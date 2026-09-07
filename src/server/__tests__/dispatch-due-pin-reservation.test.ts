import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleDispatch } from '../../pages/api/internal/pinterest/dispatch-due-pin';
import { dbClients } from '../db/clients';

describe('Dispatch Due Pin: Atomic Capacity Reservation & 503 Handling', () => {
  const scheduleId = '11111111-1111-1111-1111-111111111111';
  const dispatchToken = 'valid-dispatch-token-secret-12345';
  const workspaceId = '22222222-2222-2222-2222-222222222222';
  const accountId = '33333333-3333-3333-3333-333333333333';
  const webhookId = '44444444-4444-4444-4444-444444444444';
  const webhookUrl = 'https://hook.make.com/test-pin-receiver';

  let mockRuntimeEnv: Record<string, any>;
  let mockLocals: any;
  let rpcCalls: Array<{ proc: string; args: any }>;
  let updatedPins: Array<any>;
  let incrementThrowsInsufficientCapacity: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    rpcCalls = [];
    updatedPins = [];
    incrementThrowsInsufficientCapacity = false;

    mockRuntimeEnv = {
      SCHEDULING_SUPABASE_SECRET_KEY: 'test-secret-key-123',
    };
    mockLocals = {
      runtimeEnv: mockRuntimeEnv,
    };

    // Global fetch mock to simulate successful Make.com delivery
    global.fetch = vi.fn().mockImplementation(async (url: any) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('hook.make.com')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => 'Accepted',
          json: async () => ({ success: true }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    const mockAdmin = {
      from: (table: string) => {
        let filterEq: Record<string, any> = {};
        const builder: any = {
          select: vi.fn(() => builder),
          update: vi.fn((payload: any) => {
            if (table === 'pins') {
              updatedPins.push(payload);
            }
            return builder;
          }),
          or: vi.fn(() => builder),
          gte: vi.fn(() => builder),
          lte: vi.fn(() => builder),
          gt: vi.fn(() => builder),
          lt: vi.fn(() => builder),
          order: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          not: vi.fn(() => builder),
          ilike: vi.fn(() => builder),
          eq: vi.fn((col: string, val: any) => {
            filterEq[col] = val;
            return builder;
          }),
          is: vi.fn(() => builder),
          in: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => {
            if (table === 'posting_schedules') {
              return {
                data: {
                  id: scheduleId,
                  workspace_id: workspaceId,
                  account_id: accountId,
                  webhook_id: webhookId,
                  dispatch_token: dispatchToken,
                  status: 'active',
                  batch: 1,
                  locked_until: null,
                  window_start: '00:00',
                  window_end: '23:59',
                },
                error: null,
              };
            }
            if (table === 'account_webhooks') {
              return {
                data: {
                  id: webhookId,
                  account_id: accountId,
                  webhook_url: webhookUrl,
                  is_active: true,
                  remaining_capacity: 1,
                  executions_used: 99,
                  monthly_capacity: 100,
                  monthly_usage: 99,
                },
                error: null,
              };
            }
            if (table === 'accounts') {
              return {
                data: { id: accountId, workspace_id: workspaceId, account_type: 'business', board_webhook_id: null },
                error: null,
              };
            }
            if (table === 'pins') {
              return {
                data: {
                  id: 'pin-res-1',
                  account_id: accountId,
                  workspace_id: workspaceId,
                  title: 'Capacity Test Pin',
                  image_url: 'https://example.com/cap.jpg',
                  board_name: 'Test Board',
                  status: 'processing',
                  attempts: 1,
                  claimed_by_schedule_id: scheduleId,
                },
                error: null,
              };
            }
            return { data: null, error: null };
          }),
          then: vi.fn((cb: any) => {
            if (table === 'account_webhooks') {
              return Promise.resolve(cb({
                data: [
                  {
                    id: webhookId,
                    account_id: accountId,
                    webhook_url: webhookUrl,
                    is_active: true,
                    priority: 1,
                    remaining_capacity: 1,
                    executions_used: 99,
                    monthly_capacity: 100,
                    monthly_usage: 99,
                  },
                ],
                error: null,
              }));
            }
            if (table === 'pins') {
              return Promise.resolve(cb({
                data: [
                  {
                    id: 'pin-res-1',
                    account_id: accountId,
                    workspace_id: workspaceId,
                    title: 'Capacity Test Pin',
                    image_url: 'https://example.com/cap.jpg',
                    board_name: 'Test Board',
                    status: 'pending',
                  },
                ],
                error: null,
              }));
            }
            if (table === 'boards') {
              return Promise.resolve(cb({
                data: [{ board_name: 'Test Board', pinterest_board_id: 'pb-1' }],
                error: null,
              }));
            }
            return Promise.resolve(cb({ data: [], error: null }));
          }),
        };
        return builder;
      },
      rpc: vi.fn(async (proc: string, args: any) => {
        rpcCalls.push({ proc, args });
        if (proc === 'acquire_schedule_dispatch_lease') {
          return { data: true, error: null };
        }
        if (proc === 'release_schedule_dispatch_lease') {
          return { data: true, error: null };
        }
        if (proc === 'claim_due_pins_simple') {
          return {
            data: [{ id: 'pin-res-1', schedule_id: scheduleId, account_id: accountId }],
            error: null,
          };
        }
        if (proc === 'increment_webhook_execution') {
          if (incrementThrowsInsufficientCapacity) {
            return {
              data: null,
              error: { message: 'insufficient_capacity', code: 'P0001' },
            };
          }
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }),
    };

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);
  });

  it('handles insufficient_capacity by resetting claimed pins to pending and returning 503 without retrying', async () => {
    incrementThrowsInsufficientCapacity = true;

    const res = await handleDispatch(
      {
        schedule_id: scheduleId,
        dispatch_token: dispatchToken,
      },
      mockLocals
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe('no_webhook_capacity');
    expect(body.error).toContain('No active webhook with remaining capacity found');

    // Webhook increment RPC was called once, but not retried
    const incrementCalls = rpcCalls.filter((c) => c.proc === 'increment_webhook_execution');
    expect(incrementCalls.length).toBe(1);

    // Verify claimed pins were reset to pending
    const pendingResets = updatedPins.filter((p) => p.status === 'pending');
    expect(pendingResets.length).toBeGreaterThanOrEqual(1);
    expect(pendingResets[pendingResets.length - 1].claimed_at).toBeNull();
  });

  it('succeeds normally when increment_webhook_execution does not throw insufficient_capacity', async () => {
    incrementThrowsInsufficientCapacity = false;

    const res = await handleDispatch(
      {
        schedule_id: scheduleId,
        dispatch_token: dispatchToken,
      },
      mockLocals
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.dispatched).toBe(1);

    const incrementCalls = rpcCalls.filter((c) => c.proc === 'increment_webhook_execution');
    expect(incrementCalls.length).toBe(1);
  });
});
