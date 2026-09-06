import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as ingestHandler } from '../../pages/api/internal/pinterest/ingest';
import { dbClients } from '../db/clients';
import * as webhookSecrets from '../services/webhook-secrets';

describe('Pinterest Ingest: pin.posted Duplicate Dedup & Idempotency', () => {
  const wsId = '11111111-1111-1111-1111-111111111111';
  const accId = '22222222-2222-2222-2222-222222222222';
  const pinId = '33333333-3333-3333-3333-333333333333';
  const ingestSecret = 'test_ingest_secret_xyz123';

  let mockRuntimeEnv: Record<string, any>;
  let mockLocals: any;
  let pinsDb: any[];
  let deliveryLogs: any[];

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntimeEnv = {
      SCHEDULING_SUPABASE_SECRET_KEY: 'test-secret-key-123',
    };
    mockLocals = {
      runtime: { env: mockRuntimeEnv },
    };

    pinsDb = [
      {
        id: pinId,
        workspace_id: wsId,
        account_id: accId,
        title: 'Original Architecture Pin',
        image_url: 'https://cdn.example.com/initial.jpg',
        board_name: 'Architecture',
        status: 'processing',
        attempts: 1,
        posted_at: null,
      },
    ];

    deliveryLogs = [];

    vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
      source: 'workspace',
      value: ingestSecret,
    });

    const mockAdmin = {
      from: (table: string) => {
        let filterEq: Record<string, any> = {};
        let updatePayload: any = null;
        function applyUpdate() {
          if (table === 'pins') {
            for (const p of pinsDb) {
              if (filterEq.id && p.id !== filterEq.id) continue;
              if (filterEq.workspace_id && p.workspace_id !== filterEq.workspace_id) continue;
              Object.assign(p, updatePayload);
            }
          }
        }

        const builder: any = {
          select: vi.fn(() => builder),
          update: vi.fn((payload: any) => {
            updatePayload = payload;
            const ub: any = {
              eq: vi.fn((col: string, val: any) => {
                filterEq[col] = val;
                applyUpdate();
                return ub;
              }),
              then: (cb: any) => {
                applyUpdate();
                return Promise.resolve(cb({ data: null, error: null }));
              },
            };
            return ub;
          }),
          insert: vi.fn((rows: any) => {
            const arr = Array.isArray(rows) ? rows : [rows];
            if (table === 'pin_delivery_logs') {
              deliveryLogs.push(...arr);
            }
            return { error: null };
          }),
          eq: vi.fn((col: string, val: any) => {
            filterEq[col] = val;
            return builder;
          }),
          maybeSingle: vi.fn(async () => {
            if (table === 'pins') {
              const pin = pinsDb.find((p) => p.id === filterEq.id && p.workspace_id === filterEq.workspace_id);
              return { data: pin ? { ...pin } : null, error: null };
            }
            return { data: null, error: null };
          }),
          then: vi.fn((cb: any) => Promise.resolve(cb({ data: [], error: null }))),
        };
        return builder;
      },
    };

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);
  });

  it('handles initial pin.posted callback, updates status to posted, and records delivery log with idempotency_key', async () => {
    const initialTimestamp = '2026-09-01T12:00:00.000Z';
    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.posted',
        workspace_id: wsId,
        pin_id: pinId,
        id: 'pinterest-pin-100',
        image_url: 'https://i.pinimg.com/1200x/final-cdn.jpg',
        created_at: initialTimestamp,
        idempotency_key: 'make_post_batch_123',
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.handled).toBe('pin_posted');

    const pin = pinsDb.find((p) => p.id === pinId);
    expect(pin.status).toBe('posted');
    expect(pin.posted_at).toBe(initialTimestamp);
    expect(pin.pinterest_pin_id).toBe('pinterest-pin-100');
    expect(pin.image_url).toBe('https://i.pinimg.com/1200x/final-cdn.jpg');

    expect(deliveryLogs).toHaveLength(1);
    expect(deliveryLogs[0].event_type).toBe('dispatch_success');
    expect(deliveryLogs[0].metadata?.idempotency_key).toBe('make_post_batch_123');
    expect(deliveryLogs[0].metadata?.pinterest_pin_id).toBe('pinterest-pin-100');
  });

  it('short-circuits duplicate pin.posted callback with handled: "pin_posted_duplicate" without mutating posted_at or creating duplicate logs', async () => {
    // 1. Initial post
    const initialTimestamp = '2026-09-01T12:00:00.000Z';
    const req1 = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.posted',
        workspace_id: wsId,
        pin_id: pinId,
        id: 'pinterest-pin-100',
        image_url: 'https://i.pinimg.com/1200x/final-cdn.jpg',
        created_at: initialTimestamp,
        idempotency_key: 'make_post_batch_123',
      }),
    });

    const res1 = await ingestHandler({ request: req1, locals: mockLocals } as any);
    expect(res1.status).toBe(200);
    expect((await res1.json()).handled).toBe('pin_posted');
    expect(deliveryLogs).toHaveLength(1);

    // 2. Duplicate callback arriving 30 seconds later with different created_at and different payload
    const duplicateTimestamp = '2026-09-01T12:00:30.000Z';
    const req2 = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.posted',
        workspace_id: wsId,
        pin_id: pinId,
        id: 'pinterest-pin-100-tampered',
        image_url: 'https://i.pinimg.com/1200x/tampered.jpg',
        created_at: duplicateTimestamp,
        idempotency_key: 'make_post_batch_123_retry',
      }),
    });

    const res2 = await ingestHandler({ request: req2, locals: mockLocals } as any);
    expect(res2.status).toBe(200);

    const body2 = await res2.json();
    expect(body2.success).toBe(true);
    expect(body2.handled).toBe('pin_posted_duplicate');
    expect(body2.pin_id).toBe(pinId);

    // Assert that pin was NOT mutated
    const pin = pinsDb.find((p) => p.id === pinId);
    expect(pin.status).toBe('posted');
    expect(pin.posted_at).toBe(initialTimestamp); // preserved!
    expect(pin.pinterest_pin_id).toBe('pinterest-pin-100'); // preserved!
    expect(pin.image_url).toBe('https://i.pinimg.com/1200x/final-cdn.jpg'); // preserved!

    // Assert that no second delivery log was recorded
    expect(deliveryLogs).toHaveLength(1);
  });
});
