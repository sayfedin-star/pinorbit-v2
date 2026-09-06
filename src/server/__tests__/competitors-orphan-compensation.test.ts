import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schedulesIndexApi from '../../pages/api/competitors/schedules/index';
import * as schedulesIdApi from '../../pages/api/competitors/schedules/[id]';
import * as schedulesBulkApi from '../../pages/api/competitors/schedules/bulk';
import * as fastcronClient from '../lib/fastcron-client';
import * as workspaceGuard from '../auth/workspace-guard';
import * as tokenResolver from '../lib/token-resolver';
import * as webhookSecrets from '../services/webhook-secrets';
import { dbClients } from '../db/clients';

describe('Competitors Orphan Compensation & Token Redaction Suite (P1 #R4 & P2 #R11)', () => {
  const mockWorkspaceId = '44444444-5555-6666-7777-888888888888';
  const mockUserId = '99999999-8888-7777-6666-555555555555';
  const sensitiveToken = 'sensitive_raw_dispatch_token_123';

  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
      workspaceId: mockWorkspaceId,
      role: 'admin',
      isAdmin: true,
      isOwner: true,
    } as any);

    vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
      value: 'secret_test_key_12345',
      source: 'workspace',
    });

    vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
      token: 'fc_api_token_test',
      source: 'workspace_registry',
      tokenId: 'tok-1',
      name: 'Default',
      maskedToken: '••••1234',
    });
  });

  describe('POST /api/competitors/schedules (index.ts)', () => {
    it('redacts dispatch_token and sets has_dispatch_token: true on successful creation', async () => {
      const mockCompAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'competitor_schedules') {
            return {
              insert: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: {
                      id: 'sched-created-1',
                      workspace_id: mockWorkspaceId,
                      label: 'Test Schedule',
                      cron_expression: '0 2 * * *',
                      dispatch_token: sensitiveToken,
                      fastcron_job_id: '10101',
                    },
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

      vi.spyOn(fastcronClient, 'fastcronCall').mockResolvedValue({
        success: true,
        data: { id: 10101 },
      });

      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({ data: { name: 'Test WS' }, error: null })),
        })),
      };

      const request = new Request('http://localhost/api/competitors/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Test Schedule',
          cron_expression: '0 2 * * *',
        }),
      });

      const response = await schedulesIndexApi.POST({
        request,
        locals: {
          user: { id: mockUserId },
          supabase: mockSupabase,
          activeWorkspaceId: mockWorkspaceId,
        },
      } as any);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.schedule.has_dispatch_token).toBe(true);
      expect(body.schedule.dispatch_token).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(sensitiveToken);
    });

    it('triggers compensating cron_delete when DB insert fails after FastCron job creation', async () => {
      const fastcronCallSpy = vi.spyOn(fastcronClient, 'fastcronCall').mockImplementation(async (action: string) => {
        if (action === 'cron_add') {
          return { success: true, data: { id: 20202 } };
        }
        if (action === 'cron_delete') {
          return { success: true, data: { status: 'OK' } };
        }
        return { success: true, data: {} };
      });

      const mockCompAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'competitor_schedules') {
            return {
              insert: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: null,
                    error: new Error('duplicate key value violates unique constraint'),
                  })),
                })),
              })),
            };
          }
          return {};
        }),
      };
      vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockCompAdmin as any);

      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({ data: { name: 'Test WS' }, error: null })),
        })),
      };

      const request = new Request('http://localhost/api/competitors/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Failing Schedule',
          cron_expression: '0 2 * * *',
        }),
      });

      const response = await schedulesIndexApi.POST({
        request,
        locals: {
          user: { id: mockUserId },
          supabase: mockSupabase,
          activeWorkspaceId: mockWorkspaceId,
        },
      } as any);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('unique constraint');

      // Verify compensating cron_delete was called with the created job ID
      expect(fastcronCallSpy).toHaveBeenCalledWith(
        'cron_delete',
        { id: '20202' },
        'fc_api_token_test'
      );
    });
  });

  describe('PATCH /api/competitors/schedules/[id] ([id].ts)', () => {
    it('redacts dispatch_token and sets has_dispatch_token: true on update', async () => {
      const scheduleUuid = '11111111-2222-3333-4444-555555555555';
      const mockCompAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'competitor_schedules') {
            const selectBuilder: any = {
              eq: vi.fn(() => selectBuilder),
              maybeSingle: vi.fn(async () => ({
                data: {
                  id: scheduleUuid,
                  workspace_id: mockWorkspaceId,
                  label: 'Old Label',
                  cron_expression: '0 2 * * *',
                  fastcron_job_id: '12345',
                  fastcron_token_id: 'tok-1',
                  status: 'active',
                },
                error: null,
              })),
            };

            const updateBuilder: any = {
              eq: vi.fn(() => updateBuilder),
              select: vi.fn(() => updateBuilder),
              single: vi.fn(async () => ({
                data: {
                  id: scheduleUuid,
                  workspace_id: mockWorkspaceId,
                  label: 'Updated Label',
                  dispatch_token: sensitiveToken,
                  fastcron_job_id: '12345',
                  status: 'active',
                },
                error: null,
              })),
            };

            return {
              select: vi.fn(() => selectBuilder),
              update: vi.fn(() => updateBuilder),
            };
          }
          return {};
        }),
      };
      vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockCompAdmin as any);

      vi.spyOn(fastcronClient, 'fastcronCall').mockResolvedValue({
        success: true,
        data: { id: 12345 },
      });

      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({ data: { name: 'Test WS' }, error: null })),
        })),
      };

      const request = new Request(`http://localhost/api/competitors/schedules/${scheduleUuid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Updated Label',
        }),
      });

      const response = await schedulesIdApi.PATCH({
        params: { id: scheduleUuid },
        request,
        locals: {
          user: { id: mockUserId },
          supabase: mockSupabase,
          activeWorkspaceId: mockWorkspaceId,
        },
      } as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.schedule.has_dispatch_token).toBe(true);
      expect(body.schedule.dispatch_token).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(sensitiveToken);
    });
  });

  describe('POST /api/competitors/schedules/bulk (bulk.ts action: clone)', () => {
    it('triggers compensating cron_delete when cloned DB insert throws', async () => {
      const fastcronCallSpy = vi.spyOn(fastcronClient, 'fastcronCall').mockImplementation(async (action: string) => {
        if (action === 'cron_add') {
          return { success: true, data: { id: 30303 } };
        }
        if (action === 'cron_delete') {
          return { success: true, data: { status: 'OK' } };
        }
        return { success: true, data: {} };
      });

      const mockCompAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'competitor_schedules') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  in: vi.fn(async () => ({
                    data: [
                      {
                        id: 'sched-to-clone',
                        workspace_id: mockWorkspaceId,
                        label: 'Original Schedule',
                        cron_expression: '0 4 * * *',
                        timezone: 'UTC',
                        fastcron_job_id: '9999',
                        fastcron_token_id: 'tok-1',
                        status: 'active',
                      },
                    ],
                    error: null,
                  })),
                })),
              })),
              insert: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: vi.fn(async () => {
                    throw new Error('DB connection terminated unexpectedly');
                  }),
                })),
              })),
            };
          }
          return {};
        }),
      };
      vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockCompAdmin as any);

      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({ data: { name: 'Test WS' }, error: null })),
        })),
      };

      const request = new Request('http://localhost/api/competitors/schedules/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'clone',
          ids: ['sched-to-clone'],
        }),
      });

      const response = await schedulesBulkApi.POST({
        request,
        locals: {
          user: { id: mockUserId },
          supabase: mockSupabase,
          activeWorkspaceId: mockWorkspaceId,
        },
      } as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.failed).toBe(1);
      expect(body.succeeded).toBe(0);
      expect(body.results[0].success).toBe(false);
      expect(body.results[0].error).toContain('DB connection terminated unexpectedly');

      // Verify compensating cron_delete was called
      expect(fastcronCallSpy).toHaveBeenCalledWith(
        'cron_delete',
        { id: '30303' },
        'fc_api_token_test'
      );
    });
  });
});
