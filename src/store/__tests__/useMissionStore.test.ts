import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMissionStore, CATEGORY_COLORS } from '../useMissionStore'
import { sgp4Init } from '@/orbit/wasmLoader'

// Mock wasmLoader
vi.mock('@/orbit/wasmLoader', () => ({
  sgp4Init: vi.fn(() => 42),
  sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
  sgp4GetElements: vi.fn(() => ({ a: 6781, e: 0.0007, i: 0.9, raan: 3.49, argp: 0.87, ta: 5.41 })),
  sgp4Destroy: vi.fn(),
}))

// Mock sampleTles so we can control what loadSampleSatellites processes
vi.mock('@/orbit/sampleTles', () => ({
  SAMPLE_TLES: [
    { name: 'ISS', noradId: 25544, line1: '1 25544U 98067A', line2: '2 25544  51.64', category: 'LEO' },
    { name: 'TIANGONG', noradId: 48274, line1: '1 48274U 21035A', line2: '2 48274  41.50', category: 'LEO' },
    { name: 'HUBBLE', noradId: 20580, line1: '1 20580U 90037B', line2: '2 20580  28.47', category: 'LEO' },
    { name: 'STARLINK-1007', noradId: 44713, line1: '1 44713U 19074A', line2: '2 44713  53.00', category: 'LEO' },
    { name: 'GPS BIIR-01', noradId: 24873, line1: '1 24873U 97035A', line2: '2 24873  55.00', category: 'MEO' },
    { name: 'BEIDOU-3 M1', noradId: 44203, line1: '1 44203U 19023A', line2: '2 44203  55.00', category: 'MEO' },
    { name: 'GOES-16', noradId: 41888, line1: '1 41888U 16080A', line2: '2 41888   0.50', category: 'GEO' },
    { name: 'COSMOS 2251', noradId: 22674, line1: '1 22674U 93036B', line2: '2 22674  74.00', category: 'DEBRIS' },
    { name: 'IRIDIUM 33', noradId: 24793, line1: '1 24793U 97020B', line2: '2 24793  86.40', category: 'DEBRIS' },
  ],
  getTleByNoradId: vi.fn(),
  getTleByName: vi.fn(),
  getTlesByCategory: vi.fn(),
}))

// Reset store between tests
beforeEach(() => {
  useMissionStore.setState({
    satellites: [],
    selectedSatelliteId: null,
    isPlaying: false,
    timeSpeed: 1,
    propagationMethod: 'sgp4',
    forceModels: { j2: true, drag: false, srp: false, thirdBody: false },
    isLoading: false,
    wasmReady: false,
  })
})

// Helper to build a satellite object for addSatellite
const makeSatInput = (overrides?: Partial<{ name: string; noradId: number; line1: string; line2: string; category: 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'DEBRIS'; color: string; visible: boolean }>) => ({
  name: 'Test Sat',
  noradId: 99999,
  line1: '1 99999U 00001A   24100.50000000  .00000000  00000-0  00000-0 0  9001',
  line2: '2 99999  51.6400 200.0000 0005000  50.0000 310.0000 15.49000000 10000',
  category: 'LEO' as const,
  color: CATEGORY_COLORS.LEO,
  visible: true,
  ...overrides,
})

// =============================================================================
// Initial State
// =============================================================================

describe('Initial State', () => {
  it('satellites is empty array', () => {
    expect(useMissionStore.getState().satellites).toEqual([])
  })

  it('selectedSatelliteId is null', () => {
    expect(useMissionStore.getState().selectedSatelliteId).toBeNull()
  })

  it('isPlaying is false', () => {
    expect(useMissionStore.getState().isPlaying).toBe(false)
  })

  it('timeSpeed is 1', () => {
    expect(useMissionStore.getState().timeSpeed).toBe(1)
  })

  it("propagationMethod is 'sgp4'", () => {
    expect(useMissionStore.getState().propagationMethod).toBe('sgp4')
  })

  it('forceModels j2 is true', () => {
    expect(useMissionStore.getState().forceModels.j2).toBe(true)
  })

  it('forceModels drag is false', () => {
    expect(useMissionStore.getState().forceModels.drag).toBe(false)
  })

  it('forceModels srp is false', () => {
    expect(useMissionStore.getState().forceModels.srp).toBe(false)
  })

  it('forceModels thirdBody is false', () => {
    expect(useMissionStore.getState().forceModels.thirdBody).toBe(false)
  })

  it('isLoading is false', () => {
    expect(useMissionStore.getState().isLoading).toBe(false)
  })

  it('wasmReady is false', () => {
    expect(useMissionStore.getState().wasmReady).toBe(false)
  })
})

// =============================================================================
// addSatellite
// =============================================================================

describe('addSatellite', () => {
  it('adds satellite to satellites array', () => {
    useMissionStore.getState().addSatellite(makeSatInput())
    expect(useMissionStore.getState().satellites).toHaveLength(1)
  })

  it('assigns unique ids', () => {
    useMissionStore.getState().addSatellite(makeSatInput({ name: 'Sat A' }))
    useMissionStore.getState().addSatellite(makeSatInput({ name: 'Sat B' }))
    const sats = useMissionStore.getState().satellites
    expect(sats).toHaveLength(2)
    expect(sats[0].id).not.toBe(sats[1].id)
    expect(sats[0].id).toMatch(/^sat-\d+$/)
    expect(sats[1].id).toMatch(/^sat-\d+$/)
  })

  it('sets handle from sgp4Init', () => {
    vi.mocked(sgp4Init).mockClear()
    useMissionStore.getState().addSatellite(makeSatInput())
    expect(sgp4Init).toHaveBeenCalledTimes(1)
    expect(useMissionStore.getState().satellites[0].handle).toBe(42)
  })

  it('sets category color from CATEGORY_COLORS', () => {
    useMissionStore.getState().addSatellite(makeSatInput({ category: 'MEO', color: CATEGORY_COLORS.MEO }))
    const sat = useMissionStore.getState().satellites[0]
    expect(sat.color).toBe(CATEGORY_COLORS.MEO)
  })
})

// =============================================================================
// removeSatellite
// =============================================================================

describe('removeSatellite', () => {
  it('removes satellite from array', () => {
    useMissionStore.getState().addSatellite(makeSatInput())
    const id = useMissionStore.getState().satellites[0].id
    useMissionStore.getState().removeSatellite(id)
    expect(useMissionStore.getState().satellites).toHaveLength(0)
  })

  it('clears selection if selected satellite is removed', () => {
    useMissionStore.getState().addSatellite(makeSatInput())
    const id = useMissionStore.getState().satellites[0].id
    useMissionStore.getState().selectSatellite(id)
    expect(useMissionStore.getState().selectedSatelliteId).toBe(id)
    useMissionStore.getState().removeSatellite(id)
    expect(useMissionStore.getState().selectedSatelliteId).toBeNull()
  })

  it('preserves selection if different satellite is removed', () => {
    useMissionStore.getState().addSatellite(makeSatInput({ name: 'Sat A' }))
    useMissionStore.getState().addSatellite(makeSatInput({ name: 'Sat B' }))
    const sats = useMissionStore.getState().satellites
    useMissionStore.getState().selectSatellite(sats[0].id)
    useMissionStore.getState().removeSatellite(sats[1].id)
    expect(useMissionStore.getState().selectedSatelliteId).toBe(sats[0].id)
    expect(useMissionStore.getState().satellites).toHaveLength(1)
  })
})

// =============================================================================
// selectSatellite
// =============================================================================

describe('selectSatellite', () => {
  it('sets selectedSatelliteId', () => {
    useMissionStore.getState().addSatellite(makeSatInput())
    const id = useMissionStore.getState().satellites[0].id
    useMissionStore.getState().selectSatellite(id)
    expect(useMissionStore.getState().selectedSatelliteId).toBe(id)
  })

  it('null clears selection', () => {
    useMissionStore.getState().addSatellite(makeSatInput())
    const id = useMissionStore.getState().satellites[0].id
    useMissionStore.getState().selectSatellite(id)
    useMissionStore.getState().selectSatellite(null)
    expect(useMissionStore.getState().selectedSatelliteId).toBeNull()
  })
})

// =============================================================================
// toggleSatelliteVisibility
// =============================================================================

describe('toggleSatelliteVisibility', () => {
  it('toggles visible flag from true to false', () => {
    useMissionStore.getState().addSatellite(makeSatInput({ visible: true }))
    const id = useMissionStore.getState().satellites[0].id
    useMissionStore.getState().toggleSatelliteVisibility(id)
    expect(useMissionStore.getState().satellites[0].visible).toBe(false)
  })

  it('toggles visible flag from false to true', () => {
    useMissionStore.getState().addSatellite(makeSatInput({ visible: false }))
    const id = useMissionStore.getState().satellites[0].id
    useMissionStore.getState().toggleSatelliteVisibility(id)
    expect(useMissionStore.getState().satellites[0].visible).toBe(true)
  })
})

// =============================================================================
// setTimeSpeed
// =============================================================================

describe('setTimeSpeed', () => {
  it('sets timeSpeed normally', () => {
    useMissionStore.getState().setTimeSpeed(5)
    expect(useMissionStore.getState().timeSpeed).toBe(5)
  })

  it('clamps to minimum 0.1 (input 0.01 becomes 0.1)', () => {
    useMissionStore.getState().setTimeSpeed(0.01)
    expect(useMissionStore.getState().timeSpeed).toBe(0.1)
  })

  it('clamps to maximum 100 (input 200 becomes 100)', () => {
    useMissionStore.getState().setTimeSpeed(200)
    expect(useMissionStore.getState().timeSpeed).toBe(100)
  })
})

// =============================================================================
// setPropagationMethod
// =============================================================================

describe('setPropagationMethod', () => {
  it("sets method to 'kepler'", () => {
    useMissionStore.getState().setPropagationMethod('kepler')
    expect(useMissionStore.getState().propagationMethod).toBe('kepler')
  })

  it("sets method to 'rk45'", () => {
    useMissionStore.getState().setPropagationMethod('rk45')
    expect(useMissionStore.getState().propagationMethod).toBe('rk45')
  })
})

// =============================================================================
// toggleForceModel
// =============================================================================

describe('toggleForceModel', () => {
  it('toggles j2 from true to false', () => {
    expect(useMissionStore.getState().forceModels.j2).toBe(true)
    useMissionStore.getState().toggleForceModel('j2')
    expect(useMissionStore.getState().forceModels.j2).toBe(false)
  })

  it('toggles drag from false to true', () => {
    expect(useMissionStore.getState().forceModels.drag).toBe(false)
    useMissionStore.getState().toggleForceModel('drag')
    expect(useMissionStore.getState().forceModels.drag).toBe(true)
  })
})

// =============================================================================
// setWasmReady
// =============================================================================

describe('setWasmReady', () => {
  it('sets wasmReady to true', () => {
    useMissionStore.getState().setWasmReady(true)
    expect(useMissionStore.getState().wasmReady).toBe(true)
  })

  it('sets wasmReady to false', () => {
    useMissionStore.getState().setWasmReady(false)
    expect(useMissionStore.getState().wasmReady).toBe(false)
  })
})

// =============================================================================
// loadSampleSatellites
// =============================================================================

describe('loadSampleSatellites', () => {
  it('loads 9 sample satellites', () => {
    useMissionStore.getState().loadSampleSatellites()
    expect(useMissionStore.getState().satellites).toHaveLength(9)
  })

  it('no-op if satellites already exist', () => {
    useMissionStore.getState().addSatellite(makeSatInput())
    useMissionStore.getState().loadSampleSatellites()
    expect(useMissionStore.getState().satellites).toHaveLength(1)
  })

  it('sets category colors correctly', () => {
    useMissionStore.getState().loadSampleSatellites()
    const sats = useMissionStore.getState().satellites
    for (const sat of sats) {
      expect(sat.color).toBe(CATEGORY_COLORS[sat.category])
    }
  })
})

// =============================================================================
// CATEGORY_COLORS
// =============================================================================

describe('CATEGORY_COLORS', () => {
  it('LEO is #8be9fd', () => {
    expect(CATEGORY_COLORS.LEO).toBe('#8be9fd')
  })

  it('MEO is #50fa7b', () => {
    expect(CATEGORY_COLORS.MEO).toBe('#50fa7b')
  })

  it('GEO is #ffb86c', () => {
    expect(CATEGORY_COLORS.GEO).toBe('#ffb86c')
  })

  it('HEO is #bd93f9', () => {
    expect(CATEGORY_COLORS.HEO).toBe('#bd93f9')
  })

  it('DEBRIS is #ff5555', () => {
    expect(CATEGORY_COLORS.DEBRIS).toBe('#ff5555')
  })
})
