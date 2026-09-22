import { useState } from 'react'
import { useAnalysisStore } from '@/store/useAnalysisStore'
import { useMissionStore } from '@/store/useMissionStore'
import { mcPropagate } from '@/orbit/analysisLoader'

export function MonteCarloPanel() {
  const selectedSatelliteId = useMissionStore((s) => s.selectedSatelliteId)
  const satellites = useMissionStore((s) => s.satellites)
  const currentEpoch = useMissionStore((s) => s.currentEpoch)
  const mcResult = useAnalysisStore((s) => s.mcResult)
  const showMcCloud = useAnalysisStore((s) => s.showMcCloud)
  const showMcEllipsoid = useAnalysisStore((s) => s.showMcEllipsoid)
  const toggleMcCloud = useAnalysisStore((s) => s.toggleMcCloud)
  const toggleMcEllipsoid = useAnalysisStore((s) => s.toggleMcEllipsoid)

  const [nSamples, setNSamples] = useState(1000)
  const [posSigma, setPosSigma] = useState(0.1)
  const [velSigma, setVelSigma] = useState(0.001)
  const [durationDays, setDurationDays] = useState(1)
  const [seed, setSeed] = useState(42)
  const [running, setRunning] = useState(false)

  const selectedSat = satellites.find((s) => s.id === selectedSatelliteId)

  const handleRun = async () => {
    if (!selectedSat?.handle) return
    setRunning(true)

    const { sgp4Propagate } = await import('@/orbit/wasmLoader')
    const initState = sgp4Propagate(selectedSat.handle, currentEpoch)
    if (!initState) {
      setRunning(false)
      return
    }

    const result = mcPropagate(
      initState.x, initState.y, initState.z,
      initState.vx, initState.vy, initState.vz,
      currentEpoch,
      { nSamples, endTimeDays: durationDays, positionStddevKm: posSigma, velocityStddevKmS: velSigma, seed }
    )

    if (result) {
      // Map analysisLoader MonteCarloResult to store's MonteCarloResult type
      useAnalysisStore.setState({
        mcResult: {
          meanState: {
            position: { x: result.mean.x, y: result.mean.y, z: result.mean.z },
            velocity: { x: result.mean.vx, y: result.mean.vy, z: result.mean.vz },
            epoch: currentEpoch,
          },
          positionStddev: [
            result.positionStddev[0] ?? 0,
            result.positionStddev[1] ?? 0,
            result.positionStddev[2] ?? 0,
          ],
          velocityStddev: [
            result.velocityStddev[0] ?? 0,
            result.velocityStddev[1] ?? 0,
            result.velocityStddev[2] ?? 0,
          ],
          samples: result.samples,
        },
      })
    }
    setRunning(false)
  }

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Monte Carlo Propagation
      </span>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">Samples</label>
        <input
          type="number"
          min={100}
          max={5000}
          step={100}
          value={nSamples}
          onChange={(e) => setNSamples(Math.min(5000, Math.max(100, parseInt(e.target.value) || 1000)))}
          className="input-field w-full"
        />
        {nSamples > 2000 && (
          <div className="text-[9px] font-mono text-neon-orange mt-1">
            Large sample counts may briefly freeze the UI
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Pos sigma (km)</label>
          <input
            type="number"
            min={0.001}
            max={10}
            step={0.01}
            value={posSigma}
            onChange={(e) => setPosSigma(parseFloat(e.target.value) || 0.1)}
            className="input-field w-full"
          />
        </div>
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Vel sigma (km/s)</label>
          <input
            type="number"
            min={0.0001}
            max={0.1}
            step={0.001}
            value={velSigma}
            onChange={(e) => setVelSigma(parseFloat(e.target.value) || 0.001)}
            className="input-field w-full"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Duration (days)</label>
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
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Seed</label>
          <input
            type="number"
            min={1}
            value={seed}
            onChange={(e) => setSeed(parseInt(e.target.value) || 42)}
            className="input-field w-full"
          />
        </div>
      </div>

      <button
        onClick={handleRun}
        disabled={!selectedSat || running}
        className="btn-primary w-full text-[11px] font-mono disabled:opacity-40"
      >
        {running ? 'Running...' : 'Run Monte Carlo'}
      </button>

      {mcResult && (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Results ({mcResult.samples.length} samples)
          </div>
          <div className="grid grid-cols-2 gap-1 text-[10px] font-mono">
            <div>
              <span className="text-comment">Pos sigma:</span>
              <span className="text-neon-cyan ml-1">
                ({mcResult.positionStddev.map((s) => s.toFixed(3)).join(', ')}) km
              </span>
            </div>
            <div>
              <span className="text-comment">Vel sigma:</span>
              <span className="text-neon-purple ml-1">
                ({mcResult.velocityStddev.map((s) => s.toFixed(6)).join(', ')}) km/s
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={toggleMcCloud}
              className={`px-2 py-0.5 text-[10px] font-mono ${
                showMcCloud ? 'bg-neon-green/20 text-neon-green' : 'bg-white/5 text-comment'
              }`}
            >
              Cloud {showMcCloud ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={toggleMcEllipsoid}
              className={`px-2 py-0.5 text-[10px] font-mono ${
                showMcEllipsoid ? 'bg-neon-purple/20 text-neon-purple' : 'bg-white/5 text-comment'
              }`}
            >
              Ellipsoid {showMcEllipsoid ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      )}

      {!selectedSat && (
        <div className="text-[10px] font-mono text-neon-orange">
          Select a satellite first
        </div>
      )}
    </div>
  )
}
