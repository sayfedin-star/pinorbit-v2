import type { SupabaseClient } from '@supabase/supabase-js';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { competitorsDb, type CompetitorRecord, type CompetitorBoardRecord, type CompetitorDailySnapshotRecord } from '../db/competitors';

/**
 * High-level server-only service for Competitor Intelligence.
 * Mandatory Guard: Every method calls assertWorkspaceAccess against Project 1 before touching Project 2.
 */
export const competitorsService = {
  async getCompetitors(
    schedulingClient: SupabaseClient,
    userId: string,
    workspaceId: string,
    options?: { niche?: string; limit?: number; offset?: number }
  ): Promise<{ competitors: CompetitorRecord[]; count: number }> {
    await assertWorkspaceAccess(schedulingClient, workspaceId, userId);
    return competitorsDb.listCompetitors(workspaceId, options);
  },

  async getCompetitorDetails(
    schedulingClient: SupabaseClient,
    userId: string,
    workspaceId: string,
    competitorId: string
  ): Promise<{
    competitor: CompetitorRecord | null;
    boards: CompetitorBoardRecord[];
    snapshots: CompetitorDailySnapshotRecord[];
  }> {
    await assertWorkspaceAccess(schedulingClient, workspaceId, userId);

    const competitor = await competitorsDb.getCompetitor(workspaceId, competitorId);
    if (!competitor) {
      return { competitor: null, boards: [], snapshots: [] };
    }

    const [boards, snapshots] = await Promise.all([
      competitorsDb.listCompetitorBoards(workspaceId, competitorId),
      competitorsDb.getCompetitorDailySnapshots(workspaceId, competitorId, 30, competitor),
    ]);

    return { competitor, boards, snapshots };
  },

  async trackCompetitor(
    schedulingClient: SupabaseClient,
    userId: string,
    workspaceId: string,
    competitorData: Partial<CompetitorRecord> & { username: string }
  ): Promise<CompetitorRecord> {
    await assertWorkspaceAccess(schedulingClient, workspaceId, userId);
    return competitorsDb.upsertCompetitor(workspaceId, competitorData);
  },
};
