import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIp, validateSafeUrl } from '../lib/ssrf-guard';
import { HttpError } from '../lib/http-error';

describe('SSRF Guard IP Encoding Hardening Suite (P2 #30)', () => {
  describe('isPrivateOrReservedIp', () => {
    it('detects decimal integer representations of loopback and private IPs', () => {
      // 127.0.0.1 = 2130706433 (0x7F000001)
      expect(isPrivateOrReservedIp('2130706433')).toBe(true);
      // 10.0.0.1 = 167772161 (0x0A000001)
      expect(isPrivateOrReservedIp('167772161')).toBe(true);
      // 172.16.0.1 = 2886729729 (0xAC100001)
      expect(isPrivateOrReservedIp('2886729729')).toBe(true);
      // 192.168.0.1 = 3232235521 (0xC0A80001)
      expect(isPrivateOrReservedIp('3232235521')).toBe(true);
      // 169.254.169.254 = 2852039166 (0xA9FEA9FE)
      expect(isPrivateOrReservedIp('2852039166')).toBe(true);
      // 0.0.0.0 = 0
      expect(isPrivateOrReservedIp('0')).toBe(true);

      // Public IP decimal: 8.8.8.8 = 134744072
      expect(isPrivateOrReservedIp('134744072')).toBe(false);
    });

    it('detects hex representations of loopback and private IPs', () => {
      // 127.0.0.1
      expect(isPrivateOrReservedIp('0x7f000001')).toBe(true);
      // 10.0.0.1
      expect(isPrivateOrReservedIp('0x0a000001')).toBe(true);
      // 192.168.1.1
      expect(isPrivateOrReservedIp('0xc0a80101')).toBe(true);
      // 169.254.169.254
      expect(isPrivateOrReservedIp('0xa9fea9fe')).toBe(true);

      // Public IP hex: 8.8.8.8 = 0x08080808
      expect(isPrivateOrReservedIp('0x08080808')).toBe(false);
    });

    it('detects mixed dotted notation with octal and hex octets', () => {
      // 0177.0.0.1 (octal 0177 = 127)
      expect(isPrivateOrReservedIp('0177.0.0.1')).toBe(true);
      // 0x7f.0.0.1 (hex 0x7f = 127)
      expect(isPrivateOrReservedIp('0x7f.0.0.1')).toBe(true);
      // 012.0.0.1 (octal 012 = 10)
      expect(isPrivateOrReservedIp('012.0.0.1')).toBe(true);
      // 0300.0250.0.1 (octal 0300 = 192, 0250 = 168)
      expect(isPrivateOrReservedIp('0300.0250.0.1')).toBe(true);
      // 0xc0.0xa8.0.1 (hex 0xc0 = 192, 0xa8 = 168)
      expect(isPrivateOrReservedIp('0xc0.0xa8.0.1')).toBe(true);
    });

    it('detects IPv4-mapped IPv6 addresses', () => {
      expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('[::ffff:127.0.0.1]')).toBe(true);
      expect(isPrivateOrReservedIp('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateOrReservedIp('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateOrReservedIp('::ffff:7f00:1')).toBe(true);
    });

    it('handles trailing dots correctly', () => {
      expect(isPrivateOrReservedIp('localhost.')).toBe(true);
      expect(isPrivateOrReservedIp('127.0.0.1.')).toBe(true);
      expect(isPrivateOrReservedIp('example.com.')).toBe(false);
    });
  });

  describe('validateSafeUrl with encoded IP evasions', () => {
    it('rejects decimal integer IP URLs', () => {
      expect(() => validateSafeUrl('http://2130706433/')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://2852039166/latest/meta-data')).toThrow(HttpError);
    });

    it('rejects hex IP URLs', () => {
      expect(() => validateSafeUrl('http://0x7f000001/')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://0xa9fea9fe/meta-data')).toThrow(HttpError);
    });

    it('rejects octal and hex dotted notation URLs', () => {
      expect(() => validateSafeUrl('http://0177.0.0.1/')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://0x7f.0.0.1/')).toThrow(HttpError);
    });

    it('rejects IPv4-mapped IPv6 URLs', () => {
      expect(() => validateSafeUrl('http://[::ffff:127.0.0.1]/')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://[::ffff:169.254.169.254]/')).toThrow(HttpError);
    });

    it('rejects loopback with trailing dot', () => {
      expect(() => validateSafeUrl('http://localhost./')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://127.0.0.1./')).toThrow(HttpError);
    });
  });
});
