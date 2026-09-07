import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isValidTimeZone } from '../lib/timezone';
import { POST as competitorCronPost } from '../../pages/api/competitors/cron';
import { POST as pinArchiveCronPost } from '../../pages/api/pinarchive/cron';
import * as webhookSecrets from '../services/webhook-secrets';
import * as workspaceGuard from '../auth/workspace-guard';
import * as tokenResolver from '../lib/token-resolver';
import * as fastcronClient from '../lib/fastcron-client';

describe('Cron Timezone Validation Suite (Competitors & PinArchive)', () => {
  const mockWorkspaceId = '11111111-2222-3333-4444-555555555555';
  const mockUserId = '99999999-8888-7777-6666-555555555555';

  describe('1. isValidTimeZone Helper Unit Tests', () => {
    it('returns true for standard IANA timezones', () => {
      expect(isValidTimeZone('UTC')).toBe(true);
      expect(isValidTimeZone('America/New_York')).toBe(true);
      expect(isValidTimeZone('Europe/London')).toBe(true);
      expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
      expect(isValidTimeZone('Australia/Sydney')).toBe(true);
      expect(isValidTimeZone('Etc/GMT')).toBe(true);
    });

    it('returns false for invalid, malformed, or non-string timezones', () => {
      expect(isValidTimeZone('Invalid/Timezone')).toBe(false);
      expect(isValidTimeZone('America/NonExistentCity')).toBe(false);
      expect(isValidTimeZone('NotATimezone')).toBe(false);
      expect(isValidTimeZone('Mars/Phobos')).toBe(false);
      expect(isValidTimeZone('')).toBe(false);
      expect(isValidTimeZone('   ')).toBe(false);
      expect(isValidTimeZone(null)).toBe(false);
      expect(isValidTimeZone(undefined)).toBe(false);
      expect(isValidTimeZone(12345)).toBe(false);
      expect(isValidTimeZone({})).toBe(false);
      expect(isValidTimeZone(['UTC'])).toBe(false);
    });
  });

  describe('2. Competitor Cron API (/api/competitors/cron)', () => {
    let mockLocals: any;

    beforeEach(() => {
      vi.clearAllMocks();

      vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
        id: 'mem-1',
        role: 'admin',
        isAdmin: true,
        isOwner: false,
      } as any);

      vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
        value: 'sec_test_secret_123',
        source: 'workspace',
      });

      vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
        token: 'fastcron_test_token',
        source: 'workspace',
      } as any);

      vi.spyOn(fastcronClient, 'fastcronCall').mockResolvedValue({
        success: true,
        data: { id: 77777 },
      });

      const mockSupabase = {
        from: () => {
          const builder: any = {
            select: () => builder,
            eq: () => builder,
            maybeSingle: async () => ({ data: { name: 'Test Workspace' }, error: null }),
            upsert: async () => ({ error: null }),
          };
          return builder;
        },
      };

      mockLocals = {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          COMPETITORS_DISPATCH_URL: 'https://example.com/api/internal/competitors/dispatch',
        },
      };
    });

    it('rejects invalid IANA timezone with 400 on schedule creation', async () => {
      const req = new Request('https://example.com/api/competitors/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          cron_expression: '0 2 * * *',
          timezone: 'Mars/Phobos',
        }),
      });

      const res = await competitorCronPost({ request: req, locals: mockLocals } as any);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe('Invalid timezone. Must be a valid IANA timezone name.');
    });

    it('accepts valid IANA timezone on schedule creation', async () => {
      const req = new Request('https://example.com/api/competitors/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          cron_expression: '0 2 * * *',
          timezone: 'America/New_York',
        }),
      });

      const res = await competitorCronPost({ request: req, locals: mockLocals } as any);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(fastcronClient.fastcronCall).toHaveBeenCalledWith(
        'cron_add',
        expect.objectContaining({
          timezone: 'America/New_York',
        }),
        'fastcron_test_token'
      );
    });

    it('defaults to UTC when timezone is omitted', async () => {
      const req = new Request('https://example.com/api/competitors/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          cron_expression: '0 2 * * *',
        }),
      });

      const res = await competitorCronPost({ request: req, locals: mockLocals } as any);
      expect(res.status).toBe(200);

      expect(fastcronClient.fastcronCall).toHaveBeenCalledWith(
        'cron_add',
        expect.objectContaining({
          timezone: 'UTC',
        }),
        'fastcron_test_token'
      );
    });
  });

  describe('3. PinArchive Cron API (/api/pinarchive/cron)', () => {
    let mockLocals: any;

    beforeEach(() => {
      vi.clearAllMocks();

      vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
        value: 'sec_test_secret_123',
        source: 'workspace',
      });

      vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
        token: 'fastcron_test_token',
        source: 'workspace',
      } as any);

      vi.spyOn(fastcronClient, 'fastcronCall').mockImplementation(async (action: string) => {
        if (action === 'cron_get') {
          return {
            success: true,
            data: {
              id: 88888,
              name: 'PinOrbit pinarchive — Test Workspace — Default — 11111111',
              url: 'https://example.com/api/internal/pinarchive/dispatch?workspace_id=11111111-2222-3333-4444-555555555555&secret=sec_test_secret_123',
            },
          };
        }
        return {
          success: true,
          data: { id: 88888 },
        };
      });

      const mockSupabase = {
        from: () => {
          const builder: any = {
            select: () => builder,
            eq: () => builder,
            single: async () => ({ data: { id: 'm1', role: 'admin' }, error: null }),
            maybeSingle: async () => ({ data: { id: 'm1', role: 'admin', name: 'Test Workspace' }, error: null }),
            upsert: async () => ({ error: null }),
          };
          return builder;
        },
      };

      mockLocals = {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          PINARCHIVE_DISPATCH_URL: 'https://example.com/api/internal/pinarchive/dispatch',
        },
      };
    });

    it('rejects invalid IANA timezone on create with 400', async () => {
      const req = new Request('https://example.com/api/pinarchive/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          cron_expression: '0 3 * * *',
          timezone: 'Fake/Timezone',
        }),
      });

      const res = await pinArchiveCronPost({ request: req, locals: mockLocals } as any);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe('Invalid timezone. Must be a valid IANA timezone name.');
    });

    it('rejects invalid IANA timezone on edit with 400', async () => {
      const req = new Request('https://example.com/api/pinarchive/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          job_id: 88888,
          cron_expression: '0 3 * * *',
          timezone: 'Not_A_Timezone',
        }),
      });

      const res = await pinArchiveCronPost({ request: req, locals: mockLocals } as any);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe('Invalid timezone. Must be a valid IANA timezone name.');
    });

    it('accepts valid IANA timezone on create', async () => {
      const req = new Request('https://example.com/api/pinarchive/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          cron_expression: '0 3 * * *',
          timezone: 'Europe/Paris',
        }),
      });

      const res = await pinArchiveCronPost({ request: req, locals: mockLocals } as any);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(fastcronClient.fastcronCall).toHaveBeenCalledWith(
        'cron_add',
        expect.objectContaining({
          timezone: 'Europe/Paris',
        }),
        'fastcron_test_token'
      );
    });
  });
});
