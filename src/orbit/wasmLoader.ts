import { parse_tle } from '@/processing/tle_parser'

// Module-level state
let wasmModule: any = null

// TypeScript fallback propagator state
interface TSBucket {
  meanMotion: number
  eccentricity: number
  inclination: number
  raan: number
  argPerigee: number
  meanAnomaly: number
  epoch_jd: number
}
const ts_propagators: Map<number, TSBucket> = new Map()
const wasm_to_ts_handle: Map<number, number> = new Map()
let next_handle = 1

const DEG_TO_RAD = Math.PI / 180
const MU_EARTH = 398600.4418

/**
 * Initialize the WASM module via Emscripten embind.
 * Loads the JS glue file via script tag (not import) since it is in /public.
 */
export async function initWasm(): Promise<boolean> {
  try {
    // Load the Emscripten JS glue file via script tag
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = `${import.meta.env.BASE_URL}wasm/zenith.js`
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Failed to load WASM script'))
      document.head.appendChild(script)
    })

    // The Emscripten module factory is exposed globally as ZenithWasm
    const factory = (globalThis as any).ZenithWasm
    if (typeof factory === 'function') {
      wasmModule = await factory()
      // Wire up analysis module
      const { setWasmModule } = await import('./analysisLoader')
      setWasmModule(wasmModule)
      return true
    }
    console.warn('WASM factory not found on globalThis')
    return false
  } catch (e) {
    console.warn('WASM init failed, using TS fallbacks:', e)
    return false
  }
}

/**
 * Solve Kepler's equation M = E - e*sin(E) for eccentric anomaly E.
 */
function solve_kepler(M: number, e: number): number {
  let E = M + e * Math.sin(M)
  for (let i = 0; i < 20; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
    E -= dE
    if (Math.abs(dE) < 1e-12) break
  }
  return E
}

/**
 * TS fallback: propagate a satellite using simplified Keplerian motion.
 * Less accurate than full SGP4 (no drag, no J2) but visually correct for demo.
 */
function sgp4_propagate_ts(
  bucket: TSBucket,
  jd: number
): { x: number; y: number; z: number; vx: number; vy: number; vz: number } | null {
  const dt_days = jd - bucket.epoch_jd
  const n_rad_min = (bucket.meanMotion * 2 * Math.PI) / 1440
  const M = bucket.meanAnomaly * DEG_TO_RAD + n_rad_min * dt_days * 1440

  const E = solve_kepler(M, bucket.eccentricity)

  // True anomaly
  const cos_nu = (Math.cos(E) - bucket.eccentricity) / (1 - bucket.eccentricity * Math.cos(E))
  const sin_nu =
    (Math.sqrt(1 - bucket.eccentricity ** 2) * Math.sin(E)) /
    (1 - bucket.eccentricity * Math.cos(E))
  const nu = Math.atan2(sin_nu, cos_nu)

  // Semi-major axis from mean motion (km)
  const n_rad_sec = n_rad_min / 60
  const a = Math.pow(MU_EARTH / (n_rad_sec * n_rad_sec), 1 / 3)

  // Radius
  const r = a * (1 - bucket.eccentricity * Math.cos(E))

  // Position in orbital plane
  const x_orb = r * Math.cos(nu)
  const y_orb = r * Math.sin(nu)

  // Rotation to TEME
  const i_rad = bucket.inclination * DEG_TO_RAD
  const raan_rad = bucket.raan * DEG_TO_RAD
  const argp_rad = bucket.argPerigee * DEG_TO_RAD

  const cos_raan = Math.cos(raan_rad)
  const sin_raan = Math.sin(raan_rad)
  const cos_i = Math.cos(i_rad)
  const sin_i = Math.sin(i_rad)
  const cos_argp = Math.cos(argp_rad)
  const sin_argp = Math.sin(argp_rad)

  const x =
    (cos_raan * cos_argp - sin_raan * sin_argp * cos_i) * x_orb +
    (-cos_raan * sin_argp - sin_raan * cos_argp * cos_i) * y_orb
  const y =
    (sin_raan * cos_argp + cos_raan * sin_argp * cos_i) * x_orb +
    (-sin_raan * sin_argp + cos_raan * cos_argp * cos_i) * y_orb
  const z = sin_argp * sin_i * x_orb + cos_argp * sin_i * y_orb

  // Velocity in orbital plane
  const v = Math.sqrt(MU_EARTH / a)
  const vx_orb = -v * Math.sin(nu)
  const vy_orb = v * Math.cos(nu)

  // Rotate velocity to TEME using same 3-1-3 rotation as position
  const vx =
    (cos_raan * cos_argp - sin_raan * sin_argp * cos_i) * vx_orb +
    (-cos_raan * sin_argp - sin_raan * cos_argp * cos_i) * vy_orb
  const vy =
    (sin_raan * cos_argp + cos_raan * sin_argp * cos_i) * vx_orb +
    (-sin_raan * sin_argp + cos_raan * cos_argp * cos_i) * vy_orb
  const vz = sin_argp * sin_i * vx_orb + cos_argp * sin_i * vy_orb

  return { x, y, z, vx, vy, vz }
}

/**
 * Initialize a satellite from TLE strings. Returns handle for propagation.
 * Tries WASM first, falls back to TS Keplerian propagation.
 */
export function sgp4Init(line1: string, line2: string): number | null {
  // Parse TLE for TS fallback storage (always needed as backup)
  let tsHandle: number | null = null
  try {
    const tle = parse_tle(line1, line2, undefined, true)
    const handle = next_handle++
    ts_propagators.set(handle, {
      meanMotion: tle.mean_motion,
      eccentricity: tle.eccentricity,
      inclination: tle.inclination,
      raan: tle.raan,
      argPerigee: tle.arg_perigee,
      meanAnomaly: tle.mean_anomaly,
      epoch_jd: tle.epoch_jd,
    })
    tsHandle = handle
  } catch (e) {
    console.warn('TLE parse failed:', e)
  }

  // Try WASM first
  if (wasmModule) {
    try {
      const wasmHandle = wasmModule.sgp4_init(line1, line2) as number
      // WASM handle 0 means error
      if (wasmHandle !== 0) {
        // Store mapping so TS fallback can be used if WASM fails later
        if (tsHandle !== null) {
          wasm_to_ts_handle.set(wasmHandle, tsHandle)
        }
        return wasmHandle
      }
      console.warn('WASM sgp4_init returned 0 (error), using TS fallback')
    } catch (e) {
      console.warn('WASM sgp4_init failed, using TS fallback:', e)
    }
  }

  // Return TS fallback handle
  return tsHandle
}

/**
 * Propagate satellite to Julian Date.
 * Returns {x,y,z,vx,vy,vz} in TEME km/km/s or null.
 */
export function sgp4Propagate(
  handle: number,
  jd: number
): { x: number; y: number; z: number; vx: number; vy: number; vz: number } | null {
  // Try WASM first
  if (wasmModule) {
    try {
      const result = wasmModule.sgp4_propagate(handle, jd)
      if (result) return result
    } catch (e) {
      console.warn('WASM sgp4_propagate failed, trying TS fallback:', e)
    }
  }

  // TS fallback: map WASM handle to TS handle if needed
  const tsHandle = wasm_to_ts_handle.get(handle) ?? handle
  const bucket = ts_propagators.get(tsHandle)
  if (!bucket) return null
  return sgp4_propagate_ts(bucket, jd)
}

/**
 * Get Keplerian elements at Julian Date.
 * Returns {a,e,i,raan,argp,ta} or null.
 */
export function sgp4GetElements(
  handle: number,
  jd: number
): { a: number; e: number; i: number; raan: number; argp: number; ta: number } | null {
  // Try WASM first
  if (wasmModule) {
    try {
      const result = wasmModule.sgp4_get_elements(handle, jd)
      if (result) {
        // Defensive: normalize angles to radians
        // WASM may return degrees; if value > 2*PI, assume degrees
        const normalizeAngle = (v: number) => v > 2 * Math.PI ? v * DEG_TO_RAD : v
        return {
          a: result.a,
          e: result.e,
          i: normalizeAngle(result.i),
          raan: normalizeAngle(result.raan),
          argp: normalizeAngle(result.argp),
          ta: normalizeAngle(result.ta),
        }
      }
    } catch (e) {
      console.warn('WASM sgp4_get_elements failed, trying TS fallback:', e)
    }
  }

  // TS fallback: map WASM handle to TS handle if needed
  const tsHandle = wasm_to_ts_handle.get(handle) ?? handle
  const bucket = ts_propagators.get(tsHandle)
  if (!bucket) return null
  return {
    a: Math.pow(MU_EARTH / (bucket.meanMotion * (2 * Math.PI) / 86400) ** 2, 1 / 3),
    e: bucket.eccentricity,
    i: bucket.inclination * DEG_TO_RAD,
    raan: bucket.raan * DEG_TO_RAD,
    argp: bucket.argPerigee * DEG_TO_RAD,
    ta: bucket.meanAnomaly * DEG_TO_RAD,
  }
}

/**
 * Solve Lambert's problem. Returns {v1x,v1y,v1z,v2x,v2y,v2z,converged} or null.
 */
export function lambertSolveWasm(
  r1: [number, number, number],
  r2: [number, number, number],
  dt: number,
  mu: number
): { v1x: number; v1y: number; v1z: number; v2x: number; v2y: number; v2z: number; converged: boolean } | null {
  if (!wasmModule) return null
  try {
    return wasmModule.lambert_solve(r1[0], r1[1], r1[2], r2[0], r2[1], r2[2], dt, mu)
  } catch (e) {
    console.warn('lambert_solve failed:', e)
    return null
  }
}

/**
 * Clear all satellite propagators from WASM memory.
 */
export function sgp4Clear(): void {
  if (wasmModule) {
    try {
      wasmModule.sgp4_clear()
    } catch {
      /* ignore */
    }
  }
  ts_propagators.clear()
  wasm_to_ts_handle.clear()
}
