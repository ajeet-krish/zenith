import { useState } from 'react'
import { useODStore } from '@/store/useODStore'
import { useMissionStore } from '@/store/useMissionStore'
import { sgp4Propagate } from '@/orbit/wasmLoader'
import { simulateObservations, type TruthState } from '@/orbit/observations'
import { getEkfConfigDefaults } from '@/orbit/odEkf'
import {
  GOLDSTONE,
  ARECIBO,
  TROMSOE,
  SIGMA_ANGLES_RAD,
  type CanonicalStation,
} from '@/orbit/odConstants'
import { EKF_STATUS } from '@/orbit/types'
import type {
  EkfTsConfig,
  EkfTsResult,
  ODObservation,
  ODObservationType,
  ScheduledManeuver,
} from '@/orbit/types'
import { MU_EARTH, DEG_TO_RAD, RAD_TO_DEG } from '@/orbit/constants'
import { jdToDatetimeLocal, datetimeLocalToJd } from '@/utils/timeFormat'
import { NisPlot } from '@/components/ui/NisPlot'
import { CovariancePlot } from '@/components/ui/CovariancePlot'

// =============================================================================
// Types and helpers
// =============================================================================

type EkfTab = 'input' | 'results'

type GuessMode = 'iod' | 'batch' | 'custom' | 'satellite'

type ForceTier = 'two_body' | 'j2'

/** One editable scheduled-burn draft row (strings mirror the inputs). */
interface ManeuverRowDraft {
  epoch: string
  dv: [string, string, string]
}

/** Everything the Input tab hands to the store's runEkf action. */
interface EkfRunRequest {
  state0: number[]
  epochJd: number
  config: Partial<EkfTsConfig>
  maneuvers: ScheduledManeuver[]
  /** NIS gate sigma used for this run; the Results NIS plot gates at its square. */
  gateSigma: number
}

const TABS: { id: EkfTab; label: string }[] = [
  { id: 'input', label: 'Input' },
  { id: 'results', label: 'Results' },
]

const QUICK_ADD: CanonicalStation[] = [GOLDSTONE, ARECIBO, TROMSOE]

const QUICK_ADD_LABELS: Record<string, string> = {
  goldstone: 'Goldstone',
  arecibo: 'Arecibo',
  tromsoe: 'Tromsoe',
}

/** Scalar components per observation type (matches the EKF kernel). */
const OBS_NDIM: Record<ODObservationType, number> = {
  range: 1,
  range_rate: 1,
  ra_dec: 2,
  az_el: 2,
}

/** Observation types the EKF kernel accepts (AZ_EL rows are rejected). */
const EKF_OBS_TYPES: ODObservationType[] = ['range', 'range_rate', 'ra_dec']

/** Custom state guess labels: aria label + input placeholder. */
const GUESS_FIELDS: { aria: string; placeholder: string }[] = [
  { aria: 'Guess X km', placeholder: 'X (km)' },
  { aria: 'Guess Y km', placeholder: 'Y (km)' },
  { aria: 'Guess Z km', placeholder: 'Z (km)' },
  { aria: 'Guess Vx km/s', placeholder: 'Vx (km/s)' },
  { aria: 'Guess Vy km/s', placeholder: 'Vy (km/s)' },
  { aria: 'Guess Vz km/s', placeholder: 'Vz (km/s)' },
]

/** Initial covariance diagonal labels (variance per component). */
const P0_LABELS = [
  'P0 variance X (km^2)',
  'P0 variance Y (km^2)',
  'P0 variance Z (km^2)',
  'P0 variance Vx ((km/s)^2)',
  'P0 variance Vy ((km/s)^2)',
  'P0 variance Vz ((km/s)^2)',
]

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

/** True when a draft burn row parses to a valid epoch and finite dv. */
function draftBurnValid(row: ManeuverRowDraft): boolean {
  if (datetimeLocalToJd(row.epoch) == null) return false
  return row.dv.every((v) => v.trim() !== '' && Number.isFinite(Number(v)))
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

/** Format a formal sigma: positions 3 decimals, velocities 6 or scientific. */
function formatSigma(value: number, isPosition: boolean): string {
  if (isPosition) return value.toFixed(3)
  const abs = Math.abs(value)
  if (abs === 0) return '0'
  if (abs < 1e-4 || abs >= 1e6) return value.toExponential(3)
  return value.toFixed(6)
}

// =============================================================================
// Panel
// =============================================================================

/**
 * Sequential EKF OD panel (Phase 4). Input tab wires observations, a filter
 * start epoch, an initial state guess, and filter config into runEkf;
 * Results tab reports status, the final state and sigmas, filter-health
 * stats, maneuver records, and the NIS and covariance plots.
 */
export function EkfPanel() {
  const [activeTab, setActiveTab] = useState<EkfTab>('input')
  const [runError, setRunError] = useState<string | null>(null)
  // NIS gate sigma of the last run; the Results NIS plot gates at its square.
  const [lastRunGateSigma, setLastRunGateSigma] = useState(
    () => getEkfConfigDefaults().maneuver.nisSigmaThreshold
  )

  const runEkf = useODStore((s) => s.runEkf)
  const clearScheduledManeuvers = useODStore((s) => s.clearScheduledManeuvers)
  const addScheduledManeuver = useODStore((s) => s.addScheduledManeuver)
  const ekfResult = useODStore((s) => s.ekfResult)

  const handleRun = (request: EkfRunRequest) => {
    setRunError(null)
    // Submit the draft burns through the store (ascending-epoch invariant),
    // then hand the whole request to the solver.
    clearScheduledManeuvers()
    for (const maneuver of request.maneuvers) {
      addScheduledManeuver(maneuver)
    }
    setLastRunGateSigma(request.gateSigma)
    runEkf(request.state0, request.epochJd, request.config)
    const result = useODStore.getState().ekfResult
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

      {activeTab === 'results' && (
        <ResultsTab ekfResult={ekfResult} gateSigma={lastRunGateSigma} />
      )}
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
  onRun: (request: EkfRunRequest) => void
}) {
  const stations = useODStore((s) => s.stations)
  const observations = useODStore((s) => s.observations)
  const iodResult = useODStore((s) => s.iodResult)
  const batchResult = useODStore((s) => s.batchResult)
  const ekfIsRunning = useODStore((s) => s.ekfIsRunning)
  const ekfProgress = useODStore((s) => s.ekfProgress)
  const addStation = useODStore((s) => s.addStation)
  const setObservations = useODStore((s) => s.setObservations)
  const clearObservations = useODStore((s) => s.clearObservations)
  const clearEkfResult = useODStore((s) => s.clearEkfResult)
  const setSimConfig = useODStore((s) => s.setSimConfig)

  const satellites = useMissionStore((s) => s.satellites)
  const selectedSatelliteId = useMissionStore((s) => s.selectedSatelliteId)

  const propagatable = satellites.filter((s) => s.handle != null)
  const selectedSat = satellites.find((s) => s.id === selectedSatelliteId)
  const selectedSatReady = selectedSat != null && selectedSat.handle != null

  // Kernel defaults seed every config input (WASM-first with TS fallback).
  const defaults = getEkfConfigDefaults()

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
  const [guessMode, setGuessMode] = useState<GuessMode>(() => {
    if (useODStore.getState().iodResult) return 'iod'
    if (useODStore.getState().batchResult) return 'batch'
    return 'custom'
  })
  const [customGuess, setCustomGuess] = useState<string[]>(() => Array(6).fill(''))

  // Force model tier (defaults to J2, matching the kernel default).
  const [forceTier, setForceTier] = useState<ForceTier>(() =>
    defaults.forceTier === 0 ? 'two_body' : 'j2'
  )

  // EKF config (collapsible), seeded once from the kernel defaults.
  const [qA, setQA] = useState(() => String(defaults.process.qA))
  const [qAManeuver, setQAManeuver] = useState(() => String(defaults.process.qAManeuver))
  const [gateSigma, setGateSigma] = useState(() => String(defaults.maneuver.nisSigmaThreshold))
  const [p0Inputs, setP0Inputs] = useState<string[]>(() =>
    defaults.p0Diag.map((v) => String(v))
  )

  // Maneuver detection (collapsible).
  const [detectEnabled, setDetectEnabled] = useState(
    () => defaults.maneuver.estimateManeuver
  )
  const [consecutiveExceed, setConsecutiveExceed] = useState(() =>
    String(defaults.maneuver.consecutiveExceedances)
  )
  const [reentryWindow, setReentryWindow] = useState(() =>
    String(defaults.maneuver.reentryWindowObs)
  )

  // Scheduled maneuvers: local draft rows submitted to the store on Run.
  const [burnRows, setBurnRows] = useState<ManeuverRowDraft[]>([])

  // Divergence recovery (collapsible).
  const [sustainedCount, setSustainedCount] = useState(() =>
    String(defaults.recovery.sustainedNisCount)
  )
  const [inflateFactor, setInflateFactor] = useState(() =>
    String(defaults.recovery.inflateFactor)
  )

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
  } else if (guessMode === 'batch') {
    guess = batchResult && batchResult.state.length === 6 ? [...batchResult.state] : null
  } else if (guessMode === 'custom') {
    guess = parseSix(customGuess)
  } else {
    if (selectedSatReady && epochJd != null) {
      const state = sgp4Propagate(selectedSat!.handle!, epochJd)
      guess = state ? [state.x, state.y, state.z, state.vx, state.vy, state.vz] : null
    }
  }

  const qANum = Number(qA)
  const qAManeuverNum = Number(qAManeuver)
  const gateSigmaNum = Number(gateSigma)
  const p0Values = parseSix(p0Inputs)
  const configValid =
    Number.isFinite(qANum) &&
    qANum > 0 &&
    Number.isFinite(qAManeuverNum) &&
    qAManeuverNum > 0 &&
    Number.isFinite(gateSigmaNum) &&
    gateSigmaNum > 0 &&
    p0Values != null &&
    p0Values.every((v) => v > 0)

  const consecutiveNum = Number(consecutiveExceed)
  const reentryNum = Number(reentryWindow)
  const detectionValid =
    !detectEnabled ||
    (Number.isInteger(consecutiveNum) &&
      consecutiveNum >= 1 &&
      Number.isInteger(reentryNum) &&
      reentryNum >= 1)

  const sustainedNum = Number(sustainedCount)
  const inflateNum = Number(inflateFactor)
  const recoveryValid =
    Number.isInteger(sustainedNum) &&
    sustainedNum >= 1 &&
    Number.isFinite(inflateNum) &&
    inflateNum > 1

  const burnsValid = burnRows.every(draftBurnValid)

  const canRun =
    obsCount > 0 &&
    epochJd != null &&
    guess != null &&
    !ekfIsRunning &&
    configValid &&
    detectionValid &&
    recoveryValid &&
    burnsValid

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
      setSimMessage({
        kind: 'error',
        text: 'Arc length and cadence must be positive; noise cannot be negative',
      })
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
    const noiseScale = ((noiseArcsec * DEG_TO_RAD) / 3600) / SIGMA_ANGLES_RAD
    const all: ODObservation[] = []
    for (const station of chosen) {
      const obs = simulateObservations(station.handle!, truthStates, {
        noiseScale,
        seed: 42,
        stationId: station.id,
        obsTypes: EKF_OBS_TYPES,
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
    clearEkfResult()
    setSimConfig({ arcHours, cadenceSec, noiseScale })
    setEpochOverride(null)
    setSimMessage({
      kind: 'ok',
      text: `Generated ${all.length} observations (${truthStates.length} epochs x ${chosen.length} station${chosen.length === 1 ? '' : 's'})`,
    })
  }

  const handleToggleDetection = () => {
    const next = !detectEnabled
    if (!next) {
      // Restore kernel defaults so disabled values never leak into a run.
      setConsecutiveExceed(String(defaults.maneuver.consecutiveExceedances))
      setReentryWindow(String(defaults.maneuver.reentryWindowObs))
    }
    setDetectEnabled(next)
  }

  const handleAddBurnRow = () => {
    setBurnRows((prev) => [
      ...prev,
      { epoch: epochStr, dv: ['0', '0', '0'] },
    ])
  }

  const handleRemoveBurnRow = (index: number) => {
    setBurnRows((prev) => prev.filter((_, i) => i !== index))
  }

  const handleBurnRowChange = (
    index: number,
    patch: Partial<ManeuverRowDraft>
  ) => {
    setBurnRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row))
    )
  }

  const handleBurnDvChange = (index: number, axis: 0 | 1 | 2, value: string) => {
    setBurnRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row
        const dv: [string, string, string] = [...row.dv]
        dv[axis] = value
        return { ...row, dv }
      })
    )
  }

  const handleRun = () => {
    if (epochJd == null || guess == null || !configValid || !detectionValid || !recoveryValid) {
      return
    }
    if (!burnsValid) return
    const config: Partial<EkfTsConfig> = {
      process: { qA: qANum, qAManeuver: qAManeuverNum },
      maneuver: {
        estimateManeuver: detectEnabled,
        nisSigmaThreshold: gateSigmaNum,
        consecutiveExceedances: consecutiveNum,
        reentryWindowObs: reentryNum,
        // Not user-exposed; the kernel default velocity inflation at burns.
        scheduledInflateKms: defaults.maneuver.scheduledInflateKms,
      },
      recovery: {
        sustainedNisCount: sustainedNum,
        inflateFactor: inflateNum,
      },
      p0Diag: p0Values!,
      forceTier: forceTier === 'j2' ? 1 : 0,
    }
    // Draft rows are already validated; parse and sort ascending by epoch
    // (the kernel requirement) before submitting.
    const maneuvers: ScheduledManeuver[] = []
    for (const row of burnRows) {
      const jd = datetimeLocalToJd(row.epoch)
      if (jd == null) continue
      maneuvers.push({
        epochJd: jd,
        dv: [Number(row.dv[0]), Number(row.dv[1]), Number(row.dv[2])],
      })
    }
    maneuvers.sort((a, b) => a.epochJd - b.epochJd)
    onRun({ state0: guess, epochJd, config, maneuvers, gateSigma: gateSigmaNum })
  }

  // Blocking-condition hints shown under the Run button.
  const blockers: string[] = []
  if (obsCount === 0) blockers.push('Add or generate observations to enable the solver')
  if (epochJd == null && obsCount > 0) blockers.push('Estimation epoch is invalid')
  if (guessMode === 'iod' && guess == null) {
    blockers.push('Run Gauss IOD first to seed the EKF')
  }
  if (guessMode === 'batch' && guess == null) {
    blockers.push('Run a batch solve first to seed the EKF')
  }
  if (guessMode === 'custom' && guess == null) {
    blockers.push('Enter all 6 custom state components')
  }
  if (guessMode === 'satellite' && guess == null) {
    blockers.push(
      selectedSatReady
        ? 'The selected satellite could not be propagated at the estimation epoch'
        : 'Select a satellite in the mission list'
    )
  }
  if (!configValid) {
    blockers.push(
      'q_a and q_a_maneuver must be positive; the NIS gate sigma must be positive; P0 variances must be positive'
    )
  }
  if (!detectionValid) {
    blockers.push('Consecutive exceedances and the reentry window must be whole numbers of at least 1')
  }
  if (!recoveryValid) {
    blockers.push('Sustained NIS count must be a whole number of at least 1; the inflate factor must exceed 1')
  }
  if (!burnsValid) {
    blockers.push('Each scheduled maneuver needs a valid epoch and finite dv components')
  }

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
                clearEkfResult()
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
            ? 'Defaults to the first observation epoch; the filter starts here'
            : 'The initial state guess must refer to this epoch'}
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
              name="ekf-guess-mode"
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
              Run Gauss IOD first to seed the EKF
            </div>
          )}
          <label
            className={`flex items-center gap-2 text-[10px] font-mono cursor-pointer ${
              batchResult ? 'text-white' : 'text-comment opacity-60 cursor-not-allowed'
            }`}
          >
            <input
              type="radio"
              name="ekf-guess-mode"
              checked={guessMode === 'batch'}
              onChange={() => setGuessMode('batch')}
              disabled={!batchResult}
              aria-label="From batch result"
              className="accent-neon-purple"
            />
            From batch result
          </label>
          {!batchResult && (
            <div className="text-[9px] font-mono text-comment pl-5">
              Run a batch solve first to seed the EKF
            </div>
          )}
          <label className="flex items-center gap-2 text-[10px] font-mono text-white cursor-pointer">
            <input
              type="radio"
              name="ekf-guess-mode"
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
              name="ekf-guess-mode"
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
        {guessMode === 'iod' && iodResult && (
          <div className="text-[10px] font-mono text-neon-cyan">
            Gauss IOD state vector at its estimation epoch
          </div>
        )}
        {guessMode === 'batch' && batchResult && (
          <div className="text-[10px] font-mono text-neon-cyan">
            Batch solution state vector at its solve epoch
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
            name="ekf-force-tier"
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
            name="ekf-force-tier"
            checked={forceTier === 'j2'}
            onChange={() => setForceTier('j2')}
            aria-label="J2"
            className="accent-neon-purple"
          />
          J2
        </label>
      </div>

      {/* EKF config */}
      <MiniSection label="EKF Config">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="text-[9px] font-mono text-comment block mb-0.5">
              q_a (km^2/s^5)
            </label>
            <input
              type="number"
              step="any"
              min={0}
              value={qA}
              onChange={(e) => setQA(e.target.value)}
              aria-label="Process noise q_a"
              className="input-field w-full text-[10px]"
            />
          </div>
          <div>
            <label className="text-[9px] font-mono text-comment block mb-0.5">
              q_a_maneuver (km^2/s^5)
            </label>
            <input
              type="number"
              step="any"
              min={0}
              value={qAManeuver}
              onChange={(e) => setQAManeuver(e.target.value)}
              aria-label="Process noise q_a_maneuver"
              className="input-field w-full text-[10px]"
            />
          </div>
        </div>
        <div>
          <label className="text-[9px] font-mono text-comment block mb-0.5">NIS gate sigma</label>
          <input
            type="number"
            step="any"
            min={0}
            value={gateSigma}
            onChange={(e) => setGateSigma(e.target.value)}
            aria-label="NIS gate sigma"
            className="input-field w-full text-[10px]"
          />
        </div>
        <div className="text-[9px] font-mono text-comment">
          White-noise acceleration PSD for the 6D and 9D modes; the NIS gate is the square of the
          gate sigma.
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {P0_LABELS.map((aria, i) => (
            <input
              key={aria}
              type="number"
              step="any"
              min={0}
              value={p0Inputs[i]}
              onChange={(e) =>
                setP0Inputs((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
              }
              aria-label={aria}
              className="input-field w-full text-[10px]"
            />
          ))}
        </div>
        <div className="text-[9px] font-mono text-comment">
          Initial covariance diagonal applied at the estimation epoch.
        </div>
      </MiniSection>

      {/* Maneuver detection */}
      <MiniSection label="Maneuver Detection">
        <label className="flex items-center gap-2 text-[10px] font-mono text-white cursor-pointer">
          <input
            type="checkbox"
            checked={detectEnabled}
            onChange={handleToggleDetection}
            aria-label="Enable maneuver detection"
            className="accent-neon-purple"
          />
          Enable maneuver detection
        </label>
        <div className="text-[9px] font-mono text-comment">
          Enters 9D augmented mode when the NIS gate flags enough consecutive exceedances.
        </div>
        {detectEnabled && (
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="text-[9px] font-mono text-comment block mb-0.5">
                Consecutive exceedances
              </label>
              <input
                type="number"
                step={1}
                min={1}
                value={consecutiveExceed}
                onChange={(e) => setConsecutiveExceed(e.target.value)}
                aria-label="Consecutive exceedances"
                className="input-field w-full text-[10px]"
              />
            </div>
            <div>
              <label className="text-[9px] font-mono text-comment block mb-0.5">
                Reentry window (obs)
              </label>
              <input
                type="number"
                step={1}
                min={1}
                value={reentryWindow}
                onChange={(e) => setReentryWindow(e.target.value)}
                aria-label="Reentry window"
                className="input-field w-full text-[10px]"
              />
            </div>
          </div>
        )}
      </MiniSection>

      {/* Scheduled maneuvers */}
      <MiniSection label="Scheduled Maneuvers">
        <div className="text-[9px] font-mono text-comment">
          Known impulsive burns applied mid-predict. Epochs must fall inside the observation arc.
        </div>
        {burnRows.length === 0 && (
          <div className="text-[10px] font-mono text-comment">
            No scheduled burns. Add a row for each known impulsive maneuver.
          </div>
        )}
        {burnRows.map((row, i) => {
          const valid = draftBurnValid(row)
          return (
            <div
              key={i}
              className={`space-y-1.5 p-1.5 border ${valid ? 'border-dust' : 'border-neon-red/50'}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-mono text-comment uppercase">
                  Burn {i + 1}
                </span>
                <button
                  onClick={() => handleRemoveBurnRow(i)}
                  aria-label={`Remove maneuver ${i + 1}`}
                  className="text-[9px] font-mono text-neon-orange hover:text-neon-red transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
                >
                  Remove
                </button>
              </div>
              <input
                type="datetime-local"
                step={60}
                value={row.epoch}
                onChange={(e) => handleBurnRowChange(i, { epoch: e.target.value })}
                aria-label={`Maneuver ${i + 1} epoch UTC`}
                className="input-field w-full text-[10px]"
                style={{ colorScheme: 'dark' }}
              />
              <div className="grid grid-cols-3 gap-1.5">
                {(['X', 'Y', 'Z'] as const).map((axis, axisIdx) => (
                  <input
                    key={axis}
                    type="number"
                    step="any"
                    value={row.dv[axisIdx]}
                    onChange={(e) =>
                      handleBurnDvChange(i, axisIdx as 0 | 1 | 2, e.target.value)
                    }
                    aria-label={`Maneuver ${i + 1} dv ${axis} km/s`}
                    placeholder={`dv${axis} (km/s)`}
                    className="input-field w-full text-[10px]"
                  />
                ))}
              </div>
            </div>
          )
        })}
        <button
          onClick={handleAddBurnRow}
          className="btn-secondary w-full text-[10px] font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
        >
          Add Maneuver
        </button>
      </MiniSection>

      {/* Divergence recovery */}
      <MiniSection label="Divergence Recovery">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="text-[9px] font-mono text-comment block mb-0.5">
              Sustained NIS count
            </label>
            <input
              type="number"
              step={1}
              min={1}
              value={sustainedCount}
              onChange={(e) => setSustainedCount(e.target.value)}
              aria-label="Sustained NIS count"
              className="input-field w-full text-[10px]"
            />
          </div>
          <div>
            <label className="text-[9px] font-mono text-comment block mb-0.5">
              Inflate factor
            </label>
            <input
              type="number"
              step="any"
              min={0}
              value={inflateFactor}
              onChange={(e) => setInflateFactor(e.target.value)}
              aria-label="Inflate factor"
              className="input-field w-full text-[10px]"
            />
          </div>
        </div>
        <div className="text-[9px] font-mono text-comment">
          Sustained NIS exceedances inflate the whole covariance by this factor to recover.
        </div>
      </MiniSection>

      {/* Run */}
      <div className="border-t border-dust pt-2 space-y-2">
        <button
          onClick={handleRun}
          disabled={!canRun}
          className="btn-primary w-full text-[11px] font-mono disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
        >
          {ekfIsRunning ? 'Running EKF...' : 'Run EKF'}
        </button>
        {ekfIsRunning && ekfProgress > 0 && ekfProgress < 100 && (
          <div
            role="progressbar"
            aria-label="EKF solve progress"
            aria-valuenow={ekfProgress}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1 w-full bg-black/30 overflow-hidden"
          >
            <div
              className="h-full bg-neon-purple transition-all"
              style={{ width: `${ekfProgress}%` }}
            />
          </div>
        )}
        <div className="text-[9px] font-mono text-comment">
          {obsCount} observation{obsCount === 1 ? '' : 's'} from {stationCount} station
          {stationCount === 1 ? '' : 's'}, ~{scalarRows} scalar rows
          {burnRows.length > 0 &&
            `, ${burnRows.length} scheduled burn${burnRows.length === 1 ? '' : 's'}`}
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

function ResultsTab({
  ekfResult,
  gateSigma,
}: {
  ekfResult: EkfTsResult | null
  gateSigma: number
}) {
  const clearEkfResult = useODStore((s) => s.clearEkfResult)

  if (!ekfResult) {
    return (
      <div className="text-[10px] font-mono text-comment">
        Run an EKF solve to see filter health and covariance
      </div>
    )
  }

  const ok = ekfResult.errorStatus === EKF_STATUS.OK
  const badge = ok
    ? { label: 'OK', className: 'bg-neon-green/20 text-neon-green' }
    : { label: 'ERROR', className: 'bg-neon-red/20 text-neon-red' }

  const state = ekfResult.finalState
  const r: [number, number, number] = [state[0] ?? 0, state[1] ?? 0, state[2] ?? 0]
  const v: [number, number, number] = [state[3] ?? 0, state[4] ?? 0, state[5] ?? 0]
  const elements = ok ? deriveElements(r, v) : null
  const sigmas = ekfResult.finalCovDiag.map((d) => Math.sqrt(Math.max(d, 0)))
  const maneuverStepCount = ekfResult.steps.filter((step) => step.maneuverFlag).length
  const stats = ekfResult.stats

  return (
    <div className="space-y-3">
      {/* Status badge */}
      <div className="flex items-center gap-2">
        <span className={`px-2 py-0.5 text-[9px] font-mono uppercase ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      <div className={`text-[10px] font-mono ${ok ? 'text-neon-green' : 'text-neon-red'}`}>
        {ekfResult.statusMessage}
      </div>
      {!ok && (
        <div className="text-[10px] font-mono text-neon-orange">
          Check the observation arc, the initial guess, and the force model, then run again
        </div>
      )}

      {/* State vector */}
      {ok ? (
        <div className="space-y-2 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            State Vector (last update)
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
          <div className="text-[9px] font-mono text-comment">
            Position km, velocity km/s, ECI/TEME
          </div>
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

      {/* Final sigmas */}
      {ok && sigmas.length === 6 && (
        <div className="space-y-1 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Final Sigmas
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

      {/* Filter stats */}
      <div className="space-y-1 border-t border-dust pt-2">
        <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
          Filter Stats
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
          <div>
            <span className="text-comment">Updates:</span>{' '}
            <span className="text-white">
              {stats.nUpdated} / {stats.nRows}
            </span>
          </div>
          <div>
            <span className="text-comment">Gated:</span>{' '}
            <span className="text-white">{stats.nGated}</span>
          </div>
          <div>
            <span className="text-comment">Maneuver steps:</span>{' '}
            <span className="text-white">{maneuverStepCount}</span>
          </div>
          <div>
            <span className="text-comment">Recoveries:</span>{' '}
            <span className="text-white">{stats.nRecoveries}</span>
          </div>
          <div>
            <span className="text-comment">Augmented:</span>{' '}
            <span
              className={stats.augmentedActiveFinal ? 'text-neon-yellow' : 'text-comment'}
            >
              {stats.augmentedActiveFinal ? 'ACTIVE' : 'inactive'}
            </span>
          </div>
        </div>
      </div>

      {/* Maneuver records */}
      {ekfResult.maneuverRecords.length > 0 && (
        <div className="space-y-1 border-t border-dust pt-2">
          <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Maneuver Records
          </div>
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-comment text-left">
                <th className="py-0.5 font-normal">Epoch (UTC)</th>
                <th className="py-0.5 font-normal">dvx</th>
                <th className="py-0.5 font-normal">dvy</th>
                <th className="py-0.5 font-normal">dvz</th>
                <th className="py-0.5 font-normal text-right">|dv| (m/s)</th>
              </tr>
            </thead>
            <tbody>
              {ekfResult.maneuverRecords.map((record, i) => (
                <tr key={i} className="text-white">
                  <td className="py-0.5">{jdToDatetimeLocal(record.epochJd)}</td>
                  <td className="text-neon-cyan">{record.dv[0].toFixed(6)}</td>
                  <td className="text-neon-cyan">{record.dv[1].toFixed(6)}</td>
                  <td className="text-neon-cyan">{record.dv[2].toFixed(6)}</td>
                  <td className="text-right text-neon-orange">
                    {(Math.hypot(record.dv[0], record.dv[1], record.dv[2]) * 1000).toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* NIS plot */}
      <div className="space-y-1.5 border-t border-dust pt-2">
        <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
          NIS Gate
        </div>
        <NisPlot
          steps={ekfResult.steps}
          gateThreshold={gateSigma * gateSigma}
          showManeuverMarkers
          title="Normalized innovation squared"
        />
        <div className="text-[9px] font-mono text-comment">
          Points above the dashed gate line are flagged for gating; orange markers are maneuver
          steps
        </div>
      </div>

      {/* Covariance plot */}
      <div className="space-y-1.5 border-t border-dust pt-2">
        <div className="text-[10px] font-mono text-comment uppercase tracking-wider">
          Covariance History
        </div>
        <CovariancePlot steps={ekfResult.steps} title="Formal sigmas" />
        <div className="text-[9px] font-mono text-comment">
          Position sigmas in km on top, velocity sigmas in km/s below, log scale
        </div>
      </div>

      {/* Clear */}
      <button
        onClick={clearEkfResult}
        className="btn-secondary w-full text-[10px] font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
      >
        Clear result
      </button>
    </div>
  )
}
