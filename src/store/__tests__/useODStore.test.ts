import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useODStore } from '../useODStore'
import { createStation, destroyStation } from '@/orbit/stations'
import type { ODObservation } from '@/orbit/types'

vi.mock('@/orbit/stations', () => ({
  createStation: vi.fn(() => 101),
  destroyStation: vi.fn(),
}))

const mockCreateStation = vi.mocked(createStation)
const mockDestroyStation = vi.mocked(destroyStation)

const GOLDSTONE = { name: 'goldstone', latRad: 0.6178, lonRad: -2.0384, altKm: 1.0 }

function makeObs(overrides?: Partial<ODObservation>): ODObservation {
  return {
    timeJd: 2451545.5,
    stationId: 'sta-1',
    obsType: 'range',
    values: [6781.2],
    sigmas: [1e-3],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateStation.mockReturnValue(101)
  useODStore.setState({
    stations: [],
    selectedStationId: null,
    observations: [],
    simConfig: { noiseScale: 1, cadenceSec: 60, arcHours: 1, stationNames: ['goldstone'] },
  })
})

// =============================================================================
// Initial State
// =============================================================================

describe('Initial State', () => {
  it('stations is empty', () => {
    expect(useODStore.getState().stations).toEqual([])
  })

  it('selectedStationId is null', () => {
    expect(useODStore.getState().selectedStationId).toBeNull()
  })

  it('observations is empty', () => {
    expect(useODStore.getState().observations).toEqual([])
  })

  it('simConfig has defaults', () => {
    expect(useODStore.getState().simConfig).toEqual({
      noiseScale: 1,
      cadenceSec: 60,
      arcHours: 1,
      stationNames: ['goldstone'],
    })
  })
})

// =============================================================================
// addStation
// =============================================================================

describe('addStation', () => {
  it('creates a WASM station and stores the handle', () => {
    useODStore.getState().addStation(GOLDSTONE.name, GOLDSTONE.latRad, GOLDSTONE.lonRad, GOLDSTONE.altKm)
    expect(mockCreateStation).toHaveBeenCalledWith(
      GOLDSTONE.name,
      GOLDSTONE.latRad,
      GOLDSTONE.lonRad,
      GOLDSTONE.altKm
    )
    const stations = useODStore.getState().stations
    expect(stations).toHaveLength(1)
    expect(stations[0]!.name).toBe('goldstone')
    expect(stations[0]!.handle).toBe(101)
    expect(stations[0]!.id).toMatch(/^sta-\d+$/)
  })

  it('assigns stable unique ids', () => {
    const store = useODStore.getState()
    store.addStation('a', 0.1, 0.2, 0.3)
    mockCreateStation.mockReturnValue(102)
    useODStore.getState().addStation('b', 0.4, 0.5, 0.6)
    const [a, b] = useODStore.getState().stations
    expect(a!.id).not.toBe(b!.id)
    expect(a!.handle).toBe(101)
    expect(b!.handle).toBe(102)
  })

  it('stores null handle when createStation returns null (no WASM)', () => {
    mockCreateStation.mockReturnValue(null)
    useODStore.getState().addStation(GOLDSTONE.name, 0.5, 1.0, 0.1)
    expect(useODStore.getState().stations[0]!.handle).toBeNull()
  })
})

// =============================================================================
// removeStation
// =============================================================================

describe('removeStation', () => {
  it('destroys the WASM handle and removes the station', () => {
    useODStore.getState().addStation(GOLDSTONE.name, 0.5, 1.0, 0.1)
    const id = useODStore.getState().stations[0]!.id
    useODStore.getState().removeStation(id)
    expect(mockDestroyStation).toHaveBeenCalledWith(101)
    expect(useODStore.getState().stations).toHaveLength(0)
  })

  it('does not call destroyStation for null handles', () => {
    mockCreateStation.mockReturnValue(null)
    useODStore.getState().addStation(GOLDSTONE.name, 0.5, 1.0, 0.1)
    const id = useODStore.getState().stations[0]!.id
    useODStore.getState().removeStation(id)
    expect(mockDestroyStation).not.toHaveBeenCalled()
    expect(useODStore.getState().stations).toHaveLength(0)
  })

  it('clears selectedStationId when the selected station is removed', () => {
    useODStore.getState().addStation(GOLDSTONE.name, 0.5, 1.0, 0.1)
    const id = useODStore.getState().stations[0]!.id
    useODStore.getState().selectStation(id)
    useODStore.getState().removeStation(id)
    expect(useODStore.getState().selectedStationId).toBeNull()
  })

  it('keeps selectedStationId when a different station is removed', () => {
    useODStore.getState().addStation('a', 0.1, 0.2, 0.3)
    mockCreateStation.mockReturnValue(102)
    useODStore.getState().addStation('b', 0.4, 0.5, 0.6)
    const [a, b] = useODStore.getState().stations
    useODStore.getState().selectStation(a!.id)
    useODStore.getState().removeStation(b!.id)
    expect(useODStore.getState().selectedStationId).toBe(a!.id)
  })

  it('is a no-op for unknown ids', () => {
    useODStore.getState().removeStation('sta-999')
    expect(mockDestroyStation).not.toHaveBeenCalled()
    expect(useODStore.getState().stations).toHaveLength(0)
  })
})

// =============================================================================
// selectStation
// =============================================================================

describe('selectStation', () => {
  it('sets the selected id', () => {
    useODStore.getState().addStation('a', 0.1, 0.2, 0.3)
    const id = useODStore.getState().stations[0]!.id
    useODStore.getState().selectStation(id)
    expect(useODStore.getState().selectedStationId).toBe(id)
  })

  it('clears the selection with null', () => {
    useODStore.getState().addStation('a', 0.1, 0.2, 0.3)
    useODStore.getState().selectStation(useODStore.getState().stations[0]!.id)
    useODStore.getState().selectStation(null)
    expect(useODStore.getState().selectedStationId).toBeNull()
  })
})

// =============================================================================
// setSimConfig
// =============================================================================

describe('setSimConfig', () => {
  it('merges partial updates', () => {
    useODStore.getState().setSimConfig({ noiseScale: 2.5, arcHours: 4 })
    expect(useODStore.getState().simConfig).toEqual({
      noiseScale: 2.5,
      cadenceSec: 60,
      arcHours: 4,
      stationNames: ['goldstone'],
    })
  })

  it('replaces stationNames array wholesale', () => {
    useODStore.getState().setSimConfig({ stationNames: ['goldstone', 'tromsoe'] })
    expect(useODStore.getState().simConfig.stationNames).toEqual(['goldstone', 'tromsoe'])
  })
})

// =============================================================================
// Observations
// =============================================================================

describe('observation actions', () => {
  it('setObservations replaces the array', () => {
    useODStore.getState().setObservations([makeObs()])
    expect(useODStore.getState().observations).toHaveLength(1)
    useODStore.getState().setObservations([makeObs({ timeJd: 2451546.0 }), makeObs()])
    expect(useODStore.getState().observations).toHaveLength(2)
  })

  it('appendObservations adds to the array', () => {
    useODStore.getState().setObservations([makeObs()])
    useODStore.getState().appendObservations([makeObs(), makeObs()])
    expect(useODStore.getState().observations).toHaveLength(3)
  })

  it('clearObservations empties the array but keeps stations', () => {
    useODStore.getState().addStation('a', 0.1, 0.2, 0.3)
    useODStore.getState().setObservations([makeObs()])
    useODStore.getState().clearObservations()
    expect(useODStore.getState().observations).toHaveLength(0)
    expect(useODStore.getState().stations).toHaveLength(1)
  })
})

// =============================================================================
// clearAll
// =============================================================================

describe('clearAll', () => {
  it('destroys every station handle and resets all state', () => {
    useODStore.getState().addStation('a', 0.1, 0.2, 0.3)
    mockCreateStation.mockReturnValue(102)
    useODStore.getState().addStation('b', 0.4, 0.5, 0.6)
    useODStore.getState().selectStation(useODStore.getState().stations[0]!.id)
    useODStore.getState().setObservations([makeObs()])
    useODStore.getState().setSimConfig({ noiseScale: 9 })

    useODStore.getState().clearAll()

    const state = useODStore.getState()
    expect(mockDestroyStation).toHaveBeenCalledWith(101)
    expect(mockDestroyStation).toHaveBeenCalledWith(102)
    expect(state.stations).toHaveLength(0)
    expect(state.selectedStationId).toBeNull()
    expect(state.observations).toHaveLength(0)
    expect(state.simConfig).toEqual({
      noiseScale: 1,
      cadenceSec: 60,
      arcHours: 1,
      stationNames: ['goldstone'],
    })
  })

  it('skips destroy for null handles', () => {
    mockCreateStation.mockReturnValue(null)
    useODStore.getState().addStation('a', 0.1, 0.2, 0.3)
    useODStore.getState().clearAll()
    expect(mockDestroyStation).not.toHaveBeenCalled()
  })
})
