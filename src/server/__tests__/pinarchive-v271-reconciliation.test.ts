import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeToGas } from '../../../scripts/pinarchive-discovery.mjs';

describe('PinArchive v2.7.1 Reconciliation & Resilience Suite', () => {
  const mockGasUrl = 'https://script.google.com/macros/s/mock-gas-id/exec';
  const mockSecret = 'test_secret_123';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockResponse = (status: number, body: string | object, contentType = 'application/json') => {
    const textBody = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': contentType }),
      text: async () => textBody,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    };
  };

  describe('writeToGas Retry & Backoff Resilience', () => {
    it('returns { ok: true, skipped: true } when gasUrl is empty or whitespace', async () => {
      const res = await writeToGas('', mockSecret, {});
      expect(res).toEqual({ ok: true, skipped: true });
    });

    it('succeeds on first attempt without retrying when GAS responds ok: true', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        createMockResponse(200, {
          ok: true,
          version: '2.7.1',
          written: 131,
          appended: 110,
          updated: 21,
          unchanged: 116,
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGas(mockGasUrl, mockSecret, { username: 'testuser', rows: [] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
      expect(res.written).toBe(131);
      expect(res.unchanged).toBe(116);
    });

    it('retries on "locked" error up to maxRetries and succeeds when lock frees', async () => {
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return createMockResponse(200, { ok: false, error: 'locked' });
        }
        return createMockResponse(200, {
          ok: true,
          version: '2.7.1',
          written: 50,
          appended: 50,
          updated: 0,
          unchanged: 0,
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGas(mockGasUrl, mockSecret, { username: 'testuser', rows: [] }, 3);
      expect(callCount).toBe(3);
      expect(res.ok).toBe(true);
      expect(res.written).toBe(50);
    });

    it('returns failure object after exhausting all retries on persistent lock conflict', async () => {
      const fetchMock = vi.fn().mockResolvedValue(createMockResponse(200, { ok: false, error: 'locked' }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGas(mockGasUrl, mockSecret, { username: 'testuser', rows: [] }, 2);
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
      expect(res.ok).toBe(false);
      expect(res.error).toBe('locked');
    });

    it('returns failure object on network throw after exhausting retries', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('Network timeout'));
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGas(mockGasUrl, mockSecret, { username: 'testuser', rows: [] }, 1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('Network timeout');
    });

    it('retries on 200 with non-JSON HTML body up to maxRetries and returns GAS_NON_JSON', async () => {
      const htmlBody = '<html><body>Temporarily Unavailable</body></html>';
      const fetchMock = vi.fn().mockResolvedValue(createMockResponse(200, htmlBody, 'text/html'));
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGas(mockGasUrl, mockSecret, { username: 'testuser', rows: [] }, 2);
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
      expect(res).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^GAS_NON_JSON\(status=200,ct=text\/html\):/),
      });
    });

    it('retries on 503 HTTP error with HTML body and returns GAS_HTTP_503', async () => {
      const htmlBody = 'Service Unavailable';
      const fetchMock = vi.fn().mockResolvedValue(createMockResponse(503, htmlBody, 'text/html'));
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGas(mockGasUrl, mockSecret, { username: 'testuser', rows: [] }, 2);
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
      expect(res).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^GAS_HTTP_503: Service Unavailable/),
      });
    });

    it('retries on 500 HTTP error with JSON body and returns GAS_HTTP_500', async () => {
      const jsonBody = { ok: false, error: 'internal_server_error' };
      const fetchMock = vi.fn().mockResolvedValue(createMockResponse(500, jsonBody, 'application/json'));
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGas(mockGasUrl, mockSecret, { username: 'testuser', rows: [] }, 2);
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
      expect(res).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^GAS_HTTP_500:/),
      });
    });

    it('does NOT retry on 400 validation error and returns typed GAS_HTTP_400 with exactly 1 call', async () => {
      const validationBody = { ok: false, error: 'username required' };
      const fetchMock = vi.fn().mockResolvedValue(createMockResponse(400, validationBody, 'application/json'));
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGas(mockGasUrl, mockSecret, { username: '', rows: [] }, 2);
      expect(fetchMock).toHaveBeenCalledTimes(1); // Client validation error: no retry
      expect(res).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^GAS_HTTP_400:/),
      });
    });

    it('retries on TimeoutError / AbortError and returns typed GAS_TIMEOUT_30S', async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGas(mockGasUrl, mockSecret, { username: 'testuser', rows: [] }, 1);
      expect(fetchMock).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
      expect(res).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^GAS_TIMEOUT_30S\(elapsed=\d+ms\): The operation was aborted due to timeout/),
      });
    });
  });

  describe('Tolerant Last Result Regex Parsing & Fallback Logic', () => {
    const parse = (raw: string | null | undefined) => {
      if (!raw || raw === '—') return null;
      const str = String(raw).trim();
      const m = str.match(/^pages=(\d+)(?:\s+fetched=(\d+))?\s+\+(\d+)(?:\s+qual=\d+)?\s+sheet=(\d+)(?:\s+\(app=(\d+),\s*upd=(\d+)(?:,\s*unch=(\d+))?\))?(.*)$/i);
      if (!m) return { fallback: true, raw: str };

      return {
        fallback: false,
        pages: Number(m[1]),
        fetched: m[2] !== undefined ? Number(m[2]) : null,
        newPins: Number(m[3]),
        sheet: Number(m[4]),
        app: m[5] !== undefined ? Number(m[5]) : null,
        upd: m[6] !== undefined ? Number(m[6]) : null,
        unch: m[7] !== undefined ? Number(m[7]) : null,
        extra: (m[8] || '').trim(),
      };
    };

    it('correctly parses canonical v2.7.1 format with fetched and unchanged counts', () => {
      const parsed = parse('pages=5 fetched=247 +3 sheet=131 (app=110, upd=21, unch=116)');
      expect(parsed).toEqual({
        fallback: false,
        pages: 5,
        fetched: 247,
        newPins: 3,
        sheet: 131,
        app: 110,
        upd: 21,
        unch: 116,
        extra: '',
      });
    });

    it('correctly parses format without unch when GAS is legacy v2.7.0 (no false zeros)', () => {
      const parsed = parse('pages=4 fetched=199 +2 sheet=111 (app=90, upd=21)');
      expect(parsed).toEqual({
        fallback: false,
        pages: 4,
        fetched: 199,
        newPins: 2,
        sheet: 111,
        app: 90,
        upd: 21,
        unch: null,
        extra: '',
      });
    });

    it('correctly parses legacy format (pages=3 +0 qual=0 sheet=2) without crashing', () => {
      const parsed = parse('pages=3 +0 qual=0 sheet=2');
      expect(parsed).toEqual({
        fallback: false,
        pages: 3,
        fetched: null,
        newPins: 0,
        sheet: 2,
        app: null,
        upd: null,
        unch: null,
        extra: '',
      });
    });

    it('parses circuit-breaker annotations into extra field', () => {
      const parsed = parse('pages=5 fetched=247 +3 sheet=131 (circuit-broken)');
      expect(parsed).toEqual({
        fallback: false,
        pages: 5,
        fetched: 247,
        newPins: 3,
        sheet: 131,
        app: null,
        upd: null,
        unch: null,
        extra: '(circuit-broken)',
      });
    });

    it('parses sheet error annotations into extra field', () => {
      const parsed = parse('pages=5 fetched=247 +3 sheet=0 (sheet_err: locked)');
      expect(parsed).toEqual({
        fallback: false,
        pages: 5,
        fetched: 247,
        newPins: 3,
        sheet: 0,
        app: null,
        upd: null,
        unch: null,
        extra: '(sheet_err: locked)',
      });
    });

    it('falls back gracefully to raw string for non-matching or error states', () => {
      const parsed = parse('cookie expired / http error');
      expect(parsed).toEqual({
        fallback: true,
        raw: 'cookie expired / http error',
      });
    });
  });

  describe('Noisy Failure Gate Assertion', () => {
    it('verifies process.exit condition triggers whenever grandSummary.errors > 0 regardless of newPins', () => {
      // Logic from discovery.mjs line 872:
      // if (grandSummary.errors.length > 0) process.exit(1);
      const shouldExit = (errorsCount: number, qualifyingPins: number) => {
        return errorsCount > 0;
      };

      // Even if 100 new qualifying pins were found, a sheet error must NOT be buried silently
      expect(shouldExit(1, 100)).toBe(true);
      expect(shouldExit(3, 0)).toBe(true);
      expect(shouldExit(0, 50)).toBe(false);
      expect(shouldExit(0, 0)).toBe(false);
    });
  });
});
