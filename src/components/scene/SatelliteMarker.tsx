import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group } from 'three';
import * as THREE from 'three';
import { useMissionStore } from '@/store/useMissionStore';
import { propagateSatellite } from '@/orbit/wasmLoader';

/**
 * Throttle interval in seconds. Satellite positions are propagated at 10Hz
 * instead of 60fps. Between updates, position is interpolated using velocity.
 */
const PROPAGATION_INTERVAL = 0.1;

/**
 * SatelliteMarker - renders a satellite cubesat with label in the scene.
 *
 * Position updates at 10Hz via propagation, with linear interpolation
 * between updates for smooth visual motion. Clicking selects the satellite.
 */
export function SatelliteMarker({
  handle,
  name,
  color,
  isSelected,
  satelliteId,
}: {
  handle: number;
  name: string;
  color: string;
  isSelected: boolean;
  satelliteId: string;
}) {
  const groupRef = useRef<Group>(null);
  const selectSatellite = useMissionStore((s) => s.selectSatellite);

  // Interpolation state
  const lastPosRef = useRef(new THREE.Vector3());
  const lastVelRef = useRef(new THREE.Vector3());
  const lastJdRef = useRef(0);
  const accumRef = useRef(0);

  // Update position each frame with throttling + interpolation
  useFrame((_, delta) => {
    if (!groupRef.current) return;

    accumRef.current += delta;

    // Only propagate at 10Hz intervals
    if (accumRef.current >= PROPAGATION_INTERVAL) {
      accumRef.current = 0;
      const state = useMissionStore.getState();
      const jd = state.currentEpoch;
      const method = state.propagationMethod;
      try {
        const result = propagateSatellite(handle, jd, method);
        if (result) {
          const SCALE = 1000;
          const pos = new THREE.Vector3(
            result.x / SCALE,
            result.z / SCALE,
            -result.y / SCALE
          );
          const vel = new THREE.Vector3(
            result.vx / SCALE,
            result.vz / SCALE,
            -result.vy / SCALE
          );
          lastPosRef.current.copy(pos);
          lastVelRef.current.copy(vel);
          lastJdRef.current = jd;
          groupRef.current.position.copy(pos);
        }
      } catch {
        // WASM propagation failed, keep interpolated position
      }
    } else if (lastJdRef.current > 0) {
      // Interpolate between propagation updates using velocity
      const dt = delta;
      groupRef.current.position.copy(lastPosRef.current);
      groupRef.current.position.addScaledVector(lastVelRef.current, dt);
      lastPosRef.current.copy(groupRef.current.position);
    }
  });

  const scale = isSelected ? 1.5 : 1.0;
  const markerSize = 0.05;

  return (
    <group ref={groupRef}>
      {/* Satellite cubesat */}
      <mesh
        scale={scale}
        rotation={[0.3, 0.5, 0]}
        onClick={(e) => {
          e.stopPropagation();
          selectSatellite(isSelected ? null : satelliteId);
        }}
      >
        <boxGeometry args={[markerSize * 1.5, markerSize * 1.5, markerSize * 1.5]} />
        <meshBasicMaterial color={color} />
      </mesh>

      {/* Glow ring when selected */}
      {isSelected && (
        <mesh scale={scale}>
          <ringGeometry args={[markerSize * 1.5, markerSize * 2.5, 24]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.4}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Label - positioned relative to group, which follows satellite */}
      <Html
        position={[0, 0.12, 0]}
        center
        distanceFactor={15}
        style={{
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        <div
          className="whitespace-nowrap px-1.5 py-0.5 rounded text-[9px] font-mono"
          style={{
            background: isSelected
              ? `${color}33`
              : 'rgba(0, 0, 0, 0.6)',
            color: isSelected ? color : '#aaa',
            border: isSelected
              ? `1px solid ${color}66`
              : '1px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          {name}
        </div>
      </Html>
    </group>
  );
}
