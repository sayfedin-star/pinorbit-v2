import { describe, it, expect, beforeEach, vi } from 'vitest';
import { updateAccountSchedule } from '../accounts';
import * as supabaseClientModule from '../supabase-client';

describe('updateAccountSchedule Error Handling Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success: true and data when supabase update succeeds', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'acc-1', timezone: 'UTC', posting_interval_minutes: 30 },
                error: null,
              }),
            }),
          }),
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const res = await updateAccountSchedule('acc-1', {
      timezone: 'UTC',
      posting_interval_minutes: 30,
    });

    expect(res.success).toBe(true);
    expect(res.error).toBeNull();
    expect(res.data?.timezone).toBe('UTC');
  });

  it('returns success: false and error message when supabase update fails completely', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: null,
                error: { message: 'Database constraint violation' },
              }),
            }),
          }),
        }),
      }),
    };
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const res = await updateAccountSchedule('acc-test-fail', {
      posting_interval_minutes: 60,
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('Database constraint violation');
    expect(res.data).toBeDefined();
  });

  it('returns success: false and error message when supabase update throws an exception', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('Network timeout connecting to database');
      }),
    };
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const res = await updateAccountSchedule('acc-test-throw', {
      posting_interval_minutes: 45,
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('Network timeout connecting to database');
    expect(res.data).toBeDefined();
  });
});

describe('getAccountPinStats 2-Roundtrip & Parity Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('aggregates pin statuses and daily remaining accurately from 2 queries', async () => {
    const todayStr = new Date().toISOString();
    const mockPinsData = [
      { status: 'pending', retry_count: 0, posted_at: null },
      { status: 'pending', retry_count: 2, posted_at: null }, // retrying
      { status: 'processing', retry_count: 0, posted_at: null }, // pending
      { status: 'posted', retry_count: 0, posted_at: todayStr }, // posted + postedToday
      { status: 'posted', retry_count: 0, posted_at: '2026-01-01T00:00:00Z' }, // posted, old
      { status: 'failed', retry_count: 3, posted_at: null }, // failed
    ];

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'pins') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                range: vi.fn().mockResolvedValue({
                  data: mockPinsData,
                  count: 6,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { max_pins_per_day: 15 },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const stats = await updateAccountSchedule ? await (await import('../accounts')).getAccountPinStats('acc-1') : null;
    expect(stats).toBeDefined();
    expect(stats?.total).toBe(6);
    expect(stats?.pending).toBe(3); // 2 pending + 1 processing
    expect(stats?.retrying).toBe(1);
    expect(stats?.posted).toBe(2);
    expect(stats?.failed).toBe(1);
    expect(stats?.remainingToday).toBe(14); // 15 max - 1 posted today
  });

  it('paginates remaining chunks when total count exceeds 1000 pins', async () => {
    const chunk1 = Array.from({ length: 1000 }, () => ({ status: 'posted', retry_count: 0, posted_at: '2026-01-01T00:00:00Z' }));
    const chunk2 = [
      { status: 'pending', retry_count: 1, posted_at: null },
      { status: 'failed', retry_count: 3, posted_at: null },
    ];

    let callCount = 0;
    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'pins') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                range: vi.fn().mockImplementation((from: number, to: number) => {
                  callCount++;
                  if (from === 0) {
                    return Promise.resolve({ data: chunk1, count: 1002, error: null });
                  } else {
                    return Promise.resolve({ data: chunk2, count: 1002, error: null });
                  }
                }),
              }),
            }),
          };
        }
        if (table === 'accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { max_pins_per_day: 20 },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const { getAccountPinStats } = await import('../accounts');
    const stats = await getAccountPinStats('acc-bulk');

    expect(callCount).toBe(2); // Initial (0-999) + Next chunk (1000-1999)
    expect(stats.total).toBe(1002);
    expect(stats.posted).toBe(1000);
    expect(stats.pending).toBe(1);
    expect(stats.retrying).toBe(1);
    expect(stats.failed).toBe(1);
  });
});
