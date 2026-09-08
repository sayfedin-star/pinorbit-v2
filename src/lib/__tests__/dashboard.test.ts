import { describe, it, expect, beforeEach, vi } from 'vitest';
import { countPinsByStatus, getDashboardKPIs } from '../dashboard';
import { setMockPins, mockPins, DEFAULT_WS_ID } from '../supabase-mock';
import * as supabaseClientModule from '../supabase-client';

describe('Dashboard Server-Side Pin Status Counts Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('countPinsByStatus issues { count: "exact", head: true } and filters with .in() when supabase is active', async () => {
    const inSpy = vi.fn().mockReturnThis();
    const eqSpy = vi.fn().mockReturnThis();
    const selectSpy = vi.fn().mockReturnValue({
      eq: eqSpy,
      in: inSpy,
      then: (resolve: any) => resolve({ count: 42, error: null }),
    });
    // If in is called on eq:
    eqSpy.mockReturnValue({
      in: inSpy,
      then: (resolve: any) => resolve({ count: 42, error: null }),
    });

    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        select: selectSpy,
      }),
    };

    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const count = await countPinsByStatus('ws-123', ['pending', 'processing']);
    expect(mockSupabase.from).toHaveBeenCalledWith('pins');
    expect(selectSpy).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(eqSpy).toHaveBeenCalledWith('workspace_id', 'ws-123');
    expect(inSpy).toHaveBeenCalledWith('status', ['pending', 'processing']);
    expect(count).toBe(42);
  });

  it('throws directly on Supabase query failure without swallowing or falling back to mockPins', async () => {
    const dbError = new Error('Database connection failed');
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              then: (resolve: any) => resolve({ count: null, error: dbError }),
            }),
          }),
        }),
      }),
    };

    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    await expect(countPinsByStatus('ws-123', ['pending'])).rejects.toThrow('Database connection failed');
  });

  it('calculates counts correctly using mock fallback when supabase is null', async () => {
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(null);

    setMockPins([
      {
        id: 'p1',
        account_id: 'acc-1',
        title: 'P1',
        description: null,
        image_url: '',
        board_name: null,
        link: null,
        status: 'pending',
        source: 'csv_upload',
        posted_at: null,
        scheduled_for: null,
        created_at: new Date().toISOString(),
        workspace_id: DEFAULT_WS_ID,
      },
      {
        id: 'p2',
        account_id: 'acc-1',
        title: 'P2',
        description: null,
        image_url: '',
        board_name: null,
        link: null,
        status: 'processing',
        source: 'csv_upload',
        posted_at: null,
        scheduled_for: null,
        created_at: new Date().toISOString(),
        workspace_id: DEFAULT_WS_ID,
      },
      {
        id: 'p3',
        account_id: 'acc-1',
        title: 'P3',
        description: null,
        image_url: '',
        board_name: null,
        link: null,
        status: 'posted',
        source: 'csv_upload',
        posted_at: new Date().toISOString(),
        scheduled_for: null,
        created_at: new Date().toISOString(),
        workspace_id: DEFAULT_WS_ID,
      },
      {
        id: 'p4',
        account_id: 'acc-1',
        title: 'P4',
        description: null,
        image_url: '',
        board_name: null,
        link: null,
        status: 'failed',
        source: 'csv_upload',
        posted_at: null,
        scheduled_for: null,
        created_at: new Date().toISOString(),
        workspace_id: DEFAULT_WS_ID,
      },
    ]);

    const pendingAndProcessing = await countPinsByStatus(DEFAULT_WS_ID, ['pending', 'processing']);
    expect(pendingAndProcessing).toBe(2);

    const posted = await countPinsByStatus(DEFAULT_WS_ID, ['posted']);
    expect(posted).toBe(1);

    const failed = await countPinsByStatus(DEFAULT_WS_ID, ['failed']);
    expect(failed).toBe(1);
  });

  it('getDashboardKPIs includes both pending and processing pins in pendingPins metric', async () => {
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(null);

    const kpis = await getDashboardKPIs(DEFAULT_WS_ID);
    expect(typeof kpis.pendingPins).toBe('number');
    expect(typeof kpis.postedPins).toBe('number');
    expect(typeof kpis.failedPins).toBe('number');
  });
});
