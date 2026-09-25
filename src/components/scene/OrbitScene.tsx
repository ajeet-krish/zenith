import { useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import { Earth } from './Earth';
import { OrbitPath } from './OrbitPath';
import { SatelliteMarker } from './SatelliteMarker';
import { CameraController } from './CameraController';
import { GroundTrackLine } from './GroundTrackLine';
import { TransferOrbitPath } from './TransferOrbitPath';
import { ConjunctionMarker } from './ConjunctionMarker';
import { useMissionStore } from '@/store/useMissionStore';
import { useOrbitTrails } from '@/hooks/useOrbitTrails';

/**
 * OrbitScene - main 3D canvas for the orbital visualization.
 *
 * Renders Earth, orbit paths, satellite markers, and camera controls
 * inside a dark-background R3F Canvas with a star field.
 */
export function OrbitScene() {
  const satellites = useMissionStore((s) => s.satellites);
  const selectedId = useMissionStore((s) => s.selectedSatelliteId);
  const currentEpoch = useMissionStore((s) => s.currentEpoch);
  const loadSampleSatellites = useMissionStore((s) => s.loadSampleSatellites);

  // Load sample satellites on mount
  useEffect(() => {
    loadSampleSatellites();
  }, [loadSampleSatellites]);

  // Cached orbit trails - only recomputes when epoch drifts > 60s
  const orbitTrails = useOrbitTrails(satellites, currentEpoch);

  return (
    <div className="w-full h-full bg-void">
      <Canvas
        camera={{
          position: [30, 20, 30],
          fov: 50,
          near: 0.1,
          far: 20000,
        }}
        gl={{ antialias: true, alpha: false }}
        style={{ background: '#0a0a0f' }}
      >
        {/* Star field background */}
        <Stars
          radius={300}
          depth={100}
          count={5000}
          factor={4}
          saturation={0}
          fade
          speed={0.5}
        />

        {/* Lighting */}
        <ambientLight intensity={0.15} />
        <directionalLight position={[50, 30, 50]} intensity={1.5} />
        <pointLight position={[0, 0, 0]} intensity={0.5} decay={2} distance={100} />

        {/* Earth at origin */}
        <Earth />

        {/* Orbit paths and satellite markers */}
        {satellites
          .filter((sat) => sat.visible)
          .map((sat) => {
            const trail = orbitTrails.get(sat.id) ?? [];
            const isSelected = selectedId === sat.id;

            return (
              <group key={sat.id}>
                {/* Orbit path */}
                <OrbitPath
                  positions={trail}
                  color={sat.color}
                  opacity={0.4}
                  isSelected={isSelected}
                />

                {/* Satellite marker */}
                {sat.handle !== null && (
                  <SatelliteMarker
                    handle={sat.handle}
                    name={sat.name}
                    color={sat.color}
                    isSelected={isSelected}
                    satelliteId={sat.id}
                  />
                )}
              </group>
            );
          })}

        {/* Analysis overlays */}
        <GroundTrackLine />
        <TransferOrbitPath />
        <ConjunctionMarker />

        {/* Camera controls */}
        <CameraController />
      </Canvas>
    </div>
  );
}
