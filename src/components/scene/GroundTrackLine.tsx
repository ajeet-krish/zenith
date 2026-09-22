import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { useAnalysisStore } from '@/store/useAnalysisStore';
import { R_EARTH } from '@/orbit/constants';

const SCALE = 1000; // 1 scene unit = 1000 km
const EARTH_RADIUS_SCENE = R_EARTH / SCALE;

/**
 * GroundTrackLine - renders the sub-satellite ground track on the Earth sphere.
 *
 * Converts lat/lon points (radians) to 3D positions on the Earth surface
 * and renders them as a line with color gradient from green (start) to green (end).
 * Breaks the line at anti-meridian crossings to avoid visual artifacts.
 */
export function GroundTrackLine() {
  const showGroundTrack = useAnalysisStore((s) => s.showGroundTrack);
  const groundTrackPoints = useAnalysisStore((s) => s.groundTrackPoints);

  const segments = useMemo(() => {
    if (!showGroundTrack || groundTrackPoints.length < 2) return null;

    const allSegments: [number, number, number][][] = [];
    let currentSegment: [number, number, number][] = [];
    let prevLon: number | null = null;

    for (const pt of groundTrackPoints) {
      // Skip if crossing the anti-meridian (longitude jump > 180 deg)
      if (prevLon !== null) {
        const lonDiff = Math.abs(pt.lon - prevLon);
        if (lonDiff > Math.PI) {
          // Break the line at the meridian crossing
          if (currentSegment.length > 1) {
            allSegments.push(currentSegment);
          }
          currentSegment = [];
          prevLon = pt.lon;
          continue;
        }
      }
      prevLon = pt.lon;

      // Convert lat/lon (radians) to 3D position on sphere
      const r = EARTH_RADIUS_SCENE + pt.alt / SCALE + 0.01; // Slightly above surface

      const x = r * Math.cos(pt.lat) * Math.cos(pt.lon);
      const y = r * Math.sin(pt.lat);
      const z = -r * Math.cos(pt.lat) * Math.sin(pt.lon);

      currentSegment.push([x, y, z]);
    }

    if (currentSegment.length > 1) {
      allSegments.push(currentSegment);
    }

    return allSegments.length > 0 ? allSegments : null;
  }, [showGroundTrack, groundTrackPoints]);

  if (!segments) return null;

  return (
    <group>
      {segments.map((pts, idx) => (
        <Line
          key={idx}
          points={pts}
          color="#50fa7b"
          lineWidth={1.5}
          transparent
          opacity={0.8}
        />
      ))}
    </group>
  );
}
