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
 * Velocity-to-color gradient mapping.
 * Slow (apogee) = blue, medium = purple, fast (perigee) = red.
 */
function velocityToColor(v: number, vMin: number, vMax: number): [number, number, number] {
  if (vMax <= vMin) return [0.5, 0.5, 1.0]; // default blue
  const t = Math.max(0, Math.min(1, (v - vMin) / (vMax - vMin)));

  // 3-stop gradient: blue(0) -> purple(0.5) -> red(1)
  let r: number, g: number, b: number;
  if (t < 0.5) {
    const s = t * 2;
    r = 0.36 * s;         // 0 -> 0.36
    g = 0.29 * (1 - s);   // 0.29 -> 0
    b = 0.97 * (1 - s) + 0.40 * s; // 0.97 -> 0.40
  } else {
    const s = (t - 0.5) * 2;
    r = 0.36 + 0.61 * s;  // 0.36 -> 0.97
    g = 0.0;              // stays 0
    b = 0.40 * (1 - s);   // 0.40 -> 0
  }

  return [r, g, b];
}

/**
 * Compute orbit trail points for visualization with velocity data.
 *
 * Propagates one full orbital period and returns positions + velocities.
 */
export function computeOrbitTrailWithVelocity(
  handle: number,
  epochJd: number,
  numPoints: number = 360
): { positions: Vector3[]; velocities: number[]; colors: [number, number, number][] } | null {
  const elements = sgp4GetElements(handle, epochJd);
  if (!elements || elements.a <= 0) {
    return null;
  }

  const periodSec = 2 * Math.PI * Math.sqrt(Math.pow(elements.a, 3) / MU_EARTH);
  if (periodSec < 600 || periodSec > 86400) {
    return null;
  }

  const positions: Vector3[] = [];
  const velocities: number[] = [];

  for (let idx = 0; idx <= numPoints; idx++) {
    const tFrac = idx / numPoints;
    const tSec = tFrac * periodSec;
    const jd = epochJd + tSec / 86400;

    const result = sgp4Propagate(handle, jd);
    if (result) {
      positions.push(
        new Vector3(
          result.x / SCALE,
          result.z / SCALE,
          -result.y / SCALE
        )
      );
      velocities.push(
        Math.sqrt(result.vx ** 2 + result.vy ** 2 + result.vz ** 2)
      );
    }
  }

  if (positions.length < 2) return null;

  // Compute velocity range for color mapping
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const v of velocities) {
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }

  // Map velocities to colors
  const colors: [number, number, number][] = velocities.map((v) =>
    velocityToColor(v, vMin, vMax)
  );

  return { positions, velocities, colors };
}

/**
 * Compute orbit trail points for visualization.
 *
 * Propagates one full orbital period using the satellite's WASM/TS handle
 * and returns an array of THREE.Vector3 positions in scene units.
 */
export function computeOrbitTrail(
  handle: number,
  epochJd: number,
  numPoints: number = 360
): Vector3[] {
  const elements = sgp4GetElements(handle, epochJd);
  if (!elements || elements.a <= 0) {
    return [];
  }

  const periodSec = 2 * Math.PI * Math.sqrt(Math.pow(elements.a, 3) / MU_EARTH);
  if (periodSec < 600 || periodSec > 86400) {
    return [];
  }

  const points: Vector3[] = [];

  for (let idx = 0; idx <= numPoints; idx++) {
    const tFrac = idx / numPoints;
    const tSec = tFrac * periodSec;
    const jd = epochJd + tSec / 86400;

    const result = sgp4Propagate(handle, jd);
    if (result) {
      points.push(
        new Vector3(
          result.x / SCALE,
          result.z / SCALE,
          -result.y / SCALE
        )
      );
    }
  }

  return points;
}

/**
 * Compute current satellite position in scene coordinates.
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
