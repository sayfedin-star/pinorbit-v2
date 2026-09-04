import { HttpError } from './http-error';

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  // IPv4 Loopback
  if (ip === 'localhost' || ip === '127.0.0.1' || ip === '0.0.0.0') return true;

  // Cloud metadata IMDS
  if (ip === '169.254.169.254' || ip.startsWith('169.254.')) return true;

  // Parse IPv4 octets
  const ipv4Parts = ip.split('.').map(Number);
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    const [a, b] = ipv4Parts;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8
    if (a === 127) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
  }

  // IPv6 check
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc00:') || lower.startsWith('fd00:')) {
    return true;
  }

  return false;
}

export function validateSafeUrl(rawUrl: string): URL {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new HttpError(400, 'Invalid URL provided.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new HttpError(400, 'Malformed URL string.');
  }

  // Gate 1: Protocol Gate
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, `Forbidden URL protocol "${parsed.protocol}". Only http: and https: are allowed.`);
  }

  // Gate 2 & 3: Host Resolution Gate (Disallow localhost, private IPs, IMDS)
  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateOrReservedIp(hostname)) {
    throw new HttpError(400, `Forbidden destination host "${hostname}". Access to private or internal addresses is blocked.`);
  }

  // Gate 4: Port Gate (Standard web ports 80/443 only)
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new HttpError(400, `Forbidden port "${parsed.port}". Only ports 80 and 443 are allowed.`);
  }

  // Gate 5: Credentials Gate (Reject userinfo)
  if (parsed.username || parsed.password) {
    throw new HttpError(400, 'Forbidden URL: embedded credentials are not permitted.');
  }

  return parsed;
}

export async function safeFetchText(targetUrl: string, options: SafeFetchOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024; // 5MB
  const maxRedirects = options.maxRedirects ?? 3;

  let currentUrl = targetUrl;
  let redirectsCount = 0;

  while (redirectsCount <= maxRedirects) {
    const validated = validateSafeUrl(currentUrl);

    // Gate 7: Timeout signal
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Gate 6: Manual redirect following with full re-validation
      const response = await fetch(validated.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'PinOrbit-Bot/2.3 (+https://pinorbit.com)',
          'Accept': 'application/xml, text/xml, text/plain, */*',
          ...(options.headers || {}),
        },
      });

      clearTimeout(timeoutId);

      // Handle redirect
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new HttpError(400, 'Redirect response missing Location header.');
        }
        currentUrl = new URL(location, validated).toString();
        redirectsCount++;
        continue;
      }

      if (!response.ok) {
        throw new HttpError(response.status, `Remote server responded with HTTP ${response.status}: ${response.statusText}`);
      }

      // Check Content-Length if present
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader && parseInt(contentLengthHeader, 10) > maxBytes) {
        throw new HttpError(413, `Payload too large: exceeds maximum allowed size of ${maxBytes / (1024 * 1024)}MB.`);
      }

      // Read stream with byte cap guard
      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        if (text.length > maxBytes) {
          throw new HttpError(413, 'Payload too large.');
        }
        return text;
      }

      let receivedBytes = 0;
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > maxBytes) {
            reader.cancel();
            throw new HttpError(413, `Payload exceeded maximum allowed size of ${maxBytes / (1024 * 1024)}MB.`);
          }
          chunks.push(value);
        }
      }

      const totalBuffer = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        totalBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      const decoder = new TextDecoder('utf-8');
      return decoder.decode(totalBuffer);
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err instanceof HttpError) throw err;
      if (err.name === 'AbortError') {
        throw new HttpError(504, `Gateway timeout: remote server did not respond within ${timeoutMs}ms.`);
      }
      throw new HttpError(502, `Failed to fetch remote URL: ${err.message || 'Unknown network error.'}`);
    }
  }

  throw new HttpError(400, `Too many redirects (exceeded ${maxRedirects}).`);
}
