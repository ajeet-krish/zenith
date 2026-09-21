import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SatelliteInfo } from '../SatelliteInfo'
import { useMissionStore, CATEGORY_COLORS } from '@/store/useMissionStore'
import type { Satellite } from '@/store/useMissionStore'

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

function makeSat(overrides: Partial<Satellite> = {}): Satellite {
  return {
    id: 'sat-1',
    name: 'ISS',
    noradId: 25544,
    line1: '1 25544U 98067A   24100.50000000  .00016717  00000-0  10270-3 0  9002',
    line2: '2 25544  51.6400 200.0000 0005000  50.0000 310.0000 15.49000000 10000',
    category: 'LEO',
    color: CATEGORY_COLORS.LEO,
    visible: true,
    handle: 1,
    ...overrides,
  }
}

describe('SatelliteInfo', () => {
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

  it('renders nothing when no satellite is selected', () => {
    const { container } = render(<SatelliteInfo />)
    expect(container.innerHTML).toBe('')
  })

  it('renders satellite name when selected', () => {
    useMissionStore.setState({
      satellites: [makeSat()],
      selectedSatelliteId: 'sat-1',
    })
    render(<SatelliteInfo />)
    expect(screen.getByText('ISS')).toBeInTheDocument()
  })

  it('renders NORAD ID', () => {
    useMissionStore.setState({
      satellites: [makeSat()],
      selectedSatelliteId: 'sat-1',
    })
    render(<SatelliteInfo />)
    expect(screen.getByText('NORAD ID')).toBeInTheDocument()
    expect(screen.getByText('25544')).toBeInTheDocument()
  })

  it('renders category', () => {
    useMissionStore.setState({
      satellites: [makeSat()],
      selectedSatelliteId: 'sat-1',
    })
    render(<SatelliteInfo />)
    expect(screen.getByText('Category')).toBeInTheDocument()
    expect(screen.getByText('LEO')).toBeInTheDocument()
  })

  it('renders orbital elements section', () => {
    useMissionStore.setState({
      satellites: [makeSat()],
      selectedSatelliteId: 'sat-1',
    })
    render(<SatelliteInfo />)
    expect(screen.getByText('Orbital Elements')).toBeInTheDocument()
  })

  it('renders orbital element labels', () => {
    useMissionStore.setState({
      satellites: [makeSat()],
      selectedSatelliteId: 'sat-1',
    })
    render(<SatelliteInfo />)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('e')).toBeInTheDocument()
    expect(screen.getByText('i')).toBeInTheDocument()
    expect(screen.getByText('RAAN')).toBeInTheDocument()
    expect(screen.getByText('argp')).toBeInTheDocument()
    expect(screen.getByText('ta')).toBeInTheDocument()
  })

  it('renders derived quantities section', () => {
    useMissionStore.setState({
      satellites: [makeSat()],
      selectedSatelliteId: 'sat-1',
    })
    render(<SatelliteInfo />)
    expect(screen.getByText('Derived')).toBeInTheDocument()
    expect(screen.getByText('Period')).toBeInTheDocument()
    expect(screen.getByText('Altitude')).toBeInTheDocument()
    expect(screen.getByText('Velocity')).toBeInTheDocument()
  })

  it('close button deselects the satellite', async () => {
    const user = userEvent.setup()
    useMissionStore.setState({
      satellites: [makeSat()],
      selectedSatelliteId: 'sat-1',
    })
    render(<SatelliteInfo />)

    const closeBtn = screen.getByRole('button', { name: /Close/i })
    await user.click(closeBtn)

    expect(useMissionStore.getState().selectedSatelliteId).toBeNull()
  })

  it('shows "No orbital data available" when handle is null', () => {
    useMissionStore.setState({
      satellites: [makeSat({ handle: null })],
      selectedSatelliteId: 'sat-1',
    })
    render(<SatelliteInfo />)
    expect(screen.getByText('No orbital data available')).toBeInTheDocument()
  })
})
