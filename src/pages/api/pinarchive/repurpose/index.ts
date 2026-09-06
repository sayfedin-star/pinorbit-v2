export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { executeRepurposeDispatch, type TargetDestination } from '../../../../server/services/repurpose-service';
import { HttpError } from '../../../../server/lib/http-error';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;

  if (!user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized: missing authenticated session or workspace.' }, 401);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
  const paAdmin = dbClients.getPinArchive(runtimeEnv);

  try {
    // A3 Role Check: admin or owner required to dispatch repurpose (creates pins and consumes quota)
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'admin');

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Malformed JSON payload.' }, 400);
    }

    const { batchUuid, pinIds, targets, linkOverride, allowDuplicates } = body || {};

    if (!batchUuid || typeof batchUuid !== 'string') {
      return json({ success: false, error: 'batchUuid string is required.' }, 400);
    }
    if (!Array.isArray(pinIds) || pinIds.length === 0) {
      return json({ success: false, error: 'pinIds array cannot be empty.' }, 400);
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return json({ success: false, error: 'targets array cannot be empty.' }, 400);
    }

    // Condition 10: Validate Publishable Boards in P1 (boards.pinterest_board_id IS NOT NULL)
    const targetAccountIds = [...new Set(targets.map((t: TargetDestination) => t.accountId).filter(Boolean))];
    const targetBoardNames = [...new Set(targets.map((t: TargetDestination) => t.boardName).filter(Boolean))];

    const { data: validBoards, error: boardErr } = await p1Admin
      .from('boards')
      .select('account_id, board_name, pinterest_board_id')
      .eq('workspace_id', workspaceId)
      .in('account_id', targetAccountIds)
      .in('board_name', targetBoardNames)
      .not('pinterest_board_id', 'is', null);

    if (boardErr) {
      return json({ success: false, error: 'Failed to verify target boards: ' + boardErr.message }, 500);
    }

    const validBoardKeys = new Set((validBoards || []).map((b: any) => `${b.account_id}:${b.board_name}`));

    for (const t of targets) {
      const key = `${t.accountId}:${t.boardName}`;
      if (!validBoardKeys.has(key)) {
        return json(
          {
            success: false,
            error: `Board "${t.boardName}" on account "${t.accountLabel}" is not a publishable board (missing Pinterest remote ID).`,
          },
          422
        );
      }
    }

    // Execute Repurpose Flow
    const result = await executeRepurposeDispatch(paAdmin, p1Admin, {
      batchUuid,
      workspaceId,
      userId: user.id,
      pinIds,
      targets,
      linkOverride: typeof linkOverride === 'string' ? linkOverride.trim() : undefined,
      allowDuplicates: Boolean(allowDuplicates),
    });

    return json(result, 200);
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json(
        {
          success: false,
          error: err.message,
          code: err.options?.code,
          retryable: err.options?.retryable,
        },
        err.status
      );
    }
    return json({ success: false, error: err?.message || 'Server error during repurpose.' }, 500);
  }
};
