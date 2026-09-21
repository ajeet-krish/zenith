import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TimeControls } from '../TimeControls'
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

// Valid Julian Date for 2024-04-10 ~12:00 UTC
const VALID_EPOCH = 2460410.0

describe('TimeControls', () => {
  let rafSpy: ReturnType<typeof vi.fn>
  let cafSpy: ReturnType<typeof vi.fn>
  let frameCallbacks: FrameRequestCallback[]
  let frameId: number

  beforeEach(() => {
    vi.clearAllMocks()
    frameCallbacks = []
    frameId = 0

    rafSpy = vi.fn((cb: FrameRequestCallback) => {
      frameCallbacks.push(cb)
      return ++frameId
    })
    cafSpy = vi.fn(() => {})

    global.requestAnimationFrame = rafSpy
    global.cancelAnimationFrame = cafSpy

    useMissionStore.setState({
      satellites: [],
      selectedSatelliteId: null,
      currentEpoch: VALID_EPOCH,
      isPlaying: false,
      timeSpeed: 1,
      propagationMethod: 'sgp4',
      forceModels: { j2: true, drag: false, srp: false, thirdBody: false },
      wasmReady: false,
    })
  })

  afterEach(() => {
    cleanup()
    // Restore original mocks from setup.ts
    global.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0)) as any
    global.cancelAnimationFrame = vi.fn((id) => clearTimeout(id as any)) as any
  })

  it('renders the TIME panel label', () => {
    render(<TimeControls />)
    expect(screen.getByText('TIME')).toBeInTheDocument()
  })

  it('renders a time display with UTC', () => {
    render(<TimeControls />)
    expect(screen.getByText(/UTC/)).toBeInTheDocument()
  })

  it('renders play button', () => {
    render(<TimeControls />)
    expect(screen.getByRole('button', { name: /Play/i })).toBeInTheDocument()
  })

  it('renders pause button when playing', () => {
    useMissionStore.setState({ isPlaying: true })
    render(<TimeControls />)
    expect(screen.getByRole('button', { name: /Pause/i })).toBeInTheDocument()
  })

  it('play button toggles isPlaying', async () => {
    const user = userEvent.setup()
    render(<TimeControls />)

    const playBtn = screen.getByRole('button', { name: /Play/i })
    await user.click(playBtn)

    expect(useMissionStore.getState().isPlaying).toBe(true)
  })

  it('pause button stops playing', async () => {
    const user = userEvent.setup()
    useMissionStore.setState({ isPlaying: true })
    render(<TimeControls />)

    const pauseBtn = screen.getByRole('button', { name: /Pause/i })
    await user.click(pauseBtn)

    expect(useMissionStore.getState().isPlaying).toBe(false)
  })

  it('renders all speed buttons', () => {
    render(<TimeControls />)
    expect(screen.getByRole('button', { name: /Set speed to 0\.1x/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Set speed to 1x/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Set speed to 10x/i })).toBeInTheDocument()
  })

  it('clicking a speed button changes timeSpeed', async () => {
    const user = userEvent.setup()
    render(<TimeControls />)

    const speedBtn = screen.getByRole('button', { name: /Set speed to 10x/i })
    await user.click(speedBtn)

    expect(useMissionStore.getState().timeSpeed).toBe(10)
  })

  it('renders step backward and step forward buttons', () => {
    render(<TimeControls />)
    expect(screen.getByRole('button', { name: /Step backward/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Step forward/i })).toBeInTheDocument()
  })

  it('renders reset button', () => {
    render(<TimeControls />)
    expect(screen.getByRole('button', { name: /Reset to current time/i })).toBeInTheDocument()
  })

  it('reset button updates currentEpoch', async () => {
    const user = userEvent.setup()
    useMissionStore.setState({ currentEpoch: VALID_EPOCH - 1 })
    render(<TimeControls />)

    const resetBtn = screen.getByRole('button', { name: /Reset to current time/i })
    await user.click(resetBtn)

    // Epoch should have changed (reset to current JD)
    const newEpoch = useMissionStore.getState().currentEpoch
    expect(newEpoch).not.toBe(VALID_EPOCH - 1)
  })
})
