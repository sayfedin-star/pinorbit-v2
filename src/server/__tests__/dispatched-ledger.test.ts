import { describe, it, expect, vi } from 'vitest';
import { fetchDispatchesLedger } from '../services/dispatched-service';

function createMockSupabase(tablesData: Record<string, any>) {
  return {
    from: vi.fn((tableName: string) => {
      const config = tablesData[tableName] || { data: [], error: null };

      const chain: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => {
          return Promise.resolve({
            data: typeof config.data === 'function' ? config.data() : config.data,
            error: config.error || null,
          });
        }),
      };

      // For calls that don't end in limit (e.g. .in('id', paPinIds))
      chain.then = (resolve: any, reject: any) => {
        if (config.error && !config.data) {
          return Promise.resolve({ data: null, error: config.error }).then(resolve, reject);
        }
        return Promise.resolve({
          data: typeof config.data === 'function' ? config.data() : config.data,
          error: config.error || null,
        }).then(resolve, reject);
      };

      return chain;
    }),
  };
}

describe('Dispatched Ledger Service Suite', () => {
  const workspaceId = 'ws-test-123';

  it('Gate 1: Performs 2-step application join mapping P4 stamps with P1 publishing states', async () => {
    const mockP4Stamps = [
      {
        id: 'stamp-1',
        batch_id: 'batch-1',
        pa_pin_id: 'pin-1',
        target_account_id: 'acc-1',
        target_account_label: 'Main Account',
        target_board_name: 'Design Ideas',
        link_used: 'https://example.com/item1',
        p1_pin_id: 'p1-uuid-1',
        sent_at: '2026-09-08T10:00:00Z',
        sent_by: 'user-1',
      },
      {
        id: 'stamp-2',
        batch_id: 'batch-1',
        pa_pin_id: 'pin-2',
        target_account_id: 'acc-1',
        target_account_label: 'Main Account',
        target_board_name: 'Design Ideas',
        link_used: 'https://example.com/item2',
        p1_pin_id: 'p1-uuid-2',
        sent_at: '2026-09-08T09:00:00Z',
        sent_by: 'user-1',
      },
      {
        id: 'stamp-3',
        batch_id: 'batch-2',
        pa_pin_id: 'pin-3',
        target_account_id: 'acc-2',
        target_account_label: 'Second Account',
        target_board_name: 'Recipes',
        link_used: '',
        p1_pin_id: 'p1-uuid-3',
        sent_at: '2026-09-08T08:00:00Z',
        sent_by: 'user-1',
      },
    ];

    const mockPaPins = [
      { id: 'pin-1', title: 'Top Modern Kitchens', description: 'desc 1', image_url: 'https://img.com/1.jpg' },
      { id: 'pin-2', title: '', description: 'Cozy Living Rooms in Fall', image_url: 'https://img.com/2.jpg' },
      { id: 'pin-3', title: 'Quick Breakfast', description: '', image_url: 'https://img.com/3.jpg' },
    ];

    const mockBatches = [
      { id: 'batch-1', status: 'completed' },
      { id: 'batch-2', status: 'in_progress' },
    ];

    const mockP1Pins = [
      { id: 'p1-uuid-1', status: 'posted', error_message: null },
      { id: 'p1-uuid-2', status: 'draft', error_message: null },
      { id: 'p1-uuid-3', status: 'failed', error_message: 'Image download timeout' },
    ];

    const mockPaAdmin = createMockSupabase({
      pa_pin_dispatches: { data: mockP4Stamps },
      pa_pins: { data: mockPaPins },
      pa_repurpose_batches: { data: mockBatches },
    });

    const mockP1Admin = createMockSupabase({
      pins: { data: mockP1Pins },
    });

    const result = await fetchDispatchesLedger(mockPaAdmin as any, mockP1Admin as any, {
      workspaceId,
      timeframe: '7d',
    });

    // Zero cross-DB join verification
    expect(mockPaAdmin.from).toHaveBeenCalledWith('pa_pin_dispatches');
    expect(mockPaAdmin.from).toHaveBeenCalledWith('pa_pins');
    expect(mockPaAdmin.from).toHaveBeenCalledWith('pa_repurpose_batches');
    expect(mockP1Admin.from).toHaveBeenCalledWith('pins');

    expect(result.items).toHaveLength(3);
    expect(result.p1_degraded).toBe(false);

    // Stamp 1 mapped to posted
    expect(result.items[0].pin_title).toBe('Top Modern Kitchens');
    expect(result.items[0].publish_status).toBe('posted');
    expect(result.items[0].batch_status).toBe('completed');

    // Stamp 2 resolved title fallback + draft
    expect(result.items[1].pin_title).toBe('Cozy Living Rooms in Fall');
    expect(result.items[1].publish_status).toBe('draft');

    // Stamp 3 mapped to failed with error
    expect(result.items[2].publish_status).toBe('failed');
    expect(result.items[2].publish_error).toBe('Image download timeout');
    expect(result.items[2].batch_status).toBe('in_progress');
  });

  it('Gate 2: Gracefully handles missing/deleted P1 pins without crashing', async () => {
    const mockP4Stamps = [
      {
        id: 'stamp-ghost',
        batch_id: 'batch-1',
        pa_pin_id: 'pin-1',
        target_account_id: 'acc-1',
        target_account_label: 'Main Account',
        target_board_name: 'Board A',
        link_used: 'https://example.com',
        p1_pin_id: 'p1-deleted-uuid',
        sent_at: '2026-09-08T10:00:00Z',
      },
    ];

    const mockPaAdmin = createMockSupabase({
      pa_pin_dispatches: { data: mockP4Stamps },
      pa_pins: { data: [{ id: 'pin-1', title: 'Existing Pin' }] },
      pa_repurpose_batches: { data: [{ id: 'batch-1', status: 'completed' }] },
    });

    // P1 returns empty array (pin was deleted or purged from P1)
    const mockP1Admin = createMockSupabase({
      pins: { data: [] },
    });

    const result = await fetchDispatchesLedger(mockPaAdmin as any, mockP1Admin as any, {
      workspaceId,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].publish_status).toBe('missing');
    expect(result.p1_degraded).toBe(false);
  });

  it('Gate 3: Graceful degradation when P1 query fails completely (p1_degraded = true)', async () => {
    const mockP4Stamps = [
      {
        id: 'stamp-1',
        batch_id: 'batch-1',
        pa_pin_id: 'pin-1',
        target_account_id: 'acc-1',
        target_account_label: 'Account A',
        target_board_name: 'Board A',
        link_used: 'https://example.com',
        p1_pin_id: 'p1-uuid-1',
        sent_at: '2026-09-08T10:00:00Z',
      },
    ];

    const mockPaAdmin = createMockSupabase({
      pa_pin_dispatches: { data: mockP4Stamps },
      pa_pins: { data: [{ id: 'pin-1', title: 'Pin 1' }] },
      pa_repurpose_batches: { data: [{ id: 'batch-1', status: 'completed' }] },
    });

    // P1 throws error or returns error
    const mockP1Admin: any = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockRejectedValue(new Error('P1 Connection timeout')),
      })),
    };

    const result = await fetchDispatchesLedger(mockPaAdmin as any, mockP1Admin as any, {
      workspaceId,
    });

    // P4 data must remain intact and accessible
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('stamp-1');
    expect(result.items[0].publish_status).toBe('unknown');
    expect(result.p1_degraded).toBe(true);
  });

  it('Gate 4: Respects combined filters (accountId, timeframe, batchStatus, publishStatus)', async () => {
    const mockP4Stamps = [
      {
        id: 'stamp-1',
        batch_id: 'batch-1',
        pa_pin_id: 'pin-1',
        target_account_id: 'acc-target',
        target_account_label: 'Target Acc',
        target_board_name: 'Board 1',
        link_used: 'https://example.com',
        p1_pin_id: 'p1-1',
        sent_at: '2026-09-07T12:00:00Z',
      },
      {
        id: 'stamp-2',
        batch_id: 'batch-2',
        pa_pin_id: 'pin-2',
        target_account_id: 'acc-target',
        target_account_label: 'Target Acc',
        target_board_name: 'Board 2',
        link_used: 'https://example.com',
        p1_pin_id: 'p1-2',
        sent_at: '2026-09-07T11:00:00Z',
      },
    ];

    const mockPaPins = [
      { id: 'pin-1', title: 'Pin 1' },
      { id: 'pin-2', title: 'Pin 2' },
    ];

    const mockBatches = [
      { id: 'batch-1', status: 'completed' },
      { id: 'batch-2', status: 'failed' },
    ];

    const mockP1Pins = [
      { id: 'p1-1', status: 'posted', error_message: null },
      { id: 'p1-2', status: 'failed', error_message: 'Pinterest auth expired' },
    ];

    const mockPaAdmin = createMockSupabase({
      pa_pin_dispatches: { data: mockP4Stamps },
      pa_pins: { data: mockPaPins },
      pa_repurpose_batches: { data: mockBatches },
    });

    const mockP1Admin = createMockSupabase({
      pins: { data: mockP1Pins },
    });

    // Test with publishStatus filter = 'posted'
    const resultPosted = await fetchDispatchesLedger(mockPaAdmin as any, mockP1Admin as any, {
      workspaceId,
      accountId: 'acc-target',
      timeframe: '30d',
      batchStatus: 'completed',
      publishStatus: 'posted',
    });

    expect(resultPosted.items).toHaveLength(1);
    expect(resultPosted.items[0].id).toBe('stamp-1');
    expect(resultPosted.items[0].publish_status).toBe('posted');

    // Test with batchStatus filter = 'failed'
    const resultFailedBatch = await fetchDispatchesLedger(mockPaAdmin as any, mockP1Admin as any, {
      workspaceId,
      accountId: 'acc-target',
      timeframe: '30d',
      batchStatus: 'failed',
    });

    expect(resultFailedBatch.items).toHaveLength(1);
    expect(resultFailedBatch.items[0].id).toBe('stamp-2');
  });

  it('Gate 5: Supports keyset pagination with cursor and limit boundaries', async () => {
    // Generate 6 items for limit = 5
    const mockItems = Array.from({ length: 6 }, (_, i) => ({
      id: `stamp-${100 - i}`,
      batch_id: 'batch-1',
      pa_pin_id: `pin-${i}`,
      target_account_id: 'acc-1',
      target_account_label: 'Acc',
      target_board_name: 'Board',
      link_used: '',
      p1_pin_id: `p1-${i}`,
      sent_at: new Date(1725790000000 - i * 60000).toISOString(),
    }));

    let orClauseCalled = '';
    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_pin_dispatches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            or: vi.fn((clause: string) => {
              orClauseCalled = clause;
              return {
                order: vi.fn().mockReturnThis(),
                limit: vi.fn().mockResolvedValue({ data: mockItems, error: null }),
              };
            }),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: mockItems, error: null }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }),
    };

    const mockP1Admin = createMockSupabase({
      pins: { data: [] },
    });

    // Page 1: limit 5, total returned 6 (has_more = true)
    const page1 = await fetchDispatchesLedger(mockPaAdmin as any, mockP1Admin as any, {
      workspaceId,
      limit: 5,
    });

    expect(page1.items).toHaveLength(5);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toEqual({
      sent_at: mockItems[4].sent_at,
      id: mockItems[4].id,
    });

    // Page 2: with cursor
    await fetchDispatchesLedger(mockPaAdmin as any, mockP1Admin as any, {
      workspaceId,
      cursor: page1.next_cursor!,
      limit: 5,
    });

    expect(orClauseCalled).toContain(`sent_at.lt.${page1.next_cursor!.sent_at}`);
    expect(orClauseCalled).toContain(`id.lt.${page1.next_cursor!.id}`);
  });
});
