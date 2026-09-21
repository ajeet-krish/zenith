import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SatelliteList } from '../SatelliteList'
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

describe('SatelliteList', () => {
  const onOpenTleInput = vi.fn()

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

  it('renders "No satellites loaded" when store is empty', () => {
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)
    expect(screen.getByText('No satellites loaded')).toBeInTheDocument()
  })

  it('renders the "Add a satellite" link when empty', () => {
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)
    expect(screen.getByText('Add a satellite')).toBeInTheDocument()
  })

  it('renders satellite count when satellites exist', () => {
    useMissionStore.setState({ satellites: [makeSat()] })
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)
    // Header shows count (multiple "1" elements: header count + category count)
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('SATELLITES')).toBeInTheDocument()
  })

  it('renders satellite name and noradId', () => {
    useMissionStore.setState({ satellites: [makeSat()] })
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)
    expect(screen.getByText('ISS')).toBeInTheDocument()
    expect(screen.getByText('25544')).toBeInTheDocument()
  })

  it('clicking a satellite row calls selectSatellite', async () => {
    const user = userEvent.setup()
    useMissionStore.setState({ satellites: [makeSat()] })
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)

    const satRow = screen.getByText('ISS').closest('[class*="cursor-pointer"]')!
    await user.click(satRow)

    expect(useMissionStore.getState().selectedSatelliteId).toBe('sat-1')
  })

  it('clicking a selected satellite deselects it', async () => {
    const user = userEvent.setup()
    useMissionStore.setState({
      satellites: [makeSat()],
      selectedSatelliteId: 'sat-1',
    })
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)

    const satRow = screen.getByText('ISS').closest('[class*="cursor-pointer"]')!
    await user.click(satRow)

    expect(useMissionStore.getState().selectedSatelliteId).toBeNull()
  })

  it('visibility toggle button works', async () => {
    const user = userEvent.setup()
    useMissionStore.setState({ satellites: [makeSat()] })
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)

    const hideButton = screen.getByRole('button', { name: /Hide ISS/i })
    await user.click(hideButton)

    expect(useMissionStore.getState().satellites[0].visible).toBe(false)
  })

  it('toggling visibility from hidden shows the satellite', async () => {
    const user = userEvent.setup()
    useMissionStore.setState({ satellites: [makeSat({ visible: false })] })
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)

    const showButton = screen.getByRole('button', { name: /Show ISS/i })
    await user.click(showButton)

    expect(useMissionStore.getState().satellites[0].visible).toBe(true)
  })

  it('"+ Add TLE" button calls onOpenTleInput', async () => {
    const user = userEvent.setup()
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)

    const addTleButton = screen.getByText('+ Add TLE')
    await user.click(addTleButton)

    expect(onOpenTleInput).toHaveBeenCalledTimes(1)
  })

  it('"Add a satellite" link calls onOpenTleInput when empty', async () => {
    const user = userEvent.setup()
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)

    const addLink = screen.getByText('Add a satellite')
    await user.click(addLink)

    expect(onOpenTleInput).toHaveBeenCalledTimes(1)
  })

  it('renders category header with correct label', () => {
    useMissionStore.setState({ satellites: [makeSat({ category: 'GEO' })] })
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)
    expect(screen.getByText('GEO')).toBeInTheDocument()
  })

  it('groups multiple satellites under category headers', () => {
    useMissionStore.setState({
      satellites: [
        makeSat({ id: 'sat-1', name: 'ISS', category: 'LEO' }),
        makeSat({ id: 'sat-2', name: 'Hubble', category: 'LEO' }),
        makeSat({ id: 'sat-3', name: 'GPS', category: 'MEO' }),
      ],
    })
    render(<SatelliteList onOpenTleInput={onOpenTleInput} />)
    expect(screen.getByText('LEO')).toBeInTheDocument()
    expect(screen.getByText('MEO')).toBeInTheDocument()
    expect(screen.getByText('ISS')).toBeInTheDocument()
    expect(screen.getByText('Hubble')).toBeInTheDocument()
    expect(screen.getByText('GPS')).toBeInTheDocument()
  })
})
