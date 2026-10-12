import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EkfPanel } from '../EkfPanel'
import { useODStore } from '@/store/useODStore'
import { useMissionStore } from '@/store/useMissionStore'
import { getWasmModule } from '@/orbit/wasmLoader'
import { EKF_STATUS, EKF_STATUS_MESSAGES } from '@/orbit/types'
import type { BatchTsResult, ODObservation } from '@/orbit/types'

vi.mock('@/orbit/wasmLoader', () => ({
  getWasmModule: vi.fn(() => null),
  sgp4Init: vi.fn(() => 1),
  sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
  sgp4Destroy: vi.fn(),
  initWasm: vi.fn(async () => false),
}))

const mockGetWasmModule = vi.mocked(getWasmModule)

/**
 * Canned exports.cpp flat EKF result for 2 observation steps (one scalar
 * range with NaN padding, one ra_dec) and one stored maneuver record
 * (see od_ekf.test.ts for the layout contract).
 */
function cannedFlat(options?: {
  error?: number
  augmentedActive?: number
}): number[] {
  const flat: number[] = []
  // Header: status + diagnostics.
  flat.push(
    options?.error ?? EKF_STATUS.OK,
    2, // n_obs
    3, // n_rows (range 1 + ra_dec 2)
    2, // n_updated
    1, // n_gated
    0, // divergence_flag
    1, // n_recoveries
    options?.augmentedActive ?? 0, // augmented_active_final
    12.4, // nis_mean
    20.1, // nis_max
    1, // n_nis_exceed
    1 // n_maneuvers
  )
  flat.push(6778.1, 123.4, 456.7, 1.5, -2.5, 7.6) // final_state
  flat.push(0.01, 0.04, 0.09, 1e-8, 4e-8, 9e-8) // final_cov_diag
  for (let i = 0; i < 36; ++i) flat.push(i * 0.001) // final_cov
  // SoA payload.
  flat.push(2460310.5, 2460310.51) // obs_times(2)
  flat.push(0, 2) // obs_types(2): RANGE, RA_DEC
  flat.push(0, 1) // maneuver_flag(2)
  for (let i = 0; i < 12; ++i) flat.push(6778 + i) // state_hist(12)
  for (let i = 0; i < 12; ++i) flat.push(0.01 * (i + 1)) // sigma_hist(12)
  flat.push(0.002, NaN, 1e-6, -2e-6) // innovations(4): range pad NaN
  flat.push(1.5, NaN, 4.0, 9.0) // nis(4): range pad NaN
  flat.push(1, 0, 1, 1) // updated_mask(4)
  flat.push(2460310.505, 0.001, 0.002, 0.003) // maneuver_records(4)
  return flat
}

/** Full WASM module mock: station registry, observation model, EKF kernel. */
function makeWasmModule(ekfFlat: number[] | null = cannedFlat()) {
  return {
    od_station_create: vi.fn(() => 11),
    od_station_destroy: vi.fn(),
    od_predict_observation: vi.fn(() => [6781.2, 0.1, 1.234, -0.321, 0.5, 0.3]),
    od_ekf_solve: vi.fn(
      (
        _obs_flat: number[],
        _state6: number[],
        _epoch_jd: number,
        _config16: number[],
        _burns: number[] | null
      ) => ekfFlat
    ),
  }
}

/** Minimal converged batch result for the From-batch guess mode. */
function batchResultFixture(): BatchTsResult {
  return {
    state: [6778.1, 123.4, 456.7, 1.5, -2.5, 7.6],
    covariance: new Array(36).fill(0),
    formalSigmas: [0.1, 0.2, 0.3, 1e-4, 2e-4, 3e-4],
    iterations: 3,
    converged: true,
    wrms: 1.0,
    reducedChi2: null,
    editedCount: 0,
    nActive: 6,
    errorStatus: 0,
    statusMessage: 'Batch least-squares solve converged',
    residuals: [],
  }
}

/** Two store observations from one station (range + one ra_dec record). */
function storeObservations(stationId: string): ODObservation[] {
  return [
    {
      timeJd: 2460310.5,
      stationId,
      obsType: 'range',
      values: [6781.2],
      sigmas: [1e-3],
    },
    {
      timeJd: 2460310.51,
      stationId,
      obsType: 'ra_dec',
      values: [1.2, 0.3],
      sigmas: [1e-6, 1e-6],
    },
  ]
}

/** Add Goldstone via the quick-add button (registers a WASM station handle). */
async function addGoldstone(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Goldstone' }))
  return useODStore.getState().stations[0]!
}

/** Fill the six custom state guess inputs. */
function fillCustomGuess() {
  const values = ['6778.1', '123.4', '456.7', '1.5', '-2.5', '7.6']
  const labels = [
    'Guess X km',
    'Guess Y km',
    'Guess Z km',
    'Guess Vx km/s',
    'Guess Vy km/s',
    'Guess Vz km/s',
  ]
  for (let i = 0; i < 6; i++) {
    fireEvent.change(screen.getByLabelText(labels[i]!), { target: { value: values[i] } })
  }
}

/** Text of the span following a Filter Stats label. */
function statValue(label: string): string | null | undefined {
  return screen.getByText(label).nextElementSibling?.textContent
}

describe('EkfPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetWasmModule.mockReturnValue(null)
    useODStore.setState({
      stations: [],
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
    useMissionStore.setState({
      satellites: [],
      selectedSatelliteId: null,
      currentEpoch: 2461239.5,
      isPlaying: false,
      timeSpeed: 1,
      wasmReady: false,
    })
  })

  it('renders Input and Results tabs with Run disabled when there are no observations', () => {
    render(<EkfPanel />)
    expect(screen.getByRole('button', { name: 'Input' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Results' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run EKF' })).toBeDisabled()
    expect(
      screen.getByText('Add or generate observations to enable the solver')
    ).toBeInTheDocument()
    // Status line reports the empty arc honestly.
    expect(screen.getByText(/0 observations from 0 stations/)).toBeInTheDocument()
  })

  it('IOD and batch seed radios are disabled without their results', () => {
    render(<EkfPanel />)
    expect(screen.getByRole('radio', { name: 'From IOD result' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'From batch result' })).toBeDisabled()
    expect(screen.getByText('Run Gauss IOD first to seed the EKF')).toBeInTheDocument()
    expect(screen.getByText('Run a batch solve first to seed the EKF')).toBeInTheDocument()
  })

  it('custom guess inputs enable Run once observations and an epoch exist', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule())
    render(<EkfPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })

    // Observations are in, but the custom guess is still empty.
    expect(screen.getByRole('button', { name: 'Run EKF' })).toBeDisabled()
    expect(screen.getByText('Enter all 6 custom state components')).toBeInTheDocument()

    fillCustomGuess()
    expect(screen.getByRole('button', { name: 'Run EKF' })).toBeEnabled()
  })

  it('batch guess mode seeds from batchResult.state without extra inputs', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule())
    useODStore.setState({ batchResult: batchResultFixture() })
    render(<EkfPanel />)

    // The batch radio is selected by default when a batch result exists.
    const radio = screen.getByRole('radio', {
      name: 'From batch result',
    }) as HTMLInputElement
    expect(radio).toBeChecked()

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    // The store update lands outside act(); wait for the re-render.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run EKF' })).toBeEnabled()
    )
  })

  it('From-batch guess passes batchResult.state verbatim to the kernel', async () => {
    // Value-plumbing guard: the enabled-radio test above proves the
    // batch mode is selectable, but not that state6 actually carries
    // batchResult.state. Use a state that differs from the custom-guess
    // defaults so no other source could satisfy the assertion.
    const user = userEvent.setup()
    const wasm = makeWasmModule()
    mockGetWasmModule.mockReturnValue(wasm)
    const batchState = [6871.5, -246.8, 3210.25, -1.125, 4.5, -3.375]
    useODStore.setState({
      batchResult: { ...batchResultFixture(), state: batchState },
    })
    render(<EkfPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run EKF' })).toBeEnabled()
    )
    await user.click(screen.getByRole('button', { name: 'Run EKF' }))

    expect(wasm.od_ekf_solve).toHaveBeenCalledTimes(1)
    expect(wasm.od_ekf_solve.mock.calls[0]![1]).toEqual(batchState)
  })

  it('generate-arc populates store observations from the Phase 1 simulator', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule(null))
    useMissionStore.setState({
      wasmReady: true,
      satellites: [
        {
          id: 'sat-x',
          name: 'ISS',
          noradId: 25544,
          line1: '1 25544U',
          line2: '2 25544',
          category: 'LEO',
          color: '#8be9fd',
          visible: true,
          handle: 42,
        },
      ],
    })
    render(<EkfPanel />)

    await addGoldstone(user)
    fireEvent.change(screen.getByLabelText('Simulator satellite'), {
      target: { value: 'sat-x' },
    })
    await user.click(screen.getByRole('button', { name: 'Generate Simulated Arc' }))

    const obs = useODStore.getState().observations
    expect(obs.length).toBeGreaterThan(0)
    expect(obs[0]!.obsType).toBe('range')
    expect(obs.every((o) => o.stationId === useODStore.getState().stations[0]!.id)).toBe(true)
    expect(screen.getByText(/Generated \d+ observations/)).toBeInTheDocument()
  })

  it('scheduled maneuver rows validate finite dv and remove cleanly', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule())
    render(<EkfPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()
    expect(screen.getByRole('button', { name: 'Run EKF' })).toBeEnabled()

    // Add one burn row: epoch defaults to the estimation epoch, dv to zero.
    await user.click(screen.getByRole('button', { name: 'Scheduled Maneuvers' }))
    await user.click(screen.getByRole('button', { name: 'Add Maneuver' }))
    expect(screen.getByLabelText('Maneuver 1 epoch UTC')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run EKF' })).toBeEnabled()

    // An empty dv component blocks the run with an explicit hint.
    fireEvent.change(screen.getByLabelText('Maneuver 1 dv X km/s'), {
      target: { value: '' },
    })
    expect(screen.getByRole('button', { name: 'Run EKF' })).toBeDisabled()
    expect(
      screen.getByText('Each scheduled maneuver needs a valid epoch and finite dv components')
    ).toBeInTheDocument()

    // A non-numeric dv stays blocked.
    fireEvent.change(screen.getByLabelText('Maneuver 1 dv X km/s'), {
      target: { value: 'abc' },
    })
    expect(screen.getByRole('button', { name: 'Run EKF' })).toBeDisabled()

    // A finite dv re-enables the run.
    fireEvent.change(screen.getByLabelText('Maneuver 1 dv X km/s'), {
      target: { value: '0.001' },
    })
    expect(screen.getByRole('button', { name: 'Run EKF' })).toBeEnabled()

    // Removing the row clears the draft.
    await user.click(screen.getByRole('button', { name: 'Remove maneuver 1' }))
    expect(screen.queryByLabelText('Maneuver 1 epoch UTC')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run EKF' })).toBeEnabled()
  })

  it('scheduled maneuvers sync to the store and kernel burns on run', async () => {
    const user = userEvent.setup()
    const wasm = makeWasmModule()
    mockGetWasmModule.mockReturnValue(wasm)
    render(<EkfPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()

    await user.click(screen.getByRole('button', { name: 'Scheduled Maneuvers' }))
    await user.click(screen.getByRole('button', { name: 'Add Maneuver' }))
    fireEvent.change(screen.getByLabelText('Maneuver 1 dv X km/s'), {
      target: { value: '0.001' },
    })
    await user.click(screen.getByRole('button', { name: 'Run EKF' }))

    // The draft row reached the store sorted and intact.
    const burns = useODStore.getState().scheduledManeuvers
    expect(burns).toHaveLength(1)
    expect(burns[0]!.epochJd).toBeCloseTo(2460310.5, 3)
    expect(burns[0]!.dv).toEqual([0.001, 0, 0])

    // The kernel received the packed 4-doubles-per-burn array.
    const packed = wasm.od_ekf_solve.mock.calls[0]![4] as number[]
    expect(packed).toHaveLength(4)
    expect(packed[0]).toBeCloseTo(2460310.5, 3)
    expect(packed.slice(1)).toEqual([0.001, 0, 0])
  })

  it('running with a mocked kernel shows results, stats, and both plots', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule())
    render(<EkfPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()
    await user.click(screen.getByRole('button', { name: 'Run EKF' }))

    // Status badge and kernel message.
    expect(screen.getByText('OK')).toBeInTheDocument()
    expect(screen.getByText('EKF solve completed')).toBeInTheDocument()

    // State vector and derived elements.
    expect(screen.getByText('6778.100')).toBeInTheDocument()
    expect(screen.getByText('1.500000')).toBeInTheDocument()
    expect(screen.getByText('Derived Elements (two-body)')).toBeInTheDocument()

    // Final sigmas (positions 3 decimals; sqrt of the cov diagonal).
    expect(screen.getByText('0.100 km')).toBeInTheDocument()
    expect(screen.getByText('0.000100 km/s')).toBeInTheDocument()

    // Filter stats grid.
    expect(statValue('Updates:')).toBe('2 / 3')
    expect(statValue('Gated:')).toBe('1')
    expect(statValue('Maneuver steps:')).toBe('1')
    expect(statValue('Recoveries:')).toBe('1')
    expect(statValue('Augmented:')).toBe('inactive')

    // Maneuver records table with the |dv| magnitude in m/s.
    expect(screen.getByText('Maneuver Records')).toBeInTheDocument()
    expect(screen.getByText('3.742')).toBeInTheDocument()

    // Both plots render with their accessible summaries.
    const plots = screen.getAllByRole('img')
    expect(plots).toHaveLength(2)
    expect(plots[0]).toHaveAttribute(
      'aria-label',
      expect.stringContaining('NIS plot: 2 steps')
    )
    expect(plots[0]).toHaveAttribute('aria-label', expect.stringContaining('25 gate'))
    expect(plots[1]).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Covariance plot: 2 steps')
    )

    expect(screen.getByRole('button', { name: 'Clear result' })).toBeInTheDocument()
  })

  it('shows the explicit message for an error status without a state vector', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(
      makeWasmModule(cannedFlat({ error: EKF_STATUS.ERROR_DIVERGENCE }))
    )
    render(<EkfPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()
    await user.click(screen.getByRole('button', { name: 'Run EKF' }))

    expect(screen.getByText('ERROR')).toBeInTheDocument()
    expect(
      screen.getByText(EKF_STATUS_MESSAGES[EKF_STATUS.ERROR_DIVERGENCE]!)
    ).toBeInTheDocument()
    expect(screen.getByText('No usable state vector for this status.')).toBeInTheDocument()
    expect(screen.queryByText('Final Sigmas')).not.toBeInTheDocument()
    expect(screen.queryByText('Derived Elements (two-body)')).not.toBeInTheDocument()
  })

  it('displays the augmented-active flag when the arc ends in 9D mode', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule(cannedFlat({ augmentedActive: 1 })))
    render(<EkfPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()
    await user.click(screen.getByRole('button', { name: 'Run EKF' }))

    expect(statValue('Augmented:')).toBe('ACTIVE')
  })

  it('shows the empty Results state before any solve', () => {
    render(<EkfPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Results' }))
    expect(
      screen.getByText('Run an EKF solve to see filter health and covariance')
    ).toBeInTheDocument()
  })
})
