import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useODStore } from '../useODStore'
import { createStation, destroyStation } from '@/orbit/stations'
import { runGaussIod } from '@/orbit/iodGauss'
import { runBatchSolve } from '@/orbit/odBatch'
import type {
  BatchTsResult,
  GaussIodObservation,
  GaussIodTsResult,
  ODObservation,
} from '@/orbit/types'

vi.mock('@/orbit/stations', () => ({
  createStation: vi.fn(() => 101),
  destroyStation: vi.fn(),
}))

vi.mock('@/orbit/iodGauss', () => ({
  runGaussIod: vi.fn(),
}))

vi.mock('@/orbit/odBatch', () => ({
  runBatchSolve: vi.fn(() => null),
}))

const mockCreateStation = vi.mocked(createStation)
const mockDestroyStation = vi.mocked(destroyStation)
const mockRunGaussIod = vi.mocked(runGaussIod)
const mockRunBatchSolve = vi.mocked(runBatchSolve)

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

function makeIodObs(overrides?: Partial<GaussIodObservation>): GaussIodObservation {
  return {
    epochJd: 2460310.5,
    raRad: 1.2,
    decRad: -0.3,
    stationId: 'sta-1',
    ...overrides,
  }
}

const CANNED_IOD_RESULT: GaussIodTsResult = {
  r: [6778.1, 123.4, 456.7],
  v: [1.5, -2.5, 7.6],
  status: 0,
  statusMessage: 'Solution found with nominal geometry',
  converged: true,
  iterations: 4,
  residualNorm: 5e-7,
  conditionNumber: 1.2e6,
  ranges: [1500.1, 1500.2, 1500.3],
}

const CANNED_BATCH_RESULT: BatchTsResult = {
  state: [6778.1, 123.4, 456.7, 1.5, -2.5, 7.6],
  covariance: Array.from({ length: 36 }, (_, i) => (i % 7 === 0 ? 1e-6 : 0)),
  formalSigmas: [0.001, 0.001, 0.001, 1e-6, 1e-6, 1e-6],
  iterations: 6,
  converged: true,
  wrms: 0.98,
  reducedChi2: 1.02,
  editedCount: 1,
  nActive: 59,
  errorStatus: 0,
  statusMessage: 'Batch least-squares solve converged',
  residuals: [
    {
      timeJd: 2460310.5,
      obsType: 'range',
      value: [6781.2],
      predicted: [6781.19],
      residual: [0.01],
      sigma: [1e-3],
      normalized: [10],
      edited: true,
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateStation.mockReturnValue(101)
  mockRunGaussIod.mockReturnValue(null)
  mockRunBatchSolve.mockReturnValue(null)
  useODStore.setState({
    stations: [],
    selectedStationId: null,
    observations: [],
    simConfig: { noiseScale: 1, cadenceSec: 60, arcHours: 1, stationNames: ['goldstone'] },
    sceneToggles: { trajectory: true, stations: true, losRays: false, covarianceEllipsoid: true },
    iodResult: null,
    batchResult: null,
    batchIsRunning: false,
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

  it('iodResult is null', () => {
    expect(useODStore.getState().iodResult).toBeNull()
  })

  it('batchResult is null', () => {
    expect(useODStore.getState().batchResult).toBeNull()
  })

  it('batchIsRunning is false', () => {
    expect(useODStore.getState().batchIsRunning).toBe(false)
  })

  it('sceneToggles has Phase 5 defaults', () => {
    expect(useODStore.getState().sceneToggles).toEqual({
      trajectory: true,
      stations: true,
      losRays: false,
      covarianceEllipsoid: true,
    })
  })
})

// =============================================================================
// setSceneToggle
// =============================================================================

describe('setSceneToggle', () => {
  it('updates only the requested key', () => {
    useODStore.getState().setSceneToggle('losRays', true)
    expect(useODStore.getState().sceneToggles).toEqual({
      trajectory: true,
      stations: true,
      losRays: true,
      covarianceEllipsoid: true,
    })
    useODStore.getState().setSceneToggle('covarianceEllipsoid', false)
    expect(useODStore.getState().sceneToggles).toEqual({
      trajectory: true,
      stations: true,
      losRays: true,
      covarianceEllipsoid: false,
    })
  })

  it('is idempotent for repeated values', () => {
    useODStore.getState().setSceneToggle('trajectory', false)
    useODStore.getState().setSceneToggle('trajectory', false)
    expect(useODStore.getState().sceneToggles.trajectory).toBe(false)
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
// Gauss IOD (runIod / clearIodResult)
// =============================================================================

describe('runIod', () => {
  const THREE_OBS = [makeIodObs(), makeIodObs({ epochJd: 2460310.507, stationId: 'sta-2' }), makeIodObs({ epochJd: 2460310.514, stationId: 'sta-3' })]

  it('stores the solver result', () => {
    mockRunGaussIod.mockReturnValue(CANNED_IOD_RESULT)
    useODStore.getState().runIod(THREE_OBS)
    expect(mockRunGaussIod).toHaveBeenCalledWith(THREE_OBS, undefined)
    expect(useODStore.getState().iodResult).toEqual(CANNED_IOD_RESULT)
  })

  it('forwards a config override to the solver', () => {
    mockRunGaussIod.mockReturnValue(CANNED_IOD_RESULT)
    useODStore.getState().runIod(THREE_OBS, { mu: 123456 })
    expect(mockRunGaussIod).toHaveBeenCalledWith(THREE_OBS, { mu: 123456 })
  })

  it('stores null when the solver returns null (WASM absent)', () => {
    useODStore.getState().runIod(THREE_OBS)
    expect(mockRunGaussIod).toHaveBeenCalled()
    expect(useODStore.getState().iodResult).toBeNull()
  })

  it('clears a previous result when the new solve fails', () => {
    mockRunGaussIod.mockReturnValueOnce(CANNED_IOD_RESULT)
    useODStore.getState().runIod(THREE_OBS)
    expect(useODStore.getState().iodResult).toEqual(CANNED_IOD_RESULT)
    mockRunGaussIod.mockReturnValueOnce(null)
    useODStore.getState().runIod(THREE_OBS)
    expect(useODStore.getState().iodResult).toBeNull()
  })

  it('stores null when the solver throws', () => {
    mockRunGaussIod.mockImplementation(() => {
      throw new Error('solver exploded')
    })
    expect(() => useODStore.getState().runIod(THREE_OBS)).not.toThrow()
    expect(useODStore.getState().iodResult).toBeNull()
  })
})

describe('clearIodResult', () => {
  it('clears the stored result', () => {
    mockRunGaussIod.mockReturnValue(CANNED_IOD_RESULT)
    useODStore.getState().runIod([makeIodObs()])
    expect(useODStore.getState().iodResult).toEqual(CANNED_IOD_RESULT)
    useODStore.getState().clearIodResult()
    expect(useODStore.getState().iodResult).toBeNull()
  })

  it('is a no-op when no result is stored', () => {
    useODStore.getState().clearIodResult()
    expect(useODStore.getState().iodResult).toBeNull()
  })
})

// =============================================================================
// Batch LSQ OD (runBatch / clearBatchResult)
// =============================================================================

describe('runBatch', () => {
  const STATE_GUESS = [6778.1, 0, 0, 0, 7.6, 0]
  const EPOCH_JD = 2460310.5

  it('calls runBatchSolve with store observations and stores the result', () => {
    mockRunBatchSolve.mockReturnValue(CANNED_BATCH_RESULT)
    useODStore.getState().setObservations([makeObs()])
    useODStore.getState().runBatch(STATE_GUESS, EPOCH_JD)
    expect(mockRunBatchSolve).toHaveBeenCalledWith({
      observations: [expect.objectContaining({ timeJd: 2451545.5 })],
      stateGuess: STATE_GUESS,
      epochJd: EPOCH_JD,
      config: undefined,
      apriori: undefined,
    })
    expect(useODStore.getState().batchResult).toEqual(CANNED_BATCH_RESULT)
  })

  it('forwards config and apriori overrides to the wrapper', () => {
    mockRunBatchSolve.mockReturnValue(CANNED_BATCH_RESULT)
    const config = { maxIter: 5, enableEditing: false }
    const apriori = { x0: Array(6).fill(0), cov: Array(36).fill(0) }
    // Diagonal of the 6x6 row-major covariance.
    for (let i = 0; i < 6; i += 1) apriori.cov[i * 6 + i] = 1
    useODStore.getState().runBatch(STATE_GUESS, EPOCH_JD, config, apriori)
    expect(mockRunBatchSolve).toHaveBeenCalledWith({
      observations: [],
      stateGuess: STATE_GUESS,
      epochJd: EPOCH_JD,
      config,
      apriori,
    })
  })

  it('sets batchIsRunning true during the solve and false after', () => {
    let runningDuringCall: boolean | undefined
    mockRunBatchSolve.mockImplementation(() => {
      runningDuringCall = useODStore.getState().batchIsRunning
      return CANNED_BATCH_RESULT
    })
    useODStore.getState().runBatch(STATE_GUESS, EPOCH_JD)
    expect(runningDuringCall).toBe(true)
    expect(useODStore.getState().batchIsRunning).toBe(false)
  })

  it('stores null when the wrapper returns null (WASM absent)', () => {
    useODStore.getState().runBatch(STATE_GUESS, EPOCH_JD)
    expect(mockRunBatchSolve).toHaveBeenCalled()
    expect(useODStore.getState().batchResult).toBeNull()
    expect(useODStore.getState().batchIsRunning).toBe(false)
  })

  it('clears a previous result when the new solve fails', () => {
    mockRunBatchSolve.mockReturnValueOnce(CANNED_BATCH_RESULT)
    useODStore.getState().runBatch(STATE_GUESS, EPOCH_JD)
    expect(useODStore.getState().batchResult).toEqual(CANNED_BATCH_RESULT)
    mockRunBatchSolve.mockReturnValueOnce(null)
    useODStore.getState().runBatch(STATE_GUESS, EPOCH_JD)
    expect(useODStore.getState().batchResult).toBeNull()
  })

  it('stores null and clears the running flag when the wrapper throws', () => {
    mockRunBatchSolve.mockImplementation(() => {
      throw new Error('solver exploded')
    })
    expect(() => useODStore.getState().runBatch(STATE_GUESS, EPOCH_JD)).not.toThrow()
    expect(useODStore.getState().batchResult).toBeNull()
    expect(useODStore.getState().batchIsRunning).toBe(false)
  })
})

describe('clearBatchResult', () => {
  it('clears the stored result', () => {
    mockRunBatchSolve.mockReturnValue(CANNED_BATCH_RESULT)
    useODStore.getState().runBatch([6778.1, 0, 0, 0, 7.6, 0], 2460310.5)
    expect(useODStore.getState().batchResult).toEqual(CANNED_BATCH_RESULT)
    useODStore.getState().clearBatchResult()
    expect(useODStore.getState().batchResult).toBeNull()
  })

  it('is a no-op when no result is stored', () => {
    useODStore.getState().clearBatchResult()
    expect(useODStore.getState().batchResult).toBeNull()
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

  it('also clears iodResult', () => {
    mockRunGaussIod.mockReturnValue(CANNED_IOD_RESULT)
    useODStore.getState().runIod([makeIodObs()])
    expect(useODStore.getState().iodResult).toEqual(CANNED_IOD_RESULT)
    useODStore.getState().clearAll()
    expect(useODStore.getState().iodResult).toBeNull()
  })

  it('also clears batchResult and batchIsRunning', () => {
    mockRunBatchSolve.mockReturnValue(CANNED_BATCH_RESULT)
    useODStore.getState().runBatch([6778.1, 0, 0, 0, 7.6, 0], 2460310.5)
    expect(useODStore.getState().batchResult).toEqual(CANNED_BATCH_RESULT)
    useODStore.getState().clearAll()
    expect(useODStore.getState().batchResult).toBeNull()
    expect(useODStore.getState().batchIsRunning).toBe(false)
  })

  it('preserves sceneToggles (UI preferences persist)', () => {
    useODStore.getState().setSceneToggle('trajectory', false)
    useODStore.getState().setSceneToggle('covarianceEllipsoid', false)
    useODStore.getState().clearAll()
    expect(useODStore.getState().sceneToggles).toEqual({
      trajectory: false,
      stations: true,
      losRays: false,
      covarianceEllipsoid: false,
    })
  })
})
