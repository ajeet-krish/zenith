import { useState } from 'react'
import { useODStore } from '@/store/useODStore'
import { useMissionStore } from '@/store/useMissionStore'
import { sgp4Propagate } from '@/orbit/wasmLoader'
import { simulateObservations, type TruthState } from '@/orbit/observations'
import { getBatchConfigDefaults } from '@/orbit/odBatch'
import {
  GOLDSTONE,
  ARECIBO,
  TROMSOE,
  SIGMA_ANGLES_RAD,
  type CanonicalStation,
} from '@/orbit/odConstants'
import { BATCH_STATUS } from '@/orbit/types'
import type {
  BatchAPriori,
  BatchTsConfig,
  BatchTsResult,
  ODObservation,
  ODObservationType,
} from '@/orbit/types'
import { MU_EARTH, DEG_TO_RAD, RAD_TO_DEG } from '@/orbit/constants'
import { jdToDatetimeLocal, datetimeLocalToJd } from '@/utils/timeFormat'
import { ResidualPlot } from '@/components/ui/ResidualPlot'

// =============================================================================
// Types and helpers
// =============================================================================

type BatchTab = 'input' | 'results'

type GuessMode = 'iod' | 'custom' | 'satellite'

type ForceTier = 'two_body' | 'j2'

/** Everything the Input tab hands to the store's runBatch action. */
interface BatchRunRequest {
  stateGuess: number[]
  epochJd: number
  config: Partial<BatchTsConfig>
  apriori: BatchAPriori | null
}

const TABS: { id: BatchTab; label: string }[] = [
  { id: 'input', label: 'Input' },
  { id: 'results', label: 'Results' },
]

const QUICK_ADD: CanonicalStation[] = [GOLDSTONE, ARECIBO, TROMSOE]

const QUICK_ADD_LABELS: Record<string, string> = {
  goldstone: 'Goldstone',
  arecibo: 'Arecibo',
  tromsoe: 'Tromsoe',
}

/** Scalar components per observation type (matches the batch kernel). */
const OBS_NDIM: Record<ODObservationType, number> = {
  range: 1,
  range_rate: 1,
  ra_dec: 2,
  az_el: 2,
}

/** Observation types the batch kernel accepts (AZ_EL rows are rejected). */
const BATCH_OBS_TYPES: ODObservationType[] = ['range', 'range_rate', 'ra_dec']

/** Custom state guess labels: aria label + input placeholder. */
const GUESS_FIELDS: { aria: string; placeholder: string }[] = [
  { aria: 'Guess X km', placeholder: 'X (km)' },
  { aria: 'Guess Y km', placeholder: 'Y (km)' },
  { aria: 'Guess Z km', placeholder: 'Z (km)' },
  { aria: 'Guess Vx km/s', placeholder: 'Vx (km/s)' },
  { aria: 'Guess Vy km/s', placeholder: 'Vy (km/s)' },
  { aria: 'Guess Vz km/s', placeholder: 'Vz (km/s)' },
]

/** A-priori mean labels (same six components as the state guess). */
const APRIORI_X0_LABELS = [
  'A-priori X km',
  'A-priori Y km',
  'A-priori Z km',
  'A-priori Vx km/s',
  'A-priori Vy km/s',
  'A-priori Vz km/s',
]

/** A-priori diagonal covariance labels (variance per component). */
const APRIORI_P0_LABELS = [
  'A-priori variance X (km^2)',
  'A-priori variance Y (km^2)',
  'A-priori variance Z (km^2)',
  'A-priori variance Vx ((km/s)^2)',
  'A-priori variance Vy ((km/s)^2)',
  'A-priori variance Vz ((km/s)^2)',
]

/** Default a-priori diagonal: 100 km position sigma, 1 km/s velocity sigma. */
const APRIORI_P0_DEFAULTS = ['10000', '10000', '10000', '1', '1', '1']

/** Total scalar rows implied by a set of observations. */
function countScalarRows(observations: ODObservation[]): number {
  return observations.reduce((sum, obs) => sum + (OBS_NDIM[obs.obsType] ?? 1), 0)
}

/** Unique station count across a set of observations. */
function countStations(observations: ODObservation[]): number {
  return new Set(observations.map((obs) => obs.stationId)).size
}

/** Earliest epoch across the observations (null when empty). */
function firstObservationJd(observations: ODObservation[]): number | null {
  if (observations.length === 0) return null
  let min = observations[0]!.timeJd
  for (const obs of observations) {
    if (obs.timeJd < min) min = obs.timeJd
  }
  return min
}

/** Parse a six-element string list as finite numbers (null when any fails). */
function parseSix(values: string[]): number[] | null {
  const out: number[] = []
  for (const value of values) {
    const n = Number(value)
    if (value.trim() === '' || !Number.isFinite(n)) return null
    out.push(n)
  }
  return out
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

/** Status badge label + classes for a batch solve result. */
function statusBadge(result: BatchTsResult): { label: string; className: string } {
  if (result.errorStatus === BATCH_STATUS.OK && result.converged) {
    return { label: 'CONVERGED', className: 'bg-neon-green/20 text-neon-green' }
  }
  if (
    result.errorStatus === BATCH_STATUS.ERROR_NOT_CONVERGED ||
    (result.errorStatus === BATCH_STATUS.OK && !result.converged)
  ) {
    return { label: 'NOT CONVERGED', className: 'bg-neon-yellow/20 text-neon-yellow' }
  }
  return { label: 'ERROR', className: 'bg-neon-red/20 text-neon-red' }
}

/** True when a hard error left no trustworthy state vector to display. */
function stateVectorHidden(result: BatchTsResult): boolean {
  return !result.converged && result.errorStatus !== BATCH_STATUS.ERROR_NOT_CONVERGED
}

/** Format a formal sigma: positions 3 decimals, velocities 6 or scientific. */
function formatSigma(value: number, isPosition: boolean): string {
  if (isPosition) return value.toFixed(3)
  const abs = Math.abs(value)
  if (abs === 0) return '0'
  if (abs < 1e-4 || abs >= 1e6) return value.toExponential(3)
  return value.toFixed(6)
}

/** True when the a-priori diagonal variances are all positive and finite. */
function aprioriDiagValid(diag: string[]): boolean {
  return diag.every((value) => {
    const n = Number(value)
    return value.trim() !== '' && Number.isFinite(n) && n > 0
  })
}

// =============================================================================
// Panel
// =============================================================================

/**
 * Batch least-squares OD panel (Phase 3). Input tab wires observations,
 * an estimation epoch, a state guess, and solver config into runBatch;
 * Results tab reports the status, state, formal sigmas, and residuals.
 */
export function BatchPanel() {
  const [activeTab, setActiveTab] = useState<BatchTab>('input')
  const [runError, setRunError] = useState<string | null>(null)

  const runBatch = useODStore((s) => s.runBatch)
  const batchResult = useODStore((s) => s.batchResult)

  const handleRun = (request: BatchRunRequest) => {
    setRunError(null)
    runBatch(request.stateGuess, request.epochJd, request.config, request.apriori)
    const result = useODStore.getState().batchResult
    if (!result) {
      setRunError('Solver returned no result; check WASM status and station handles')
      return
    }
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

      {activeTab === 'input' && <InputTab runError={runError} onRun={handleRun} />}

      {activeTab === 'results' && <ResultsTab batchResult={batchResult} />}
    </div>
  )
}

// =============================================================================
// Collapsible mini-section
// =============================================================================

function MiniSection({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-dust pt-2 space-y-2">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center justify-between focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
      >
        <span
          className={`text-[10px] font-mono uppercase tracking-wider ${
            open ? 'text-neon-purple' : 'text-comment'
          }`}
        >
          {label}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-comment transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

// =============================================================================
// Input tab
// =============================================================================

function InputTab({
  runError,
  onRun,
}: {
  runError: string | null
  onRun: (request: BatchRunRequest) => void
}) {
  const stations = useODStore((s) => s.stations)
  const observations = useODStore((s) => s.observations)
  const iodResult = useODStore((s) => s.iodResult)
  const batchIsRunning = useODStore((s) => s.batchIsRunning)
  const addStation = useODStore((s) => s.addStation)
  const setObservations = useODStore((s) => s.setObservations)
  const clearObservations = useODStore((s) => s.clearObservations)
  const clearBatchResult = useODStore((s) => s.clearBatchResult)
  const setSimConfig = useODStore((s) => s.setSimConfig)

  const satellites = useMissionStore((s) => s.satellites)
  const selectedSatelliteId = useMissionStore((s) => s.selectedSatelliteId)

  const propagatable = satellites.filter((s) => s.handle != null)
  const selectedSat = satellites.find((s) => s.id === selectedSatelliteId)
  const selectedSatReady = selectedSat != null && selectedSat.handle != null

  // Simulated arc generator state.
  const [simSatId, setSimSatId] = useState('')
  const [selectedStationIds, setSelectedStationIds] = useState<Set<string>>(
    () => new Set(useODStore.getState().stations.map((s) => s.id))
  )
  const [simArcHours, setSimArcHours] = useState('2')
  const [simCadenceSec, setCadenceSec] = useState('60')
  const [simNoiseArcsec, setSimNoiseArcsec] = useState('1')
  const [simMessage, setSimMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    null
  )

  // Estimation epoch: null override derives from the first observation.
  const [epochOverride, setEpochOverride] = useState<string | null>(null)

  // Initial state guess.
  const [guessMode, setGuessMode] = useState<GuessMode>(() =>
    useODStore.getState().iodResult ? 'iod' : 'custom'
  )
  const [customGuess, setCustomGuess] = useState<string[]>(() =>
    Array(6).fill('')
  )

  // Force model tier (defaults to J2, matching the kernel default).
  const [forceTier, setForceTier] = useState<ForceTier>(() =>
    getBatchConfigDefaults().forceTier === 0 ? 'two_body' : 'j2'
  )

  // Solver config (collapsible), seeded once from the kernel defaults.
  const [maxIter, setMaxIter] = useState(() => String(getBatchConfigDefaults().maxIter))
  const [sigmaEdit, setSigmaEdit] = useState(() => String(getBatchConfigDefaults().sigmaEdit))

  // A-priori constraint (collapsible).
  const [aprioriEnabled, setAPrioriEnabled] = useState(false)
  const [aprioriX0, setAPrioriX0] = useState<string[]>(() => Array(6).fill(''))
  const [aprioriP0, setAPrioriP0] = useState<string[]>(() => [...APRIORI_P0_DEFAULTS])

  const obsCount = observations.length
  const stationCount = countStations(observations)
  const scalarRows = countScalarRows(observations)

  const firstJd = firstObservationJd(observations)
  const epochStr = epochOverride ?? (firstJd != null ? jdToDatetimeLocal(firstJd) : '')
  const epochJd = datetimeLocalToJd(epochStr)

  // Compose the state guess from the selected mode.
  let guess: number[] | null = null
  if (guessMode === 'iod') {
    guess = iodResult ? [...iodResult.r, ...iodResult.v] : null
  } else if (guessMode === 'custom') {
    guess = parseSix(customGuess)
  } else {
    if (selectedSatReady && epochJd != null) {
      const state = sgp4Propagate(selectedSat!.handle!, epochJd)
      guess = state ? [state.x, state.y, state.z, state.vx, state.vy, state.vz] : null
    }
  }

  const maxIterNum = Number(maxIter)
  const sigmaEditNum = Number(sigmaEdit)
  // Bounds match the kernel's parse_config_flat clamps (max_iter [1, 100])
  // so the entered value is exactly what the solver applies.
  const configValid =
    Number.isInteger(maxIterNum) &&
    maxIterNum >= 1 &&
    maxIterNum <= 100 &&
    Number.isFinite(sigmaEditNum) &&
    sigmaEditNum > 0

  const aprioriX0Values = parseSix(aprioriX0)
  const aprioriValid = !aprioriEnabled || (aprioriX0Values != null && aprioriDiagValid(aprioriP0))

  const canRun =
    obsCount > 0 && epochJd != null && guess != null && !batchIsRunning && configValid && aprioriValid

  const handleQuickAdd = (station: CanonicalStation) => {
    if (stations.some((s) => s.name === station.name)) return
    addStation(station.name, station.latRad, station.lonRad, station.altKm)
    const added = useODStore.getState().stations.find((s) => s.name === station.name)
    if (added) {
      setSelectedStationIds((prev) => new Set([...prev, added.id]))
    }
  }

  const toggleStation = (id: string) => {
    setSelectedStationIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleGenerateArc = () => {
    setSimMessage(null)
    const sat = satellites.find((s) => s.id === simSatId)
    if (!sat || sat.handle == null) {
      setSimMessage({ kind: 'error', text: 'Select a satellite with a valid propagator' })
      return
    }
    const chosen = stations.filter((s) => selectedStationIds.has(s.id))
    if (chosen.length === 0) {
      setSimMessage({ kind: 'error', text: 'Select at least one ground station to observe from' })
      return
    }
    if (chosen.some((s) => s.handle == null)) {
      setSimMessage({ kind: 'error', text: 'One or more selected stations have no WASM handle' })
      return
    }
    const arcHours = Number(simArcHours)
    const cadenceSec = Number(simCadenceSec)
    const noiseArcsec = Number(simNoiseArcsec)
    if (!(arcHours > 0) || !(cadenceSec > 0) || !(noiseArcsec >= 0)) {
      setSimMessage({ kind: 'error', text: 'Arc length and cadence must be positive; noise cannot be negative' })
      return
    }

    const nEpochs = Math.min(Math.floor((arcHours * 3600) / cadenceSec) + 1, 2000)
    const startJd = useMissionStore.getState().currentEpoch
    const truthStates: TruthState[] = []
    for (let i = 0; i < nEpochs; ++i) {
      const jd = startJd + (i * cadenceSec) / 86400
      const state = sgp4Propagate(sat.handle!, jd)
      if (!state) continue
      truthStates.push({
        jd,
        r: { x: state.x, y: state.y, z: state.z },
        v: { x: state.vx, y: state.vy, z: state.vz },
      })
    }
    if (truthStates.length === 0) {
      setSimMessage({ kind: 'error', text: 'Propagator returned no states for the arc' })
      return
    }

    // noiseScale multiplies the default sigmas; scale so the angular noise
    // matches the requested arcsec value.
    const noiseScale = (noiseArcsec * DEG_TO_RAD / 3600) / SIGMA_ANGLES_RAD
    const all: ODObservation[] = []
    for (const station of chosen) {
      const obs = simulateObservations(station.handle!, truthStates, {
        noiseScale,
        seed: 42,
        stationId: station.id,
        obsTypes: BATCH_OBS_TYPES,
      })
      if (!obs) {
        setSimMessage({
          kind: 'error',
          text: `Observation model failed for ${station.name}; check the WASM module`,
        })
        return
      }
      all.push(...obs)
    }

    setObservations(all)
    clearBatchResult()
    setSimConfig({ arcHours, cadenceSec, noiseScale })
    setEpochOverride(null)
    setSimMessage({
      kind: 'ok',
      text: `Generated ${all.length} observations (${truthStates.length} epochs x ${chosen.length} station${chosen.length === 1 ? '' : 's'})`,
    })
  }

  const handleToggleAPriori = () => {
    const next = !aprioriEnabled
    if (next && guess) {
      setAPrioriX0(guess.map((v) => String(v)))
    }
    setAPrioriEnabled(next)
  }

  const handleRun = () => {
    if (epochJd == null || guess == null || !configValid || !aprioriValid) return
    const config: Partial<BatchTsConfig> = {
      forceTier: forceTier === 'j2' ? 1 : 0,
      maxIter: maxIterNum,
      sigmaEdit: sigmaEditNum,
    }
    let apriori: BatchAPriori | null = null
    if (aprioriEnabled && aprioriX0Values) {
      const cov = new Array(36).fill(0)
      for (let i = 0; i < 6; ++i) {
        cov[i * 6 + i] = Number(aprioriP0[i])
      }
      apriori = { x0: aprioriX0Values, cov }
    }
    onRun({ stateGuess: guess, epochJd, config, apriori })
  }

  // Blocking-condition hints shown under the Run button.
  const blockers: string[] = []
  if (obsCount === 0) blockers.push('Add or generate observations to enable the solver')
  if (epochJd == null && obsCount > 0) blockers.push('Estimation epoch is invalid')
  if (guessMode === 'custom' && guess == null) blockers.push('Enter all 6 custom state components')
  if (guessMode === 'satellite' && guess == null) {
    blockers.push(
      selectedSatReady
        ? 'The selected satellite could not be propagated at the estimation epoch'
        : 'Select a satellite in the mission list'
    )
  }
  if (!configValid) {
    blockers.push('Max iterations must be a whole number between 1 and 100; sigma edit must be positive')
  }
  if (!aprioriValid) blockers.push('A-priori x0 must be numeric and P0 variances must be positive')

  return (
    <div className="space-y-3">
      {/* Observation source */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Observations
          </span>
          {obsCount > 0 && (
            <button
              onClick={() => {
                clearObservations()
                clearBatchResult()
              }}
              className="text-[9px] font-mono text-neon-orange hover:text-neon-red transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
            >
              Clear
            </button>
          )}
        </div>
        <div className="bg-black/30 p-2 space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-mono">
            <span className="text-comment">Store observations</span>
            <span className={obsCount > 0 ? 'text-neon-green' : 'text-neon-orange'}>
              {obsCount}
            </span>
          </div>
          {obsCount > 0 && (
            <div className="text-[9px] font-mono text-comment">
              {stationCount} station{stationCount === 1 ? '' : 's'}, ~{scalarRows} scalar rows
            </div>
          )}
        </div>
      </div>

      {/* Simulated arc generator */}
      <div className="border-t border-dust pt-2 space-y-2">
        <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
          Simulated Arc
        </span>
        <select
          value={simSatId}
          onChange={(e) => setSimSatId(e.target.value)}
          aria-label="Simulator satellite"
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

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] font-mono text-comment uppercase">Stations</span>
            {stations.length > 0 && (
              <span className="text-[9px] font-mono text-neon-green">
                {selectedStationIds.size} selected
              </span>
            )}
          </div>
          <div className="flex gap-1 mb-1.5">
            {QUICK_ADD.map((station) => {
              const added = stations.some((s) => s.name === station.name)
              return (
                <button
                  key={station.name}
                  onClick={() => handleQuickAdd(station)}
                  disabled={added}
                  className="btn-secondary flex-1 text-[9px] font-mono disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
                >
                  {QUICK_ADD_LABELS[station.name] ?? station.name}
                </button>
              )
            })}
          </div>
          {stations.length === 0 ? (
            <div className="text-[10px] font-mono text-neon-orange">
              Add at least one ground station to observe from
            </div>
          ) : (
            <div className="space-y-1">
              {stations.map((station) => (
                <label
                  key={station.id}
                  className="flex items-center gap-2 text-[10px] font-mono text-white cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedStationIds.has(station.id)}
                    onChange={() => toggleStation(station.id)}
                    aria-label={`Observe from ${station.name}`}
                    className="accent-neon-purple"
                  />
                  {station.name}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <div>
            <label className="text-[9px] font-mono text-comment block mb-0.5">Arc (h)</label>
            <input
              type="number"
              step="any"
              min={0.1}
              value={simArcHours}
              onChange={(e) => setSimArcHours(e.target.value)}
              aria-label="Arc length hours"
              className="input-field w-full text-[10px]"
            />
          </div>
          <div>
            <label className="text-[9px] font-mono text-comment block mb-0.5">Cadence (s)</label>
            <input
              type="number"
              step="any"
              min={1}
              value={simCadenceSec}
              onChange={(e) => setCadenceSec(e.target.value)}
              aria-label="Cadence seconds"
              className="input-field w-full text-[10px]"
            />
          </div>
          <div>
            <label className="text-[9px] font-mono text-comment block mb-0.5">Noise (arcsec)</label>
            <input
              type="number"
              step="any"
              min={0}
              value={simNoiseArcsec}
              onChange={(e) => setSimNoiseArcsec(e.target.value)}
              aria-label="Noise arcsec"
              className="input-field w-full text-[10px]"
            />
          </div>
        </div>

        <button
          onClick={handleGenerateArc}
          disabled={propagatable.length === 0 || simSatId === '' || stations.length === 0}
          className="btn-secondary w-full text-[10px] font-mono disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
        >
          Generate Simulated Arc
        </button>
        <div className="text-[9px] font-mono text-comment">
          Propagates the selected satellite and emits range, range-rate, and RA/Dec rows from each
          checked station. Replaces the current store observations.
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

      {/* Estimation epoch */}
      <div className="border-t border-dust pt-2 space-y-1.5">
        <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
          Estimation Epoch
        </span>
        <input
          type="datetime-local"
          step={60}
          value={epochStr}
          onChange={(e) => setEpochOverride(e.target.value)}
          aria-label="Estimation epoch UTC"
          className="input-field w-full text-[10px]"
          style={{ colorScheme: 'dark' }}
        />
        <div className="text-[9px] font-mono text-comment">
          {epochOverride == null && firstJd != null
            ? 'Defaults to the first observation epoch'
            : 'The state guess must refer to this epoch'}
        </div>
      </div>

      {/* Initial state guess */}
      <div className="border-t border-dust pt-2 space-y-2">
        <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
          Initial State Guess
        </span>
        <div className="space-y-1.5">
          <label
            className={`flex items-center gap-2 text-[10px] font-mono cursor-pointer ${
              iodResult ? 'text-white' : 'text-comment opacity-60 cursor-not-allowed'
            }`}
          >
            <input
              type="radio"
              name="batch-guess-mode"
              checked={guessMode === 'iod'}
              onChange={() => setGuessMode('iod')}
              disabled={!iodResult}
              aria-label="From IOD result"
              className="accent-neon-purple"
            />
            From IOD result
          </label>
          {!iodResult && (
            <div className="text-[9px] font-mono text-comment pl-5">
              Run Gauss IOD first to seed the batch solver
            </div>
          )}
          <label className="flex items-center gap-2 text-[10px] font-mono text-white cursor-pointer">
            <input
              type="radio"
              name="batch-guess-mode"
              checked={guessMode === 'custom'}
              onChange={() => setGuessMode('custom')}
              aria-label="Custom"
              className="accent-neon-purple"
            />
            Custom
          </label>
          <label className="flex items-center gap-2 text-[10px] font-mono text-white cursor-pointer">
            <input
              type="radio"
              name="batch-guess-mode"
              checked={guessMode === 'satellite'}
              onChange={() => setGuessMode('satellite')}
              aria-label="Satellite current state"
              className="accent-neon-purple"
            />
            Satellite current state
          </label>
          {!selectedSatReady && (
            <div className="text-[9px] font-mono text-comment pl-5">
              Select a satellite in the mission list
            </div>
          )}
        </div>

        {guessMode === 'custom' && (
          <div className="grid grid-cols-3 gap-1.5">
            {GUESS_FIELDS.map((field, i) => (
              <input
                key={field.aria}
                type="number"
                step="any"
                value={customGuess[i]}
                onChange={(e) =>
                  setCustomGuess((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                }
                aria-label={field.aria}
                placeholder={field.placeholder}
                className="input-field w-full text-[10px]"
              />
            ))}
          </div>
        )}
        {guessMode === 'satellite' && selectedSatReady && (
          <div className="text-[10px] font-mono text-neon-cyan">
            {selectedSat!.name} at the estimation epoch via SGP4
          </div>
        )}
      </div>

      {/* Force model */}
      <div className="border-t border-dust pt-2 space-y-1.5">
        <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
          Force Model
        </span>
        <label className="flex items-center gap-2 text-[10px] font-mono text-white cursor-pointer">
          <input
            type="radio"
            name="batch-force-tier"
            checked={forceTier === 'two_body'}
            onChange={() => setForceTier('two_body')}
            aria-label="Two-body"
            className="accent-neon-purple"
          />
          Two-body
        </label>
        <label className="flex items-center gap-2 text-[10px] font-mono text-white cursor-pointer">
          <input
            type="radio"
            name="batch-force-tier"
            checked={forceTier === 'j2'}
            onChange={() => setForceTier('j2')}
            aria-label="J2"
            className="accent-neon-purple"
          />
          J2
        </label>
        <label className="flex items-center gap-2 text-[10px] font-mono text-comment opacity-60 cursor-not-allowed">
          <input
            type="radio"
            name="batch-force-tier"
            checked={false}
            disabled
            aria-label="J2 plus drag"
            className="accent-neon-purple"
          />
          J2 + drag (Phase 4 fast-follow)
        </label>
      </div>

      {/* Solver config */}
      <MiniSection label="Solver Config">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="text-[9px] font-mono text-comment block mb-0.5">Max iterations</label>
            <input
              type="number"
              step={1}
              min={1}
              max={100}
              value={maxIter}
              onChange={(e) => setMaxIter(e.target.value)}
              aria-label="Max iterations"
              className="input-field w-full text-[10px]"
            />
          </div>
          <div>
            <label className="text-[9px] font-mono text-comment block mb-0.5">Sigma edit</label>
            <input
              type="number"
              step="any"
              min={0.1}
              value={sigmaEdit}
              onChange={(e) => setSigmaEdit(e.target.value)}
              aria-label="Sigma edit threshold"
              className="input-field w-full text-[10px]"
            />
          </div>
        </div>
        <div className="text-[9px] font-mono text-comment">
          Outliers beyond this many sigmas are edited out and the solve warm-restarts.
        </div>
      </MiniSection>

      {/* A-priori constraint */}
      <MiniSection label="A-Priori Constraint">
        <label className="flex items-center gap-2 text-[10px] font-mono text-white cursor-pointer">
          <input
            type="checkbox"
            checked={aprioriEnabled}
            onChange={handleToggleAPriori}
            aria-label="Enable a-priori constraint"
            className="accent-neon-purple"
          />
          Enable a-priori constraint
        </label>
        {aprioriEnabled && (
          <div className="space-y-2">
            <div className="text-[9px] font-mono text-comment">
              Mean x0 pre-fills from the current guess; P0 is the diagonal covariance.
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {APRIORI_X0_LABELS.map((aria, i) => (
                <input
                  key={aria}
                  type="number"
                  step="any"
                  value={aprioriX0[i]}
                  onChange={(e) =>
                    setAPrioriX0((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                  }
                  aria-label={aria}
                  placeholder={GUESS_FIELDS[i]!.placeholder}
                  className="input-field w-full text-[10px]"
                />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {APRIORI_P0_LABELS.map((aria, i) => (
                <input
                  key={aria}
                  type="number"
                  step="any"
                  min={0}
                  value={aprioriP0[i]}
                  onChange={(e) =>
                    setAPrioriP0((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                  }
                  aria-label={aria}
                  className="input-field w-full text-[10px]"
                />
              ))}
            </div>
          </div>
        )}
      </MiniSection>

      {/* Run */}
      <div className="border-t border-dust pt-2 space-y-2">
        <button
          onClick={handleRun}
          disabled={!canRun}
          className="btn-primary w-full text-[11px] font-mono disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
        >
          {batchIsRunning ? 'Solving...' : 'Run Batch'}
        </button>
        <div className="text-[9px] font-mono text-comment">
          {obsCount} observation{obsCount === 1 ? '' : 's'} from {stationCount} station
          {stationCount === 1 ? '' : 's'}, ~{scalarRows} scalar rows
        </div>
        {blockers.map((hint) => (
          <div key={hint} className="text-[10px] font-mono text-neon-orange">
            {hint}
          </div>
        ))}
        {runError && <div className="text-[10px] font-mono text-neon-red">{runError}</div>}
      </div>
    </div>
  )
}

// =============================================================================
// Results tab
// =============================================================================

function ResultsTab({ batchResult }: { batchResult: BatchTsResult | null }) {
  const clearBatchResult = useODStore((s) => s.clearBatchResult)
  const [showSigmaBand, setShowSigmaBand] = useState(true)

  if (!batchResult) {
    return (
      <div className="text-[10px] font-mono text-comment">
        Run a batch solve to see residuals and covariance
      </div>
    )
  }

  const badge = statusBadge(batchResult)
  const state = batchResult.state
  const r: [number, number, number] = [state[0] ?? 0, state[1] ?? 0, state[2] ?? 0]
  const v: [number, number, number] = [state[3] ?? 0, state[4] ?? 0, state[5] ?? 0]
  const elements = stateVectorHidden(batchResult) ? null : deriveElements(r, v)
  const sigmas = batchResult.formalSigmas

  return (
    <div className="space-y-3">
      {/* Status badge */}
      <div className="flex items-center gap-2">
        <span className={`px-2 py-0.5 text-[9px] font-mono uppercase ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      <div
        className={`text-[10px] font-mono ${
          badge.label === 'CONVERGED'
            ? 'text-neon-green'
            : badge.label === 'NOT CONVERGED'
              ? 'text-neon-yellow'
              : 'text-neon-red'
        }`}
      >
        {batchResult.statusMessage}
      </div>
      {badge.label === 'NOT CONVERGED' && (
        <div className="text-[10px] font-mono text-neon-yellow">
          Loosen the tolerances, extend the arc, or check the force model and initial guess
        </div>
      )}

      {/* State vector */}
      {!stateVectorHidden(batchResult) ? (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            State Vector (estimation epoch)
          </div>
          <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px] font-mono">
            <div>
              <span className="text-comment">X</span>{' '}
              <span className="text-neon-cyan">{r[0].toFixed(3)}</span>
            </div>
            <div>
              <span className="text-comment">Y</span>{' '}
              <span className="text-neon-cyan">{r[1].toFixed(3)}</span>
            </div>
            <div>
              <span className="text-comment">Z</span>{' '}
              <span className="text-neon-cyan">{r[2].toFixed(3)}</span>
            </div>
            <div>
              <span className="text-comment">Vx</span>{' '}
              <span className="text-neon-purple">{v[0].toFixed(6)}</span>
            </div>
            <div>
              <span className="text-comment">Vy</span>{' '}
              <span className="text-neon-purple">{v[1].toFixed(6)}</span>
            </div>
            <div>
              <span className="text-comment">Vz</span>{' '}
              <span className="text-neon-purple">{v[2].toFixed(6)}</span>
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
      {elements && (
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

      {/* Formal sigmas */}
      {sigmas.length === 6 && (
        <div className="space-y-1 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Formal Sigmas
          </div>
          <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px] font-mono">
            <div>
              <span className="text-comment">sx</span>{' '}
              <span className="text-neon-cyan">{formatSigma(sigmas[0]!, true)} km</span>
            </div>
            <div>
              <span className="text-comment">sy</span>{' '}
              <span className="text-neon-cyan">{formatSigma(sigmas[1]!, true)} km</span>
            </div>
            <div>
              <span className="text-comment">sz</span>{' '}
              <span className="text-neon-cyan">{formatSigma(sigmas[2]!, true)} km</span>
            </div>
            <div>
              <span className="text-comment">svx</span>{' '}
              <span className="text-neon-purple">{formatSigma(sigmas[3]!, false)} km/s</span>
            </div>
            <div>
              <span className="text-comment">svy</span>{' '}
              <span className="text-neon-purple">{formatSigma(sigmas[4]!, false)} km/s</span>
            </div>
            <div>
              <span className="text-comment">svz</span>{' '}
              <span className="text-neon-purple">{formatSigma(sigmas[5]!, false)} km/s</span>
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
            <span className="text-comment">WRMS:</span>{' '}
            <span className="text-white">{batchResult.wrms.toFixed(3)}</span>
          </div>
          <div>
            <span className="text-comment">Iterations:</span>{' '}
            <span className="text-white">{batchResult.iterations}</span>
          </div>
          <div>
            <span className="text-comment">Edited:</span>{' '}
            <span className="text-white">
              {batchResult.editedCount} / {batchResult.residuals.length}
            </span>
          </div>
          <div>
            <span className="text-comment">Reduced chi2:</span>{' '}
            <span className="text-white">
              {batchResult.reducedChi2 != null ? batchResult.reducedChi2.toFixed(3) : 'n/a'}
            </span>
          </div>
        </div>
      </div>

      {/* Residual plot */}
      <div className="space-y-1.5 border-t border-dust pt-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Post-Fit Residuals
          </span>
          <label className="flex items-center gap-1.5 text-[9px] font-mono text-comment cursor-pointer">
            <input
              type="checkbox"
              checked={showSigmaBand}
              onChange={(e) => setShowSigmaBand(e.target.checked)}
              aria-label="Show 3-sigma band"
              className="accent-neon-purple"
            />
            3-sigma band
          </label>
        </div>
        <ResidualPlot
          rows={batchResult.residuals}
          height={140}
          showSigmaBand={showSigmaBand}
          title="Normalized residuals"
        />
        <div className="text-[9px] font-mono text-comment">
          One point per scalar row; red X markers are edited outliers
        </div>
      </div>

      {/* Clear */}
      <button
        onClick={clearBatchResult}
        className="btn-secondary w-full text-[10px] font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
      >
        Clear result
      </button>
    </div>
  )
}
