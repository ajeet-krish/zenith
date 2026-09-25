import { useMissionStore } from '@/store/useMissionStore';

const PROPAGATION_METHODS: { value: 'sgp4' | 'kepler' | 'rk45'; label: string }[] = [
  { value: 'sgp4', label: 'SGP4' },
  { value: 'kepler', label: 'Kepler' },
  { value: 'rk45', label: 'RK45' },
];

const FORCE_MODELS: { key: 'j2' | 'drag' | 'srp' | 'thirdBody'; label: string }[] = [
  { key: 'j2', label: 'J2' },
  { key: 'drag', label: 'Drag' },
  { key: 'srp', label: 'SRP' },
  { key: 'thirdBody', label: '3rd' },
];

/**
 * Format Julian Date for display.
 */
function formatJdShort(jd: number): string {
  return jd.toFixed(4);
}

/**
 * PropagationPanel - compact horizontal bar for propagation method and force model configuration.
 * Sits above the TimeControls bar at the top of the scene.
 */
export function PropagationPanel() {
  const propagationMethod = useMissionStore((s) => s.propagationMethod);
  const forceModels = useMissionStore((s) => s.forceModels);
  const currentEpoch = useMissionStore((s) => s.currentEpoch);
  const wasmReady = useMissionStore((s) => s.wasmReady);
  const setPropagationMethod = useMissionStore((s) => s.setPropagationMethod);
  const toggleForceModel = useMissionStore((s) => s.toggleForceModel);

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-black/60 backdrop-blur-sm border-b border-white/5 font-mono text-[11px]">
      {/* Label + status */}
      <span className="text-comment uppercase tracking-wider shrink-0">
        PROP
      </span>
      <span
        className={`text-[9px] px-1 py-0.5 rounded shrink-0 ${
          wasmReady
            ? 'text-neon-green bg-neon-green/10'
            : 'text-neon-orange bg-neon-orange/10'
        }`}
      >
        {wasmReady ? 'WASM' : 'TS'}
      </span>

      {/* Divider */}
      <div className="w-px h-4 bg-white/10 shrink-0" />

      {/* Propagation method */}
      <div className="flex items-center gap-0.5 shrink-0">
        {PROPAGATION_METHODS.map((m) => (
          <button
            key={m.value}
            onClick={() => setPropagationMethod(m.value)}
            className={`px-2 py-0.5 rounded transition-colors ${
              propagationMethod === m.value
                ? 'bg-neon-purple/30 text-neon-purple'
                : 'text-comment hover:text-white hover:bg-white/5'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-white/10 shrink-0" />

      {/* Force models */}
      <div className="flex items-center gap-0.5 shrink-0">
        {FORCE_MODELS.map((f) => (
          <button
            key={f.key}
            onClick={() => toggleForceModel(f.key)}
            className={`px-1.5 py-0.5 rounded transition-colors ${
              forceModels[f.key]
                ? 'bg-neon-cyan/20 text-neon-cyan'
                : 'text-comment hover:text-white hover:bg-white/5'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* WASM notice */}
      {!wasmReady && (
        <>
          <div className="w-px h-4 bg-white/10 shrink-0" />
          <span className="text-neon-orange/70 shrink-0">
            Force models + RK45 need WASM
          </span>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Epoch */}
      <span className="text-comment shrink-0">JD</span>
      <span className="text-space-400 tabular-nums shrink-0">
        {formatJdShort(currentEpoch)}
      </span>
    </div>
  );
}
