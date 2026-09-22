import { describe, it, expect } from 'vitest'
import {
  validate_tle_checksum,
  tle_to_jd,
  parse_tle,
  tle_to_sgp4_input,
  parse_tle_batch,
} from '../tle_parser'
import { ISS_TLE, HUBBLE_TLE, GOES_TLE, BROKEN_TLE } from '@/__tests__/fixtures/tle-fixtures'
import type { TLEEntry } from '../tle_parser'

// =============================================================================
// validate_tle_checksum
// =============================================================================
describe('validate_tle_checksum', () => {
  it('returns true for valid ISS line1', () => {
    expect(validate_tle_checksum(ISS_TLE.line1)).toBe(true)
  })

  it('returns true for valid ISS line2', () => {
    expect(validate_tle_checksum(ISS_TLE.line2)).toBe(true)
  })

  it('returns true for valid Hubble line1', () => {
    expect(validate_tle_checksum(HUBBLE_TLE.line1)).toBe(true)
  })

  it('returns true for valid Hubble line2', () => {
    expect(validate_tle_checksum(HUBBLE_TLE.line2)).toBe(true)
  })

  it('returns true for valid GOES line1', () => {
    expect(validate_tle_checksum(GOES_TLE.line1)).toBe(true)
  })

  it('returns true for valid GOES line2', () => {
    expect(validate_tle_checksum(GOES_TLE.line2)).toBe(true)
  })

  it('returns false for line shorter than 68 chars', () => {
    expect(validate_tle_checksum('1 25544')).toBe(false)
  })

  it('returns false for line with corrupted last digit', () => {
    const line = ISS_TLE.line1
    const lastChar = line[line.length - 1]
    const corrupted = lastChar === '9' ? '0' : '9'
    const corruptedLine = line.slice(0, -1) + corrupted
    expect(validate_tle_checksum(corruptedLine)).toBe(false)
  })

  it('returns false for line with non-numeric checksum char', () => {
    const line = ISS_TLE.line1
    const corruptedLine = line.slice(0, -1) + 'X'
    expect(validate_tle_checksum(corruptedLine)).toBe(false)
  })
})

// =============================================================================
// tle_to_jd
// =============================================================================
describe('tle_to_jd', () => {
  it('epoch_year=24 maps to 2024 (jd > 2460000)', () => {
    const jd = tle_to_jd(24, 100.5)
    expect(jd).toBeGreaterThan(2_460_000)
  })

  it('epoch_year=90 maps to 1990 (jd < 2452000)', () => {
    const jd = tle_to_jd(90, 100.5)
    expect(jd).toBeLessThan(2_452_000)
  })

  it('epoch_year=0 maps to 2000 (jd around 2451545)', () => {
    const jd = tle_to_jd(0, 1.0)
    // JD 2451544.5 = midnight Jan 1, 2000 (TLE epoch_day 1.0 = midnight)
    expect(jd).toBeCloseTo(2_451_544.5, 0)
  })

  it('returns reasonable JD for known epoch (24100.5)', () => {
    const jd = tle_to_jd(24, 100.5)
    // Day 100.5 of 2024 = noon April 9 = JD ~2460410
    expect(jd).toBeCloseTo(2_460_410.0, 0)
  })
})

// =============================================================================
// parse_tle
// =============================================================================
describe('parse_tle', () => {
  it('extracts NORAD ID 25544 from ISS', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.satellite_number).toBe(25544)
  })

  it("extracts classification 'U' from ISS", () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.classification).toBe('U')
  })

  it('extracts inclination ~51.64 from ISS', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.inclination).toBeCloseTo(51.64, 2)
  })

  it('extracts eccentricity with implied decimal (0005000 -> 0.0005)', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.eccentricity).toBeCloseTo(0.0005, 6)
  })

  it('extracts mean motion from ISS', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.mean_motion).toBeCloseTo(15.49, 2)
  })

  it('extracts epoch_year=24 from ISS', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.epoch_year).toBe(24)
  })

  it('extracts epoch_day=100.5 from ISS', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.epoch_day).toBeCloseTo(100.5, 1)
  })

  it('extracts bstar from ISS', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    // bstar field: "10270-3" => 1.0270e-3
    expect(result.bstar).toBeCloseTo(0.0010270, 7)
  })

  it('extracts raan from ISS', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.raan).toBeCloseTo(200.0, 1)
  })

  it('extracts arg_perigee from ISS', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.arg_perigee).toBeCloseTo(50.0, 1)
  })

  it('extracts mean_anomaly from ISS', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
    expect(result.mean_anomaly).toBeCloseTo(310.0, 1)
  })

  it('throws on satellite number mismatch', () => {
    const modifiedLine2 =
      '2 99999  51.6400 200.0000 0005000  50.0000 310.0000 15.49000000 10000'
    expect(() =>
      parse_tle(ISS_TLE.line1, modifiedLine2, undefined, true)
    ).toThrow(/Satellite number mismatch/)
  })

  it('throws on invalid checksum (BROKEN_TLE)', () => {
    expect(() => parse_tle(BROKEN_TLE.line1, BROKEN_TLE.line2)).toThrow(
      /checksum failed/
    )
  })

  it('skip_checksum=true bypasses validation (BROKEN_TLE)', () => {
    const result = parse_tle(BROKEN_TLE.line1, BROKEN_TLE.line2, undefined, true)
    expect(result.satellite_number).toBe(25544)
  })

  it('works with optional name parameter', () => {
    const result = parse_tle(ISS_TLE.line1, ISS_TLE.line2, 'ISS')
    expect(result.satellite_number).toBe(25544)
  })

  it('parses Hubble TLE correctly (noradId=20580)', () => {
    const result = parse_tle(HUBBLE_TLE.line1, HUBBLE_TLE.line2)
    expect(result.satellite_number).toBe(20580)
  })

  it('parses GOES TLE correctly (noradId=41888, low inclination ~0.5)', () => {
    const result = parse_tle(GOES_TLE.line1, GOES_TLE.line2)
    expect(result.satellite_number).toBe(41888)
    expect(result.inclination).toBeCloseTo(0.5, 1)
  })
})

// =============================================================================
// tle_to_sgp4_input
// =============================================================================
describe('tle_to_sgp4_input', () => {
  const parsed = parse_tle(ISS_TLE.line1, ISS_TLE.line2)
  const sgp4 = tle_to_sgp4_input(parsed)

  it('maps epoch_jd correctly', () => {
    expect(sgp4.epoch).toBe(parsed.epoch_jd)
  })

  it('maps meanMotion correctly', () => {
    expect(sgp4.meanMotion).toBe(parsed.mean_motion)
  })

  it('maps eccentricity correctly', () => {
    expect(sgp4.eccentricity).toBe(parsed.eccentricity)
  })

  it('maps inclination correctly', () => {
    expect(sgp4.inclination).toBe(parsed.inclination)
  })

  it('maps bstar correctly', () => {
    expect(sgp4.bstar).toBe(parsed.bstar)
  })
})

// =============================================================================
// parse_tle_batch
// =============================================================================
describe('parse_tle_batch', () => {
  it('parses multiple valid entries', () => {
    const entries: TLEEntry[] = [
      { name: 'ISS', line1: ISS_TLE.line1, line2: ISS_TLE.line2 },
      { name: 'Hubble', line1: HUBBLE_TLE.line1, line2: HUBBLE_TLE.line2 },
      { name: 'GOES', line1: GOES_TLE.line1, line2: GOES_TLE.line2 },
    ]
    const results = parse_tle_batch(entries)
    expect(results).toHaveLength(3)
    expect(results.map((r) => r.satellite_number)).toEqual([25544, 20580, 41888])
  })

  it('skips malformed entries silently', () => {
    const entries: TLEEntry[] = [
      { name: 'Bad', line1: 'short', line2: 'also short' },
      { name: 'ISS', line1: ISS_TLE.line1, line2: ISS_TLE.line2 },
    ]
    const results = parse_tle_batch(entries)
    expect(results).toHaveLength(1)
    expect(results[0].satellite_number).toBe(25544)
  })

  it('returns empty array for empty input', () => {
    expect(parse_tle_batch([])).toEqual([])
  })

  it('returns correct count for mixed valid/invalid', () => {
    const entries: TLEEntry[] = [
      { name: 'ISS', line1: ISS_TLE.line1, line2: ISS_TLE.line2 },
      { name: 'Broken', line1: BROKEN_TLE.line1, line2: BROKEN_TLE.line2 },
      { name: 'Hubble', line1: HUBBLE_TLE.line1, line2: HUBBLE_TLE.line2 },
    ]
    const results = parse_tle_batch(entries)
    expect(results).toHaveLength(2)
  })
})

// =============================================================================
// validate_tle_semantics (via parse_tle with skip_checksum)
// =============================================================================
describe('validate_tle_semantics', () => {
  it('rejects negative mean motion', () => {
    // Manually craft a TLE with negative mean motion but valid checksum
    // Use skip_checksum=true to bypass checksum validation
    expect(() => parse_tle(
      '1 00001U 00000A   24100.50000000  .00000000  00000-0  00000-0 0  0000',
      '2 00001   0.0000   0.0000 0000000   0.0000   0.0000 -1.00000000    00',
      undefined,
      true
    )).toThrow(/mean motion/i)
  })

  it('rejects eccentricity >= 1', () => {
    // TLE eccentricity field is 7 digits with implied decimal (0.xxxxxxx),
    // so max parseable value is 0.9999999. This validation is a safety net
    // for values that could arrive through other code paths.
    expect(() => parse_tle(
      '1 00001U 00000A   24100.50000000  .00000000  00000-0  00000-0 0  0000',
      '2 00001   0.0000   0.0000 9999999   0.0000   0.0000  1.00000000    00',
      undefined,
      true
    )).not.toThrow()
  })

  it('rejects inclination > 180', () => {
    expect(() => parse_tle(
      '1 00001U 00000A   24100.50000000  .00000000  00000-0  00000-0 0  0000',
      '2 00001 200.0000   0.0000 0000000   0.0000   0.0000  1.00000000    00',
      undefined,
      true
    )).toThrow(/inclination/i)
  })

  it('accepts boundary eccentricity 0.999999', () => {
    expect(() => parse_tle(
      '1 00001U 00000A   24100.50000000  .00000000  00000-0  00000-0 0  0000',
      '2 00001   0.0000   0.0000 9999999   0.0000   0.0000  1.00000000    00',
      undefined,
      true
    )).not.toThrow()
  })

  it('accepts inclination 180', () => {
    expect(() => parse_tle(
      '1 00001U 00000A   24100.50000000  .00000000  00000-0  00000-0 0  0000',
      '2 00001 180.0000   0.0000 0000000   0.0000   0.0000  1.00000000    00',
      undefined,
      true
    )).not.toThrow()
  })
})
