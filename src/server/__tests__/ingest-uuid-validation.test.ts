import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as ingestHandler } from '../../pages/api/internal/pinterest/ingest';
import { dbClients } from '../db/clients';
import * as webhookSecrets from '../services/webhook-secrets';

vi.mock('../services/pinner-etl', () => ({
  pinnerETL: {
    processIngestionPayload: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../db/clients', () => ({
  isProductionEnv: vi.fn().mockReturnValue(false),
  isKnownDefaultIngestSecret: vi.fn().mockReturnValue(false),
  dbClients: {
    getSchedulingAdmin: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    }),
    getAnalytics: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    }),
  },
}));

describe('P1 #8: Ingest Entry Point UUID Strictness Suite', () => {
  const validUuid = '00000000-0000-0000-0000-000000000001';
  const malformedUuids = [
    'invalid-uuid',
    'not-a-uuid-at-all',
    '12345',
    '../../../etc/passwd',
    'undefined',
    'null',
    '00000000-0000-0000-0000-00000000000g', // invalid hex
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Engine Events Branch (event in [pin.posted, pin.failed, board.created, boards.list, board.deleted])', () => {
    it.each(malformedUuids)('rejects malformed workspace_id "%s" with HTTP 422', async (badWsId) => {
      const req = new Request('https://app.pinorbit.com/api/internal/pinterest/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'secret-123' },
        body: JSON.stringify({
          event: 'pin.posted',
          workspace_id: badWsId,
          pin_id: 'pin-123',
        }),
      });

      const res = await ingestHandler({ request: req, locals: {} } as any);
      expect(res.status).toBe(422);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('workspace_id or valid account_id required for engine events.');
    });

    it('rejects engine event with missing workspace_id and nonexistent/malformed account_id with HTTP 422', async () => {
      const req = new Request('https://app.pinorbit.com/api/internal/pinterest/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'board.created',
          account_id: 'nonexistent-acc',
          board_id: 'board-1',
        }),
      });

      const res = await ingestHandler({ request: req, locals: {} } as any);
      expect(res.status).toBe(422);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('workspace_id or valid account_id required for engine events.');
    });
  });

  describe('Main Ingestion Pipeline Branch', () => {
    it.each(malformedUuids)('rejects malformed workspace_id "%s" with HTTP 422 before reaching secret resolver', async (badWsId) => {
      const secretSpy = vi.spyOn(webhookSecrets, 'getEffectiveSecret');

      const req = new Request('https://app.pinorbit.com/api/internal/pinterest/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'secret-123' },
        body: JSON.stringify({
          connection_id: 'conn-123',
          workspace_id: badWsId,
        }),
      });

      const res = await ingestHandler({ request: req, locals: {} } as any);
      expect(res.status).toBe(422);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe('Invalid workspace_id in payload.');

      // Verify that getEffectiveSecret was NEVER called with the malformed workspace ID
      expect(secretSpy).not.toHaveBeenCalled();
    });

    it('accepts valid UUID format for workspace_id and proceeds to secret check', async () => {
      vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
        value: 'correct-secret',
        source: 'workspace',
      } as any);

      const req = new Request('https://app.pinorbit.com/api/internal/pinterest/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'wrong-secret' },
        body: JSON.stringify({
          connection_id: 'conn-123',
          workspace_id: validUuid,
        }),
      });

      const res = await ingestHandler({ request: req, locals: {} } as any);
      // Fails at secret check (401), NOT at UUID validation (422)
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toContain('Unauthorized');
    });
  });
});
