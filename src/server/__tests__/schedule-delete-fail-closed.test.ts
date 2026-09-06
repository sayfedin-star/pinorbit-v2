import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deletePublishingSchedule } from '../services/fastcron-service';
import { fastcronService } from '../services/fastcron-service';
import { dbClients } from '../db/clients';
import { DELETE as singleDeleteHandler } from '../../pages/api/schedules/[id]';
import { POST as actionHandler } from '../../pages/api/schedules/[id]/action';
import { POST as bulkHandler } from '../../pages/api/schedules/bulk';
import * as workspaceGuard from '../auth/workspace-guard';
import * as tokenResolver from '../lib/token-resolver';

describe('Publishing Schedules Fail-Closed Remote Deletion Suite', () => {
  const mockWorkspaceId = '11111111-2222-3333-4444-555555555555';
  const mockScheduleId = 'sched-0000-1111-2222-333333333333';
  const mockJobId = 98765;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. deletePublishingSchedule core behavior', () => {
    it('aborts database delete and returns success:false when FastCron remote delete fails', async () => {
      vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
        token: 'test_token',
        source: 'workspace_registry',
        tokenId: 'tok-1',
        name: 'Test',
        maskedToken: '••••1234',
      });

      vi.spyOn(fastcronService, 'fastcronCall').mockResolvedValue({
        success: false,
        error: 'FastCron 500: Internal Server Error',
      });

      let dbDeleteCalled = false;
      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: mockScheduleId,
                    workspace_id: mockWorkspaceId,
                    fastcron_job_id: mockJobId,
                  },
                }),
              }),
            }),
          }),
          delete: vi.fn().mockImplementation(() => {
            dbDeleteCalled = true;
            return {
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            };
          }),
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

      const result = await deletePublishingSchedule(
        mockScheduleId,
        mockJobId,
        {},
        mockWorkspaceId
      );

      expect(result.success).toBe(false);
      expect(result.remote_deleted).toBe(false);
      expect(result.remote_error).toContain('FastCron 500');
      expect(dbDeleteCalled).toBe(false);
    });
  });

  describe('2. DELETE /api/schedules/[id] HTTP 502 mapping', () => {
    it('returns HTTP 502 with remote_deleted:false and preserves row when FastCron delete fails', async () => {
      vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
        role: 'admin',
        workspaceId: mockWorkspaceId,
        isAdmin: true,
        isOwner: true,
      } as any);

      vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
        token: 'test_token',
        source: 'workspace_registry',
        tokenId: 'tok-1',
        name: 'Test',
        maskedToken: '••••1234',
      });

      vi.spyOn(fastcronService, 'fastcronCall').mockResolvedValue({
        success: false,
        error: 'FastCron API connection timeout',
      });

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: mockScheduleId,
                    workspace_id: mockWorkspaceId,
                    fastcron_job_id: mockJobId,
                  },
                }),
              }),
            }),
          }),
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          }),
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

      const request = new Request(`http://localhost/api/schedules/${mockScheduleId}`, {
        method: 'DELETE',
      });
      const response = await singleDeleteHandler({
        request,
        params: { id: mockScheduleId },
        locals: {
          user: { id: 'user-1' },
          supabase: mockAdmin,
          activeWorkspaceId: mockWorkspaceId,
        },
      } as any);

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.remote_deleted).toBe(false);
      expect(data.remote_error).toContain('FastCron API connection timeout');
    });
  });

  describe('3. POST /api/schedules/[id]/action delete branch HTTP 502 mapping', () => {
    it('returns HTTP 502 when action is delete and remote FastCron delete fails', async () => {
      vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
        role: 'admin',
        workspaceId: mockWorkspaceId,
        isAdmin: true,
        isOwner: true,
      } as any);

      vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
        token: 'test_token',
        source: 'workspace_registry',
        tokenId: 'tok-1',
        name: 'Test',
        maskedToken: '••••1234',
      });

      vi.spyOn(fastcronService, 'fastcronCall').mockResolvedValue({
        success: false,
        error: 'FastCron remote failure',
      });

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: mockScheduleId,
                    workspace_id: mockWorkspaceId,
                    fastcron_job_id: mockJobId,
                  },
                }),
              }),
            }),
          }),
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          }),
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

      const request = new Request(`http://localhost/api/schedules/${mockScheduleId}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: 'delete' }),
      });
      const response = await actionHandler({
        request,
        params: { id: mockScheduleId },
        locals: {
          user: { id: 'user-1' },
          supabase: mockAdmin,
          activeWorkspaceId: mockWorkspaceId,
        },
      } as any);

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.remote_deleted).toBe(false);
      expect(data.remote_error).toContain('FastCron remote failure');
    });
  });

  describe('4. POST /api/schedules/bulk delete action fail-closed reporting', () => {
    it('records success:false and increments remote_orphans when FastCron delete fails', async () => {
      vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
        role: 'admin',
        workspaceId: mockWorkspaceId,
        isAdmin: true,
        isOwner: true,
      } as any);

      vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
        token: 'test_token',
        source: 'workspace_registry',
        tokenId: 'tok-1',
        name: 'Test',
        maskedToken: '••••1234',
      });

      vi.spyOn(fastcronService, 'fastcronCall').mockResolvedValue({
        success: false,
        error: 'FastCron bulk delete timeout',
      });

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: mockScheduleId,
                    workspace_id: mockWorkspaceId,
                    fastcron_job_id: mockJobId,
                  },
                ],
              }),
            }),
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: mockScheduleId,
                    workspace_id: mockWorkspaceId,
                    fastcron_job_id: mockJobId,
                  },
                }),
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: mockScheduleId,
                    workspace_id: mockWorkspaceId,
                    fastcron_job_id: mockJobId,
                  },
                }),
              }),
            }),
          }),
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          }),
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

      const request = new Request(`http://localhost/api/schedules/bulk`, {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', ids: [mockScheduleId] }),
      });
      const response = await bulkHandler({
        request,
        locals: {
          user: { id: 'user-1' },
          supabase: mockAdmin,
          activeWorkspaceId: mockWorkspaceId,
        },
      } as any);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.failed).toBe(1);
      expect(data.success).toBe(0);
      expect(data.remote_orphans).toBe(1);
      expect(data.results[0].success).toBe(false);
      expect(data.results[0].remote_deleted).toBe(false);
      expect(data.results[0].remote_error).toContain('FastCron bulk delete timeout');
    });
  });
});
