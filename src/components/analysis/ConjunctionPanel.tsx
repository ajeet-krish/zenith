import { useState, useCallback } from 'react'
import { useMissionStore } from '@/store/useMissionStore'
import { sgp4Propagate } from '@/orbit/wasmLoader'

interface ConjunctionEvent {
  sat1Name: string
  sat2Name: string
  missDistanceKm: number
  riskLevel: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW'
}

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
  const [events, setEvents] = useState<ConjunctionEvent[]>([])
  const [screening, setScreening] = useState(false)
  const [threshold, setThreshold] = useState(100)

  const runScreening = useCallback(() => {
    if (satellites.length < 2) return
    setScreening(true)

    // Yield to React so "Screening..." renders before blocking computation
    requestAnimationFrame(() => {
      const found: ConjunctionEvent[] = []
      const visibleSats = satellites.filter((s) => s.visible && s.handle != null)

      for (let i = 0; i < visibleSats.length; i++) {
        for (let j = i + 1; j < visibleSats.length; j++) {
          const s1 = visibleSats[i]!
          const s2 = visibleSats[j]!

          // Compare positions at current epoch
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
              missDistanceKm: missKm,
              riskLevel: getRiskLevel(missKm),
            })
          }
        }
      }

      // Sort by miss distance
      found.sort((a, b) => a.missDistanceKm - b.missDistanceKm)
      setEvents(found)
      setScreening(false)
    })
  }, [satellites, currentEpoch, threshold])

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Conjunction Screening
      </span>

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

      <button
        onClick={runScreening}
        disabled={satellites.length < 2 || screening}
        className="btn-primary w-full text-[11px] font-mono disabled:opacity-40"
      >
        {screening ? 'Screening...' : 'Run Screening'}
      </button>

      {events.length > 0 && (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment">
            {events.length} event{events.length !== 1 ? 's' : ''} found
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {events.map((evt, i) => (
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
              </div>
            ))}
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
