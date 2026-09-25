/**
 * Analysis module loader - WASM/TypeScript fallback pattern for analysis functions.
 * Mirrors the wasmLoader.ts pattern.
 */

import { MU_EARTH, R_EARTH, DEG_TO_RAD, JD_J2000 } from './constants'
import type { HohmannResult, GroundTrackPoint, MonteCarloConfig, MonteCarloResult, WalkerDeltaConfig } from './types'

// Module-level state
let wasmModule: any = null

/**
 * Set the WASM module reference (called from wasmLoader after init).
 */
export function setWasmModule(mod: any): void {
  wasmModule = mod
}

// =============================================================================
// Hohmann Transfer (TS fallback available)
// =============================================================================

/**
 * Compute Hohmann transfer from altitudes. Tries WASM first, falls back to TS.
 */
export function hohmannFromAltitudes(alt1Km: number, alt2Km: number): HohmannResult | null {
  // Try WASM first
  if (wasmModule) {
    try {
      const r = wasmModule.hohmann_from_altitudes(alt1Km, alt2Km)
      return {
        dv1: r.dv1,
        dv2: r.dv2,
        dvTotal: r.dv_total,
        transferTimeS: r.transfer_time_s,
        aTransfer: r.a_transfer,
      }
    } catch (e) {
      console.warn('WASM hohmann_from_altitudes failed, trying TS fallback:', e)
    }
  }

  // TS fallback
  return hohmannFromAltitudesTS(alt1Km, alt2Km)
}

/**
 * TypeScript fallback for Hohmann transfer.
 */
function hohmannFromAltitudesTS(alt1Km: number, alt2Km: number): HohmannResult {
  const r1 = R_EARTH + alt1Km
  const r2 = R_EARTH + alt2Km

  if (Math.abs(r2 - r1) < 1e-10) {
    return { dv1: 0, dv2: 0, dvTotal: 0, transferTimeS: 0, aTransfer: r1 }
  }

  const aT = (r1 + r2) / 2
  const v1Circ = Math.sqrt(MU_EARTH / r1)
  const v2Circ = Math.sqrt(MU_EARTH / r2)
  const v1Transfer = Math.sqrt(MU_EARTH * (2 / r1 - 1 / aT))
  const v2Transfer = Math.sqrt(MU_EARTH * (2 / r2 - 1 / aT))

  const dv1 = Math.abs(v1Transfer - v1Circ)
  const dv2 = Math.abs(v2Circ - v2Transfer)

  return {
    dv1,
    dv2,
    dvTotal: dv1 + dv2,
    transferTimeS: Math.PI * Math.sqrt(aT * aT * aT / MU_EARTH),
    aTransfer: aT,
  }
}

// =============================================================================
// Bi-Elliptic Transfer
// =============================================================================

export interface BiellipticResult {
  dv1: number
  dv2: number
  dvTotal: number
  transferTimeS: number
  aTransfer: number
}

/**
 * Compute bi-elliptic transfer. WASM only (no TS fallback for 3-burn).
 */
export function biellipticTransfer(
  r1Km: number,
  r2Km: number,
  rIntermediateKm: number
): BiellipticResult | null {
  if (wasmModule) {
    try {
      const r = wasmModule.bielliptic_transfer(r1Km, r2Km, rIntermediateKm)
      return {
        dv1: r.dv1,
        dv2: r.dv2,
        dvTotal: r.dv_total,
        transferTimeS: r.transfer_time_s,
        aTransfer: r.a_transfer,
      }
    } catch (e) {
      console.warn('WASM bielliptic_transfer failed:', e)
    }
  }
  return null
}

// =============================================================================
// Ground Track
// =============================================================================

/**
 * TypeScript fallback for ground track computation.
 * Converts ECI (TEME) positions to geodetic lat/lon using simple spherical Earth.
 */
function computeGroundTrackTS(flatTrajectory: number[]): GroundTrackPoint[] {
  const points: GroundTrackPoint[] = []
  const R_EARTH_KM = R_EARTH

  for (let i = 0; i < flatTrajectory.length; i += 7) {
    const x = flatTrajectory[i]!
    const y = flatTrajectory[i + 1]!
    const z = flatTrajectory[i + 2]!
    const jd = flatTrajectory[i + 6]!

    // Compute longitude rotation (TEME to ECEF approximate)
    const t_ut1_days = jd - JD_J2000
    const gmst = ((280.46061837 + 360.98564736629 * t_ut1_days) % 360) * Math.PI / 180

    // Latitude from z and radius
    const r = Math.sqrt(x * x + y * y + z * z)
    const lat = Math.asin(z / r)

    // Longitude from x, y with GMST rotation
    const lon = Math.atan2(y, x) - gmst

    // Normalize longitude to [-PI, PI]
    const lonNorm = ((lon % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI

    const alt = r - R_EARTH_KM

    points.push({
      lat,
      lon: lonNorm,
      alt,
      jd,
    })
  }

  return points
}

/**
 * Compute ground track from trajectory data. Tries WASM first, falls back to TS.
 */
export function computeGroundTrack(flatTrajectory: number[]): GroundTrackPoint[] | null {
  // Try WASM first
  if (wasmModule) {
    try {
      const flat = wasmModule.compute_ground_track(flatTrajectory)
      const points: GroundTrackPoint[] = []
      for (let i = 0; i < flat.length; i += 4) {
        points.push({
          lat: flat[i],
          lon: flat[i + 1],
          alt: flat[i + 2],
          jd: flat[i + 3],
        })
      }
      return points
    } catch (e) {
      console.warn('WASM compute_ground_track failed, using TS fallback:', e)
    }
  }

  // TS fallback
  return computeGroundTrackTS(flatTrajectory)
}

// =============================================================================
// Monte Carlo
// =============================================================================

/**
 * Run Monte Carlo propagation. WASM only (too complex for TS fallback).
 */
export function mcPropagate(
  px: number, py: number, pz: number,
  vx: number, vy: number, vz: number,
  epochJd: number,
  config: MonteCarloConfig
): MonteCarloResult | null {
  if (wasmModule) {
    try {
      return wasmModule.mc_propagate(
        px, py, pz, vx, vy, vz, epochJd,
        config.nSamples, config.endTimeDays,
        config.positionStddevKm, config.velocityStddevKmS,
        config.seed
      )
    } catch (e) {
      console.warn('WASM mc_propagate failed:', e)
    }
  }
  return null
}

// =============================================================================
// Walker Constellation
// =============================================================================

export interface WalkerState {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  jd: number
}

/**
 * TypeScript fallback for Walker Delta constellation generation.
 * Generates evenly distributed satellites in circular orbits.
 */
function generateWalkerTS(config: WalkerDeltaConfig, jdEpoch: number): WalkerState[] {
  const a = R_EARTH + config.altitudeKm
  const inc = config.inclinationDeg * Math.PI / 180

  const states: WalkerState[] = []
  const satsPerPlane = Math.floor(config.totalSats / config.numPlanes)
  const deltaRaann = (2 * Math.PI) / config.numPlanes
  const deltaMA = (2 * Math.PI * config.phasingFactor) / config.totalSats

  for (let p = 0; p < config.numPlanes; p++) {
    const raan = p * deltaRaann

    for (let j = 0; j < satsPerPlane; j++) {
      const ma = (2 * Math.PI * j) / satsPerPlane + p * deltaMA

      // Convert Keplerian elements to ECI state for circular orbit
      const cosInc = Math.cos(inc)
      const sinInc = Math.sin(inc)
      const cosRaan = Math.cos(raan)
      const sinRaan = Math.sin(raan)
      const cosMa = Math.cos(ma)
      const sinMa = Math.sin(ma)

      // Position in orbital plane
      const xOrb = a * cosMa
      const yOrb = a * sinMa

      // Rotate to ECI
      const x = cosRaan * xOrb - sinRaan * cosInc * yOrb
      const y = sinRaan * xOrb + cosRaan * cosInc * yOrb
      const z = sinInc * yOrb

      // Velocity in orbital plane (circular orbit)
      const v = Math.sqrt(MU_EARTH / a)
      const vxOrb = -v * sinMa
      const vyOrb = v * cosMa

      // Rotate velocity to ECI
      const vx = cosRaan * vxOrb - sinRaan * cosInc * vyOrb
      const vy = sinRaan * vxOrb + cosRaan * cosInc * vyOrb
      const vz = sinInc * vyOrb

      states.push({ x, y, z, vx, vy, vz, jd: jdEpoch })
    }
  }

  return states
}

/**
 * Generate Walker Delta constellation. Tries WASM first, falls back to TS.
 */
export function generateWalker(
  config: WalkerDeltaConfig,
  jdEpoch: number
): WalkerState[] | null {
  // Try WASM first
  if (wasmModule) {
    try {
      return wasmModule.generate_walker(
        config.inclinationDeg * DEG_TO_RAD,
        config.totalSats,
        config.numPlanes,
        config.phasingFactor,
        config.altitudeKm,
        jdEpoch
      )
    } catch (e) {
      console.warn('WASM generate_walker failed, using TS fallback:', e)
    }
  }

  // TS fallback
  return generateWalkerTS(config, jdEpoch)
}
