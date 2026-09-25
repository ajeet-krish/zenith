import { useState } from 'react'
import { useAnalysisStore } from '@/store/useAnalysisStore'
import { useMissionStore, CATEGORY_COLORS } from '@/store/useMissionStore'
import { generateWalker, type WalkerState } from '@/orbit/analysisLoader'
import { sgp4Init } from '@/orbit/wasmLoader'
import { MU_EARTH } from '@/orbit/constants'

/**
 * Convert a Walker state (ECI position/velocity) back to a TLE-like representation.
 * For generated constellation satellites, we create simplified TLE lines.
 */
function walkerStateToTle(state: WalkerState, index: number): { line1: string; line2: string } {
  // Compute mean motion from semi-major axis (circular orbit assumption)
  const a = Math.sqrt(state.x ** 2 + state.y ** 2 + state.z ** 2)
  const nRevPerDay = Math.sqrt(MU_EARTH / (a ** 3)) * 86400 / (2 * Math.PI)

  // Compute inclination from position/velocity
  const hx = state.y * state.vz - state.z * state.vy
  const hy = state.z * state.vx - state.x * state.vz
  const hz = state.x * state.vy - state.y * state.vx
  const h = Math.sqrt(hx ** 2 + hy ** 2 + hz ** 2)
  const inc = Math.acos(Math.max(-1, Math.min(1, hz / h))) * 180 / Math.PI

  // Compute RAAN from angular momentum vector
  const raan = ((Math.atan2(-hx, hy) * 180 / Math.PI) + 360) % 360

  // Epoch string (simplified)
  const epochYear = 24
  const epochDay = ((state.jd - 2459945.5) % 365.25)

  // Build TLE lines (simplified format for generated satellites)
  const noradId = 90000 + index
  const line1 = `1 ${String(noradId).padStart(5, '0')}U GEN${String(epochYear).padStart(2, '0')}A   ${epochYear}${String(epochDay).padStart(12, ' ')}  .00000000  00000-0  00000-0 0  000`
  const line2 = `2 ${String(noradId).padStart(5, '0')} ${inc.toFixed(4).padStart(8, ' ')} ${raan.toFixed(4).padStart(8, ' ')} 0001000 000.0000 ${String(360).padStart(8, ' ')} ${nRevPerDay.toFixed(8)}    00`

  return { line1, line2 }
}

export function CoveragePanel() {
  const walkerConfig = useAnalysisStore((s) => s.walkerConfig)
  const setWalkerConfig = useAnalysisStore((s) => s.setWalkerConfig)
  const currentEpoch = useMissionStore((s) => s.currentEpoch)
  const addSatellite = useMissionStore((s) => s.addSatellite)
  const [constellation, setConstellation] = useState<WalkerState[] | null>(null)
  const [generating, setGenerating] = useState(false)
  const [addedCount, setAddedCount] = useState(0)

  const handleGenerate = () => {
    setGenerating(true)
    const states = generateWalker(
      {
        inclinationDeg: walkerConfig.inclinationDeg,
        totalSats: walkerConfig.totalSats,
        numPlanes: walkerConfig.numPlanes,
        phasingFactor: walkerConfig.phasingFactor,
        altitudeKm: walkerConfig.altitudeKm,
      },
      currentEpoch
    )

    if (states && states.length > 0) {
      // Add generated satellites to the mission store/scene
      let added = 0
      for (let i = 0; i < states.length; i++) {
        const state = states[i]!
        const { line1, line2 } = walkerStateToTle(state, i)
        const handle = sgp4Init(line1, line2)
        if (handle != null) {
          addSatellite({
            name: `Walker-${walkerConfig.totalSats}:${walkerConfig.numPlanes}/${walkerConfig.phasingFactor}-${i + 1}`,
            noradId: 90000 + i,
            line1,
            line2,
            category: walkerConfig.altitudeKm < 2000 ? 'LEO'
              : walkerConfig.altitudeKm < 35786 ? 'MEO'
              : 'GEO',
            color: walkerConfig.altitudeKm < 2000 ? CATEGORY_COLORS.LEO
              : walkerConfig.altitudeKm < 35786 ? CATEGORY_COLORS.MEO
              : CATEGORY_COLORS.GEO,
            visible: true,
          })
          added++
        }
      }
      setAddedCount(added)
    }

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
            value={walkerConfig.inclinationDeg.toFixed(1)}
            onChange={(e) =>
              setWalkerConfig({
                inclinationDeg: parseFloat(e.target.value) || 51.6,
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
            {constellation.length} satellites generated, {addedCount} added to scene
          </div>
          <div className="text-[10px] font-mono text-space-300">
            Pattern: {walkerConfig.totalSats}:{walkerConfig.numPlanes}/{walkerConfig.phasingFactor}
          </div>
        </div>
      )}
    </div>
  )
}
