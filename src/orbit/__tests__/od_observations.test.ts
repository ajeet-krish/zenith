import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  predictObservation,
  measurementPartials,
  simulateObservations,
  mulberry32,
  box_muller_gaussian,
} from '../observations'
import type { TruthState } from '../observations'
import { getWasmModule } from '@/orbit/wasmLoader'
import { SIGMA_RANGE_KM } from '../odConstants'

vi.mock('@/orbit/wasmLoader', () => ({
  getWasmModule: vi.fn(() => null),
}))

const mockGetWasmModule = vi.mocked(getWasmModule)

const R = { x: 6781.0, y: 1000.0, z: 2000.0 }
const V = { x: 1.0, y: 7.0, z: 2.0 }
const JD = 2451545.5

beforeEach(() => {
  vi.clearAllMocks()
  mockGetWasmModule.mockReturnValue(null)
})

// =============================================================================
// predictObservation
// =============================================================================

describe('predictObservation', () => {
  it('returns null when WASM is not loaded', () => {
    expect(predictObservation(1, R, V, JD)).toBeNull()
  })

  it('maps the flat WASM array to a typed object', () => {
    mockGetWasmModule.mockReturnValue({
      od_predict_observation: vi.fn(() => [6512.9, 5.22, 0.95, -0.26, 1.61, -0.39]),
    })
    const pred = predictObservation(1, R, V, JD)
    expect(pred).toEqual({
      rangeKm: 6512.9,
      rangeRateKms: 5.22,
      raRad: 0.95,
      decRad: -0.26,
      azRad: 1.61,
      elRad: -0.39,
    })
  })

  it('returns null for short arrays and thrown errors', () => {
    mockGetWasmModule.mockReturnValue({ od_predict_observation: vi.fn(() => [1, 2]) })
    expect(predictObservation(1, R, V, JD)).toBeNull()

    mockGetWasmModule.mockReturnValue({
      od_predict_observation: vi.fn(() => { throw new Error('bad handle') }),
    })
    expect(predictObservation(1, R, V, JD)).toBeNull()
  })
})

// =============================================================================
// measurementPartials
// =============================================================================

describe('measurementPartials', () => {
  it('returns null when WASM is not loaded', () => {
    expect(measurementPartials(1, R, V, JD)).toBeNull()
  })

  it('splits the flat row-major arrays into per-type rows', () => {
    const range_row = [0.55, 0.78, -0.25, 0, 0, 0]
    const range_rate_row = [-3.3e-4, 4.0e-4, 5.1e-4, 0.55, 0.78, -0.25]
    const ra_row = [1e-5, 2e-5, 3e-5, 0, 0, 0]
    const dec_row = [4e-5, 5e-5, 6e-5, 0, 0, 0]
    const mockPartials = vi.fn((_station_h: number, obs_type: number) => {
      if (obs_type === 0) return [1, ...range_row]
      if (obs_type === 1) return [1, ...range_rate_row]
      return [2, ...ra_row, ...dec_row]
    })
    mockGetWasmModule.mockReturnValue({ od_measurement_partials: mockPartials })

    const h = measurementPartials(1, R, V, JD)
    expect(h).not.toBeNull()
    expect(h!.rangeH).toEqual(range_row)
    expect(h!.rangeRateH).toEqual(range_rate_row)
    expect(h!.raH).toEqual(ra_row)
    expect(h!.decH).toEqual(dec_row)
    // One call per type: range, range_rate, ra_dec.
    expect(mockPartials).toHaveBeenCalledTimes(3)
  })

  it('returns null when the WASM result is malformed', () => {
    mockGetWasmModule.mockReturnValue({
      od_measurement_partials: vi.fn(() => null),
    })
    expect(measurementPartials(1, R, V, JD)).toBeNull()
  })
})

// =============================================================================
// PRNG
// =============================================================================

describe('mulberry32 + box_muller', () => {
  it('mulberry32 is deterministic for the same seed', () => {
    const a = mulberry32(123)
    const b = mulberry32(123)
    for (let i = 0; i < 10; i++) {
      expect(a()).toBe(b())
    }
  })

  it('uniforms stay in [0, 1)', () => {
    const rand = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const u = rand()
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
    }
  })

  it('box_muller draws have ~N(0,1) statistics', () => {
    const rand = mulberry32(99)
    const n = 5000
    let sum = 0
    let sum_sq = 0
    for (let i = 0; i < n; i++) {
      const g = box_muller_gaussian(rand)
      sum += g
      sum_sq += g * g
    }
    const mean = sum / n
    const variance = sum_sq / n - mean * mean
    expect(Math.abs(mean)).toBeLessThan(0.05)
    expect(variance).toBeGreaterThan(0.9)
    expect(variance).toBeLessThan(1.1)
  })
})

// =============================================================================
// TS observation simulator
// =============================================================================

function fakePredictModule() {
  return {
    od_predict_observation: vi.fn((_h: number, rx: number, ry: number, rz: number) => {
      // Deterministic pseudo-truth derived from the position input.
      const range = Math.sqrt(rx * rx + ry * ry + rz * rz)
      return [range, 5.0, 0.9, -0.3, 1.5, 0.4]
    }),
  }
}

function makeTruthStates(n: number): TruthState[] {
  const states: TruthState[] = []
  for (let i = 0; i < n; i++) {
    states.push({
      jd: 2451545.5 + i / 1440,
      r: { x: 6781 + i, y: 1000, z: 2000 },
      v: { x: 1, y: 7, z: 2 },
    })
  }
  return states
}

describe('simulateObservations', () => {
  it('returns null when WASM prediction is unavailable', () => {
    expect(simulateObservations(1, makeTruthStates(2), { noiseScale: 0, seed: 42 })).toBeNull()
  })

  it('returns an empty array for an empty truth_states input', () => {
    const mod = fakePredictModule()
    mockGetWasmModule.mockReturnValue(mod)
    const obs = simulateObservations(1, [], { noiseScale: 0, seed: 42 })
    expect(obs).toEqual([])
    // No epochs means no WASM prediction calls.
    expect(mod.od_predict_observation).not.toHaveBeenCalled()
  })

  it('emits one observation per epoch per type', () => {
    mockGetWasmModule.mockReturnValue(fakePredictModule())
    const obs = simulateObservations(1, makeTruthStates(3), { noiseScale: 0, seed: 42 })
    expect(obs).not.toBeNull()
    expect(obs!).toHaveLength(12)  // 3 epochs x 4 types
    expect(obs![0]!.obsType).toBe('range')
    expect(obs![0]!.values).toHaveLength(1)
    expect(obs![2]!.obsType).toBe('ra_dec')
    expect(obs![2]!.values).toHaveLength(2)
  })

  it('noiseScale 0 returns exact truth values', () => {
    mockGetWasmModule.mockReturnValue(fakePredictModule())
    const states = makeTruthStates(2)
    const obs = simulateObservations(1, states, { noiseScale: 0, seed: 42 })
    expect(obs![0]!.values[0]).toBeCloseTo(Math.sqrt(6781 ** 2 + 1000 ** 2 + 2000 ** 2), 6)
    expect(obs![1]!.values[0]).toBe(5.0)  // range_rate
  })

  it('is bit-identical for the same seed', () => {
    mockGetWasmModule.mockReturnValue(fakePredictModule())
    const states = makeTruthStates(5)
    const a = simulateObservations(1, states, { noiseScale: 1, seed: 42 })
    const b = simulateObservations(1, states, { noiseScale: 1, seed: 42 })
    expect(a).toEqual(b)
  })

  it('differs for different seeds', () => {
    mockGetWasmModule.mockReturnValue(fakePredictModule())
    const states = makeTruthStates(5)
    const a = simulateObservations(1, states, { noiseScale: 1, seed: 42 })
    const b = simulateObservations(1, states, { noiseScale: 1, seed: 7 })
    expect(a).not.toEqual(b)
  })

  it('range noise is statistically consistent with the sigma', () => {
    mockGetWasmModule.mockReturnValue(fakePredictModule())
    // Many epochs of the same geometry so the truth value is constant.
    const states = makeTruthStates(2000).map((s) => ({ ...s, r: { x: 6781, y: 1000, z: 2000 } }))
    const obs = simulateObservations(1, states, {
      noiseScale: 1,
      seed: 1234,
      obsTypes: ['range'],
    })
    expect(obs).toHaveLength(2000)
    const truth = Math.sqrt(6781 ** 2 + 1000 ** 2 + 2000 ** 2)
    const residuals = obs!.map((o) => o.values[0]! - truth)
    const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length
    const variance =
      residuals.reduce((a, r) => a + (r - mean) * (r - mean), 0) / residuals.length
    const stderr = SIGMA_RANGE_KM / Math.sqrt(residuals.length)
    expect(Math.abs(mean)).toBeLessThan(5 * stderr)
    // Sample stddev within 20% of the configured sigma.
    expect(Math.sqrt(variance)).toBeGreaterThan(0.8 * SIGMA_RANGE_KM)
    expect(Math.sqrt(variance)).toBeLessThan(1.2 * SIGMA_RANGE_KM)
  })

  it('stamps stationId onto returned observations', () => {
    mockGetWasmModule.mockReturnValue(fakePredictModule())
    const obs = simulateObservations(1, makeTruthStates(1), {
      noiseScale: 0,
      seed: 1,
      stationId: 'sta-1',
    })
    expect(obs![0]!.stationId).toBe('sta-1')
  })
})
