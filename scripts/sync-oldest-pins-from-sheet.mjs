#!/usr/bin/env node
/**
 * scripts/sync-oldest-pins-from-sheet.mjs
 *
 * Comprehensive one-time (and on-demand) synchronization script that queries
 * Google Apps Script (GAS) `account_ages` action across all creator tabs in Google Sheets,
 * and writes the true historical oldest pin timestamp into `pa_accounts.oldest_pin_at`.
 *
 * Usage:
 *   node --use-system-ca scripts/sync-oldest-pins-from-sheet.mjs [options]
 *
 * Options:
 *   --workspace <uuid>     Scope sync to a specific workspace UUID
 *   --username <username>  Scope sync to a single creator username
 *   --dry-run              Fetch and compute ages without writing to DB
 *   --verbose              Print detailed per-chunk payloads and responses
 *
 * Environment Variables (or loaded from env/defaults):
 *   PINARCHIVE_SUPABASE_URL
 *   PINARCHIVE_SUPABASE_KEY
 *   PINARCHIVE_GAS_URL
 *   PINARCHIVE_INGEST_SECRET
 */

import { parseArgs } from 'node:util';

const DEFAULT_SUPABASE_URL = 'https://kuuugffvyokywtgmdrfk.supabase.co';
const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbwBFmyisJ59ejbOLimfgLHAfPcGx4E_WhIiSEI56BhFSJ6HkHrM2wfoPeO-v3nJa5CA/exec';

const { values: flags } = parseArgs({
  options: {
    workspace: { type: 'string' },
    username: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const SUPABASE_URL = process.env.PINARCHIVE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
const SUPABASE_KEY = process.env.PINARCHIVE_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GAS_URL = process.env.PINARCHIVE_GAS_URL || DEFAULT_GAS_URL;
const INGEST_SECRET = process.env.PINARCHIVE_INGEST_SECRET || process.env.PINARCHIVE_SECRET || '';

async function supaQuery(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase query ${table} failed (HTTP ${res.status}): ${txt}`);
  }
  return res.json();
}

async function supaPatch(table, matchParams, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${matchParams}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase PATCH ${table} failed (HTTP ${res.status}): ${txt}`);
  }
}

async function callGasAccountAges(gasUrl, secret, workspaceId, usernames) {
  const body = {
    v: 1,
    cmd_id: crypto.randomUUID(),
    secret,
    action: 'account_ages',
    workspace_id: workspaceId,
    payload: {
      usernames,
    },
  };

  const res = await fetch(gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GAS HTTP ${res.status}: ${txt}`);
  }

  const data = await res.json();
  if (!data || data.ok === false) {
    throw new Error(`GAS error: ${data?.error || 'Unknown GAS error'}`);
  }

  return data.ages || {};
}

async function main() {
  console.log('===========================================================');
  console.log('  PinArchive Oldest Pin Timestamp Sheet Sync Utility       ');
  console.log('===========================================================\n');

  if (!SUPABASE_KEY) {
    console.error('❌ Error: PINARCHIVE_SUPABASE_KEY or SUPABASE_SERVICE_ROLE_KEY is required to connect to database.');
    console.error('   Please run with: PINARCHIVE_SUPABASE_KEY="..." PINARCHIVE_INGEST_SECRET="..." node scripts/sync-oldest-pins-from-sheet.mjs');
    process.exit(1);
  }

  if (!INGEST_SECRET) {
    console.error('❌ Error: PINARCHIVE_INGEST_SECRET is required to query Google Apps Script bridge.');
    process.exit(1);
  }

  console.log(`📡 Supabase URL: ${SUPABASE_URL}`);
  console.log(`🌐 GAS Web App URL: ${GAS_URL}`);
  console.log(`🧪 Mode: ${flags['dry-run'] ? 'DRY RUN (no DB writes)' : 'LIVE SYNC'}`);
  if (flags.workspace) console.log(`🔍 Workspace Filter: ${flags.workspace}`);
  if (flags.username) console.log(`🔍 Username Filter: ${flags.username}`);
  console.log('');

  // 1. Query accounts from pa_accounts
  let queryParams = 'select=id,workspace_id,username,oldest_pin_at,pins_count&order=workspace_id.asc,username.asc';
  if (flags.workspace) queryParams += `&workspace_id=eq.${flags.workspace}`;
  if (flags.username) queryParams += `&username=eq.${flags.username.toLowerCase().replace(/^@/, '')}`;

  console.log('⏳ Fetching accounts from pa_accounts...');
  const accounts = await supaQuery('pa_accounts', queryParams);
  console.log(`✅ Loaded ${accounts.length} account(s).\n`);

  if (accounts.length === 0) {
    console.log('No accounts found matching the criteria.');
    return;
  }

  // 2. Group accounts by workspace
  const workspaceMap = new Map();
  for (const a of accounts) {
    if (!workspaceMap.has(a.workspace_id)) {
      workspaceMap.set(a.workspace_id, []);
    }
    workspaceMap.get(a.workspace_id).push(a);
  }

  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalFailed = 0;

  for (const [wsId, wsAccounts] of workspaceMap.entries()) {
    console.log(`\n───────────────────────────────────────────────────────────`);
    console.log(`📁 Workspace: ${wsId} (${wsAccounts.length} account(s))`);
    console.log(`───────────────────────────────────────────────────────────`);

    const allUsernames = wsAccounts.map(a => a.username);

    // Chunk into 50 usernames per call
    for (let i = 0; i < allUsernames.length; i += 50) {
      const chunk = allUsernames.slice(i, i + 50);
      console.log(`⏳ Querying GAS account_ages for chunk [${i + 1}-${i + chunk.length}] of ${allUsernames.length}...`);

      let ages = {};
      try {
        ages = await callGasAccountAges(GAS_URL, INGEST_SECRET, wsId, chunk);
        if (flags.verbose) console.log('   Raw GAS response:', ages);
      } catch (err) {
        console.error(`❌ GAS query failed for workspace ${wsId}: ${err.message}`);
        totalFailed += chunk.length;
        continue;
      }

      for (const username of chunk) {
        const acc = wsAccounts.find(a => a.username === username);
        const sheetAge = ages[username];
        const prevAge = acc?.oldest_pin_at || null;

        if (!sheetAge) {
          console.log(`   @${username.padEnd(24)}: (no pins found in sheet, kept: ${prevAge || 'null'})`);
          totalUnchanged++;
          continue;
        }

        const isChanged = prevAge !== sheetAge;
        if (isChanged) {
          console.log(`   @${username.padEnd(24)}: ${prevAge || 'null'} -> \x1b[32m${sheetAge}\x1b[0m`);

          if (!flags['dry-run']) {
            try {
              await supaPatch('pa_accounts', `workspace_id=eq.${wsId}&id=eq.${acc.id}`, {
                oldest_pin_at: sheetAge,
              });
              totalUpdated++;
            } catch (err) {
              console.error(`   ❌ Failed to patch @${username}: ${err.message}`);
              totalFailed++;
            }
          } else {
            totalUpdated++;
          }
        } else {
          console.log(`   @${username.padEnd(24)}: \x1b[36m${sheetAge}\x1b[0m (already in sync)`);
          totalUnchanged++;
        }
      }
    }
  }

  console.log('\n===========================================================');
  console.log('  Summary Report                                           ');
  console.log('===========================================================');
  console.log(`  Total Accounts Evaluated: ${accounts.length}`);
  console.log(`  Updated with Sheet Age:   \x1b[32m${totalUpdated}\x1b[0m`);
  console.log(`  Already in Sync / Null:   ${totalUnchanged}`);
  console.log(`  Errors:                   ${totalFailed > 0 ? `\x1b[31m${totalFailed}\x1b[0m` : '0'}`);
  console.log('===========================================================\n');
}

main().catch(err => {
  console.error('\n💥 Fatal sync error:', err);
  process.exit(1);
});
