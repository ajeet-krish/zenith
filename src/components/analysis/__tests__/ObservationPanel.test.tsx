import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ObservationPanel,
  applyImportObservationText,
} from '../ObservationPanel'
import { useODStore } from '@/store/useODStore'
import { GOLDSTONE } from '@/orbit/odConstants'

vi.mock('@/orbit/stations', () => ({
  createStation: vi.fn(() => 101),
  destroyStation: vi.fn(),
}))

vi.mock('@/orbit/wasmLoader', () => ({
  getWasmModule: vi.fn(() => null),
  sgp4Init: vi.fn(() => 1),
  sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
  sgp4Destroy: vi.fn(),
  initWasm: vi.fn(async () => false),
}))

const GOLDSTONE_CSV = [
  'epoch_jd,station,obs_type,value1,value2,sigma1,sigma2',
  '2460310.5,goldstone,range,1523.412,,0.001,',
  '2460310.6,goldstone,range_rate,1.234,,0.0001,',
  '2460310.7,goldstone,ra_dec,1.8342,-0.5128,,',
].join('\n')

const BAD_CSV = [
  'epoch_jd,station,obs_type,value1,value2,sigma1,sigma2',
  '2460310.5,goldstone,range,1523.412,,0.001,',
  'not-a-number,goldstone,range,1523.0,,0.001,',
  '2460310.6,goldstone,az_el,1.2,0.4,,',
].join('\n')

beforeEach(() => {
  vi.clearAllMocks()
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

describe('ObservationPanel', () => {
  it('renders station and observation sections with empty-state hints', () => {
    render(<ObservationPanel />)
    expect(screen.getByText('Stations')).toBeInTheDocument()
    expect(screen.getByText('Observations')).toBeInTheDocument()
    expect(
      screen.getByText('Add a ground station to observe from')
    ).toBeInTheDocument()
    expect(
      screen.getByText('No observations yet. Import a CSV or JSON file below.')
    ).toBeInTheDocument()
  })

  it('quick-add buttons add the three canonical stations once', async () => {
    const user = userEvent.setup()
    render(<ObservationPanel />)

    await user.click(screen.getByRole('button', { name: 'Goldstone' }))
    await user.click(screen.getByRole('button', { name: 'Arecibo' }))
    await user.click(screen.getByRole('button', { name: 'Tromsoe' }))

    expect(useODStore.getState().stations.map((s) => s.name)).toEqual([
      'goldstone',
      'arecibo',
      'tromsoe',
    ])
    // Added stations render in the list and disable their quick-add button.
    expect(screen.getByText('goldstone')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Goldstone' })).toBeDisabled()
  })

  it('manual add validates and appends a station in degrees', async () => {
    const user = userEvent.setup()
    render(<ObservationPanel />)

    await user.type(screen.getByLabelText('Station name'), 'redsea')
    await user.type(screen.getByLabelText('Station latitude deg'), '28')
    await user.type(screen.getByLabelText('Station longitude deg'), '-13')
    await user.type(screen.getByLabelText('Station altitude km'), '0.2')
    await user.click(screen.getByRole('button', { name: 'Add Station' }))

    const added = useODStore.getState().stations
    expect(added).toHaveLength(1)
    expect(added[0]!.name).toBe('redsea')
    expect(added[0]!.latRad).toBeCloseTo((28 * Math.PI) / 180, 10)
    expect(added[0]!.lonRad).toBeCloseTo((-13 * Math.PI) / 180, 10)
    expect(added[0]!.altKm).toBeCloseTo(0.2, 10)
  })

  it('manual add rejects a duplicate station name', async () => {
    const user = userEvent.setup()
    useODStore.setState({
      stations: [{ id: 'sta-1', name: 'goldstone', latRad: 0.6, lonRad: -2, altKm: 1, handle: 11 }],
    })
    render(<ObservationPanel />)

    await user.type(screen.getByLabelText('Station name'), 'Goldstone')
    await user.click(screen.getByRole('button', { name: 'Add Station' }))

    expect(screen.getByRole('alert')).toHaveTextContent(
      "A station named 'Goldstone' already exists"
    )
    expect(useODStore.getState().stations).toHaveLength(1)
  })

  it('remove button deletes a station from the store', async () => {
    const user = userEvent.setup()
    useODStore.setState({
      stations: [{ id: 'sta-1', name: 'goldstone', latRad: 0.6, lonRad: -2, altKm: 1, handle: 11 }],
    })
    render(<ObservationPanel />)

    await user.click(screen.getByRole('button', { name: 'Remove station goldstone' }))

    expect(useODStore.getState().stations).toHaveLength(0)
  })

  it('clear button empties the observation list', async () => {
    const user = userEvent.setup()
    useODStore.setState({
      observations: [
        {
          timeJd: 2460310.5,
          stationId: 'sta-1',
          obsType: 'range',
          values: [1523.4],
          sigmas: [1e-3],
        },
      ],
    })
    render(<ObservationPanel />)
    expect(screen.getByText('1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear Observations' }))

    expect(useODStore.getState().observations).toHaveLength(0)
  })

  it('toggles update the sceneToggles store slice', async () => {
    const user = userEvent.setup()
    render(<ObservationPanel />)

    const trajectory = screen.getByLabelText('OD trajectory')
    const losRays = screen.getByLabelText('LOS rays')
    const ellipsoid = screen.getByLabelText('Covariance ellipsoid')
    expect(trajectory).toBeChecked()
    expect(losRays).not.toBeChecked()
    expect(ellipsoid).toBeChecked()

    await user.click(trajectory)
    await user.click(losRays)
    await user.click(ellipsoid)

    expect(useODStore.getState().sceneToggles).toEqual({
      trajectory: false,
      stations: true,
      losRays: true,
      covarianceEllipsoid: false,
    })
  })
})

describe('applyImportObservationText', () => {
  it('imports CSV rows and remaps station names to store ids', () => {
    useODStore.setState({
      stations: [{ id: 'sta-7', name: 'goldstone', latRad: 0.6, lonRad: -2, altKm: 1, handle: 11 }],
    })

    const summary = applyImportObservationText(GOLDSTONE_CSV, 'csv')

    expect(summary.imported).toBe(3)
    expect(summary.errors).toEqual([])
    expect(summary.stationNamesAdded).toEqual([])
    expect(summary.stationNamesKept).toEqual([])
    const obs = useODStore.getState().observations
    expect(obs).toHaveLength(3)
    expect(obs.map((o) => o.obsType)).toEqual(['range', 'range_rate', 'ra_dec'])
    // Station names remapped to the existing store id.
    expect(obs.every((o) => o.stationId === 'sta-7')).toBe(true)
  })

  it('rejects CSV rows referencing stations the store has not seen', () => {
    const summary = applyImportObservationText(GOLDSTONE_CSV, 'csv')

    // CSV cannot embed station defs; unknown stations are per-row errors.
    expect(summary.imported).toBe(0)
    expect(summary.stationNamesAdded).toEqual([])
    expect(summary.errors).toHaveLength(3)
    expect(summary.errors[0]).toContain("unknown station 'goldstone'")
    expect(useODStore.getState().observations).toHaveLength(0)
    expect(useODStore.getState().stations).toHaveLength(0)
  })

  it('collects row-level errors with line numbers and keeps good rows', () => {
    useODStore.setState({
      stations: [{ id: 'sta-7', name: 'goldstone', latRad: 0.6, lonRad: -2, altKm: 1, handle: 11 }],
    })

    const summary = applyImportObservationText(BAD_CSV, 'csv')

    expect(summary.imported).toBe(1)
    expect(summary.errors).toHaveLength(2)
    expect(summary.errors[0]).toContain('line 3')
    expect(summary.errors[1]).toContain('az_el')
  })

  it('imports JSON with embedded station definitions', () => {
    const json = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'ksat', obs_type: 'range', values: [1500.2] },
      ],
      stations: [{ name: 'ksat', lat_rad: 1.1, lon_rad: 0.2, alt_km: 0.05 }],
    })

    const summary = applyImportObservationText(json, 'json')

    expect(summary.imported).toBe(1)
    expect(summary.stationNamesAdded).toEqual(['ksat'])
    const obs = useODStore.getState().observations
    expect(obs).toHaveLength(1)
    expect(obs[0]!.stationId).toBe(useODStore.getState().stations[0]!.id)
  })

  it('keeps the existing store station def when JSON embeds the same name', () => {
    useODStore.setState({
      stations: [{ id: 'sta-3', name: 'Goldstone', latRad: 0.6, lonRad: -2, altKm: 1, handle: 33 }],
    })
    const json = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'goldstone', obs_type: 'range', values: [1500.2] },
      ],
      stations: [{ name: 'goldstone', lat_rad: 0.99, lon_rad: 1.11, alt_km: 9.9 }],
    })

    const summary = applyImportObservationText(json, 'json')

    expect(summary.imported).toBe(1)
    expect(summary.stationNamesAdded).toEqual([])
    expect(summary.stationNamesKept).toEqual(['Goldstone'])
    // The store definition is not mutated by the embedded def.
    const station = useODStore.getState().stations[0]!
    expect(station.latRad).toBe(0.6)
    expect(station.lonRad).toBe(-2)
    expect(station.altKm).toBe(1)
    // The observation remaps to the existing store id.
    expect(useODStore.getState().observations[0]!.stationId).toBe('sta-3')
  })

  it('reports invalid JSON as a parse error', () => {
    const summary = applyImportObservationText('{ not json', 'json')

    expect(summary.imported).toBe(0)
    expect(summary.errors[0]).toContain('Invalid JSON')
    expect(useODStore.getState().observations).toHaveLength(0)
  })
})

describe('ObservationPanel file import flow', () => {
  it('CSV file input parses via FileReader and renders the import log', async () => {
    useODStore.setState({
      stations: [{ id: 'sta-7', name: 'goldstone', latRad: 0.6, lonRad: -2, altKm: 1, handle: 11 }],
    })
    render(<ObservationPanel />)

    const file = new File([GOLDSTONE_CSV], 'obs.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('Import observations from file'), {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Imported 3 observations from obs.csv')
    })
    expect(useODStore.getState().observations).toHaveLength(3)
  })

  it('import log shows errors from a bad file', async () => {
    useODStore.setState({
      stations: [{ id: 'sta-7', name: 'goldstone', latRad: 0.6, lonRad: -2, altKm: 1, handle: 11 }],
    })
    render(<ObservationPanel />)

    const file = new File([BAD_CSV], 'bad.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('Import observations from file'), {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Imported 1 observation from bad.csv')
      expect(screen.getByRole('status')).toHaveTextContent('line 3')
    })
  })

  it('JSON import log reports kept existing definitions without mutating the store', async () => {
    useODStore.setState({
      stations: [{ id: 'sta-7', name: 'goldstone', latRad: 0.6, lonRad: -2, altKm: 1, handle: 11 }],
    })
    render(<ObservationPanel />)

    const json = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'goldstone', obs_type: 'range', values: [1500.2] },
      ],
      stations: [{ name: 'goldstone', lat_rad: 0.99, lon_rad: 1.11, alt_km: 9.9 }],
    })
    const file = new File([json], 'obs.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText('Import observations from JSON file'), {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'Kept existing definitions: goldstone'
      )
    })
    expect(useODStore.getState().stations[0]!.latRad).toBe(0.6)
  })

  it('rejects files over 10 MB before reading them', async () => {
    render(<ObservationPanel />)

    const file = new File(['epoch_jd,station,obs_type,value1'], 'big.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 })
    fireEvent.change(screen.getByLabelText('Import observations from file'), {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('File is too large')
      expect(screen.getByRole('status')).toHaveTextContent('the limit is 10 MB')
    })
    expect(useODStore.getState().observations).toHaveLength(0)
  })

  it('file inputs filter by extension (.csv / .json)', () => {
    render(<ObservationPanel />)

    expect(screen.getByLabelText('Import observations from file')).toHaveAttribute('accept', '.csv')
    expect(screen.getByLabelText('Import observations from JSON file')).toHaveAttribute(
      'accept',
      '.json'
    )
  })
})

describe('ObservationPanel canonical station parity', () => {
  it('quick-add uses the shared canonical coordinates', async () => {
    const user = userEvent.setup()
    render(<ObservationPanel />)

    await user.click(screen.getByRole('button', { name: 'Goldstone' }))

    const station = useODStore.getState().stations[0]!
    expect(station.name).toBe(GOLDSTONE.name)
    expect(station.latRad).toBe(GOLDSTONE.latRad)
    expect(station.lonRad).toBe(GOLDSTONE.lonRad)
    expect(station.altKm).toBe(GOLDSTONE.altKm)
  })
})
