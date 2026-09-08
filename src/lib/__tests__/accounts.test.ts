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
