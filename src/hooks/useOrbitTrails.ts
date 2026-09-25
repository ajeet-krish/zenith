import { useRef, useMemo } from 'react';
import { Vector3 } from 'three';
import { computeOrbitTrail } from '@/utils/orbitTrail';

/**
 * Cache entry for orbit trail data.
 */
interface TrailCacheEntry {
  epoch: number;
  trail: Vector3[];
}

/**
 * Time bucket size in days. Trails are only recomputed when the epoch
 * drifts more than this from the cached epoch. For a 90-min LEO orbit,
 * bucket = 60 seconds = 60/86400 days.
 */
const TRAIL_BUCKET_DAYS = 60 / 86400;

/**
 * useOrbitTrails - cached orbit trail computation with epoch-bucketed invalidation.
 *
 * Instead of recomputing trails every frame (which triggers 360 sgp4Propagate
 * calls per satellite per frame), trails are only recomputed when the epoch
 * has drifted more than TRAIL_BUCKET_DAYS from the last cached epoch.
 */
export function useOrbitTrails(
  satellites: Array<{ id: string; visible: boolean; handle: number | null }>,
  currentEpoch: number
): Map<string, Vector3[]> {
  const cacheRef = useRef<Map<string, TrailCacheEntry>>(new Map());

  const trails = useMemo(() => {
    const result = new Map<string, Vector3[]>();
    const cache = cacheRef.current;

    for (const sat of satellites) {
      if (!sat.visible || sat.handle === null) continue;

      const cached = cache.get(sat.id);
      const epochDrift = Math.abs(currentEpoch - (cached?.epoch ?? 0));

      // Only recompute if epoch drifted beyond the bucket threshold
      if (cached && epochDrift < TRAIL_BUCKET_DAYS) {
        result.set(sat.id, cached.trail);
        continue;
      }

      // Recompute trail
      const trail = computeOrbitTrail(sat.handle, currentEpoch);
      if (trail.length > 0) {
        result.set(sat.id, trail);
        cache.set(sat.id, { epoch: currentEpoch, trail });
      } else if (cached) {
        // Keep last valid trail if computation fails
        result.set(sat.id, cached.trail);
      }
    }

    return result;
  }, [satellites, currentEpoch]);

  return trails;
}
