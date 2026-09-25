import { useRef, useMemo } from 'react';
import { Vector3 } from 'three';
import { computeOrbitTrailWithVelocity } from '@/utils/orbitTrail';

/**
 * Cache entry for orbit trail data.
 */
interface TrailCacheEntry {
  epoch: number;
  positions: Vector3[];
  colors: [number, number, number][];
}

/**
 * Time bucket size in days. Trails are only recomputed when the epoch
 * drifts more than this from the cached epoch.
 */
const TRAIL_BUCKET_DAYS = 60 / 86400;

/**
 * useOrbitTrails - cached orbit trail computation with velocity-based coloring.
 *
 * Trails are only recomputed when the epoch drifts beyond the bucket threshold.
 * Colors map velocity to a blue(purple gradient: blue at apogee, red at perigee.
 */
export function useOrbitTrails(
  satellites: Array<{ id: string; visible: boolean; handle: number | null }>,
  currentEpoch: number
): Map<string, { positions: Vector3[]; colors: [number, number, number][] }> {
  const cacheRef = useRef<Map<string, TrailCacheEntry>>(new Map());

  const trails = useMemo(() => {
    const result = new Map<string, { positions: Vector3[]; colors: [number, number, number][] }>();
    const cache = cacheRef.current;

    for (const sat of satellites) {
      if (!sat.visible || sat.handle === null) continue;

      const cached = cache.get(sat.id);
      const epochDrift = Math.abs(currentEpoch - (cached?.epoch ?? 0));

      // Only recompute if epoch drifted beyond the bucket threshold
      if (cached && epochDrift < TRAIL_BUCKET_DAYS) {
        result.set(sat.id, { positions: cached.positions, colors: cached.colors });
        continue;
      }

      // Recompute trail with velocity colors
      const trail = computeOrbitTrailWithVelocity(sat.handle, currentEpoch);
      if (trail && trail.positions.length > 0) {
        result.set(sat.id, { positions: trail.positions, colors: trail.colors });
        cache.set(sat.id, {
          epoch: currentEpoch,
          positions: trail.positions,
          colors: trail.colors,
        });
      } else if (cached) {
        result.set(sat.id, { positions: cached.positions, colors: cached.colors });
      }
    }

    return result;
  }, [satellites, currentEpoch]);

  return trails;
}
