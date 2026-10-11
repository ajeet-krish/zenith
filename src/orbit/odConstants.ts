// =============================================================================
// Zenith Web - Orbit Determination Constants and Canonical Stations
// =============================================================================
// Values match the C++ core (wasm/src/zenith/od_constants.hpp,
// wasm/src/zenith/stations.hpp) and helio_ob so golden-master fixtures agree.

import { DEG_TO_RAD, RAD_TO_DEG } from './constants'
import type { ObsConfig } from './types'

// =============================================================================
// Estimator Default Measurement Sigmas
// =============================================================================

/** Default one-sigma range noise [km] (~1 m, radiometric tracking). */
export const SIGMA_RANGE_KM = 1e-3

/** Default one-sigma range-rate noise [km/s] (~0.1 m/s). */
export const SIGMA_RANGE_RATE_KMS = 1e-4

/** Default one-sigma (RA, Dec) noise [rad] (~0.2 arcsec, optical angles). */
export const SIGMA_ANGLES_RAD = 1e-6

/** Default one-sigma (Az, El) noise [rad] (~10 arcsec, radar pointing). */
export const SIGMA_AZ_EL_RAD = 5e-5

/** Default ObsConfig built from the sigma constants above. */
export const DEFAULT_OBS_CONFIG: ObsConfig = {
  sigmaRangeKm: SIGMA_RANGE_KM,
  sigmaRangeRateKms: SIGMA_RANGE_RATE_KMS,
  sigmaAnglesRad: [SIGMA_ANGLES_RAD, SIGMA_ANGLES_RAD],
  sigmaAzElRad: [SIGMA_AZ_EL_RAD, SIGMA_AZ_EL_RAD],
}

// =============================================================================
// Canonical Ground Stations (WGS-84 geodetic, matches C++ make_* helpers)
// =============================================================================

/** Canonical station coordinates in radians and kilometers. */
export interface CanonicalStation {
  name: string
  latRad: number
  lonRad: number
  altKm: number
  latDeg: number
  lonDeg: number
}

/** Goldstone DSN complex (35.4N, 116.8W, about 1.0 km elevation). */
export const GOLDSTONE: CanonicalStation = {
  name: 'goldstone',
  latRad: 35.4 * DEG_TO_RAD,
  lonRad: -116.8 * DEG_TO_RAD,
  altKm: 1.0,
  latDeg: 35.4,
  lonDeg: -116.8,
}

/** Arecibo Observatory (18.3N, 66.75W, about 0.4 km). */
export const ARECIBO: CanonicalStation = {
  name: 'arecibo',
  latRad: 18.3 * DEG_TO_RAD,
  lonRad: -66.75 * DEG_TO_RAD,
  altKm: 0.4,
  latDeg: 18.3,
  lonDeg: -66.75,
}

/** Tromso EISCAT site (69.6N, 18.9E, about 0.1 km). */
export const TROMSOE: CanonicalStation = {
  name: 'tromsoe',
  latRad: 69.6 * DEG_TO_RAD,
  lonRad: 18.9 * DEG_TO_RAD,
  altKm: 0.1,
  latDeg: 69.6,
  lonDeg: 18.9,
}

/** All canonical stations keyed by name. */
export const CANONICAL_STATIONS: Record<string, CanonicalStation> = {
  goldstone: GOLDSTONE,
  arecibo: ARECIBO,
  tromsoe: TROMSOE,
}

/** Look up a canonical station by name (null if unknown). */
export function getCanonicalStation(name: string): CanonicalStation | null {
  return CANONICAL_STATIONS[name] ?? null
}

/** Convert a CanonicalStation's degrees convenience fields to radians. */
export function degToRad(deg: number): number {
  return deg * DEG_TO_RAD
}

/** Convert radians to the degrees convenience representation. */
export function radToDeg(rad: number): number {
  return rad * RAD_TO_DEG
}
