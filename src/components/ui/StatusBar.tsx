import { useMemo } from 'react';
import { useMissionStore } from '@/store/useMissionStore';
import { sgp4GetElements } from '@/orbit/wasmLoader';
import { MU_EARTH } from '@/orbit/constants';

/**
 * Format a number with fixed precision.
 */
function fmt(n: number, decimals: number): string {
  return n.toFixed(decimals);
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

  const totalCount = satellites.length;
  const visibleCount = satellites.filter((s) => s.visible).length;

  // Compute selected satellite stats
  const selectedStats = useMemo(() => {
    if (!selectedId) return null;
    const sat = satellites.find((s) => s.id === selectedId);
    if (!sat || sat.handle === null) return null;

    const elements = sgp4GetElements(sat.handle, currentEpoch);
    if (!elements || elements.a <= 0) return null;

    const R_EARTH = 6378.137;
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
    </div>
  );
}
