import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    packEkfConfig,
    packScheduledBurns,
    unpackEkfResult,
    mergeEkfConfig,
    runEkfSolve,
    getEkfConfigDefaults,
    EKF_CONFIG_LEN,
    EKF_RESULT_HEADER_LEN,
    EKF_BURN_LEN,
} from '../odEkf'
import { getWasmModule } from '@/orbit/wasmLoader'
import { stationPositionEci, stationVelocityEci } from '@/orbit/stations'
import { useODStore } from '@/store/useODStore'
import { DEFAULT_EKF_CONFIG } from '../odConstants'
import { EKF_STATUS, EKF_STATUS_MESSAGES } from '../types'
import type { ODObservation, ScheduledManeuver } from '../types'

vi.mock('@/orbit/wasmLoader', () => ({
    getWasmModule: vi.fn(() => null),
}))

vi.mock('@/orbit/stations', () => ({
    stationPositionEci: vi.fn(),
    stationVelocityEci: vi.fn(),
    createStation: vi.fn(() => 1),
    destroyStation: vi.fn(),
}))

const mockGetWasmModule = vi.mocked(getWasmModule)
const mockStationPositionEci = vi.mocked(stationPositionEci)
const mockStationVelocityEci = vi.mocked(stationVelocityEci)

// Store stations with WASM handles (stationId -> handle resolution).
const STATIONS = [
    { id: 'sta-1', name: 'goldstone', latRad: 0.6, lonRad: -2.0, altKm: 1.0, handle: 11 },
    { id: 'sta-2', name: 'arecibo', latRad: 0.3, lonRad: -1.2, altKm: 0.4, handle: 22 },
]

const STA1_POS = { x: 6378.1, y: 100.2, z: 200.3 }
const STA1_VEL = { x: -0.29, y: 0.05, z: 0.01 }

const STATE0 = [6778.1, 123.4, 456.7, 1.5, -2.5, 7.6]

function makeObs(overrides?: Partial<ODObservation>): ODObservation {
    return {
        timeJd: 2460310.5,
        stationId: 'sta-1',
        obsType: 'range',
        values: [6781.2],
        sigmas: [1e-3],
        ...overrides,
    }
}

/**
 * Canned exports.cpp flat result for 2 observation steps (one scalar
 * range with NaN padding, one ra_dec) and one stored maneuver record:
 * [header(60), obs_times(2), obs_types(2), maneuver_flag(2),
 *  state_hist(12), sigma_hist(12), innovations(4), nis(4),
 *  updated_mask(4), maneuver_records(4)].
 */
function cannedFlat(options?: { error?: number; nObs?: number }): number[] {
    const flat: number[] = []
    // Header: status + diagnostics.
    flat.push(
        options?.error ?? EKF_STATUS.OK,
        options?.nObs ?? 2, // n_obs
        3, // n_rows (range 1 + ra_dec 2)
        3, // n_updated
        0, // n_gated
        0, // divergence_flag
        0, // n_recoveries
        0, // augmented_active_final
        0.5, // nis_mean
        12.5, // nis_max
        0, // n_nis_exceed
        1 // n_maneuvers
    )
    flat.push(6778.1, 123.4, 456.7, 1.5, -2.5, 7.6) // final_state
    flat.push(0.1, 0.2, 0.3, 1e-4, 2e-4, 3e-4) // final_cov_diag
    for (let i = 0; i < 36; ++i) flat.push(i * 0.001) // final_cov
    // SoA payload.
    flat.push(2460310.5, 2460310.51) // obs_times(2)
    flat.push(0, 2) // obs_types(2): RANGE, RA_DEC
    flat.push(0, 1) // maneuver_flag(2)
    for (let i = 0; i < 12; ++i) flat.push(100 + i) // state_hist(12)
    for (let i = 0; i < 12; ++i) flat.push(0.01 * (i + 1)) // sigma_hist(12)
    flat.push(0.002, NaN, 1e-6, -2e-6) // innovations(4): range pad NaN
    flat.push(1.5, NaN, 4.0, 9.0) // nis(4): range pad NaN
    flat.push(1, 0, 1, 1) // updated_mask(4)
    flat.push(2460310.505, 0.001, 0.002, 0.003) // maneuver_records(4)
    return flat
}

/**
 * 60-double header-only error result with the status placed LAST at [59]
 * (legacy exports.cpp od_ekf_error_header layout, since fixed to [0]).
 * Exercises the unpackEkfResult defensive fallback for legacy/mutated
 * arrays; the current WASM always writes the status at [0].
 */
function errorHeaderTail(status: number): number[] {
    const flat = Array.from({ length: EKF_RESULT_HEADER_LEN }, () => 0)
    flat[59] = status
    return flat
}

/** Typed mock for od_ekf_solve capturing its five arguments. */
function ekfSolveMock(flat: number[] | null) {
    return vi.fn(
        (
            _obs_flat: number[],
            _state6: number[],
            _epoch_jd: number,
            _config16: number[],
            _burns: number[] | null
        ) => flat
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    mockGetWasmModule.mockReturnValue(null)
    mockStationPositionEci.mockReturnValue(STA1_POS)
    mockStationVelocityEci.mockReturnValue(STA1_VEL)
    useODStore.setState({
        stations: STATIONS.map((s) => ({ ...s })),
        selectedStationId: null,
        observations: [],
        simConfig: { noiseScale: 1, cadenceSec: 60, arcHours: 1, stationNames: ['goldstone'] },
        iodResult: null,
        batchResult: null,
        batchIsRunning: false,
        ekfResult: null,
        ekfIsRunning: false,
        ekfProgress: 0,
        scheduledManeuvers: [],
    })
})

// =============================================================================
// packEkfConfig: exports.cpp config16 contract (pinned order)
// =============================================================================

describe('packEkfConfig layout', () => {
    it('packs the exact config16 order from exports.cpp parse_ekf_config_flat', () => {
        const cfg = mergeEkfConfig({
            process: { qA: 1e-9, qAManeuver: 1e-5 },
            maneuver: {
                estimateManeuver: true,
                nisSigmaThreshold: 4.0,
                consecutiveExceedances: 2,
                reentryWindowObs: 15,
                scheduledInflateKms: 2e-4,
            },
            recovery: { sustainedNisCount: 8, inflateFactor: 50 },
            p0Diag: [2, 2, 2, 2e-6, 2e-6, 2e-6],
            forceTier: 0,
        })
        expect(packEkfConfig(cfg)).toEqual([
            1e-9, // [0] q_a
            1e-5, // [1] q_a_maneuver
            1, // [2] estimate_maneuver (true -> 1)
            4.0, // [3] nis_sigma_threshold
            2, // [4] consecutive_exceedances
            15, // [5] reentry_window_obs
            2e-4, // [6] scheduled_inflate_kms
            8, // [7] sustained_nis_count
            50, // [8] inflate_factor
            2, 2, 2, 2e-6, 2e-6, 2e-6, // [9..14] p0_diag(6)
            0, // [15] force_tier
        ])
        expect(packEkfConfig(cfg)).toHaveLength(EKF_CONFIG_LEN)
    })

    it('packs the kernel defaults verbatim (helio parity values)', () => {
        expect(packEkfConfig(mergeEkfConfig())).toEqual([
            1e-10, 1e-6, 0, 5, 3, 20, 1e-4, 10, 100,
            1, 1, 1, 1e-6, 1e-6, 1e-6,
            1,
        ])
    })

    it('encodes estimateManeuver false as 0', () => {
        const flat = packEkfConfig(mergeEkfConfig({ maneuver: { estimateManeuver: false } }))
        expect(flat[2]).toBe(0)
    })
})

// =============================================================================
// mergeEkfConfig / packScheduledBurns
// =============================================================================

describe('mergeEkfConfig', () => {
    it('deep-merges partial sub-configs over the defaults', () => {
        const cfg = mergeEkfConfig({
            process: { qA: 2e-10 },
            recovery: { inflateFactor: 10 },
        })
        expect(cfg.process.qA).toBe(2e-10)
        expect(cfg.process.qAManeuver).toBe(DEFAULT_EKF_CONFIG.process.qAManeuver)
        expect(cfg.recovery.inflateFactor).toBe(10)
        expect(cfg.recovery.sustainedNisCount).toBe(
            DEFAULT_EKF_CONFIG.recovery.sustainedNisCount
        )
        expect(cfg.maneuver).toEqual(DEFAULT_EKF_CONFIG.maneuver)
    })

    it('pads a short p0Diag with default entries and keeps 6 values', () => {
        const cfg = mergeEkfConfig({ p0Diag: [9, 9] })
        expect(cfg.p0Diag).toEqual([9, 9, 1, 1e-6, 1e-6, 1e-6])
        expect(cfg.p0Diag).toHaveLength(6)
    })

    it('returns a copy, not the shared defaults object', () => {
        const cfg = mergeEkfConfig()
        expect(cfg).toEqual(DEFAULT_EKF_CONFIG)
        expect(cfg).not.toBe(DEFAULT_EKF_CONFIG)
        expect(cfg.process).not.toBe(DEFAULT_EKF_CONFIG.process)
        expect(cfg.p0Diag).not.toBe(DEFAULT_EKF_CONFIG.p0Diag)
    })
})

describe('packScheduledBurns', () => {
    it('packs burns as {epoch_jd, dv(3)} per record', () => {
        const burns: ScheduledManeuver[] = [
            { epochJd: 2460310.51, dv: [0.001, 0.002, 0.003] },
            { epochJd: 2460310.52, dv: [-0.004, 0, 0.005] },
        ]
        const flat = packScheduledBurns(burns)
        expect(flat).toHaveLength(2 * EKF_BURN_LEN)
        expect(flat).toEqual([
            2460310.51, 0.001, 0.002, 0.003,
            2460310.52, -0.004, 0, 0.005,
        ])
    })

    it('returns an empty array for null, undefined, or no burns', () => {
        expect(packScheduledBurns(null)).toEqual([])
        expect(packScheduledBurns(undefined)).toEqual([])
        expect(packScheduledBurns([])).toEqual([])
    })
})

// =============================================================================
// unpackEkfResult: flat result mapping
// =============================================================================

describe('unpackEkfResult mapping', () => {
    it('maps the 60-double header, stats, and final state/covariance', () => {
        const result = unpackEkfResult(cannedFlat())
        expect(result).not.toBeNull()
        expect(result!.finalState).toEqual([6778.1, 123.4, 456.7, 1.5, -2.5, 7.6])
        expect(result!.finalCovDiag).toEqual([0.1, 0.2, 0.3, 1e-4, 2e-4, 3e-4])
        expect(result!.finalCov).toHaveLength(36)
        expect(result!.finalCov[0]).toBeCloseTo(0)
        expect(result!.finalCov[35]).toBeCloseTo(0.035)
        expect(result!.stats).toEqual({
            nObs: 2,
            nRows: 3,
            nUpdated: 3,
            nGated: 0,
            divergenceFlag: false,
            nRecoveries: 0,
            augmentedActiveFinal: false,
            nisMean: 0.5,
            nisMax: 12.5,
            nNisExceed: 0,
            nManeuvers: 1,
        })
        expect(result!.errorStatus).toBe(EKF_STATUS.OK)
        expect(result!.statusMessage).toBe(EKF_STATUS_MESSAGES[EKF_STATUS.OK])
    })

    it('maps the range step with NaN padding to null slots', () => {
        const result = unpackEkfResult(cannedFlat())
        expect(result!.steps).toHaveLength(2)
        const range_step = result!.steps[0]!
        expect(range_step.timeJd).toBe(2460310.5)
        expect(range_step.obsType).toBe('range')
        expect(range_step.state).toEqual([100, 101, 102, 103, 104, 105])
        expect(range_step.sigmas).toEqual([0.01, 0.02, 0.03, 0.04, 0.05, 0.06])
        expect(range_step.nis).toEqual([1.5, null])
        expect(range_step.innovation).toEqual([0.002, null])
        expect(range_step.updatedMask).toEqual([true, false])
        expect(range_step.maneuverFlag).toBe(false)
    })

    it('maps the ra_dec step with both components and the maneuver flag', () => {
        const result = unpackEkfResult(cannedFlat())
        const angles_step = result!.steps[1]!
        expect(angles_step.timeJd).toBe(2460310.51)
        expect(angles_step.obsType).toBe('ra_dec')
        expect(angles_step.nis).toEqual([4.0, 9.0])
        expect(angles_step.innovation).toEqual([1e-6, -2e-6])
        expect(angles_step.updatedMask).toEqual([true, true])
        expect(angles_step.maneuverFlag).toBe(true)
        expect(angles_step.state).toEqual([106, 107, 108, 109, 110, 111])
    })

    it('maps maneuver records {epoch_jd, dv(3)}', () => {
        const result = unpackEkfResult(cannedFlat())
        expect(result!.maneuverRecords).toHaveLength(1)
        expect(result!.maneuverRecords[0]).toEqual({
            epochJd: 2460310.505,
            dv: [0.001, 0.002, 0.003],
        })
    })

    it('reads the status from [0] for normal results with payload', () => {
        const result = unpackEkfResult(cannedFlat({ error: EKF_STATUS.ERROR_DIVERGENCE }))
        expect(result!.errorStatus).toBe(EKF_STATUS.ERROR_DIVERGENCE)
        expect(result!.statusMessage).toBe(EKF_STATUS_MESSAGES[EKF_STATUS.ERROR_DIVERGENCE])
        expect(result!.steps).toHaveLength(2)
    })

    it('reads the tail-placed status of a header-only legacy error result (inert defensive fallback)', () => {
        // The exports.cpp od_ekf_error_header now places the status at
        // [0] like the normal serializer. This pins the unpackEkfResult
        // defensive fallback that still accepts the legacy tail-placed
        // ([59]) status of a header-only array (legacy or mutated input).
        const result = unpackEkfResult(errorHeaderTail(EKF_STATUS.ERROR_INPUT))
        expect(result).not.toBeNull()
        expect(result!.errorStatus).toBe(EKF_STATUS.ERROR_INPUT)
        expect(result!.statusMessage).toBe(EKF_STATUS_MESSAGES[EKF_STATUS.ERROR_INPUT])
        expect(result!.steps).toHaveLength(0)
        expect(result!.maneuverRecords).toHaveLength(0)
        expect(result!.stats.nObs).toBe(0)
    })

    it('falls back to a generic message for unknown status codes', () => {
        const result = unpackEkfResult(cannedFlat({ error: 99 }))
        expect(result!.statusMessage).toBe('Unknown EKF OD status')
    })

    it('drops all steps when the header over-claims n_obs (SoA misalignment)', () => {
        // n_obs says 5 but the payload only contains 2 steps: every SoA
        // offset after obs_times misaligns, so no step is recoverable.
        const result = unpackEkfResult(cannedFlat({ nObs: 5 }))
        expect(result!.steps).toHaveLength(0)
        expect(result!.stats.nObs).toBe(5)
    })

    it('parses steps fully but truncates maneuver records that overrun the array', () => {
        const flat = cannedFlat()
        // Chop the single maneuver record in half (2 of 4 doubles).
        const truncated = flat.slice(0, flat.length - 2)
        const result = unpackEkfResult(truncated)
        expect(result!.steps).toHaveLength(2)
        expect(result!.maneuverRecords).toHaveLength(0)
    })

    it('returns null for arrays shorter than the 60-double header', () => {
        expect(unpackEkfResult([1, 2, 3])).toBeNull()
        expect(unpackEkfResult([])).toBeNull()
        expect(unpackEkfResult(null)).toBeNull()
        expect(unpackEkfResult(undefined)).toBeNull()
    })
})

// =============================================================================
// runEkfSolve: exports.cpp call contract
// =============================================================================

describe('runEkfSolve call contract', () => {
    it('passes the packed table, state6, epoch, config16, and null burns', () => {
        const od_ekf_solve = ekfSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_ekf_solve })
        const result = runEkfSolve({
            observations: [makeObs()],
            state0: STATE0,
            epochJd: 2460310.5,
        })
        expect(result).not.toBeNull()
        expect(od_ekf_solve).toHaveBeenCalledTimes(1)
        const [obs_flat, state6, epoch_jd, config16, burns] = od_ekf_solve.mock.calls[0]!
        expect(obs_flat).toEqual([
            2460310.5,
            STA1_POS.x, STA1_POS.y, STA1_POS.z,
            STA1_VEL.x, STA1_VEL.y, STA1_VEL.z,
            0, // RANGE
            1, // ndim
            6781.2,
            1e-3,
        ])
        expect(state6).toEqual(STATE0)
        expect(state6).not.toBe(STATE0) // defensive copy
        expect(epoch_jd).toBe(2460310.5)
        expect(config16).toEqual(packEkfConfig(mergeEkfConfig()))
        expect(burns).toBeNull()
    })

    it('resolves station geometry per observation epoch and maps types to codes', () => {
        const od_ekf_solve = ekfSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_ekf_solve })
        runEkfSolve({
            observations: [
                makeObs(),
                makeObs({
                    timeJd: 2460310.52,
                    stationId: 'sta-2',
                    obsType: 'ra_dec',
                    values: [1.2, -0.3],
                    sigmas: [1e-6, 1e-6],
                }),
            ],
            state0: STATE0,
            epochJd: 2460310.5,
        })
        expect(mockStationPositionEci).toHaveBeenCalledWith(11, 2460310.5)
        expect(mockStationVelocityEci).toHaveBeenCalledWith(11, 2460310.5)
        expect(mockStationPositionEci).toHaveBeenCalledWith(22, 2460310.52)
        const obs_flat = od_ekf_solve.mock.calls[0]![0]
        expect(obs_flat).toHaveLength(24) // range(11) + ra_dec(13)
        expect(obs_flat[11 + 7]).toBe(2) // RA_DEC code
        expect(obs_flat[11 + 8]).toBe(2) // ndim
    })

    it('applies nested config overrides through the config16 array', () => {
        const od_ekf_solve = ekfSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_ekf_solve })
        runEkfSolve({
            observations: [makeObs()],
            state0: STATE0,
            epochJd: 2460310.5,
            config: {
                process: { qA: 3e-10, qAManeuver: 1e-5 },
                maneuver: { estimateManeuver: true, nisSigmaThreshold: 3 },
                forceTier: 0,
            },
        })
        const config16 = od_ekf_solve.mock.calls[0]![3]
        expect(config16).toEqual([
            3e-10, // q_a override
            1e-5, // q_a_maneuver override
            1, // estimate_maneuver override
            3, // nis_sigma_threshold override
            3, 20, 1e-4, // remaining maneuver defaults
            10, 100, // recovery defaults
            1, 1, 1, 1e-6, 1e-6, 1e-6, // p0_diag defaults
            0, // force_tier override
        ])
    })

    it('packs scheduled burns as 4 doubles each', () => {
        const od_ekf_solve = ekfSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_ekf_solve })
        runEkfSolve({
            observations: [makeObs()],
            state0: STATE0,
            epochJd: 2460310.5,
            scheduledBurns: [
                { epochJd: 2460310.505, dv: [0.001, 0.002, 0.003] },
                { epochJd: 2460310.515, dv: [0, -0.001, 0] },
            ],
        })
        const burns = od_ekf_solve.mock.calls[0]![4]
        expect(burns).toEqual([
            2460310.505, 0.001, 0.002, 0.003,
            2460310.515, 0, -0.001, 0,
        ])
    })
})

// =============================================================================
// runEkfSolve: null paths
// =============================================================================

describe('runEkfSolve null paths', () => {
    it('returns null when WASM is not ready', () => {
        mockGetWasmModule.mockReturnValue(null)
        expect(
            runEkfSolve({ observations: [makeObs()], state0: STATE0, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when the od_ekf_solve export is absent', () => {
        mockGetWasmModule.mockReturnValue({})
        expect(
            runEkfSolve({ observations: [makeObs()], state0: STATE0, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when the state guess is not 6 values', () => {
        mockGetWasmModule.mockReturnValue({ od_ekf_solve: ekfSolveMock(cannedFlat()) })
        expect(
            runEkfSolve({ observations: [makeObs()], state0: [1, 2, 3], epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when a stationId cannot be resolved to a handle', () => {
        const od_ekf_solve = ekfSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_ekf_solve })
        expect(
            runEkfSolve({
                observations: [makeObs({ stationId: 'sta-999' })],
                state0: STATE0,
                epochJd: 2460310.5,
            })
        ).toBeNull()
        expect(od_ekf_solve).not.toHaveBeenCalled()
    })

    it('returns null when station geometry cannot be resolved', () => {
        mockGetWasmModule.mockReturnValue({ od_ekf_solve: ekfSolveMock(cannedFlat()) })
        mockStationPositionEci.mockReturnValue(null)
        expect(
            runEkfSolve({ observations: [makeObs()], state0: STATE0, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when values or sigmas are shorter than the type ndim', () => {
        const od_ekf_solve = ekfSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_ekf_solve })
        expect(
            runEkfSolve({
                observations: [makeObs({ obsType: 'ra_dec', values: [1.2], sigmas: [1e-6] })],
                state0: STATE0,
                epochJd: 2460310.5,
            })
        ).toBeNull()
        expect(od_ekf_solve).not.toHaveBeenCalled()
    })

    it('returns null when the WASM call throws', () => {
        mockGetWasmModule.mockReturnValue({
            od_ekf_solve: vi.fn(() => {
                throw new Error('bad input')
            }),
        })
        expect(
            runEkfSolve({ observations: [makeObs()], state0: STATE0, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('surfaces the kernel ERROR_INPUT result for an empty observation list', () => {
        // Empty tables come back as a header-only ERROR_INPUT (status at
        // [0] per the current error_header layout; the mock uses the
        // legacy tail-placed header to also exercise the fallback).
        const od_ekf_solve = ekfSolveMock(errorHeaderTail(EKF_STATUS.ERROR_INPUT))
        mockGetWasmModule.mockReturnValue({ od_ekf_solve })
        const result = runEkfSolve({ observations: [], state0: STATE0, epochJd: 2460310.5 })
        expect(result).not.toBeNull()
        expect(result!.errorStatus).toBe(EKF_STATUS.ERROR_INPUT)
        expect(result!.steps).toHaveLength(0)
        expect(od_ekf_solve.mock.calls[0]![0]).toEqual([])
    })
})

// =============================================================================
// getEkfConfigDefaults
// =============================================================================

describe('getEkfConfigDefaults', () => {
    it('prefers the WASM od_ekf_config_defaults export', () => {
        const wasm_defaults = [
            2e-10, 2e-6, 1, 4.0, 2, 15, 3e-4, 8, 50,
            2, 2, 2, 2e-6, 2e-6, 2e-6,
            0,
        ]
        mockGetWasmModule.mockReturnValue({
            od_ekf_config_defaults: vi.fn(() => wasm_defaults),
        })
        expect(getEkfConfigDefaults()).toEqual({
            process: { qA: 2e-10, qAManeuver: 2e-6 },
            maneuver: {
                estimateManeuver: true,
                nisSigmaThreshold: 4.0,
                consecutiveExceedances: 2,
                reentryWindowObs: 15,
                scheduledInflateKms: 3e-4,
            },
            recovery: { sustainedNisCount: 8, inflateFactor: 50 },
            p0Diag: [2, 2, 2, 2e-6, 2e-6, 2e-6],
            forceTier: 0,
        })
    })

    it('falls back to DEFAULT_EKF_CONFIG when WASM is absent', () => {
        mockGetWasmModule.mockReturnValue(null)
        const defaults = getEkfConfigDefaults()
        expect(defaults).toEqual(DEFAULT_EKF_CONFIG)
        expect(defaults).not.toBe(DEFAULT_EKF_CONFIG)
    })

    it('falls back when the export is missing or throws', () => {
        mockGetWasmModule.mockReturnValue({})
        expect(getEkfConfigDefaults()).toEqual(DEFAULT_EKF_CONFIG)
        mockGetWasmModule.mockReturnValue({
            od_ekf_config_defaults: vi.fn(() => {
                throw new Error('boom')
            }),
        })
        expect(getEkfConfigDefaults()).toEqual(DEFAULT_EKF_CONFIG)
    })

    it('falls back when the export returns a short array', () => {
        mockGetWasmModule.mockReturnValue({
            od_ekf_config_defaults: vi.fn(() => [1, 2, 3]),
        })
        expect(getEkfConfigDefaults()).toEqual(DEFAULT_EKF_CONFIG)
    })
})

// =============================================================================
// useODStore: runEkf lifecycle + scheduled maneuver CRUD
// =============================================================================

describe('useODStore runEkf lifecycle', () => {
    it('toggles running/progress flags and stores the typed result', () => {
        mockGetWasmModule.mockReturnValue({ od_ekf_solve: ekfSolveMock(cannedFlat()) })
        useODStore.getState().setObservations([makeObs()])
        useODStore.getState().runEkf(STATE0, 2460310.5)
        const state = useODStore.getState()
        expect(state.ekfIsRunning).toBe(false)
        expect(state.ekfProgress).toBe(100)
        expect(state.ekfResult).not.toBeNull()
        expect(state.ekfResult!.stats.nObs).toBe(2)
        expect(state.ekfResult!.steps).toHaveLength(2)
    })

    it('clears a previous result when the new solve returns null', () => {
        useODStore.setState({ ekfResult: unpackEkfResult(cannedFlat()) })
        mockGetWasmModule.mockReturnValue(null)
        useODStore.getState().runEkf(STATE0, 2460310.5)
        expect(useODStore.getState().ekfResult).toBeNull()
        expect(useODStore.getState().ekfIsRunning).toBe(false)
        expect(useODStore.getState().ekfProgress).toBe(100)
    })

    it('passes the store observations and scheduled maneuvers to the kernel', () => {
        const od_ekf_solve = ekfSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_ekf_solve })
        useODStore.getState().setObservations([makeObs()])
        useODStore.getState().addScheduledManeuver({
            epochJd: 2460310.505,
            dv: [0.001, 0.002, 0.003],
        })
        useODStore.getState().runEkf(STATE0, 2460310.5)
        const [obs_flat, , , , burns] = od_ekf_solve.mock.calls[0]!
        expect(obs_flat).toHaveLength(11) // one range record
        expect(burns).toEqual([2460310.505, 0.001, 0.002, 0.003])
    })

    it('clearEkfResult resets the result and progress', () => {
        useODStore.setState({ ekfResult: unpackEkfResult(cannedFlat()), ekfProgress: 100 })
        useODStore.getState().clearEkfResult()
        expect(useODStore.getState().ekfResult).toBeNull()
        expect(useODStore.getState().ekfProgress).toBe(0)
    })
})

describe('useODStore scheduled maneuvers CRUD', () => {
    it('addScheduledManeuver keeps the list sorted ascending by epoch', () => {
        const store = useODStore.getState()
        store.addScheduledManeuver({ epochJd: 2460310.52, dv: [0, 0, 0.001] })
        store.addScheduledManeuver({ epochJd: 2460310.50, dv: [0.001, 0, 0] })
        store.addScheduledManeuver({ epochJd: 2460310.51, dv: [0, 0.001, 0] })
        expect(useODStore.getState().scheduledManeuvers.map((m) => m.epochJd)).toEqual([
            2460310.5, 2460310.51, 2460310.52,
        ])
    })

    it('removeScheduledManeuver removes by index', () => {
        const store = useODStore.getState()
        store.addScheduledManeuver({ epochJd: 1, dv: [0, 0, 0] })
        store.addScheduledManeuver({ epochJd: 2, dv: [0, 0, 0] })
        store.removeScheduledManeuver(0)
        expect(useODStore.getState().scheduledManeuvers).toHaveLength(1)
        expect(useODStore.getState().scheduledManeuvers[0]!.epochJd).toBe(2)
    })

    it('clearScheduledManeuvers empties the list', () => {
        const store = useODStore.getState()
        store.addScheduledManeuver({ epochJd: 1, dv: [0, 0, 0] })
        store.clearScheduledManeuvers()
        expect(useODStore.getState().scheduledManeuvers).toEqual([])
    })

    it('clearAll resets EKF state and scheduled maneuvers', () => {
        mockGetWasmModule.mockReturnValue({ od_ekf_solve: ekfSolveMock(cannedFlat()) })
        const store = useODStore.getState()
        store.setObservations([makeObs()])
        store.addScheduledManeuver({ epochJd: 2460310.505, dv: [0.001, 0, 0] })
        store.runEkf(STATE0, 2460310.5)
        expect(useODStore.getState().ekfResult).not.toBeNull()

        useODStore.getState().clearAll()
        const state = useODStore.getState()
        expect(state.ekfResult).toBeNull()
        expect(state.ekfIsRunning).toBe(false)
        expect(state.ekfProgress).toBe(0)
        expect(state.scheduledManeuvers).toEqual([])
        expect(state.observations).toEqual([])
    })
})
