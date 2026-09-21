import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useMissionStore } from '@/store/useMissionStore';
import { getSatellitePosition } from '@/utils/orbitTrail';

const FLY_SPEED = 2.0;

/**
 * CameraController - wraps drei OrbitControls with fly-to animation.
 *
 * When a satellite is selected, smoothly animates the camera toward it.
 * Provides orbit, pan, and zoom controls with damping.
 */
export function CameraController() {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const flyTarget = useRef<Vector3 | null>(null);
  const lookTargetRef = useRef<Vector3 | null>(null);
  const flyActive = useRef(false);

  const { camera } = useThree();
  const selectedId = useMissionStore((s) => s.selectedSatelliteId);
  const satellites = useMissionStore((s) => s.satellites);

  // When selection changes, set fly target
  useEffect(() => {
    if (!selectedId) {
      flyActive.current = false;
      flyTarget.current = null;
      lookTargetRef.current = null;
      return;
    }

    const sat = satellites.find((s) => s.id === selectedId);
    if (!sat || !sat.handle) return;

    const jd = useMissionStore.getState().currentEpoch;
    const pos = getSatellitePosition(sat.handle, jd);
    if (!pos) return;

    // Position camera offset from the object
    const offset = new Vector3(pos.x + 3, pos.y + 2, pos.z + 3);
    flyTarget.current = offset;
    lookTargetRef.current = pos.clone();
    flyActive.current = true;
  }, [selectedId, satellites]);

  // Smoothly animate camera toward fly target
  useFrame((_, delta) => {
    if (!flyActive.current || !flyTarget.current) return;

    const target = flyTarget.current;
    const camPos = camera.position;

    const dir = new Vector3().subVectors(target, camPos);
    const dist = dir.length();

    if (dist < 0.3) {
      flyActive.current = false;
      flyTarget.current = null;
      return;
    }

    dir.normalize();
    const step = Math.min(FLY_SPEED * delta * 60, dist * 0.05);
    camera.position.addScaledVector(dir, step);

    if (controlsRef.current) {
      const lookTarget = lookTargetRef.current ?? new Vector3();
      controlsRef.current.target.lerp(lookTarget, 0.02);
      controlsRef.current.update();
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.05}
      minDistance={8}
      maxDistance={500}
      enablePan
    />
  );
}
