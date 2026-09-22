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
 * When a satellite is selected, smoothly animates the camera toward it ONCE.
 * After the fly-to completes, full orbit controls are restored.
 */
export function CameraController() {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const flyTarget = useRef<Vector3 | null>(null);
  const lookTargetRef = useRef<Vector3 | null>(null);
  const flyActive = useRef(false);
  const lastSelectedId = useRef<string | null>(null);

  const { camera } = useThree();
  const selectedId = useMissionStore((s) => s.selectedSatelliteId);

  // When selection changes, set fly target (ONLY on selection change, not on every frame)
  useEffect(() => {
    if (selectedId === lastSelectedId.current) return;
    lastSelectedId.current = selectedId;

    if (!selectedId) {
      flyActive.current = false;
      flyTarget.current = null;
      lookTargetRef.current = null;
      return;
    }

    const satellites = useMissionStore.getState().satellites;
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
  }, [selectedId]);

  // Smoothly animate camera toward fly target
  useFrame((_, delta) => {
    if (!flyActive.current || !flyTarget.current) return;

    const target = flyTarget.current;
    const camPos = camera.position;

    const dir = new Vector3().subVectors(target, camPos);
    const dist = dir.length();

    if (dist < 0.3) {
      // Fly-to complete: release camera control
      flyActive.current = false;
      flyTarget.current = null;
      lookTargetRef.current = null;
      return;
    }

    dir.normalize();
    const step = Math.min(FLY_SPEED * delta * 60, dist * 0.05);
    camera.position.addScaledVector(dir, step);

    // Also move the orbit controls target during fly-to
    if (controlsRef.current && lookTargetRef.current) {
      controlsRef.current.target.lerp(lookTargetRef.current, 0.05);
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
