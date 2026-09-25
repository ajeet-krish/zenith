import { useAnalysisStore } from '@/store/useAnalysisStore';
import { ManeuverPanel } from './ManeuverPanel';
import { LambertPanel } from './LambertPanel';
import { GroundTrackPanel } from './GroundTrackPanel';
import { ConjunctionPanel } from './ConjunctionPanel';
import { PassPredictorPanel } from './PassPredictorPanel';
import { MonteCarloPanel } from './MonteCarloPanel';
import { CoveragePanel } from './CoveragePanel';
import type { AnalysisTool } from '@/orbit/types';

const TOOLS: { id: AnalysisTool; label: string }[] = [
  { id: 'maneuver', label: 'Maneuver' },
  { id: 'lambert', label: 'Lambert' },
  { id: 'groundtrack', label: 'Gnd Trk' },
  { id: 'conjunction', label: 'Conjunc' },
  { id: 'passpredict', label: 'Passes' },
  { id: 'montecarlo', label: 'MC' },
  { id: 'coverage', label: 'Cov' },
];

export function AnalysisPanel() {
  const activeTool = useAnalysisStore((s) => s.activeTool);
  const setActiveTool = useAnalysisStore((s) => s.setActiveTool);

  return (
    <div className="bg-[#0d0d12] border border-dust w-full flex flex-col overflow-hidden">
      {/* Tool tabs */}
      <div className="flex border-b border-dust">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(activeTool === tool.id ? null : tool.id)}
            className={`flex-1 px-2 py-2 text-[10px] font-mono transition-colors ${
              activeTool === tool.id
                ? 'text-neon-purple bg-neon-purple/10 border-b-2 border-neon-purple'
                : 'text-comment hover:text-space-50 hover:bg-white/5'
            }`}
          >
            {tool.label}
          </button>
        ))}
      </div>

      {/* Tool content - fills available space */}
      <div className="flex-1 overflow-y-auto p-3">
        {activeTool === 'maneuver' && <ManeuverPanel />}
        {activeTool === 'lambert' && <LambertPanel />}
        {activeTool === 'groundtrack' && <GroundTrackPanel />}
        {activeTool === 'conjunction' && <ConjunctionPanel />}
        {activeTool === 'passpredict' && <PassPredictorPanel />}
        {activeTool === 'montecarlo' && <MonteCarloPanel />}
        {activeTool === 'coverage' && <CoveragePanel />}
        {!activeTool && (
          <div className="text-[11px] font-mono text-comment text-center py-8">
            Select an analysis tool above
          </div>
        )}
      </div>
    </div>
  );
}
