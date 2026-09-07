import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as ingestHandler } from '../../pages/api/internal/pinterest/ingest';
import { dbClients } from '../db/clients';
import * as webhookSecrets from '../services/webhook-secrets';

describe('Pinterest Ingest: CAS Ordering & Terminal State Safety', () => {
  const wsId = '11111111-1111-1111-1111-111111111111';
  const accId = '22222222-2222-2222-2222-222222222222';
  const pinId = '33333333-3333-3333-3333-333333333333';
  const ingestSecret = 'test_ingest_secret_xyz123';

  let mockRuntimeEnv: Record<string, any>;
  let mockLocals: any;
  let pinsDb: any[];
  let deliveryLogs: any[];
  let simulateCasUpdateMiss: boolean;

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
        title: 'CAS Test Pin',
        image_url: 'https://cdn.example.com/initial.jpg',
        board_name: 'Architecture',
        status: 'processing',
        attempts: 1,
        max_retries: 3,
        posted_at: null,
      },
    ];

    deliveryLogs = [];
    simulateCasUpdateMiss = false;

    vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
      source: 'workspace',
      value: ingestSecret,
    });

    const mockAdmin = {
      from: (table: string) => {
        let filterEq: Record<string, any> = {};
        let filterNeq: Record<string, any> = {};
        let updatePayload: any = null;

        function applyUpdate(): any[] {
          if (table === 'pins') {
            if (simulateCasUpdateMiss) {
              return [];
            }
            const updated: any[] = [];
            for (const p of pinsDb) {
              if (filterEq.id && p.id !== filterEq.id) continue;
              if (filterEq.workspace_id && p.workspace_id !== filterEq.workspace_id) continue;
              if (filterNeq.status && p.status === filterNeq.status) continue;
              Object.assign(p, updatePayload);
              updated.push({ id: p.id });
            }
            return updated;
          }
          return [];
        }

        const builder: any = {
          select: vi.fn(() => builder),
          update: vi.fn((payload: any) => {
            updatePayload = payload;
            const ub: any = {
              eq: vi.fn((col: string, val: any) => {
                filterEq[col] = val;
                return ub;
              }),
              neq: vi.fn((col: string, val: any) => {
                filterNeq[col] = val;
                return ub;
              }),
              select: vi.fn((_cols: string) => {
                const affected = applyUpdate();
                return {
                  data: affected,
                  error: null,
                };
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

  it('ignores out-of-order pin.failed if pin is already posted (terminal state safety)', async () => {
    // Setup pin as already posted
    const targetPin = pinsDb.find((p) => p.id === pinId);
    targetPin.status = 'posted';
    targetPin.posted_at = '2026-09-01T12:00:00.000Z';

    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.failed',
        workspace_id: wsId,
        pin_id: pinId,
        error: 'Network timeout downstream after post was already verified',
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.handled).toBe('pin_failed_ignored_already_posted');
    expect(body.pin_id).toBe(pinId);

    // Assert status remained 'posted' and not regressed to 'failed' or 'pending'
    expect(targetPin.status).toBe('posted');
    expect(targetPin.posted_at).toBe('2026-09-01T12:00:00.000Z');

    // Assert no failure delivery log was inserted
    expect(deliveryLogs).toHaveLength(0);
  });

  it('prevents duplicate delivery logs when concurrent CAS update returns 0 affected rows', async () => {
    // Pin is initially 'processing' when read via maybeSingle
    expect(pinsDb[0].status).toBe('processing');

    // Simulate concurrent winner race condition where another worker completed CAS first
    simulateCasUpdateMiss = true;

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
        id: 'pinterest-pin-race-1',
        created_at: '2026-09-01T12:05:00.000Z',
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.handled).toBe('pin_posted_duplicate');
    expect(body.pin_id).toBe(pinId);

    // Verify delivery log was NOT inserted because CAS update returned 0 rows
    expect(deliveryLogs).toHaveLength(0);
  });

  it('processes normal pin.failed when pin is in processing state', async () => {
    const targetPin = pinsDb.find((p) => p.id === pinId);
    targetPin.status = 'processing';
    targetPin.attempts = 1;
    targetPin.max_retries = 3;

    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.failed',
        workspace_id: wsId,
        pin_id: pinId,
        error: 'Rate limit exceeded',
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.handled).toBe('pin_failed');
    expect(body.exhausted).toBe(false);

    expect(targetPin.status).toBe('pending');
    expect(deliveryLogs).toHaveLength(1);
    expect(deliveryLogs[0].event_type).toBe('dispatch_failed');
    expect(deliveryLogs[0].error_message).toBe('Rate limit exceeded');
  });

  it('marks pin as failed when retry limit is exhausted', async () => {
    const targetPin = pinsDb.find((p) => p.id === pinId);
    targetPin.status = 'processing';
    targetPin.attempts = 2;
    targetPin.max_retries = 3;

    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.failed',
        workspace_id: wsId,
        pin_id: pinId,
        error: 'Permanent Pinterest API rejection',
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.handled).toBe('pin_failed');
    expect(body.exhausted).toBe(true);

    expect(targetPin.status).toBe('failed');
    expect(deliveryLogs).toHaveLength(1);
    expect(deliveryLogs[0].event_type).toBe('dispatch_failed');
  });
});
