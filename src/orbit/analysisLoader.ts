/**
 * Analysis module loader - WASM/TypeScript fallback pattern for analysis functions.
 * Mirrors the wasmLoader.ts pattern.
 */

import { MU_EARTH, R_EARTH, DEG_TO_RAD } from './constants'

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

export interface HohmannResult {
  dv1: number
  dv2: number
  dvTotal: number
  transferTimeS: number
  aTransfer: number
}

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

export interface GroundTrackPoint {
  lat: number
  lon: number
  alt: number
  jd: number
}

/**
 * Compute ground track from trajectory data. WASM only.
 */
export function computeGroundTrack(flatTrajectory: number[]): GroundTrackPoint[] | null {
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
      console.warn('WASM compute_ground_track failed:', e)
    }
  }
  return null
}

// =============================================================================
// Monte Carlo
// =============================================================================

export interface MonteCarloConfig {
  nSamples: number
  endTimeDays: number
  positionStddevKm: number
  velocityStddevKmS: number
  seed: number
}

export interface MonteCarloResult {
  mean: { x: number; y: number; z: number; vx: number; vy: number; vz: number }
  positionStddev: number[]
  velocityStddev: number[]
  samples: Array<{ x: number; y: number; z: number }>
}

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

export interface WalkerDeltaConfig {
  inclinationDeg: number
  totalSats: number
  numPlanes: number
  phasingFactor: number
  altitudeKm: number
}

export interface WalkerState {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  jd: number
}

/**
 * Generate Walker Delta constellation. WASM only.
 */
export function generateWalker(
  config: WalkerDeltaConfig,
  jdEpoch: number
): WalkerState[] | null {
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
      console.warn('WASM generate_walker failed:', e)
    }
  }
  return null
}
