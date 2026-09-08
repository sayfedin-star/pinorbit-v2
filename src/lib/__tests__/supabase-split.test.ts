import { describe, it, expect } from 'vitest';
import * as supabaseShim from '../supabase';
import fs from 'node:fs';
import path from 'node:path';

describe('Supabase God-File Split Compatibility Shim Suite', () => {
  it('exports all 50+ domain functions, constants, and session maps with backward compatibility', () => {
    // Client initialization
    expect(supabaseShim.supabaseUrl).toBeDefined();
    expect(supabaseShim.supabaseAnonKey).toBeDefined();
    expect(typeof supabaseShim.isSupabaseConfigured).toBe('boolean');
    expect('supabase' in supabaseShim).toBe(true);

    // Session maps
    expect(supabaseShim.editedAccountScheduleSession).toBeInstanceOf(Map);
    expect(supabaseShim.deletedPinIdsSession).toBeInstanceOf(Set);
    expect(supabaseShim.editedPinsSession).toBeInstanceOf(Map);

    // Accounts
    expect(typeof supabaseShim.getAccounts).toBe('function');
    expect(typeof supabaseShim.createAccount).toBe('function');
    expect(typeof supabaseShim.updateAccountDailyLimit).toBe('function');
    expect(typeof supabaseShim.toggleAccountActive).toBe('function');
    expect(typeof supabaseShim.getAccountDetails).toBe('function');
    expect(typeof supabaseShim.getAccountPinStats).toBe('function');
    expect(typeof supabaseShim.getBulkAccountPinStats).toBe('function');
    expect(typeof supabaseShim.updateAccountSchedule).toBe('function');
    expect(typeof supabaseShim.updateAccountScheduling).toBe('function');
    expect(supabaseShim.updateAccountScheduling).toBe(supabaseShim.updateAccountSchedule);
    expect(typeof supabaseShim.updateAccountAutoBoardSettings).toBe('function');

    // Boards
    expect(typeof supabaseShim.getBoards).toBe('function');
    expect(typeof supabaseShim.getBoardsForAccount).toBe('function');
    expect(typeof supabaseShim.getBulkAccountBoards).toBe('function');
    expect(typeof supabaseShim.createBoard).toBe('function');
    expect(typeof supabaseShim.updateBoard).toBe('function');
    expect(typeof supabaseShim.getAccountBoards).toBe('function');
    expect(typeof supabaseShim.createBoardViaWebhook).toBe('function');
    expect(typeof supabaseShim.bulkCreateMissingBoardsViaWebhook).toBe('function');

    // Pins
    expect(typeof supabaseShim.escapeLike).toBe('function');
    expect(typeof supabaseShim.getPins).toBe('function');
    expect(typeof supabaseShim.bulkInsertPins).toBe('function');
    expect(typeof supabaseShim.getAccountRecentPins).toBe('function');
    expect(typeof supabaseShim.getAccountPins).toBe('function');
    expect(typeof supabaseShim.bulkDeletePins).toBe('function');
    expect(typeof supabaseShim.bulkEditPins).toBe('function');
    expect(typeof supabaseShim.bulkRetryPinsNow).toBe('function');
    expect(typeof supabaseShim.bulkCancelPins).toBe('function');

    // Logs
    expect(typeof supabaseShim.getLogs).toBe('function');
    expect(typeof supabaseShim.getPinDeliveryLogs).toBe('function');
    expect(typeof supabaseShim.getAuditLogs).toBe('function');
    expect(typeof supabaseShim.getImportSessions).toBe('function');
    expect(typeof supabaseShim.getAccountRecentLogs).toBe('function');

    // Dashboard
    expect(typeof supabaseShim.getDashboardKPIs).toBe('function');

    // Schedules
    expect(typeof supabaseShim.calculateJSPacingForAccount).toBe('function');
    expect(typeof supabaseShim.rescheduleAccountPendingPins).toBe('function');

    // Webhooks
    expect(typeof supabaseShim.getAccountWebhooks).toBe('function');
    expect(typeof supabaseShim.getBulkAccountWebhooks).toBe('function');
    expect(typeof supabaseShim.createAccountWebhook).toBe('function');
    expect(typeof supabaseShim.updateAccountWebhook).toBe('function');
    expect(typeof supabaseShim.setPrimaryWebhook).toBe('function');
    expect(typeof supabaseShim.toggleAccountWebhookActive).toBe('function');
    expect(typeof supabaseShim.deleteAccountWebhook).toBe('function');
    expect(typeof supabaseShim.getAccountWebhookSummary).toBe('function');
  });

  it('CRITICAL: asserts that createAstroServerClient is NOT exported by the shim', () => {
    expect((supabaseShim as any).createAstroServerClient).toBeUndefined();
  });

  it('verifies unidirectional dependencies between modules without circular loops', () => {
    const libDir = path.resolve(__dirname, '..');

    const accountsContent = fs.readFileSync(path.join(libDir, 'accounts.ts'), 'utf8');
    const pinsContent = fs.readFileSync(path.join(libDir, 'pins.ts'), 'utf8');
    const clientContent = fs.readFileSync(path.join(libDir, 'supabase-client.ts'), 'utf8');
    const workspacesContent = fs.readFileSync(path.join(libDir, 'workspaces.ts'), 'utf8');

    // accounts and pins must never import dashboard (unidirectional KPI aggregation)
    expect(accountsContent.includes('dashboard')).toBe(false);
    expect(pinsContent.includes('dashboard')).toBe(false);

    // supabase-client must never import server, mocks, or session
    expect(clientContent.includes('createAstroServerClient')).toBe(false);
    expect(clientContent.includes('supabase-mock')).toBe(false);
    expect(clientContent.includes('supabase-session')).toBe(false);

    // workspaces must never import server/db
    expect(workspacesContent.includes('server/db')).toBe(false);
    expect(workspacesContent.includes('createAstroServerClient')).toBe(false);
  });
});
