// =============================================================================
// Zenith Web - STM Propagation WASM Wrapper
// =============================================================================
// Wraps the od_propagate_with_stm embind export: propagates a 6-dim state
// with the 42-dim J2 variational system (DOP853) and returns the final
// state plus the 6x6 state transition matrix.

import { getWasmModule } from './wasmLoader'
import type { STMPropagationResult } from './types'

/** Force tier: 0 = two-body, 1 = J2 (matches C++ orbit::ForceTier). */
export type ForceTier = 0 | 1

/** Default DOP853 relative tolerance (matches helio propagate_j2_with_stm). */
export const DEFAULT_STM_RTOL = 1e-10
/** Default DOP853 absolute tolerance. */
export const DEFAULT_STM_ATOL = 1e-12

/**
 * Propagate a 6-dim ECI state with the variational (STM) system.
 *
 * @param state6  Flat [rx, ry, rz, vx, vy, vz] in ECI km and km/s.
 * @param t0      Integration start time [s].
 * @param t1      Integration end time [s].
 * @param force_tier  0 = two-body, 1 = J2 (default).
 * @param rtol    Relative tolerance (default 1e-10).
 * @param atol    Absolute tolerance (default 1e-12).
 * @returns Final r, v and row-major 36-element STM, or null when WASM is
 *          unavailable, the input length is wrong, or integration failed.
 */
export function propagateStm(
    state6: number[],
    t0: number,
    t1: number,
    force_tier: ForceTier = 1,
    rtol: number = DEFAULT_STM_RTOL,
    atol: number = DEFAULT_STM_ATOL
): STMPropagationResult | null {
    if (state6.length !== 6) {
        console.warn('propagateStm: state must have 6 elements')
        return null
    }
    const mod = getWasmModule()
    if (!mod) return null
    try {
        const flat = mod.od_propagate_with_stm(state6, force_tier, rtol, atol, t0, t1)
        if (!flat || flat.length < 42) return null
        return {
            r: [flat[0], flat[1], flat[2]],
            v: [flat[3], flat[4], flat[5]],
            stm: Array.from(flat.slice(6, 42) as number[]),
        }
    } catch (e) {
        console.warn('od_propagate_with_stm failed:', e)
        return null
    }
}
