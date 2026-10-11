// =============================================================================
// Zenith Web - OD Observation WASM Wrappers + TS Simulator
// =============================================================================
// Wraps the od_predict_observation and od_measurement_partials embind
// exports, plus a deterministic TS-side observation simulator (seeded
// mulberry32 PRNG + Box-Muller Gaussian noise) since C++ generation is not
// exported for the browser yet.

import { getWasmModule } from './wasmLoader'
import { SIGMA_ANGLES_RAD, SIGMA_AZ_EL_RAD, SIGMA_RANGE_KM, SIGMA_RANGE_RATE_KMS } from './odConstants'
import type { MeasurementPartials, ODObservation, ODObservationType, ObsPrediction } from './types'

/** Observation type -> embind obs_type integer (matches C++ orbit::ObsType). */
const OBS_TYPE_CODE: Record<ODObservationType, number> = {
    range: 0,
    range_rate: 1,
    ra_dec: 2,
    az_el: 3,
}

// =============================================================================
// Deterministic PRNG (mulberry32) + Box-Muller Gaussian
// =============================================================================

/**
 * mulberry32: small, fast, deterministic PRNG. Returns a function yielding
 * uniform doubles in [0, 1).
 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return function () {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** Standard normal draw via Box-Muller transform from a uniform PRNG. */
export function box_muller_gaussian(rand: () => number): number {
    // Guard against log(0).
    let u1 = rand()
    if (u1 <= 0) u1 = Number.MIN_VALUE
    const u2 = rand()
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)
}

// =============================================================================
// Prediction and Partials (WASM-only; no TS fallback)
// =============================================================================

/**
 * Predict noise-free observables for an ECI state from a station handle.
 * Returns all six components or null when WASM is unavailable.
 */
export function predictObservation(
    station_h: number,
    r: { x: number; y: number; z: number },
    v: { x: number; y: number; z: number },
    jd: number
): ObsPrediction | null {
    const mod = getWasmModule()
    if (!mod) return null
    try {
        const flat = mod.od_predict_observation(station_h, r.x, r.y, r.z, v.x, v.y, v.z, jd)
        if (!flat || flat.length < 6) return null
        return {
            rangeKm: flat[0],
            rangeRateKms: flat[1],
            raRad: flat[2],
            decRad: flat[3],
            azRad: flat[4],
            elRad: flat[5],
        }
    } catch (e) {
        console.warn('od_predict_observation failed:', e)
        return null
    }
}

/**
 * Analytic measurement partials H = dh/d(r, v) for all supported types.
 * Each row is 6 columns (position then velocity), row-major.
 * Returns null when WASM is unavailable or geometry is singular.
 */
export function measurementPartials(
    station_h: number,
    r: { x: number; y: number; z: number },
    v: { x: number; y: number; z: number },
    jd: number
): MeasurementPartials | null {
    const mod = getWasmModule()
    if (!mod) return null
    try {
        const range = mod.od_measurement_partials(station_h, OBS_TYPE_CODE.range, r.x, r.y, r.z, v.x, v.y, v.z, jd)
        const range_rate = mod.od_measurement_partials(station_h, OBS_TYPE_CODE.range_rate, r.x, r.y, r.z, v.x, v.y, v.z, jd)
        const ra_dec = mod.od_measurement_partials(station_h, OBS_TYPE_CODE.ra_dec, r.x, r.y, r.z, v.x, v.y, v.z, jd)
        if (!range || !range_rate || !ra_dec || ra_dec.length < 13) return null
        const nrows = ra_dec[0] as number
        if (nrows < 2) return null
        return {
            rangeH: range.slice(1, 7),
            rangeRateH: range_rate.slice(1, 7),
            raH: ra_dec.slice(1, 7),
            decH: ra_dec.slice(7, 13),
        }
    } catch (e) {
        console.warn('od_measurement_partials failed:', e)
        return null
    }
}

// =============================================================================
// TS-side Observation Simulator
// =============================================================================

/** One truth state (ECI, km and km/s) with its epoch. */
export interface TruthState {
    jd: number
    r: { x: number; y: number; z: number }
    v: { x: number; y: number; z: number }
}

export interface SimulateOptions {
    /** Multiplier on the default measurement sigmas (0 = noise-free truth). */
    noiseScale: number
    /** mulberry32 seed for deterministic noise. */
    seed: number
    /** Station id stamped onto returned observations (default ''). */
    stationId?: string
    /** Observation types to emit (default: all four). */
    obsTypes?: ODObservationType[]
}

/** Default sigmas for one observation type, scaled by noiseScale. */
function sigmas_for(obs_type: ODObservationType, noise_scale: number): number[] {
    switch (obs_type) {
        case 'range':
            return [SIGMA_RANGE_KM * noise_scale]
        case 'range_rate':
            return [SIGMA_RANGE_RATE_KMS * noise_scale]
        case 'ra_dec':
            return [SIGMA_ANGLES_RAD * noise_scale, SIGMA_ANGLES_RAD * noise_scale]
        case 'az_el':
            return [SIGMA_AZ_EL_RAD * noise_scale, SIGMA_AZ_EL_RAD * noise_scale]
    }
}

/** Extract measured values for one observation type from a prediction. */
function values_for(pred: ObsPrediction, obs_type: ODObservationType): number[] {
    switch (obs_type) {
        case 'range':
            return [pred.rangeKm]
        case 'range_rate':
            return [pred.rangeRateKms]
        case 'ra_dec':
            return [pred.raRad, pred.decRad]
        case 'az_el':
            return [pred.azRad, pred.elRad]
    }
}

/**
 * Simulate noisy observations of truth states from one station.
 * Calls the WASM predictObservation per epoch and adds seeded Gaussian
 * noise (mulberry32 + Box-Muller) scaled by each type's default sigma.
 * Deterministic: same seed gives bit-identical results.
 * Returns null if prediction fails for any epoch.
 */
export function simulateObservations(
    station_h: number,
    truth_states: TruthState[],
    options: SimulateOptions
): ODObservation[] | null {
    const obs_types = options.obsTypes ?? (Object.keys(OBS_TYPE_CODE) as ODObservationType[])
    const rand = mulberry32(options.seed)
    const station_id = options.stationId ?? ''
    const out: ODObservation[] = []

    for (const state of truth_states) {
        const pred = predictObservation(station_h, state.r, state.v, state.jd)
        if (!pred) return null
        for (const obs_type of obs_types) {
            const truth = values_for(pred, obs_type)
            const sigmas = sigmas_for(obs_type, options.noiseScale)
            const values = truth.map((t, i) => t + sigmas[i]! * box_muller_gaussian(rand))
            out.push({
                timeJd: state.jd,
                stationId: station_id,
                obsType: obs_type,
                values,
                sigmas,
            })
        }
    }
    return out
}
