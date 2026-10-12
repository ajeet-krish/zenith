// =============================================================================
// Zenith Web - Sequential EKF OD WASM Wrapper
// =============================================================================
// Wraps the od_ekf_solve and od_ekf_config_defaults embind exports
// (Phase 4). Follows the wasmLoader.ts WASM-first pattern: every call
// degrades gracefully (returns null) when the WASM module is not loaded.
// Flat-array layouts match wasm/src/exports.cpp exactly:
//   od_ekf_solve obs table: same Phase 3 SoA record layout as
//     od_batch_solve ([time_jd, sta_pos x3, sta_vel x3, obs_type, ndim,
//     values(ndim), sigmas(ndim)] per record; 9 + 2*ndim doubles).
//     obs_type: 0=RANGE, 1=RANGE_RATE, 2=RA_DEC (3=AZ_EL rejected).
//   od_ekf_solve state6:  6 doubles [rx, ry, rz, vx, vy, vz] at epoch_jd
//   od_ekf_solve config16: {q_a, q_a_maneuver, estimate_maneuver (0/1),
//     nis_sigma_threshold, consecutive_exceedances, reentry_window_obs,
//     scheduled_inflate_kms, sustained_nis_count, inflate_factor,
//     p0_diag(6), force_tier}
//   od_ekf_solve burns: 4*n_burns doubles {epoch_jd, dv(3)} per scheduled
//     burn (ascending epochs; null/empty for none)
//   od_ekf_solve result: flat array
//     Header (60 doubles):
//       [0] error, [1] n_obs, [2] n_rows, [3] n_updated, [4] n_gated,
//       [5] divergence_flag, [6] n_recoveries, [7] augmented_active_final,
//       [8] nis_mean, [9] nis_max, [10] n_nis_exceed, [11] n_maneuvers,
//       [12..17] final_state(6), [18..23] final_cov_diag(6),
//       [24..59] final_cov(36 row-major).
//     Payload (SoA, present whenever the obs table parsed; N = n_obs):
//       obs_times(N), obs_types(N), maneuver_flag(N), state_hist(N*6),
//       sigma_hist(N*6), innovations(2*N PADDED: NaN in the second slot of
//       scalar observations), nis(2*N padded), updated_mask(2*N),
//       maneuver_records(n_maneuvers * 4 {epoch_jd, dv(3)}).
//     Malformed / oversized obs tables return the 60-double header only
//     (status at [0]).
// Station geometry is PRE-RESOLVED by this wrapper via the shared
// odBatch.ts helper (the kernel is a pure compute kernel with no station
// handles inside).

import { getWasmModule } from './wasmLoader'
import { DEFAULT_EKF_CONFIG } from './odConstants'
import { EKF_STATUS_MESSAGES } from './types'
import {
    OBS_TYPE_NAME,
    packBatchObsTable,
    resolveBatchObservationInputs,
    type BatchObservationInput,
} from './odBatch'
import type {
    EkfStepRow,
    EkfTsConfig,
    EkfTsResult,
    ManeuverConfigTs,
    ManeuverRecordTs,
    ODObservation,
    ProcessNoiseConfigTs,
    RecoveryConfigTs,
    ScheduledManeuver,
} from './types'

// =============================================================================
// Layout constants (exports.cpp contracts)
// =============================================================================

/** Doubles in the od_ekf_solve config array. */
export const EKF_CONFIG_LEN = 16

/** Scalars in the od_ekf_solve result header (diagnostics + final state/cov). */
export const EKF_RESULT_HEADER_LEN = 60

/** Doubles per scheduled burn in the burns array ({epoch_jd, dv(3)}). */
export const EKF_BURN_LEN = 4

/** Doubles per observation step in the result payload (SoA total per step). */
export const EKF_STEP_LEN = 21

// =============================================================================
// Config packing / unpacking (exported for unit tests)
// =============================================================================

/**
 * Deep-partial EKF config accepted by mergeEkfConfig / runEkfSolve.
 * Sub-configs are Partial<> because mergeEkfConfig deep-merges them over
 * the defaults; the shallow Partial<EkfTsConfig> would force callers to
 * repeat every field of a sub-config just to override one.
 */
export interface EkfPartialConfig {
    /** Process noise overrides (merged field-by-field). */
    process?: Partial<ProcessNoiseConfigTs>
    /** Maneuver detection / estimation overrides (merged field-by-field). */
    maneuver?: Partial<ManeuverConfigTs>
    /** Divergence recovery overrides (merged field-by-field). */
    recovery?: Partial<RecoveryConfigTs>
    /** Initial covariance diagonal; short arrays are padded with defaults. */
    p0Diag?: number[]
    /** Force model tier: 0 = two-body, 1 = J2. */
    forceTier?: number
}

/**
 * Deep-merge a partial config over the defaults, normalizing p0Diag to
 * exactly 6 values (defaults fill any gap). Exported so the EkfPanel can
 * build a full config from user edits without duplicating the structure.
 */
export function mergeEkfConfig(partial?: EkfPartialConfig): EkfTsConfig {
    const base = DEFAULT_EKF_CONFIG
    const p0 = [...base.p0Diag]
    if (partial?.p0Diag) {
        for (let i = 0; i < 6 && i < partial.p0Diag.length; ++i) {
            p0[i] = partial.p0Diag[i]!
        }
    }
    return {
        process: { ...base.process, ...partial?.process },
        maneuver: { ...base.maneuver, ...partial?.maneuver },
        recovery: { ...base.recovery, ...partial?.recovery },
        p0Diag: p0,
        forceTier: partial?.forceTier ?? base.forceTier,
    }
}

/**
 * Pack a config into the exports.cpp config16 array (16 doubles):
 * {q_a, q_a_maneuver, estimate_maneuver (0/1), nis_sigma_threshold,
 *  consecutive_exceedances, reentry_window_obs, scheduled_inflate_kms,
 *  sustained_nis_count, inflate_factor, p0_diag(6), force_tier}.
 */
export function packEkfConfig(cfg: EkfTsConfig): number[] {
    const flat: number[] = [
        cfg.process.qA,
        cfg.process.qAManeuver,
        cfg.maneuver.estimateManeuver ? 1 : 0,
        cfg.maneuver.nisSigmaThreshold,
        cfg.maneuver.consecutiveExceedances,
        cfg.maneuver.reentryWindowObs,
        cfg.maneuver.scheduledInflateKms,
        cfg.recovery.sustainedNisCount,
        cfg.recovery.inflateFactor,
    ]
    for (let i = 0; i < 6; ++i) flat.push(cfg.p0Diag[i] ?? 0)
    flat.push(cfg.forceTier)
    return flat
}

/** Unpack the exports.cpp config16 array into a typed config (short arrays apply partially over defaults). */
function config_from_flat(flat: ArrayLike<number>): EkfTsConfig {
    return mergeEkfConfig({
        process: {
            qA: flat[0] ?? DEFAULT_EKF_CONFIG.process.qA,
            qAManeuver: flat[1] ?? DEFAULT_EKF_CONFIG.process.qAManeuver,
        },
        maneuver: {
            estimateManeuver: (flat[2] ?? 0) !== 0,
            nisSigmaThreshold:
                flat[3] ?? DEFAULT_EKF_CONFIG.maneuver.nisSigmaThreshold,
            consecutiveExceedances:
                flat[4] ?? DEFAULT_EKF_CONFIG.maneuver.consecutiveExceedances,
            reentryWindowObs:
                flat[5] ?? DEFAULT_EKF_CONFIG.maneuver.reentryWindowObs,
            scheduledInflateKms:
                flat[6] ?? DEFAULT_EKF_CONFIG.maneuver.scheduledInflateKms,
        },
        recovery: {
            sustainedNisCount:
                flat[7] ?? DEFAULT_EKF_CONFIG.recovery.sustainedNisCount,
            inflateFactor: flat[8] ?? DEFAULT_EKF_CONFIG.recovery.inflateFactor,
        },
        p0Diag: Array.from({ length: 6 }, (_, i) => flat[9 + i] ?? DEFAULT_EKF_CONFIG.p0Diag[i]!),
        forceTier: flat[15] ?? DEFAULT_EKF_CONFIG.forceTier,
    })
}

/** Pack scheduled burns into the exports.cpp burns array (4 doubles per burn). */
export function packScheduledBurns(
    burns: ScheduledManeuver[] | null | undefined
): number[] {
    const flat: number[] = []
    if (!burns) return flat
    for (const burn of burns) {
        flat.push(burn.epochJd, burn.dv[0], burn.dv[1], burn.dv[2])
    }
    return flat
}

// =============================================================================
// Result unpacking (exported for unit tests)
// =============================================================================

/** Map a NaN-padded scalar slot to a number or null. */
function nan_to_null(v: number | undefined): number | null {
    return v == null || Number.isNaN(v) ? null : v
}

/**
 * Unpack the exports.cpp od_ekf_solve flat result into a typed result.
 * Returns null when the array is missing or shorter than the 60-double
 * header (malformed input from the WASM boundary). NaN-padded NIS and
 * innovation slots of scalar observations become null; step rows beyond
 * the actual array length are dropped.
 */
export function unpackEkfResult(
    flat: ArrayLike<number> | null | undefined
): EkfTsResult | null {
    if (!flat || flat.length < EKF_RESULT_HEADER_LEN) return null

    // Normal results and the exports.cpp od_ekf_error_header both carry
    // the error status at [0]. The [59] check below is an inert
    // defensive fallback for legacy or mutated header-only arrays (a
    // header-only array can only be the malformed-input path; an OK
    // solve always emits payload).
    let error_status = Math.round(flat[0] ?? 0)
    if (
        error_status === 0 &&
        flat.length === EKF_RESULT_HEADER_LEN &&
        Math.round(flat[59] ?? 0) !== 0
    ) {
        error_status = Math.round(flat[59] ?? 0)
    }

    const n_obs = Math.round(flat[1] ?? 0)
    const n_maneuvers = Math.round(flat[11] ?? 0)

    const finalState: number[] = []
    for (let i = 0; i < 6; ++i) finalState.push(flat[12 + i] ?? 0)
    const finalCovDiag: number[] = []
    for (let i = 0; i < 6; ++i) finalCovDiag.push(flat[18 + i] ?? 0)
    const finalCov: number[] = []
    for (let i = 0; i < 36; ++i) finalCov.push(flat[24 + i] ?? 0)

    // SoA payload: obs_times(N), obs_types(N), maneuver_flag(N),
    // state_hist(N*6), sigma_hist(N*6), innovations(2N), nis(2N),
    // updated_mask(2N), maneuver_records(4*M).
    const steps: EkfStepRow[] = []
    const obs_times_at = EKF_RESULT_HEADER_LEN
    const obs_types_at = obs_times_at + n_obs
    const maneuver_flag_at = obs_types_at + n_obs
    const state_hist_at = maneuver_flag_at + n_obs
    const sigma_hist_at = state_hist_at + 6 * n_obs
    const innovations_at = sigma_hist_at + 6 * n_obs
    const nis_at = innovations_at + 2 * n_obs
    const updated_mask_at = nis_at + 2 * n_obs
    const maneuver_records_at = updated_mask_at + 2 * n_obs

    // Payload is SoA: if the header over-claims n_obs, every offset after
    // obs_times misaligns and no step can be recovered honestly, so the
    // whole step block is dropped (defensive against mutated arrays; the
    // kernel always emits a consistent length).
    const stepsReadable = updated_mask_at + 2 * n_obs <= flat.length
    const n_steps = stepsReadable ? n_obs : 0

    for (let k = 0; k < n_steps; ++k) {
        const obs_type_code = Math.round(flat[obs_types_at + k] ?? 0)
        const state: number[] = []
        for (let i = 0; i < 6; ++i) state.push(flat[state_hist_at + 6 * k + i] ?? 0)
        const sigmas: number[] = []
        for (let i = 0; i < 6; ++i) sigmas.push(flat[sigma_hist_at + 6 * k + i] ?? 0)
        steps.push({
            timeJd: flat[obs_times_at + k] ?? 0,
            obsType: OBS_TYPE_NAME[obs_type_code] ?? 'range',
            state,
            sigmas,
            nis: [
                nan_to_null(flat[nis_at + 2 * k]),
                nan_to_null(flat[nis_at + 2 * k + 1]),
            ],
            innovation: [
                nan_to_null(flat[innovations_at + 2 * k]),
                nan_to_null(flat[innovations_at + 2 * k + 1]),
            ],
            updatedMask: [
                (flat[updated_mask_at + 2 * k] ?? 0) !== 0,
                (flat[updated_mask_at + 2 * k + 1] ?? 0) !== 0,
            ],
            maneuverFlag: (flat[maneuver_flag_at + k] ?? 0) !== 0,
        })
    }

    const maneuverRecords: ManeuverRecordTs[] = []
    for (let m = 0; m < n_maneuvers; ++m) {
        const offset = maneuver_records_at + EKF_BURN_LEN * m
        if (offset + EKF_BURN_LEN > flat.length) break
        maneuverRecords.push({
            epochJd: flat[offset] ?? 0,
            dv: [flat[offset + 1] ?? 0, flat[offset + 2] ?? 0, flat[offset + 3] ?? 0],
        })
    }

    return {
        finalState,
        finalCovDiag,
        finalCov,
        steps,
        maneuverRecords,
        stats: {
            nObs: n_obs,
            nRows: Math.round(flat[2] ?? 0),
            nUpdated: Math.round(flat[3] ?? 0),
            nGated: Math.round(flat[4] ?? 0),
            divergenceFlag: (flat[5] ?? 0) !== 0,
            nRecoveries: Math.round(flat[6] ?? 0),
            augmentedActiveFinal: (flat[7] ?? 0) !== 0,
            nisMean: flat[8] ?? 0,
            nisMax: flat[9] ?? 0,
            nNisExceed: Math.round(flat[10] ?? 0),
            nManeuvers: n_maneuvers,
        },
        errorStatus: error_status,
        statusMessage:
            EKF_STATUS_MESSAGES[error_status] ?? 'Unknown EKF OD status',
    }
}

// =============================================================================
// Config defaults (WASM-first)
// =============================================================================

/**
 * Default EKF solver configuration.
 *
 * Prefers the live WASM od_ekf_config_defaults export (single source of
 * truth with the kernel) and falls back to DEFAULT_EKF_CONFIG when WASM
 * is not loaded.
 */
export function getEkfConfigDefaults(): EkfTsConfig {
    const mod = getWasmModule()
    if (mod && typeof mod.od_ekf_config_defaults === 'function') {
        try {
            const flat = mod.od_ekf_config_defaults()
            if (flat && flat.length >= EKF_CONFIG_LEN) return config_from_flat(flat)
        } catch (e) {
            console.warn('od_ekf_config_defaults failed:', e)
        }
    }
    return mergeEkfConfig()
}

// =============================================================================
// EKF solve (WASM-only; no TS fallback)
// =============================================================================

/** Input to runEkfSolve. */
export interface EkfSolveInput {
    /** Observations in the useODStore format (stationId resolved to geometry). */
    observations: ODObservation[]
    /** ECI state guess at epochJd [km, km/s] (exactly 6 values). */
    state0: number[]
    /** Filter start epoch [Julian Date, days]; the guess must be here. */
    epochJd: number
    /** Deep-partial config merged over getEkfConfigDefaults(). */
    config?: EkfPartialConfig
    /** Known impulsive burns applied mid-predict (ascending epochs). */
    scheduledBurns?: ScheduledManeuver[] | null
}

/**
 * Run sequential EKF orbit determination on pre-generated observations.
 *
 * Resolves every observation's station to ECI position/velocity at its
 * epoch via the shared odBatch helper (WASM with TS fallback), packs the
 * exports.cpp flat arrays, and calls the od_ekf_solve kernel. Returns
 * null when WASM is not ready, a station cannot be resolved, an input is
 * malformed, or the WASM call fails. Solver-level problems (empty arc,
 * AZ_EL rows, unsorted epochs, integration failure, divergence) come
 * back as a typed result with a non-OK errorStatus instead of null.
 */
export function runEkfSolve(input: EkfSolveInput): EkfTsResult | null {
    const mod = getWasmModule()
    if (!mod || typeof mod.od_ekf_solve !== 'function') return null

    const { observations, state0, epochJd } = input
    if (state0.length !== 6) return null

    // Resolve station ECI geometry at each observation epoch and pack the
    // obs table (9 header + 2*ndim doubles per record).
    const records: BatchObservationInput[] | null =
        resolveBatchObservationInputs(observations)
    if (!records) return null
    const obs_flat = packBatchObsTable(records)

    const config16 = packEkfConfig(mergeEkfConfig(input.config))
    const burns_flat = packScheduledBurns(input.scheduledBurns)

    try {
        const flat = mod.od_ekf_solve(
            obs_flat,
            [...state0],
            epochJd,
            config16,
            burns_flat.length > 0 ? burns_flat : null
        )
        return unpackEkfResult(flat)
    } catch (e) {
        console.warn('od_ekf_solve failed:', e)
        return null
    }
}
