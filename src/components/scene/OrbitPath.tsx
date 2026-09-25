import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import type { Vector3 } from 'three';

interface OrbitPathProps {
  positions: Vector3[];
  color: string;
  opacity?: number;
  isSelected?: boolean;
}

/**
 * OrbitPath - renders a single orbital path as a line in 3D.
 *
 * Uses drei Line with BufferGeometry for efficient rendering.
 * Selected orbits appear brighter and thicker.
 */
export function OrbitPath({
  positions,
  color,
  opacity = 0.4,
  isSelected = false,
}: OrbitPathProps) {
  const points = useMemo(() => {
    return positions.map((v) => [v.x, v.y, v.z] as [number, number, number]);
  }, [positions]);

  if (points.length < 2) return null;

  return (
    <Line
      points={points}
      color={color}
      lineWidth={isSelected ? 2.5 : 1}
      transparent
      opacity={isSelected ? Math.min(opacity + 0.3, 1.0) : opacity}
    />
  );
}
