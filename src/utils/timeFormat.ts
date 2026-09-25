/**
 * Convert Julian Date to UTC string.
 */
export function jdToUtc(jd: number): string {
  const date = new Date((jd - 2440587.5) * 86400000)
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}
