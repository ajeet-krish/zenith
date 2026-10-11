import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createStation,
  destroyStation,
  stationPositionEci,
  stationVelocityEci,
  stationElevation,
  jd_to_gmst_ts,
  lla_to_ecef_ts,
} from '../stations'
import { getWasmModule } from '@/orbit/wasmLoader'
import { GOLDSTONE, ARECIBO, TROMSOE, CANONICAL_STATIONS, DEFAULT_OBS_CONFIG, SIGMA_RANGE_KM } from '../odConstants'
import { useODStore } from '@/store/useODStore'

vi.mock('@/orbit/wasmLoader', () => ({
  getWasmModule: vi.fn(() => null),
}))

const mockGetWasmModule = vi.mocked(getWasmModule)

function fakeModule(overrides?: Record<string, unknown>) {
  return {
    od_station_create: vi.fn(() => 42),
    od_station_destroy: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetWasmModule.mockReturnValue(null)
  useODStore.setState({
    stations: [],
    selectedStationId: null,
    observations: [],
    simConfig: { noiseScale: 1, cadenceSec: 60, arcHours: 1, stationNames: ['goldstone'] },
  })
})

// =============================================================================
// odConstants
// =============================================================================

describe('odConstants', () => {
  it('canonical stations have matching rad/deg representations', () => {
    for (const station of Object.values(CANONICAL_STATIONS)) {
      expect(station.latRad).toBeCloseTo((station.latDeg * Math.PI) / 180, 12)
      expect(station.lonRad).toBeCloseTo((station.lonDeg * Math.PI) / 180, 12)
    }
  })

  it('has goldstone, arecibo, tromsoe', () => {
    expect(GOLDSTONE.name).toBe('goldstone')
    expect(ARECIBO.name).toBe('arecibo')
    expect(TROMSOE.name).toBe('tromsoe')
  })

  it('default sigma for range is 1 m in km', () => {
    expect(SIGMA_RANGE_KM).toBe(1e-3)
    expect(DEFAULT_OBS_CONFIG.sigmaRangeKm).toBe(1e-3)
    expect(DEFAULT_OBS_CONFIG.sigmaAnglesRad).toEqual([1e-6, 1e-6])
  })
})

// =============================================================================
// createStation / destroyStation lifecycle
// =============================================================================

describe('createStation', () => {
  it('returns null when WASM is not ready', () => {
    expect(createStation('gs', 0.5, 1.0, 0.1)).toBeNull()
  })

  it('returns the WASM handle on success', () => {
    const mod = fakeModule()
    mockGetWasmModule.mockReturnValue(mod)
    expect(createStation('gs', 0.5, 1.0, 0.1)).toBe(42)
    expect(mod.od_station_create).toHaveBeenCalledWith('gs', 0.5, 1.0, 0.1)
  })

  it('returns null when WASM returns handle 0', () => {
    mockGetWasmModule.mockReturnValue(fakeModule({ od_station_create: vi.fn(() => 0) }))
    expect(createStation('gs', 0.5, 1.0, 0.1)).toBeNull()
  })

  it('returns null when WASM throws', () => {
    mockGetWasmModule.mockReturnValue(
      fakeModule({ od_station_create: vi.fn(() => { throw new Error('boom') }) })
    )
    expect(createStation('gs', 0.5, 1.0, 0.1)).toBeNull()
  })
})

describe('destroyStation', () => {
  it('calls od_station_destroy when WASM is ready', () => {
    const mod = fakeModule()
    mockGetWasmModule.mockReturnValue(mod)
    const h = createStation('gs', 0.5, 1.0, 0.1)
    destroyStation(h!)
    expect(mod.od_station_destroy).toHaveBeenCalledWith(42)
  })

  it('does not throw when WASM is not ready', () => {
    expect(() => destroyStation(7)).not.toThrow()
  })

  it('does not throw when od_station_destroy throws', () => {
    mockGetWasmModule.mockReturnValue(
      fakeModule({ od_station_destroy: vi.fn(() => { throw new Error('bad handle') }) })
    )
    expect(() => destroyStation(99)).not.toThrow()
  })
})

// =============================================================================
// Station geometry (TS fallback from registry)
// =============================================================================

describe('station geometry fallback', () => {
  it('stationPositionEci returns null for unknown handle', () => {
    expect(stationPositionEci(12345, 2451545.0)).toBeNull()
  })

  it('stationPositionEci computes ECI position from registry geometry', () => {
    const mod = fakeModule()
    mockGetWasmModule.mockReturnValue(mod)
    const h = createStation('goldstone', GOLDSTONE.latRad, GOLDSTONE.lonRad, GOLDSTONE.altKm)!
    const pos = stationPositionEci(h, 2451545.0)
    expect(pos).not.toBeNull()
    // Magnitude is roughly Earth radius + altitude.
    const mag = Math.sqrt(pos!.x ** 2 + pos!.y ** 2 + pos!.z ** 2)
    expect(mag).toBeGreaterThan(6300)
    expect(mag).toBeLessThan(6500)
  })

  it('stationVelocityEci is omega x r of the position', () => {
    const mod = fakeModule()
    mockGetWasmModule.mockReturnValue(mod)
    const h = createStation('gs', 0.5, 1.0, 0.1)!
    const jd = 2451545.25
    const pos = stationPositionEci(h, jd)!
    const vel = stationVelocityEci(h, jd)!
    const omega = 7.2921151467e-5
    expect(vel.x).toBeCloseTo(-omega * pos.y, 12)
    expect(vel.y).toBeCloseTo(omega * pos.x, 12)
    expect(vel.z).toBe(0)
  })

  it('stationElevation is positive for a zenith target and null for unknown handle', () => {
    const mod = fakeModule()
    mockGetWasmModule.mockReturnValue(mod)
    const h = createStation('gs', 0.0, 0.0, 0.0)!
    const pos = stationPositionEci(h, 2451545.0)!
    // Scale the station position outward: target directly overhead.
    const scale = 7000 / Math.sqrt(pos.x ** 2 + pos.y ** 2 + pos.z ** 2)
    const zenith = { x: pos.x * scale, y: pos.y * scale, z: pos.z * scale }
    const el = stationElevation(h, zenith, 2451545.0)
    expect(el).not.toBeNull()
    expect(el!).toBeGreaterThan(1.5)  // near PI/2
    expect(stationElevation(999999, zenith, 2451545.0)).toBeNull()
  })
})

describe('ts geometry helpers', () => {
  it('jd_to_gmst_ts matches J2000 expected range', () => {
    const gmst = jd_to_gmst_ts(2451545.0)
    expect(gmst).toBeGreaterThanOrEqual(0)
    expect(gmst).toBeLessThanOrEqual(2 * Math.PI)
  })

  it('lla_to_ecef_ts puts equatorial station on +x axis', () => {
    const [x, y, z] = lla_to_ecef_ts(0, 0, 0)
    expect(x).toBeCloseTo(6378.137, 6)
    expect(y).toBeCloseTo(0, 12)
    expect(z).toBeCloseTo(0, 12)
  })
})

// =============================================================================
// Store lifecycle (addStation/removeStation with real stations.ts)
// =============================================================================

describe('useODStore station lifecycle via WASM', () => {
  it('addStation stores handle from WASM', () => {
    const mod = fakeModule()
    mockGetWasmModule.mockReturnValue(mod)
    useODStore.getState().addStation('goldstone', GOLDSTONE.latRad, GOLDSTONE.lonRad, GOLDSTONE.altKm)
    const { stations } = useODStore.getState()
    expect(stations).toHaveLength(1)
    expect(stations[0]!.handle).toBe(42)
    expect(stations[0]!.name).toBe('goldstone')
  })

  it('addStation stores null handle when WASM is not ready', () => {
    useODStore.getState().addStation('goldstone', 0.5, 1.0, 0.1)
    expect(useODStore.getState().stations[0]!.handle).toBeNull()
  })

  it('removeStation destroys the WASM handle', () => {
    const mod = fakeModule()
    mockGetWasmModule.mockReturnValue(mod)
    const store = useODStore.getState()
    store.addStation('goldstone', 0.5, 1.0, 0.1)
    const id = useODStore.getState().stations[0]!.id
    useODStore.getState().removeStation(id)
    expect(mod.od_station_destroy).toHaveBeenCalledWith(42)
    expect(useODStore.getState().stations).toHaveLength(0)
  })
})
