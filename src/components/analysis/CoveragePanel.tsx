import { useState } from 'react'
import { useAnalysisStore } from '@/store/useAnalysisStore'
import { useMissionStore } from '@/store/useMissionStore'
import { generateWalker, type WalkerState } from '@/orbit/analysisLoader'

export function CoveragePanel() {
  const walkerConfig = useAnalysisStore((s) => s.walkerConfig)
  const setWalkerConfig = useAnalysisStore((s) => s.setWalkerConfig)
  const currentEpoch = useMissionStore((s) => s.currentEpoch)
  const [constellation, setConstellation] = useState<WalkerState[] | null>(null)
  const [generating, setGenerating] = useState(false)

  const handleGenerate = () => {
    setGenerating(true)
    const states = generateWalker(
      {
        inclinationDeg: (walkerConfig.inclinationRad * 180) / Math.PI,
        totalSats: walkerConfig.totalSats,
        numPlanes: walkerConfig.numPlanes,
        phasingFactor: walkerConfig.phasingFactor,
        altitudeKm: walkerConfig.altitudeKm,
      },
      currentEpoch
    )
    setConstellation(states)
    setGenerating(false)
  }

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Walker Delta Constellation
      </span>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Total Sats</label>
          <input
            type="number"
            min={1}
            max={100}
            value={walkerConfig.totalSats}
            onChange={(e) => setWalkerConfig({ totalSats: parseInt(e.target.value) || 24 })}
            className="input-field w-full"
          />
        </div>
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Planes</label>
          <input
            type="number"
            min={1}
            max={20}
            value={walkerConfig.numPlanes}
            onChange={(e) => setWalkerConfig({ numPlanes: parseInt(e.target.value) || 6 })}
            className="input-field w-full"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">
            Inclination (deg)
          </label>
          <input
            type="number"
            min={0}
            max={180}
            step={0.1}
            value={(walkerConfig.inclinationRad * 180 / Math.PI).toFixed(1)}
            onChange={(e) =>
              setWalkerConfig({
                inclinationRad: (parseFloat(e.target.value) || 51.6) * Math.PI / 180,
              })
            }
            className="input-field w-full"
          />
        </div>
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Altitude (km)</label>
          <input
            type="number"
            min={200}
            max={50000}
            step={100}
            value={walkerConfig.altitudeKm}
            onChange={(e) => setWalkerConfig({ altitudeKm: parseInt(e.target.value) || 20200 })}
            className="input-field w-full"
          />
        </div>
      </div>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">Phasing Factor</label>
        <input
          type="number"
          min={0}
          max={walkerConfig.totalSats - 1}
          value={walkerConfig.phasingFactor}
          onChange={(e) => setWalkerConfig({ phasingFactor: parseInt(e.target.value) || 1 })}
          className="input-field w-full"
        />
      </div>

      <button
        onClick={handleGenerate}
        disabled={generating}
        className="btn-primary w-full text-[11px] font-mono disabled:opacity-40"
      >
        {generating ? 'Generating...' : 'Generate Constellation'}
      </button>

      {constellation && (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment">
            {constellation.length} satellites generated
          </div>
          <div className="text-[10px] font-mono text-space-300">
            Pattern: {walkerConfig.totalSats}:{walkerConfig.numPlanes}/{walkerConfig.phasingFactor}
          </div>
        </div>
      )}
    </div>
  )
}
