import { useAnalysisStore } from '@/store/useAnalysisStore';

export function ManeuverPanel() {
  const alt1 = useAnalysisStore((s) => s.maneuverAlt1Km);
  const alt2 = useAnalysisStore((s) => s.maneuverAlt2Km);
  const result = useAnalysisStore((s) => s.maneuverResult);
  const setAlt1 = useAnalysisStore((s) => s.setManeuverAlt1);
  const setAlt2 = useAnalysisStore((s) => s.setManeuverAlt2);
  const compute = useAnalysisStore((s) => s.computeManeuver);

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Hohmann Transfer
      </span>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Initial Altitude (km)
        </label>
        <input
          type="number"
          min={100}
          max={100000}
          step={100}
          value={alt1}
          onChange={(e) => setAlt1(parseFloat(e.target.value) || 400)}
          className="input-field w-full"
        />
      </div>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Target Altitude (km)
        </label>
        <input
          type="number"
          min={100}
          max={100000}
          step={100}
          value={alt2}
          onChange={(e) => setAlt2(parseFloat(e.target.value) || 35786)}
          className="input-field w-full"
        />
      </div>

      <button onClick={compute} className="btn-primary w-full text-[11px] font-mono">
        Compute Transfer
      </button>

      {result && (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Results
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
            <div>
              <span className="text-comment">Burn 1:</span>
              <span className="text-neon-cyan ml-1">
                {result.dv1.toFixed(4)} km/s
              </span>
            </div>
            <div>
              <span className="text-comment">Burn 2:</span>
              <span className="text-neon-cyan ml-1">
                {result.dv2.toFixed(4)} km/s
              </span>
            </div>
            <div>
              <span className="text-comment">Total dV:</span>
              <span className="text-neon-green ml-1 font-bold">
                {result.dvTotal.toFixed(4)} km/s
              </span>
            </div>
            <div>
              <span className="text-comment">Transfer:</span>
              <span className="text-neon-purple ml-1">
                {(result.transferTimeS / 3600).toFixed(2)} hr
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
