import { Html } from '@react-three/drei';
import { useODStore } from '@/store/useODStore';
import { useMissionStore } from '@/store/useMissionStore';
import { stationPositionEci } from '@/orbit/stations';

/** Marker color: Dracula orange, distinct from satellite and overlay hues. */
const STATION_COLOR = '#ffb86c';

/** Station marker radius in scene units (about 20 km, visible against Earth). */
const MARKER_RADIUS = 0.02;

/**
 * Convert a TEME position (km) to scene coordinates.
 * Same transform used by SatelliteMarker and ConjunctionMarker.
 */
function toScene(pos: { x: number; y: number; z: number }): [number, number, number] {
  return [pos.x / 1000, pos.z / 1000, -pos.y / 1000];
}

/**
 * GroundStationMarkers - OD ground station markers in the 3D scene.
 *
 * Positions each station from the OD store at the mission's current epoch
 * (the Earth rotates under the satellites, so markers must follow). Stations
 * without a propagator handle (WASM never loaded) are skipped. Labels reuse
 * the Html pattern from SatelliteMarker. Visibility follows
 * sceneToggles.stations.
 */
export function GroundStationMarkers() {
  const show = useODStore((s) => s.sceneToggles.stations);
  const stations = useODStore((s) => s.stations);
  const currentEpoch = useMissionStore((s) => s.currentEpoch);

  if (!show) return null;

  return (
    <group>
      {stations.map((station) => {
        if (station.handle == null) return null;
        const pos = stationPositionEci(station.handle, currentEpoch);
        if (!pos) return null;

        return (
          <group key={station.id} position={toScene(pos)}>
            <mesh>
              <sphereGeometry args={[MARKER_RADIUS, 12, 12]} />
              <meshBasicMaterial color={STATION_COLOR} />
            </mesh>
            <Html
              position={[0, MARKER_RADIUS * 2.5, 0]}
              center
              distanceFactor={15}
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              <div
                className="whitespace-nowrap px-1.5 py-0.5 rounded text-[8px] font-mono"
                style={{
                  background: 'rgba(0, 0, 0, 0.6)',
                  color: STATION_COLOR,
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              >
                {station.name}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
