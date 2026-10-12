import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { useODStore } from '@/store/useODStore';
import { MU_EARTH } from '@/orbit/constants';

const SCALE = 1000; // 1 scene unit = 1000 km

/** Trajectory color: Dracula cyan, distinct from the green ground track. */
const TRAJECTORY_COLOR = '#8be9fd';

/**
 * Convert a TEME position (km) to scene coordinates.
 * Same transform used by SatelliteMarker and ConjunctionMarker.
 */
function toScene(x: number, y: number, z: number): [number, number, number] {
  return [x / SCALE, z / SCALE, -y / SCALE];
}

/**
 * Build a closed two-body orbit path from an ECI state [km, km/s].
 *
 * Converts the state to classical elements, then sweeps true anomaly over
 * one full revolution in the perifocal frame and rotates back to ECI. Used
 * for the batch-least-squares overlay: the solver returns a single epoch
 * state, so the estimated orbit is drawn as the full ellipse it implies.
 *
 * @returns `nPoints` + 1 TEME positions in km (first point repeated to close
 *   the loop), or null for invalid/hyperbolic states.
 */
export function buildBatchOrbitPath(
  state6: number[],
  nPoints = 100
): [number, number, number][] | null {
  if (state6.length !== 6 || nPoints < 2) return null;
  const rx = state6[0]!;
  const ry = state6[1]!;
  const rz = state6[2]!;
  const vx = state6[3]!;
  const vy = state6[4]!;
  const vz = state6[5]!;
  if (![rx, ry, rz, vx, vy, vz].every(Number.isFinite)) return null;

  const rMag = Math.hypot(rx, ry, rz);
  const vMag = Math.hypot(vx, vy, vz);
  if (rMag < 1e-6 || vMag < 1e-12) return null;

  // Angular momentum h = r x v and specific energy.
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const hMag = Math.hypot(hx, hy, hz);
  if (hMag < 1e-9) return null;
  const energy = (vMag * vMag) / 2 - MU_EARTH / rMag;
  if (!Number.isFinite(energy) || energy >= 0) return null; // parabolic/hyperbolic
  const a = -MU_EARTH / (2 * energy);

  // Eccentricity vector e = ((v^2 - mu/r) r - (r.v) v) / mu.
  const rvDot = rx * vx + ry * vy + rz * vz;
  const f = (vMag * vMag - MU_EARTH / rMag) / MU_EARTH;
  const ex = f * rx - (rvDot * vx) / MU_EARTH;
  const ey = f * ry - (rvDot * vy) / MU_EARTH;
  const ez = f * rz - (rvDot * vz) / MU_EARTH;
  const eMag = Math.hypot(ex, ey, ez);
  if (eMag >= 1) return null;

  // Perifocal basis: p̂ along periapsis, q̂ 90 deg ahead in the orbit plane.
  let px: number;
  let py: number;
  let pz: number;
  if (eMag < 1e-12) {
    // Circular orbit: no periapsis direction; use the current radius vector.
    px = rx / rMag;
    py = ry / rMag;
    pz = rz / rMag;
  } else {
    px = ex / eMag;
    py = ey / eMag;
    pz = ez / eMag;
  }
  // q̂ = h_hat x p̂ (unit because h_hat is perpendicular to p̂).
  const qx = ((hy / hMag) * pz - (hz / hMag) * py);
  const qy = ((hz / hMag) * px - (hx / hMag) * pz);
  const qz = ((hx / hMag) * py - (hy / hMag) * px);

  const semiLatus = a * (1 - eMag * eMag);
  const points: [number, number, number][] = [];
  for (let k = 0; k <= nPoints; k += 1) {
    const nu = (k / nPoints) * 2 * Math.PI;
    const r = semiLatus / (1 + eMag * Math.cos(nu));
    const c = Math.cos(nu);
    const s = Math.sin(nu);
    points.push([r * (c * px + s * qx), r * (c * py + s * qy), r * (c * pz + s * qz)]);
  }
  return points;
}

/**
 * OdTrajectoryOverlay - estimated trajectory from orbit determination.
 *
 * Prefers the sequential EKF filter path (one point per update step, the
 * actual arc the filter tracked). When only a batch least-squares solve
 * exists, draws the full two-body orbit implied by its estimated epoch
 * state. Reads its inputs straight from useODStore; visibility follows
 * sceneToggles.trajectory.
 */
export function OdTrajectoryOverlay() {
  const show = useODStore((s) => s.sceneToggles.trajectory);
  const ekfResult = useODStore((s) => s.ekfResult);
  const batchResult = useODStore((s) => s.batchResult);

  const points = useMemo(() => {
    if (!show) return null;

    // EKF steps: the filter's estimated position at each observation epoch.
    if (ekfResult && ekfResult.steps.length >= 2) {
      return ekfResult.steps.map((step) =>
        toScene(step.state[0]!, step.state[1]!, step.state[2]!)
      );
    }

    // Batch-only: full estimated orbit ellipse from the converged epoch state.
    if (batchResult && batchResult.state.length === 6) {
      const teme = buildBatchOrbitPath(batchResult.state);
      if (teme) return teme.map(([x, y, z]) => toScene(x, y, z));
    }

    return null;
  }, [show, ekfResult, batchResult]);

  if (!points || points.length < 2) return null;

  return (
    <Line points={points} color={TRAJECTORY_COLOR} lineWidth={2} transparent opacity={0.85} />
  );
}
