import { analyticsDb } from '../db/analytics';
import { getServerEnv } from '../db/clients';
import { decryptToken } from '../lib/token-crypto';
import { getEffectiveSecret } from './webhook-secrets';
import type {
  ScheduleSyncResponse,
  TriggerSyncResponse,
} from '../../lib/types';

export const FASTCRON_BASE = 'https://www.fastcron.com/api/v1';
export const DISPATCH_ENDPOINT_URL = process.env.DISPATCH_BASE_URL || 'https://pinorbit-v2.o-i.workers.dev/api/internal/pinterest/daily-dispatch';

const ALLOWED_WEBHOOK_HOSTS = [
  'hook.make.com',
  'hook.eu1.make.com',
  'hook.eu2.make.com',
  'hook.us1.make.com',
  'hook.us2.make.com',
  'hook.integromat.com',
];

export const SORT_MODES = [
  'IMPRESSION',
  'OUTBOUND_CLICK',
  'SAVE',
  'ENGAGEMENT',
  'PIN_CLICK',
];

export const fastcronService = {
  /**
   * Dispatches a request to FastCron API.
   * Strategy:
   * 1. Primary: POST JSON body.
   * 2. Fallback: On 404/405, fallback to GET query-string.
   * 3. Surface errors verbatim.
   */
  async fastcronCall(
    action: string,
    params: Record<string, any>,
    token: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const url = `${FASTCRON_BASE}/${action}`;
    const payload = { token, ...params };

    try {
      let res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });

      if (res.status === 404 || res.status === 405) {
        const searchParams = new URLSearchParams();
        for (const [key, value] of Object.entries(payload)) {
          if (value !== undefined && value !== null) {
            searchParams.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          }
        }
        res = await fetch(`${url}?${searchParams.toString()}`, {
          method: 'GET',
          signal: AbortSignal.timeout(8000),
        });
      }

      const data = await res.json().catch(() => ({}));

      if (
        data.status === 'OK' ||
        data.status === 'success' ||
        data.id ||
        data?.data?.id ||
        Array.isArray(data) ||
        Array.isArray(data?.data)
      ) {
        return { success: true, data };
      }

      const errorMsg =
        data.message ||
        data.error ||
        data.err_message ||
        (typeof data === 'string' && data.length > 0 ? data : `FastCron returned HTTP ${res.status}`);

      return { success: false, data, error: errorMsg };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'FastCron network request failed',
      };
    }
  },

  /**
   * Validates webhook URL format and domain allowlist.
   */
  validateWebhookUrl(urlStr?: string | null): { valid: boolean; error?: string } {
    if (!urlStr || typeof urlStr !== 'string') {
      return { valid: false, error: 'Webhook URL is required.' };
    }

    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol !== 'https:') {
        return { valid: false, error: 'Webhook URL must use secure HTTPS protocol.' };
      }

      const host = parsed.hostname.toLowerCase();
      const isAllowed =
        ALLOWED_WEBHOOK_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed)) ||
        host.endsWith('.make.com') ||
        host.endsWith('.integromat.com');

      if (!isAllowed) {
        return {
          valid: false,
          error: `Webhook host "${host}" is not allowed. Must be a verified Make.com or Integromat domain.`,
        };
      }

      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid Webhook URL format.' };
    }
  },

  /**
   * Converts HH:MM (24-hour) format to standard cron expression: M H * * *
   */
  parseTimeToCron(timeStr?: string | null): { valid: boolean; cron?: string; error?: string } {
    if (!timeStr || !/^\d{1,2}:\d{2}$/.test(timeStr.trim())) {
      return { valid: false, error: 'Time must be in HH:MM (24-hour) format (e.g. 04:00).' };
    }

    const [hStr, mStr] = timeStr.trim().split(':');
    const hour = parseInt(hStr, 10);
    const minute = parseInt(mStr, 10);

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return { valid: false, error: 'Hour must be between 0-23 and minute between 0-59.' };
    }

    return {
      valid: true,
      cron: `${minute} ${hour} * * *`,
    };
  },

  /**
   * Resolves the active FastCron token (Connection channel token -> Legacy Connection token → Workspace DB token → env FASTCRON_API_TOKEN → null).
   */
  async resolveFastCronToken(
    channelToken: string | null | undefined,
    workspaceToken?: string | Record<string, any> | null,
    runtimeEnvOrNull?: Record<string, any>
  ): Promise<string | null> {
    let wsTok: string | null = null;
    let envObj: Record<string, any> = {};

    if (runtimeEnvOrNull !== undefined) {
      wsTok = typeof workspaceToken === 'string' ? workspaceToken : null;
      envObj = runtimeEnvOrNull || {};
    } else {
      wsTok = typeof channelToken === 'string' ? channelToken : null; // If 2-arg, arg1 was workspaceToken
      envObj = (workspaceToken as Record<string, any>) || {};
      channelToken = null;
    }

    const env = getServerEnv(envObj);

    const checkToken = async (tok: string | null | undefined) => {
      if (tok && typeof tok === 'string' && tok.trim().length >= 16) {
        if (tok.startsWith('v1:')) {
          const dec = await decryptToken(tok, env.TOKEN_KEK);
          if (dec) return dec.trim();
        } else {
          return tok.trim();
        }
      }
      return null;
    };

    const res1 = await checkToken(channelToken);
    if (res1) return res1;

    const res2 = await checkToken(wsTok);
    if (res2) return res2;

    const res3 = await checkToken(env.FASTCRON_API_TOKEN);
    if (res3) return res3;

    return null;
  },

  /**
   * Synchronizes schedule for a specific connection & channel with FastCron API.
   * Handles batch_add when both jobs are unconfigured, or add/edit accordingly.
   */
  async syncScheduleWithFastCron(
    workspaceId: string,
    connectionId: string,
    channel: 'analytics' | 'top_pins',
    runtimeEnv: Record<string, any>
  ): Promise<ScheduleSyncResponse> {
    const connection = await analyticsDb.getWorkspaceConnection(workspaceId, connectionId);
    if (!connection) {
      return {
        success: false,
        connection_id: connectionId,
        channel,
        schedule_status: 'error',
        error: 'Connection not found in workspace.',
      };
    }

    const isAnalytics = channel === 'analytics';
    const webhookUrl = isAnalytics
      ? connection.analytics_webhook_url
      : connection.top_pins_webhook_url;
    const syncTime = isAnalytics ? connection.analytics_sync_time : connection.top_pins_sync_time;
    const existingJobId = isAnalytics
      ? connection.analytics_fastcron_job_id
      : connection.top_pins_fastcron_job_id;

    // Validate Webhook URL
    const urlValidation = this.validateWebhookUrl(webhookUrl);
    if (!urlValidation.valid) {
      const statusField = isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status';
      await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
        [statusField]: 'error',
      });
      return {
        success: false,
        connection_id: connectionId,
        channel,
        schedule_status: 'error',
        error: urlValidation.error || 'Invalid webhook URL for this channel.',
      };
    }

    // Validate Cron
    const cronValidation = this.parseTimeToCron(syncTime);
    if (!cronValidation.valid || !cronValidation.cron) {
      const statusField = isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status';
      await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
        [statusField]: 'error',
      });
      return {
        success: false,
        connection_id: connectionId,
        channel,
        schedule_status: 'error',
        error: cronValidation.error || 'Invalid sync time format.',
      };
    }

    // Resolve Token (Connection token → Workspace DB token → env FASTCRON_API_TOKEN → null)
    const settings = await analyticsDb.getWorkspaceAnalyticsSettings(workspaceId);
    const channelToken = isAnalytics ? connection.analytics_fastcron_token : connection.top_pins_fastcron_token;
    const effectiveConnToken = channelToken || connection.fastcron_token;
    const token = await this.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);
    if (!token) {
      const statusField = isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status';
      await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
        [statusField]: 'error',
      });
      return {
        success: false,
        connection_id: connectionId,
        channel,
        schedule_status: 'error',
        error: 'FastCron API token not configured. Please provide a valid token in settings.',
      };
    }

    // Resolve effective secret before scheduling
    const effectiveSecretResult = await getEffectiveSecret(workspaceId, runtimeEnv);
    const effectiveSecret = effectiveSecretResult?.value;
    if (!effectiveSecret || effectiveSecret.trim().length === 0) {
      const statusField = isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status';
      await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
        [statusField]: 'error',
      });
      return {
        success: false,
        connection_id: connectionId,
        channel,
        schedule_status: 'error',
        error: 'Ingest secret not configured',
      };
    }

    // R6.1 Reconcile Algorithm Step 1 & 2: Check storedId with cron_get
    let storedId = isAnalytics ? connection.analytics_fastcron_job_id : connection.top_pins_fastcron_job_id;
    let verifiedJobId: number | null = null;

    if (storedId) {
      const getRes = await this.fastcronCall('cron_get', { id: storedId }, token);
      if (getRes.success && (getRes.data?.id || getRes.data?.data?.id || getRes.data?.status === 'OK' || getRes.data?.status === 'success')) {
        const rawId = getRes.data?.id ?? getRes.data?.data?.id ?? storedId;
        const parsedStoredId = rawId != null && !isNaN(Number(rawId)) ? Number(rawId) : storedId;
        verifiedJobId = parsedStoredId;
      } else {
        console.warn(`[FastCron] Stored job ${storedId} for ${channel} not found in FastCron (404/deleted). Treating as missing.`);
        storedId = null;
      }
    }

    // Prepare FastCron job parameters pointing to daily-dispatch endpoint (F2, X2)
    const postData = JSON.stringify({
      connection_id: connectionId,
      channel: isAnalytics ? 'account_analytics' : 'top_pins',
    });

    const jobName = `PinOrbit ${isAnalytics ? 'analytics' : 'top-pins'} — ${workspaceId.substring(0, 8)} — ${connection.display_name}`;
    const httpHeaders = `Content-Type: application/json\r\nx-ingest-secret: ${effectiveSecret}`;

    const jobParams: Record<string, any> = {
      name: jobName,
      expression: cronValidation.cron,
      timezone: settings?.timezone || 'UTC',
      url: DISPATCH_ENDPOINT_URL,
      httpMethod: 'POST',
      http_method: 'POST',
      httpHeaders: httpHeaders,
      http_headers: httpHeaders,
      postData: postData,
      post_data: postData,
      instances: connection.fastcron_instances !== undefined ? connection.fastcron_instances : 1,
      notify: connection.fastcron_notify !== undefined ? connection.fastcron_notify : true,
      timeout: connection.fastcron_timeout || 30,
    };

    let batchCreatedOtherId: number | null = null;

    if (verifiedJobId) {
      // Step 2 Found: Execute cron_edit
      jobParams.id = verifiedJobId;
      const editResult = await this.fastcronCall('cron_edit', jobParams, token);
      if (!editResult.success) {
        const statusField = isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status';
        await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
          [statusField]: 'error',
        });
        return {
          success: false,
          connection_id: connectionId,
          channel,
          schedule_status: 'error',
          error: editResult.error || 'Failed to update FastCron schedule.',
        };
      }

      // Persist verified id and status (single UPDATE per channel)
      await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
        [isAnalytics ? 'analytics_fastcron_job_id' : 'top_pins_fastcron_job_id']: verifiedJobId,
        [isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status']: 'synced',
        [isAnalytics ? 'analytics_cron_expression' : 'top_pins_cron_expression']: cronValidation.cron,
      });
    } else {
      // Step 3 Missing: Create job (cron_batch_add ONLY when BOTH channels missing and both URLs configured)
      const otherChannelStoredId = isAnalytics ? connection.top_pins_fastcron_job_id : connection.analytics_fastcron_job_id;
      const bothMissing = !storedId && !otherChannelStoredId;

      if (bothMissing && channel === 'analytics' && connection.top_pins_webhook_url) {
        const cronTopPins = this.parseTimeToCron(connection.top_pins_sync_time || '04:30');
        const batchPostDataA = JSON.stringify({
          connection_id: connectionId,
          channel: 'account_analytics',
        });
        const batchPostDataB = JSON.stringify({
          connection_id: connectionId,
          channel: 'top_pins',
        });

        const batchItems = [
          {
            name: `PinOrbit analytics — ${workspaceId.substring(0, 8)} — ${connection.display_name}`,
            expression: cronValidation.cron,
            timezone: settings?.timezone || 'UTC',
            url: DISPATCH_ENDPOINT_URL,
            httpMethod: 'POST',
            http_method: 'POST',
            httpHeaders: httpHeaders,
            http_headers: httpHeaders,
            postData: batchPostDataA,
            post_data: batchPostDataA,
            instances: connection.fastcron_instances !== undefined ? connection.fastcron_instances : 1,
            notify: connection.fastcron_notify !== undefined ? connection.fastcron_notify : true,
            timeout: connection.fastcron_timeout || 30,
          },
          {
            name: `PinOrbit top-pins — ${workspaceId.substring(0, 8)} — ${connection.display_name}`,
            expression: cronTopPins.cron || '30 4 * * *',
            timezone: settings?.timezone || 'UTC',
            url: DISPATCH_ENDPOINT_URL,
            httpMethod: 'POST',
            http_method: 'POST',
            httpHeaders: httpHeaders,
            http_headers: httpHeaders,
            postData: batchPostDataB,
            post_data: batchPostDataB,
            instances: connection.fastcron_instances !== undefined ? connection.fastcron_instances : 1,
            notify: connection.fastcron_notify !== undefined ? connection.fastcron_notify : true,
            timeout: connection.fastcron_timeout || 30,
          },
        ];

        const batchRes = await this.fastcronCall(
          'cron_batch_add',
          { data: batchItems, jobs: batchItems, timezone: settings?.timezone || 'UTC' },
          token
        );

        if (!batchRes.success) {
          await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
            analytics_schedule_status: 'error',
          });
          return {
            success: false,
            connection_id: connectionId,
            channel,
            schedule_status: 'error',
            error: batchRes.error || 'FastCron batch creation failed.',
          };
        }

        const batchList = Array.isArray(batchRes.data?.data)
          ? batchRes.data.data
          : Array.isArray(batchRes.data)
          ? batchRes.data
          : [];
        const rawId0 = batchList[0]?.id ?? (Array.isArray(batchRes.data?.ids) ? batchRes.data.ids[0] : batchRes.data?.id);
        const rawId1 = batchList[1]?.id ?? (Array.isArray(batchRes.data?.ids) ? batchRes.data.ids[1] : null);

        const idA = rawId0 != null && !isNaN(Number(rawId0)) ? Number(rawId0) : null;
        const idB = rawId1 != null && !isNaN(Number(rawId1)) ? Number(rawId1) : null;

        // R8.2 / R9.2: Check numeric extraction for current channel
        if (!idA) {
          if (idB) {
            await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
              top_pins_fastcron_job_id: idB,
              top_pins_schedule_status: 'synced',
              top_pins_cron_expression: cronTopPins.cron || '30 4 * * *',
              analytics_schedule_status: 'error',
            });
          } else {
            await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
              analytics_schedule_status: 'error',
            });
          }
          return {
            success: false,
            connection_id: connectionId,
            channel,
            schedule_status: 'error',
            error: 'FastCron batch creation failed to return a valid numeric job id for analytics.',
          };
        }

        verifiedJobId = idA;
        batchCreatedOtherId = idB;

        // R8.3: Persist channel job id IMMEDIATELY after extraction
        await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
          analytics_fastcron_job_id: idA,
          analytics_schedule_status: 'synced',
          analytics_cron_expression: cronValidation.cron,
          ...(idB
            ? {
                top_pins_fastcron_job_id: idB,
                top_pins_schedule_status: 'synced',
                top_pins_cron_expression: cronTopPins.cron || '30 4 * * *',
              }
            : {}),
        });
      } else {
        // Single cron_add
        const addRes = await this.fastcronCall('cron_add', jobParams, token);
        if (!addRes.success) {
          const statusField = isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status';
          await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
            [statusField]: 'error',
          });
          return {
            success: false,
            connection_id: connectionId,
            channel,
            schedule_status: 'error',
            error: addRes.error || 'FastCron creation failed.',
          };
        }

        // R8.2: extract id as (data.id ?? data.data.id). If extraction fails -> schedule_status 'error', return success:false. NEVER report 'synced' without a numeric id.
        const returnedId =
          addRes.data?.id ??
          addRes.data?.data?.id ??
          (Array.isArray(addRes.data?.ids) ? addRes.data.ids[0] : null);
        const parsedId = returnedId != null && !isNaN(Number(returnedId)) ? Number(returnedId) : null;

        if (!parsedId) {
          const statusField = isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status';
          await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
            [statusField]: 'error',
          });
          return {
            success: false,
            connection_id: connectionId,
            channel,
            schedule_status: 'error',
            error: 'FastCron creation failed to return a valid numeric job id.',
          };
        }

        verifiedJobId = parsedId;

        // R8.3: Persist the channel job id to analytics_connections IMMEDIATELY after extraction (single UPDATE per channel)
        await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
          [isAnalytics ? 'analytics_fastcron_job_id' : 'top_pins_fastcron_job_id']: verifiedJobId,
          [isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status']: 'synced',
          [isAnalytics ? 'analytics_cron_expression' : 'top_pins_cron_expression']: cronValidation.cron,
        });
      }
    }

    // X3: Orphan Cleanup with Strict Cross-Channel Safety
    // Delete a job ONLY if ALL hold:
    // 1. url === DISPATCH_ENDPOINT_URL (or legacy channel webhook URL)
    // 2. postData contains this connection_id
    // 3. id !== stored analytics_fastcron_job_id
    // 4. id !== stored top_pins_fastcron_job_id
    if (verifiedJobId != null) {
      try {
        const listRes = await this.fastcronCall('cron_list', { keyword: 'PinOrbit' }, token);
        const jobsList =
          listRes.data?.data ||
          listRes.data?.jobs ||
          (Array.isArray(listRes.data) ? listRes.data : []);
        if (Array.isArray(jobsList)) {
          const storedAnalyticsId = isAnalytics ? verifiedJobId : (batchCreatedOtherId || connection.analytics_fastcron_job_id);
          const storedTopPinsId = !isAnalytics ? verifiedJobId : (batchCreatedOtherId || connection.top_pins_fastcron_job_id);

          for (const job of jobsList) {
            const jobUrl = job.url?.trim();
            const jId = job.id != null ? parseInt(String(job.id), 10) : null;
            if (!jId) continue;

            const jobPostData =
              typeof job.postData === 'string'
                ? job.postData
                : typeof job.post_data === 'string'
                ? job.post_data
                : JSON.stringify(job.postData || job.post_data || '');

            const isDispatchUrl = jobUrl === DISPATCH_ENDPOINT_URL || jobUrl === webhookUrl?.trim();
            const matchesConnection = jobPostData.includes(connectionId) || (job.name && job.name.includes(connection.display_name));
            const isStoredJob = (storedAnalyticsId != null && jId === storedAnalyticsId) ||
                                (storedTopPinsId != null && jId === storedTopPinsId);

            if (isDispatchUrl && matchesConnection && !isStoredJob) {
              console.log(
                `[FastCron] Removing orphan duplicate job ${jId} for connection ${connectionId}`
              );
              await this.fastcronCall('cron_delete', { id: jId }, token);
            }
          }
        }
      } catch (cleanErr) {
        console.warn('[FastCron] Orphan cleanup non-fatal warning:', cleanErr);
      }
    }

    // Final DB update ensuring current channel status is synced
    await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, {
      [isAnalytics ? 'analytics_fastcron_job_id' : 'top_pins_fastcron_job_id']: verifiedJobId,
      [isAnalytics ? 'analytics_schedule_status' : 'top_pins_schedule_status']: 'synced',
      [isAnalytics ? 'analytics_cron_expression' : 'top_pins_cron_expression']: cronValidation.cron,
    });

    return {
      success: true,
      connection_id: connectionId,
      channel,
      schedule_status: 'synced',
      fastcron_job_id: verifiedJobId,
      message: `FastCron schedule successfully synced for ${channel} (Job ID: ${verifiedJobId}).`,
    };
  },

  /**
   * Disables a FastCron job via cron_disable (safe soft-delete / pause).
   */
  async disableFastCronJob(
    workspaceId: string,
    jobId: number | null | undefined,
    runtimeEnv: Record<string, any>,
    connectionId?: string
  ): Promise<boolean> {
    if (!jobId) return true;
    const connection = connectionId ? await analyticsDb.getWorkspaceConnection(workspaceId, connectionId) : null;
    const settings = await analyticsDb.getWorkspaceAnalyticsSettings(workspaceId);
    const effectiveConnToken = connection ? (connection.analytics_fastcron_job_id === jobId ? connection.analytics_fastcron_token : connection.top_pins_fastcron_job_id === jobId ? connection.top_pins_fastcron_token : null) || connection.fastcron_token : null;
    const token = await this.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);
    if (!token) return false;

    const res = await this.fastcronCall('cron_disable', { id: jobId }, token);
    return res.success;
  },

  /**
   * Enables a FastCron job via cron_enable (re-enable connection).
   */
  async enableFastCronJob(
    workspaceId: string,
    jobId: number | null | undefined,
    runtimeEnv: Record<string, any>,
    connectionId?: string
  ): Promise<boolean> {
    if (!jobId) return true;
    const connection = connectionId ? await analyticsDb.getWorkspaceConnection(workspaceId, connectionId) : null;
    const settings = await analyticsDb.getWorkspaceAnalyticsSettings(workspaceId);
    const effectiveConnToken = connection ? (connection.analytics_fastcron_job_id === jobId ? connection.analytics_fastcron_token : connection.top_pins_fastcron_job_id === jobId ? connection.top_pins_fastcron_token : null) || connection.fastcron_token : null;
    const token = await this.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);
    if (!token) return false;

    const res = await this.fastcronCall('cron_enable', { id: jobId }, token);
    return res.success;
  },

  /**
   * Deletes a FastCron job via cron_delete API (reserved for stale 404 cleanup).
   */
  async deleteFastCronJob(
    workspaceId: string,
    jobId: number | null | undefined,
    runtimeEnv: Record<string, any>,
    connectionId?: string
  ): Promise<boolean> {
    if (!jobId) return true;
    const connection = connectionId ? await analyticsDb.getWorkspaceConnection(workspaceId, connectionId) : null;
    const settings = await analyticsDb.getWorkspaceAnalyticsSettings(workspaceId);
    const effectiveConnToken = connection ? (connection.analytics_fastcron_job_id === jobId ? connection.analytics_fastcron_token : connection.top_pins_fastcron_job_id === jobId ? connection.top_pins_fastcron_token : null) || connection.fastcron_token : null;
    const token = await this.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);
    if (!token) return false;

    const res = await this.fastcronCall('cron_delete', { id: jobId }, token);
    return res.success;
  },

  /**
   * Dispatches manual sync via cron_run (with legacy direct POST fallback) or test ping.
   */
  async triggerManualSync(
    workspaceId: string,
    connectionId: string,
    channel: 'analytics' | 'top_pins',
    mode: 'ping' | 'sync',
    runtimeEnv: Record<string, any>,
    overrides?: { from_date?: string; to_date?: string; start_date?: string; end_date?: string }
  ): Promise<TriggerSyncResponse> {
    const connection = await analyticsDb.getWorkspaceConnection(workspaceId, connectionId);
    if (!connection) {
      return {
        success: false,
        connection_id: connectionId,
        channel,
        mode,
        error: 'Connection not found in this workspace.',
      };
    }

    const isAnalytics = channel === 'analytics';
    const webhookUrl = isAnalytics
      ? connection.analytics_webhook_url
      : connection.top_pins_webhook_url;

    const urlValidation = this.validateWebhookUrl(webhookUrl);
    if (!urlValidation.valid) {
      return {
        success: false,
        connection_id: connectionId,
        channel,
        mode,
        error: urlValidation.error || 'Webhook URL not configured or invalid.',
      };
    }

    const effectiveSortModes =
      connection.top_pins_sort_modes && connection.top_pins_sort_modes.length > 0
        ? connection.top_pins_sort_modes
        : SORT_MODES;
    const effectiveNumPins = connection.top_pins_num_of_pins || 50;

    // Per-pipeline date offsets and manual override resolution (V20.1 & R31.1)
    const startOffset = isAnalytics
      ? (connection.analytics_start_offset_days ?? 7)
      : (connection.top_pins_start_offset_days ?? 7);
    const endOffset = isAnalytics
      ? (connection.analytics_end_offset_days ?? 1)
      : (connection.top_pins_end_offset_days ?? 2);

    const fromOverride = overrides?.from_date || overrides?.start_date;
    const toOverride = overrides?.to_date || overrides?.end_date;

    let startDate: string;
    let endDate: string;

    if (fromOverride && toOverride) {
      if (fromOverride > toOverride) {
        return {
          success: false,
          connection_id: connectionId,
          channel,
          mode: 'sync',
          error: 'Validation Error: start_date must be before end_date (identical dates allowed for same-day pull).',
        };
      }
      startDate = fromOverride;
      endDate = toOverride;
    } else {
      const now = new Date();
      const startDateObj = new Date(now.getTime() - startOffset * 24 * 60 * 60 * 1000);
      const endDateObj = new Date(now.getTime() - endOffset * 24 * 60 * 60 * 1000);
      startDate = startDateObj.toISOString().split('T')[0];
      endDate = endDateObj.toISOString().split('T')[0];
    }

    // If Test Ping mode
    if (mode === 'ping') {
      try {
        const pingPayload = isAnalytics
          ? {
              job_type: 'ping',
              channel: 'account_analytics',
              connection_id: connectionId,
              start_date: startDate,
              end_date: endDate,
            }
          : {
              job_type: 'ping',
              channel: 'top_pins',
              connection_id: connectionId,
              start_date: startDate,
              end_date: endDate,
              num_of_pins: effectiveNumPins,
              sort_modes: effectiveSortModes,
            };

        const res = await fetch(webhookUrl!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pingPayload),
          signal: AbortSignal.timeout(8000),
        });

        return {
          success: res.ok,
          connection_id: connectionId,
          channel,
          mode: 'ping',
          webhookResponseStatus: res.status,
          message: res.ok ? 'Ping successful.' : `Webhook returned HTTP ${res.status}`,
        };
      } catch (err: any) {
        return {
          success: false,
          connection_id: connectionId,
          channel,
          mode: 'ping',
          error: `Ping failed: ${err.message}`,
        };
      }
    }

    const jobId = isAnalytics
      ? connection.analytics_fastcron_job_id
      : connection.top_pins_fastcron_job_id;

    const settings = await analyticsDb.getWorkspaceAnalyticsSettings(workspaceId);
    const channelToken = isAnalytics ? connection.analytics_fastcron_token : connection.top_pins_fastcron_token;
    const effectiveConnToken = channelToken || connection.fastcron_token;
    const token = await this.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);

    const payloadObj = isAnalytics
      ? {
          job_type: 'manual_sync',
          channel: 'account_analytics',
          connection_id: connectionId,
          start_date: startDate,
          end_date: endDate,
          analytics_start_offset_days: startOffset,
          analytics_end_offset_days: endOffset,
        }
      : {
          job_type: 'manual_sync',
          channel: 'top_pins',
          connection_id: connectionId,
          start_date: startDate,
          end_date: endDate,
          top_pins_start_offset_days: startOffset,
          top_pins_end_offset_days: endOffset,
          num_of_pins: effectiveNumPins,
          sort_modes: effectiveSortModes,
        };

    // If Job ID and Token exist -> Dispatches cron_run
    if (jobId && token) {
      const payload = JSON.stringify(payloadObj);

      const cronRunRes = await this.fastcronCall(
        'cron_run',
        { id: jobId, payload },
        token
      );

      if (cronRunRes.success) {
        return {
          success: true,
          connection_id: connectionId,
          channel,
          mode: 'sync',
          startDate,
          endDate,
          message: `Successfully triggered manual sync via FastCron cron_run for ${channel}.`,
        };
      } else {
        return {
          success: false,
          connection_id: connectionId,
          channel,
          mode: 'sync',
          startDate,
          endDate,
          error: cronRunRes.error || 'FastCron cron_run execution failed.',
        };
      }
    }

    // Legacy Fallback: Direct POST to channel webhook
    try {
      const res = await fetch(webhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadObj),
        signal: AbortSignal.timeout(8000),
      });

      return {
        success: res.ok,
        connection_id: connectionId,
        channel,
        mode: 'sync',
        startDate,
        endDate,
        webhookResponseStatus: res.status,
        message: res.ok
          ? `Successfully triggered ${channel} sync on Make.com proxy.`
          : `Make.com webhook returned HTTP ${res.status}`,
      };
    } catch (err: any) {
      return {
        success: false,
        connection_id: connectionId,
        channel,
        mode: 'sync',
        startDate,
        endDate,
        error: `Webhook dispatch failed: ${err.message}`,
      };
    }
  },

  /**
   * Fetches FastCron execution history logs for observability.
   */
  async getCronLogs(
    workspaceId: string,
    connectionId: string,
    jobId: number | null | undefined,
    runtimeEnv: Record<string, any>
  ): Promise<{ success: boolean; logs?: any[]; error?: string }> {
    if (!jobId) {
      return { success: false, error: 'job_not_configured' };
    }

    if (!connectionId) {
      return { success: false, error: 'connection_id is required' };
    }

    const connection = await analyticsDb.getWorkspaceConnection(workspaceId, connectionId);
    if (!connection) {
      return { success: false, error: 'Connection not found in this workspace.' };
    }

    const isMatch =
      (connection.analytics_fastcron_job_id != null && Number(connection.analytics_fastcron_job_id) === Number(jobId)) ||
      (connection.top_pins_fastcron_job_id != null && Number(connection.top_pins_fastcron_job_id) === Number(jobId));

    if (!isMatch) {
      return { success: false, error: '403 Forbidden: jobId does not belong to this connection' };
    }

    const settings = await analyticsDb.getWorkspaceAnalyticsSettings(workspaceId);
    const channelToken = connection.analytics_fastcron_token || connection.top_pins_fastcron_token;
    const effectiveConnToken = channelToken || connection.fastcron_token;
    const token = await this.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);
    if (!token) {
      return { success: false, error: 'FastCron API token not configured.' };
    }

    const res = await this.fastcronCall('cron_logs', { id: jobId }, token);
    if (!res.success) {
      return { success: false, error: res.error || 'Failed to fetch FastCron logs.' };
    }

    const logs =
      res.data?.logs ||
      res.data?.data?.logs ||
      res.data?.data ||
      (Array.isArray(res.data) ? res.data : []);

    return { success: true, logs: Array.isArray(logs) ? logs : [] };
  },

  /**
   * Pauses a FastCron job for a specified duration (e.g. "1 hour", "15 minutes").
   */
  async pauseJob(
    id: number,
    forExpr: string,
    token: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.fastcronCall('cron_pause', { id, for: forExpr }, token);
  },

  /**
   * Fetches upcoming execution times for a FastCron job.
   */
  async nextRuns(
    id: number,
    token: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.fastcronCall('cron_next', { id }, token);
  },

  /**
   * Fetches failure history logs for a FastCron job.
   */
  async getFailures(
    id: number,
    token: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.fastcronCall('cron_failures', { id }, token);
  },

  /**
   * Edits an existing FastCron job parameters.
   */
  async editJob(
    id: number,
    params: Record<string, any>,
    token: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.fastcronCall('cron_edit', { id, ...params }, token);
  },

  /**
   * Lists FastCron jobs matching keyword.
   */
  async listJobs(
    token: string,
    keyword = 'PinOrbit'
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.fastcronCall('cron_list', { keyword }, token);
  },

  /**
   * Deletes multiple FastCron jobs in a single batch call.
   */
  async batchDelete(
    ids: number[],
    token: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.fastcronCall('cron_batch_delete', { ids, id: ids, data: ids }, token);
  },

  /**
   * Adds multiple FastCron jobs in a single batch call.
   */
  async batchAdd(
    items: any[],
    token: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.fastcronCall('cron_batch_add', { data: items, jobs: items }, token);
  },
};

// ===== Publishing Schedules (Project 1, isolated from Analytics) =====
import { dbClients } from '../db/clients';
import type { SupabaseClient } from '@supabase/supabase-js';

export function buildPublishingCron(s: { interval_minutes: number; window_start: string; window_end: string; active_days: string[] }): string {
  const step = Math.max(5, Math.round(60 / Math.max(1, Math.round(60 / Math.max(5, s.interval_minutes || 36)))));
  const min = `*/${step}`;
  const hStart = parseInt(String(s.window_start || '09:00').slice(0, 2), 10);
  const hEnd = parseInt(String(s.window_end || '21:00').slice(0, 2), 10);
  const hours = hEnd >= hStart ? `${hStart}-${hEnd}` : `${hStart}-23,0-${hEnd}`;
  const map: Record<string, string> = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };
  const days = (s.active_days || []).map((d) => map[d]).filter(Boolean).sort().join(',');
  return `${min} ${hours} * * ${days || '*'}`;
}

async function resolveWebhookUrlForSchedule(schedulingClient: SupabaseClient, schedule: any): Promise<string> {
  // First try schedule.webhook_id row in account_webhooks
  if (schedule.webhook_id) {
    const { data: whData } = await schedulingClient.from('account_webhooks')
      .select('webhook_url').eq('id', schedule.webhook_id).eq('account_id', schedule.account_id).single();
    if (whData?.webhook_url) return whData.webhook_url;
  }
  // Else first active webhook of the account
  const { data: webhooks } = await schedulingClient.from('account_webhooks')
    .select('webhook_url').eq('account_id', schedule.account_id).eq('is_active', true).limit(1);
  if (webhooks && webhooks.length > 0 && webhooks[0].webhook_url) return webhooks[0].webhook_url;
  throw new Error('No active webhook URL found for account');
}

async function resolveTokenForSchedule(schedule: any, runtimeEnv: Record<string, any>): Promise<string> {
  const env = getServerEnv(runtimeEnv);
  if (schedule.fastcron_token_encrypted) {
    const dec = await decryptToken(schedule.fastcron_token_encrypted, env.TOKEN_KEK);
    if (dec && dec.trim().length >= 16) return dec.trim();
  }
  if (env.FASTCRON_API_TOKEN && env.FASTCRON_API_TOKEN.trim().length >= 16) return env.FASTCRON_API_TOKEN.trim();
  throw new Error('FastCron API token not configured');
}

export async function syncPublishingSchedule(schedule: any, runtimeEnv: Record<string, any>): Promise<{ success: boolean; job_id?: number | null; error?: string }> {
  const schedulingClient = dbClients.getSchedulingAdmin(runtimeEnv);
  let token: string;
  try {
    token = await resolveTokenForSchedule(schedule, runtimeEnv);
  } catch (e: any) {
    return { success: false, error: e.message };
  }
  let webhookUrl: string;
  try {
    webhookUrl = await resolveWebhookUrlForSchedule(schedulingClient, schedule);
  } catch (e: any) {
    return { success: false, error: e.message };
  }
  const cronExpr = buildPublishingCron(schedule);
  const jobName = `PinOrbit-pub-${schedule.id.slice(0, 8)}`;
  const postData = JSON.stringify({ kind: 'pin.post', schedule_id: schedule.id, dispatch_token: schedule.dispatch_token });
  const jobParams: Record<string, any> = {
    name: jobName,
    expression: cronExpr,
    timezone: schedule.timezone || 'UTC',
    url: webhookUrl,
    httpMethod: 'POST',
    http_method: 'POST',
    httpHeaders: 'Content-Type: application/json',
    http_headers: 'Content-Type: application/json',
    postData: postData,
    post_data: postData,
    instances: 1,
    notify: true,
    timeout: 30,
  };
  if (schedule.random_delay_minutes !== undefined && schedule.random_delay_minutes !== null) {
    jobParams.random_delay = schedule.random_delay_minutes;
  }
  let result: { success: boolean; data?: any; error?: string };
  if (schedule.fastcron_job_id) {
    jobParams.id = schedule.fastcron_job_id;
    result = await fastcronService.fastcronCall('cron_edit', jobParams, token);
  } else {
    result = await fastcronService.fastcronCall('cron_add', jobParams, token);
  }
  if (!result.success) {
    return { success: false, error: result.error };
  }
  const returnedId = result.data?.id ?? result.data?.data?.id ?? (Array.isArray(result.data?.ids) ? result.data.ids[0] : null);
  const parsedId = returnedId != null && !isNaN(Number(returnedId)) ? Number(returnedId) : null;
  if (parsedId) {
    await schedulingClient.from('posting_schedules').update({ fastcron_job_id: parsedId }).eq('id', schedule.id);
  }
  return { success: true, job_id: parsedId };
}

export async function pausePublishingSchedule(scheduleId: string, jobId: number, runtimeEnv: Record<string, any>): Promise<{ success: boolean; error?: string }> {
  const schedulingClient = dbClients.getSchedulingAdmin(runtimeEnv);
  const { data: schedule } = await schedulingClient.from('posting_schedules').select('fastcron_token_encrypted').eq('id', scheduleId).single();
  const env = getServerEnv(runtimeEnv);
  let token: string;
  if (schedule?.fastcron_token_encrypted) {
    const dec = await decryptToken(schedule.fastcron_token_encrypted, env.TOKEN_KEK);
    if (dec) token = dec.trim();
  }
  if (!token && env.FASTCRON_API_TOKEN) token = env.FASTCRON_API_TOKEN.trim();
  if (!token) return { success: false, error: 'Token not configured' };
  const res = await fastcronService.fastcronCall('cron_disable', { id: jobId }, token);
  if (!res.success) return { success: false, error: res.error };
  await schedulingClient.from('posting_schedules').update({ status: 'paused' }).eq('id', scheduleId);
  return { success: true };
}

export async function resumePublishingSchedule(scheduleId: string, jobId: number, runtimeEnv: Record<string, any>): Promise<{ success: boolean; error?: string }> {
  const schedulingClient = dbClients.getSchedulingAdmin(runtimeEnv);
  const { data: schedule } = await schedulingClient.from('posting_schedules').select('fastcron_token_encrypted').eq('id', scheduleId).single();
  const env = getServerEnv(runtimeEnv);
  let token: string;
  if (schedule?.fastcron_token_encrypted) {
    const dec = await decryptToken(schedule.fastcron_token_encrypted, env.TOKEN_KEK);
    if (dec) token = dec.trim();
  }
  if (!token && env.FASTCRON_API_TOKEN) token = env.FASTCRON_API_TOKEN.trim();
  if (!token) return { success: false, error: 'Token not configured' };
  const res = await fastcronService.fastcronCall('cron_enable', { id: jobId }, token);
  if (!res.success) return { success: false, error: res.error };
  await schedulingClient.from('posting_schedules').update({ status: 'active' }).eq('id', scheduleId);
  return { success: true };
}

export async function deletePublishingSchedule(scheduleId: string, jobId: number | null | undefined, runtimeEnv: Record<string, any>): Promise<{ success: boolean; error?: string }> {
  const schedulingClient = dbClients.getSchedulingAdmin(runtimeEnv);
  if (jobId) {
    const { data: schedule } = await schedulingClient.from('posting_schedules').select('fastcron_token_encrypted').eq('id', scheduleId).single();
    const env = getServerEnv(runtimeEnv);
    let token: string;
    if (schedule?.fastcron_token_encrypted) {
      const dec = await decryptToken(schedule.fastcron_token_encrypted, env.TOKEN_KEK);
      if (dec) token = dec.trim();
    }
    if (!token && env.FASTCRON_API_TOKEN) token = env.FASTCRON_API_TOKEN.trim();
    if (token) {
      await fastcronService.fastcronCall('cron_delete', { id: jobId }, token);
    }
  }
  await schedulingClient.from('posting_schedules').delete().eq('id', scheduleId);
  return { success: true };
}

export async function clonePublishingSchedule(scheduleId: string, runtimeEnv: Record<string, any>): Promise<{ success: boolean; new_schedule?: any; error?: string }> {
  const schedulingClient = dbClients.getSchedulingAdmin(runtimeEnv);
  const { data: orig, error: fetchErr } = await schedulingClient.from('posting_schedules').select('*').eq('id', scheduleId).single();
  if (fetchErr || !orig) return { success: false, error: 'Original schedule not found' };
  const newDispatchToken = crypto.randomUUID();
  const newLabel = (orig.label || '') + ' (copy)';
  const { data: newRow, error: insertErr } = await schedulingClient.from('posting_schedules')
    .insert({
      workspace_id: orig.workspace_id,
      account_id: orig.account_id,
      label: newLabel,
      webhook_id: orig.webhook_id,
      timezone: orig.timezone,
      window_start: orig.window_start,
      window_end: orig.window_end,
      interval_minutes: orig.interval_minutes,
      random_delay_minutes: orig.random_delay_minutes,
      active_days: orig.active_days,
      started_at: orig.started_at,
      batch: orig.batch,
      status: 'not_synced',
      dispatch_token: newDispatchToken,
      fastcron_job_id: null,
      fastcron_token_encrypted: orig.fastcron_token_encrypted,
    })
    .select()
    .single();
  if (insertErr || !newRow) return { success: false, error: insertErr?.message || 'Failed to insert clone' };
  const syncResult = await syncPublishingSchedule(newRow, runtimeEnv);
  if (!syncResult.success) return { success: false, error: syncResult.error };
  return { success: true, new_schedule: newRow };
}

export async function triggerBoardAction(accountId: string, action: 'create' | 'list' | 'delete', extra: Record<string, any>, runtimeEnv: Record<string, any>): Promise<{ success: boolean; status?: number; error?: string }> {
  const schedulingClient = dbClients.getSchedulingAdmin(runtimeEnv);
  // Resolve board channel = accounts.board_creation_webhook_id webhook row
  const { data: account } = await schedulingClient.from('accounts').select('board_creation_webhook_id').eq('id', accountId).single();
  let webhookUrl: string | null = null;
  if (account?.board_creation_webhook_id) {
    const { data: wh } = await schedulingClient.from('account_webhooks')
      .select('webhook_url').eq('id', account.board_creation_webhook_id).single();
    if (wh?.webhook_url) webhookUrl = wh.webhook_url;
  }
  // Else first active account_webhooks row
  if (!webhookUrl) {
    const { data: webhooks } = await schedulingClient.from('account_webhooks')
      .select('webhook_url').eq('account_id', accountId).eq('is_active', true).limit(1);
    if (webhooks && webhooks.length > 0) webhookUrl = webhooks[0].webhook_url;
  }
  if (!webhookUrl) return { success: false, error: 'No webhook URL found for board actions' };
  const payload = { action, account_id: accountId, ...extra };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return { success: res.ok, status: res.status };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
