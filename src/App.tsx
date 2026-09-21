import { useEffect, useState } from 'react';
import { initWasm } from '@/orbit/wasmLoader';
import { OrbitScene } from '@/components/scene/OrbitScene';
import { TimeControls } from '@/components/ui/TimeControls';
import { SatelliteList } from '@/components/ui/SatelliteList';
import { TLEInput } from '@/components/ui/TLEInput';
import { PropagationPanel } from '@/components/ui/PropagationPanel';
import { SatelliteInfo } from '@/components/ui/SatelliteInfo';
import { useMissionStore } from '@/store/useMissionStore';

function App() {
  const [loading, setLoading] = useState(true);
  const [showTleInput, setShowTleInput] = useState(false);
  const selectedSatelliteId = useMissionStore((s) => s.selectedSatelliteId);
  const wasmReady = useMissionStore((s) => s.wasmReady);

  useEffect(() => {
    initWasm().then((ok) => {
      useMissionStore.getState().setWasmReady(ok);
      if (!ok) console.warn('WASM init failed, using TS fallbacks');
      setTimeout(() => setLoading(false), 600);
    });
  }, []);

  return (
    <div className="h-screen w-screen flex bg-zenith-dark overflow-hidden">
      {/* Left sidebar: Satellite List */}
      <aside className="w-64 shrink-0 border-r border-zenith-border bg-zenith-surface z-10 flex flex-col">
        <SatelliteList onOpenTleInput={() => setShowTleInput(true)} />
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-10 border-b border-zenith-border flex items-center px-4 justify-between bg-zenith-surface z-10 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 bg-zenith-purple/20 flex items-center justify-center">
              <span className="text-zenith-purple font-bold text-[10px] font-mono">Z</span>
            </div>
            <span className="font-bold text-sm text-white font-mono">Zenith</span>
            <span className="text-[10px] text-zenith-muted font-mono">v0.1.0</span>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`text-[10px] font-mono px-2 py-0.5 ${
                wasmReady
                  ? 'text-zenith-green bg-zenith-green/10'
                  : 'text-zenith-orange bg-zenith-orange/10'
              }`}
            >
              {wasmReady ? 'WASM Ready' : 'TS Fallback'}
            </span>
          </div>
        </header>

        {/* 3D Scene with overlay panels */}
        <main className="flex-1 relative">
          <OrbitScene />

          {/* Loading overlay */}
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-zenith-dark/80 z-20">
              <div className="flex items-center gap-3 px-4 py-2 rounded-md bg-zenith-surface border border-zenith-border">
                <div className="w-3 h-3 rounded-full border-2 border-zenith-purple/40 border-t-zenith-purple animate-spin" />
                <span className="text-xs font-mono text-zenith-muted">
                  Initializing propagators...
                </span>
              </div>
            </div>
          )}

          {/* Top right: Time Controls */}
          <div className="absolute top-3 right-3 z-10 pointer-events-auto">
            <TimeControls />
          </div>

          {/* Bottom right: Propagation Panel */}
          <div className="absolute bottom-3 right-3 z-10 pointer-events-auto">
            <PropagationPanel />
          </div>

          {/* Bottom left: Controls help */}
          <div className="absolute bottom-3 left-3 z-10 pointer-events-auto">
            <div className="bg-black/60 backdrop-blur-sm rounded-lg p-3 text-[11px] font-mono text-zenith-muted space-y-1">
              <div className="text-zenith-subtle font-semibold mb-1">
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
      </div>

      {/* TLE Input Modal */}
      {showTleInput && (
        <TLEInput onClose={() => setShowTleInput(false)} />
      )}
    </div>
  );
}

export default App;
