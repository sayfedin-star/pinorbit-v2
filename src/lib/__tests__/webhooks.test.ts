import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAccountWebhooks, getAccountWebhookSummary } from '../webhooks';
import * as supabaseClientModule from '../supabase-client';
import { mockWebhooks, mockAccounts } from '../supabase-mock';

describe('Webhooks Domain Optimization Suite (T2.5 & T2.6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getAccountWebhooks with workspaceId performs single inner join query and strips embedded accounts object', async () => {
    const rawJoinedData = [
      {
        id: 'wh-1',
        account_id: 'acc-1',
        label: 'Webhook 1',
        webhook_url: 'https://example.com/wh1',
        monthly_capacity: 500,
        remaining_capacity: 450,
        is_active: true,
        is_primary: true,
        priority: 1,
        created_at: '2026-01-01T00:00:00Z',
        accounts: { id: 'acc-1', workspace_id: 'ws-100' },
      },
      {
        id: 'wh-2',
        account_id: 'acc-1',
        label: 'Webhook 2',
        webhook_url: 'https://example.com/wh2',
        monthly_capacity: 500,
        remaining_capacity: 500,
        is_active: true,
        is_primary: false,
        priority: 2,
        created_at: '2026-01-02T00:00:00Z',
        accounts: { id: 'acc-1', workspace_id: 'ws-100' },
      },
    ];

    const orderCreatedSpy = vi.fn().mockResolvedValue({ data: rawJoinedData, error: null });
    const orderPrioritySpy = vi.fn().mockReturnValue({ order: orderCreatedSpy });
    const eqSpy = vi.fn().mockReturnValue({ order: orderPrioritySpy });
    const selectSpy = vi.fn().mockReturnValue({ eq: eqSpy });

    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        select: selectSpy,
      }),
    };

    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const result = await getAccountWebhooks(undefined, 'ws-100');

    expect(mockSupabase.from).toHaveBeenCalledWith('account_webhooks');
    expect(selectSpy).toHaveBeenCalledWith('*, accounts!inner(id, workspace_id)');
    expect(eqSpy).toHaveBeenCalledWith('accounts.workspace_id', 'ws-100');
    expect(result.length).toBe(2);
    // Embedded accounts property must be stripped from returned AccountWebhook objects
    expect((result[0] as any).accounts).toBeUndefined();
    expect(result[0].id).toBe('wh-1');
    expect(result[0].label).toBe('Webhook 1');
  });

  it('getAccountWebhookSummary narrows query to 4 columns and calculates summary accurately', async () => {
    const summaryData = [
      { label: 'Primary Hook', is_active: true, is_primary: true, remaining_capacity: 350 },
      { label: 'Secondary Hook', is_active: true, is_primary: false, remaining_capacity: 150 },
      { label: 'Inactive Hook', is_active: false, is_primary: false, remaining_capacity: 500 },
    ];

    const eqSpy = vi.fn().mockResolvedValue({ data: summaryData, error: null });
    const selectSpy = vi.fn().mockReturnValue({ eq: eqSpy });

    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        select: selectSpy,
      }),
    };

    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const summary = await getAccountWebhookSummary('acc-1');

    expect(mockSupabase.from).toHaveBeenCalledWith('account_webhooks');
    expect(selectSpy).toHaveBeenCalledWith('label, is_active, is_primary, remaining_capacity');
    expect(eqSpy).toHaveBeenCalledWith('account_id', 'acc-1');
    expect(summary.totalWebhooks).toBe(3);
    expect(summary.activeWebhooks).toBe(2);
    expect(summary.primaryWebhookLabel).toBe('Primary Hook');
    expect(summary.totalRemainingCapacity).toBe(500); // 350 + 150
  });

  it('getAccountWebhooks falls back gracefully in mock mode', async () => {
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(null);

    const res = await getAccountWebhooks('acc-1');
    expect(Array.isArray(res)).toBe(true);
  });
});
