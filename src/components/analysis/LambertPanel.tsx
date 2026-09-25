import { useState } from 'react'
import { lambertSolveWasm } from '@/orbit/wasmLoader'
import { MU_EARTH } from '@/orbit/constants'

interface LambertResult {
  v1: [number, number, number]
  v2: [number, number, number]
  converged: boolean
}

export function LambertPanel() {
  const [r1, setR1] = useState<[string, string, string]>(['6778', '0', '0'])
  const [r2, setR2] = useState<[string, string, string]>(['0', '0', '35786'])
  const [tof, setTof] = useState(21600) // 6 hours default
  const [result, setResult] = useState<LambertResult | null>(null)
  const [solving, setSolving] = useState(false)

  const handleSolve = () => {
    setSolving(true)
    const r1Vec: [number, number, number] = [
      parseFloat(r1[0]) || 0,
      parseFloat(r1[1]) || 0,
      parseFloat(r1[2]) || 0,
    ]
    const r2Vec: [number, number, number] = [
      parseFloat(r2[0]) || 0,
      parseFloat(r2[1]) || 0,
      parseFloat(r2[2]) || 0,
    ]

    const wasmResult = lambertSolveWasm(r1Vec, r2Vec, tof, MU_EARTH)
    if (wasmResult) {
      setResult({
        v1: [wasmResult.v1x, wasmResult.v1y, wasmResult.v1z],
        v2: [wasmResult.v2x, wasmResult.v2y, wasmResult.v2z],
        converged: wasmResult.converged,
      })
    }
    setSolving(false)
  }

  const dv1 = result ? Math.sqrt(result.v1[0] ** 2 + result.v1[1] ** 2 + result.v1[2] ** 2) : 0
  const dv2 = result ? Math.sqrt(result.v2[0] ** 2 + result.v2[1] ** 2 + result.v2[2] ** 2) : 0

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Lambert Solver
      </span>

      {/* Departure position */}
      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Departure Position (km, TEME)
        </label>
        <div className="grid grid-cols-3 gap-1">
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <input
              key={axis}
              type="number"
              value={r1[i]}
              onChange={(e) => {
                const newR1 = [...r1] as [string, string, string]
                newR1[i] = e.target.value
                setR1(newR1)
              }}
              className="input-field w-full text-[10px]"
              placeholder={axis}
            />
          ))}
        </div>
      </div>

      {/* Arrival position */}
      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Arrival Position (km, TEME)
        </label>
        <div className="grid grid-cols-3 gap-1">
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <input
              key={axis}
              type="number"
              value={r2[i]}
              onChange={(e) => {
                const newR2 = [...r2] as [string, string, string]
                newR2[i] = e.target.value
                setR2(newR2)
              }}
              className="input-field w-full text-[10px]"
              placeholder={axis}
            />
          ))}
        </div>
      </div>

      {/* Time of flight */}
      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Time of Flight (seconds)
        </label>
        <input
          type="number"
          min={60}
          max={86400 * 30}
          step={60}
          value={tof}
          onChange={(e) => setTof(parseFloat(e.target.value) || 21600)}
          className="input-field w-full"
        />
        <div className="text-[9px] font-mono text-comment mt-0.5">
          {(tof / 3600).toFixed(1)} hours
        </div>
      </div>

      <button
        onClick={handleSolve}
        disabled={solving}
        className="btn-primary w-full text-[11px] font-mono disabled:opacity-40"
      >
        {solving ? 'Solving...' : 'Solve Lambert'}
      </button>

      {result && (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-mono px-1.5 py-0.5 ${
              result.converged ? 'text-neon-green bg-neon-green/10' : 'text-neon-red bg-neon-red/10'
            }`}>
              {result.converged ? 'CONVERGED' : 'FAILED'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
            <div>
              <span className="text-comment">Departure |v|:</span>
              <span className="text-neon-cyan ml-1">{dv1.toFixed(4)} km/s</span>
            </div>
            <div>
              <span className="text-comment">Arrival |v|:</span>
              <span className="text-neon-cyan ml-1">{dv2.toFixed(4)} km/s</span>
            </div>
          </div>

          <div className="text-[9px] font-mono text-comment space-y-0.5">
            <div>v1: ({result.v1.map((v) => v.toFixed(3)).join(', ')}) km/s</div>
            <div>v2: ({result.v2.map((v) => v.toFixed(3)).join(', ')}) km/s</div>
          </div>
        </div>
      )}
    </div>
  )
}
