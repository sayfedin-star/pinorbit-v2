import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getPins,
  bulkDeletePins,
  bulkEditPins,
  bulkRetryPinsNow,
  bulkCancelPins,
} from '../pins';
import { mockPins, setMockPins } from '../supabase-mock';
import * as supabaseClientModule from '../supabase-client';

describe('getPins Top-N & Limit Unit Tests', () => {
  const originalMockPins = [...mockPins];

  beforeEach(() => {
    setMockPins([
      {
        id: 'pin-old',
        account_id: 'acc-1',
        title: 'Old Pin',
        description: null,
        image_url: 'https://example.com/old.png',
        board_name: 'Board 1',
        link: null,
        status: 'pending',
        source: 'csv_upload',
        posted_at: null,
        scheduled_for: null,
        created_at: '2026-01-01T10:00:00.000Z',
      },
      {
        id: 'pin-mid',
        account_id: 'acc-1',
        title: 'Mid Pin',
        description: null,
        image_url: 'https://example.com/mid.png',
        board_name: 'Board 1',
        link: null,
        status: 'pending',
        source: 'csv_upload',
        posted_at: null,
        scheduled_for: null,
        created_at: '2026-02-01T10:00:00.000Z',
      },
      {
        id: 'pin-new',
        account_id: 'acc-1',
        title: 'Newest Pin',
        description: null,
        image_url: 'https://example.com/new.png',
        board_name: 'Board 1',
        link: null,
        status: 'pending',
        source: 'csv_upload',
        posted_at: null,
        scheduled_for: null,
        created_at: '2026-03-01T10:00:00.000Z',
      },
    ]);
  });

  it('returns all pins when limit is omitted (backward compatibility)', async () => {
    // Force mock mode
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(null);

    const result = await getPins('all');
    expect(result.length).toBe(3);
    // Verified descending sort order
    expect(result[0].id).toBe('pin-new');
    expect(result[1].id).toBe('pin-mid');
    expect(result[2].id).toBe('pin-old');
  });

  it('returns at most limit pins when limit parameter is provided', async () => {
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(null);

    const result = await getPins('all', undefined, undefined, 2);
    expect(result.length).toBe(2);
    expect(result[0].id).toBe('pin-new');
    expect(result[1].id).toBe('pin-mid');
  });

  it('passes limit down to Supabase query builder when supabase is active', async () => {
    const limitSpy = vi.fn().mockReturnThis();
    const orderSpy = vi.fn().mockReturnThis();
    const mockQuery: any = {
      order: orderSpy,
      limit: limitSpy,
      then: (resolve: any) => resolve({ data: [], error: null }),
    };
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue(mockQuery),
      }),
    };

    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    await getPins('all', undefined, undefined, 5);
    expect(limitSpy).toHaveBeenCalledWith(5);
  });

  it('guarantees identical parity between full list slice and getPins with limit', async () => {
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(null);

    const all = await getPins('all');
    const top2 = await getPins('all', undefined, undefined, 2);

    expect(top2).toEqual(all.slice(0, 2));
  });
});

describe('Bulk Operations Error Propagation Suite', () => {
  it('returns count: 0 and error message when bulkDeletePins encounters a DB error', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ error: { message: 'Database delete failure' } }),
        }),
      }),
    };
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const res = await bulkDeletePins(['pin-1', 'pin-2']);
    expect(res.count).toBe(0);
    expect(res.error).toBe('Database delete failure');
  });

  it('returns count: 0 and error message when bulkDeletePins throws an exception', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('Network timeout during delete');
      }),
    };
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const res = await bulkDeletePins(['pin-1']);
    expect(res.count).toBe(0);
    expect(res.error).toBe('Network timeout during delete');
  });

  it('returns count: 0 and error message when bulkEditPins encounters a DB error', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ error: { message: 'Database update constraint error' } }),
        }),
      }),
    };
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const res = await bulkEditPins(['pin-1'], { board_name: 'New Board' });
    expect(res.count).toBe(0);
    expect(res.error).toBe('Database update constraint error');
  });

  it('returns count: 0 and error message when bulkRetryPinsNow encounters a DB error', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ error: { message: 'Rate limit on retry' } }),
        }),
      }),
    };
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const res = await bulkRetryPinsNow(['pin-1']);
    expect(res.count).toBe(0);
    expect(res.error).toBe('Rate limit on retry');
  });

  it('returns count: 0 and error message when bulkCancelPins encounters a DB error', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ error: { message: 'Permission denied on cancel' } }),
        }),
      }),
    };
    vi.spyOn(supabaseClientModule, 'supabase', 'get').mockReturnValue(mockSupabase);

    const res = await bulkCancelPins(['pin-1']);
    expect(res.count).toBe(0);
    expect(res.error).toBe('Permission denied on cancel');
  });
});
