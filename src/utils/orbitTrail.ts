import { Vector3 } from 'three';
import { sgp4Propagate, sgp4GetElements } from '@/orbit/wasmLoader';
import { MU_EARTH } from '@/orbit/constants';

// =============================================================================
// Orbit Trail Computation
// =============================================================================

/**
 * Scale factor: 1 scene unit = 1000 km.
 * Earth radius (6378.137 km) becomes ~6.378 units.
 */
const SCALE = 1000;

/**
 * Compute orbit trail points for visualization.
 *
 * Propagates one full orbital period using the satellite's WASM/TS handle
 * and returns an array of THREE.Vector3 positions in scene units.
 *
 * @param handle - WASM propagator handle from sgp4Init
 * @param epochJd - Current Julian Date epoch
 * @param numPoints - Number of points along the orbit (default 360)
 * @returns Array of Vector3 positions, or empty array on failure
 */
export function computeOrbitTrail(
  handle: number,
  epochJd: number,
  numPoints: number = 360
): Vector3[] {
  // Get orbital elements to determine period
  const elements = sgp4GetElements(handle, epochJd);
  if (!elements || elements.a <= 0) {
    return [];
  }

  // Orbital period: T = 2*pi * sqrt(a^3 / mu) in seconds
  const periodSec = 2 * Math.PI * Math.sqrt(Math.pow(elements.a, 3) / MU_EARTH);

  const points: Vector3[] = [];

  for (let idx = 0; idx <= numPoints; idx++) {
    const tFrac = idx / numPoints;
    const tSec = tFrac * periodSec;
    const jd = epochJd + tSec / 86400; // seconds to days

    const result = sgp4Propagate(handle, jd);
    if (result) {
      points.push(
        new Vector3(
          result.x / SCALE,
          result.z / SCALE,  // TEME Z -> scene Y (up)
          -result.y / SCALE  // TEME Y -> scene -Z (forward)
        )
      );
    }
  }

  return points;
}

/**
 * Compute current satellite position in scene coordinates.
 *
 * @param handle - WASM propagator handle
 * @param jd - Julian Date to propagate to
 * @returns Scene-space Vector3 or null
 */
export function getSatellitePosition(
  handle: number,
  jd: number
): Vector3 | null {
  const result = sgp4Propagate(handle, jd);
  if (!result) return null;

  return new Vector3(
    result.x / SCALE,
    result.z / SCALE,
    -result.y / SCALE
  );
}
