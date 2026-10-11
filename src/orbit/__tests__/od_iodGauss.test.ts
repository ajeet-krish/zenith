import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runGaussIod, runHerrickGibbs } from '../iodGauss'
import { getWasmModule } from '@/orbit/wasmLoader'
import { useODStore } from '@/store/useODStore'
import { DEFAULT_GAUSS_IOD_CONFIG } from '../odConstants'
import { GAUSS_IOD_STATUS, GAUSS_IOD_STATUS_MESSAGES } from '../types'
import type { GaussIodObservation } from '../types'

vi.mock('@/orbit/wasmLoader', () => ({
    getWasmModule: vi.fn(() => null),
}))

const mockGetWasmModule = vi.mocked(getWasmModule)

// Three store stations with WASM handles (ids resolve to handles 11/22/33).
const STATIONS = [
    { id: 'sta-1', name: 'goldstone', latRad: 0.6, lonRad: -2.0, altKm: 1.0, handle: 11 },
    { id: 'sta-2', name: 'arecibo', latRad: 0.3, lonRad: -1.2, altKm: 0.4, handle: 22 },
    { id: 'sta-3', name: 'tromsoe', latRad: 1.2, lonRad: 0.3, altKm: 0.1, handle: 33 },
]

function makeObs(overrides?: Partial<GaussIodObservation>): GaussIodObservation[] {
    return [
        { epochJd: 2460310.5, raRad: 1.2, decRad: -0.3, stationId: 'sta-1' },
        { epochJd: 2460310.5069444445, raRad: 3.6, decRad: 0.9, stationId: 'sta-2' },
        { epochJd: 2460310.5138888889, raRad: 2.7, decRad: 0.1, stationId: 'sta-3' },
        ].map((o) => ({ ...o, ...overrides }))
}

/** Canned 16-double result: r[3], v[3], converged, iterations, residual_norm,
 *  cond_number, error_code, ranges[3], pad[2] (exports.cpp layout). */
function cannedFlat(overrides?: { converged?: number; status?: number }): number[] {
    const flat = [
        6778.1, 123.4, 456.7,          // r [km]
        1.5, -2.5, 7.6,                // v [km/s]
        1,                             // converged
        4,                             // iterations
        5e-7,                          // residual_norm [rad]
        1.2e6,                         // cond_number
        GAUSS_IOD_STATUS.OK,           // error_code
        1500.1, 1500.2, 1500.3,        // ranges [km]
        0, 0,                          // pad
    ]
    if (overrides?.converged !== undefined) flat[6] = overrides.converged
    if (overrides?.status !== undefined) flat[10] = overrides.status
    return flat
}

/** Typed mock for od_gauss_iod: (h1, h2, h3, obs12, config6) -> 16 doubles. */
function gaussIodMock(flat: number[]) {
    return vi.fn((_h1: number, _h2: number, _h3: number, _obs12: number[], _config6: number[]) => flat)
}

/** Typed mock for od_herrick_gibbs: 12 position/time scalars + mu -> object. */
function herrickGibbsMock(result: { vx: number; vy: number; vz: number; status: number }) {
    return vi.fn((..._args: number[]) => result)
}

beforeEach(() => {
    vi.clearAllMocks()
    mockGetWasmModule.mockReturnValue(null)
    useODStore.setState({
        stations: STATIONS.map((s) => ({ ...s })),
        selectedStationId: null,
        observations: [],
        simConfig: { noiseScale: 1, cadenceSec: 60, arcHours: 1, stationNames: ['goldstone'] },
        iodResult: null,
    })
})

// =============================================================================
// runGaussIod: flat result mapping
// =============================================================================

describe('runGaussIod result mapping', () => {
    it('maps a canned 16-double flat result to the typed result', () => {
        mockGetWasmModule.mockReturnValue({ od_gauss_iod: vi.fn(() => cannedFlat()) })
        const result = runGaussIod(makeObs())
        expect(result).not.toBeNull()
        expect(result!.r).toEqual([6778.1, 123.4, 456.7])
        expect(result!.v).toEqual([1.5, -2.5, 7.6])
        expect(result!.converged).toBe(true)
        expect(result!.iterations).toBe(4)
        expect(result!.residualNorm).toBe(5e-7)
        expect(result!.conditionNumber).toBe(1.2e6)
        expect(result!.status).toBe(GAUSS_IOD_STATUS.OK)
        expect(result!.statusMessage).toBe(GAUSS_IOD_STATUS_MESSAGES[GAUSS_IOD_STATUS.OK])
        expect(result!.ranges).toEqual([1500.1, 1500.2, 1500.3])
    })

    it('treats WARNING_ILL_CONDITIONED as converged with its message', () => {
        mockGetWasmModule.mockReturnValue({
            od_gauss_iod: vi.fn(() =>
                cannedFlat({ converged: 1, status: GAUSS_IOD_STATUS.WARNING_ILL_CONDITIONED })
            ),
        })
        const result = runGaussIod(makeObs())
        expect(result!.converged).toBe(true)
        expect(result!.status).toBe(GAUSS_IOD_STATUS.WARNING_ILL_CONDITIONED)
        expect(result!.statusMessage).toBe(
            GAUSS_IOD_STATUS_MESSAGES[GAUSS_IOD_STATUS.WARNING_ILL_CONDITIONED]
        )
    })

    it('maps error statuses as not converged with their message', () => {
        mockGetWasmModule.mockReturnValue({
            od_gauss_iod: vi.fn(() =>
                cannedFlat({ converged: 0, status: GAUSS_IOD_STATUS.ERROR_INCONSISTENT_ROOTS })
            ),
        })
        const result = runGaussIod(makeObs())
        expect(result!.converged).toBe(false)
        expect(result!.status).toBe(GAUSS_IOD_STATUS.ERROR_INCONSISTENT_ROOTS)
        expect(result!.statusMessage).toBe(
            GAUSS_IOD_STATUS_MESSAGES[GAUSS_IOD_STATUS.ERROR_INCONSISTENT_ROOTS]
        )
    })

    it('falls back to a generic message for unknown status codes', () => {
        mockGetWasmModule.mockReturnValue({
            od_gauss_iod: vi.fn(() => cannedFlat({ converged: 0, status: 99 })),
        })
        const result = runGaussIod(makeObs())
        expect(result!.status).toBe(99)
        expect(result!.statusMessage).toBe('Unknown Gauss IOD status')
    })
})

// =============================================================================
// runGaussIod: exports.cpp flat-array contract
// =============================================================================

describe('runGaussIod exports.cpp contract', () => {
    it('passes station handles and 12-double obs array with stride-4 padding', () => {
        const od_gauss_iod = gaussIodMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_gauss_iod })
        runGaussIod(makeObs())
        expect(od_gauss_iod).toHaveBeenCalledTimes(1)
        const [h1, h2, h3, obs12] = od_gauss_iod.mock.calls[0]!
        expect(h1).toBe(11)
        expect(h2).toBe(22)
        expect(h3).toBe(33)
        expect(obs12).toEqual([
            2460310.5, 1.2, -0.3, 0,
            2460310.5069444445, 3.6, 0.9, 0,
            2460310.5138888889, 2.7, 0.1, 0,
        ])
    })

    it('passes default config in the exact {mu, tol, corr, iter, cond_singular, cond_warning} order', () => {
        const od_gauss_iod = gaussIodMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_gauss_iod })
        runGaussIod(makeObs())
        const config6 = od_gauss_iod.mock.calls[0]![4]
        expect(config6).toEqual([
            DEFAULT_GAUSS_IOD_CONFIG.mu,
            DEFAULT_GAUSS_IOD_CONFIG.residualTolRad,
            1, // enableCorrection defaults true
            DEFAULT_GAUSS_IOD_CONFIG.maxDcIter,
            DEFAULT_GAUSS_IOD_CONFIG.condSingular,  // index 4 (swapped vs struct order)
            DEFAULT_GAUSS_IOD_CONFIG.condWarning,   // index 5
        ])
        expect(config6).toHaveLength(6)
    })

    it('applies config overrides (mu, enableCorrection false, maxDcIter)', () => {
        const od_gauss_iod = gaussIodMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_gauss_iod })
        runGaussIod(makeObs(), { mu: 123456, enableCorrection: false, maxDcIter: 7 })
        const config6 = od_gauss_iod.mock.calls[0]![4]
        expect(config6).toEqual([
            123456,
            DEFAULT_GAUSS_IOD_CONFIG.residualTolRad,
            0,
            7,
            DEFAULT_GAUSS_IOD_CONFIG.condSingular,
            DEFAULT_GAUSS_IOD_CONFIG.condWarning,
        ])
    })
})

// =============================================================================
// runGaussIod: null paths
// =============================================================================

describe('runGaussIod null paths', () => {
    it('returns null when WASM is not ready', () => {
        mockGetWasmModule.mockReturnValue(null)
        expect(runGaussIod(makeObs())).toBeNull()
    })

    it('returns null when the od_gauss_iod export is absent', () => {
        mockGetWasmModule.mockReturnValue({})
        expect(runGaussIod(makeObs())).toBeNull()
    })

    it('returns null for 2 observations', () => {
        mockGetWasmModule.mockReturnValue({ od_gauss_iod: vi.fn(() => cannedFlat()) })
        expect(runGaussIod(makeObs().slice(0, 2))).toBeNull()
    })

    it('returns null for 4 observations', () => {
        mockGetWasmModule.mockReturnValue({ od_gauss_iod: vi.fn(() => cannedFlat()) })
        const four = [...makeObs(), makeObs()[0]!]
        expect(runGaussIod(four)).toBeNull()
    })

    it('returns null when a stationId cannot be resolved to a handle', () => {
        const od_gauss_iod = vi.fn(() => cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_gauss_iod })
        const obs = makeObs()
        obs[1] = { ...obs[1]!, stationId: 'sta-999' }
        expect(runGaussIod(obs)).toBeNull()
        expect(od_gauss_iod).not.toHaveBeenCalled()
    })

    it('returns null when a station has a null WASM handle', () => {
        mockGetWasmModule.mockReturnValue({ od_gauss_iod: vi.fn(() => cannedFlat()) })
        useODStore.setState({
            stations: STATIONS.map((s) => ({ ...s, handle: s.id === 'sta-2' ? null : s.handle })),
        })
        expect(runGaussIod(makeObs())).toBeNull()
    })

    it('resolves a numeric-string stationId as a raw WASM handle', () => {
        const od_gauss_iod = gaussIodMock(cannedFlat())
        mockGetWasmModule.mockReturnValue({ od_gauss_iod })
        const obs = makeObs()
        obs[0] = { ...obs[0]!, stationId: '11' }
        obs[1] = { ...obs[1]!, stationId: '22' }
        obs[2] = { ...obs[2]!, stationId: '33' }
        expect(runGaussIod(obs)).not.toBeNull()
        expect(od_gauss_iod.mock.calls[0]![0]).toBe(11)
        expect(od_gauss_iod.mock.calls[0]![1]).toBe(22)
        expect(od_gauss_iod.mock.calls[0]![2]).toBe(33)
    })

    it('returns null when the WASM result is shorter than 16 doubles', () => {
        mockGetWasmModule.mockReturnValue({ od_gauss_iod: vi.fn(() => [1, 2, 3]) })
        expect(runGaussIod(makeObs())).toBeNull()
    })

    it('returns null when the WASM call throws', () => {
        mockGetWasmModule.mockReturnValue({
            od_gauss_iod: vi.fn(() => { throw new Error('bad geometry') }),
        })
        expect(runGaussIod(makeObs())).toBeNull()
    })
})

// =============================================================================
// runHerrickGibbs
// =============================================================================

describe('runHerrickGibbs', () => {
    const R1 = { x: 5981.66, y: 1980.17, z: 2498.35 }
    const R2 = { x: 5870.04, y: 2105.11, z: 2655.99 }
    const R3 = { x: 5751.65, y: 2227.63, z: 2810.57 }

    it('maps the WASM object result to the typed result', () => {
        const od_herrick_gibbs = vi.fn(() => ({ vx: -3.8, vy: 4.1, vz: 5.2, status: 0 }))
        mockGetWasmModule.mockReturnValue({ od_herrick_gibbs })
        const result = runHerrickGibbs(R1, R2, R3, -30, 0, 30)
        expect(result).not.toBeNull()
        expect(result!.v).toEqual([-3.8, 4.1, 5.2])
        expect(result!.status).toBe(GAUSS_IOD_STATUS.OK)
        expect(result!.statusMessage).toBe(GAUSS_IOD_STATUS_MESSAGES[GAUSS_IOD_STATUS.OK])
    })

    it('passes positions, times, and default Earth mu to the WASM export', () => {
        const od_herrick_gibbs = vi.fn(() => ({ vx: 0, vy: 0, vz: 0, status: 0 }))
        mockGetWasmModule.mockReturnValue({ od_herrick_gibbs })
        runHerrickGibbs(R1, R2, R3, -30, 0, 30)
        expect(od_herrick_gibbs).toHaveBeenCalledWith(
            R1.x, R1.y, R1.z,
            R2.x, R2.y, R2.z,
            R3.x, R3.y, R3.z,
            -30, 0, 30,
            DEFAULT_GAUSS_IOD_CONFIG.mu
        )
    })

    it('passes a custom mu through', () => {
        const od_herrick_gibbs = herrickGibbsMock({ vx: 0, vy: 0, vz: 0, status: 0 })
        mockGetWasmModule.mockReturnValue({ od_herrick_gibbs })
        runHerrickGibbs(R1, R2, R3, -30, 0, 30, 123456)
        expect(od_herrick_gibbs.mock.calls[0]![12]).toBe(123456)
    })

    it('maps ERROR_INPUT status for non-increasing epochs', () => {
        const od_herrick_gibbs = vi.fn(() => ({ vx: 0, vy: 0, vz: 0, status: GAUSS_IOD_STATUS.ERROR_INPUT }))
        mockGetWasmModule.mockReturnValue({ od_herrick_gibbs })
        const result = runHerrickGibbs(R1, R2, R3, 30, 0, -30)
        expect(result!.status).toBe(GAUSS_IOD_STATUS.ERROR_INPUT)
        expect(result!.statusMessage).toBe(GAUSS_IOD_STATUS_MESSAGES[GAUSS_IOD_STATUS.ERROR_INPUT])
    })

    it('returns null when WASM is not ready', () => {
        expect(runHerrickGibbs(R1, R2, R3, -30, 0, 30)).toBeNull()
    })

    it('returns null when the od_herrick_gibbs export is absent', () => {
        mockGetWasmModule.mockReturnValue({})
        expect(runHerrickGibbs(R1, R2, R3, -30, 0, 30)).toBeNull()
    })

    it('returns null when the WASM call throws', () => {
        mockGetWasmModule.mockReturnValue({
            od_herrick_gibbs: vi.fn(() => { throw new Error('boom') }),
        })
        expect(runHerrickGibbs(R1, R2, R3, -30, 0, 30)).toBeNull()
    })
})
