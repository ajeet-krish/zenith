import { useState } from 'react';
import { ManeuverPanel } from './ManeuverPanel';
import { LambertPanel } from './LambertPanel';
import { GroundTrackPanel } from './GroundTrackPanel';
import { ConjunctionPanel } from './ConjunctionPanel';
import { PassPredictorPanel } from './PassPredictorPanel';
import { MonteCarloPanel } from './MonteCarloPanel';
import { CoveragePanel } from './CoveragePanel';

interface ToolSection {
  id: string;
  label: string;
  component: React.ReactNode;
}

const TOOLS: ToolSection[] = [
  { id: 'maneuver', label: 'MANEUVER', component: <ManeuverPanel /> },
  { id: 'lambert', label: 'LAMBERT', component: <LambertPanel /> },
  { id: 'groundtrack', label: 'GROUND TRACK', component: <GroundTrackPanel /> },
  { id: 'conjunction', label: 'CONJUNCTION', component: <ConjunctionPanel /> },
  { id: 'passpredict', label: 'PASS PREDICTOR', component: <PassPredictorPanel /> },
  { id: 'montecarlo', label: 'MONTE CARLO', component: <MonteCarloPanel /> },
  { id: 'coverage', label: 'WALKER CONSTELLATION', component: <CoveragePanel /> },
];

/**
 * Collapsible section component.
 */
function CollapsibleSection({
  label,
  isOpen,
  onToggle,
  children,
}: {
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-dust">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-mono uppercase tracking-wider transition-colors hover:bg-white/5"
      >
        <span className={isOpen ? 'text-neon-purple' : 'text-comment'}>
          {label}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-comment transition-transform ${isOpen ? 'rotate-90' : ''}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {isOpen && (
        <div className="px-3 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * AnalysisPanel - vertically stacked collapsible analysis sections.
 *
 * Modeled after the Zenith desktop layout. Multiple sections can be
 * open simultaneously, and all sections are scrollable.
 */
export function AnalysisPanel() {
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const toggleSection = (id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="bg-[#0d0d12] border border-dust w-full flex flex-col overflow-hidden">
      {/* Scrollable stacked sections */}
      <div className="flex-1 overflow-y-auto">
        {TOOLS.map((tool) => (
          <CollapsibleSection
            key={tool.id}
            label={tool.label}
            isOpen={openSections.has(tool.id)}
            onToggle={() => toggleSection(tool.id)}
          >
            {tool.component}
          </CollapsibleSection>
        ))}
      </div>
    </div>
  );
}
