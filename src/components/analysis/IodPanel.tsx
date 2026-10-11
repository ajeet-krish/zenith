import { useState } from 'react'
import { useODStore } from '@/store/useODStore'
import { useMissionStore } from '@/store/useMissionStore'
import { sgp4Propagate, getWasmModule } from '@/orbit/wasmLoader'
import { predictObservation } from '@/orbit/observations'
import { stationPositionEci, lla_to_ecef_ts, jd_to_gmst_ts } from '@/orbit/stations'
import { GOLDSTONE, ARECIBO, TROMSOE, type CanonicalStation } from '@/orbit/odConstants'
import { MU_EARTH, DEG_TO_RAD, RAD_TO_DEG } from '@/orbit/constants'
import { GAUSS_IOD_STATUS } from '@/orbit/types'
import type { GaussIodObservation, GaussIodTsResult } from '@/orbit/types'
import { jdToUtc, jdToDatetimeLocal, datetimeLocalToJd } from '@/utils/timeFormat'

// =============================================================================
// Types and helpers
// =============================================================================

/** One observation input row (kept as strings so fields can be empty/partial). */
interface ObsRow {
  epoch: string
  raDeg: string
  decDeg: string
  stationId: string
}

type IodTab = 'input' | 'results'

const TABS: { id: IodTab; label: string }[] = [
  { id: 'input', label: 'Input' },
  { id: 'results', label: 'Results' },
]

const QUICK_ADD: CanonicalStation[] = [GOLDSTONE, ARECIBO, TROMSOE]

const QUICK_ADD_LABELS: Record<string, string> = {
  goldstone: 'Goldstone',
  arecibo: 'Arecibo',
  tromsoe: 'Tromsoe',
}

/** A row is valid when epoch parses, RA is in [0, 360], Dec in [-90, 90], and a station is chosen. */
function isRowValid(row: ObsRow): boolean {
  if (datetimeLocalToJd(row.epoch) == null) return false
  if (row.stationId === '') return false
  const ra = Number(row.raDeg)
  const dec = Number(row.decDeg)
  return (
    row.raDeg !== '' &&
    row.decDeg !== '' &&
    Number.isFinite(ra) &&
    ra >= 0 &&
    ra <= 360 &&
    Number.isFinite(dec) &&
    dec >= -90 &&
    dec <= 90
  )
}

/** Topocentric RA/Dec [rad] of an ECI target from an ECI observer position. */
function topocentricRaDec(
  r_target: { x: number; y: number; z: number },
  r_observer: { x: number; y: number; z: number }
): { raRad: number; decRad: number } {
  const dx = r_target.x - r_observer.x
  const dy = r_target.y - r_observer.y
  const dz = r_target.z - r_observer.z
  const range = Math.hypot(dx, dy, dz)
  let raRad = Math.atan2(dy, dx)
  if (raRad < 0) raRad += 2 * Math.PI
  const decRad = Math.asin(Math.max(-1, Math.min(1, dz / (range || 1))))
  return { raRad, decRad }
}

/** Station ECI position from geodetic LLA via GMST rotation (TS fallback path). */
function stationPosEciFallback(
  latRad: number,
  lonRad: number,
  altKm: number,
  jd: number
): { x: number; y: number; z: number } {
  const [ex, ey, ez] = lla_to_ecef_ts(latRad, lonRad, altKm)
  const gmst = jd_to_gmst_ts(jd)
  const c = Math.cos(gmst)
  const s = Math.sin(gmst)
  return { x: ex * c - ey * s, y: ex * s + ey * c, z: ez }
}

/** Two-body orbital elements derived from an ECI state (display only). */
function deriveElements(
  r: [number, number, number],
  v: [number, number, number]
): { aKm: number; e: number; iDeg: number } | null {
  const rMag = Math.hypot(r[0], r[1], r[2])
  const vMag = Math.hypot(v[0], v[1], v[2])
  if (rMag < 1e-6 || vMag < 1e-12) return null
  const energy = (vMag * vMag) / 2 - MU_EARTH / rMag
  if (!Number.isFinite(energy) || energy === 0) return null
  const aKm = -MU_EARTH / (2 * energy)
  const hx = r[1] * v[2] - r[2] * v[1]
  const hy = r[2] * v[0] - r[0] * v[2]
  const hz = r[0] * v[1] - r[1] * v[0]
  const hMag = Math.hypot(hx, hy, hz)
  if (hMag < 1e-9) return null
  const rvDot = r[0] * v[0] + r[1] * v[1] + r[2] * v[2]
  const v2MinusMuR = vMag * vMag - MU_EARTH / rMag
  const ex = (v2MinusMuR * r[0] - rvDot * v[0]) / MU_EARTH
  const ey = (v2MinusMuR * r[1] - rvDot * v[1]) / MU_EARTH
  const ez = (v2MinusMuR * r[2] - rvDot * v[2]) / MU_EARTH
  const e = Math.hypot(ex, ey, ez)
  const cosI = Math.max(-1, Math.min(1, hz / hMag))
  const iDeg = Math.acos(cosI) * RAD_TO_DEG
  return { aKm, e, iDeg }
}

/** Status badge label + classes for a Gauss IOD status code. */
function statusBadge(status: number): { label: string; className: string } {
  if (status === GAUSS_IOD_STATUS.OK) {
    return { label: 'OK', className: 'bg-neon-green/20 text-neon-green' }
  }
  if (status === GAUSS_IOD_STATUS.WARNING_ILL_CONDITIONED) {
    return { label: 'WARNING', className: 'bg-neon-yellow/20 text-neon-yellow' }
  }
  return { label: 'ERROR', className: 'bg-neon-red/20 text-neon-red' }
}

// =============================================================================
// Panel
// =============================================================================

export function IodPanel() {
  const [activeTab, setActiveTab] = useState<IodTab>('input')
  const [resultEpochJd, setResultEpochJd] = useState<number | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  // Local observation rows; epochs default to mission time +10/+20 min.
  const [rows, setRows] = useState<ObsRow[]>(() => {
    const jd = useMissionStore.getState().currentEpoch
    return [0, 10, 20].map((minutes) => ({
      epoch: jdToDatetimeLocal(jd + minutes / 1440),
      raDeg: '',
      decDeg: '',
      stationId: '',
    }))
  })

  const stations = useODStore((s) => s.stations)
  const iodResult = useODStore((s) => s.iodResult)
  const addStation = useODStore((s) => s.addStation)
  const runIod = useODStore((s) => s.runIod)

  const satellites = useMissionStore((s) => s.satellites)
  const wasmReady = useMissionStore((s) => s.wasmReady)

  const validRowCount = rows.filter(isRowValid).length
  const canRun = validRowCount === 3 && wasmReady

  const updateRow = (index: number, patch: Partial<ObsRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const handleQuickAdd = (station: CanonicalStation) => {
    if (stations.some((s) => s.name === station.name)) return
    addStation(station.name, station.latRad, station.lonRad, station.altKm)
  }

  const handleRun = () => {
    setRunError(null)
    const observations: GaussIodObservation[] = []
    for (const row of rows) {
      const epochJd = datetimeLocalToJd(row.epoch)
      if (epochJd == null) {
        setRunError('One or more epochs are invalid')
        return
      }
      observations.push({
        epochJd,
        raRad: Number(row.raDeg) * DEG_TO_RAD,
        decRad: Number(row.decDeg) * DEG_TO_RAD,
        stationId: row.stationId,
      })
    }
    runIod(observations)
    const result = useODStore.getState().iodResult
    if (!result) {
      setRunError('Solver returned no result; check WASM status and station handles')
      return
    }
    setResultEpochJd(observations[1]?.epochJd ?? null)
    setActiveTab('results')
  }

  return (
    <div className="space-y-3">
      {/* Sub-tabs */}
      <div className="flex gap-0.5 border-b border-dust">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 px-2 py-1.5 text-[9px] font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60 ${
              activeTab === tab.id
                ? 'text-neon-purple border-b-2 border-neon-purple'
                : 'text-comment hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'input' && (
        <InputTab
          rows={rows}
          stations={stations}
          satellites={satellites}
          wasmReady={wasmReady}
          validRowCount={validRowCount}
          canRun={canRun}
          runError={runError}
          onUpdateRow={updateRow}
          onSetRows={setRows}
          onQuickAdd={handleQuickAdd}
          onRun={handleRun}
        />
      )}

      {activeTab === 'results' && (
        <ResultsTab iodResult={iodResult} resultEpochJd={resultEpochJd} />
      )}
    </div>
  )
}

// =============================================================================
// Input tab
// =============================================================================

function InputTab({
  rows,
  stations,
  satellites,
  wasmReady,
  validRowCount,
  canRun,
  runError,
  onUpdateRow,
  onSetRows,
  onQuickAdd,
  onRun,
}: {
  rows: ObsRow[]
  stations: ReturnType<typeof useODStore.getState>['stations']
  satellites: ReturnType<typeof useMissionStore.getState>['satellites']
  wasmReady: boolean
  validRowCount: number
  canRun: boolean
  runError: string | null
  onUpdateRow: (index: number, patch: Partial<ObsRow>) => void
  onSetRows: (rows: ObsRow[]) => void
  onQuickAdd: (station: CanonicalStation) => void
  onRun: () => void
}) {
  const [simSatId, setSimSatId] = useState('')
  const [simMessage, setSimMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const propagatable = satellites.filter((s) => s.handle != null)

  const handleSimulate = () => {
    setSimMessage(null)
    const sat = satellites.find((s) => s.id === simSatId)
    if (!sat || sat.handle == null) {
      setSimMessage({ kind: 'error', text: 'Select a satellite with a valid propagator' })
      return
    }
    let filled = 0
    const next = rows.map((row) => {
      const epochJd = datetimeLocalToJd(row.epoch)
      const station = stations.find((s) => s.id === row.stationId)
      if (epochJd == null || !station) return row
      const state = sgp4Propagate(sat.handle!, epochJd)
      if (!state) return row
      const r = { x: state.x, y: state.y, z: state.z }
      const v = { x: state.vx, y: state.vy, z: state.vz }

      // Prefer the WASM observation model; fall back to TS topocentric geometry.
      let raRad: number | null = null
      let decRad: number | null = null
      if (station.handle != null && getWasmModule()) {
        const pred = predictObservation(station.handle, r, v, epochJd)
        if (pred) {
          raRad = pred.raRad
          decRad = pred.decRad
        }
      }
      if (raRad == null || decRad == null) {
        const staPos =
          station.handle != null
            ? stationPositionEci(station.handle, epochJd)
            : null
        const pos =
          staPos ??
          stationPosEciFallback(station.latRad, station.lonRad, station.altKm, epochJd)
        const los = topocentricRaDec(r, pos)
        raRad = los.raRad
        decRad = los.decRad
      }
      filled += 1
      return {
        ...row,
        raDeg: (raRad * RAD_TO_DEG).toFixed(4),
        decDeg: (decRad * RAD_TO_DEG).toFixed(4),
      }
    })
    onSetRows(next)
    setSimMessage(
      filled === 3
        ? { kind: 'ok', text: 'Filled 3 noise-free RA/Dec observations' }
        : {
            kind: 'error',
            text: `Filled ${filled} of 3 rows; check epochs, stations, and propagator`,
          }
    )
  }

  return (
    <div className="space-y-3">
      {/* Station quick-add */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Stations
          </span>
          {stations.length > 0 && (
            <span className="text-[9px] font-mono text-neon-green">
              {stations.length} ready
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {QUICK_ADD.map((station) => {
            const added = stations.some((s) => s.name === station.name)
            return (
              <button
                key={station.name}
                onClick={() => onQuickAdd(station)}
                disabled={added}
                className="btn-secondary flex-1 text-[9px] font-mono disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
              >
                {QUICK_ADD_LABELS[station.name] ?? station.name}
              </button>
            )
          })}
        </div>
        {stations.length === 0 && (
          <div className="text-[10px] font-mono text-neon-orange mt-1.5">
            Add at least one ground station to observe from
          </div>
        )}
      </div>

      {/* Observation rows */}
      <div>
        <div className="text-[10px] font-mono text-comment uppercase tracking-wider mb-1.5">
          Observations (RA/Dec, UTC epochs)
        </div>
        <div className="space-y-2">
          {rows.map((row, i) => {
            const valid = isRowValid(row)
            return (
              <div key={i} className="bg-black/30 p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-mono text-comment uppercase">
                    Obs {i + 1}
                  </span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      valid ? 'bg-neon-green' : 'bg-dust'
                    }`}
                    title={valid ? 'Row ready' : 'Incomplete'}
                  />
                  <span className="sr-only">{valid ? 'complete' : 'incomplete'}</span>
                </div>
                <input
                  type="datetime-local"
                  step={60}
                  value={row.epoch}
                  onChange={(e) => onUpdateRow(i, { epoch: e.target.value })}
                  aria-label={`Observation ${i + 1} epoch UTC`}
                  className="input-field w-full text-[10px]"
                  style={{ colorScheme: 'dark' }}
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    type="number"
                    step="any"
                    value={row.raDeg}
                    onChange={(e) => onUpdateRow(i, { raDeg: e.target.value })}
                    aria-label={`Observation ${i + 1} RA deg`}
                    placeholder="RA (deg)"
                    className="input-field w-full text-[10px]"
                  />
                  <input
                    type="number"
                    step="any"
                    value={row.decDeg}
                    onChange={(e) => onUpdateRow(i, { decDeg: e.target.value })}
                    aria-label={`Observation ${i + 1} Dec deg`}
                    placeholder="Dec (deg)"
                    className="input-field w-full text-[10px]"
                  />
                </div>
                <select
                  value={row.stationId}
                  onChange={(e) => onUpdateRow(i, { stationId: e.target.value })}
                  aria-label={`Observation ${i + 1} station`}
                  className="input-field w-full text-[10px]"
                >
                  <option value="">
                    {stations.length === 0 ? 'No stations (add above)' : 'Select station'}
                  </option>
                  {stations.map((station) => (
                    <option key={station.id} value={station.id}>
                      {station.name}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      </div>

      {/* Simulate from truth */}
      <div className="border-t border-dust pt-2 space-y-2">
        <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
          Simulate From Truth
        </span>
        <select
          value={simSatId}
          onChange={(e) => setSimSatId(e.target.value)}
          aria-label="Truth satellite"
          disabled={propagatable.length === 0}
          className="input-field w-full text-[10px] disabled:opacity-40"
        >
          <option value="">
            {propagatable.length === 0 ? 'No satellites loaded' : 'Select satellite'}
          </option>
          {propagatable.map((sat) => (
            <option key={sat.id} value={sat.id}>
              {sat.name}
            </option>
          ))}
        </select>
        <button
          onClick={handleSimulate}
          disabled={propagatable.length === 0 || simSatId === ''}
          className="btn-secondary w-full text-[10px] font-mono disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
        >
          Fill RA/Dec From Truth
        </button>
        <div className="text-[9px] font-mono text-comment">
          Uses each row's epoch and station; noise-free prediction.
        </div>
        {simMessage && (
          <div
            className={`text-[10px] font-mono ${
              simMessage.kind === 'ok' ? 'text-neon-green' : 'text-neon-red'
            }`}
          >
            {simMessage.text}
          </div>
        )}
      </div>

      {/* Run */}
      <div className="border-t border-dust pt-2 space-y-2">
        <button
          onClick={onRun}
          disabled={!canRun}
          className="btn-primary w-full text-[11px] font-mono disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
        >
          Run Gauss IOD
        </button>
        {!wasmReady && (
          <div className="text-[10px] font-mono text-neon-orange">
            WASM solver unavailable; Gauss IOD needs the compiled module
          </div>
        )}
        {wasmReady && validRowCount < 3 && (
          <div className="text-[10px] font-mono text-comment">
            Add 3 valid RA/Dec observations to enable the solver ({validRowCount}/3 ready)
          </div>
        )}
        {runError && (
          <div className="text-[10px] font-mono text-neon-red">{runError}</div>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// Results tab
// =============================================================================

function ResultsTab({
  iodResult,
  resultEpochJd,
}: {
  iodResult: GaussIodTsResult | null
  resultEpochJd: number | null
}) {
  if (!iodResult) {
    return (
      <div className="text-[10px] font-mono text-comment">
        No solution yet. Run Gauss IOD from the Input tab.
      </div>
    )
  }

  const badge = statusBadge(iodResult.status)
  const elements = deriveElements(iodResult.r, iodResult.v)

  return (
    <div className="space-y-3">
      {/* Status badge */}
      <div className="flex items-center gap-2">
        <span
          className={`px-2 py-0.5 text-[9px] font-mono uppercase ${badge.className}`}
        >
          {badge.label}
        </span>
        {resultEpochJd != null && (
          <span className="text-[9px] font-mono text-comment">
            {jdToUtc(resultEpochJd)}
          </span>
        )}
      </div>
      <div
        className={`text-[10px] font-mono ${
          iodResult.status === GAUSS_IOD_STATUS.OK
            ? 'text-neon-green'
            : iodResult.status === GAUSS_IOD_STATUS.WARNING_ILL_CONDITIONED
              ? 'text-neon-yellow'
              : 'text-neon-red'
        }`}
      >
        {iodResult.statusMessage}
      </div>
      {iodResult.status === GAUSS_IOD_STATUS.WARNING_ILL_CONDITIONED && (
        <div className="text-[10px] font-mono text-neon-yellow">
          Observation geometry too weak; increase spacing or use different stations
        </div>
      )}

      {/* State vector */}
      {iodResult.converged ? (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            State Vector (middle epoch)
          </div>
          <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px] font-mono">
            <div>
              <span className="text-comment">X</span>{' '}
              <span className="text-neon-cyan">{iodResult.r[0].toFixed(3)}</span>
            </div>
            <div>
              <span className="text-comment">Y</span>{' '}
              <span className="text-neon-cyan">{iodResult.r[1].toFixed(3)}</span>
            </div>
            <div>
              <span className="text-comment">Z</span>{' '}
              <span className="text-neon-cyan">{iodResult.r[2].toFixed(3)}</span>
            </div>
            <div>
              <span className="text-comment">Vx</span>{' '}
              <span className="text-neon-purple">{iodResult.v[0].toFixed(6)}</span>
            </div>
            <div>
              <span className="text-comment">Vy</span>{' '}
              <span className="text-neon-purple">{iodResult.v[1].toFixed(6)}</span>
            </div>
            <div>
              <span className="text-comment">Vz</span>{' '}
              <span className="text-neon-purple">{iodResult.v[2].toFixed(6)}</span>
            </div>
          </div>
          <div className="text-[9px] font-mono text-comment">Position km, velocity km/s, ECI/TEME</div>
        </div>
      ) : (
        <div className="border-t border-dust pt-2 text-[10px] font-mono text-comment">
          No usable state vector for this status.
        </div>
      )}

      {/* Derived elements */}
      {iodResult.converged && elements && (
        <div className="space-y-1 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Derived Elements (two-body)
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
            <div>
              <div className="text-[9px] text-comment">a (km)</div>
              <span className="text-neon-cyan">{elements.aKm.toFixed(3)}</span>
            </div>
            <div>
              <div className="text-[9px] text-comment">e</div>
              <span className="text-neon-cyan">{elements.e.toFixed(6)}</span>
            </div>
            <div>
              <div className="text-[9px] text-comment">i (deg)</div>
              <span className="text-neon-cyan">{elements.iDeg.toFixed(3)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Diagnostics */}
      <div className="space-y-1 border-t border-dust pt-2">
        <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
          Diagnostics
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
          <div>
            <span className="text-comment">Iterations:</span>{' '}
            <span className="text-white">{iodResult.iterations}</span>
          </div>
          <div>
            <span className="text-comment">Residual:</span>{' '}
            <span className="text-white">{iodResult.residualNorm.toExponential(2)} rad</span>
          </div>
          <div>
            <span className="text-comment">Condition:</span>{' '}
            <span className="text-white">{iodResult.conditionNumber.toExponential(2)}</span>
          </div>
          <div>
            <span className="text-comment">Ranges:</span>{' '}
            <span className="text-neon-orange">
              {iodResult.ranges.map((rho) => rho.toFixed(1)).join(' / ')} km
            </span>
          </div>
        </div>
        <div className="text-[9px] font-mono text-comment">
          Slant ranges rho1 / rho2 / rho3 at the three observation epochs
        </div>
      </div>
    </div>
  )
}
