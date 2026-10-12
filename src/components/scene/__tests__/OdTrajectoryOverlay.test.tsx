import { describe, it, expect, vi } from 'vitest'
import { buildBatchOrbitPath } from '../OdTrajectoryOverlay'
import { MU_EARTH } from '@/orbit/constants'

// Scene components are not unit-tested (no R3F test renderer in deps; matches
// the existing scene precedent: zero test files for scene components). Only
// the exported pure two-body path helper is covered here.
vi.mock('@react-three/drei', () => ({
  Line: () => null,
}))

/** Circular LEO state at 6781 km radius in the equatorial plane. */
const CIRCULAR_STATE = (() => {
  const r = 6781
  const v = Math.sqrt(MU_EARTH / r)
  return [r, 0, 0, 0, v, 0]
})()

/** GTO-like elliptical state: perigee 7000 km, apogee about 42000 km. */
const ELLIPTICAL_STATE = (() => {
  const mu = MU_EARTH
  const rp = 7000
  const ra = 42164
  const a = (rp + ra) / 2
  const vp = Math.sqrt(mu * ((2 / rp) - (1 / a)))
  return [rp, 0, 0, 0, vp, 0]
})()

describe('buildBatchOrbitPath', () => {
  it('returns a closed path of nPoints + 1 entries for a circular orbit', () => {
    const path = buildBatchOrbitPath(CIRCULAR_STATE, 100)

    expect(path).not.toBeNull()
    expect(path!).toHaveLength(101)
    // Closed: last point returns to the first (floating-point tolerance).
    for (let i = 0; i < 3; i += 1) {
      expect(path![100]![i]).toBeCloseTo(path![0]![i]!, 9)
    }
  })

  it('keeps a constant radius for a circular orbit', () => {
    const path = buildBatchOrbitPath(CIRCULAR_STATE, 36)!

    for (const [x, y, z] of path) {
      expect(Math.hypot(x, y, z)).toBeCloseTo(6781, 6)
    }
  })

  it('sweeps the full radius range of an elliptical orbit', () => {
    const path = buildBatchOrbitPath(ELLIPTICAL_STATE, 180)!

    const radii = path.map(([x, y, z]) => Math.hypot(x, y, z))
    const min = Math.min(...radii)
    const max = Math.max(...radii)
    expect(min).toBeCloseTo(7000, 3)
    expect(max).toBeCloseTo(42164, 1)
  })

  it('returns all finite positions for a valid state', () => {
    const path = buildBatchOrbitPath(ELLIPTICAL_STATE, 50)!

    for (const point of path) {
      for (const component of point) {
        expect(Number.isFinite(component)).toBe(true)
      }
    }
  })

  it('keeps an inclined retrograde orbit path finite with correct radii', () => {
    // Molniya-like apogee state: a=26600 km, e=0.74, rotated to inclination
    // 120 deg (retrograde) and RAAN 45 deg. buildBatchOrbitPath must stay
    // finite for non-equatorial geometry (no asin-domain NaN).
    const a = 26600
    const e = 0.74
    const rApo = a * (1 + e)
    const vApo = Math.sqrt(MU_EARTH * (2 / rApo - 1 / a))
    const inc = (120 * Math.PI) / 180
    const raan = (45 * Math.PI) / 180
    const ci = Math.cos(inc)
    const si = Math.sin(inc)
    const cr = Math.cos(raan)
    const sr = Math.sin(raan)
    const rot = (v: number[]): number[] => {
      const x1 = v[0]!
      const y1 = ci * v[1]! - si * v[2]!
      const z1 = si * v[1]! + ci * v[2]!
      return [cr * x1 - sr * y1, sr * x1 + cr * y1, z1]
    }
    const state = [...rot([rApo, 0, 0]), ...rot([0, vApo, 0])]

    const path = buildBatchOrbitPath(state, 200)
    expect(path).not.toBeNull()

    // Every component finite (the asin-clamp NaN risk this guards against).
    for (const point of path!) {
      for (const component of point) {
        expect(Number.isFinite(component)).toBe(true)
      }
    }
    // Radius sweeps exactly the apogee/perigee range of the ellipse.
    const radii = path!.map(([x, y, z]) => Math.hypot(x, y, z))
    expect(Math.max(...radii)).toBeCloseTo(rApo, 3)
    expect(Math.min(...radii)).toBeCloseTo(a * (1 - e), 3)
    // Closed to floating-point tolerance.
    for (let i = 0; i < 3; i += 1) {
      expect(path![200]![i]).toBeCloseTo(path![0]![i]!, 9)
    }
  })

  it('returns null for a wrong-length or non-finite state', () => {
    expect(buildBatchOrbitPath([6781, 0, 0])).toBeNull()
    expect(buildBatchOrbitPath([6781, 0, 0, 0, NaN, 0])).toBeNull()
  })

  it('returns null for a degenerate or hyperbolic state', () => {
    // Zero velocity (radial fall, no angular momentum).
    expect(buildBatchOrbitPath([6781, 0, 0, 0, 0, 0])).toBeNull()
    // Escape velocity and above (hyperbolic).
    const escape = Math.sqrt((2 * MU_EARTH) / 6781)
    expect(buildBatchOrbitPath([6781, 0, 0, 0, escape * 1.1, 0])).toBeNull()
  })
})
