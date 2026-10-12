import { useMemo } from 'react';
import * as THREE from 'three';
import { useODStore } from '@/store/useODStore';
import { ellipsoidAxesFromCov } from '@/orbit/covarianceUtils';

const SCALE = 1000; // 1 scene unit = 1000 km

/** Ellipsoid color: Dracula purple, matching the analysis accent. */
const ELLIPSOID_COLOR = '#bd93f9';

/**
 * Minimum semi-axis in scene units (5 km). Converged LEO formal position
 * covariances are often sub-kilometer, which would render smaller than a
 * pixel at this scale; the floor keeps the overlay usable. Note the floor
 * does slightly distort the shape: minor axes render larger than formal.
 */
const MIN_AXIS_SCENE = 0.005;

/**
 * Maximum semi-axis in scene units (1e6 km). Pathological covariances
 * (near-singular batches, unit mix-ups) can produce absurd axes; clamping
 * keeps the overlay from swallowing the whole scene.
 */
const MAX_AXIS_SCENE = 1e6 / SCALE;

/**
 * Convert a TEME position (km) to scene coordinates.
 * Same transform used by SatelliteMarker and ConjunctionMarker.
 */
function toScene(x: number, y: number, z: number): [number, number, number] {
  return [x / SCALE, z / SCALE, -y / SCALE];
}

/**
 * Build the scene-frame rotation basis from TEME-frame covariance
 * eigenvectors. `rotation` is a row-major 3x3 whose COLUMN k is the TEME
 * direction of semi-axis k (see covarianceUtils). Each column is pushed
 * through the same (x, z, -y) TEME -> scene permutation as toScene, so
 * makeBasis column k still images local axis k, preserving the
 * col k <-> semiAxes[k] pairing.
 */
export function makeSceneBasis(rotation: number[]): THREE.Matrix4 {
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(rotation[0]!, rotation[6]!, -rotation[3]!),
    new THREE.Vector3(rotation[1]!, rotation[7]!, -rotation[4]!),
    new THREE.Vector3(rotation[2]!, rotation[8]!, -rotation[5]!)
  );

  // jacobiEigen3 sign-normalizes each eigenvector column independently, so the
  // assembled basis is often an improper rotation (det = -1, a reflection).
  // Matrix4.setFromRotationMatrix assumes a pure rotation and mishandles
  // reflections. The ellipsoid is invariant to an eigenvector sign flip, so
  // negate the first column (any single column works) to restore det >= 0.
  // Columns 1 and 2 keep their orientation, preserving the col k <->
  // semiAxes[k] pairing for the medium and major axes.
  if (basis.determinant() < 0) {
    const e = basis.elements;
    e[0] = -e[0]!;
    e[1] = -e[1]!;
    e[2] = -e[2]!;
  }

  return basis;
}

/**
 * CovarianceEllipsoid - 3-sigma position uncertainty ellipsoid.
 *
 * Eigendecomposes the 3x3 position block of the OD covariance (EKF final
 * covariance preferred, batch formal covariance as fallback) and renders a
 * transparent sphere scaled and rotated onto the uncertainty ellipsoid's
 * principal axes. Visibility follows sceneToggles.covarianceEllipsoid.
 */
export function CovarianceEllipsoid() {
  const show = useODStore((s) => s.sceneToggles.covarianceEllipsoid);
  const ekfResult = useODStore((s) => s.ekfResult);
  const batchResult = useODStore((s) => s.batchResult);

  const shape = useMemo(() => {
    if (!show) return null;

    const cov = ekfResult?.finalCov ?? batchResult?.covariance ?? null;
    const state = ekfResult?.finalState ?? batchResult?.state ?? null;
    if (!cov || !state || state.length < 3) return null;

    const ellipsoid = ellipsoidAxesFromCov(cov);
    if (!ellipsoid) return null;

    const position = new THREE.Vector3(...toScene(state[0]!, state[1]!, state[2]!));

    // Rotation: eigenvectors are TEME directions in the COLUMNS of the
    // row-major rotation; makeSceneBasis permutes them into the scene frame
    // so basis column k images local axis k. semiAxes are sorted ascending
    // with matching columns, so local x/y/z scale directly.
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(
      makeSceneBasis(ellipsoid.rotation)
    );

    // Clamp each semi-axis into [MIN_AXIS_SCENE, MAX_AXIS_SCENE] (see above).
    const clampAxis = (km: number): number =>
      Math.min(Math.max(km / SCALE, MIN_AXIS_SCENE), MAX_AXIS_SCENE);
    const scale = new THREE.Vector3(
      clampAxis(ellipsoid.semiAxes[0]!),
      clampAxis(ellipsoid.semiAxes[1]!),
      clampAxis(ellipsoid.semiAxes[2]!)
    );

    return { position, quaternion, scale };
  }, [show, ekfResult, batchResult]);

  if (!shape) return null;

  return (
    <mesh position={shape.position} quaternion={shape.quaternion} scale={shape.scale}>
      <sphereGeometry args={[1, 24, 16]} />
      <meshBasicMaterial
        color={ELLIPSOID_COLOR}
        transparent
        opacity={0.15}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
