import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getAccountByUsername,
  PINARCHIVE_ACCOUNT_FIELDS,
} from '../services/pinarchive-account-service';

const { mockPinArchiveClient } = vi.hoisted(() => ({
  mockPinArchiveClient: {
    from: vi.fn(),
  },
}));

vi.mock('../db/clients', () => ({
  dbClients: {
    getPinArchive: vi.fn(() => mockPinArchiveClient),
  },
}));

describe('pinarchive-account-service', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const username = 'testcreator';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null if workspaceId or username is missing', async () => {
    expect(await getAccountByUsername('', username)).toBeNull();
    expect(await getAccountByUsername(workspaceId, '')).toBeNull();
  });

  it('queries pa_accounts with narrow projection and returns account data', async () => {
    const mockAccountData = {
      id: 'acc-123',
      username: 'testcreator',
      status: 'active',
      ingest_enabled: true,
      follower_count: 1250,
      pins_count: 340,
      last_run_at: '2026-09-10T12:00:00Z',
      next_run_at: '2026-09-11T12:00:00Z',
    };

    const maybeSingleMock = vi.fn().mockResolvedValue({ data: mockAccountData, error: null });
    const eqUserMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eqWsMock = vi.fn().mockReturnValue({ eq: eqUserMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqWsMock });

    mockPinArchiveClient.from.mockReturnValue({ select: selectMock });

    const result = await getAccountByUsername(workspaceId, username);

    expect(mockPinArchiveClient.from).toHaveBeenCalledWith('pa_accounts');
    expect(selectMock).toHaveBeenCalledWith(PINARCHIVE_ACCOUNT_FIELDS);
    expect(eqWsMock).toHaveBeenCalledWith('workspace_id', workspaceId);
    expect(result).toEqual({
      ...mockAccountData,
      delta_saves_24h: 0,
      delta_repins_24h: 0,
    });
  });

  it('returns null if account is not found', async () => {
    mockPinArchiveClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    });

    const result = await getAccountByUsername(workspaceId, username);
    expect(result).toBeNull();
  });

  it('returns null if DB returns an error', async () => {
    mockPinArchiveClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'Database connection failure' },
            }),
          }),
        }),
      }),
    });

    const result = await getAccountByUsername(workspaceId, username);
    expect(result).toBeNull();
  });

  it('uses provided custom paClient if passed', async () => {
    const customClient: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'acc-custom', username },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };

    const result = await getAccountByUsername(workspaceId, username, undefined, customClient);
    expect(customClient.from).toHaveBeenCalledWith('pa_accounts');
    expect(mockPinArchiveClient.from).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: 'acc-custom',
      username,
      delta_saves_24h: 0,
      delta_repins_24h: 0,
    });
  });

  it('queries pa_account_deltas_24h via RPC and attaches deltas to result', async () => {
    const customClientWithRpc: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'acc-rpc', username },
                error: null,
              }),
            }),
          }),
        }),
      }),
      rpc: vi.fn().mockResolvedValue({
        data: [{ account_id: 'acc-rpc', delta_saves_24h: 42, delta_repins_24h: 18 }],
        error: null,
      }),
    };

    const result = await getAccountByUsername(workspaceId, username, undefined, customClientWithRpc);
    expect(customClientWithRpc.rpc).toHaveBeenCalledWith('pa_account_deltas_24h', {
      p_workspace_id: workspaceId,
      p_account_id: 'acc-rpc',
    });
    expect(result).toEqual({
      id: 'acc-rpc',
      username,
      delta_saves_24h: 42,
      delta_repins_24h: 18,
    });
  });
});
