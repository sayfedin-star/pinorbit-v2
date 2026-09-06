import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveToken } from '../lib/token-resolver';
import * as tokenCrypto from '../lib/token-crypto';
import { dbClients } from '../db/clients';

describe('Token Resolver Fail-Lazy & Tenant Isolation Suite (token-resolver-fail-lazy.test.ts)', () => {
  const mockWorkspaceId = '00000000-0000-0000-0000-000000000001';
  const mockTokenId = 'tok-1111-2222-3333-444444444444';
  const mockKek = '32_byte_secret_key_for_aes_gcm_test_1234';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('P0 #6: rejects schedule override decryption when workspaceId is omitted', async () => {
    vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);

    await expect(
      resolveToken(
        {
          encryptedToken: 'v1:some_encrypted_schedule_token',
        },
        'scheduling',
        { FASTCRON_API_TOKEN: 'global_env_token' }
      )
    ).rejects.toThrow('Tenant isolation violation: workspaceId is required when resolving schedule override token');
  });

  it('P0 #2: throws fail-lazy error when workspace default token exists but cannot be decrypted (KEK mismatch)', async () => {
    vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);
    // Decryption fails (e.g. wrong KEK returns null)
    vi.spyOn(tokenCrypto, 'decryptToken').mockResolvedValue(null);

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: mockTokenId,
                  name: 'Team Production Token',
                  token_encrypted: 'v1:corrupt_or_wrong_kek_ciphertext',
                  token_masked: '••••5678',
                  is_default: true,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };
    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    // Must THROW fail-lazy error, NOT silently return FASTCRON_API_TOKEN with source: workspace_registry
    await expect(
      resolveToken(
        {
          workspaceId: mockWorkspaceId,
        },
        'scheduling',
        { FASTCRON_API_TOKEN: 'shared_env_token_that_must_not_be_used' }
      )
    ).rejects.toThrow('Workspace token undecryptable; KEK mismatch — fail-lazy, not env fallback');
  });

  it('throws fail-lazy error when explicit tokenId row exists but cannot be decrypted', async () => {
    vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);
    vi.spyOn(tokenCrypto, 'decryptToken').mockResolvedValue(null);

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: mockTokenId,
                  name: 'Explicit Token',
                  token_encrypted: 'v1:undecryptable_ciphertext',
                  token_masked: '••••1234',
                  is_default: false,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };
    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    await expect(
      resolveToken(
        {
          workspaceId: mockWorkspaceId,
          tokenId: mockTokenId,
        },
        'scheduling',
        { FASTCRON_API_TOKEN: 'shared_env_token' }
      )
    ).rejects.toThrow('Workspace token undecryptable; KEK mismatch — fail-lazy, not env fallback');
  });

  it('permits envToken fallback ONLY when workspace has zero tokens in registry', async () => {
    vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: null,
                error: null,
              }),
            }),
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          }),
        }),
      }),
    };
    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    const result = await resolveToken(
      {
        workspaceId: mockWorkspaceId,
      },
      'scheduling',
      { FASTCRON_API_TOKEN: 'legitimate_env_fallback_token_1234' }
    );

    expect(result.token).toBe('legitimate_env_fallback_token_1234');
    expect(result.source).toBe('env');
    expect(result.tokenId).toBeNull();
  });
});
