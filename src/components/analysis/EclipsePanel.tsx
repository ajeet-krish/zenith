import { useState } from 'react'
import { useMissionStore } from '@/store/useMissionStore'
import { computeEclipse, type EclipseResult } from '@/orbit/eclipse'

function jdToUtc(jd: number): string {
  const date = new Date((jd - 2440587.5) * 86400000)
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

function formatDuration(seconds: number): string {
  const min = Math.floor(seconds / 60)
  const sec = Math.floor(seconds % 60)
  return `${min}m ${sec}s`
}

export function EclipsePanel() {
  const satellites = useMissionStore((s) => s.satellites)
  const selectedSatelliteId = useMissionStore((s) => s.selectedSatelliteId)
  const currentEpoch = useMissionStore((s) => s.currentEpoch)

  const [durationDays, setDurationDays] = useState(1)
  const [result, setResult] = useState<EclipseResult | null>(null)
  const [computing, setComputing] = useState(false)

  const selectedSat = satellites.find((s) => s.id === selectedSatelliteId)

  const handleCompute = () => {
    if (!selectedSat || selectedSat.handle === null) return
    setComputing(true)

    setTimeout(() => {
      const eclipseResult = computeEclipse(
        selectedSat.handle!,
        currentEpoch,
        durationDays,
        60
      )
      setResult(eclipseResult)
      setComputing(false)
    })
  }

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Eclipse / Shadow
      </span>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Duration (days)
        </label>
        <input
          type="number"
          min={0.1}
          max={30}
          step={0.5}
          value={durationDays}
          onChange={(e) => setDurationDays(parseFloat(e.target.value) || 1)}
          className="input-field w-full"
        />
      </div>

      <button
        onClick={handleCompute}
        disabled={!selectedSat || computing}
        className="btn-primary w-full text-[11px] font-mono disabled:opacity-40"
      >
        {computing ? 'Computing...' : 'Compute Eclipse'}
      </button>

      {!selectedSat && (
        <div className="text-[10px] font-mono text-neon-orange">
          Select a satellite first
        </div>
      )}

      {result && (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment">
            {result.events.length} eclipse{result.events.length !== 1 ? 's' : ''} found
          </div>

          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
            <div>
              <span className="text-comment">Avg duration:</span>
              <span className="text-neon-cyan ml-1">{formatDuration(result.avgDurationS)}</span>
            </div>
            <div>
              <span className="text-comment">Max:</span>
              <span className="text-neon-cyan ml-1">{formatDuration(result.maxDurationS)}</span>
            </div>
            <div>
              <span className="text-comment">Min:</span>
              <span className="text-neon-cyan ml-1">{formatDuration(result.minDurationS)}</span>
            </div>
            <div>
              <span className="text-comment">Fraction:</span>
              <span className="text-neon-purple ml-1">{(result.eclipseFraction * 100).toFixed(1)}%</span>
            </div>
          </div>

          {result.events.length > 0 && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {result.events.slice(0, 20).map((evt, i) => (
                <div key={i} className="bg-black/30 p-2 text-[9px] font-mono flex items-center justify-between">
                  <span className="text-comment">{jdToUtc(evt.entryJd)}</span>
                  <span className="text-neon-orange mx-1">-</span>
                  <span className="text-comment">{jdToUtc(evt.exitJd)}</span>
                  <span className="text-neon-cyan ml-2">{formatDuration(evt.durationS)}</span>
                </div>
              ))}
              {result.events.length > 20 && (
                <div className="text-[9px] font-mono text-comment text-center py-1">
                  +{result.events.length - 20} more
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
