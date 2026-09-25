import { useState, useCallback, useRef, useEffect } from 'react'
import { useMissionStore } from '@/store/useMissionStore'
import { useAnalysisStore } from '@/store/useAnalysisStore'
import { sgp4Propagate, screenConjunctions } from '@/orbit/wasmLoader'
import type { ConjunctionEvent } from '@/orbit/types'
import { jdToUtc } from '@/utils/timeFormat'

const RISK_COLORS: Record<string, string> = {
  CRITICAL: 'text-red-500 bg-red-500/10',
  HIGH: 'text-neon-orange bg-neon-orange/10',
  MODERATE: 'text-neon-yellow bg-neon-yellow/10',
  LOW: 'text-neon-green bg-neon-green/10',
}

function getRiskLevel(missKm: number): 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' {
  if (missKm < 1) return 'CRITICAL'
  if (missKm < 5) return 'HIGH'
  if (missKm < 25) return 'MODERATE'
  return 'LOW'
}

export function ConjunctionPanel() {
  const satellites = useMissionStore((s) => s.satellites)
  const currentEpoch = useMissionStore((s) => s.currentEpoch)
  const wasmReady = useMissionStore((s) => s.wasmReady)
  const conjunctionEvents = useAnalysisStore((s) => s.conjunctionEvents)
  const setConjunctionEvents = useAnalysisStore((s) => s.setConjunctionEvents)
  const showConjunctionMarkers = useAnalysisStore((s) => s.showConjunctionMarkers)
  const toggleConjunctionMarkers = useAnalysisStore((s) => s.toggleConjunctionMarkers)
  const [screening, setScreening] = useState(false)
  const [threshold, setThreshold] = useState(100)
  const [mode, setMode] = useState<'single' | 'window'>('single')
  const [windowDays, setWindowDays] = useState(1)
  const [timeStepS, setTimeStepS] = useState(60)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => { mountedRef.current = false }
  }, [])

  /**
   * Single-epoch screening (original behavior).
   */
  const runSingleEpochScreening = useCallback(() => {
    if (satellites.length < 2) return
    setScreening(true)

    setTimeout(() => {
      const found: ConjunctionEvent[] = []
      const visibleSats = satellites.filter((s) => s.visible && s.handle != null)

      for (let i = 0; i < visibleSats.length; i++) {
        for (let j = i + 1; j < visibleSats.length; j++) {
          const s1 = visibleSats[i]!
          const s2 = visibleSats[j]!

          const p1 = sgp4Propagate(s1.handle!, currentEpoch)
          const p2 = sgp4Propagate(s2.handle!, currentEpoch)
          if (!p1 || !p2) continue

          const dx = p1.x - p2.x
          const dy = p1.y - p2.y
          const dz = p1.z - p2.z
          const missKm = Math.sqrt(dx * dx + dy * dy + dz * dz)

          if (missKm < threshold) {
            found.push({
              sat1Name: s1.name,
              sat2Name: s2.name,
              sat1Id: s1.id,
              sat2Id: s2.id,
              missDistanceKm: missKm,
              riskLevel: getRiskLevel(missKm),
              position1: { x: p1.x, y: p1.y, z: p1.z },
              position2: { x: p2.x, y: p2.y, z: p2.z },
            })
          }
        }
      }

      found.sort((a, b) => a.missDistanceKm - b.missDistanceKm)
      if (mountedRef.current) {
        setConjunctionEvents(found)
        setScreening(false)
      }
    })
  }, [satellites, currentEpoch, threshold, setConjunctionEvents])

  /**
   * Time-window screening using WASM screen_conjunctions.
   */
  const runWindowScreening = useCallback(() => {
    if (satellites.length < 2) return
    setScreening(true)

    setTimeout(() => {
      const visibleSats = satellites.filter((s) => s.visible && s.handle != null)
      if (visibleSats.length < 2) {
        if (mountedRef.current) setScreening(false)
        return
      }

      // Build trajectories for all satellites over the time window
      const totalSeconds = windowDays * 86400
      const nSteps = Math.ceil(totalSeconds / timeStepS)
      const catalog: number[][] = []

      for (const sat of visibleSats) {
        const flatTrajectory: number[] = []
        for (let i = 0; i <= nSteps; i++) {
          const tSec = i * timeStepS
          const jd = currentEpoch + tSec / 86400
          const sv = sgp4Propagate(sat.handle!, jd)
          if (sv) {
            flatTrajectory.push(sv.x, sv.y, sv.z, sv.vx, sv.vy, sv.vz, jd)
          }
        }
        catalog.push(flatTrajectory)
      }

      // Use WASM screen_conjunctions
      const wasmEvents = screenConjunctions(catalog, threshold)

      if (wasmEvents) {
        const found: ConjunctionEvent[] = wasmEvents.map((evt: any) => {
          const s1 = visibleSats[evt.sat_id_1]
          const s2 = visibleSats[evt.sat_id_2]
          return {
            sat1Name: s1?.name ?? `Sat ${evt.sat_id_1}`,
            sat2Name: s2?.name ?? `Sat ${evt.sat_id_2}`,
            sat1Id: s1?.id ?? '',
            sat2Id: s2?.id ?? '',
            missDistanceKm: evt.miss_distance_km,
            riskLevel: getRiskLevel(evt.miss_distance_km),
            tcaJd: evt.tca_jd,
            position1: { x: 0, y: 0, z: 0 },
            position2: { x: 0, y: 0, z: 0 },
          }
        })
        found.sort((a, b) => a.missDistanceKm - b.missDistanceKm)
        if (mountedRef.current) {
          setConjunctionEvents(found)
        }
      }

      if (mountedRef.current) setScreening(false)
    })
  }, [satellites, currentEpoch, threshold, windowDays, timeStepS, setConjunctionEvents])

  const handleRun = mode === 'single' ? runSingleEpochScreening : runWindowScreening

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div className="flex gap-1">
        <button
          onClick={() => setMode('single')}
          className={`flex-1 px-2 py-1 rounded text-[10px] font-mono transition-colors ${
            mode === 'single'
              ? 'bg-neon-purple/20 text-neon-purple border border-neon-purple/30'
              : 'bg-white/5 text-comment hover:text-white hover:bg-white/10 border border-transparent'
          }`}
        >
          Single Epoch
        </button>
        <button
          onClick={() => setMode('window')}
          disabled={!wasmReady}
          title={!wasmReady ? 'Requires WASM' : undefined}
          className={`flex-1 px-2 py-1 rounded text-[10px] font-mono transition-colors ${
            mode === 'window'
              ? 'bg-neon-purple/20 text-neon-purple border border-neon-purple/30'
              : 'bg-white/5 text-comment hover:text-white hover:bg-white/10 border border-transparent'
          }`}
        >
          Time Window
        </button>
      </div>

      {/* Threshold */}
      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Threshold (km)
        </label>
        <input
          type="number"
          min={1}
          max={1000}
          step={10}
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value) || 100)}
          className="input-field w-full"
        />
      </div>

      {/* Time window settings */}
      {mode === 'window' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-mono text-comment block mb-1">
              Duration (days)
            </label>
            <input
              type="number"
              min={0.1}
              max={30}
              step={0.5}
              value={windowDays}
              onChange={(e) => setWindowDays(parseFloat(e.target.value) || 1)}
              className="input-field w-full"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono text-comment block mb-1">
              Time Step (s)
            </label>
            <input
              type="number"
              min={10}
              max={3600}
              step={10}
              value={timeStepS}
              onChange={(e) => setTimeStepS(parseFloat(e.target.value) || 60)}
              className="input-field w-full"
            />
          </div>
        </div>
      )}

      {!wasmReady && mode === 'window' && (
        <div className="text-[10px] font-mono text-neon-orange">
          Requires WASM for time-window screening
        </div>
      )}

      <button
        onClick={handleRun}
        disabled={satellites.length < 2 || screening || (mode === 'window' && !wasmReady)}
        className="btn-primary w-full text-[11px] font-mono disabled:opacity-40"
      >
        {screening ? 'Screening...' : mode === 'single' ? 'Run Screening' : 'Run Window Screening'}
      </button>

      {conjunctionEvents.length > 0 && (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment">
            {conjunctionEvents.length} event{conjunctionEvents.length !== 1 ? 's' : ''} found
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {conjunctionEvents.map((evt, i) => (
              <div key={i} className="bg-black/30 p-2 text-[10px] font-mono space-y-1">
                <div className="flex items-center gap-2">
                  <span className={`px-1 py-0.5 ${RISK_COLORS[evt.riskLevel]}`}>
                    {evt.riskLevel}
                  </span>
                  <span className="text-comment">{evt.missDistanceKm.toFixed(1)} km</span>
                </div>
                <div className="text-space-300">
                  {evt.sat1Name} / {evt.sat2Name}
                </div>
                {evt.tcaJd != null && (
                  <div className="text-comment">
                    TCA: {jdToUtc(evt.tcaJd)}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-dust pt-2">
            <span className="text-[10px] font-mono text-comment">3D Markers</span>
            <button
              onClick={toggleConjunctionMarkers}
              className={`px-2 py-0.5 text-[10px] font-mono ${
                showConjunctionMarkers
                  ? 'bg-neon-red/20 text-neon-red'
                  : 'bg-white/5 text-comment'
              }`}
            >
              {showConjunctionMarkers ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      )}

      {satellites.length < 2 && (
        <div className="text-[10px] font-mono text-neon-orange">
          Need at least 2 satellites
        </div>
      )}
    </div>
  )
}
