import { useMemo } from 'react';
import * as THREE from 'three';
import { useODStore } from '@/store/useODStore';
import { useMissionStore } from '@/store/useMissionStore';
import { sgp4Propagate } from '@/orbit/wasmLoader';
import { stationPositionEci } from '@/orbit/stations';
import type { ODObservationType } from '@/orbit/types';

/** Hard cap on drawn rays; larger observation sets are subsampled evenly. */
const MAX_RAYS = 50;

/** Ray color per observation type (Dracula palette, distinct per type). */
const TYPE_COLORS: Record<ODObservationType, string> = {
  range: '#8be9fd', // cyan
  range_rate: '#bd93f9', // purple
  ra_dec: '#50fa7b', // green
  az_el: '#ffb86c', // orange
};

/**
 * ObservationLosRays - lines of sight from ground stations to the selected
 * satellite at each observation epoch.
 *
 * One LineSegments draw call with per-vertex colors. Satellite positions
 * come from SGP4 (WASM with TS fallback, same as SatelliteMarker); station
 * positions from stationPositionEci. Renders nothing without a selected
 * satellite. Visibility follows sceneToggles.losRays.
 */
export function ObservationLosRays() {
  const show = useODStore((s) => s.sceneToggles.losRays);
  const observations = useODStore((s) => s.observations);
  const stations = useODStore((s) => s.stations);
  const satellites = useMissionStore((s) => s.satellites);
  const selectedId = useMissionStore((s) => s.selectedSatelliteId);

  const geometry = useMemo(() => {
    if (!show || observations.length === 0) return null;

    const sat = satellites.find((s) => s.id === selectedId);
    if (!sat || sat.handle == null) return null;

    // Even subsample of up to MAX_RAYS observations.
    const stride = Math.max(1, Math.ceil(observations.length / MAX_RAYS));
    const sampled = observations.filter((_, i) => i % stride === 0).slice(0, MAX_RAYS);

    const stationById = new Map(stations.map((s) => [s.id, s]));

    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();

    for (const obs of sampled) {
      const station = stationById.get(obs.stationId);
      if (!station || station.handle == null) continue;
      const staPos = stationPositionEci(station.handle, obs.timeJd);
      const satState = sgp4Propagate(sat.handle, obs.timeJd);
      if (!staPos || !satState) continue;
      // Skip rays with non-finite endpoints (bad TLE epochs, WASM hiccups):
      // one NaN vertex would poison the whole LineSegments draw call.
      const finite =
        Number.isFinite(staPos.x) && Number.isFinite(staPos.y) && Number.isFinite(staPos.z) &&
        Number.isFinite(satState.x) && Number.isFinite(satState.y) && Number.isFinite(satState.z);
      if (!finite) continue;

      // TEME km -> scene units.
      positions.push(
        staPos.x / 1000, staPos.z / 1000, -staPos.y / 1000,
        satState.x / 1000, satState.z / 1000, -satState.y / 1000
      );
      color.set(TYPE_COLORS[obs.obsType] ?? '#ffffff');
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }

    if (positions.length === 0) return null;
    return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
  }, [show, observations, stations, satellites, selectedId]);

  if (!geometry) return null;

  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[geometry.positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[geometry.colors, 3]} />
      </bufferGeometry>
      <lineBasicMaterial vertexColors transparent opacity={0.4} />
    </lineSegments>
  );
}
