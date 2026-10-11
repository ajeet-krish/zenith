import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    packBatchObsTable,
    packBatchConfig,
    packBatchAPriori,
    unpackBatchResult,
    runBatchSolve,
    getBatchConfigDefaults,
    BATCH_OBS_HEADER_LEN,
    BATCH_RESULT_HEADER_LEN,
    BATCH_RESIDUAL_ROW_LEN,
} from '../odBatch'
import { getWasmModule } from '@/orbit/wasmLoader'
import { stationPositionEci, stationVelocityEci } from '@/orbit/stations'
import { useODStore } from '@/store/useODStore'
import { DEFAULT_BATCH_CONFIG } from '../odConstants'
import { BATCH_STATUS, BATCH_STATUS_MESSAGES } from '../types'
import type { ODObservation } from '../types'

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

const STATE_GUESS = [6778.1, 123.4, 456.7, 1.5, -2.5, 7.6]

/**
 * Canned exports.cpp flat result: [state(6), cov(36), formal_sigmas(6),
 * iterations, converged, wrms, reduced_chi2, edited_count, n_active,
 * status, n_residual_rows, residual_rows(N x 14)].
 */
function cannedFlat(options?: {
    status?: number
    converged?: number
    reducedChi2?: number
    nResidualRows?: number
}): number[] {
    const flat: number[] = []
    // state(6)
    flat.push(6778.1, 123.4, 456.7, 1.5, -2.5, 7.6)
    // cov(36): distinctive pattern cov[i] = i * 0.001
    for (let i = 0; i < 36; ++i) flat.push(i * 0.001)
    // formal_sigmas(6)
    flat.push(0.1, 0.2, 0.3, 1e-4, 2e-4, 3e-4)
    // iterations, converged, wrms, reduced_chi2, edited_count, n_active, status, n_residual_rows
    flat.push(
        5,
        options?.converged ?? 1,
        0.98,
        options?.reducedChi2 ?? 1.05,
        2,
        58,
        options?.status ?? BATCH_STATUS.OK,
        options?.nResidualRows ?? 2
    )
    // residual row 0: edited range observation
    flat.push(
        2460310.5, // time_jd
        0, // obs_type = RANGE
        1, // ndim
        6781.2, // values[0]
        0, // values[1]
        6781.19, // computed[0]
        0,
        0.01, // residual[0]
        0,
        1e-3, // sigma[0]
        0,
        10, // normalized[0]
        0,
        1 // edited
    )
    // residual row 1: active ra_dec observation
    flat.push(
        2460310.51,
        2, // obs_type = RA_DEC
        2, // ndim
        1.2, 0.3, // values
        1.19999, 0.30001, // computed
        1e-5, -1e-5, // residual
        1e-6, 1e-6, // sigma
        10, -10, // normalized
        0 // edited
    )
    return flat
}

/** Typed mock for od_batch_solve capturing its five arguments. */
function batchSolveMock(flat: number[] | null) {
    return vi.fn(
        (
            _obs_flat: number[],
            _state6: number[],
            _epoch_jd: number,
            _config10: number[],
            _apriori42: number[] | null
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
    })
})

// =============================================================================
// packBatchObsTable: exports.cpp record layout (9 header + 2*ndim)
// =============================================================================

describe('packBatchObsTable layout', () => {
    const STA_POS = { x: 1000, y: 2000, z: 3000 }
    const STA_VEL = { x: 1, y: 2, z: 3 }

    it('packs a range record as 9 header + 2 doubles (11 total)', () => {
        const flat = packBatchObsTable([
            {
                timeJd: 2460310.5,
                staPosEci: STA_POS,
                staVelEci: STA_VEL,
                obsType: 'range',
                values: [6781.2],
                sigmas: [1e-3],
            },
        ])
        expect(flat).toHaveLength(BATCH_OBS_HEADER_LEN + 2)
        expect(flat).toEqual([
            2460310.5, // time_jd
            1000, 2000, 3000, // sta_pos x3
            1, 2, 3, // sta_vel x3
            0, // obs_type = RANGE
            1, // ndim
            6781.2, // values(1)
            1e-3, // sigmas(1)
        ])
    })

    it('packs a ra_dec record as 9 header + 4 doubles (13 total)', () => {
        const flat = packBatchObsTable([
            {
                timeJd: 2460310.5,
                staPosEci: STA_POS,
                staVelEci: STA_VEL,
                obsType: 'ra_dec',
                values: [1.2, -0.3],
                sigmas: [1e-6, 2e-6],
            },
        ])
        expect(flat).toHaveLength(BATCH_OBS_HEADER_LEN + 4)
        expect(flat).toEqual([
            2460310.5,
            1000, 2000, 3000,
            1, 2, 3,
            2, // obs_type = RA_DEC
            2, // ndim
            1.2, -0.3, // values(2)
            1e-6, 2e-6, // sigmas(2)
        ])
    })

    it('packs mixed records with correct total length and field order', () => {
        const flat = packBatchObsTable([
            {
                timeJd: 1,
                staPosEci: STA_POS,
                staVelEci: STA_VEL,
                obsType: 'range',
                values: [10],
                sigmas: [0.1],
            },
            {
                timeJd: 2,
                staPosEci: STA_POS,
                staVelEci: STA_VEL,
                obsType: 'range_rate',
                values: [7.6],
                sigmas: [0.01],
            },
            {
                timeJd: 3,
                staPosEci: STA_POS,
                staVelEci: STA_VEL,
                obsType: 'ra_dec',
                values: [1, 2],
                sigmas: [3, 4],
            },
        ])
        // range 11 + range_rate 11 + ra_dec 13
        expect(flat).toHaveLength(35)
        // Record 2 starts at index 11: type code 1, ndim 1
        expect(flat[11 + 7]).toBe(1) // obs_type = RANGE_RATE
        expect(flat[11 + 8]).toBe(1) // ndim
        // Record 3 starts at index 22: type code 2, ndim 2, values then sigmas
        expect(flat[22 + 7]).toBe(2) // obs_type = RA_DEC
        expect(flat[22 + 8]).toBe(2) // ndim
        expect(flat.slice(22 + 9, 22 + 13)).toEqual([1, 2, 3, 4])
    })

    it('packs az_el with code 3 and ndim 2 (kernel rejects it as ERROR_INPUT)', () => {
        const flat = packBatchObsTable([
            {
                timeJd: 1,
                staPosEci: STA_POS,
                staVelEci: STA_VEL,
                obsType: 'az_el',
                values: [0.5, 0.3],
                sigmas: [5e-5, 5e-5],
            },
        ])
        expect(flat[7]).toBe(3)
        expect(flat[8]).toBe(2)
        expect(flat).toHaveLength(13)
    })
})

// =============================================================================
// packBatchConfig / packBatchAPriori
// =============================================================================

describe('packBatchConfig', () => {
    it('packs the exact config10 order from exports.cpp', () => {
        expect(packBatchConfig(DEFAULT_BATCH_CONFIG)).toEqual([
            DEFAULT_BATCH_CONFIG.mu,
            DEFAULT_BATCH_CONFIG.forceTier,
            DEFAULT_BATCH_CONFIG.maxIter,
            DEFAULT_BATCH_CONFIG.tolPosKm,
            DEFAULT_BATCH_CONFIG.tolVelKms,
            DEFAULT_BATCH_CONFIG.tolWrmsRel,
            DEFAULT_BATCH_CONFIG.sigmaEdit,
            DEFAULT_BATCH_CONFIG.editMaxFraction,
            DEFAULT_BATCH_CONFIG.editMaxRounds,
            1, // enableEditing defaults true
        ])
    })

    it('encodes enableEditing false as 0', () => {
        const flat = packBatchConfig({ ...DEFAULT_BATCH_CONFIG, enableEditing: false })
        expect(flat[9]).toBe(0)
        expect(flat).toHaveLength(10)
    })
})

describe('packBatchAPriori', () => {
    it('packs {x0(6), cov(36)} = 42 doubles', () => {
        const x0 = [1, 2, 3, 4, 5, 6]
        const cov = Array.from({ length: 36 }, (_, i) => i)
        const flat = packBatchAPriori({ x0, cov })
        expect(flat).toHaveLength(42)
        expect(flat.slice(0, 6)).toEqual(x0)
        expect(flat.slice(6)).toEqual(cov)
    })
})

// =============================================================================
// unpackBatchResult: flat result mapping
// =============================================================================

describe('unpackBatchResult mapping', () => {
    it('maps the 56-double header and residual rows to the typed result', () => {
        const result = unpackBatchResult(cannedFlat())
        expect(result).not.toBeNull()
        expect(result!.state).toEqual([6778.1, 123.4, 456.7, 1.5, -2.5, 7.6])
        expect(result!.covariance).toHaveLength(36)
        expect(result!.covariance[0]).toBeCloseTo(0)
        expect(result!.covariance[35]).toBeCloseTo(0.035)
        expect(result!.formalSigmas).toEqual([0.1, 0.2, 0.3, 1e-4, 2e-4, 3e-4])
        expect(result!.iterations).toBe(5)
        expect(result!.converged).toBe(true)
        expect(result!.wrms).toBe(0.98)
        expect(result!.reducedChi2).toBe(1.05)
        expect(result!.editedCount).toBe(2)
        expect(result!.nActive).toBe(58)
        expect(result!.errorStatus).toBe(BATCH_STATUS.OK)
        expect(result!.statusMessage).toBe(BATCH_STATUS_MESSAGES[BATCH_STATUS.OK])
    })

    it('maps residual rows: edited range row and active ra_dec row', () => {
        const result = unpackBatchResult(cannedFlat())
        expect(result!.residuals).toHaveLength(2)

        const range_row = result!.residuals[0]!
        expect(range_row.timeJd).toBe(2460310.5)
        expect(range_row.obsType).toBe('range')
        expect(range_row.value).toEqual([6781.2])
        expect(range_row.predicted).toEqual([6781.19])
        expect(range_row.residual).toEqual([0.01])
        expect(range_row.sigma).toEqual([1e-3])
        expect(range_row.normalized).toEqual([10])
        expect(range_row.edited).toBe(true)

        const ra_dec_row = result!.residuals[1]!
        expect(ra_dec_row.timeJd).toBe(2460310.51)
        expect(ra_dec_row.obsType).toBe('ra_dec')
        expect(ra_dec_row.value).toEqual([1.2, 0.3])
        expect(ra_dec_row.predicted).toEqual([1.19999, 0.30001])
        expect(ra_dec_row.residual).toEqual([1e-5, -1e-5])
        expect(ra_dec_row.sigma).toEqual([1e-6, 1e-6])
        expect(ra_dec_row.normalized).toEqual([10, -10])
        expect(ra_dec_row.edited).toBe(false)
    })

    it('honors n_residual_rows over the actual array length', () => {
        const result = unpackBatchResult(cannedFlat({ nResidualRows: 1 }))
        expect(result!.residuals).toHaveLength(1)
    })

    it('maps a reducedChi2 NaN to null', () => {
        const result = unpackBatchResult(cannedFlat({ reducedChi2: NaN }))
        expect(result!.reducedChi2).toBeNull()
    })

    it('maps error statuses with their messages', () => {
        const result = unpackBatchResult(
            cannedFlat({ status: BATCH_STATUS.ERROR_SINGULAR_N, converged: 0 })
        )
        expect(result!.errorStatus).toBe(BATCH_STATUS.ERROR_SINGULAR_N)
        expect(result!.converged).toBe(false)
        expect(result!.statusMessage).toBe(
            BATCH_STATUS_MESSAGES[BATCH_STATUS.ERROR_SINGULAR_N]
        )
    })

    it('falls back to a generic message for unknown status codes', () => {
        const result = unpackBatchResult(cannedFlat({ status: 99 }))
        expect(result!.statusMessage).toBe('Unknown batch OD status')
    })

    it('returns null for arrays shorter than the 56-double header', () => {
        expect(unpackBatchResult([1, 2, 3])).toBeNull()
        expect(unpackBatchResult([])).toBeNull()
        expect(unpackBatchResult(null)).toBeNull()
        expect(unpackBatchResult(undefined)).toBeNull()
    })

    it('truncates residual rows that overrun the flat array', () => {
        const flat = cannedFlat({ nResidualRows: 5 })
        // Header says 5 rows but only 2 are present.
        const result = unpackBatchResult(flat)
        expect(result!.residuals).toHaveLength(2)
        expect(flat.length).toBe(BATCH_RESULT_HEADER_LEN + 2 * BATCH_RESIDUAL_ROW_LEN)
    })
})

// =============================================================================
// runBatchSolve: exports.cpp call contract
// =============================================================================

describe('runBatchSolve call contract', () => {
    it('passes the packed table, state6, epoch, config10, and null apriori', () => {
        const od_batch_solve = batchSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_batch_solve })
        const result = runBatchSolve({
            observations: [makeObs()],
            stateGuess: STATE_GUESS,
            epochJd: 2460310.5,
        })
        expect(result).not.toBeNull()
        expect(od_batch_solve).toHaveBeenCalledTimes(1)
        const [obs_flat, state6, epoch_jd, config10, apriori42] = od_batch_solve.mock.calls[0]!
        expect(obs_flat).toEqual([
            2460310.5,
            STA1_POS.x, STA1_POS.y, STA1_POS.z,
            STA1_VEL.x, STA1_VEL.y, STA1_VEL.z,
            0, // RANGE
            1, // ndim
            6781.2,
            1e-3,
        ])
        expect(state6).toEqual(STATE_GUESS)
        expect(epoch_jd).toBe(2460310.5)
        expect(config10).toEqual(packBatchConfig(DEFAULT_BATCH_CONFIG))
        expect(apriori42).toBeNull()
    })

    it('resolves station geometry per observation epoch and maps types to codes', () => {
        const od_batch_solve = batchSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_batch_solve })
        mockStationPositionEci.mockReturnValue(STA1_POS)
        mockStationVelocityEci.mockReturnValue(STA1_VEL)
        runBatchSolve({
            observations: [
                makeObs(),
                makeObs({ timeJd: 2460310.51, obsType: 'range_rate', values: [7.6], sigmas: [1e-4] }),
                makeObs({
                    timeJd: 2460310.52,
                    stationId: 'sta-2',
                    obsType: 'ra_dec',
                    values: [1.2, -0.3],
                    sigmas: [1e-6, 1e-6],
                }),
            ],
            stateGuess: STATE_GUESS,
            epochJd: 2460310.5,
        })
        expect(mockStationPositionEci).toHaveBeenCalledWith(11, 2460310.5)
        expect(mockStationVelocityEci).toHaveBeenCalledWith(11, 2460310.5)
        expect(mockStationPositionEci).toHaveBeenCalledWith(22, 2460310.52)
        const obs_flat = od_batch_solve.mock.calls[0]![0]
        // range(11) + range_rate(11) + ra_dec(13)
        expect(obs_flat).toHaveLength(35)
        expect(obs_flat[11 + 7]).toBe(1) // RANGE_RATE code
        expect(obs_flat[22 + 7]).toBe(2) // RA_DEC code
        expect(obs_flat[22 + 8]).toBe(2) // ndim
    })

    it('resolves a numeric-string stationId as a raw WASM handle', () => {
        const od_batch_solve = batchSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_batch_solve })
        runBatchSolve({
            observations: [makeObs({ stationId: '11' })],
            stateGuess: STATE_GUESS,
            epochJd: 2460310.5,
        })
        expect(mockStationPositionEci).toHaveBeenCalledWith(11, 2460310.5)
    })

    it('applies config overrides through the config10 array', () => {
        const od_batch_solve = batchSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_batch_solve })
        runBatchSolve({
            observations: [makeObs()],
            stateGuess: STATE_GUESS,
            epochJd: 2460310.5,
            config: { maxIter: 7, enableEditing: false, sigmaEdit: 4.5 },
        })
        const config10 = od_batch_solve.mock.calls[0]![3]
        expect(config10).toEqual([
            DEFAULT_BATCH_CONFIG.mu,
            DEFAULT_BATCH_CONFIG.forceTier,
            7, // maxIter override
            DEFAULT_BATCH_CONFIG.tolPosKm,
            DEFAULT_BATCH_CONFIG.tolVelKms,
            DEFAULT_BATCH_CONFIG.tolWrmsRel,
            4.5, // sigmaEdit override
            DEFAULT_BATCH_CONFIG.editMaxFraction,
            DEFAULT_BATCH_CONFIG.editMaxRounds,
            0, // enableEditing false
        ])
    })

    it('packs an a-priori constraint as 42 doubles {x0(6), cov(36)}', () => {
        const od_batch_solve = batchSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_batch_solve })
        const x0 = [6778, 0, 0, 0, 7.6, 0]
        const cov = Array.from({ length: 36 }, (_, i) => (i % 7 === 0 ? 1 : 0) * 1e-6)
        runBatchSolve({
            observations: [makeObs()],
            stateGuess: STATE_GUESS,
            epochJd: 2460310.5,
            apriori: { x0, cov },
        })
        const apriori42 = od_batch_solve.mock.calls[0]![4]
        expect(apriori42).toHaveLength(42)
        expect(apriori42!.slice(0, 6)).toEqual(x0)
        expect(apriori42!.slice(6)).toEqual(cov)
    })
})

// =============================================================================
// runBatchSolve: null paths
// =============================================================================

describe('runBatchSolve null paths', () => {
    it('returns null when WASM is not ready', () => {
        mockGetWasmModule.mockReturnValue(null)
        expect(
            runBatchSolve({ observations: [makeObs()], stateGuess: STATE_GUESS, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when the od_batch_solve export is absent', () => {
        mockGetWasmModule.mockReturnValue({})
        expect(
            runBatchSolve({ observations: [makeObs()], stateGuess: STATE_GUESS, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when the state guess is not 6 values', () => {
        mockGetWasmModule.mockReturnValue({ od_batch_solve: batchSolveMock(cannedFlat()) })
        expect(
            runBatchSolve({ observations: [makeObs()], stateGuess: [1, 2, 3], epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when a stationId cannot be resolved to a handle', () => {
        const od_batch_solve = batchSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_batch_solve })
        expect(
            runBatchSolve({
                observations: [makeObs({ stationId: 'sta-999' })],
                stateGuess: STATE_GUESS,
                epochJd: 2460310.5,
            })
        ).toBeNull()
        expect(od_batch_solve).not.toHaveBeenCalled()
    })

    it('returns null when a station has a null WASM handle', () => {
        mockGetWasmModule.mockReturnValue({ od_batch_solve: batchSolveMock(cannedFlat()) })
        useODStore.setState({
            stations: STATIONS.map((s) => ({ ...s, handle: s.id === 'sta-1' ? null : s.handle })),
        })
        expect(
            runBatchSolve({ observations: [makeObs()], stateGuess: STATE_GUESS, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when station geometry cannot be resolved', () => {
        mockGetWasmModule.mockReturnValue({ od_batch_solve: batchSolveMock(cannedFlat()) })
        mockStationPositionEci.mockReturnValue(null)
        expect(
            runBatchSolve({ observations: [makeObs()], stateGuess: STATE_GUESS, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when values or sigmas are shorter than the type ndim', () => {
        const od_batch_solve = batchSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_batch_solve })
        expect(
            runBatchSolve({
                observations: [makeObs({ obsType: 'ra_dec', values: [1.2], sigmas: [1e-6] })],
                stateGuess: STATE_GUESS,
                epochJd: 2460310.5,
            })
        ).toBeNull()
        expect(
            runBatchSolve({
                observations: [makeObs({ obsType: 'range', values: [], sigmas: [1e-3] })],
                stateGuess: STATE_GUESS,
                epochJd: 2460310.5,
            })
        ).toBeNull()
        expect(od_batch_solve).not.toHaveBeenCalled()
    })

    it('returns null when the a-priori shapes are wrong', () => {
        const od_batch_solve = batchSolveMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_batch_solve })
        expect(
            runBatchSolve({
                observations: [makeObs()],
                stateGuess: STATE_GUESS,
                epochJd: 2460310.5,
                apriori: { x0: [1, 2, 3], cov: Array(36).fill(0) },
            })
        ).toBeNull()
        expect(
            runBatchSolve({
                observations: [makeObs()],
                stateGuess: STATE_GUESS,
                epochJd: 2460310.5,
                apriori: { x0: Array(6).fill(0), cov: [1, 2, 3] },
            })
        ).toBeNull()
        expect(od_batch_solve).not.toHaveBeenCalled()
    })

    it('returns null when the WASM call returns a short array', () => {
        mockGetWasmModule.mockReturnValue({ od_batch_solve: batchSolveMock([1, 2, 3]) })
        expect(
            runBatchSolve({ observations: [makeObs()], stateGuess: STATE_GUESS, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('returns null when the WASM call throws', () => {
        mockGetWasmModule.mockReturnValue({
            od_batch_solve: vi.fn(() => {
                throw new Error('bad geometry')
            }),
        })
        expect(
            runBatchSolve({ observations: [makeObs()], stateGuess: STATE_GUESS, epochJd: 2460310.5 })
        ).toBeNull()
    })

    it('surfaces the kernel ERROR_INPUT result for an empty observation list', () => {
        // The kernel validates empty input itself and returns a 56-double
        // ERROR_INPUT header with zero residual rows.
        const error_input_flat = cannedFlat({
            status: BATCH_STATUS.ERROR_INPUT,
            converged: 0,
            nResidualRows: 0,
        }).slice(0, BATCH_RESULT_HEADER_LEN)
        const od_batch_solve = batchSolveMock(error_input_flat)
        mockGetWasmModule.mockReturnValue({ od_batch_solve })
        const result = runBatchSolve({
            observations: [],
            stateGuess: STATE_GUESS,
            epochJd: 2460310.5,
        })
        expect(result).not.toBeNull()
        expect(result!.errorStatus).toBe(BATCH_STATUS.ERROR_INPUT)
        expect(result!.residuals).toHaveLength(0)
        expect(od_batch_solve.mock.calls[0]![0]).toEqual([])
    })
})

// =============================================================================
// getBatchConfigDefaults
// =============================================================================

describe('getBatchConfigDefaults', () => {
    it('prefers the WASM od_batch_config_defaults export', () => {
        const wasm_defaults = [
            3.986e5,
            0, // force_tier two-body
            20,
            2e-6,
            2e-9,
            2e-3,
            4.0,
            0.2,
            5,
            0, // enable_editing false
        ]
        mockGetWasmModule.mockReturnValue({
            od_batch_config_defaults: vi.fn(() => wasm_defaults),
        })
        expect(getBatchConfigDefaults()).toEqual({
            mu: 3.986e5,
            forceTier: 0,
            maxIter: 20,
            tolPosKm: 2e-6,
            tolVelKms: 2e-9,
            tolWrmsRel: 2e-3,
            sigmaEdit: 4.0,
            editMaxFraction: 0.2,
            editMaxRounds: 5,
            enableEditing: false,
        })
    })

    it('falls back to DEFAULT_BATCH_CONFIG when WASM is absent', () => {
        mockGetWasmModule.mockReturnValue(null)
        const defaults = getBatchConfigDefaults()
        expect(defaults).toEqual(DEFAULT_BATCH_CONFIG)
        expect(defaults).not.toBe(DEFAULT_BATCH_CONFIG)
    })

    it('falls back when the export is missing or throws', () => {
        mockGetWasmModule.mockReturnValue({})
        expect(getBatchConfigDefaults()).toEqual(DEFAULT_BATCH_CONFIG)
        mockGetWasmModule.mockReturnValue({
            od_batch_config_defaults: vi.fn(() => {
                throw new Error('boom')
            }),
        })
        expect(getBatchConfigDefaults()).toEqual(DEFAULT_BATCH_CONFIG)
    })
})
