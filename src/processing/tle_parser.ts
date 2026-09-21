/**
 * TLE (Two-Line Element) parser for NORAD catalog objects.
 *
 * Parses the standard NORAD 2-line format used for Earth-orbiting satellites.
 * Handles implied decimals, checksum validation, and Julian Date epoch conversion.
 *
 * Reference: NORAD Space-Track TLE format specification.
 * https://celestrak.org/NORAD/documentation/tle-fmt.asp
 */

import type { SGP4Input } from '@/orbit/types'

/** Parsed TLE orbital elements */
export interface TLEElements {
  satellite_number: number
  classification: 'U' | 'C' | 'S'
  intl_designator: string
  epoch_year: number
  epoch_day: number
  epoch_jd: number
  mean_motion_dot: number
  mean_motion_ddot: number
  bstar: number
  element_set_number: number
  inclination: number
  raan: number
  eccentricity: number
  arg_perigee: number
  mean_anomaly: number
  mean_motion: number
  revolution_number: number
}

/** Named TLE entry (name + both lines) */
export interface TLEEntry {
  name: string
  line1: string
  line2: string
}

// ---------------------------------------------------------------------------
//  Checksum
// ---------------------------------------------------------------------------

/**
 * Validate a single TLE line using the NORAD modulo-10 checksum.
 *
 * Rules:
 *   - Sum every digit character.
 *   - Treat '-' as 1.
 *   - Ignore all other characters (letters, spaces, periods).
 *   - The sum mod 10 must equal the last character (column 69 / 70).
 *
 * @param line - A single TLE line (Line 1 or Line 2)
 * @returns true if the checksum matches
 */
export function validate_tle_checksum(line: string): boolean {
  if (line.length < 68) {
    return false
  }

  let sum = 0
  // Checksum covers columns 1-68 (indices 0-67). The last char is the checksum.
  for (let idx = 0; idx < 68; idx++) {
    const ch = line[idx] ?? ''
    if (ch >= '0' && ch <= '9') {
      sum += parseInt(ch, 10)
    } else if (ch === '-') {
      sum += 1
    }
    // Letters, spaces, periods -> add 0
  }

  const expected = parseInt(line[68] ?? '', 10)
  if (Number.isNaN(expected)) {
    return false
  }

  return (sum % 10) === expected
}

// ---------------------------------------------------------------------------
//  Epoch -> Julian Date
// ---------------------------------------------------------------------------

/**
 * Convert a 2-digit epoch year + day-of-year to Julian Date.
 *
 * Year convention: epoch_year < 57 means 2000s, otherwise 1900s.
 *
 * @param epoch_year - 2-digit year (e.g. 24 for 2024)
 * @param epoch_day  - Day of year with fractional part (e.g. 100.5)
 * @returns Julian Date (TT)
 */
export function tle_to_jd(epoch_year: number, epoch_day: number): number {
  const century = epoch_year < 57 ? 2000 : 1900
  const full_year = century + epoch_year

  // Meeus algorithm: compute JD of Jan 0.0 then add epoch_day.
  // For January (month 1), treat as month 13 of the previous year.
  const m = 1 // January
  const y_adj = full_year + (m <= 2 ? -1 : 0)
  const m_adj = m + (m <= 2 ? 12 : 0)

  // Gregorian calendar correction factor
  const a = Math.floor(y_adj / 100)
  const b = 2 - a + Math.floor(a / 4)

  // JD at midnight Jan 0.0 (= midnight between Dec 30 and Dec 31 of previous year)
  const jd_jan0 =
    Math.floor(365.25 * (y_adj + 4716)) +
    Math.floor(30.6001 * (m_adj + 1)) +
    b -
    1524.5

  // epoch_day = 1.0 is midnight Jan 1, so jd = jd_jan0 + epoch_day
  return jd_jan0 + epoch_day
}

// ---------------------------------------------------------------------------
//  TLE Parser
// ---------------------------------------------------------------------------

/**
 * Parse a pair of TLE lines into structured orbital elements.
 *
 * @param line1 - TLE Line 1 (must be exactly 69 characters)
 * @param line2 - TLE Line 2 (must be exactly 69 characters)
 * @param name  - Optional satellite name (not in TLE lines)
 * @returns Parsed TLE elements ready for SGP4 propagation
 * @throws Error if lines are malformed or satellite numbers don't match
 */
export function parse_tle(
  line1: string,
  line2: string,
  name?: string,
  skip_checksum = false
): TLEElements {
  // Pad to 69 chars to avoid index-out-of-range on short lines
  const l1 = line1.padEnd(69, ' ')
  const l2 = line2.padEnd(69, ' ')

  // --- Validate checksums ---
  if (!skip_checksum) {
    if (!validate_tle_checksum(l1)) {
      throw new Error(`Line 1 checksum failed${name ? ` for ${name}` : ''}`)
    }
    if (!validate_tle_checksum(l2)) {
      throw new Error(`Line 2 checksum failed${name ? ` for ${name}` : ''}`)
    }
  }

  // --- Line 1 fields ---
  // Columns are 1-indexed in the spec; convert to 0-indexed.
  const sat_num_1 = parseInt(l1.substring(2, 8).trim(), 10)
  const sat_num_2 = parseInt(l2.substring(2, 8).trim(), 10)
  if (sat_num_1 !== sat_num_2) {
    throw new Error(
      `Satellite number mismatch: Line 1 = ${sat_num_1}, Line 2 = ${sat_num_2}`
    )
  }

  const classification = (l1[7] ?? 'U') as 'U' | 'C' | 'S'
  const intl_designator = l1.substring(9, 17).trim()

  const epoch_year = parseInt(l1.substring(18, 20), 10)
  const epoch_day = parseFloat(l1.substring(20, 32))
  const epoch_jd = tle_to_jd(epoch_year, epoch_day)

  const mean_motion_dot = parseFloat(l1.substring(34, 44))
  const mean_motion_ddot = parse_implied_decimal(l1.substring(44, 52))
  const bstar = parse_implied_decimal(l1.substring(53, 61))
  const element_set_number = parseInt(l1.substring(62, 68).trim(), 10)

  // --- Line 2 fields ---
  const inclination = parseFloat(l2.substring(8, 16))
  const raan = parseFloat(l2.substring(17, 25))

  // Eccentricity: 7 digits with implied decimal (e.g. "0005000" -> 0.0005000)
  const eccentricity_str = l2.substring(26, 33)
  const eccentricity = parseFloat(`0.${eccentricity_str}`)

  const arg_perigee = parseFloat(l2.substring(34, 42))
  const mean_anomaly = parseFloat(l2.substring(43, 51))
  const mean_motion = parseFloat(l2.substring(52, 63))
  const revolution_number = parseInt(l2.substring(63, 68).trim(), 10)

  return {
    satellite_number: sat_num_1,
    classification,
    intl_designator,
    epoch_year,
    epoch_day,
    epoch_jd,
    mean_motion_dot,
    mean_motion_ddot,
    bstar,
    element_set_number,
    inclination,
    raan,
    eccentricity,
    arg_perigee,
    mean_anomaly,
    mean_motion,
    revolution_number,
  }
}

// ---------------------------------------------------------------------------
//  SGP4 Input Conversion
// ---------------------------------------------------------------------------

/**
 * Convert parsed TLE elements into SGP4Input for orbit propagation.
 *
 * @param tle - Parsed TLE elements from parse_tle()
 * @returns SGP4Input compatible with the SGP4 propagator
 */
export function tle_to_sgp4_input(tle: TLEElements): SGP4Input {
  return {
    epoch: tle.epoch_jd,
    meanMotion: tle.mean_motion,
    eccentricity: tle.eccentricity,
    inclination: tle.inclination,
    raan: tle.raan,
    argPerigee: tle.arg_perigee,
    meanAnomaly: tle.mean_anomaly,
    bstar: tle.bstar,
  }
}

// ---------------------------------------------------------------------------
//  Batch Parsing
// ---------------------------------------------------------------------------

/**
 * Parse multiple named TLE entries at once.
 *
 * @param entries - Array of {name, line1, line2} objects
 * @returns Array of parsed TLEElements (skips entries that fail to parse)
 */
export function parse_tle_batch(entries: TLEEntry[]): TLEElements[] {
  const results: TLEElements[] = []
  for (const entry of entries) {
    try {
      results.push(parse_tle(entry.line1, entry.line2, entry.name))
    } catch {
      // Skip malformed entries silently
    }
  }
  return results
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a TLE field with an implied decimal point.
 *
 * Fields like B* and mean-motion second derivative use a compressed format:
 *   " 10270-3" -> 1.0270e-3
 *   " 00000-0" -> 0.0000e-0
 *   "+.00016717" -> not implied, but handled by parseFloat
 *
 * The format is: [optional sign][digits][exponent with sign]
 * The decimal is implied after the first digit.
 *
 * @param field - Raw field string (6 chars)
 * @returns Parsed floating point value
 */
function parse_implied_decimal(field: string): number {
  const trimmed = field.trim()

  // If it contains a decimal point already, just parse it
  if (trimmed.includes('.')) {
    return parseFloat(trimmed)
  }

  // Try to find the exponent part (last 2 chars often contain the exponent)
  // Pattern: "NNNNNEE" where E is the exponent sign + digit
  // The implied decimal goes after the first significant digit

  // Handle formats like "10270-3" -> 1.0270e-3
  // or " 00000-0" -> 0.0
  const match = trimmed.match(/^([+-]?)(\d+)\s*([+-]\d+)$/)
  if (match) {
    const sign = match[1] ?? ''
    const mantissa = match[2] ?? ''
    const exponent = match[3] ?? ''

    // Place decimal after first digit
    const mantissa_str =
      mantissa.length > 0 ? `${mantissa[0]}.${mantissa.substring(1)}` : '0'

    return parseFloat(`${sign}${mantissa_str}e${exponent}`)
  }

  // Fallback: try plain parseFloat (handles "0000000" -> 0)
  return parseFloat(trimmed)
}
