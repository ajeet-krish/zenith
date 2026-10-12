// =============================================================================
// Zenith Web - Observation Import (Phase 5: OD Visualization)
// =============================================================================
// Pure-TS parsers for importing OD observations from CSV and JSON text.
// No DOM APIs (the importing panel owns FileReader/clipboard) and no store or
// WASM dependencies, so the logic is fully unit-testable.
//
// Import caps: a file whose parse would exceed MAX_IMPORT_OBS observations
// (or, for JSON, MAX_IMPORT_STATIONS embedded stations) is rejected in full
// with a clear error. No partial import is applied.

import { DEFAULT_OBS_CONFIG } from './odConstants'
import type { ODObservation, ODObservationType } from './types'

// =============================================================================
// Types
// =============================================================================

/** Station geodetic definition without store ids or WASM handles (parser output). */
export interface ImportedStationDef {
  /** Station name as spelled by the source (canonical casing preserved). */
  name: string
  /** Geodetic latitude [rad]. */
  latRad: number
  /** Geodetic longitude [rad]. */
  lonRad: number
  /** Altitude above the ellipsoid [km]. */
  altKm: number
}

/** Shared result shape of parseObservationCsv and parseObservationJson. */
export interface ObservationParseResult {
  /**
   * Successfully parsed observations. `stationId` holds the matched station
   * NAME (not a useODStore id): the importing panel remaps names to store ids
   * after merging station defs via addStation.
   */
  observations: ODObservation[]
  /**
   * Deduplicated defs of the stations referenced by successfully parsed
   * observations, in first-reference order.
   */
  stations: ImportedStationDef[]
  /**
   * Names of embedded station defs (JSON only) whose name matched an
   * already-available station. The importing panel keeps the existing
   * definition at merge time and reports these names; always empty for CSV.
   */
  overriddenStations: string[]
  /** Schema errors and per-row errors (row errors include the source line or index). */
  errors: string[]
}

/** Maximum observations a single import may produce (rejected in full above). */
export const MAX_IMPORT_OBS = 50000

/** Maximum embedded station defs a single JSON import may carry (rejected in full above). */
export const MAX_IMPORT_STATIONS = 500

/** Observation types accepted by batch least-squares and EKF import. */
const IMPORTABLE_OBS_TYPES: ReadonlySet<string> = new Set(['range', 'range_rate', 'ra_dec'])

/** Scalar count for each observation type. */
const OBS_NDIM: Record<ODObservationType, number> = {
  range: 1,
  range_rate: 1,
  ra_dec: 2,
  az_el: 2,
}

// =============================================================================
// CSV Parsing
// =============================================================================

/**
 * Parse a CSV observation file.
 *
 * Layout (PM format): a header row naming columns epoch_jd, station, obs_type,
 * value1 [, value2, sigma1, sigma2], followed by data rows. Column order is
 * flexible; `#` comment lines and blank lines are skipped. az_el rows are
 * rejected (batch least-squares and EKF do not estimate them). Row-level
 * errors carry the 1-based source line number and parsing continues with the
 * remaining rows.
 *
 * @param text Raw CSV file contents.
 * @param availableStations Station defs the `station` column is matched
 *   against, case-insensitively by name.
 */
export function parseObservationCsv(
  text: string,
  availableStations: ImportedStationDef[]
): ObservationParseResult {
  const observations: ODObservation[] = []
  const errors: string[] = []
  const lookup = buildStationLookup(availableStations)

  const lines = text.split(/\r?\n/)

  // Locate the header row (first non-blank, non-comment line).
  let headerIdx = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (isSkippableLine(lines[i]!)) {
      continue
    }
    headerIdx = i
    break
  }
  if (headerIdx === -1) {
    return {
      observations: [],
      stations: [],
      overriddenStations: [],
      errors: ['No header row found (input is empty or only comments)'],
    }
  }

  const header = lines[headerIdx]!.replace(/^\uFEFF/, '').split(',').map((c) => c.trim().toLowerCase())
  const col = (name: string): number => header.indexOf(name)

  const requiredCols = ['epoch_jd', 'station', 'obs_type', 'value1']
  const missing = requiredCols.filter((name) => col(name) === -1)
  if (missing.length > 0) {
    return {
      observations: [],
      stations: [],
      overriddenStations: [],
      errors: [`Header is missing required column(s): ${missing.join(', ')}`],
    }
  }
  const hasValue2 = col('value2') !== -1
  const hasSigma1 = col('sigma1') !== -1
  const hasSigma2 = col('sigma2') !== -1

  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const raw = lines[i]!
    if (isSkippableLine(raw)) {
      continue
    }
    const lineNo = i + 1
    const cells = raw.split(',').map((c) => c.trim())
    const cell = (name: string): string => {
      const idx = col(name)
      return idx === -1 ? '' : (cells[idx] ?? '')
    }

    const epoch = parseFiniteNumber(cell('epoch_jd'))
    if (epoch === null || epoch <= 0) {
      errors.push(`line ${lineNo}: invalid epoch_jd '${cell('epoch_jd')}' (must be a finite Julian Date > 0)`)
      continue
    }

    const typeResult = resolveObsType(cell('obs_type'))
    if (!typeResult.ok) {
      errors.push(`line ${lineNo}: ${typeResult.reason}`)
      continue
    }
    const obsType = typeResult.obsType
    const ndim = OBS_NDIM[obsType]

    const stationDef = lookup.get(cell('station').toLowerCase())
    if (!stationDef) {
      errors.push(`line ${lineNo}: unknown station '${cell('station')}' (not in the available station list)`)
      continue
    }

    const values: number[] = []
    const value1 = parseFiniteNumber(cell('value1'))
    if (value1 === null) {
      errors.push(`line ${lineNo}: value1 must be a finite number, got '${cell('value1')}'`)
      continue
    }
    values.push(value1)
    if (ndim === 2) {
      const value2 = hasValue2 ? parseFiniteNumber(cell('value2')) : null
      if (value2 === null) {
        errors.push(`line ${lineNo}: obs_type '${obsType}' requires value2 (a finite number)`)
        continue
      }
      values.push(value2)
    }

    const sigmaResult = resolveCsvSigmas(cell('sigma1'), cell('sigma2'), hasSigma1, hasSigma2, obsType, lineNo)
    if (!sigmaResult.ok) {
      errors.push(sigmaResult.reason)
      continue
    }

    observations.push({
      timeJd: epoch,
      stationId: stationDef.name,
      obsType,
      values,
      sigmas: sigmaResult.sigmas,
    })
    if (observations.length > MAX_IMPORT_OBS) {
      return {
        observations: [],
        stations: [],
        overriddenStations: [],
        errors: [`too many observations: limit is ${MAX_IMPORT_OBS}, import rejected`],
      }
    }
  }

  return {
    observations,
    stations: collectReferencedStations(observations, lookup),
    overriddenStations: [],
    errors,
  }
}

// =============================================================================
// JSON Parsing
// =============================================================================

interface RawJsonObservation {
  epoch_jd?: unknown
  station?: unknown
  obs_type?: unknown
  values?: unknown
  sigmas?: unknown
}

interface RawJsonStation {
  name?: unknown
  lat_rad?: unknown
  lon_rad?: unknown
  alt_km?: unknown
}

/**
 * Parse a JSON observation file (PM schema).
 *
 * Shape: `{ observations: [{epoch_jd, station, obs_type, values, sigmas?}],
 * stations?: [{name, lat_rad, lon_rad, alt_km}] }`. Embedded stations
 * augment `availableStations`; an embedded def with the same name
 * (case-insensitive) replaces the available def inside the parser's lookup,
 * and its name is recorded in `overriddenStations` so the importing panel
 * can report that the existing definition was kept. Files embedding more
 * than MAX_IMPORT_STATIONS stations, or parsing past MAX_IMPORT_OBS
 * observations, are rejected in full. Row-level errors carry the
 * observation index (`observations[N]: ...`) and parsing continues.
 *
 * @param text Raw JSON file contents.
 * @param availableStations Fallback station defs when the file embeds none.
 */
export function parseObservationJson(
  text: string,
  availableStations: ImportedStationDef[]
): ObservationParseResult {
  const errors: string[] = []

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { observations: [], stations: [], overriddenStations: [], errors: [`Invalid JSON: ${message}`] }
  }

  if (typeof root !== 'object' || root === null || !Array.isArray((root as { observations?: unknown }).observations)) {
    return {
      observations: [],
      stations: [],
      overriddenStations: [],
      errors: ['Invalid schema: expected an object with an observations array'],
    }
  }
  const { observations: rawObs, stations: rawStations } = root as {
    observations: RawJsonObservation[]
    stations?: RawJsonStation[]
  }

  if (Array.isArray(rawStations) && rawStations.length > MAX_IMPORT_STATIONS) {
    return {
      observations: [],
      stations: [],
      overriddenStations: [],
      errors: [`too many embedded stations: limit is ${MAX_IMPORT_STATIONS}, import rejected`],
    }
  }

  // Available stations, then embedded defs (same name -> embedded wins in
  // the lookup; the name is recorded so the panel can report keeping the
  // existing store definition).
  const lookup = buildStationLookup(availableStations)
  const overriddenSeen = new Set<string>()
  const overriddenStations: string[] = []
  if (Array.isArray(rawStations)) {
    for (let i = 0; i < rawStations.length; i += 1) {
      const raw = rawStations[i]!
      const name = typeof raw.name === 'string' ? raw.name.trim() : ''
      const latRad = typeof raw.lat_rad === 'number' ? raw.lat_rad : NaN
      const lonRad = typeof raw.lon_rad === 'number' ? raw.lon_rad : NaN
      const altKm = typeof raw.alt_km === 'number' ? raw.alt_km : NaN
      if (name === '' || !Number.isFinite(latRad) || !Number.isFinite(lonRad) || !Number.isFinite(altKm)) {
        errors.push(`stations[${i}]: requires name, lat_rad, lon_rad, and alt_km (finite numbers)`)
        continue
      }
      const key = name.toLowerCase()
      if (lookup.has(key) && !overriddenSeen.has(key)) {
        overriddenSeen.add(key)
        overriddenStations.push(name)
      }
      lookup.set(key, { name, latRad, lonRad, altKm })
    }
  }

  const observations: ODObservation[] = []
  for (let i = 0; i < rawObs.length; i += 1) {
    const raw = rawObs[i]!
    const label = `observations[${i}]`

    const epoch = typeof raw.epoch_jd === 'number' ? raw.epoch_jd : NaN
    if (!Number.isFinite(epoch) || epoch <= 0) {
      errors.push(`${label}: invalid epoch_jd (must be a finite Julian Date > 0)`)
      continue
    }

    if (typeof raw.obs_type !== 'string') {
      errors.push(`${label}: obs_type must be a string`)
      continue
    }
    const typeResult = resolveObsType(raw.obs_type)
    if (!typeResult.ok) {
      errors.push(`${label}: ${typeResult.reason}`)
      continue
    }
    const obsType = typeResult.obsType
    const ndim = OBS_NDIM[obsType]

    if (typeof raw.station !== 'string') {
      errors.push(`${label}: station must be a string`)
      continue
    }
    const stationDef = lookup.get(raw.station.trim().toLowerCase())
    if (!stationDef) {
      errors.push(`${label}: unknown station '${raw.station}' (not in the available station list)`)
      continue
    }

    if (!Array.isArray(raw.values) || raw.values.length !== ndim) {
      errors.push(`${label}: obs_type '${obsType}' requires exactly ${ndim} value(s) in values`)
      continue
    }
    if (raw.values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      errors.push(`${label}: values must all be finite numbers`)
      continue
    }
    const values = raw.values as number[]

    let sigmas: number[]
    if (raw.sigmas === undefined || raw.sigmas === null) {
      sigmas = defaultSigmasForType(obsType)
    } else {
      if (!Array.isArray(raw.sigmas) || raw.sigmas.length !== ndim) {
        errors.push(`${label}: sigmas must be an array of exactly ${ndim} number(s) when provided`)
        continue
      }
      if (raw.sigmas.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
        errors.push(`${label}: sigmas must all be finite numbers > 0`)
        continue
      }
      sigmas = raw.sigmas as number[]
    }

    observations.push({
      timeJd: epoch,
      stationId: stationDef.name,
      obsType,
      values,
      sigmas,
    })
    if (observations.length > MAX_IMPORT_OBS) {
      return {
        observations: [],
        stations: [],
        overriddenStations,
        errors: [`too many observations: limit is ${MAX_IMPORT_OBS}, import rejected`],
      }
    }
  }

  return {
    observations,
    stations: collectReferencedStations(observations, lookup),
    overriddenStations,
    errors,
  }
}

// =============================================================================
// Shared Helpers
// =============================================================================

/** True for blank lines and `#` comment lines. */
function isSkippableLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

/** Parse a CSV cell into a finite number (null for empty or non-numeric text). */
function parseFiniteNumber(raw: string): number | null {
  if (raw === '') {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** Case-insensitive station-name lookup keyed by lowercased name. */
function buildStationLookup(list: ImportedStationDef[]): Map<string, ImportedStationDef> {
  const map = new Map<string, ImportedStationDef>()
  for (const station of list) {
    map.set(station.name.trim().toLowerCase(), {
      name: station.name.trim(),
      latRad: station.latRad,
      lonRad: station.lonRad,
      altKm: station.altKm,
    })
  }
  return map
}

type ObsTypeResolution =
  | { ok: true; obsType: ODObservationType }
  | { ok: false; reason: string }

/** Resolve an obs_type string; az_el is explicitly rejected for import. */
function resolveObsType(raw: string): ObsTypeResolution {
  const obsType = raw.trim().toLowerCase()
  if (obsType === 'az_el') {
    return {
      ok: false,
      reason:
        "obs_type 'az_el' is not supported for import (batch least-squares and EKF estimate only range, range_rate, and ra_dec)",
    }
  }
  if (IMPORTABLE_OBS_TYPES.has(obsType)) {
    return { ok: true, obsType: obsType as ODObservationType }
  }
  return { ok: false, reason: `unknown obs_type '${raw}' (expected range, range_rate, or ra_dec)` }
}

/** Default sigmas for an observation type from DEFAULT_OBS_CONFIG. */
function defaultSigmasForType(obsType: ODObservationType): number[] {
  switch (obsType) {
    case 'range':
      return [DEFAULT_OBS_CONFIG.sigmaRangeKm]
    case 'range_rate':
      return [DEFAULT_OBS_CONFIG.sigmaRangeRateKms]
    case 'ra_dec':
      return [...DEFAULT_OBS_CONFIG.sigmaAnglesRad]
    case 'az_el':
      return [...DEFAULT_OBS_CONFIG.sigmaAzElRad]
  }
}

type SigmaResolution =
  | { ok: true; sigmas: number[] }
  | { ok: false; reason: string }

/** Validate CSV sigma cells, defaulting from DEFAULT_OBS_CONFIG when absent. */
function resolveCsvSigmas(
  sigma1Raw: string,
  sigma2Raw: string,
  hasSigma1: boolean,
  hasSigma2: boolean,
  obsType: ODObservationType,
  lineNo: number
): SigmaResolution {
  const ndim = OBS_NDIM[obsType]
  if (sigma1Raw === '' && (!hasSigma2 || sigma2Raw === '')) {
    return { ok: true, sigmas: defaultSigmasForType(obsType) }
  }
  const sigma1 = hasSigma1 ? parseFiniteNumber(sigma1Raw) : null
  if (sigma1 === null || sigma1 <= 0) {
    return { ok: false, reason: `line ${lineNo}: sigma1 must be a finite number > 0, got '${sigma1Raw}'` }
  }
  if (ndim === 2) {
    const sigma2 = hasSigma2 ? parseFiniteNumber(sigma2Raw) : null
    if (sigma2 === null || sigma2 <= 0) {
      return { ok: false, reason: `line ${lineNo}: obs_type '${obsType}' requires sigma2 (a finite number > 0), got '${sigma2Raw}'` }
    }
    return { ok: true, sigmas: [sigma1, sigma2] }
  }
  return { ok: true, sigmas: [sigma1] }
}

/** Deduplicate the station defs referenced by the parsed observations. */
function collectReferencedStations(
  observations: ODObservation[],
  lookup: Map<string, ImportedStationDef>
): ImportedStationDef[] {
  const seen = new Set<string>()
  const stations: ImportedStationDef[] = []
  for (const obs of observations) {
    const key = obs.stationId.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const def = lookup.get(key)
    if (def) {
      stations.push(def)
    }
  }
  return stations
}
