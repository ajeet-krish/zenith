import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group } from 'three';
import * as THREE from 'three';
import { useMissionStore } from '@/store/useMissionStore';
import { getSatellitePosition } from '@/utils/orbitTrail';

/**
 * SatelliteMarker - renders all satellite markers in the scene.
 *
 * Each satellite is a small glowing sphere with a label.
 * Positions update every frame from WASM/TS propagation.
 * Clicking a marker selects that satellite.
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

  // Update position each frame
  useFrame(() => {
    if (!groupRef.current) return;
    const jd = useMissionStore.getState().currentEpoch;
    const pos = getSatellitePosition(handle, jd);
    if (pos) {
      groupRef.current.position.copy(pos);
    }
  });

  const scale = isSelected ? 1.5 : 1.0;
  const markerSize = 0.05;

  return (
    <group
      ref={groupRef}
      onClick={(e) => {
        e.stopPropagation();
        selectSatellite(isSelected ? null : satelliteId);
      }}
    >
      {/* Satellite dot */}
      <mesh scale={scale}>
        <sphereGeometry args={[markerSize, 12, 12]} />
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

      {/* Label */}
      <Html
        position={[0, markerSize * scale + 0.15, 0]}
        center
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
