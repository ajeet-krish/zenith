import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IodPanel } from '../IodPanel'
import { useODStore } from '@/store/useODStore'
import { useMissionStore } from '@/store/useMissionStore'
import { getWasmModule } from '@/orbit/wasmLoader'
import { GAUSS_IOD_STATUS } from '@/orbit/types'
import { RAD_TO_DEG } from '@/orbit/constants'

vi.mock('@/orbit/wasmLoader', () => ({
  getWasmModule: vi.fn(() => null),
  sgp4Init: vi.fn(() => 1),
  sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
  sgp4Destroy: vi.fn(),
  initWasm: vi.fn(async () => false),
}))

const mockGetWasmModule = vi.mocked(getWasmModule)

// Three store stations with WASM handles for the run/results tests.
const STATIONS = [
  { id: 'sta-a', name: 'goldstone', latRad: 0.6, lonRad: -2.0, altKm: 1.0, handle: 11 },
  { id: 'sta-b', name: 'arecibo', latRad: 0.3, lonRad: -1.2, altKm: 0.4, handle: 22 },
  { id: 'sta-c', name: 'tromsoe', latRad: 1.2, lonRad: 0.3, altKm: 0.1, handle: 33 },
]

/** Canned 16-double od_gauss_iod result (exports.cpp layout). */
function cannedFlat(overrides?: { converged?: number; status?: number }): number[] {
  const flat = [
    6778.1, 123.4, 456.7, // r [km]
    1.5, -2.5, 7.6, // v [km/s]
    1, // converged
    4, // iterations
    5e-7, // residual_norm [rad]
    1.2e6, // cond_number
    GAUSS_IOD_STATUS.OK, // error_code
    1500.1, 1500.2, 1500.3, // ranges [km]
    0, 0, // pad
  ]
  if (overrides?.converged !== undefined) flat[6] = overrides.converged
  if (overrides?.status !== undefined) flat[10] = overrides.status
  return flat
}

/** Fill all three observation rows via the labeled inputs. */
function fillAllRows() {
  const raValues = ['120.5', '130.2', '140.9']
  const decValues = ['25.1', '20.4', '15.8']
  for (let i = 0; i < 3; i++) {
    fireEvent.change(screen.getByLabelText(`Observation ${i + 1} RA deg`), {
      target: { value: raValues[i] },
    })
    fireEvent.change(screen.getByLabelText(`Observation ${i + 1} Dec deg`), {
      target: { value: decValues[i] },
    })
    fireEvent.change(screen.getByLabelText(`Observation ${i + 1} station`), {
      target: { value: STATIONS[i]!.id },
    })
  }
}

describe('IodPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetWasmModule.mockReturnValue(null)
    useODStore.setState({
      stations: [],
      selectedStationId: null,
      observations: [],
      simConfig: { noiseScale: 1, cadenceSec: 60, arcHours: 1, stationNames: ['goldstone'] },
      iodResult: null,
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

  it('renders Input and Results tabs with a WASM-unavailable hint', () => {
    render(<IodPanel />)
    expect(screen.getByRole('button', { name: 'Input' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Results' })).toBeInTheDocument()
    expect(
      screen.getByText('WASM solver unavailable; Gauss IOD needs the compiled module')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run Gauss IOD' })).toBeDisabled()
  })

  it('quick-add buttons populate the station store', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue({
      od_station_create: vi.fn(() => 5),
      od_station_destroy: vi.fn(),
    })
    render(<IodPanel />)

    await user.click(screen.getByRole('button', { name: 'Goldstone' }))
    await user.click(screen.getByRole('button', { name: 'Arecibo' }))
    await user.click(screen.getByRole('button', { name: 'Tromsoe' }))

    const names = useODStore.getState().stations.map((s) => s.name)
    expect(names).toEqual(['goldstone', 'arecibo', 'tromsoe'])
    // Station options now appear in each row's select.
    expect(screen.getAllByRole('option', { name: 'goldstone' })).toHaveLength(3)
  })

  it('Run stays disabled with empty inputs even when stations and WASM are ready', () => {
    useODStore.setState({ stations: STATIONS.map((s) => ({ ...s })) })
    useMissionStore.setState({ wasmReady: true })
    render(<IodPanel />)

    expect(screen.getByRole('button', { name: 'Run Gauss IOD' })).toBeDisabled()
    expect(screen.getByText(/Add 3 valid RA\/Dec observations/)).toBeInTheDocument()
  })

  it('Run stays disabled when only two of three rows are valid', () => {
    useODStore.setState({ stations: STATIONS.map((s) => ({ ...s })) })
    useMissionStore.setState({ wasmReady: true })
    render(<IodPanel />)

    // Rows 1 and 2 fully valid; row 3 has an out-of-range RA (999 deg).
    const raValues = ['120.5', '130.2', '999']
    const decValues = ['25.1', '20.4', '15.8']
    for (let i = 0; i < 3; i++) {
      fireEvent.change(screen.getByLabelText(`Observation ${i + 1} RA deg`), {
        target: { value: raValues[i] },
      })
      fireEvent.change(screen.getByLabelText(`Observation ${i + 1} Dec deg`), {
        target: { value: decValues[i] },
      })
      fireEvent.change(screen.getByLabelText(`Observation ${i + 1} station`), {
        target: { value: STATIONS[i]!.id },
      })
    }

    expect(screen.getByRole('button', { name: 'Run Gauss IOD' })).toBeDisabled()
    expect(screen.getByText(/2\/3 ready/)).toBeInTheDocument()
    // Row validity indicators: two complete, one incomplete.
    expect(screen.getAllByText('complete')).toHaveLength(2)
    expect(screen.getAllByText('incomplete')).toHaveLength(1)
  })

  it('running with valid rows and mocked WASM shows the solution', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue({ od_gauss_iod: vi.fn(() => cannedFlat()) })
    useODStore.setState({ stations: STATIONS.map((s) => ({ ...s })) })
    useMissionStore.setState({ wasmReady: true })
    render(<IodPanel />)

    fillAllRows()
    const runBtn = screen.getByRole('button', { name: 'Run Gauss IOD' })
    expect(runBtn).toBeEnabled()
    await user.click(runBtn)

    // Results tab is shown with OK status and the status message.
    expect(screen.getByText('OK')).toBeInTheDocument()
    expect(screen.getByText('Solution found with nominal geometry')).toBeInTheDocument()

    // State vector: 3-decimal position, 6-decimal velocity.
    expect(screen.getByText('6778.100')).toBeInTheDocument()
    expect(screen.getByText('1.500000')).toBeInTheDocument()

    // Derived elements section present.
    expect(screen.getByText('Derived Elements (two-body)')).toBeInTheDocument()
    expect(screen.getByText('a (km)')).toBeInTheDocument()
    expect(screen.getByText('i (deg)')).toBeInTheDocument()

    // Diagnostics.
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('5.00e-7 rad')).toBeInTheDocument()
    expect(screen.getByText('1.20e+6')).toBeInTheDocument()
    expect(screen.getByText(/1500\.1/)).toBeInTheDocument()
  })

  it('shows the explicit message for an error status', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue({
      od_gauss_iod: vi.fn(() =>
        cannedFlat({ converged: 0, status: GAUSS_IOD_STATUS.ERROR_NO_SOLUTION })
      ),
    })
    useODStore.setState({ stations: STATIONS.map((s) => ({ ...s })) })
    useMissionStore.setState({ wasmReady: true })
    render(<IodPanel />)

    fillAllRows()
    await user.click(screen.getByRole('button', { name: 'Run Gauss IOD' }))

    expect(screen.getByText('ERROR')).toBeInTheDocument()
    expect(
      screen.getByText('No root converged to a consistent physical orbit')
    ).toBeInTheDocument()
    expect(screen.getByText('No usable state vector for this status.')).toBeInTheDocument()
  })

  it('shows warning badge and geometry guidance for ill-conditioned solutions', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue({
      od_gauss_iod: vi.fn(() =>
        cannedFlat({ converged: 1, status: GAUSS_IOD_STATUS.WARNING_ILL_CONDITIONED })
      ),
    })
    useODStore.setState({ stations: STATIONS.map((s) => ({ ...s })) })
    useMissionStore.setState({ wasmReady: true })
    render(<IodPanel />)

    fillAllRows()
    await user.click(screen.getByRole('button', { name: 'Run Gauss IOD' }))

    expect(screen.getByText('WARNING')).toBeInTheDocument()
    expect(
      screen.getByText('Ill-conditioned geometry: state may be inaccurate')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Observation geometry too weak; increase spacing or use different stations')
    ).toBeInTheDocument()
  })

  it('simulate from truth fills RA/Dec from the prediction model', async () => {
    const user = userEvent.setup()
    mockGetWasmModule.mockReturnValue({
      od_predict_observation: vi.fn(() => [1500, 0.1, 1.234, -0.321, 0.5, 0.3]),
    })
    useODStore.setState({ stations: STATIONS.map((s) => ({ ...s })) })
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
    render(<IodPanel />)

    fireEvent.change(screen.getByLabelText('Truth satellite'), {
      target: { value: 'sat-x' },
    })
    for (let i = 0; i < 3; i++) {
      fireEvent.change(screen.getByLabelText(`Observation ${i + 1} station`), {
        target: { value: STATIONS[i]!.id },
      })
    }
    await user.click(screen.getByRole('button', { name: 'Fill RA/Dec From Truth' }))

    const ra1 = screen.getByLabelText('Observation 1 RA deg') as HTMLInputElement
    const dec1 = screen.getByLabelText('Observation 1 Dec deg') as HTMLInputElement
    expect(ra1.value).toBe((1.234 * RAD_TO_DEG).toFixed(4))
    expect(dec1.value).toBe((-0.321 * RAD_TO_DEG).toFixed(4))
    expect(
      screen.getByText('Filled 3 noise-free RA/Dec observations')
    ).toBeInTheDocument()
  })
})
