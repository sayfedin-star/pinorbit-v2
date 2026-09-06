import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleDispatch } from '../../pages/api/internal/pinterest/dispatch-due-pin';
import { dbClients } from '../db/clients';

describe('Dispatch Due Pin: Webhook Execution Quota Idempotency', () => {
  const scheduleId = '11111111-1111-1111-1111-111111111111';
  const dispatchToken = 'valid-dispatch-token-secret-12345';
  const workspaceId = '22222222-2222-2222-2222-222222222222';
  const accountId = '33333333-3333-3333-3333-333333333333';
  const webhookId = '44444444-4444-4444-4444-444444444444';
  const webhookUrl = 'https://hook.make.com/test-pin-receiver';

  let mockRuntimeEnv: Record<string, any>;
  let mockLocals: any;
  let rpcCalls: Array<{ proc: string; args: any }>;
  let shouldFailFirstIncrement: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    rpcCalls = [];
    shouldFailFirstIncrement = false;

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
          update: vi.fn(() => builder),
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
                  remaining_capacity: 100,
                  executions_used: 0,
                  monthly_capacity: 1000,
                  monthly_usage: 0,
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
                  id: 'pin-1',
                  account_id: accountId,
                  workspace_id: workspaceId,
                  title: 'Test Pin',
                  image_url: 'https://example.com/img.jpg',
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
                data: [{
                  id: webhookId,
                  account_id: accountId,
                  webhook_url: webhookUrl,
                  is_active: true,
                  remaining_capacity: 100,
                  executions_used: 0,
                  monthly_capacity: 1000,
                  monthly_usage: 0,
                }],
                error: null,
              }));
            }
            if (table === 'boards') {
              return Promise.resolve(cb({ data: [{ board_name: 'Test Board', pinterest_board_id: 'pb-1' }], error: null }));
            }
            if (table === 'pins') {
              return Promise.resolve(cb({
                data: [{
                  id: 'pin-1',
                  account_id: accountId,
                  workspace_id: workspaceId,
                  title: 'Test Pin',
                  image_url: 'https://example.com/img.jpg',
                  board_name: 'Test Board',
                  status: 'processing',
                  attempts: 1,
                }],
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
          return { data: null, error: null };
        }
        if (proc === 'claim_due_pins_simple') {
          return {
            data: [{ id: 'pin-1', account_id: accountId, workspace_id: workspaceId }],
            error: null,
          };
        }
        if (proc === 'increment_webhook_execution') {
          if (shouldFailFirstIncrement) {
            shouldFailFirstIncrement = false; // Only fail the first call to trigger retry
            return { data: null, error: { message: 'Transient connection timeout' } };
          }
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }),
    };

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);
  });

  it('passes formatted p_idempotency_key on successful increment_webhook_execution', async () => {
    const res = await handleDispatch(
      {
        schedule_id: scheduleId,
        dispatch_token: dispatchToken,
        force: true,
      },
      mockLocals
    );

    const data = await res.json();
    expect(data.success).toBe(true);

    const incCalls = rpcCalls.filter((c) => c.proc === 'increment_webhook_execution');
    expect(incCalls).toHaveLength(1);
    expect(incCalls[0].args.p_idempotency_key).toBeDefined();
    expect(incCalls[0].args.p_idempotency_key).toMatch(
      /^dispatch_inc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(incCalls[0].args.p_webhook_id).toBe(webhookId);
    expect(incCalls[0].args.p_workspace_id).toBe(workspaceId);
    expect(incCalls[0].args.p_count).toBe(1);
  });

  it('re-uses the exact same p_idempotency_key on network retry of increment_webhook_execution', async () => {
    shouldFailFirstIncrement = true;

    const res = await handleDispatch(
      {
        schedule_id: scheduleId,
        dispatch_token: dispatchToken,
        force: true,
      },
      mockLocals
    );

    const data = await res.json();
    expect(data.success).toBe(true);

    const incCalls = rpcCalls.filter((c) => c.proc === 'increment_webhook_execution');
    expect(incCalls).toHaveLength(2);

    const keyFirst = incCalls[0].args.p_idempotency_key;
    const keyRetry = incCalls[1].args.p_idempotency_key;

    expect(keyFirst).toBeDefined();
    expect(keyRetry).toBeDefined();
    // Amendment 2 requirement: the key MUST be identical across the initial and retry pair
    expect(keyFirst).toBe(keyRetry);
    expect(keyFirst).toMatch(/^dispatch_inc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('generates unique p_idempotency_key across distinct dispatch requests', async () => {
    await handleDispatch(
      { schedule_id: scheduleId, dispatch_token: dispatchToken, force: true },
      mockLocals
    );

    await handleDispatch(
      { schedule_id: scheduleId, dispatch_token: dispatchToken, force: true },
      mockLocals
    );

    const incCalls = rpcCalls.filter((c) => c.proc === 'increment_webhook_execution');
    expect(incCalls).toHaveLength(2);

    const key1 = incCalls[0].args.p_idempotency_key;
    const key2 = incCalls[1].args.p_idempotency_key;

    expect(key1).not.toBe(key2);
  });
});
