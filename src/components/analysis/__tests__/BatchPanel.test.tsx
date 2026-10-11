import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BatchPanel } from '../BatchPanel'
import { useODStore } from '@/store/useODStore'
import { useMissionStore } from '@/store/useMissionStore'
import { getWasmModule } from '@/orbit/wasmLoader'
import { BATCH_STATUS } from '@/orbit/types'
import type { ODObservation } from '@/orbit/types'

vi.mock('@/orbit/wasmLoader', () => ({
  getWasmModule: vi.fn(() => null),
  sgp4Init: vi.fn(() => 1),
  sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
  sgp4Destroy: vi.fn(),
  initWasm: vi.fn(async () => false),
}))

const mockGetWasmModule = vi.mocked(getWasmModule)

/** Canned exports.cpp flat batch result (see od_batch.test.ts layout). */
function cannedFlat(options?: { status?: number; converged?: number }): number[] {
  const flat: number[] = []
  // state(6)
  flat.push(6778.1, 123.4, 456.7, 1.5, -2.5, 7.6)
  // cov(36)
  for (let i = 0; i < 36; ++i) flat.push(i * 0.001)
  // formal_sigmas(6)
  flat.push(0.1, 0.2, 0.3, 1e-4, 2e-4, 3e-4)
  // iterations, converged, wrms, reduced_chi2, edited_count, n_active, status, n_residual_rows
  flat.push(
    5,
    options?.converged ?? 1,
    0.98,
    1.05,
    2,
    58,
    options?.status ?? BATCH_STATUS.OK,
    2
  )
  // residual row 0: edited range observation
  flat.push(
    2460310.5, 0, 1,
    6781.2, 0,
    6781.19, 0,
    0.01, 0,
    1e-3, 0,
    10, 0,
    1
  )
  // residual row 1: active ra_dec observation
  flat.push(
    2460310.51, 2, 2,
    1.2, 0.3,
    1.19999, 0.30001,
    1e-5, -1e-5,
    1e-6, 1e-6,
    10, -10,
    0
  )
  return flat
}

/** Full WASM module mock: station registry, observation model, batch kernel. */
function makeWasmModule(batchFlat: number[] | null = cannedFlat()) {
  return {
    od_station_create: vi.fn(() => 11),
    od_station_destroy: vi.fn(),
    od_predict_observation: vi.fn(() => [6781.2, 0.1, 1.234, -0.321, 0.5, 0.3]),
    od_batch_solve: vi.fn(
      (
        _obs_flat: number[],
        _state6: number[],
        _epoch_jd: number,
        _config10: number[],
        _apriori42: number[] | null
      ) => batchFlat
    ),
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

describe('BatchPanel', () => {
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
    render(<BatchPanel />)
    expect(screen.getByRole('button', { name: 'Input' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Results' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeDisabled()
    expect(
      screen.getByText('Add or generate observations to enable the solver')
    ).toBeInTheDocument()
    // Status line reports the empty arc honestly.
    expect(screen.getByText(/0 observations from 0 stations/)).toBeInTheDocument()
  })

  it('IOD-seed radio is disabled without an iodResult', () => {
    render(<BatchPanel />)
    expect(screen.getByRole('radio', { name: 'From IOD result' })).toBeDisabled()
    expect(
      screen.getByText('Run Gauss IOD first to seed the batch solver')
    ).toBeInTheDocument()
  })

  it('custom guess inputs enable Run once observations and an epoch exist', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule())
    render(<BatchPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })

    // Observations are in, but the custom guess is still empty.
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeDisabled()
    expect(screen.getByText('Enter all 6 custom state components')).toBeInTheDocument()

    fillCustomGuess()
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeEnabled()
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
    render(<BatchPanel />)

    await addGoldstone(user)
    fireEvent.change(screen.getByLabelText('Simulator satellite'), {
      target: { value: 'sat-x' },
    })
    await user.click(screen.getByRole('button', { name: 'Generate Simulated Arc' }))

    const obs = useODStore.getState().observations
    expect(obs.length).toBeGreaterThan(0)
    // range, range_rate, and one ra_dec record per epoch from one station.
    expect(obs[0]!.obsType).toBe('range')
    expect(obs.every((o) => o.stationId === useODStore.getState().stations[0]!.id)).toBe(true)
    expect(screen.getByText(/Generated \d+ observations/)).toBeInTheDocument()
  })

  it('running with a mocked wrapper shows the Results tab with sigmas and residual plot', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule())
    render(<BatchPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()
    await user.click(screen.getByRole('button', { name: 'Run Batch' }))

    // Status badge and kernel message.
    expect(screen.getByText('CONVERGED')).toBeInTheDocument()
    expect(screen.getByText('Batch least-squares solve converged')).toBeInTheDocument()

    // State vector and derived elements.
    expect(screen.getByText('6778.100')).toBeInTheDocument()
    expect(screen.getByText('1.500000')).toBeInTheDocument()
    expect(screen.getByText('Derived Elements (two-body)')).toBeInTheDocument()

    // Formal sigmas (positions 3 decimals).
    expect(screen.getByText('0.100 km')).toBeInTheDocument()

    // Diagnostics: WRMS, iterations, edited/total, reduced chi2.
    expect(screen.getByText('0.980')).toBeInTheDocument()
    expect(screen.getByText('1.050')).toBeInTheDocument()
    expect(screen.getByText('2 / 2')).toBeInTheDocument()

    // Residual plot canvas with its accessible summary.
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('2 residuals')
    )
    expect(screen.getByRole('checkbox', { name: 'Show 3-sigma band' })).toBeChecked()
  })

  it('shows the explicit message for an error status', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(
      makeWasmModule(cannedFlat({ status: BATCH_STATUS.ERROR_SINGULAR_N, converged: 0 }))
    )
    render(<BatchPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()
    await user.click(screen.getByRole('button', { name: 'Run Batch' }))

    expect(screen.getByText('ERROR')).toBeInTheDocument()
    expect(
      screen.getByText('Final covariance is singular (rank-deficient active set)')
    ).toBeInTheDocument()
    expect(screen.getByText('No usable state vector for this status.')).toBeInTheDocument()
  })

  it('shows the yellow NOT CONVERGED badge with recovery guidance', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(
      makeWasmModule(
        cannedFlat({ status: BATCH_STATUS.ERROR_NOT_CONVERGED, converged: 0 })
      )
    )
    render(<BatchPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()
    await user.click(screen.getByRole('button', { name: 'Run Batch' }))

    expect(screen.getByText('NOT CONVERGED')).toBeInTheDocument()
    expect(
      screen.getByText('Solver finished without meeting the convergence tolerances')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Loosen the tolerances, extend the arc/)
    ).toBeInTheDocument()
  })

  it('shows the empty Results state before any solve', () => {
    render(<BatchPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Results' }))
    expect(
      screen.getByText('Run a batch solve to see residuals and covariance')
    ).toBeInTheDocument()
  })

  it('a-priori x0 prefills from the custom guess when the checkbox is toggled on', async () => {
    const user = userEvent.setup()
    const wasm = makeWasmModule()
    mockGetWasmModule.mockReturnValue(wasm)
    render(<BatchPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()

    // Open the collapsible A-Priori Constraint section.
    await user.click(screen.getByRole('button', { name: 'A-Priori Constraint' }))
    const checkbox = screen.getByRole('checkbox', { name: 'Enable a-priori constraint' })
    expect(checkbox).not.toBeChecked()

    const x0Labels = [
      'A-priori X km',
      'A-priori Y km',
      'A-priori Z km',
      'A-priori Vx km/s',
      'A-priori Vy km/s',
      'A-priori Vz km/s',
    ]

    // Toggle on: the x0 fieldset renders and pre-fills from the composed
    // state guess in the same interaction.
    await user.click(checkbox)
    const x0Inputs = x0Labels.map(
      (label) => screen.getByLabelText(label) as HTMLInputElement
    )
    expect(x0Inputs.map((el) => el.value)).toEqual([
      '6778.1',
      '123.4',
      '456.7',
      '1.5',
      '-2.5',
      '7.6',
    ])

    // Run: the packed apriori42 carries x0 = guess and the default
    // diagonal P0 (10000 km^2 position, 1 (km/s)^2 velocity).
    await user.click(screen.getByRole('button', { name: 'Run Batch' }))
    const apriori42 = wasm.od_batch_solve.mock.calls[0]![4] as number[]
    expect(apriori42).toHaveLength(42)
    expect(apriori42.slice(0, 6)).toEqual([6778.1, 123.4, 456.7, 1.5, -2.5, 7.6])
    const cov = apriori42.slice(6)
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        expect(cov[i * 6 + j]).toBe(i === j ? (i < 3 ? 10000 : 1) : 0)
      }
    }
  })

  it('a-priori toggle on with no guess leaves x0 empty and Run blocked', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule())
    render(<BatchPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    // Custom guess deliberately left empty.

    await user.click(screen.getByRole('button', { name: 'A-Priori Constraint' }))
    await user.click(screen.getByRole('checkbox', { name: 'Enable a-priori constraint' }))

    const x0Labels = [
      'A-priori X km',
      'A-priori Y km',
      'A-priori Z km',
      'A-priori Vx km/s',
      'A-priori Vy km/s',
      'A-priori Vz km/s',
    ]
    // No prefill when the guess does not exist yet.
    expect(
      x0Labels.every((label) => (screen.getByLabelText(label) as HTMLInputElement).value === '')
    ).toBe(true)
    // Run stays blocked (custom guess empty + a-priori x0 empty).
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeDisabled()
  })

  it('Run is gated on max iterations being an integer in [1, 100]', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue(makeWasmModule())
    render(<BatchPanel />)

    const station = await addGoldstone(user)
    useODStore.setState({ observations: storeObservations(station.id) })
    fillCustomGuess()
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeEnabled()

    // Open the Solver Config section (max iterations input lives there).
    await user.click(screen.getByRole('button', { name: 'Solver Config' }))
    const maxIterInput = screen.getByLabelText('Max iterations') as HTMLInputElement

    // Above the kernel clamp: blocked with the matching hint.
    fireEvent.change(maxIterInput, { target: { value: '101' } })
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeDisabled()
    expect(
      screen.getByText('Max iterations must be a whole number between 1 and 100; sigma edit must be positive')
    ).toBeInTheDocument()

    // Zero and non-integer values are blocked too.
    fireEvent.change(maxIterInput, { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeDisabled()
    fireEvent.change(maxIterInput, { target: { value: '2.5' } })
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeDisabled()

    // Boundary values re-enable Run.
    fireEvent.change(maxIterInput, { target: { value: '100' } })
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeEnabled()
    fireEvent.change(maxIterInput, { target: { value: '1' } })
    expect(screen.getByRole('button', { name: 'Run Batch' })).toBeEnabled()
  })
})
