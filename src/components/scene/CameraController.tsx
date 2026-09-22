import { useRef } from 'react';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

/**
 * CameraController - wraps drei OrbitControls with orbit, pan, and zoom.
 *
 * No fly-to animation. Satellite selection only highlights the marker.
 * User has full camera control at all times.
 */
export function CameraController() {
  const controlsRef = useRef<OrbitControlsImpl>(null);

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
