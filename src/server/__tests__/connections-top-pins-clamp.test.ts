import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as getTopPins } from '../../pages/api/analytics/connections/[id]/top-pins';
import { pinnerAnalyticsService } from '../services/pinner-analytics-service';

vi.mock('../services/pinner-analytics-service', () => ({
  pinnerAnalyticsService: {
    getTopPinsServerPaginated: vi.fn().mockResolvedValue({
      data: { rows: [], total: 0 },
      cacheStatus: 'MISS',
    }),
  },
}));

describe('Analytics Per-Connection Top Pins: Parameter Clamping', () => {
  const connectionId = 'conn-123';
  const workspaceId = '00000000-0000-0000-0000-000000000001';

  let mockLocals: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocals = {
      user: { id: 'user-1' },
      supabase: {},
      activeWorkspaceId: workspaceId,
      runtime: { env: {} },
    };
  });

  it('clamps limit to [1, 100] and defaults to 50', async () => {
    // 1. limit=250 clamped to 100
    const req1 = new Request(`http://localhost:4321/api/analytics/connections/${connectionId}/top-pins?limit=250`);
    const res1 = await getTopPins({
      params: { id: connectionId },
      request: req1,
      locals: mockLocals,
    } as any);
    expect(res1.status).toBe(200);
    expect(vi.mocked(pinnerAnalyticsService.getTopPinsServerPaginated)).toHaveBeenLastCalledWith(
      expect.anything(),
      'user-1',
      workspaceId,
      connectionId,
      'IMPRESSION',
      100, // clamped
      undefined,
      false,
      undefined,
      undefined,
      1,
      25,
      ''
    );

    // 2. limit=0 clamped to 1
    const req2 = new Request(`http://localhost:4321/api/analytics/connections/${connectionId}/top-pins?limit=0`);
    const res2 = await getTopPins({
      params: { id: connectionId },
      request: req2,
      locals: mockLocals,
    } as any);
    expect(res2.status).toBe(200);
    expect(vi.mocked(pinnerAnalyticsService.getTopPinsServerPaginated)).toHaveBeenLastCalledWith(
      expect.anything(),
      'user-1',
      workspaceId,
      connectionId,
      'IMPRESSION',
      1, // clamped
      undefined,
      false,
      undefined,
      undefined,
      1,
      25,
      ''
    );

    // 3. limit omitted defaults to 50
    const req3 = new Request(`http://localhost:4321/api/analytics/connections/${connectionId}/top-pins`);
    const res3 = await getTopPins({
      params: { id: connectionId },
      request: req3,
      locals: mockLocals,
    } as any);
    expect(res3.status).toBe(200);
    expect(vi.mocked(pinnerAnalyticsService.getTopPinsServerPaginated)).toHaveBeenLastCalledWith(
      expect.anything(),
      'user-1',
      workspaceId,
      connectionId,
      'IMPRESSION',
      50, // default
      undefined,
      false,
      undefined,
      undefined,
      1,
      25,
      ''
    );
  });

  it('clamps pageSize to [1, 100] and page to >= 1', async () => {
    const req = new Request(`http://localhost:4321/api/analytics/connections/${connectionId}/top-pins?page=-5&page_size=500`);
    const res = await getTopPins({
      params: { id: connectionId },
      request: req,
      locals: mockLocals,
    } as any);
    expect(res.status).toBe(200);
    expect(vi.mocked(pinnerAnalyticsService.getTopPinsServerPaginated)).toHaveBeenLastCalledWith(
      expect.anything(),
      'user-1',
      workspaceId,
      connectionId,
      'IMPRESSION',
      50,
      undefined,
      false,
      undefined,
      undefined,
      1, // clamped from -5
      100, // clamped from 500
      ''
    );
  });
});
