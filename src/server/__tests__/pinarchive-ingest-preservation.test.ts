import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST as ingestPost } from '../../pages/api/internal/pinarchive/ingest';
import { dbClients } from '../db/clients';
import * as webhookSecrets from '../services/webhook-secrets';

describe('PinArchive Ingest Enrichment Preservation Suite (pinarchive-ingest-preservation.test.ts)', () => {
  const mockWorkspaceId = '00000000-0000-0000-0000-000000000001';
  const mockAccountId = '11111111-2222-3333-4444-555555555555';
  const testSecret = 'test_ingest_secret_key_12345';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('P1 #16: legacy fallback upsert preserves existing price, currency, and site_name when incoming payload omits them', async () => {
    vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
      value: testSecret,
      source: 'global',
    });

    vi.spyOn(webhookSecrets, 'verifyIngestSecret').mockResolvedValue({
      valid: true,
      matchedSource: 'global',
    });

    const mockSchedulingAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: mockWorkspaceId },
              error: null,
            }),
          }),
        }),
      }),
    };
    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockSchedulingAdmin as any);

    let upsertedPayload: any = null;

    const mockPinArchive = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: new Error('RPC unavailable, triggering legacy fallback'),
      }),
      from: vi.fn((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { ingest_enabled: true, max_batch_pins: 500 },
                  error: null,
                })),
              })),
            })),
          };
        }
        if (table === 'pa_accounts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      id: mockAccountId,
                      workspace_id: mockWorkspaceId,
                      username: 'test_account',
                      is_active: true,
                    },
                    error: null,
                  })),
                })),
              })),
            })),
            upsert: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: {
                    id: mockAccountId,
                    workspace_id: mockWorkspaceId,
                    username: 'test_account',
                    is_active: true,
                  },
                  error: null,
                })),
              })),
            })),
          };
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                in: vi.fn(async () => ({
                  data: [
                    {
                      id: 'row-1',
                      pin_id: 'pin-12345',
                      title: 'Existing Pin Title',
                      price: '29.99',
                      currency: 'USD',
                      site_name: 'Shopify Store',
                      saves: 10,
                      repins: 5,
                      comments: 2,
                    },
                  ],
                  error: null,
                })),
              })),
            })),
            upsert: vi.fn((payload: any) => {
              upsertedPayload = payload;
              return {
                select: vi.fn(async () => ({
                  data: [
                    {
                      id: 'row-1',
                      pin_id: 'pin-12345',
                      title: 'Existing Pin Title',
                      saves: 15,
                    },
                  ],
                  error: null,
                })),
              };
            }),
          };
        }
        if (table === 'pa_pin_metrics' || table === 'pa_runs') {
          return {
            insert: vi.fn(async () => ({
              data: null,
              error: null,
            })),
            upsert: vi.fn(async () => ({
              data: null,
              error: null,
            })),
          };
        }
        return {};
      }),
    };

    vi.spyOn(dbClients, 'getPinArchive').mockReturnValue(mockPinArchive as any);

    // Incoming payload omits price, currency, site_name
    const request = new Request('http://localhost/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': testSecret,
      },
      body: JSON.stringify({
        workspace_id: mockWorkspaceId,
        account_id: mockAccountId,
        username: 'test_account',
        pins: [
          {
            pin_id: 'pin-12345',
            title: 'Updated Pin Title',
            saves: 15,
            // price, currency, site_name omitted
          },
        ],
      }),
    });

    const response = await ingestPost({
      request,
      locals: {},
    } as any);

    expect(response.status).toBe(200);
    expect(upsertedPayload).toBeDefined();
    expect(upsertedPayload).toHaveLength(1);

    const savedPin = upsertedPayload[0];
    expect(savedPin.pin_id).toBe('pin-12345');
    expect(savedPin.title).toBe('Updated Pin Title');
    expect(savedPin.price).toBe('29.99');
    expect(savedPin.currency).toBe('USD');
    expect(savedPin.site_name).toBe('Shopify Store');
  });
});
