// =============================================================================
// Zenith Web - Batch Least-Squares OD WASM Wrapper
// =============================================================================
// Wraps the od_batch_solve and od_batch_config_defaults embind exports
// (Phase 3). Follows the wasmLoader.ts WASM-first pattern: every call
// degrades gracefully (returns null) when the WASM module is not loaded.
// Flat-array layouts match wasm/src/exports.cpp exactly:
//   od_batch_solve obs table: N concatenated records of
//     [time_jd(1), sta_pos_eci(3), sta_vel_eci(3), obs_type(1), ndim(1),
//      values(ndim), sigmas(ndim)]
//     = 9 header fields + 2*ndim doubles per record
//   od_batch_solve state6:  6 doubles [rx, ry, rz, vx, vy, vz] at epoch_jd
//   od_batch_solve config10: {mu, force_tier, max_iter, tol_pos_km,
//                             tol_vel_kms, tol_wrms_rel, sigma_edit,
//                             edit_max_fraction, edit_max_rounds,
//                             enable_editing (0/1)}
//   od_batch_solve apriori42: {x0(6), cov(36 row-major)}, or null/empty
//   od_batch_solve result:    [state(6), cov(36 row-major), formal_sigmas(6),
//                              iterations(1), converged(1), wrms(1),
//                              reduced_chi2(1; NaN when n_active <= 6),
//                              edited_count(1), n_active(1), status(1),
//                              n_residual_rows(1), residual_rows(N x 14)]
//     header = 56 doubles; each residual row =
//     {time_jd, obs_type, ndim, values(2), computed(2), residual(2),
//      sigma(2), normalized(2), edited (0/1)}
// Station geometry is PRE-RESOLVED by this wrapper via the stations.ts
// exports at each observation epoch (tech-lead decision: the kernel is a
// pure compute kernel with no station handles inside).

import { getWasmModule } from './wasmLoader'
import { stationPositionEci, stationVelocityEci } from './stations'
import { DEFAULT_BATCH_CONFIG } from './odConstants'
import { BATCH_STATUS_MESSAGES } from './types'
import type {
    BatchAPriori,
    BatchResidualRow,
    BatchTsConfig,
    BatchTsResult,
    ODObservation,
    ODObservationType,
} from './types'
import { useODStore } from '@/store/useODStore'

// =============================================================================
// Layout constants (exports.cpp contracts)
// =============================================================================

/** Header fields per observation record (time_jd, pos x3, vel x3, type, ndim). */
export const BATCH_OBS_HEADER_LEN = 9

/** Scalars in the od_batch_solve result header (state, cov, sigmas, diagnostics). */
export const BATCH_RESULT_HEADER_LEN = 56

/** Doubles per residual row in the od_batch_solve result. */
export const BATCH_RESIDUAL_ROW_LEN = 14

/** Observation type -> embind obs_type integer (matches C++ orbit::ObsType). */
const OBS_TYPE_CODE: Record<ODObservationType, number> = {
    range: 0,
    range_rate: 1,
    ra_dec: 2,
    az_el: 3,
}

/** Scalar components per observation type (matches C++ orbit::obs_ndim). */
const OBS_TYPE_NDIM: Record<ODObservationType, number> = {
    range: 1,
    range_rate: 1,
    ra_dec: 2,
    az_el: 2,
}

/** obs_type integer -> observation type name (inverse of OBS_TYPE_CODE). */
const OBS_TYPE_NAME: Record<number, ODObservationType> = {
    0: 'range',
    1: 'range_rate',
    2: 'ra_dec',
    3: 'az_el',
}

// =============================================================================
// Station handle resolution (same pattern as iodGauss.ts)
// =============================================================================

/**
 * Resolve an observation stationId to a WASM station handle.
 *
 * Accepts a useODStore station id ('sta-N') or a raw handle as a numeric
 * string (e.g. '42'). The store is read lazily via getState() at call time
 * so the store -> orbit -> store import cycle never dereferences an
 * uninitialized binding.
 */
function resolve_station_handle(station_id: string): number | null {
    if (/^\d+$/.test(station_id)) {
        return Number(station_id)
    }
    const station = useODStore.getState().stations.find((s) => s.id === station_id)
    return station?.handle ?? null
}

// =============================================================================
// Flat-array packing / unpacking (exported for unit tests)
// =============================================================================

/** One observation with station geometry pre-resolved at its epoch. */
export interface BatchObservationInput {
    /** Observation epoch [Julian Date, days]. */
    timeJd: number
    /** Station position in ECI at timeJd [km]. */
    staPosEci: { x: number; y: number; z: number }
    /** Station velocity in ECI at timeJd [km/s]. */
    staVelEci: { x: number; y: number; z: number }
    /** Source observation type. */
    obsType: ODObservationType
    /** Measured values (length matches the type's ndim). */
    values: number[]
    /** One-sigma uncertainties (must be > 0; length matches ndim). */
    sigmas: number[]
}

/**
 * Pack pre-resolved observations into the exports.cpp obs table:
 * N concatenated records of [time_jd, sta_pos x3, sta_vel x3, obs_type,
 * ndim, values(ndim), sigmas(ndim)] = 9 header + 2*ndim doubles each.
 * Callers are expected to validate values/sigmas lengths beforehand.
 */
export function packBatchObsTable(records: BatchObservationInput[]): number[] {
    const flat: number[] = []
    for (const record of records) {
        const ndim = OBS_TYPE_NDIM[record.obsType]
        flat.push(
            record.timeJd,
            record.staPosEci.x,
            record.staPosEci.y,
            record.staPosEci.z,
            record.staVelEci.x,
            record.staVelEci.y,
            record.staVelEci.z,
            OBS_TYPE_CODE[record.obsType],
            ndim
        )
        for (let k = 0; k < ndim; ++k) flat.push(record.values[k] ?? 0)
        for (let k = 0; k < ndim; ++k) flat.push(record.sigmas[k] ?? 0)
    }
    return flat
}

/** Pack a config into the exports.cpp config10 array (10 doubles). */
export function packBatchConfig(cfg: BatchTsConfig): number[] {
    return [
        cfg.mu,
        cfg.forceTier,
        cfg.maxIter,
        cfg.tolPosKm,
        cfg.tolVelKms,
        cfg.tolWrmsRel,
        cfg.sigmaEdit,
        cfg.editMaxFraction,
        cfg.editMaxRounds,
        cfg.enableEditing ? 1 : 0,
    ]
}

/** Pack an a-priori constraint into the exports.cpp apriori42 array. */
export function packBatchAPriori(ap: BatchAPriori): number[] {
    return [...ap.x0, ...ap.cov]
}

/** Unpack the exports.cpp config10 array into a typed config. */
function config_from_flat(flat: ArrayLike<number>): BatchTsConfig {
    return {
        mu: flat[0] ?? DEFAULT_BATCH_CONFIG.mu,
        forceTier: flat[1] ?? DEFAULT_BATCH_CONFIG.forceTier,
        maxIter: flat[2] ?? DEFAULT_BATCH_CONFIG.maxIter,
        tolPosKm: flat[3] ?? DEFAULT_BATCH_CONFIG.tolPosKm,
        tolVelKms: flat[4] ?? DEFAULT_BATCH_CONFIG.tolVelKms,
        tolWrmsRel: flat[5] ?? DEFAULT_BATCH_CONFIG.tolWrmsRel,
        sigmaEdit: flat[6] ?? DEFAULT_BATCH_CONFIG.sigmaEdit,
        editMaxFraction: flat[7] ?? DEFAULT_BATCH_CONFIG.editMaxFraction,
        editMaxRounds: flat[8] ?? DEFAULT_BATCH_CONFIG.editMaxRounds,
        enableEditing:
            (flat[9] ?? (DEFAULT_BATCH_CONFIG.enableEditing ? 1 : 0)) !== 0,
    }
}

/**
 * Unpack one 14-double residual row starting at offset.
 *
 * The kernel emits one row per SCALAR row: a ra_dec observation yields two
 * consecutive rows (RA then Dec), each carrying the full 2-vectors; the
 * scalar component for that row is [0].
 */
function residual_row_from_flat(
    flat: ArrayLike<number>,
    offset: number
): BatchResidualRow {
    const obs_type_code = Math.round(flat[offset + 1] ?? 0)
    const ndim = Math.round(flat[offset + 2] ?? 1)
    const value: number[] = [flat[offset + 3] ?? 0]
    const predicted: number[] = [flat[offset + 5] ?? 0]
    const residual: number[] = [flat[offset + 7] ?? 0]
    const sigma: number[] = [flat[offset + 9] ?? 0]
    const normalized: number[] = [flat[offset + 11] ?? 0]
    if (ndim === 2) {
        value.push(flat[offset + 4] ?? 0)
        predicted.push(flat[offset + 6] ?? 0)
        residual.push(flat[offset + 8] ?? 0)
        sigma.push(flat[offset + 10] ?? 0)
        normalized.push(flat[offset + 12] ?? 0)
    }
    return {
        timeJd: flat[offset] ?? 0,
        obsType: OBS_TYPE_NAME[obs_type_code] ?? 'range',
        value,
        predicted,
        residual,
        sigma,
        normalized,
        edited: (flat[offset + 13] ?? 0) !== 0,
    }
}

/**
 * Unpack the exports.cpp od_batch_solve flat result into a typed result.
 * Returns null when the array is missing or shorter than the 56-double
 * header (malformed input from the WASM boundary).
 */
export function unpackBatchResult(
    flat: ArrayLike<number> | null | undefined
): BatchTsResult | null {
    if (!flat || flat.length < BATCH_RESULT_HEADER_LEN) return null

    const state: number[] = []
    for (let i = 0; i < 6; ++i) state.push(flat[i] ?? 0)
    const covariance: number[] = []
    for (let i = 0; i < 36; ++i) covariance.push(flat[6 + i] ?? 0)
    const formalSigmas: number[] = []
    for (let i = 0; i < 6; ++i) formalSigmas.push(flat[42 + i] ?? 0)

    const status = Math.round(flat[54] ?? 0)
    const n_residual_rows = Math.round(flat[55] ?? 0)
    const residuals: BatchResidualRow[] = []
    for (let r = 0; r < n_residual_rows; ++r) {
        const offset = BATCH_RESULT_HEADER_LEN + r * BATCH_RESIDUAL_ROW_LEN
        if (offset + BATCH_RESIDUAL_ROW_LEN > flat.length) break
        residuals.push(residual_row_from_flat(flat, offset))
    }

    const reduced_chi2 = flat[51] ?? 0
    return {
        state,
        covariance,
        formalSigmas,
        iterations: flat[48] ?? 0,
        converged: (flat[49] ?? 0) !== 0,
        wrms: flat[50] ?? 0,
        reducedChi2: Number.isNaN(reduced_chi2) ? null : reduced_chi2,
        editedCount: flat[52] ?? 0,
        nActive: flat[53] ?? 0,
        errorStatus: status,
        statusMessage:
            BATCH_STATUS_MESSAGES[status] ?? 'Unknown batch OD status',
        residuals,
    }
}

// =============================================================================
// Config defaults (WASM-first)
// =============================================================================

/**
 * Default batch solver configuration.
 *
 * Prefers the live WASM od_batch_config_defaults export (single source of
 * truth with the kernel) and falls back to DEFAULT_BATCH_CONFIG when WASM
 * is not loaded.
 */
export function getBatchConfigDefaults(): BatchTsConfig {
    const mod = getWasmModule()
    if (mod && typeof mod.od_batch_config_defaults === 'function') {
        try {
            const flat = mod.od_batch_config_defaults()
            if (flat && flat.length >= 10) return config_from_flat(flat)
        } catch (e) {
            console.warn('od_batch_config_defaults failed:', e)
        }
    }
    return { ...DEFAULT_BATCH_CONFIG }
}

// =============================================================================
// Batch LSQ solve (WASM-only; no TS fallback)
// =============================================================================

/** Input to runBatchSolve. */
export interface BatchSolveInput {
    /** Observations in the useODStore format (stationId resolved to geometry). */
    observations: ODObservation[]
    /** ECI state guess at epochJd [km, km/s] (exactly 6 values). */
    stateGuess: number[]
    /** Estimation epoch [Julian Date, days]; the guess must be here. */
    epochJd: number
    /** Partial config merged over getBatchConfigDefaults(). */
    config?: Partial<BatchTsConfig>
    /** Optional Bayesian a-priori constraint; omit for a pure batch. */
    apriori?: BatchAPriori | null
}

/**
 * Run batch least-squares orbit determination on pre-generated observations.
 *
 * Resolves every observation's station to ECI position/velocity at its
 * epoch via the stations.ts exports (WASM with TS fallback), packs the
 * exports.cpp flat arrays, and calls the od_batch_solve kernel. Returns
 * null when WASM is not ready, a station cannot be resolved, an input is
 * malformed, or the WASM call fails. Solver-level problems (empty arc,
 * AZ_EL rows, singular normal equations) come back as a typed result with
 * a non-OK errorStatus instead of null.
 */
export function runBatchSolve(input: BatchSolveInput): BatchTsResult | null {
    const mod = getWasmModule()
    if (!mod || typeof mod.od_batch_solve !== 'function') return null

    const { observations, stateGuess, epochJd } = input
    if (stateGuess.length !== 6) return null

    // Resolve station ECI geometry at each observation epoch and pack the
    // obs table (9 header + 2*ndim doubles per record).
    const records: BatchObservationInput[] = []
    for (const obs of observations) {
        const ndim = OBS_TYPE_NDIM[obs.obsType]
        if (obs.values.length < ndim || obs.sigmas.length < ndim) return null
        const handle = resolve_station_handle(obs.stationId)
        if (handle == null) return null
        const pos = stationPositionEci(handle, obs.timeJd)
        const vel = stationVelocityEci(handle, obs.timeJd)
        if (!pos || !vel) return null
        records.push({
            timeJd: obs.timeJd,
            staPosEci: pos,
            staVelEci: vel,
            obsType: obs.obsType,
            values: obs.values.slice(0, ndim),
            sigmas: obs.sigmas.slice(0, ndim),
        })
    }
    const obs_flat = packBatchObsTable(records)

    const cfg = { ...DEFAULT_BATCH_CONFIG, ...input.config }
    const config10 = packBatchConfig(cfg)

    let apriori42: number[] | null = null
    if (input.apriori) {
        if (input.apriori.x0.length !== 6 || input.apriori.cov.length !== 36) {
            return null
        }
        apriori42 = packBatchAPriori(input.apriori)
    }

    try {
        const flat = mod.od_batch_solve(
            obs_flat,
            [...stateGuess],
            epochJd,
            config10,
            apriori42
        )
        return unpackBatchResult(flat)
    } catch (e) {
        console.warn('od_batch_solve failed:', e)
        return null
    }
}
