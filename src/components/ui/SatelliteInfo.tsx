import { useMemo } from 'react';
import { useMissionStore } from '@/store/useMissionStore';
import { sgp4GetElements, sgp4Propagate } from '@/orbit/wasmLoader';
import { MU_EARTH, R_EARTH, RAD_TO_DEG } from '@/orbit/constants';

/**
 * SatelliteInfo - floating panel showing details of the selected satellite.
 */
export function SatelliteInfo() {
  const selectedId = useMissionStore((s) => s.selectedSatelliteId);
  const satellites = useMissionStore((s) => s.satellites);
  const currentEpoch = useMissionStore((s) => s.currentEpoch);
  const selectSatellite = useMissionStore((s) => s.selectSatellite);

  const satellite = useMemo(
    () => satellites.find((s) => s.id === selectedId) ?? null,
    [satellites, selectedId]
  );

  const elements = useMemo(() => {
    if (!satellite || satellite.handle === null) return null;
    return sgp4GetElements(satellite.handle, currentEpoch);
  }, [satellite, currentEpoch]);

  const stateVector = useMemo(() => {
    if (!satellite || satellite.handle === null) return null;
    return sgp4Propagate(satellite.handle, currentEpoch);
  }, [satellite, currentEpoch]);

  if (!satellite) return null;

  const period = elements && elements.a > 0
    ? 2 * Math.PI * Math.sqrt(Math.pow(elements.a, 3) / MU_EARTH)
    : null;

  const altitude = elements && elements.a > 0
    ? elements.a - R_EARTH
    : null;

  const velocity = stateVector
    ? Math.sqrt(stateVector.vx ** 2 + stateVector.vy ** 2 + stateVector.vz ** 2)
    : null;

  return (
    <div className="panel w-64">
      <div className="panel-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: satellite.color }}
          />
          <span className="panel-label">{satellite.name}</span>
        </div>
        <button
          onClick={() => selectSatellite(null)}
          className="btn-icon"
          aria-label="Close"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="px-3 py-2 space-y-2">
        {/* NORAD ID */}
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-mono text-zenith-muted">NORAD ID</span>
          <span className="text-[10px] font-mono text-white">{satellite.noradId}</span>
        </div>

        {/* Category */}
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-mono text-zenith-muted">Category</span>
          <span className="text-[10px] font-mono text-white">{satellite.category}</span>
        </div>

        {/* Divider */}
        <div className="border-t border-zenith-border" />

        {/* Orbital elements */}
        {elements ? (
          <>
            <div className="text-[9px] font-mono text-zenith-muted uppercase mb-1">
              Orbital Elements
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <ElementRow label="a" value={elements.a} unit="km" />
              <ElementRow label="e" value={elements.e} unit="" precision={6} />
              <ElementRow label="i" value={elements.i * RAD_TO_DEG} unit="deg" />
              <ElementRow label="RAAN" value={elements.raan * RAD_TO_DEG} unit="deg" />
              <ElementRow label="argp" value={elements.argp * RAD_TO_DEG} unit="deg" />
              <ElementRow label="ta" value={elements.ta * RAD_TO_DEG} unit="deg" />
            </div>
          </>
        ) : (
          <div className="text-[10px] font-mono text-zenith-muted text-center py-2">
            No orbital data available
          </div>
        )}

        {/* Divider */}
        <div className="border-t border-zenith-border" />

        {/* Derived quantities */}
        <div className="text-[9px] font-mono text-zenith-muted uppercase mb-1">
          Derived
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <DerivedRow label="Period" value={period} unit="min" format={(v) => (v / 60).toFixed(1)} />
          <DerivedRow label="Altitude" value={altitude} unit="km" format={(v) => v.toFixed(1)} />
          <DerivedRow label="Velocity" value={velocity} unit="km/s" format={(v) => v.toFixed(4)} />
        </div>
      </div>
    </div>
  );
}

function ElementRow({
  label,
  value,
  unit,
  precision = 2,
}: {
  label: string;
  value: number;
  unit: string;
  precision?: number;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] font-mono text-zenith-subtle">{label}</span>
      <span className="text-[10px] font-mono text-white tabular-nums">
        {value.toFixed(precision)}
        {unit ? <span className="text-zenith-muted ml-0.5">{unit}</span> : null}
      </span>
    </div>
  );
}

function DerivedRow({
  label,
  value,
  unit,
  format,
}: {
  label: string;
  value: number | null;
  unit: string;
  format: (v: number) => string;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] font-mono text-zenith-subtle">{label}</span>
      <span className="text-[10px] font-mono text-white tabular-nums">
        {value !== null ? format(value) : '--'}
        {value !== null && unit ? <span className="text-zenith-muted ml-0.5">{unit}</span> : null}
      </span>
    </div>
  );
}
