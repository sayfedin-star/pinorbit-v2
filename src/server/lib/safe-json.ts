/**
 * Safe Inbound JSON Parser with Memory / Size Bounds (5MB).
 *
 * Protects Cloudflare Pages Workers from:
 * 1. Unhandled Stream Read Exceptions (client aborts / connection drops)
 * 2. Memory Exhaustion / OOM from oversized payloads (>5MB)
 * 3. Unhandled SyntaxError from malformed JSON or HTML error pages
 */

export interface SafeJsonResult<T = any> {
  ok: boolean;
  body?: T;
  status?: number;
  error?: string;
}

export async function safeParseJson<T = any>(
  req: Request,
  maxBytes = 5 * 1024 * 1024
): Promise<SafeJsonResult<T>> {
  let text = '';
  try {
    text = await req.text();
  } catch (readErr: any) {
    return {
      ok: false,
      status: 400,
      error: `Failed to read request body: ${readErr?.message || 'Stream error'}`,
    };
  }

  if (text.length > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `Payload too large. Maximum allowed size is ${maxBytes} bytes.`,
    };
  }

  if (!text || text.trim().length === 0) {
    return {
      ok: true,
      body: {} as T,
    };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      ok: true,
      body: parsed,
    };
  } catch (parseErr: any) {
    return {
      ok: false,
      status: 400,
      error: `Malformed JSON payload: ${parseErr?.message || 'Syntax error'}`,
    };
  }
}
