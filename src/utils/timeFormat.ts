/**
 * Convert Julian Date to UTC string.
 */
export function jdToUtc(jd: number): string {
  const date = new Date((jd - 2440587.5) * 86400000)
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

/**
 * Convert Julian Date to a formatted UTC date string.
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
  const date = jdToDate(jd);
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/**
 * Format Julian Date for display (short numeric).
 */
export function formatJdShort(jd: number): string {
  return jd.toFixed(4);
}
