import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PropagationPanel } from '../PropagationPanel'
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

describe('PropagationPanel', () => {
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

  it('renders the PROP label', () => {
    render(<PropagationPanel />)
    expect(screen.getByText('PROP')).toBeInTheDocument()
  })

  it('renders propagation method buttons (SGP4, Kepler, RK45)', () => {
    render(<PropagationPanel />)
    expect(screen.getByText('SGP4')).toBeInTheDocument()
    expect(screen.getByText('Kepler')).toBeInTheDocument()
    expect(screen.getByText('RK45')).toBeInTheDocument()
  })

  it('shows "TS" badge when wasm is not ready', () => {
    render(<PropagationPanel />)
    expect(screen.getByText('TS')).toBeInTheDocument()
  })

  it('shows "WASM" badge when wasm is ready', () => {
    useMissionStore.setState({ wasmReady: true })
    render(<PropagationPanel />)
    expect(screen.getByText('WASM')).toBeInTheDocument()
  })

  it('clicking a propagation method button updates the store', async () => {
    const user = userEvent.setup()
    render(<PropagationPanel />)

    const keplerBtn = screen.getByText('Kepler').closest('button')!
    await user.click(keplerBtn)

    expect(useMissionStore.getState().propagationMethod).toBe('kepler')
  })

  it('renders force model toggle buttons', () => {
    render(<PropagationPanel />)
    expect(screen.getByText('J2')).toBeInTheDocument()
    expect(screen.getByText('Drag')).toBeInTheDocument()
    expect(screen.getByText('SRP')).toBeInTheDocument()
    expect(screen.getByText('3rd')).toBeInTheDocument()
  })

  it('clicking a force model button toggles it', async () => {
    const user = userEvent.setup()
    render(<PropagationPanel />)

    // drag is initially false, clicking should toggle to true
    const dragBtn = screen.getByText('Drag').closest('button')!
    await user.click(dragBtn)

    expect(useMissionStore.getState().forceModels.drag).toBe(true)
  })

  it('clicking an active force model button disables it', async () => {
    const user = userEvent.setup()
    render(<PropagationPanel />)

    // j2 is initially true, clicking should toggle to false
    const j2Btn = screen.getByText('J2').closest('button')!
    await user.click(j2Btn)

    expect(useMissionStore.getState().forceModels.j2).toBe(false)
  })

  it('displays the current epoch JD', () => {
    render(<PropagationPanel />)
    const epochJD = useMissionStore.getState().currentEpoch
    expect(screen.getByText(epochJD.toFixed(4))).toBeInTheDocument()
  })

  it('renders the JD label', () => {
    render(<PropagationPanel />)
    expect(screen.getByText('JD')).toBeInTheDocument()
  })
})
