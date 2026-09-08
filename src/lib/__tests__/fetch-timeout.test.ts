import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, withTimeout } from '../fetch-timeout';

afterEach(() => vi.unstubAllGlobals());

describe('fetchJson', () => {
  it('returns parsed JSON on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true }),
    }));
    await expect(fetchJson('/api/x')).resolves.toEqual({ success: true });
  });
  it('throws typed HTTP error on !ok without retry', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', f);
    await expect(fetchJson('/api/x', 1000)).rejects.toThrow('HTTP 500');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('aborts a hung fetch at the budget', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_u, opts: any) => new Promise((_res, rej) => {
      opts?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    })));
    await expect(fetchJson('/api/hung', 50)).rejects.toThrow();
  }, 10000);
});

describe('withTimeout', () => {
  it('passes through fast promises', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'p1')).resolves.toBe(7);
  });
  it('rejects with labeled timeout error when promise hangs', async () => {
    await expect(withTimeout(new Promise(() => {}), 50, 'p1-branch')).rejects.toThrow('p1-branch timed out after 50ms');
  }, 10000);
});
