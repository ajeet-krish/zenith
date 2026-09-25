/**
 * Eclipse and shadow computation for satellite orbits.
 * Uses cylindrical shadow model (umbra only).
 */

const AU_KM = 149597870.7 // km

/**
 * Compute simplified Sun position in ECI (TEME approximation).
 * Uses circular orbit at 1 AU with ecliptic longitude from J2000.
 * Accurate to ~1 degree for shadow geometry.
 */
export function computeSunPosition(jd: number): { x: number; y: number; z: number } {
  const T = (jd - 2451545.0) / 36525.0 // centuries from J2000

  // Mean ecliptic longitude (degrees)
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T // mean anomaly

  const Mrad = M * Math.PI / 180

  // Ecliptic longitude
  const L = L0 + 1.9146 * Math.sin(Mrad) + 0.02 * Math.sin(2 * Mrad)
  const Lrad = L * Math.PI / 180

  // Obliquity of ecliptic
  const eps = 23.4393 - 0.013 * T
  const epsRad = eps * Math.PI / 180

  // Sun position in ECI (km)
  const r = AU_KM
  const x = r * Math.cos(Lrad)
  const y = r * Math.sin(Lrad) * Math.cos(epsRad)
  const z = r * Math.sin(Lrad) * Math.sin(epsRad)

  return { x, y, z }
}

/**
 * Check if a satellite is in Earth's cylindrical shadow.
 * Returns true if the satellite is in eclipse (umbra).
 */
export function isInEclipse(
  satPos: { x: number; y: number; z: number },
  sunPos: { x: number; y: number; z: number }
): boolean {
  const R_EARTH = 6378.137

  // Satellite position relative to Sun
  const dx = satPos.x
  const dy = satPos.y
  const dz = satPos.z

  // Sun direction (unit vector from Earth to Sun)
  const sunDist = Math.sqrt(sunPos.x ** 2 + sunPos.y ** 2 + sunPos.z ** 2)
  const sunDirX = sunPos.x / sunDist
  const sunDirY = sunPos.y / sunDist
  const sunDirZ = sunPos.z / sunDist

  // Project satellite position onto Sun direction
  const proj = dx * sunDirX + dy * sunDirY + dz * sunDirZ

  // Satellite must be on opposite side of Earth from Sun
  if (proj > 0) return false

  // Perpendicular distance from Sun-Earth line
  const perpX = dx - proj * sunDirX
  const perpY = dy - proj * sunDirY
  const perpZ = dz - proj * sunDirZ
  const perpDist = Math.sqrt(perpX ** 2 + perpY ** 2 + perpZ ** 2)

  // Satellite is in shadow if within Earth's radius of the Sun-Earth line
  return perpDist < R_EARTH
}

export interface EclipseEvent {
  entryJd: number
  exitJd: number
  durationS: number
}

export interface EclipseResult {
  events: EclipseEvent[]
  avgDurationS: number
  maxDurationS: number
  minDurationS: number
  eclipseFraction: number
}

import { sgp4Propagate } from '@/orbit/wasmLoader'

/**
 * Compute eclipse events for a satellite over a time window.
 * Propagates the satellite and checks shadow condition at each timestep.
 */
export function computeEclipse(
  handle: number,
  epochJd: number,
  durationDays: number,
  timeStepS: number = 60
): EclipseResult | null {

  const totalSeconds = durationDays * 86400
  const nSteps = Math.ceil(totalSeconds / timeStepS)

  let inEclipse = false
  let entryJd = 0
  const events: EclipseEvent[] = []
  let eclipseTimeS = 0

  for (let i = 0; i <= nSteps; i++) {
    const jd = epochJd + (i * timeStepS) / 86400
    const sv = sgp4Propagate(handle, jd)
    if (!sv) continue

    const sunPos = computeSunPosition(jd)
    const satPos = { x: sv.x, y: sv.y, z: sv.z }
    const eclipsed = isInEclipse(satPos, sunPos)

    if (eclipsed && !inEclipse) {
      // Eclipse entry
      inEclipse = true
      entryJd = jd
    } else if (!eclipsed && inEclipse) {
      // Eclipse exit
      inEclipse = false
      const duration = (jd - entryJd) * 86400
      events.push({ entryJd, exitJd: jd, durationS: duration })
      eclipseTimeS += duration
    }
  }

  // Close any open eclipse at the end
  if (inEclipse) {
    const lastJd = epochJd + (nSteps * timeStepS) / 86400
    const duration = (lastJd - entryJd) * 86400
    events.push({ entryJd, exitJd: lastJd, durationS: duration })
    eclipseTimeS += duration
  }

  const totalTimeS = nSteps * timeStepS

  return {
    events,
    avgDurationS: events.length > 0 ? eclipseTimeS / events.length : 0,
    maxDurationS: events.length > 0 ? Math.max(...events.map((e) => e.durationS)) : 0,
    minDurationS: events.length > 0 ? Math.min(...events.map((e) => e.durationS)) : 0,
    eclipseFraction: totalTimeS > 0 ? eclipseTimeS / totalTimeS : 0,
  }
}
