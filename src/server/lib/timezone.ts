/**
 * Shared IANA Timezone validation helper using Intl.DateTimeFormat.
 * Validates timezone names against the IANA database.
 */
export function isValidTimeZone(tz: unknown): boolean {
  if (typeof tz !== 'string') return false;
  const trimmed = tz.trim();
  if (!trimmed) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}
