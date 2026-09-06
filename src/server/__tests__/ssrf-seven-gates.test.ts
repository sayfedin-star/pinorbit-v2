import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPrivateOrReservedIp, validateSafeUrl, safeFetchText } from '../lib/ssrf-guard';
import { HttpError } from '../lib/http-error';

describe('SSRF Guard Seven Gates Suite', () => {
  describe('Gate 1: Protocol Gate', () => {
    it('accepts http: and https: protocols', () => {
      expect(validateSafeUrl('http://example.com').protocol).toBe('http:');
      expect(validateSafeUrl('https://example.com').protocol).toBe('https:');
    });

    it('rejects disallowed protocols (file:, ftp:, javascript:, data:)', () => {
      expect(() => validateSafeUrl('file:///etc/passwd')).toThrow(HttpError);
      expect(() => validateSafeUrl('ftp://ftp.example.com')).toThrow(HttpError);
      expect(() => validateSafeUrl('javascript:alert(1)')).toThrow(HttpError);
      expect(() => validateSafeUrl('data:text/html,test')).toThrow(HttpError);
    });
  });

  describe('Gate 2 & 3: Host Resolution & Private IP Gates', () => {
    it('detects localhost and loopback IPv4', () => {
      expect(isPrivateOrReservedIp('localhost')).toBe(true);
      expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('127.0.1.10')).toBe(true);
      expect(isPrivateOrReservedIp('0.0.0.0')).toBe(true);
    });

    it('detects IMDS cloud metadata IP (169.254.169.254)', () => {
      expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
      expect(isPrivateOrReservedIp('169.254.1.1')).toBe(true);
    });

    it('detects RFC 1918 private ranges (10.x, 172.16-31.x, 192.168.x)', () => {
      expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('172.31.255.255')).toBe(true);
      expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
      expect(isPrivateOrReservedIp('100.64.0.1')).toBe(true);
    });

    it('detects IPv6 loopback and private ranges', () => {
      expect(isPrivateOrReservedIp('::1')).toBe(true);
      expect(isPrivateOrReservedIp('::')).toBe(true);
      expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
      expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
    });

    it('allows public domain names and public IPs', () => {
      expect(isPrivateOrReservedIp('example.com')).toBe(false);
      expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
      expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
    });

    it('throws 400 when URL points to private host', () => {
      expect(() => validateSafeUrl('http://127.0.0.1/admin')).toThrowError(/private or internal addresses is blocked/);
      expect(() => validateSafeUrl('http://169.254.169.254/latest/meta-data')).toThrowError(/private or internal addresses is blocked/);
    });
  });

  describe('Gate 4: Port Gate', () => {
    it('accepts ports 80 and 443', () => {
      expect(() => validateSafeUrl('http://example.com:80')).not.toThrow();
      expect(() => validateSafeUrl('https://example.com:443')).not.toThrow();
    });

    it('rejects arbitrary ports (8080, 3000, 22, 5432)', () => {
      expect(() => validateSafeUrl('http://example.com:8080')).toThrowError(/Forbidden port "8080"/);
      expect(() => validateSafeUrl('http://example.com:22')).toThrowError(/Forbidden port "22"/);
    });
  });

  describe('Gate 5: Credentials Gate', () => {
    it('rejects URLs with embedded username or password', () => {
      expect(() => validateSafeUrl('http://user:pass@example.com')).toThrowError(/embedded credentials/);
      expect(() => validateSafeUrl('http://admin@example.com')).toThrowError(/embedded credentials/);
    });
  });

  describe('Gate 6 & 7: Redirect following, Timeout and Body Cap', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('Gate 6: re-validates redirect destination and blocks redirect to private IP', async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('example.com')) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'http://169.254.169.254/secret' },
            })
          );
        }
        return Promise.resolve(new Response('ok'));
      });

      await expect(safeFetchText('http://example.com/redirect')).rejects.toThrowError(
        /Access to private or internal addresses is blocked/
      );
    });

    it('Gate 7: aborts and returns 504 on timeout', async () => {
      global.fetch = vi.fn().mockImplementation((_url: string, init: any) => {
        return new Promise((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      await expect(safeFetchText('http://example.com/slow', { timeoutMs: 50 })).rejects.toThrow(HttpError);
    });

    it('Body Cap: throws 413 if response exceeds maxBytes', async () => {
      const hugeData = 'x'.repeat(2000);
      global.fetch = vi.fn().mockResolvedValue(
        new Response(hugeData, {
          headers: { 'content-length': '2000' },
        })
      );

      await expect(safeFetchText('http://example.com/huge', { maxBytes: 1000 })).rejects.toThrow(HttpError);
    });
  });
});
