import { describe, it, expect, vi } from 'vitest';
import { dispatchStagedPin, dispatchBulkStagedPins, deleteStagedPin } from '../services/staged-service';
import { POST as ingestHandler } from '../../pages/api/internal/pinarchive/ingest';
import { dbClients } from '../db/clients';

vi.mock('../db/clients', () => {
  const mockSchedulingAdmin = {
    from: vi.fn(),
  };
  const mockPinArchive = {
    from: vi.fn(),
  };

  return {
    isProductionEnv: vi.fn().mockReturnValue(false),
    isKnownDefaultIngestSecret: vi.fn().mockReturnValue(false),
    isKnownDefaultKek: vi.fn().mockReturnValue(false),
    getServerEnv: vi.fn().mockReturnValue({}),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockReturnValue(mockSchedulingAdmin),
      getPinArchive: vi.fn().mockReturnValue(mockPinArchive),
      getConfig: vi.fn().mockReturnValue({}),
    },
  };
});

describe('PinArchive (P4) Bug Reproduction & Contract Proof Suite', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockUserId = 'user-test-123';

  // ── BUG 1: Pre-CAS validation swallow (staged-service.ts:323-327) ──
  describe('P4-1: Pre-CAS validation swallow', () => {
    it('FAIL on current code: board check unexpected failure must reject with 503 instead of proceeding to CAS', async () => {
      // Mock paAdmin where preRow fetch throws a network/internal error (TypeError)
      const paAdmin: any = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'pa_staged_pins') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockRejectedValue(new TypeError('network failed fetching boards')),
                  }),
                }),
              }),
              update: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      select: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: { id: 'staged-1', status: 'dispatched' },
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      };

      const p1Admin: any = { from: vi.fn() };

      // Current code swallows TypeError inside lines 323-327 and proceeds to CAS.
      // Fixed code must reject with HttpError 503.
      await expect(
        dispatchStagedPin(
          paAdmin,
          p1Admin,
          mockWsId,
          mockUserId,
          'staged-1',
          [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1', linkUrl: 'https://example.com' }]
        )
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  // ── BUG 2: Fake 200 on account skip (ingest.ts:185-198) ──
  describe('P4-2: Fake 200 on account skip', () => {
    it('FAIL on current code: disabled account returns 409 success:false with zero writes', async () => {
      const mockAdminClient = dbClients.getSchedulingAdmin();
      const mockPinArchiveClient = dbClients.getPinArchive();

      mockAdminClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
      });

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { workspace_id: mockWsId, ingest_enabled: true },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'acc-1', status: 'active', ingest_enabled: false },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': 'test-secret',
        },
        body: JSON.stringify({
          workspace_id: mockWsId,
          username: 'disabled_creator',
          pins: [{ pin_id: '123', title: 'Test Pin', saves: 5 }],
        }),
      });

      const mockRuntimeEnv = {
        INGEST_SECRETS_KV: {
          get: vi.fn().mockResolvedValue('test-secret'),
        },
      };

      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);

      // Current code returns 200 { success: true, skipped: 'account_ingest_disabled' }
      // Fixed contract requires 409 { success: false, error: 'account_ingest_disabled', skipped: 'account_ingest_disabled', retryable: false }
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.skipped).toBe('account_ingest_disabled');
      expect(json.retryable).toBe(false);
    });
  });

  // ── BUG 3: Bulk dispatch false success (staged-service.ts:568-573) ──
  describe('P4-3: Bulk dispatch false success', () => {
    it('FAIL on current code: all-failed bulk dispatch returns success:false', async () => {
      // Simulate CAS losing for all items (data: null)
      const paAdmin: any = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'pa_staged_pins') {
            return {
              select: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [{ id: 'pin-1', board_name: 'Board 1' }, { id: 'pin-2', board_name: 'Board 1' }],
                    error: null,
                  }),
                }),
              }),
              update: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      select: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      };

      const mockBoardsQuery = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        not: vi.fn().mockResolvedValue({
          data: [{ account_id: 'acc-1', board_name: 'Board 1', pinterest_board_id: 'pb-1' }],
          error: null,
        }),
      };

      const p1Admin: any = {
        from: vi.fn().mockReturnValue(mockBoardsQuery),
      };

      const res = await dispatchBulkStagedPins(
        paAdmin,
        p1Admin,
        mockWsId,
        mockUserId,
        ['pin-1', 'pin-2'],
        [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1', linkUrl: 'https://example.com' }]
      );

      // Current code lines 568-573 returns { success: true, failed: [...], ... }
      // Fixed contract requires success: false when failed items equal total requested
      expect(res.failed).toHaveLength(2);
      expect(res.success).toBe(false);
    });
  });

  // ── BUG 4: Delete staged pin status guard (staged-service.ts:173-177) ──
  describe('P4-4: Delete staged pin status guard', () => {
    it('FAIL on current code: deleting a non-staged pin rejects with 409', async () => {
      // Current deleteStagedPin does NOT filter by status='staged', so it deletes blindly
      // and succeeds even when the pin is already dispatched.
      // Fixed deleteStagedPin requires .eq('status', 'staged') and rejects with 409 if not found/dispatched.
      const paAdmin: any = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'pa_staged_pins') {
            return {
              delete: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      select: vi.fn().mockReturnValue({
                        // Simulate no staged row found to delete (already dispatched)
                        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                      }),
                    }),
                    select: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      };

      // Current code returns Promise<void> without error. Fixed code must reject with 409.
      await expect(deleteStagedPin(paAdmin, mockWsId, 'already-dispatched-pin')).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  // ── BUG 5: Conditional rollback on dispatched status (staged-service.ts:398-402, 555-559) ──
  describe('P4-5: Conditional rollback guards', () => {
    it('FAIL on current code: rollback query must require status: dispatched to prevent resurrecting cancelled pins', async () => {
      const eqCalls: [string, any][] = [];

      const mockQueryBuilder = {
        eq: vi.fn().mockImplementation((col: string, val: any) => {
          eqCalls.push([col, val]);
          return mockQueryBuilder;
        }),
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: 'staged-1', pa_pin_id: 'pa-pin-1', board_name: 'B1', override_link: '', original_link: '' },
            error: null,
          }),
        }),
      };

      const paAdmin: any = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'pa_staged_pins') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'staged-1', board_name: 'B1' }, error: null }),
                  }),
                }),
              }),
              update: vi.fn().mockImplementation(() => mockQueryBuilder),
            };
          }
          if (table === 'pa_repurpose_batches') {
            return {
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'batch-1' }, error: null }),
                }),
              }),
            };
          }
          if (table === 'pa_pin_dispatches') {
            return {
              delete: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({ error: null }),
                }),
              }),
            };
          }
          return {};
        }),
      };

      const p1Admin: any = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'boards') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  in: vi.fn().mockReturnValue({
                    in: vi.fn().mockReturnValue({
                      not: vi.fn().mockResolvedValue({
                        data: [{ account_id: 'acc-1', board_name: 'B1', pinterest_board_id: 'pb-1' }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'pins') {
            return {
              insert: vi.fn().mockResolvedValue({ error: { message: 'P1 database timeout' } }),
              delete: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({ error: null }),
                }),
              }),
            };
          }
          return {};
        }),
      };

      try {
        await dispatchStagedPin(
          paAdmin,
          p1Admin,
          mockWsId,
          mockUserId,
          'staged-1',
          [{ accountId: 'acc-1', accountLabel: 'A1', boardName: 'B1', linkUrl: 'https://example.com' }]
        );
      } catch (_) {
        // Expected dispatch failure
      }

      // In current code, rollback update calls:
      // .update({ status: 'staged' }).eq('id', stagedPinId).eq('workspace_id', workspaceId)
      // It does NOT check .eq('status', 'dispatched')!
      // Fixed code MUST assert that rollback specifically checks ['status', 'dispatched'].
      const hasDispatchedGuard = eqCalls.some(([col, val]) => col === 'status' && val === 'dispatched');
      expect(hasDispatchedGuard).toBe(true);
    });
  });
});
