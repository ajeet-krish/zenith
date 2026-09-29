import { useMissionStore } from '@/store/useMissionStore';
import { formatJdShort } from '@/utils/timeFormat';

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
 * PropagationPanel - compact horizontal bar for propagation method and force model configuration.
 * Sits above the TimeControls bar at the top of the scene.
 */
export function PropagationPanel() {
  const propagationMethod = useMissionStore((s) => s.propagationMethod);
  const forceModels = useMissionStore((s) => s.forceModels);
  const currentEpoch = useMissionStore((s) => s.currentEpoch);
  const setPropagationMethod = useMissionStore((s) => s.setPropagationMethod);
  const toggleForceModel = useMissionStore((s) => s.toggleForceModel);

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-black/60 backdrop-blur-sm border-b border-white/5 font-mono text-[11px]">
      {/* Label */}
      <span className="text-comment uppercase tracking-wider shrink-0">
        PROPAGATION
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
