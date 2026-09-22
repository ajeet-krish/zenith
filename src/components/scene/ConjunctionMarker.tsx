import { Html, Line } from '@react-three/drei';
import { useAnalysisStore } from '@/store/useAnalysisStore';

const SCALE = 1000; // 1 scene unit = 1000 km

const RISK_COLORS: Record<string, string> = {
  CRITICAL: '#ff5555',
  HIGH: '#ffb86c',
  MODERATE: '#f1fa8c',
  LOW: '#50fa7b',
};

/**
 * Convert TEME position (km) to scene coordinates.
 * Same transform used by SatelliteMarker and GroundTrackLine.
 */
function toScene(pos: { x: number; y: number; z: number }): [number, number, number] {
  return [pos.x / SCALE, pos.z / SCALE, -pos.y / SCALE];
}

/**
 * ConjunctionMarker - renders miss-distance vectors for conjunction events.
 *
 * For each conjunction event, renders:
 * - A dashed line connecting the two satellite positions at TCA
 * - Sphere markers at each satellite position
 * - A label showing the miss distance and risk level
 */
export function ConjunctionMarker() {
  const conjunctionEvents = useAnalysisStore((s) => s.conjunctionEvents);
  const showConjunctionMarkers = useAnalysisStore((s) => s.showConjunctionMarkers);

  if (!showConjunctionMarkers || conjunctionEvents.length === 0) return null;

  return (
    <group>
      {conjunctionEvents.map((event, idx) => {
        const p1 = toScene(event.position1);
        const p2 = toScene(event.position2);

        // Midpoint for label placement
        const midX = (p1[0] + p2[0]) / 2;
        const midY = (p1[1] + p2[1]) / 2;
        const midZ = (p1[2] + p2[2]) / 2;

        const color = RISK_COLORS[event.riskLevel] ?? '#ffffff';

        return (
          <group key={idx}>
            {/* Miss distance line */}
            <Line
              points={[p1, p2]}
              color={color}
              lineWidth={2}
              dashed
              dashSize={0.1}
              gapSize={0.05}
            />

            {/* Satellite position markers */}
            <mesh position={p1}>
              <sphereGeometry args={[0.03, 8, 8]} />
              <meshBasicMaterial color={color} />
            </mesh>
            <mesh position={p2}>
              <sphereGeometry args={[0.03, 8, 8]} />
              <meshBasicMaterial color={color} />
            </mesh>

            {/* Miss distance label */}
            <Html
              position={[midX, midY + 0.1, midZ]}
              center
              distanceFactor={20}
              style={{ pointerEvents: 'none' }}
            >
              <div
                className="whitespace-nowrap px-1.5 py-0.5 rounded text-[8px] font-mono"
                style={{
                  background: `${color}33`,
                  color: color,
                  border: `1px solid ${color}66`,
                }}
              >
                {event.missDistanceKm.toFixed(1)} km ({event.riskLevel})
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
