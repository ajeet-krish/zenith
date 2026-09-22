import { useMissionStore } from '@/store/useMissionStore';

const PROPAGATION_METHODS: { value: 'sgp4' | 'kepler' | 'rk45'; label: string; desc: string }[] = [
  { value: 'sgp4', label: 'SGP4', desc: 'Analytical' },
  { value: 'kepler', label: 'Kepler', desc: 'Two-body' },
  { value: 'rk45', label: 'RK45', desc: 'Numerical' },
];

const FORCE_MODELS: { key: 'j2' | 'drag' | 'srp' | 'thirdBody'; label: string }[] = [
  { key: 'j2', label: 'J2' },
  { key: 'drag', label: 'Drag' },
  { key: 'srp', label: 'SRP' },
  { key: 'thirdBody', label: '3rd Body' },
];

/**
 * Format Julian Date for display.
 */
function formatJdShort(jd: number): string {
  return jd.toFixed(4);
}

/**
 * PropagationPanel - panel for propagation method and force model configuration.
 */
export function PropagationPanel() {
  const propagationMethod = useMissionStore((s) => s.propagationMethod);
  const forceModels = useMissionStore((s) => s.forceModels);
  const currentEpoch = useMissionStore((s) => s.currentEpoch);
  const wasmReady = useMissionStore((s) => s.wasmReady);
  const setPropagationMethod = useMissionStore((s) => s.setPropagationMethod);
  const toggleForceModel = useMissionStore((s) => s.toggleForceModel);

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-label">PROPAGATION</span>
        <span
          className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
            wasmReady
              ? 'text-neon-green bg-neon-green/10'
              : 'text-neon-orange bg-neon-orange/10'
          }`}
        >
          {wasmReady ? 'WASM' : 'TS'}
        </span>
      </div>

      <div className="px-3 py-2 space-y-3">
        {/* Propagation method */}
        <div>
          <label className="block text-[9px] font-mono text-comment uppercase mb-1.5">
            Method
          </label>
          <div className="flex gap-1">
            {PROPAGATION_METHODS.map((m) => (
              <button
                key={m.value}
                onClick={() => setPropagationMethod(m.value)}
                className={`flex-1 px-2 py-1.5 rounded text-[10px] font-mono transition-colors ${
                  propagationMethod === m.value
                    ? 'bg-neon-purple/20 text-neon-purple border border-neon-purple/30'
                    : 'bg-white/5 text-comment hover:text-white hover:bg-white/10 border border-transparent'
                }`}
              >
                <div>{m.label}</div>
                <div className="text-[8px] opacity-60">{m.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Force models */}
        <div>
          <label className="block text-[9px] font-mono text-comment uppercase mb-1.5">
            Force Models
          </label>
          <div className="flex gap-1">
            {FORCE_MODELS.map((f) => (
              <button
                key={f.key}
                onClick={() => toggleForceModel(f.key)}
                className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono transition-colors ${
                  forceModels[f.key]
                    ? 'bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/30'
                    : 'bg-white/5 text-comment hover:text-white hover:bg-white/10 border border-transparent'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* WASM notice */}
        {!wasmReady && (
          <div className="text-[9px] font-mono text-neon-orange/70 bg-neon-orange/5 px-2 py-1 rounded">
            Force models and RK45 require WASM. Using Kepler fallback.
          </div>
        )}

        {/* Epoch display */}
        <div className="flex items-center justify-between pt-1 border-t border-dust">
          <span className="text-[9px] font-mono text-comment">Epoch JD</span>
          <span className="text-[10px] font-mono text-space-400 tabular-nums">
            {formatJdShort(currentEpoch)}
          </span>
        </div>
      </div>
    </div>
  );
}
