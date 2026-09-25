import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initWasm,
  sgp4Init,
  sgp4Propagate,
  sgp4GetElements,
  sgp4Clear,
  sgp4Destroy,
  propagateSatellite,
  lambertSolveWasm,
} from '../wasmLoader'
import { ISS_TLE, HUBBLE_TLE } from '@/__tests__/fixtures/tle-fixtures'
import { JD_J2000 } from '../constants'

// ---------------------------------------------------------------------------
// initWasm
// ---------------------------------------------------------------------------
describe('initWasm', () => {
  let appendChildSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    appendChildSpy = vi.spyOn(document.head, 'appendChild')
  })

  afterEach(() => {
    appendChildSpy.mockRestore()
  })

  it('returns false when script fails to load (no WASM in test env)', async () => {
    // Mock: script element fires onerror synchronously on appendChild
    appendChildSpy.mockImplementation((child: any) => {
      if (child.tagName === 'SCRIPT' && typeof child.onerror === 'function') {
        child.onerror(new Event('error'))
      }
      return child
    })

    const result = await initWasm()
    expect(result).toBe(false)
  })

  it('returns false when ZenithWasm factory is not on globalThis', async () => {
    // Mock: script loads successfully, but ZenithWasm is not defined
    appendChildSpy.mockImplementation((child: any) => {
      if (child.tagName === 'SCRIPT' && typeof child.onload === 'function') {
        child.onload(new Event('load'))
      }
      return child
    })

    // Ensure no ZenithWasm factory exists
    const hadFactory = (globalThis as any).ZenithWasm
    delete (globalThis as any).ZenithWasm

    const result = await initWasm()
    expect(result).toBe(false)

    // Restore if it existed before
    if (hadFactory !== undefined) {
      ;(globalThis as any).ZenithWasm = hadFactory
    }
  })
})

// ---------------------------------------------------------------------------
// sgp4Init
// ---------------------------------------------------------------------------
describe('sgp4Init', () => {
  beforeEach(() => {
    sgp4Clear()
  })

  it('returns a number handle for valid ISS TLE', () => {
    const handle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)
    expect(handle).toBeTypeOf('number')
    expect(Number.isFinite(handle)).toBe(true)
  })

  it('returns a number handle for valid Hubble TLE', () => {
    const handle = sgp4Init(HUBBLE_TLE.line1, HUBBLE_TLE.line2)
    expect(handle).toBeTypeOf('number')
    expect(Number.isFinite(handle)).toBe(true)
  })

  it('returns null for invalid TLE (garbage strings)', () => {
    const handle = sgp4Init('garbage line1', 'garbage line 2')
    expect(handle).toBeNull()
  })

  it('returns null for empty strings', () => {
    const handle = sgp4Init('', '')
    expect(handle).toBeNull()
  })

  it('returns different handles for different satellites', () => {
    const issHandle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)
    const hubbleHandle = sgp4Init(HUBBLE_TLE.line1, HUBBLE_TLE.line2)
    expect(issHandle).not.toBeNull()
    expect(hubbleHandle).not.toBeNull()
    expect(issHandle).not.toBe(hubbleHandle)
  })

  it('returns different handles for same TLE parsed twice (no dedup)', () => {
    const h1 = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)
    const h2 = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)
    expect(h1).not.toBeNull()
    expect(h2).not.toBeNull()
    expect(h1).not.toBe(h2)
    // Both handles should produce the same propagation data
    const pos1 = sgp4Propagate(h1!, JD_J2000)
    const pos2 = sgp4Propagate(h2!, JD_J2000)
    expect(pos1).toEqual(pos2)
  })
})

// ---------------------------------------------------------------------------
// sgp4Propagate
// ---------------------------------------------------------------------------
describe('sgp4Propagate', () => {
  let handle: number

  beforeEach(() => {
    sgp4Clear()
    handle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)!
  })

  it('returns position with x, y, z for ISS at J2000', () => {
    const result = sgp4Propagate(handle, JD_J2000)
    expect(result).not.toBeNull()
    expect(result!.x).toBeTypeOf('number')
    expect(result!.y).toBeTypeOf('number')
    expect(result!.z).toBeTypeOf('number')
    expect(Number.isFinite(result!.x)).toBe(true)
    expect(Number.isFinite(result!.y)).toBe(true)
    expect(Number.isFinite(result!.z)).toBe(true)
  })

  it('returns velocity with vx, vy, vz for ISS at J2000', () => {
    const result = sgp4Propagate(handle, JD_J2000)
    expect(result).not.toBeNull()
    expect(result!.vx).toBeTypeOf('number')
    expect(result!.vy).toBeTypeOf('number')
    expect(result!.vz).toBeTypeOf('number')
    expect(Number.isFinite(result!.vx)).toBe(true)
    expect(Number.isFinite(result!.vy)).toBe(true)
    expect(Number.isFinite(result!.vz)).toBe(true)
  })

  it('position magnitude is in LEO range (6700-7000 km for ISS)', () => {
    const result = sgp4Propagate(handle, JD_J2000)
    expect(result).not.toBeNull()
    const mag = Math.sqrt(result!.x ** 2 + result!.y ** 2 + result!.z ** 2)
    expect(mag).toBeGreaterThan(6700)
    expect(mag).toBeLessThan(7000)
  })

  it('velocity magnitude is reasonable (7-8 km/s for LEO)', () => {
    const result = sgp4Propagate(handle, JD_J2000)
    expect(result).not.toBeNull()
    const vmag = Math.sqrt(
      result!.vx ** 2 + result!.vy ** 2 + result!.vz ** 2,
    )
    expect(vmag).toBeGreaterThan(7)
    expect(vmag).toBeLessThan(8)
  })

  it('returns null for invalid handle (99999)', () => {
    const result = sgp4Propagate(99999, JD_J2000)
    expect(result).toBeNull()
  })

  it('position changes over 1 day propagation', () => {
    const pos1 = sgp4Propagate(handle, JD_J2000)
    const pos2 = sgp4Propagate(handle, JD_J2000 + 1)
    expect(pos1).not.toBeNull()
    expect(pos2).not.toBeNull()
    // At least one coordinate should differ after 1 day
    const differs =
      pos1!.x !== pos2!.x || pos1!.y !== pos2!.y || pos1!.z !== pos2!.z
    expect(differs).toBe(true)
  })

  it('trajectory is smooth (position change < 5000 km per 10 minutes)', () => {
    const dt = 10 / 1440 // 10 minutes in days
    const pos1 = sgp4Propagate(handle, JD_J2000)
    const pos2 = sgp4Propagate(handle, JD_J2000 + dt)
    expect(pos1).not.toBeNull()
    expect(pos2).not.toBeNull()
    const dist = Math.sqrt(
      (pos2!.x - pos1!.x) ** 2 +
        (pos2!.y - pos1!.y) ** 2 +
        (pos2!.z - pos1!.z) ** 2,
    )
    expect(dist).toBeLessThan(5000)
  })
})

// ---------------------------------------------------------------------------
// sgp4GetElements
// ---------------------------------------------------------------------------
describe('sgp4GetElements', () => {
  let handle: number

  beforeEach(() => {
    sgp4Clear()
    handle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)!
  })

  it('returns semi-major axis > 0 for ISS', () => {
    const elements = sgp4GetElements(handle, JD_J2000)
    expect(elements).not.toBeNull()
    expect(elements!.a).toBeGreaterThan(0)
  })

  it('returns eccentricity between 0 and 1 for ISS', () => {
    const elements = sgp4GetElements(handle, JD_J2000)
    expect(elements).not.toBeNull()
    expect(elements!.e).toBeGreaterThanOrEqual(0)
    expect(elements!.e).toBeLessThan(1)
  })

  it('returns inclination > 0 for ISS', () => {
    const elements = sgp4GetElements(handle, JD_J2000)
    expect(elements).not.toBeNull()
    expect(elements!.i).toBeGreaterThan(0)
  })

  it('returns null for invalid handle', () => {
    const elements = sgp4GetElements(99999, JD_J2000)
    expect(elements).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// sgp4Clear
// ---------------------------------------------------------------------------
describe('sgp4Clear', () => {
  it('after clear, previously valid handle returns null from sgp4Propagate', () => {
    const handle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)!
    // Verify handle works before clear
    expect(sgp4Propagate(handle, JD_J2000)).not.toBeNull()
    // Clear all propagators
    sgp4Clear()
    // Handle should now return null
    expect(sgp4Propagate(handle, JD_J2000)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// lambertSolveWasm
// ---------------------------------------------------------------------------
describe('lambertSolveWasm', () => {
  it('returns null when WASM is not available (test env)', () => {
    const r1: [number, number, number] = [7000, 0, 0]
    const r2: [number, number, number] = [0, 7000, 0]
    const result = lambertSolveWasm(r1, r2, 1800, 398600.4418)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('Edge cases', () => {
  beforeEach(() => {
    sgp4Clear()
  })

  it('sgp4Init with ISS TLE (skip_checksum=true) still works', () => {
    // The TS fallback always uses skip_checksum=true internally;
    // verify it parses successfully and produces valid propagation.
    const handle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)
    expect(handle).not.toBeNull()
    const result = sgp4Propagate(handle!, JD_J2000)
    expect(result).not.toBeNull()
    const mag = Math.sqrt(result!.x ** 2 + result!.y ** 2 + result!.z ** 2)
    expect(mag).toBeGreaterThan(6000)
  })

  it('sgp4Propagate at different epochs returns different positions', () => {
    const handle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)!
    const pos1 = sgp4Propagate(handle, JD_J2000)
    const pos2 = sgp4Propagate(handle, JD_J2000 + 0.5) // 12 hours later
    expect(pos1).not.toBeNull()
    expect(pos2).not.toBeNull()
    // At least one coordinate should differ
    const differs =
      pos1!.x !== pos2!.x || pos1!.y !== pos2!.y || pos1!.z !== pos2!.z
    expect(differs).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// sgp4Destroy
// ---------------------------------------------------------------------------
describe('sgp4Destroy', () => {
  beforeEach(() => {
    sgp4Clear()
  })

  it('removes handle so sgp4Propagate returns null', () => {
    const handle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)!
    expect(sgp4Propagate(handle, JD_J2000)).not.toBeNull()
    sgp4Destroy(handle)
    expect(sgp4Propagate(handle, JD_J2000)).toBeNull()
  })

  it('destroying non-existent handle is a no-op', () => {
    // Should not throw
    expect(() => sgp4Destroy(99999)).not.toThrow()
  })

  it('destroys one satellite while leaving others intact', () => {
    const handleA = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)!
    const handleB = sgp4Init(HUBBLE_TLE.line1, HUBBLE_TLE.line2)!
    expect(sgp4Propagate(handleA, JD_J2000)).not.toBeNull()
    expect(sgp4Propagate(handleB, JD_J2000)).not.toBeNull()

    sgp4Destroy(handleA)

    expect(sgp4Propagate(handleA, JD_J2000)).toBeNull()
    expect(sgp4Propagate(handleB, JD_J2000)).not.toBeNull()
  })

  it('double-destroy is safe', () => {
    const handle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)!
    sgp4Destroy(handle)
    expect(() => sgp4Destroy(handle)).not.toThrow()
    expect(sgp4Propagate(handle, JD_J2000)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// propagateSatellite
// ---------------------------------------------------------------------------
describe('propagateSatellite', () => {
  let handle: number

  beforeEach(() => {
    sgp4Clear()
    handle = sgp4Init(ISS_TLE.line1, ISS_TLE.line2)!
  })

  it('with method=sgp4 returns valid position via TS fallback', () => {
    const result = propagateSatellite(handle, JD_J2000, 'sgp4')
    expect(result).not.toBeNull()
    expect(result!.x).toBeTypeOf('number')
    expect(result!.y).toBeTypeOf('number')
    expect(result!.z).toBeTypeOf('number')
    expect(Number.isFinite(result!.x)).toBe(true)
  })

  it('with method=kepler uses TS fallback directly', () => {
    const result = propagateSatellite(handle, JD_J2000, 'kepler')
    expect(result).not.toBeNull()
    expect(result!.x).toBeTypeOf('number')
    expect(Number.isFinite(result!.x)).toBe(true)
    // Kepler result should have same order of magnitude as sgp4
    const mag = Math.sqrt(result!.x ** 2 + result!.y ** 2 + result!.z ** 2)
    expect(mag).toBeGreaterThan(6000)
    expect(mag).toBeLessThan(8000)
  })

  it('with method=rk45 falls back to SGP4 (TS fallback)', () => {
    const result = propagateSatellite(handle, JD_J2000, 'rk45')
    expect(result).not.toBeNull()
    const mag = Math.sqrt(result!.x ** 2 + result!.y ** 2 + result!.z ** 2)
    expect(mag).toBeGreaterThan(6000)
    expect(mag).toBeLessThan(8000)
  })

  it('with default method uses sgp4', () => {
    const result = propagateSatellite(handle, JD_J2000)
    expect(result).not.toBeNull()
    const mag = Math.sqrt(result!.x ** 2 + result!.y ** 2 + result!.z ** 2)
    expect(mag).toBeGreaterThan(6700)
    expect(mag).toBeLessThan(7000)
  })

  it('handles null/invalid handle gracefully', () => {
    const result = propagateSatellite(99999, JD_J2000, 'sgp4')
    expect(result).toBeNull()
  })

  it('kepler method with invalid handle returns null', () => {
    const result = propagateSatellite(99999, JD_J2000, 'kepler')
    expect(result).toBeNull()
  })

  it('kepler and sgp4 produce similar positions for near-circular orbits', () => {
    const sgp4Result = propagateSatellite(handle, JD_J2000, 'sgp4')
    const keplerResult = propagateSatellite(handle, JD_J2000, 'kepler')
    expect(sgp4Result).not.toBeNull()
    expect(keplerResult).not.toBeNull()

    // For near-circular ISS orbit, both should produce same position (no J2/drag in TS fallback)
    // The TS sgp4_propagate_ts is used by both code paths, so results should be identical
    expect(sgp4Result!.x).toBeCloseTo(keplerResult!.x, 6)
    expect(sgp4Result!.y).toBeCloseTo(keplerResult!.y, 6)
    expect(sgp4Result!.z).toBeCloseTo(keplerResult!.z, 6)
  })

  it('position changes over time for kepler method', () => {
    const pos1 = propagateSatellite(handle, JD_J2000, 'kepler')
    const pos2 = propagateSatellite(handle, JD_J2000 + 1, 'kepler')
    expect(pos1).not.toBeNull()
    expect(pos2).not.toBeNull()
    const differs =
      pos1!.x !== pos2!.x || pos1!.y !== pos2!.y || pos1!.z !== pos2!.z
    expect(differs).toBe(true)
  })
})
