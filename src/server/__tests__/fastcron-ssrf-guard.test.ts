import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fastcronService, triggerBoardAction } from '../services/fastcron-service';
import { analyticsDb } from '../db/analytics';
import { dbClients } from '../db/clients';

vi.mock('../db/analytics', () => ({
  analyticsDb: {
    getWorkspaceConnection: vi.fn(),
    getWorkspaceAnalyticsSettings: vi.fn(),
  },
}));

describe('FastCron Sibling Webhook SSRF Guard Suite (P1 #R2)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const connectionId = 'conn-1111-2222-3333-444444444444';
  const accountId = 'acc-1111-2222-3333-444444444444';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('triggerBoardAction SSRF Guard', () => {
    it('blocks private IP IMDS webhook (169.254.169.254) and prevents outbound fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const mockSchedulingAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'accounts') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: {
                      workspace_id: workspaceId,
                      board_webhook_id: 'wh-imds',
                    },
                    error: null,
                  })),
                })),
              })),
            };
          }
          if (table === 'account_webhooks') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                      data: {
                        id: 'wh-imds',
                        webhook_url: 'http://169.254.169.254/latest/meta-data',
                      },
                      error: null,
                    })),
                  })),
                })),
              })),
            };
          }
          return {};
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockSchedulingAdmin as any);

      const result = await triggerBoardAction(accountId, 'create', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF guard rejected webhook URL');
      expect(result.error).toContain('169.254.169.254');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('blocks loopback IP webhook (127.0.0.1) and prevents outbound fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const mockSchedulingAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'accounts') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: {
                      workspace_id: workspaceId,
                      board_webhook_id: 'wh-loopback',
                    },
                    error: null,
                  })),
                })),
              })),
            };
          }
          if (table === 'account_webhooks') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                      data: {
                        id: 'wh-loopback',
                        webhook_url: 'http://127.0.0.1:80/api/internal',
                      },
                      error: null,
                    })),
                  })),
                })),
              })),
            };
          }
          return {};
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockSchedulingAdmin as any);

      const result = await triggerBoardAction(accountId, 'create', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF guard rejected webhook URL');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns error when webhook URL is missing', async () => {
      const mockQueryBuilder = {
        eq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn(async () => ({ data: [], error: null })),
        maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      };

      const mockSchedulingAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'accounts') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: {
                      workspace_id: workspaceId,
                      board_webhook_id: null,
                    },
                    error: null,
                  })),
                })),
              })),
            };
          }
          if (table === 'account_webhooks') {
            return {
              select: vi.fn(() => mockQueryBuilder),
            };
          }
          return {};
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockSchedulingAdmin as any);

      const result = await triggerBoardAction(accountId, 'create', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('No webhook URL found for board actions');
    });

    it('allows valid safe webhook and executes fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
      } as any);

      const mockSchedulingAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'accounts') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: {
                      workspace_id: workspaceId,
                      board_webhook_id: 'wh-valid',
                    },
                    error: null,
                  })),
                })),
              })),
            };
          }
          if (table === 'account_webhooks') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                      data: {
                        id: 'wh-valid',
                        webhook_url: 'https://hook.make.com/valid-board-webhook',
                      },
                      error: null,
                    })),
                  })),
                })),
              })),
            };
          }
          return {};
        }),
        rpc: vi.fn(async () => ({ data: null, error: null })),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockSchedulingAdmin as any);

      const result = await triggerBoardAction(accountId, 'create', {});

      expect(result.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('triggerManualSync SSRF Guard', () => {
    it('mode: ping blocks private IP IMDS webhook and returns exact error shape', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
        id: connectionId,
        workspace_id: workspaceId,
        analytics_webhook_url: 'https://169.254.169.254/ping',
        analytics_start_offset_days: 7,
        analytics_end_offset_days: 1,
      });

      const runtimeEnv = { ALLOWED_WEBHOOK_HOSTS: '169.254.169.254' };
      const result = await fastcronService.triggerManualSync(
        workspaceId,
        connectionId,
        'analytics',
        'ping',
        runtimeEnv
      );

      expect(result.success).toBe(false);
      expect(result.connection_id).toBe(connectionId);
      expect(result.channel).toBe('analytics');
      expect(result.mode).toBe('ping');
      expect(result.error).toContain('SSRF guard rejected webhook URL');
      expect(result.error).toContain('169.254.169.254');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('mode: sync legacy fallback blocks private IP and returns exact error shape', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
        id: connectionId,
        workspace_id: workspaceId,
        analytics_webhook_url: 'https://127.0.0.1/sync',
        analytics_fastcron_job_id: null,
        analytics_fastcron_token: null,
        fastcron_token: null,
      });
      (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
        fastcron_token: null,
      });

      const runtimeEnv = { ALLOWED_WEBHOOK_HOSTS: '127.0.0.1' };
      const result = await fastcronService.triggerManualSync(
        workspaceId,
        connectionId,
        'analytics',
        'sync',
        runtimeEnv
      );

      expect(result.success).toBe(false);
      expect(result.connection_id).toBe(connectionId);
      expect(result.channel).toBe('analytics');
      expect(result.mode).toBe('sync');
      expect(result.error).toContain('SSRF guard rejected webhook URL');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('mode: ping returns error when webhook URL is missing', async () => {
      (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
        id: connectionId,
        workspace_id: workspaceId,
        analytics_webhook_url: null,
      });

      vi.spyOn(fastcronService, 'validateWebhookUrl').mockReturnValue({ valid: true });

      const result = await fastcronService.triggerManualSync(
        workspaceId,
        connectionId,
        'analytics',
        'ping',
        {}
      );

      expect(result.success).toBe(false);
      expect(result.connection_id).toBe(connectionId);
      expect(result.channel).toBe('analytics');
      expect(result.mode).toBe('ping');
      expect(result.error).toBe('No webhook URL configured');
    });

    it('mode: sync returns error when webhook URL is missing in fallback', async () => {
      (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
        id: connectionId,
        workspace_id: workspaceId,
        analytics_webhook_url: null,
        analytics_fastcron_job_id: null,
      });
      (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
        fastcron_token: null,
      });

      vi.spyOn(fastcronService, 'validateWebhookUrl').mockReturnValue({ valid: true });

      const result = await fastcronService.triggerManualSync(
        workspaceId,
        connectionId,
        'analytics',
        'sync',
        {}
      );

      expect(result.success).toBe(false);
      expect(result.connection_id).toBe(connectionId);
      expect(result.channel).toBe('analytics');
      expect(result.mode).toBe('sync');
      expect(result.error).toBe('No webhook URL configured');
    });
  });
});
