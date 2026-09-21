import { useEffect, useState } from 'react';
import { initWasm } from '@/orbit/wasmLoader';
import { OrbitScene } from '@/components/scene/OrbitScene';

function App() {
  const [wasmReady, setWasmReady] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    initWasm().then((ok) => {
      setWasmReady(ok)
      if (!ok) console.warn('WASM init failed, using TS fallbacks')
      // Brief delay so the scene has time to initialize
      setTimeout(() => setLoading(false), 600)
    })
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col bg-zenith-dark overflow-hidden">
      {/* Header */}
      <header className="h-14 border-b border-zenith-border flex items-center px-4 justify-between bg-zenith-surface z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-zenith-purple/20 flex items-center justify-center">
            <span className="text-zenith-purple font-bold text-sm font-mono">Z</span>
          </div>
          <span className="font-bold text-lg text-white font-mono">Zenith</span>
          <span className="text-xs text-zenith-muted font-mono">v0.1.0</span>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-xs font-mono px-2 py-0.5 ${
              wasmReady
                ? 'text-zenith-green bg-zenith-green/10'
                : 'text-zenith-orange bg-zenith-orange/10'
            }`}
          >
            {wasmReady ? 'WASM Ready' : 'TS Fallback'}
          </span>
        </div>
      </header>

      {/* 3D Scene */}
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

        {/* Controls help */}
        <div className="absolute bottom-4 left-4 z-10 pointer-events-auto">
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
      </main>

      {/* Footer */}
      <footer className="h-8 border-t border-zenith-border flex items-center px-4 bg-zenith-surface z-10 shrink-0">
        <span className="text-xs text-zenith-muted font-mono">
          Zenith v0.1.0 // Satellite Mission Planner
        </span>
      </footer>
    </div>
  )
}

export default App
