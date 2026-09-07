import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as createSchedule, isValidTimeZone } from '../../pages/api/competitors/schedules/index';
import { PATCH as updateSchedule } from '../../pages/api/competitors/schedules/[id]';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { dbClients } from '../db/clients';
import { fastcronCall } from '../lib/fastcron-client';
import { resolveToken } from '../lib/token-resolver';

vi.mock('../services/webhook-secrets', () => ({
  getEffectiveSecret: vi.fn().mockResolvedValue({
    value: 'test-secret-key-12345',
    source: 'workspace',
  }),
}));

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue({
    id: 'mem-1',
    role: 'admin',
    isAdmin: true,
    isOwner: false,
  }),
}));

vi.mock('../lib/fastcron-client', () => ({
  fastcronCall: vi.fn().mockResolvedValue({
    success: true,
    data: { id: 12345 },
  }),
  isFastCronJobPaused: vi.fn().mockReturnValue(false),
}));

vi.mock('../lib/token-resolver', () => ({
  resolveToken: vi.fn().mockResolvedValue({
    token: 'test-cron-token',
    source: 'workspace',
  }),
  listWorkspaceTokens: vi.fn().mockResolvedValue([
    { id: 'tok-1', name: 'default' },
  ]),
}));

describe('Competitor Schedules: IANA Timezone Validation & Input Hardening', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const scheduleId = '11111111-1111-1111-1111-111111111111';

  let mockSupabase: any;
  let mockCompAdmin: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSupabase = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { name: 'Test Workspace' },
              error: null,
            }),
          })),
        })),
      })),
    };

    mockCompAdmin = {
      from: vi.fn((table: string) => {
        const query: any = {
          select: vi.fn(() => query),
          insert: vi.fn(() => query),
          update: vi.fn(() => query),
          eq: vi.fn(() => query),
          maybeSingle: vi.fn(async () => {
            if (table === 'competitor_schedules') {
              return {
                data: {
                  id: scheduleId,
                  workspace_id: workspaceId,
                  fastcron_job_id: '99999',
                  cron_expression: '0 2 * * *',
                  timezone: 'UTC',
                  status: 'active',
                },
                error: null,
              };
            }
            return { data: null, error: null };
          }),
          single: vi.fn(async () => ({
            data: {
              id: scheduleId,
              workspace_id: workspaceId,
              fastcron_job_id: '99999',
              cron_expression: '0 2 * * *',
              timezone: 'UTC',
              status: 'active',
            },
            error: null,
          })),
        };
        return query;
      }),
    };

    vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockCompAdmin as any);
  });

  describe('isValidTimeZone unit helper', () => {
    it('returns true for valid IANA timezones', () => {
      expect(isValidTimeZone('UTC')).toBe(true);
      expect(isValidTimeZone('America/New_York')).toBe(true);
      expect(isValidTimeZone('Europe/London')).toBe(true);
      expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
      expect(isValidTimeZone('  America/Los_Angeles  ')).toBe(true);
    });

    it('returns false for invalid, non-string, or empty timezones', () => {
      expect(isValidTimeZone('Invalid/Timezone')).toBe(false);
      expect(isValidTimeZone('NotATimezone')).toBe(false);
      expect(isValidTimeZone('')).toBe(false);
      expect(isValidTimeZone('   ')).toBe(false);
      expect(isValidTimeZone(null)).toBe(false);
      expect(isValidTimeZone(undefined)).toBe(false);
      expect(isValidTimeZone(12345)).toBe(false);
      expect(isValidTimeZone({})).toBe(false);
    });
  });

  describe('POST /api/competitors/schedules', () => {
    it('rejects invalid IANA timezone with 400', async () => {
      const req = new Request('http://localhost:4321/api/competitors/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cron_expression: '0 2 * * *',
          timezone: 'Mars/Phobos',
        }),
      });

      const res = await createSchedule({
        request: req,
        locals: {
          user: { id: 'user-1' },
          supabase: mockSupabase,
          activeWorkspaceId: workspaceId,
        },
      } as any);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid timezone');
    });

    it('accepts valid IANA timezone and succeeds', async () => {
      const req = new Request('http://localhost:4321/api/competitors/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cron_expression: '0 2 * * *',
          timezone: 'America/Chicago',
        }),
      });

      const res = await createSchedule({
        request: req,
        locals: {
          user: { id: 'user-1' },
          supabase: mockSupabase,
          activeWorkspaceId: workspaceId,
        },
      } as any);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('defaults to UTC when timezone is omitted or blank', async () => {
      const req = new Request('http://localhost:4321/api/competitors/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cron_expression: '0 2 * * *',
          timezone: '',
        }),
      });

      const res = await createSchedule({
        request: req,
        locals: {
          user: { id: 'user-1' },
          supabase: mockSupabase,
          activeWorkspaceId: workspaceId,
        },
      } as any);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('PATCH /api/competitors/schedules/[id]', () => {
    it('rejects invalid IANA timezone with 400', async () => {
      const req = new Request(`http://localhost:4321/api/competitors/schedules/${scheduleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timezone: 'Moon/Base',
        }),
      });

      const res = await updateSchedule({
        params: { id: scheduleId },
        request: req,
        locals: {
          user: { id: 'user-1' },
          supabase: mockSupabase,
          activeWorkspaceId: workspaceId,
        },
      } as any);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid timezone');
    });

    it('accepts valid IANA timezone and succeeds', async () => {
      const req = new Request(`http://localhost:4321/api/competitors/schedules/${scheduleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timezone: 'Europe/Paris',
        }),
      });

      const res = await updateSchedule({
        params: { id: scheduleId },
        request: req,
        locals: {
          user: { id: 'user-1' },
          supabase: mockSupabase,
          activeWorkspaceId: workspaceId,
        },
      } as any);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });
});
