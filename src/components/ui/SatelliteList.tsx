import { useMissionStore, CATEGORY_COLORS } from '@/store/useMissionStore';
import type { Satellite } from '@/store/useMissionStore';

/**
 * SatelliteList - sidebar panel showing all loaded satellites.
 *
 * Uses collapsible category sections matching the analysis panel style.
 */
export function SatelliteList({
  onOpenTleInput,
  onOpenCatalog,
}: {
  onOpenTleInput: () => void;
  onOpenCatalog: () => void;
}) {
  const satellites = useMissionStore((s) => s.satellites);
  const selectedId = useMissionStore((s) => s.selectedSatelliteId);
  const selectSatellite = useMissionStore((s) => s.selectSatellite);
  const toggleVisibility = useMissionStore((s) => s.toggleSatelliteVisibility);

  // Group by category
  const grouped = satellites.reduce<Record<string, Satellite[]>>((acc, sat) => {
    const cat = sat.category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(sat);
    return acc;
  }, {});

  const categoryOrder: Satellite['category'][] = ['LEO', 'MEO', 'GEO', 'HEO', 'DEBRIS'];

  return (
    <div className="bg-[#0d0d12] flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-dust flex items-center justify-between shrink-0">
        <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
          SATELLITES
        </span>
        <span className="text-[10px] font-mono text-comment">{satellites.length}</span>
      </div>

      {/* Satellite list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {satellites.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <div className="text-xs text-comment font-mono mb-2">
              No satellites loaded
            </div>
            <div className="space-y-1">
              <button
                onClick={onOpenCatalog}
                className="block w-full text-[10px] font-mono text-neon-cyan hover:text-neon-cyan/80 transition-colors"
              >
                Browse Catalog
              </button>
              <button
                onClick={onOpenTleInput}
                className="block w-full text-[10px] font-mono text-neon-purple hover:text-neon-purple/80 transition-colors"
              >
                Add from TLE
              </button>
            </div>
          </div>
        ) : (
          categoryOrder.map((cat) => {
            const sats = grouped[cat];
            if (!sats || sats.length === 0) return null;

            return (
              <div key={cat}>
                {/* Category header */}
                <div className="px-3 py-1.5 flex items-center gap-2 border-b border-dust/50">
                  <div
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: CATEGORY_COLORS[cat] }}
                  />
                  <span className="text-[10px] font-mono text-comment uppercase">
                    {cat}
                  </span>
                  <span className="text-[10px] font-mono text-space-400">
                    {sats.length}
                  </span>
                </div>

                {/* Satellites in category */}
                {sats.map((sat) => (
                  <SatelliteRow
                    key={sat.id}
                    satellite={sat}
                    isSelected={selectedId === sat.id}
                    onSelect={() => selectSatellite(selectedId === sat.id ? null : sat.id)}
                    onToggleVisibility={() => toggleVisibility(sat.id)}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* Add buttons */}
      <div className="px-3 py-2 border-t border-dust shrink-0 flex gap-1">
        <button
          onClick={onOpenCatalog}
          className="flex-1 btn-secondary text-[10px] font-mono py-1.5"
        >
          Catalog
        </button>
        <button
          onClick={onOpenTleInput}
          className="flex-1 btn-primary text-[10px] font-mono py-1.5"
        >
          + Add TLE
        </button>
      </div>
    </div>
  );
}

/**
 * Single satellite row in the list.
 */
function SatelliteRow({
  satellite,
  isSelected,
  onSelect,
  onToggleVisibility,
}: {
  satellite: Satellite;
  isSelected: boolean;
  onSelect: () => void;
  onToggleVisibility: () => void;
}) {
  return (
    <div
      className={`px-3 py-1.5 flex items-center gap-2 cursor-pointer transition-colors ${
        isSelected
          ? 'bg-neon-purple/10 border-l-2 border-l-neon-purple'
          : 'hover:bg-white/5 border-l-2 border-l-transparent'
      }`}
      onClick={onSelect}
    >
      {/* Category color dot */}
      <div
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: satellite.color }}
      />

      {/* Name */}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-mono text-white truncate">
          {satellite.name}
        </div>
        <div className="text-[9px] font-mono text-comment">
          {satellite.noradId}
        </div>
      </div>

      {/* Visibility toggle */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisibility();
        }}
        className={`p-1 rounded transition-colors ${
          satellite.visible
            ? 'text-white/60 hover:text-white'
            : 'text-comment/30 hover:text-comment'
        }`}
        title={satellite.visible ? 'Hide' : 'Show'}
        aria-label={`${satellite.visible ? 'Hide' : 'Show'} ${satellite.name}`}
      >
        {satellite.visible ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        )}
      </button>
    </div>
  );
}
