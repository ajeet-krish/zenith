import { useRef, useState } from 'react';
import { useODStore } from '@/store/useODStore';
import {
  GOLDSTONE,
  ARECIBO,
  TROMSOE,
  radToDeg,
  type CanonicalStation,
} from '@/orbit/odConstants';
import { DEG_TO_RAD } from '@/orbit/constants';
import {
  parseObservationCsv,
  parseObservationJson,
  type ImportedStationDef,
} from '@/orbit/observationImport';
import type { ODSceneToggles } from '@/store/useODStore';

// =============================================================================
// Types and helpers
// =============================================================================

/** Canonical quick-add stations (same trio as IodPanel). */
const QUICK_ADD: CanonicalStation[] = [GOLDSTONE, ARECIBO, TROMSOE]

/** Reject observation files larger than this before reading them (10 MB). */
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024

const QUICK_ADD_LABELS: Record<string, string> = {
  goldstone: 'Goldstone',
  arecibo: 'Arecibo',
  tromsoe: 'Tromsoe',
}

/** Result of applyImportObservationText, shown in the panel's import log. */
export interface ObservationImportSummary {
  imported: number
  stationNamesAdded: string[]
  /** JSON embedded stations whose name matched an existing store station (kept as-is). */
  stationNamesKept: string[]
  errors: string[]
}

/**
 * Parse observation text, merge referenced stations into the OD store, and
 * replace the store's observation list (setObservations replace mode).
 *
 * Parsed observations reference stations by NAME; this remaps each to the
 * matching store station id, adding any station the store has not seen yet
 * (WASM handle lifecycle stays inside addStation). Exported so tests can
 * drive the import path directly on text, without a File.
 */
export function applyImportObservationText(
  text: string,
  format: 'csv' | 'json'
): ObservationImportSummary {
  const store = useODStore.getState()
  const available: ImportedStationDef[] = store.stations.map((s) => ({
    name: s.name,
    latRad: s.latRad,
    lonRad: s.lonRad,
    altKm: s.altKm,
  }))
  const parsed =
    format === 'json' ? parseObservationJson(text, available) : parseObservationCsv(text, available)

  // Merge referenced stations: reuse by case-insensitive name, else add.
  // When a JSON file embeds a def for a station the store already has, the
  // store definition wins (no mutation); report it in the import log.
  const nameToId = new Map<string, string>()
  const stationNamesAdded: string[] = []
  const stationNamesKept: string[] = []
  for (const def of parsed.stations) {
    const key = def.name.trim().toLowerCase()
    const existing = useODStore
      .getState()
      .stations.find((s) => s.name.trim().toLowerCase() === key)
    if (existing) {
      nameToId.set(key, existing.id)
      if (parsed.overriddenStations.some((n) => n.trim().toLowerCase() === key)) {
        stationNamesKept.push(existing.name)
      }
      continue
    }
    useODStore.getState().addStation(def.name, def.latRad, def.lonRad, def.altKm)
    stationNamesAdded.push(def.name)
    const created = useODStore
      .getState()
      .stations.find((s) => s.name.trim().toLowerCase() === key)
    if (created) nameToId.set(key, created.id)
  }

  const remapped = parsed.observations.map((obs) => ({
    ...obs,
    stationId: nameToId.get(obs.stationId.trim().toLowerCase()) ?? obs.stationId,
  }))
  useODStore.getState().setObservations(remapped)

  return { imported: remapped.length, stationNamesAdded, stationNamesKept, errors: parsed.errors }
}

/** Scene toggle rows: store key, user-facing label, and what it draws. */
const TOGGLE_ROWS: { key: keyof ODSceneToggles; label: string; hint: string }[] = [
  { key: 'trajectory', label: 'OD trajectory', hint: 'EKF filter path, or batch estimated orbit' },
  { key: 'stations', label: 'Ground stations', hint: 'Station markers at the current epoch' },
  { key: 'losRays', label: 'LOS rays', hint: 'Station-to-satellite lines, up to 50' },
  { key: 'covarianceEllipsoid', label: 'Covariance ellipsoid', hint: '3-sigma position uncertainty' },
]

const CSV_SAMPLE = [
  'epoch_jd,station,obs_type,value1,value2,sigma1,sigma2',
  '2460310.5,goldstone,range,1523.412,,0.001,',
  '2460310.6,goldstone,ra_dec,1.8342,-0.5128,,',
].join('\n')

const JSON_SAMPLE = [
  '{',
  '  "observations": [',
  '    { "epoch_jd": 2460310.5, "station": "goldstone", "obs_type": "range", "values": [1523.412] }',
  '  ],',
  '  "stations": [',
  '    { "name": "goldstone", "lat_rad": 0.6187, "lon_rad": -2.0387, "alt_km": 1.0 }',
  '  ]',
  '}',
].join('\n')

/** Manual-add form state (strings so fields can be empty while typing). */
interface ManualStationForm {
  name: string
  latDeg: string
  lonDeg: string
  altKm: string
}

const EMPTY_FORM: ManualStationForm = { name: '', latDeg: '', lonDeg: '', altKm: '0' }

// =============================================================================
// Panel
// =============================================================================

/**
 * ObservationPanel - ground stations, observation data, and scene layers
 * for orbit determination.
 *
 * Stations and observations feed Gauss IOD, batch least-squares, and the
 * EKF. Observations arrive via CSV/JSON import (the parsers live in
 * src/orbit/observationImport.ts). Scene toggles control which OD overlays
 * the 3D scene draws.
 */
export function ObservationPanel() {
  const stations = useODStore((s) => s.stations)
  const observations = useODStore((s) => s.observations)
  const sceneToggles = useODStore((s) => s.sceneToggles)
  const addStation = useODStore((s) => s.addStation)
  const removeStation = useODStore((s) => s.removeStation)
  const clearObservations = useODStore((s) => s.clearObservations)
  const setSceneToggle = useODStore((s) => s.setSceneToggle)

  const [form, setForm] = useState<ManualStationForm>({ ...EMPTY_FORM })
  const [formError, setFormError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<
    (ObservationImportSummary & { source: string }) | null
  >(null)

  const csvInputRef = useRef<HTMLInputElement>(null)
  const jsonInputRef = useRef<HTMLInputElement>(null)

  const handleQuickAdd = (station: CanonicalStation) => {
    if (stations.some((s) => s.name.trim().toLowerCase() === station.name)) return
    addStation(station.name, station.latRad, station.lonRad, station.altKm)
  }

  const handleManualAdd = () => {
    setFormError(null)
    const name = form.name.trim()
    const lat = Number(form.latDeg)
    const lon = Number(form.lonDeg)
    const alt = Number(form.altKm)
    if (name === '') {
      setFormError('Station name is required')
      return
    }
    if (stations.some((s) => s.name.trim().toLowerCase() === name.toLowerCase())) {
      setFormError(`A station named '${name}' already exists`)
      return
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      setFormError('Latitude must be a number between -90 and 90 deg')
      return
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      setFormError('Longitude must be a number between -180 and 180 deg')
      return
    }
    if (!Number.isFinite(alt)) {
      setFormError('Altitude must be a number in km')
      return
    }
    addStation(name, lat * DEG_TO_RAD, lon * DEG_TO_RAD, alt)
    setForm({ ...EMPTY_FORM })
  }

  const handleFile = (file: File, format: 'csv' | 'json') => {
    // Size guard before reading: a 10 MB text file is already far past any
    // realistic observation set, and parsing beyond that stalls the UI thread.
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setImportResult({
        imported: 0,
        stationNamesAdded: [],
        stationNamesKept: [],
        errors: [
          `File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB); the limit is 10 MB`,
        ],
        source: file.name,
      })
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      const summary = applyImportObservationText(text, format)
      setImportResult({ ...summary, source: file.name })
    }
    reader.onerror = () => {
      setImportResult({
        imported: 0,
        stationNamesAdded: [],
        stationNamesKept: [],
        errors: [`Could not read file '${file.name}'`],
        source: file.name,
      })
    }
    reader.readAsText(file)
  }

  return (
    <div className="space-y-3">
      {/* Stations */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Stations
          </span>
          <span className="text-[9px] font-mono text-comment">{stations.length}</span>
        </div>

        <div className="flex gap-1 mb-2">
          {QUICK_ADD.map((station) => {
            const added = stations.some(
              (s) => s.name.trim().toLowerCase() === station.name
            )
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
            Add a ground station to observe from
          </div>
        ) : (
          <div className="space-y-1 mb-2">
            {stations.map((station) => (
              <div
                key={station.id}
                className="flex items-center justify-between bg-black/30 px-2 py-1"
              >
                <span className="text-[10px] font-mono text-white">{station.name}</span>
                <span className="text-[9px] font-mono text-comment">
                  {radToDeg(station.latRad).toFixed(2)} deg,{' '}
                  {radToDeg(station.lonRad).toFixed(2)} deg
                </span>
                <button
                  onClick={() => removeStation(station.id)}
                  aria-label={`Remove station ${station.name}`}
                  className="text-[9px] font-mono text-neon-red hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
                >
                  remove
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Manual add */}
        <div className="border-t border-dust pt-2 space-y-1.5">
          <span className="text-[9px] font-mono text-comment uppercase tracking-wider">
            Add station
          </span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            aria-label="Station name"
            placeholder="name"
            className="input-field w-full text-[10px]"
          />
          <div className="grid grid-cols-3 gap-1.5">
            <input
              type="number"
              step="any"
              value={form.latDeg}
              onChange={(e) => setForm((f) => ({ ...f, latDeg: e.target.value }))}
              aria-label="Station latitude deg"
              placeholder="lat (deg)"
              className="input-field w-full text-[10px]"
            />
            <input
              type="number"
              step="any"
              value={form.lonDeg}
              onChange={(e) => setForm((f) => ({ ...f, lonDeg: e.target.value }))}
              aria-label="Station longitude deg"
              placeholder="lon (deg)"
              className="input-field w-full text-[10px]"
            />
            <input
              type="number"
              step="any"
              value={form.altKm}
              onChange={(e) => setForm((f) => ({ ...f, altKm: e.target.value }))}
              aria-label="Station altitude km"
              placeholder="alt (km)"
              className="input-field w-full text-[10px]"
            />
          </div>
          <button
            onClick={handleManualAdd}
            className="btn-secondary w-full text-[10px] font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
          >
            Add Station
          </button>
          {formError && (
            <div className="text-[9px] font-mono text-neon-red" role="alert">
              {formError}
            </div>
          )}
        </div>
      </div>

      {/* Observations */}
      <div className="border-t border-dust pt-2">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
            Observations
          </span>
          <span className="text-[9px] font-mono text-comment">{observations.length}</span>
        </div>

        {observations.length === 0 ? (
          <div className="text-[10px] font-mono text-comment mb-2">
            No observations yet. Import a CSV or JSON file below.
          </div>
        ) : (
          <button
            onClick={() => {
              clearObservations()
              setImportResult(null)
            }}
            className="btn-secondary w-full text-[10px] font-mono mb-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
          >
            Clear Observations
          </button>
        )}

        <div className="flex gap-1">
          <button
            onClick={() => csvInputRef.current?.click()}
            className="btn-secondary flex-1 text-[10px] font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
          >
            Import CSV
          </button>
          <button
            onClick={() => jsonInputRef.current?.click()}
            className="btn-secondary flex-1 text-[10px] font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60"
          >
            Import JSON
          </button>
        </div>
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          aria-label="Import observations from file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file, 'csv')
            e.target.value = ''
          }}
        />
        <input
          ref={jsonInputRef}
          type="file"
          accept=".json"
          className="hidden"
          aria-label="Import observations from JSON file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file, 'json')
            e.target.value = ''
          }}
        />

        {/* Import log: parse report, like a mission console line */}
        {importResult && (
          <div className="mt-2 bg-black/40 p-2" role="status">
            <div className="text-[9px] font-mono text-neon-green">
              Imported {importResult.imported} observation{importResult.imported === 1 ? '' : 's'}{' '}
              from {importResult.source}
            </div>
            {importResult.stationNamesAdded.length > 0 && (
              <div className="text-[9px] font-mono text-neon-cyan">
                Added stations: {importResult.stationNamesAdded.join(', ')}
              </div>
            )}
            {importResult.stationNamesKept.length > 0 && (
              <div className="text-[9px] font-mono text-neon-yellow">
                Kept existing definitions: {importResult.stationNamesKept.join(', ')}
              </div>
            )}
            {importResult.errors.length > 0 && (
              <pre className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap text-[9px] font-mono text-neon-red">
                {importResult.errors.join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Scene toggles */}
      <div className="border-t border-dust pt-2">
        <div className="text-[10px] font-mono text-comment uppercase tracking-wider mb-1.5">
          Scene Layers
        </div>
        <div className="space-y-1">
          {TOGGLE_ROWS.map((row) => (
            <label
              key={row.key}
              className="flex items-center gap-2 text-[10px] font-mono text-white cursor-pointer"
              title={row.hint}
            >
              <input
                type="checkbox"
                checked={sceneToggles[row.key]}
                onChange={(e) => setSceneToggle(row.key, e.target.checked)}
                aria-label={row.label}
                className="accent-neon-purple"
              />
              {row.label}
            </label>
          ))}
        </div>
      </div>

      {/* Sample format hint */}
      <details className="border-t border-dust pt-2">
        <summary className="text-[10px] font-mono text-comment uppercase tracking-wider cursor-pointer hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-purple/60">
          File Format
        </summary>
        <div className="mt-1.5 space-y-1.5">
          <div>
            <div className="text-[9px] font-mono text-comment mb-0.5">CSV</div>
            <pre className="bg-black/40 p-2 text-[9px] font-mono text-white overflow-x-auto whitespace-pre">
              {CSV_SAMPLE}
            </pre>
          </div>
          <div>
            <div className="text-[9px] font-mono text-comment mb-0.5">JSON</div>
            <pre className="bg-black/40 p-2 text-[9px] font-mono text-white overflow-x-auto whitespace-pre">
              {JSON_SAMPLE}
            </pre>
          </div>
          <div className="text-[9px] font-mono text-comment">
            Types: range (value1 = km), range_rate (value1 = km/s), ra_dec (value1 = RA rad,
            value2 = Dec rad). Unknown station names are added automatically when the file
            defines them.
          </div>
        </div>
      </details>
    </div>
  )
}
