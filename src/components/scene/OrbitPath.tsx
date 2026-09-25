import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import type { Vector3 } from 'three';

interface OrbitPathProps {
  positions: Vector3[];
  color: string;
  opacity?: number;
  isSelected?: boolean;
  vertexColors?: [number, number, number][];
}

/**
 * OrbitPath - renders a single orbital path as a line in 3D.
 *
 * Uses drei Line. Supports vertex colors for velocity gradient
 * when vertexColors is provided.
 */
export function OrbitPath({
  positions,
  color,
  opacity = 0.4,
  isSelected = false,
  vertexColors,
}: OrbitPathProps) {
  const points = useMemo(() => {
    return positions.map((v) => [v.x, v.y, v.z] as [number, number, number]);
  }, [positions]);

  if (points.length < 2) return null;

  // When vertex colors are available, render multiple colored segments
  if (vertexColors && vertexColors.length === points.length) {
    return (
      <group>
        {points.slice(0, -1).map((pt, i) => {
          const next = points[i + 1];
          if (!next) return null;
          const c = vertexColors[i]!;
          const hex = `#${Math.round(c[0] * 255).toString(16).padStart(2, '0')}${Math.round(c[1] * 255).toString(16).padStart(2, '0')}${Math.round(c[2] * 255).toString(16).padStart(2, '0')}`;
          return (
            <Line
              key={i}
              points={[pt, next]}
              color={hex}
              lineWidth={isSelected ? 2.5 : 1}
              transparent
              opacity={isSelected ? Math.min(opacity + 0.3, 1.0) : opacity}
            />
          );
        })}
      </group>
    );
  }

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
