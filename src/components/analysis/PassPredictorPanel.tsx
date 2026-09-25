import { useState } from 'react'
import { useMissionStore } from '@/store/useMissionStore'
import { predictPasses } from '@/orbit/wasmLoader'
import { sgp4Propagate } from '@/orbit/wasmLoader'
import { jdToUtc } from '@/utils/timeFormat'

interface PassInfo {
  start_jd: number
  end_jd: number
  max_elevation_rad: number
  duration_s: number
  min_range_km: number
}

export function PassPredictorPanel() {
  const satellites = useMissionStore((s) => s.satellites)
  const selectedSatelliteId = useMissionStore((s) => s.selectedSatelliteId)
  const currentEpoch = useMissionStore((s) => s.currentEpoch)
  const wasmReady = useMissionStore((s) => s.wasmReady)

  const [stationLat, setStationLat] = useState(35.6812) // Tokyo
  const [stationLon, setStationLon] = useState(139.7671)
  const [stationAlt, setStationAlt] = useState(0.0)
  const [elevMask, setElevMask] = useState(5.0)
  const [durationDays, setDurationDays] = useState(1)
  const [passes, setPasses] = useState<PassInfo[] | null>(null)
  const [predicting, setPredicting] = useState(false)

  const selectedSat = satellites.find((s) => s.id === selectedSatelliteId)

  const handlePredict = () => {
    if (!selectedSat || selectedSat.handle === null) return
    setPredicting(true)

    // Build trajectory over the duration
    const timeStepS = 60
    const totalSeconds = durationDays * 86400
    const nSteps = Math.ceil(totalSeconds / timeStepS)
    const flatTrajectory: number[] = []

    for (let i = 0; i <= nSteps; i++) {
      const tSec = i * timeStepS
      const jd = currentEpoch + tSec / 86400
      const sv = sgp4Propagate(selectedSat.handle, jd)
      if (sv) {
        flatTrajectory.push(sv.x, sv.y, sv.z, sv.vx, sv.vy, sv.vz, jd)
      }
    }

    if (flatTrajectory.length === 0) {
      setPasses([])
      setPredicting(false)
      return
    }

    const result = predictPasses(
      flatTrajectory,
      stationLat * Math.PI / 180,
      stationLon * Math.PI / 180,
      stationAlt,
      elevMask * Math.PI / 180
    )

    setPasses(result ?? [])
    setPredicting(false)
  }

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Pass Predictor
      </span>

      {/* Ground station coordinates */}
      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Ground Station
        </label>
        <div className="grid grid-cols-2 gap-1">
          <input
            type="number"
            step={0.001}
            value={stationLat}
            onChange={(e) => setStationLat(parseFloat(e.target.value) || 0)}
            className="input-field w-full text-[10px]"
            placeholder="Lat (deg)"
          />
          <input
            type="number"
            step={0.001}
            value={stationLon}
            onChange={(e) => setStationLon(parseFloat(e.target.value) || 0)}
            className="input-field w-full text-[10px]"
            placeholder="Lon (deg)"
          />
        </div>
        <div className="grid grid-cols-2 gap-1 mt-1">
          <input
            type="number"
            step={0.1}
            value={stationAlt}
            onChange={(e) => setStationAlt(parseFloat(e.target.value) || 0)}
            className="input-field w-full text-[10px]"
            placeholder="Alt (km)"
          />
          <input
            type="number"
            min={0}
            max={45}
            step={0.5}
            value={elevMask}
            onChange={(e) => setElevMask(parseFloat(e.target.value) || 5)}
            className="input-field w-full text-[10px]"
            placeholder="Elev mask (deg)"
          />
        </div>
      </div>

      {/* Duration */}
      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Prediction Window (days)
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
        onClick={handlePredict}
        disabled={!selectedSat || predicting || !wasmReady}
        className="btn-primary w-full text-[11px] font-mono disabled:opacity-40"
      >
        {predicting ? 'Predicting...' : 'Predict Passes'}
      </button>

      {!wasmReady && (
        <div className="text-[10px] font-mono text-neon-orange">
          Requires WASM
        </div>
      )}

      {!selectedSat && (
        <div className="text-[10px] font-mono text-neon-orange">
          Select a satellite first
        </div>
      )}

      {passes && passes.length > 0 && (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment">
            {passes.length} pass{passes.length !== 1 ? 'es' : ''} found
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {passes.map((pass, i) => (
              <div key={i} className="bg-black/30 p-2 text-[9px] font-mono space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-neon-green">
                    MAX ELEV: {(pass.max_elevation_rad * 180 / Math.PI).toFixed(1)} deg
                  </span>
                  <span className="text-comment">
                    {pass.duration_s.toFixed(0)}s
                  </span>
                </div>
                <div className="text-space-300">
                  {jdToUtc(pass.start_jd)} - {jdToUtc(pass.end_jd)}
                </div>
                <div className="text-comment">
                  Min range: {pass.min_range_km.toFixed(0)} km
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {passes && passes.length === 0 && (
        <div className="text-[10px] font-mono text-comment border-t border-dust pt-2">
          No passes found in prediction window
        </div>
      )}
    </div>
  )
}
