import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getEffectiveSecret, getSecretCandidates, GLOBAL_KEY } from '../services/webhook-secrets';
import { HttpError } from '../lib/http-error';

describe('Webhook Secrets Service: Malformed UUID Validation & Parity', () => {
  let mockKvStore: Map<string, string>;
  let mockKvNamespace: any;
  let mockRuntimeEnv: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKvStore = new Map<string, string>();
    mockKvNamespace = {
      get: vi.fn(async (key: string) => mockKvStore.get(key) || null),
      put: vi.fn(async (key: string, val: string) => {
        mockKvStore.set(key, val);
      }),
      delete: vi.fn(async (key: string) => {
        mockKvStore.delete(key);
      }),
    };

    mockRuntimeEnv = {
      INGEST_SECRETS_KV: mockKvNamespace,
      INGEST_SECRET_KEY: 'env_fallback_secret_global_123',
    };
    mockKvStore.set(GLOBAL_KEY, 'kv_global_secret_abc');
  });

  it('getEffectiveSecret strictly throws HttpError(400) when wsId is truthy but not a valid UUID', async () => {
    const malformedIds = [
      'not-a-uuid',
      '12345',
      '../../admin',
      '00000000-0000-0000-0000-00000000000Z',
      '   ',
    ];

    for (const badId of malformedIds) {
      await expect(getEffectiveSecret(badId, mockRuntimeEnv)).rejects.toThrowError(HttpError);
      try {
        await getEffectiveSecret(badId, mockRuntimeEnv);
      } catch (err: any) {
        expect(err.status).toBe(400);
        expect(err.message).toBe('Invalid workspace UUID');
      }
    }
  });

  it('getSecretCandidates strictly throws HttpError(400) when wsId is truthy but not a valid UUID (Parity Check)', async () => {
    const malformedIds = ['not-a-uuid', '123', 'invalid-token-here'];

    for (const badId of malformedIds) {
      await expect(getSecretCandidates(badId, mockRuntimeEnv)).rejects.toThrowError(HttpError);
      try {
        await getSecretCandidates(badId, mockRuntimeEnv);
      } catch (err: any) {
        expect(err.status).toBe(400);
        expect(err.message).toBe('Invalid workspace UUID');
      }
    }
  });

  it('getEffectiveSecret allows falsy wsId to resolve global or env secret without error', async () => {
    // Empty string
    const resEmpty = await getEffectiveSecret('', mockRuntimeEnv);
    expect(resEmpty.source).toBe('global');
    expect(resEmpty.value).toBe('kv_global_secret_abc');

    // Undefined
    const resUndefined = await getEffectiveSecret(undefined as any, mockRuntimeEnv);
    expect(resUndefined.source).toBe('global');
    expect(resUndefined.value).toBe('kv_global_secret_abc');

    // Null
    const resNull = await getEffectiveSecret(null as any, mockRuntimeEnv);
    expect(resNull.source).toBe('global');
    expect(resNull.value).toBe('kv_global_secret_abc');
  });

  it('getEffectiveSecret resolves workspace secret when wsId is a valid UUID', async () => {
    const validWsId = '00000000-0000-0000-0000-000000000001';
    mockKvStore.set(`ingest_secret:ws:${validWsId}`, 'ws_override_secret_value');

    const res = await getEffectiveSecret(validWsId, mockRuntimeEnv);
    expect(res.source).toBe('workspace');
    expect(res.value).toBe('ws_override_secret_value');
  });
});
