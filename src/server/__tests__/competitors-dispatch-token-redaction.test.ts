import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as competitorSchedulesGet } from '../../pages/api/competitors/schedules/index';
import * as workspaceGuard from '../auth/workspace-guard';
import * as tokenResolver from '../lib/token-resolver';
import { dbClients } from '../db/clients';

describe('Competitors Dispatch Token Redaction Suite (competitors-dispatch-token-redaction.test.ts)', () => {
  const mockWorkspaceId = '00000000-0000-0000-0000-000000000001';
  const mockScheduleId = 'sched-1111-2222-3333-444444444444';
  const sensitiveDispatchToken = 'sensitive_bearer_dispatch_token_xyz_999';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('P0 #5: omits raw dispatch_token and exposes only has_dispatch_token in schedule list', async () => {
    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
      role: 'member',
      workspaceId: mockWorkspaceId,
      isAdmin: false,
      isOwner: false,
    } as any);

    vi.spyOn(tokenResolver, 'listWorkspaceTokens').mockResolvedValue([]);
    vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
      token: 'fc_token_123',
      source: 'workspace_registry',
      tokenId: 'tok-1',
      name: 'Default',
      maskedToken: '••••1234',
    });

    const mockCompAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'competitor_schedules') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(async () => ({
                  data: [
                    {
                      id: mockScheduleId,
                      workspace_id: mockWorkspaceId,
                      label: 'Daily Competitor Crawl',
                      cron_expression: '0 3 * * *',
                      timezone: 'UTC',
                      status: 'active',
                      dispatch_token: sensitiveDispatchToken,
                      fastcron_job_id: 12345,
                      fastcron_token_id: 'tok-1',
                    },
                  ],
                  error: null,
                })),
              })),
            })),
          };
        }
        return {};
      }),
    };
    vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockCompAdmin as any);

    const request = new Request('http://localhost/api/competitors/schedules');
    const response = await competitorSchedulesGet({
      request,
      locals: {
        user: { id: 'member-user-id' },
        supabase: mockCompAdmin,
        activeWorkspaceId: mockWorkspaceId,
      },
    } as any);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.schedules).toHaveLength(1);

    const schedule = body.schedules[0];
    expect(schedule.has_dispatch_token).toBe(true);
    expect(schedule.dispatch_token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(sensitiveDispatchToken);
  });
});
