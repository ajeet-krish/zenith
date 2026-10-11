/**
 * Convert Julian Date to UTC string.
 */
export function jdToUtc(jd: number): string {
  const date = new Date((jd - 2440587.5) * 86400000)
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

/**
 * Convert Julian Date to UTC epoch milliseconds with integer-ms rounding.
 * Rounding (not flooring) avoids the floating-point case where the seconds
 * component lands at 59.99999... and minute-precision formatting would
 * spill into the previous minute.
 */
function jdToEpochMs(jd: number): number {
  return Math.round((jd - 2440587.5) * 86400000)
}

/**
 * Convert Julian Date to a formatted UTC date string.
 * Floor-based calendar decomposition; prefer formatJd / jdToDatetimeLocal
 * for display paths that need ms-rounding.
 */
export function jdToDate(jd: number): Date {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  const a = z < 2299161 ? z : z + 1 + Math.floor((z - 1867216.25) / 36524.25) - Math.floor(
    Math.floor((z - 1867216.25) / 36524.25) / 4
  );
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);

  const dayFrac = b - d - Math.floor(30.6001 * e) + f;
  const day = Math.floor(dayFrac);
  const dayF = dayFrac - day;
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;

  const hours = dayF * 24;
  const h = Math.floor(hours);
  const mins = (hours - h) * 60;
  const m = Math.floor(mins);
  const secs = (mins - m) * 60;
  const s = Math.floor(secs);

  return new Date(Date.UTC(year, month - 1, day, h, m, s));
}

/**
 * Format a Julian Date for display.
 */
export function formatJd(jd: number): string {
  return new Date(jdToEpochMs(jd)).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/**
 * Format a Julian Date for display (short numeric).
 */
export function formatJdShort(jd: number): string {
  return jd.toFixed(4);
}

/**
 * Convert a JS Date (UTC epoch milliseconds) to Julian Date.
 * Inverse of jdToDate.
 */
export function dateToJd(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Format a Julian Date as a datetime-local input value (UTC, minute precision).
 * Produces 'YYYY-MM-DDTHH:mm' for use with <input type="datetime-local">.
 */
export function jdToDatetimeLocal(jd: number): string {
  return new Date(jdToEpochMs(jd)).toISOString().slice(0, 16);
}

/** Strict shape of a datetime-local value: 'YYYY-MM-DDTHH:mm[:ss[.sss]]'. */
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;

/**
 * Parse a datetime-local input value as UTC and convert to Julian Date.
 * Accepts 'YYYY-MM-DDTHH:mm' or 'YYYY-MM-DDTHH:mm:ss'. Returns null when
 * the value is empty, not datetime-local shaped, or unparseable.
 */
export function datetimeLocalToJd(value: string): number | null {
  if (!value || !DATETIME_LOCAL_RE.test(value)) return null;
  const iso = value.length <= 16 ? `${value}:00Z` : `${value}Z`;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : dateToJd(new Date(ms));
}
