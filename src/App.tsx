import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { initWasm } from '@/orbit/wasmLoader';
import { OrbitScene } from '@/components/scene/OrbitScene';
import { TimeControls } from '@/components/ui/TimeControls';
import { SatelliteList } from '@/components/ui/SatelliteList';
import { TLEInput } from '@/components/ui/TLEInput';
import { SatelliteInfo } from '@/components/ui/SatelliteInfo';
import { AnalysisPanel } from '@/components/analysis/AnalysisPanel';
import { Starfield } from '@/components/ui/Starfield';
import { OrbitLogo } from '@/components/ui/OrbitLogo';
import { TheoryPage } from '@/pages/TheoryPage';
import { useMissionStore } from '@/store/useMissionStore';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { downloadMission } from '@/utils/missionExport';

/**
 * OrbitToolPage - the main 3D orbit visualization and analysis tool.
 */
function OrbitToolPage() {
  const [loading, setLoading] = useState(true);
  const [showTleInput, setShowTleInput] = useState(false);
  const selectedSatelliteId = useMissionStore((s) => s.selectedSatelliteId);

  useKeyboardShortcuts();

  useEffect(() => {
    initWasm().then((ok) => {
      useMissionStore.getState().setWasmReady(ok);
      if (!ok) console.warn('WASM init failed, using TS fallbacks');
      setTimeout(() => setLoading(false), 600);
    });
  }, []);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left sidebar: Satellite List */}
      <aside className="w-64 shrink-0 border-r border-dust bg-[#0d0d12] z-10 flex flex-col">
        <SatelliteList onOpenTleInput={() => setShowTleInput(true)} />
      </aside>

      {/* 3D Scene with overlay panels */}
      <main className="flex-1 relative">
        <OrbitScene />

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-void/80 z-20">
            <div className="flex items-center gap-3 px-4 py-2 bg-card-surface border border-dust">
              <div className="w-3 h-3 rounded-full border-2 border-neon-purple/40 border-t-neon-purple animate-spin" />
              <span className="text-xs font-mono text-comment">
                Initializing propagators...
              </span>
            </div>
          </div>
        )}

        {/* Top right: Time Controls */}
        <div className="absolute top-3 right-3 z-10 pointer-events-auto">
          <TimeControls />
        </div>

        {/* Bottom left: Controls help */}
        <div className="absolute bottom-3 left-3 z-10 pointer-events-auto">
          <div className="bg-black/60 backdrop-blur-sm p-3 text-[11px] font-mono text-comment space-y-1">
            <div className="text-space-300 font-semibold mb-1">
              CONTROLS
            </div>
            <div>Left drag: Rotate</div>
            <div>Right drag: Pan</div>
            <div>Scroll: Zoom</div>
            <div>Click satellite: Select</div>
          </div>
        </div>

        {/* Floating: Satellite Info (when selected) */}
        {selectedSatelliteId && (
          <div className="absolute top-3 left-3 z-10 pointer-events-auto animate-fade-in">
            <SatelliteInfo />
          </div>
        )}
      </main>

      {/* Right sidebar: Analysis Panel + Propagation */}
      <AnalysisPanel />

      {/* TLE Input Modal */}
      {showTleInput && (
        <TLEInput onClose={() => setShowTleInput(false)} />
      )}
    </div>
  );
}

function App() {
  const wasmReady = useMissionStore((s) => s.wasmReady);

  return (
    <BrowserRouter>
      <div className="h-screen w-screen flex flex-col bg-void overflow-hidden">
        <Starfield />

        {/* Header */}
        <header className="h-14 border-b border-dust flex items-center px-4 justify-between bg-[#0d0d12] z-10 shrink-0">
          <div className="flex items-center gap-3">
            <OrbitLogo className="w-8 h-8" />
            <span className="font-bold text-lg text-white font-mono">Zenith</span>
          </div>

          {/* Navigation */}
          <nav className="flex items-center gap-1">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `px-3 py-1.5 text-xs font-mono transition-colors rounded ${
                  isActive
                    ? 'text-neon-purple bg-neon-purple/10'
                    : 'text-comment hover:text-white hover:bg-white/5'
                }`
              }
            >
              Orbit
            </NavLink>
            <NavLink
              to="/theory"
              className={({ isActive }) =>
                `px-3 py-1.5 text-xs font-mono transition-colors rounded ${
                  isActive
                    ? 'text-neon-purple bg-neon-purple/10'
                    : 'text-comment hover:text-white hover:bg-white/5'
                }`
              }
            >
              Theory
            </NavLink>
          </nav>

          <div className="flex items-center gap-3">
            <button
              onClick={downloadMission}
              className="text-[10px] font-mono px-2 py-0.5 bg-white/5 text-comment hover:text-space-50 hover:bg-white/10 transition-colors"
            >
              Export
            </button>
            <span
              className={`text-[10px] font-mono px-2 py-0.5 ${
                wasmReady
                  ? 'text-neon-green bg-neon-green/10'
                  : 'text-neon-orange bg-neon-orange/10'
              }`}
            >
              {wasmReady ? 'WASM Ready' : 'TS Fallback'}
            </span>
          </div>
        </header>

        {/* Routes */}
        <Routes>
          <Route path="/" element={<OrbitToolPage />} />
          <Route path="/theory" element={<TheoryPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
