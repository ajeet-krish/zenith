// =============================================================================
// Zenith Web - Gauss Angles-Only IOD WASM Wrappers
// =============================================================================
// Wraps the od_gauss_iod and od_herrick_gibbs embind exports (Phase 2).
// Follows the wasmLoader.ts WASM-first pattern: every call degrades
// gracefully (returns null) when the WASM module is not loaded. Flat-array
// layouts match wasm/src/exports.cpp exactly:
//   od_gauss_iod input obs: 12 doubles = 3 obs x {jd, ra_rad, dec_rad, pad}
//   od_gauss_iod config:    6 doubles = {mu, residual_tol_rad,
//                            enable_corr (0/1), max_dc_iter, cond_singular,
//                            cond_warning}
//   od_gauss_iod result:    16 doubles = {r[3], v[3], converged, iterations,
//                            residual_norm, cond_number, error_code,
//                            ranges[3], pad[2]}
// Station geometry comes from od_station_create handles (Phase 1 pattern).

import { getWasmModule } from './wasmLoader'
import { MU_EARTH } from './constants'
import { DEFAULT_GAUSS_IOD_CONFIG } from './odConstants'
import { GAUSS_IOD_STATUS_MESSAGES } from './types'
import type { GaussIodConfig, GaussIodObservation, GaussIodTsResult, HerrickGibbsTsResult } from './types'
import { useODStore } from '@/store/useODStore'

// =============================================================================
// Station handle resolution
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
// Gauss IOD (WASM-only; no TS fallback)
// =============================================================================

/**
 * Run Gauss angles-only IOD from exactly three RA/Dec observations.
 *
 * Each observation's stationId is resolved to a WASM station handle via the
 * OD store (or interpreted as a raw numeric handle). The result is the
 * state at the middle epoch plus solver diagnostics. Returns null when
 * WASM is not ready, a handle cannot be resolved, the observation count is
 * not exactly 3, or the WASM call fails.
 */
export function runGaussIod(
    observations: GaussIodObservation[],
    config?: Partial<GaussIodConfig>
): GaussIodTsResult | null {
    if (observations.length !== 3) return null
    const mod = getWasmModule()
    if (!mod || typeof mod.od_gauss_iod !== 'function') return null

    const handles: number[] = []
    for (const obs of observations) {
        const handle = resolve_station_handle(obs.stationId)
        if (handle == null) return null
        handles.push(handle)
    }

    // 3 obs x {jd, ra_rad, dec_rad, pad} = 12 doubles (stride 4).
    const obs12: number[] = []
    for (const obs of observations) {
        obs12.push(obs.epochJd, obs.raRad, obs.decRad, 0)
    }

    const cfg = { ...DEFAULT_GAUSS_IOD_CONFIG, ...config }
    // NOTE: exports.cpp maps index 4 -> cond_singular and index 5 ->
    // cond_warning (swapped relative to the C++ struct field order).
    const config6 = [
        cfg.mu,
        cfg.residualTolRad,
        cfg.enableCorrection ? 1 : 0,
        cfg.maxDcIter,
        cfg.condSingular,
        cfg.condWarning,
    ]

    try {
        const flat = mod.od_gauss_iod(handles[0], handles[1], handles[2], obs12, config6)
        if (!flat || flat.length < 16) return null
        const status = flat[10] as number
        return {
            r: [flat[0], flat[1], flat[2]],
            v: [flat[3], flat[4], flat[5]],
            status,
            statusMessage: GAUSS_IOD_STATUS_MESSAGES[status] ?? 'Unknown Gauss IOD status',
            converged: flat[6] === 1.0,
            iterations: flat[7],
            residualNorm: flat[8],
            conditionNumber: flat[9],
            ranges: [flat[11], flat[12], flat[13]],
        }
    } catch (e) {
        console.warn('od_gauss_iod failed:', e)
        return null
    }
}

// =============================================================================
// Herrick-Gibbs (WASM-only; no TS fallback)
// =============================================================================

/**
 * Velocity at the middle of three ECI positions via Herrick-Gibbs.
 *
 * @param r1 Position at t1 [km, ECI/TEME].
 * @param r2 Position at t2 [km, ECI/TEME].
 * @param r3 Position at t3 [km, ECI/TEME].
 * @param t1 First epoch [s].
 * @param t2 Middle epoch [s].
 * @param t3 Last epoch [s].
 * @param mu Gravitational parameter [km^3/s^2] (default Earth).
 * @return Typed result (velocity, status, message) or null when WASM is
 *         not ready or the call fails.
 */
export function runHerrickGibbs(
    r1: { x: number; y: number; z: number },
    r2: { x: number; y: number; z: number },
    r3: { x: number; y: number; z: number },
    t1: number,
    t2: number,
    t3: number,
    mu: number = MU_EARTH
): HerrickGibbsTsResult | null {
    const mod = getWasmModule()
    if (!mod || typeof mod.od_herrick_gibbs !== 'function') return null
    try {
        const res = mod.od_herrick_gibbs(
            r1.x, r1.y, r1.z,
            r2.x, r2.y, r2.z,
            r3.x, r3.y, r3.z,
            t1, t2, t3, mu
        )
        if (!res) return null
        const status = res.status as number
        return {
            v: [res.vx, res.vy, res.vz],
            status,
            statusMessage: GAUSS_IOD_STATUS_MESSAGES[status] ?? 'Unknown Gauss IOD status',
        }
    } catch (e) {
        console.warn('od_herrick_gibbs failed:', e)
        return null
    }
}
