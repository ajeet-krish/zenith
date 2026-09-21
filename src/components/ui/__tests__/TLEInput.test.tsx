import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TLEInput } from '../TLEInput'
import { useMissionStore } from '@/store/useMissionStore'

vi.mock('@/orbit/wasmLoader', () => ({
  sgp4Init: vi.fn(() => 1),
  sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
  sgp4GetElements: vi.fn(() => ({ a: 6781, e: 0.0007, i: 0.9, raan: 3.49, argp: 0.87, ta: 5.41 })),
  sgp4Clear: vi.fn(),
  initWasm: vi.fn(async () => false),
}))

vi.mock('@/orbit/sampleTles', () => ({
  SAMPLE_TLES: [],
}))

vi.mock('@/processing/tle_parser', () => ({
  parse_tle: vi.fn(() => ({
    satellite_number: 25544,
    classification: 'U',
    intl_designator: '98067A',
    epoch_year: 24,
    epoch_day: 100.5,
    epoch_jd: 2460400,
    mean_motion_dot: 0.00016717,
    mean_motion_ddot: 0,
    bstar: 0.0001027,
    element_set_number: 900,
    inclination: 51.64,
    raan: 200.0,
    eccentricity: 0.0005,
    arg_perigee: 50.0,
    mean_anomaly: 310.0,
    mean_motion: 15.49,
    revolution_number: 10000,
  })),
  validate_tle_checksum: vi.fn(() => true),
}))

describe('TLEInput', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useMissionStore.setState({
      satellites: [],
      selectedSatelliteId: null,
      isPlaying: false,
      timeSpeed: 1,
      propagationMethod: 'sgp4',
      forceModels: { j2: true, drag: false, srp: false, thirdBody: false },
      wasmReady: false,
    })
  })

  it('renders modal with title "ADD TLE"', () => {
    render(<TLEInput onClose={onClose} />)
    expect(screen.getByText('ADD TLE')).toBeInTheDocument()
  })

  it('renders the dialog with correct role and aria', () => {
    render(<TLEInput onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: /Add TLE data/i })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('close button calls onClose', async () => {
    const user = userEvent.setup()
    render(<TLEInput onClose={onClose} />)

    const closeBtn = screen.getByRole('button', { name: /Close/i })
    await user.click(closeBtn)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders satellite name input field', () => {
    render(<TLEInput onClose={onClose} />)
    const nameInput = screen.getByPlaceholderText(/Optional/)
    expect(nameInput).toBeInTheDocument()
    expect(nameInput.tagName).toBe('INPUT')
  })

  it('renders TLE textarea', () => {
    render(<TLEInput onClose={onClose} />)
    const textarea = screen.getByPlaceholderText(/1 25544U/)
    expect(textarea).toBeInTheDocument()
    expect(textarea.tagName).toBe('TEXTAREA')
  })

  it('renders category selector buttons', () => {
    render(<TLEInput onClose={onClose} />)
    expect(screen.getByText('LEO')).toBeInTheDocument()
    expect(screen.getByText('MEO')).toBeInTheDocument()
    expect(screen.getByText('GEO')).toBeInTheDocument()
    expect(screen.getByText('HEO')).toBeInTheDocument()
    expect(screen.getByText('DEBRIS')).toBeInTheDocument()
  })

  it('renders Add Satellite button', () => {
    render(<TLEInput onClose={onClose} />)
    expect(screen.getByText('Add Satellite')).toBeInTheDocument()
  })

  it('renders Load Samples button', () => {
    render(<TLEInput onClose={onClose} />)
    expect(screen.getByText('Load Samples')).toBeInTheDocument()
  })

  it('Add Satellite button is disabled when TLE text is empty', () => {
    render(<TLEInput onClose={onClose} />)
    const addBtn = screen.getByText('Add Satellite')
    expect(addBtn).toBeDisabled()
  })

  it('renders label for satellite name', () => {
    render(<TLEInput onClose={onClose} />)
    expect(screen.getByText('Satellite Name')).toBeInTheDocument()
  })

  it('renders label for TLE data', () => {
    render(<TLEInput onClose={onClose} />)
    expect(screen.getByText('TLE Data (paste 2 lines)')).toBeInTheDocument()
  })

  it('renders label for category', () => {
    render(<TLEInput onClose={onClose} />)
    expect(screen.getByText('Category')).toBeInTheDocument()
  })

  it('type name input updates value', async () => {
    const user = userEvent.setup()
    render(<TLEInput onClose={onClose} />)

    const nameInput = screen.getByPlaceholderText(/Optional/)
    await user.type(nameInput, 'MySat')

    expect(nameInput).toHaveValue('MySat')
  })

  it('type TLE textarea enables Add Satellite button', async () => {
    const user = userEvent.setup()
    render(<TLEInput onClose={onClose} />)

    const textarea = screen.getByPlaceholderText(/1 25544U/)
    await user.type(textarea, '1 25544U 98067A')

    const addBtn = screen.getByText('Add Satellite')
    expect(addBtn).not.toBeDisabled()
  })
})
