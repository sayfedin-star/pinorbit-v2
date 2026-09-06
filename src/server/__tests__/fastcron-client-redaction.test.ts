import { describe, it, expect, vi, afterEach } from 'vitest';
import { fastcronCall } from '../lib/fastcron-client';

describe('FastCron Client Redaction & Fail-Closed Suite (P0 #R1)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fails closed on HTTP 404 without issuing GET query string containing token', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let fetchCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: any) => {
      fetchCount++;
      capturedUrl = url;
      capturedMethod = init?.method || 'GET';
      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
    });

    const res = await fastcronCall('cron_delete', { id: 12345 }, 'sensitive_secret_token_abc123');

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/refusing fallback query-string authentication/i);
    expect(fetchCount).toBe(1);
    expect(capturedMethod).toBe('POST');
    expect(capturedUrl).toBe('https://www.fastcron.com/api/v1/cron_delete');
    expect(capturedUrl).not.toContain('sensitive_secret_token_abc123');
    expect(capturedUrl).not.toContain('token=');
  });

  it('fails closed on HTTP 405 without issuing GET query string containing token', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let fetchCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: any) => {
      fetchCount++;
      capturedUrl = url;
      capturedMethod = init?.method || 'GET';
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    });

    const res = await fastcronCall('cron_add', { name: 'test_job' }, 'sensitive_secret_token_xyz789');

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/refusing fallback query-string authentication/i);
    expect(fetchCount).toBe(1);
    expect(capturedMethod).toBe('POST');
    expect(capturedUrl).toBe('https://www.fastcron.com/api/v1/cron_add');
    expect(capturedUrl).not.toContain('sensitive_secret_token_xyz789');
    expect(capturedUrl).not.toContain('token=');
  });
});
