import { describe, it, expect } from 'vitest'
import { jdToDatetimeLocal, datetimeLocalToJd } from '../timeFormat'

describe('datetimeLocalToJd', () => {
  it('parses the input value as UTC, not local time', () => {
    // Independent reference: Date.UTC milliseconds -> JD. Any local-time
    // misparse would shift the result by the runtime UTC offset.
    const expected = Date.UTC(2024, 2, 1, 12, 0, 0) / 86400000 + 2440587.5
    expect(datetimeLocalToJd('2024-03-01T12:00')).toBe(expected)
  })

  it('accepts second-precision values', () => {
    const expected = Date.UTC(2024, 2, 1, 12, 0, 30) / 86400000 + 2440587.5
    expect(datetimeLocalToJd('2024-03-01T12:00:30')).toBe(expected)
  })

  it('returns null for empty and structurally invalid input', () => {
    expect(datetimeLocalToJd('')).toBeNull()
    expect(datetimeLocalToJd('2024-13-99T99:99')).toBeNull()
  })
})

describe('jdToDatetimeLocal round-trip', () => {
  // Minute-aligned JDs across leap boundaries, month ends, and J2000.
  const minuteAligned = [
    '2000-01-01T00:00',
    '2024-02-28T23:59',
    '2024-02-29T00:00',
    '2024-03-01T12:34',
    '2024-12-31T23:58',
    '2025-01-01T00:01',
  ]

  it.each(minuteAligned)(
    'round-trips %s within 1 second',
    (value) => {
      const jd = datetimeLocalToJd(value)
      expect(jd).not.toBeNull()
      const back = datetimeLocalToJd(jdToDatetimeLocal(jd!))
      expect(back).not.toBeNull()
      expect(Math.abs(back! - jd!) * 86400).toBeLessThan(1.0)
      expect(jdToDatetimeLocal(jd!)).toBe(value)
    }
  )

  it('round-trips arbitrary fractional JDs within one minute (minute truncation)', () => {
    // jdToDatetimeLocal truncates to minute precision, so the round-trip
    // loss is bounded by 60 s, never a timezone-scale shift.
    const jd = 2460370.5 + 0.5123456789
    const back = datetimeLocalToJd(jdToDatetimeLocal(jd))
    expect(back).not.toBeNull()
    const errSec = Math.abs(back! - jd) * 86400
    expect(errSec).toBeLessThan(60.0)
    expect(errSec).toBeGreaterThan(0.5)
  })
})
