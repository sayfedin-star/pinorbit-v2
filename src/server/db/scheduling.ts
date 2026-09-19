import type { SupabaseClient } from '@supabase/supabase-js';
import { assertWorkspaceAccess } from '../auth/workspace-guard';

export interface AccountRecord {
  id: string;
  workspace_id: string;
  account_name: string;
  webhook_url: string | null;
  max_pins_per_day: number;
  is_active: boolean;
  timezone: string;
  posting_interval_minutes: number;
  random_delay_minutes: number;
  active_days: string[];
  created_at: string;
}

export interface PinRecord {
  id: string;
  workspace_id: string;
  account_id: string;
  title: string;
  description: string | null;
  image_url: string;
  board_name: string | null;
  link: string | null;
  status: 'pending' | 'processing' | 'posted' | 'failed' | 'cancelled';
  source: string;
  scheduled_for: string | null;
  processing_started_at: string | null;
  posted_at: string | null;
  attempts: number;
  last_error_code: number | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostingWindowRecord {
  id: string;
  account_id: string;
  day_of_week: number;
  posting_time: string;
  is_active: boolean;
  created_at: string;
}

export const schedulingDb = {
  /**
   * Lists all accounts belonging to a verified workspace.
   */
  async getAccounts(
    schedulingClient: SupabaseClient,
    workspaceId: string,
    userId: string
  ): Promise<AccountRecord[]> {
    await assertWorkspaceAccess(schedulingClient, workspaceId, userId);

    const { data, error } = await schedulingClient
      .from('accounts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('account_name', { ascending: true });

    if (error) throw error;
    return (data as AccountRecord[]) || [];
  },

  /**
   * Retrieves pins for an account or workspace with optional status filter.
   */
  async getPins(
    schedulingClient: SupabaseClient,
    workspaceId: string,
    userId: string,
    options?: { accountId?: string; status?: string; limit?: number; offset?: number }
  ): Promise<{ pins: PinRecord[]; count: number }> {
    await assertWorkspaceAccess(schedulingClient, workspaceId, userId);

    let query = schedulingClient
      .from('pins')
      .select('*', { count: 'exact' })
      .eq('workspace_id', workspaceId);

    if (options?.accountId) {
      query = query.eq('account_id', options.accountId);
    }
    if (options?.status) {
      query = query.eq('status', options.status);
    }

    query = query.order('scheduled_for', { ascending: true, nullsFirst: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
    }

    const { data, count, error } = await query;
    if (error) throw error;

    return {
      pins: (data as PinRecord[]) || [],
      count: count || 0,
    };
  },

  /**
   * Creates a pin within an authorized workspace.
   */
  async createPin(
    schedulingClient: SupabaseClient,
    workspaceId: string,
    userId: string,
    pinData: Omit<PinRecord, 'id' | 'workspace_id' | 'created_at' | 'updated_at' | 'attempts' | 'last_error_code' | 'last_error_message' | 'processing_started_at' | 'posted_at'>
  ): Promise<PinRecord> {
    await assertWorkspaceAccess(schedulingClient, workspaceId, userId);

    const { data, error } = await schedulingClient
      .from('pins')
      .insert({
        ...pinData,
        workspace_id: workspaceId,
      })
      .select()
      .single();

    if (error) throw error;
    return data as PinRecord;
  },

  /**
   * Batch creates pins within an authorized workspace.
   */
  async createPinsBatch(
    schedulingClient: SupabaseClient,
    workspaceId: string,
    userId: string,
    pinsData: Array<Omit<PinRecord, 'id' | 'workspace_id' | 'created_at' | 'updated_at' | 'attempts' | 'last_error_code' | 'last_error_message' | 'processing_started_at' | 'posted_at'>>
  ): Promise<PinRecord[]> {
    if (pinsData.length === 0) return [];
    await assertWorkspaceAccess(schedulingClient, workspaceId, userId);

    const rows = pinsData.map(pin => ({
      ...pin,
      workspace_id: workspaceId,
    }));

    const CHUNK_SIZE = 500;
    const insertedPins: PinRecord[] = [];

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const { data, error } = await schedulingClient
        .from('pins')
        .insert(chunk)
        .select();

      if (error) throw error;
      if (data) {
        insertedPins.push(...(data as PinRecord[]));
      }
    }

    return insertedPins;
  },

  /**
   * Updates pin status or rescheduling time.
   */
  async updatePinStatus(
    schedulingClient: SupabaseClient,
    workspaceId: string,
    userId: string,
    pinId: string,
    updates: Partial<Pick<PinRecord, 'status' | 'scheduled_for' | 'attempts' | 'last_error_code' | 'last_error_message'>>
  ): Promise<PinRecord> {
    await assertWorkspaceAccess(schedulingClient, workspaceId, userId);

    const { data, error } = await schedulingClient
      .from('pins')
      .update(updates)
      .eq('id', pinId)
      .eq('workspace_id', workspaceId)
      .select()
      .single();

    if (error) throw error;
    return data as PinRecord;
  },

  /**
   * Retrieves posting windows for an account.
   */
  async getPostingWindows(
    schedulingClient: SupabaseClient,
    workspaceId: string,
    userId: string,
    accountId: string
  ): Promise<PostingWindowRecord[]> {
    await assertWorkspaceAccess(schedulingClient, workspaceId, userId);

    const { data, error } = await schedulingClient
      .from('account_posting_windows')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('account_id', accountId)
      .order('day_of_week', { ascending: true })
      .order('posting_time', { ascending: true });

    if (error) throw error;
    return (data as PostingWindowRecord[]) || [];
  },
};
