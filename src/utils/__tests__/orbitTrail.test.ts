import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeOrbitTrail, getSatellitePosition } from '../orbitTrail'
import { Vector3 } from 'three'

// Mock wasmLoader
vi.mock('@/orbit/wasmLoader', () => ({
  sgp4Propagate: vi.fn(),
  sgp4GetElements: vi.fn(),
}))

import { sgp4Propagate, sgp4GetElements } from '@/orbit/wasmLoader'

// ============================================================================
// Test data
// ============================================================================

const VALID_HANDLE = 1
const INVALID_HANDLE = 99999
const EPOCH_JD = 2451545.0

const VALID_ELEMENTS = {
  a: 6781,
  e: 0.0007,
  i: 0.9,
  raan: 3.49,
  argp: 0.87,
  ta: 5.41,
}

const VALID_POSITION = {
  x: 6781,
  y: 0,
  z: 0,
  vx: 0,
  vy: 7.669,
  vz: 0,
}

// ============================================================================
// computeOrbitTrail
// ============================================================================

describe('computeOrbitTrail', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Valid handle returns orbital elements and position
    vi.mocked(sgp4GetElements).mockImplementation((handle: number) => {
      if (handle === INVALID_HANDLE) return null
      return VALID_ELEMENTS
    })

    vi.mocked(sgp4Propagate).mockImplementation((handle: number) => {
      if (handle === INVALID_HANDLE) return null
      return VALID_POSITION
    })
  })

  it('returns array of Vector3 for valid handle', () => {
    const result = computeOrbitTrail(VALID_HANDLE, EPOCH_JD, 10)

    expect(result).toBeInstanceOf(Array)
    expect(result.length).toBeGreaterThan(0)
    result.forEach((p) => {
      expect(p).toBeInstanceOf(Vector3)
    })
  })

  it('returns empty array for invalid handle (sgp4GetElements returns null)', () => {
    const result = computeOrbitTrail(INVALID_HANDLE, EPOCH_JD)

    expect(result).toEqual([])
  })

  it('returns empty array when semi-major axis <= 0', () => {
    vi.mocked(sgp4GetElements).mockReturnValueOnce({ ...VALID_ELEMENTS, a: -100 })

    const result = computeOrbitTrail(VALID_HANDLE, EPOCH_JD)

    expect(result).toEqual([])
  })

  it('positions are in scene units (km/1000)', () => {
    const SCALE = 1000
    const result = computeOrbitTrail(VALID_HANDLE, EPOCH_JD, 10)

    expect(result.length).toBeGreaterThan(0)
    // First point: x = 6781/1000 = 6.781, y = 0/1000 = 0, z = -0/1000 = 0
    expect(result[0].x).toBeCloseTo(VALID_POSITION.x / SCALE, 10)
  })

  it('TEME Z maps to scene Y (up)', () => {
    vi.mocked(sgp4Propagate).mockReturnValue({ x: 1000, y: 2000, z: 3000 })

    const result = computeOrbitTrail(VALID_HANDLE, EPOCH_JD, 1)

    expect(result.length).toBeGreaterThan(0)
    // Scene Y = TEME Z / 1000
    expect(result[0].y).toBeCloseTo(3000 / 1000, 10)
  })

  it('TEME Y maps to scene -Z (forward)', () => {
    vi.mocked(sgp4Propagate).mockReturnValue({ x: 1000, y: 2000, z: 3000 })

    const result = computeOrbitTrail(VALID_HANDLE, EPOCH_JD, 1)

    expect(result.length).toBeGreaterThan(0)
    // Scene Z = -TEME Y / 1000
    expect(result[0].z).toBeCloseTo(-2000 / 1000, 10)
  })

  it('returns numPoints+1 points (0 to numPoints inclusive)', () => {
    const numPoints = 50
    const result = computeOrbitTrail(VALID_HANDLE, EPOCH_JD, numPoints)

    expect(result.length).toBe(numPoints + 1)
  })

  it('positions form a complete orbit (first and last points are close)', () => {
    const numPoints = 360
    const result = computeOrbitTrail(VALID_HANDLE, EPOCH_JD, numPoints)

    // For a valid orbit the first and last positions should be close
    // (they bracket one full period). Allow tolerance for numerical effects.
    const first = result[0]
    const last = result[result.length - 1]
    const distance = first.distanceTo(last)

    // Tolerance: within 0.1 scene units
    expect(distance).toBeLessThan(0.1)
  })
})

// ============================================================================
// getSatellitePosition
// ============================================================================

describe('getSatellitePosition', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(sgp4GetElements).mockImplementation((handle: number) => {
      if (handle === INVALID_HANDLE) return null
      return VALID_ELEMENTS
    })

    vi.mocked(sgp4Propagate).mockImplementation((handle: number) => {
      if (handle === INVALID_HANDLE) return null
      return VALID_POSITION
    })
  })

  it('returns Vector3 for valid propagation', () => {
    const result = getSatellitePosition(VALID_HANDLE, EPOCH_JD)

    expect(result).toBeInstanceOf(Vector3)
  })

  it('returns null for invalid handle', () => {
    const result = getSatellitePosition(INVALID_HANDLE, EPOCH_JD)

    expect(result).toBeNull()
  })

  it('applies correct scale factor (km/1000)', () => {
    const result = getSatellitePosition(VALID_HANDLE, EPOCH_JD)

    expect(result).not.toBeNull()
    // x = 6781 / 1000 = 6.781
    expect(result!.x).toBeCloseTo(VALID_POSITION.x / 1000, 10)
  })

  it('applies correct axis swap (TEME to scene)', () => {
    const result = getSatellitePosition(VALID_HANDLE, EPOCH_JD)

    expect(result).not.toBeNull()
    // y = TEME z / 1000 = 0 / 1000 = 0
    expect(result!.y).toBeCloseTo(VALID_POSITION.z / 1000, 10)
    // z = -TEME y / 1000 = -0 / 1000 = 0
    expect(result!.z).toBeCloseTo(-VALID_POSITION.y / 1000, 10)
  })
})
