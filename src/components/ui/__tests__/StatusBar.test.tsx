import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBar } from '../StatusBar'
import { useODStore } from '@/store/useODStore'
import { useMissionStore } from '@/store/useMissionStore'
import { GAUSS_IOD_STATUS, BATCH_STATUS, EKF_STATUS } from '@/orbit/types'
import type { BatchTsResult, EkfTsResult, GaussIodTsResult } from '@/orbit/types'

vi.mock('@/orbit/wasmLoader', () => ({
  getWasmModule: vi.fn(() => null),
  sgp4GetElements: vi.fn(() => ({
    a: 6781,
    e: 0.0007,
    i: 0.9,
    raan: 3.49,
    argp: 0.87,
    ta: 5.41,
  })),
  sgp4Init: vi.fn(() => 1),
  sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
  sgp4Destroy: vi.fn(),
  initWasm: vi.fn(async () => false),
}))

const IOD_OK: GaussIodTsResult = {
  r: [6778.1, 123.4, 456.7],
  v: [1.5, -2.5, 7.6],
  status: GAUSS_IOD_STATUS.OK,
  statusMessage: 'Solution found with nominal geometry',
  converged: true,
  iterations: 4,
  residualNorm: 5e-7,
  conditionNumber: 1.2e6,
  ranges: [1500.1, 1500.2, 1500.3],
}

const IOD_ERROR: GaussIodTsResult = {
  ...IOD_OK,
  status: GAUSS_IOD_STATUS.ERROR_SINGULAR,
  statusMessage: 'Singular geometry: LOS matrix ill-conditioned or coplanar with origin',
  converged: false,
}

const BATCH_OK: BatchTsResult = {
  state: [6778.1, 123.4, 456.7, 1.5, -2.5, 7.6],
  covariance: Array.from({ length: 36 }, (_, i) => (i % 7 === 0 ? 1e-6 : 0)),
  formalSigmas: [0.001, 0.001, 0.001, 1e-6, 1e-6, 1e-6],
  iterations: 6,
  converged: true,
  wrms: 0.98,
  reducedChi2: 1.02,
  editedCount: 1,
  nActive: 59,
  errorStatus: BATCH_STATUS.OK,
  statusMessage: 'Batch least-squares solve converged',
  residuals: [],
}

const EKF_OK: EkfTsResult = {
  finalState: [6778.1, 123.4, 456.7, 1.5, -2.5, 7.6],
  finalCovDiag: [1, 1, 1, 1e-6, 1e-6, 1e-6],
  finalCov: Array.from({ length: 36 }, (_, i) => (i % 7 === 0 ? 1 : 0)),
  steps: [],
  maneuverRecords: [],
  stats: {
    nObs: 3,
    nRows: 3,
    nUpdated: 3,
    nGated: 0,
    divergenceFlag: false,
    nRecoveries: 0,
    augmentedActiveFinal: false,
    nisMean: 1.0,
    nisMax: 1.4,
    nNisExceed: 0,
    nManeuvers: 0,
  },
  errorStatus: EKF_STATUS.OK,
  statusMessage: 'EKF solve completed',
}

const EKF_DIVERGED: EkfTsResult = {
  ...EKF_OK,
  errorStatus: EKF_STATUS.ERROR_DIVERGENCE,
  statusMessage: 'Non-finite state or covariance detected after a predict',
}

function observation(timeJd: number) {
  return {
    timeJd,
    stationId: 'sta-1',
    obsType: 'range' as const,
    values: [1523.4],
    sigmas: [1e-3],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useMissionStore.setState({
    satellites: [],
    selectedSatelliteId: null,
    currentEpoch: 2461239.5,
    isPlaying: false,
    timeSpeed: 1,
    wasmReady: false,
    propagationMethod: 'sgp4',
  })
  useODStore.setState({
    stations: [],
    selectedStationId: null,
    observations: [],
    simConfig: { noiseScale: 1, cadenceSec: 60, arcHours: 1, stationNames: ['goldstone'] },
    sceneToggles: { trajectory: true, stations: true, losRays: false, covarianceEllipsoid: true },
    iodResult: null,
    batchResult: null,
    batchIsRunning: false,
    ekfResult: null,
    ekfIsRunning: false,
    ekfProgress: 0,
    scheduledManeuvers: [],
  })
})

describe('StatusBar OD segment', () => {
  it('renders idle solve chips with no OBS/STA counts when stores are empty', () => {
    render(<StatusBar />)

    expect(screen.queryByText('OBS')).not.toBeInTheDocument()
    expect(screen.queryByText('STA')).not.toBeInTheDocument()
    expect(screen.getByText('IOD')).toBeInTheDocument()
    expect(screen.getByText('BATCH')).toBeInTheDocument()
    expect(screen.getByText('EKF')).toBeInTheDocument()
    // Idle chips all render the gray idle label (3 idle labels: 3 chips x label span).
    expect(screen.getAllByText('idle')).toHaveLength(3)
  })

  it('shows OBS and STA counts when the store has data', () => {
    useODStore.setState({
      stations: [
        { id: 'sta-1', name: 'goldstone', latRad: 0.6, lonRad: -2, altKm: 1, handle: 11 },
        { id: 'sta-2', name: 'arecibo', latRad: 0.3, lonRad: -1.2, altKm: 0.4, handle: 22 },
      ],
      observations: [observation(2460310.5), observation(2460310.6), observation(2460310.7)],
    })
    render(<StatusBar />)

    expect(screen.getByText('OBS')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('STA')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('IOD chip is green OK when converged with the status message as tooltip', () => {
    useODStore.setState({ iodResult: IOD_OK })
    render(<StatusBar />)

    const label = screen.getByText('OK')
    expect(label).toHaveClass('text-neon-green')
    expect(screen.getByTitle('Solution found with nominal geometry')).toBeInTheDocument()
  })

  it('IOD chip is red ERR when the solve exists but did not converge', () => {
    useODStore.setState({ iodResult: IOD_ERROR })
    render(<StatusBar />)

    const label = screen.getByText('ERR')
    expect(label).toHaveClass('text-neon-red')
    expect(
      screen.getByTitle('Singular geometry: LOS matrix ill-conditioned or coplanar with origin')
    ).toBeInTheDocument()
  })

  it('BATCH chip follows batchResult.converged', () => {
    useODStore.setState({ batchResult: BATCH_OK })
    render(<StatusBar />)

    expect(screen.getByTitle('Batch least-squares solve converged')).toBeInTheDocument()
    const okLabels = screen.getAllByText('OK')
    expect(okLabels.some((el) => el.classList.contains('text-neon-green'))).toBe(true)
  })

  it('EKF chip turns red on a non-zero errorStatus', () => {
    useODStore.setState({ ekfResult: EKF_DIVERGED })
    render(<StatusBar />)

    expect(
      screen.getByTitle('Non-finite state or covariance detected after a predict')
    ).toBeInTheDocument()
    expect(screen.getByText('ERR')).toHaveClass('text-neon-red')
  })

  it('EKF chip is green OK on a completed solve', () => {
    useODStore.setState({ ekfResult: EKF_OK })
    render(<StatusBar />)

    expect(screen.getByText('EKF')).toBeInTheDocument()
    expect(screen.getByTitle('EKF solve completed')).toBeInTheDocument()
  })
})
