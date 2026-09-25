import { useState } from 'react'
import { useAnalysisStore } from '@/store/useAnalysisStore'
import { planeChangeDv, phasingOrbit, compareTransfers, type PlaneChangeResult, type PhasingResult, type TransferComparison } from '@/orbit/analysisLoader'
import { R_EARTH } from '@/orbit/constants'

type ManeuverTab = 'hohmann' | 'planeChange' | 'phasing' | 'comparison'

const TABS: { id: ManeuverTab; label: string }[] = [
  { id: 'hohmann', label: 'Hohmann' },
  { id: 'planeChange', label: 'Plane Change' },
  { id: 'phasing', label: 'Phasing' },
  { id: 'comparison', label: 'Comparison' },
]

export function ManeuverPanel() {
  const [activeTab, setActiveTab] = useState<ManeuverTab>('hohmann')

  return (
    <div className="space-y-3">
      {/* Sub-tabs */}
      <div className="flex gap-0.5 border-b border-dust">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 px-2 py-1.5 text-[9px] font-mono transition-colors ${
              activeTab === tab.id
                ? 'text-neon-purple border-b-2 border-neon-purple'
                : 'text-comment hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'hohmann' && <HohmannTab />}
      {activeTab === 'planeChange' && <PlaneChangeTab />}
      {activeTab === 'phasing' && <PhasingTab />}
      {activeTab === 'comparison' && <ComparisonTab />}
    </div>
  )
}

function HohmannTab() {
  const alt1 = useAnalysisStore((s) => s.maneuverAlt1Km)
  const alt2 = useAnalysisStore((s) => s.maneuverAlt2Km)
  const result = useAnalysisStore((s) => s.maneuverResult)
  const setAlt1 = useAnalysisStore((s) => s.setManeuverAlt1)
  const setAlt2 = useAnalysisStore((s) => s.setManeuverAlt2)
  const compute = useAnalysisStore((s) => s.computeManeuver)

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Hohmann Transfer
      </span>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Initial Altitude (km)
        </label>
        <input
          type="number"
          min={100}
          max={100000}
          step={100}
          value={alt1}
          onChange={(e) => setAlt1(parseFloat(e.target.value) || 400)}
          className="input-field w-full"
        />
      </div>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Target Altitude (km)
        </label>
        <input
          type="number"
          min={100}
          max={100000}
          step={100}
          value={alt2}
          onChange={(e) => setAlt2(parseFloat(e.target.value) || 35786)}
          className="input-field w-full"
        />
      </div>

      <button onClick={compute} className="btn-primary w-full text-[11px] font-mono">
        Compute Transfer
      </button>

      {result && (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Results
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
            <div>
              <span className="text-comment">Burn 1:</span>
              <span className="text-neon-cyan ml-1">{result.dv1.toFixed(4)} km/s</span>
            </div>
            <div>
              <span className="text-comment">Burn 2:</span>
              <span className="text-neon-cyan ml-1">{result.dv2.toFixed(4)} km/s</span>
            </div>
            <div>
              <span className="text-comment">Total dV:</span>
              <span className="text-neon-green ml-1 font-bold">{result.dvTotal.toFixed(4)} km/s</span>
            </div>
            <div>
              <span className="text-comment">Transfer:</span>
              <span className="text-neon-purple ml-1">{(result.transferTimeS / 3600).toFixed(2)} hr</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PlaneChangeTab() {
  const [alt1, setAlt1] = useState(400)
  const [alt2, setAlt2] = useState(400)
  const [incChange, setIncChange] = useState(10)
  const [result, setResult] = useState<PlaneChangeResult | null>(null)

  const handleCompute = () => {
    const r1 = R_EARTH + alt1
    const r2 = R_EARTH + alt2
    setResult(planeChangeDv(r1, r2, incChange))
  }

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Plane Change
      </span>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Initial Alt (km)</label>
          <input type="number" min={100} step={100} value={alt1}
            onChange={(e) => setAlt1(parseFloat(e.target.value) || 400)}
            className="input-field w-full" />
        </div>
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Target Alt (km)</label>
          <input type="number" min={100} step={100} value={alt2}
            onChange={(e) => setAlt2(parseFloat(e.target.value) || 400)}
            className="input-field w-full" />
        </div>
      </div>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">Inclination Change (deg)</label>
        <input type="number" min={0} max={180} step={0.5} value={incChange}
          onChange={(e) => setIncChange(parseFloat(e.target.value) || 0)}
          className="input-field w-full" />
      </div>

      <button onClick={handleCompute} className="btn-primary w-full text-[11px] font-mono">
        Compute
      </button>

      {result && (
        <div className="space-y-2 border-t border-dust pt-2 text-[11px] font-mono">
          <div className="grid grid-cols-2 gap-2">
            <div><span className="text-comment">Hohmann dV:</span> <span className="text-neon-cyan">{result.dvHohmann.toFixed(4)} km/s</span></div>
            <div><span className="text-comment">Plane dV:</span> <span className="text-neon-orange">{result.dvPlane.toFixed(4)} km/s</span></div>
          </div>
          <div className="pt-1 border-t border-dust">
            <span className="text-comment">Combined dV:</span> <span className="text-neon-green font-bold">{result.dvCombined.toFixed(4)} km/s</span>
          </div>
          <div>
            <span className="text-comment">Transfer time:</span> <span className="text-neon-purple">{(result.transferTimeS / 3600).toFixed(2)} hr</span>
          </div>
        </div>
      )}
    </div>
  )
}

function PhasingTab() {
  const [altKm, setAltKm] = useState(400)
  const [phaseAngle, setPhaseAngle] = useState(30)
  const [periods, setPeriods] = useState(1)
  const [result, setResult] = useState<PhasingResult | null>(null)

  const handleCompute = () => {
    const r = R_EARTH + altKm
    setResult(phasingOrbit(r, phaseAngle, periods))
  }

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Phasing Orbit
      </span>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">Orbit Altitude (km)</label>
        <input type="number" min={100} step={100} value={altKm}
          onChange={(e) => setAltKm(parseFloat(e.target.value) || 400)}
          className="input-field w-full" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Phase Angle (deg)</label>
          <input type="number" min={0} max={360} step={1} value={phaseAngle}
            onChange={(e) => setPhaseAngle(parseFloat(e.target.value) || 0)}
            className="input-field w-full" />
        </div>
        <div>
          <label className="text-[10px] font-mono text-comment block mb-1">Periods to Phase</label>
          <input type="number" min={1} max={100} step={1} value={periods}
            onChange={(e) => setPeriods(parseInt(e.target.value) || 1)}
            className="input-field w-full" />
        </div>
      </div>

      <button onClick={handleCompute} className="btn-primary w-full text-[11px] font-mono">
        Compute
      </button>

      {result && (
        <div className="space-y-2 border-t border-dust pt-2 text-[11px] font-mono">
          <div><span className="text-comment">Phasing period:</span> <span className="text-neon-cyan">{(result.phasingPeriod / 60).toFixed(1)} min</span></div>
          <div><span className="text-comment">Revolutions:</span> <span className="text-neon-purple">{result.numRevolutions}</span></div>
          <div><span className="text-comment">Total time:</span> <span className="text-neon-cyan">{(result.transferTimeS / 3600).toFixed(2)} hr</span></div>
          <div><span className="text-comment">Delta-V:</span> <span className="text-neon-green font-bold">{result.dv.toFixed(4)} km/s</span></div>
        </div>
      )}
    </div>
  )
}

function ComparisonTab() {
  const alt1 = useAnalysisStore((s) => s.maneuverAlt1Km)
  const alt2 = useAnalysisStore((s) => s.maneuverAlt2Km)
  const [rInter, setRInter] = useState(42164) // GEO radius
  const [result, setResult] = useState<TransferComparison | null>(null)

  const handleCompute = () => {
    const r1 = R_EARTH + alt1
    const r2 = R_EARTH + alt2
    setResult(compareTransfers(r1, r2, rInter))
  }

  return (
    <div className="space-y-3">
      <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
        Hohmann vs Bi-Elliptic
      </span>

      <div className="text-[10px] font-mono text-comment">
        Uses altitudes from the Hohmann tab: {alt1} km / {alt2} km
      </div>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">Intermediate Radius (km)</label>
        <input type="number" min={7000} step={100} value={rInter}
          onChange={(e) => setRInter(parseFloat(e.target.value) || 42164)}
          className="input-field w-full" />
      </div>

      <button onClick={handleCompute} className="btn-primary w-full text-[11px] font-mono">
        Compare
      </button>

      {result && (
        <div className="space-y-2 border-t border-dust pt-2 text-[11px] font-mono">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-black/30 p-2 rounded">
              <div className="text-comment text-[9px] mb-1">HOHMANN</div>
              <div><span className="text-comment">dV:</span> <span className="text-neon-cyan">{result.hohmann.dvTotal.toFixed(4)} km/s</span></div>
              <div><span className="text-comment">Time:</span> <span className="text-neon-purple">{(result.hohmann.transferTimeS / 3600).toFixed(2)} hr</span></div>
            </div>
            <div className="bg-black/30 p-2 rounded">
              <div className="text-comment text-[9px] mb-1">BI-ELLIPTIC</div>
              {result.bielliptic ? (
                <>
                  <div><span className="text-comment">dV:</span> <span className="text-neon-cyan">{result.bielliptic.dvTotal.toFixed(4)} km/s</span></div>
                  <div><span className="text-comment">Time:</span> <span className="text-neon-purple">{(result.bielliptic.transferTimeS / 3600).toFixed(2)} hr</span></div>
                </>
              ) : (
                <div className="text-neon-orange">WASM required</div>
              )}
            </div>
          </div>
          <div className="pt-1 border-t border-dust text-center">
            <span className={result.hohmannBetter ? 'text-neon-green' : 'text-neon-orange'}>
              {result.hohmannBetter ? 'Hohmann is more efficient' : 'Bi-elliptic is more efficient'}
            </span>
            <span className="text-comment ml-2">(breakeven ratio: ~11.94)</span>
          </div>
        </div>
      )}
    </div>
  )
}
