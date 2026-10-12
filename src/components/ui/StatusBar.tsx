import { useMemo } from 'react';
import { useMissionStore } from '@/store/useMissionStore';
import { useODStore } from '@/store/useODStore';
import { sgp4GetElements } from '@/orbit/wasmLoader';
import { MU_EARTH, R_EARTH } from '@/orbit/constants';

/**
 * Format a number with fixed precision.
 */
function fmt(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

/**
 * Solve-state chip tone: green when usable, red on error, comment gray when
 * the solve has not run.
 */
function solveTone(state: 'ok' | 'error' | 'idle'): string {
  if (state === 'ok') return 'text-neon-green';
  if (state === 'error') return 'text-neon-red';
  return 'text-comment';
}

/**
 * StatusBar - mission-control style telemetry display at the top of the scene.
 *
 * Shows MET clock, satellite counts, propagation status, and selected satellite stats.
 */
export function StatusBar() {
  const satellites = useMissionStore((s) => s.satellites);
  const selectedId = useMissionStore((s) => s.selectedSatelliteId);
  const currentEpoch = useMissionStore((s) => s.currentEpoch);
  const wasmReady = useMissionStore((s) => s.wasmReady);
  const propagationMethod = useMissionStore((s) => s.propagationMethod);

  // Orbit determination store (Phase 5 OD segment).
  const observations = useODStore((s) => s.observations);
  const stations = useODStore((s) => s.stations);
  const iodResult = useODStore((s) => s.iodResult);
  const batchResult = useODStore((s) => s.batchResult);
  const ekfResult = useODStore((s) => s.ekfResult);

  const obsCount = observations.length;
  const staCount = stations.length;

  const iodTone = !iodResult ? 'idle' : iodResult.converged ? 'ok' : 'error';
  const iodLabel = iodTone === 'idle' ? 'idle' : iodTone === 'ok' ? 'OK' : 'ERR';
  const iodTitle = !iodResult
    ? 'No Gauss IOD solve yet'
    : iodResult.statusMessage;

  const batchTone = !batchResult ? 'idle' : batchResult.converged ? 'ok' : 'error';
  const batchLabel = batchTone === 'idle' ? 'idle' : batchTone === 'ok' ? 'OK' : 'ERR';
  const batchTitle = !batchResult
    ? 'No batch least-squares solve yet'
    : batchResult.statusMessage;

  const ekfTone = !ekfResult ? 'idle' : ekfResult.errorStatus === 0 ? 'ok' : 'error';
  const ekfLabel = ekfTone === 'idle' ? 'idle' : ekfTone === 'ok' ? 'OK' : 'ERR';
  const ekfTitle = !ekfResult
    ? 'No EKF solve yet'
    : ekfResult.statusMessage;

  const totalCount = satellites.length;
  const visibleCount = satellites.filter((s) => s.visible).length;

  // Compute selected satellite stats
  const selectedStats = useMemo(() => {
    if (!selectedId) return null;
    const sat = satellites.find((s) => s.id === selectedId);
    if (!sat || sat.handle === null) return null;

    const elements = sgp4GetElements(sat.handle, currentEpoch);
    if (!elements || elements.a <= 0) return null;

    const altitude = elements.a - R_EARTH;
    const period = 2 * Math.PI * Math.sqrt(Math.pow(elements.a, 3) / MU_EARTH);
    const periodMin = period / 60;

    return {
      name: sat.name,
      altitude,
      periodMin,
      eccentricity: elements.e,
      inclination: elements.i * 180 / Math.PI,
    };
  }, [selectedId, satellites, currentEpoch]);

  return (
    <div className="flex items-center gap-4 px-3 py-1 bg-black/40 backdrop-blur-sm border-b border-white/5 font-mono text-[10px]">
      {/* Satellite counts */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-comment">SATS</span>
        <span className="text-white">{totalCount}</span>
        <span className="text-comment">/</span>
        <span className="text-neon-green">{visibleCount}</span>
        <span className="text-comment">vis</span>
      </div>

      {/* Divider */}
      <div className="w-px h-3 bg-white/10" />

      {/* Propagation engine */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div className={`w-1.5 h-1.5 rounded-full ${wasmReady ? 'bg-neon-green' : 'bg-neon-orange'}`} />
        <span className="text-comment">ENG</span>
        <span className={wasmReady ? 'text-neon-green' : 'text-neon-orange'}>
          {propagationMethod.toUpperCase()}
        </span>
      </div>

      {/* Divider */}
      <div className="w-px h-3 bg-white/10" />

      {/* Selected satellite quick stats */}
      {selectedStats ? (
        <div className="flex items-center gap-3">
          <span className="text-neon-purple">{selectedStats.name}</span>
          <span className="text-comment">ALT</span>
          <span className="text-white">{fmt(selectedStats.altitude, 1)} km</span>
          <span className="text-comment">PER</span>
          <span className="text-white">{fmt(selectedStats.periodMin, 1)} min</span>
          <span className="text-comment">ECC</span>
          <span className="text-white">{fmt(selectedStats.eccentricity, 4)}</span>
          <span className="text-comment">INC</span>
          <span className="text-white">{fmt(selectedStats.inclination, 1)} deg</span>
        </div>
      ) : (
        <span className="text-comment">No satellite selected</span>
      )}

      {/* Orbit determination status (right side) */}
      <div className="flex items-center gap-3 ml-auto shrink-0">
        <div className="w-px h-3 bg-white/10" />

        {obsCount > 0 && (
          <div
            className="flex items-center gap-1"
            title={`${obsCount} observations in the OD store`}
          >
            <span className="text-comment">OBS</span>
            <span className="text-white">{obsCount}</span>
          </div>
        )}

        {staCount > 0 && (
          <div
            className="flex items-center gap-1"
            title={`${staCount} ground stations in the OD store`}
          >
            <span className="text-comment">STA</span>
            <span className="text-white">{staCount}</span>
          </div>
        )}

        <div className="flex items-center gap-1" title={iodTitle}>
          <span className="text-comment">IOD</span>
          <span className={solveTone(iodTone)}>{iodLabel}</span>
        </div>

        <div className="flex items-center gap-1" title={batchTitle}>
          <span className="text-comment">BATCH</span>
          <span className={solveTone(batchTone)}>{batchLabel}</span>
        </div>

        <div className="flex items-center gap-1" title={ekfTitle}>
          <span className="text-comment">EKF</span>
          <span className={solveTone(ekfTone)}>{ekfLabel}</span>
        </div>
      </div>
    </div>
  );
}
