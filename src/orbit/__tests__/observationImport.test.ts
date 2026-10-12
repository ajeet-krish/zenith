import { describe, it, expect } from 'vitest'
import {
  parseObservationCsv,
  parseObservationJson,
  MAX_IMPORT_OBS,
  MAX_IMPORT_STATIONS,
} from '../observationImport'
import type { ImportedStationDef } from '../observationImport'
import { DEFAULT_OBS_CONFIG } from '../odConstants'

// =============================================================================
// Fixtures
// =============================================================================

const AVAILABLE: ImportedStationDef[] = [
  { name: 'goldstone', latRad: 0.6178, lonRad: -2.0384, altKm: 1.0 },
  { name: 'tromsoe', latRad: 1.2148, lonRad: 0.3299, altKm: 0.1 },
]

const VALID_CSV = [
  'epoch_jd,station,obs_type,value1,value2,sigma1,sigma2',
  '2460310.5,goldstone,range,6781.234,,1e-3,',
  '2460310.51,goldstone,range_rate,7.6681,,,',
  '2460310.52,tromsoe,ra_dec,1.2345,-0.3210,,',
].join('\n')

// =============================================================================
// parseObservationCsv
// =============================================================================

describe('parseObservationCsv', () => {
  it('parses all supported observation types with defaulted sigmas', () => {
    const result = parseObservationCsv(VALID_CSV, AVAILABLE)
    expect(result.errors).toEqual([])
    expect(result.observations).toHaveLength(3)

    expect(result.observations[0]).toEqual({
      timeJd: 2460310.5,
      stationId: 'goldstone',
      obsType: 'range',
      values: [6781.234],
      sigmas: [1e-3],
    })
    // range_rate row omitted sigmas -> defaults from DEFAULT_OBS_CONFIG.
    expect(result.observations[1]).toEqual({
      timeJd: 2460310.51,
      stationId: 'goldstone',
      obsType: 'range_rate',
      values: [7.6681],
      sigmas: [DEFAULT_OBS_CONFIG.sigmaRangeRateKms],
    })
    // ra_dec row omitted sigmas -> two angle defaults.
    expect(result.observations[2]).toEqual({
      timeJd: 2460310.52,
      stationId: 'tromsoe',
      obsType: 'ra_dec',
      values: [1.2345, -0.321],
      sigmas: [...DEFAULT_OBS_CONFIG.sigmaAnglesRad],
    })
  })

  it('collects referenced station defs in first-reference order', () => {
    const result = parseObservationCsv(VALID_CSV, AVAILABLE)
    expect(result.stations).toEqual([
      { name: 'goldstone', latRad: 0.6178, lonRad: -2.0384, altKm: 1.0 },
      { name: 'tromsoe', latRad: 1.2148, lonRad: 0.3299, altKm: 0.1 },
    ])
    // CSV never embeds station defs, so nothing is ever "overridden".
    expect(result.overriddenStations).toEqual([])
  })

  it('accepts a flexible column order', () => {
    const shuffled = [
      'obs_type,epoch_jd,station,value1',
      'range,2460310.5,goldstone,6781.234',
    ].join('\n')
    const result = parseObservationCsv(shuffled, AVAILABLE)
    expect(result.errors).toEqual([])
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]).toEqual({
      timeJd: 2460310.5,
      stationId: 'goldstone',
      obsType: 'range',
      values: [6781.234],
      sigmas: [DEFAULT_OBS_CONFIG.sigmaRangeKm],
    })
  })

  it('skips comment and blank lines and reports real source line numbers', () => {
    const text = [
      '# exported by the tracking pipeline',
      'epoch_jd,station,obs_type,value1,value2,sigma1,sigma2',
      '',
      '# a comment between rows',
      '2460310.5,unknown_site,range,6781.234,,1e-3,',
      '2460310.51,goldstone,range,6781.235,,1e-3,',
    ].join('\n')
    const result = parseObservationCsv(text, AVAILABLE)
    expect(result.observations).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('line 5')
    expect(result.errors[0]).toContain("unknown station 'unknown_site'")
  })

  it('rejects az_el rows with a clear message', () => {
    const text = [
      'epoch_jd,station,obs_type,value1,value2',
      '2460310.5,goldstone,az_el,1.2,0.5',
    ].join('\n')
    const result = parseObservationCsv(text, AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("obs_type 'az_el'")
    expect(result.errors[0]).toContain('not supported for import')
  })

  it('flags missing value2 for ra_dec as a row error', () => {
    const text = [
      'epoch_jd,station,obs_type,value1,value2',
      '2460310.5,goldstone,ra_dec,1.2345,',
    ].join('\n')
    const result = parseObservationCsv(text, AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('line 2')
    expect(result.errors[0]).toContain('requires value2')
  })

  it('flags an unknown obs_type as a row error and keeps parsing', () => {
    const text = [
      'epoch_jd,station,obs_type,value1',
      '2460310.5,goldstone,doppler,7.6',
      '2460310.51,goldstone,range,6781.2',
    ].join('\n')
    const result = parseObservationCsv(text, AVAILABLE)
    expect(result.observations).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('line 2')
    expect(result.errors[0]).toContain("unknown obs_type 'doppler'")
  })

  it('matches station names case-insensitively', () => {
    const text = [
      'epoch_jd,station,obs_type,value1',
      '2460310.5,GOLDSTONE,range,6781.2',
    ].join('\n')
    const result = parseObservationCsv(text, AVAILABLE)
    expect(result.errors).toEqual([])
    // Canonical casing from the matched def is preserved.
    expect(result.observations[0]!.stationId).toBe('goldstone')
  })

  it('rejects a non-positive or non-finite epoch', () => {
    const text = [
      'epoch_jd,station,obs_type,value1',
      '0,goldstone,range,6781.2',
      'not_a_jd,goldstone,range,6781.2',
    ].join('\n')
    const result = parseObservationCsv(text, AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('line 2')
    expect(result.errors[1]).toContain('line 3')
  })

  it('rejects rows whose value1 overflows to Infinity or is NaN', () => {
    const text = [
      'epoch_jd,station,obs_type,value1',
      '2460310.5,goldstone,range,1e309',
      '2460310.51,goldstone,range,NaN',
      '2460310.52,goldstone,range,6781.2',
      '1e400,goldstone,range,6781.2',
    ].join('\n')
    const result = parseObservationCsv(text, AVAILABLE)
    // Only the finite-value row survives.
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]!.values).toEqual([6781.2])
    // 1e309 and NaN in value1, plus an epoch that overflows to Infinity, are rejected.
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toContain('line 2')
    expect(result.errors[0]).toContain('value1 must be a finite number')
    expect(result.errors[1]).toContain('line 3')
    expect(result.errors[1]).toContain('value1 must be a finite number')
    expect(result.errors[2]).toContain('line 5')
    expect(result.errors[2]).toContain('invalid epoch_jd')
  })

  it('rejects non-positive sigmas as row errors', () => {
    const text = [
      'epoch_jd,station,obs_type,value1,sigma1',
      '2460310.5,goldstone,range,6781.2,-0.001',
    ].join('\n')
    const result = parseObservationCsv(text, AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('sigma1')
  })

  it('errors when the header misses a required column', () => {
    const text = 'epoch_jd,station,value1\n2460310.5,goldstone,6781.2'
    const result = parseObservationCsv(text, AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('obs_type')
  })

  it('errors on empty input', () => {
    const result = parseObservationCsv('', AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('No header row')
  })
})

// =============================================================================
// parseObservationJson
// =============================================================================

describe('parseObservationJson', () => {
  it('parses a valid document with explicit and defaulted sigmas', () => {
    const text = JSON.stringify({
      observations: [
        {
          epoch_jd: 2460310.5,
          station: 'goldstone',
          obs_type: 'range',
          values: [6781.234],
          sigmas: [1e-3],
        },
        {
          epoch_jd: 2460310.51,
          station: 'tromsoe',
          obs_type: 'ra_dec',
          values: [1.2345, -0.321],
        },
      ],
    })
    const result = parseObservationJson(text, AVAILABLE)
    expect(result.errors).toEqual([])
    expect(result.observations).toHaveLength(2)
    expect(result.observations[0]).toEqual({
      timeJd: 2460310.5,
      stationId: 'goldstone',
      obsType: 'range',
      values: [6781.234],
      sigmas: [1e-3],
    })
    expect(result.observations[1]).toEqual({
      timeJd: 2460310.51,
      stationId: 'tromsoe',
      obsType: 'ra_dec',
      values: [1.2345, -0.321],
      sigmas: [...DEFAULT_OBS_CONFIG.sigmaAnglesRad],
    })
  })

  it('overrides available stations with embedded defs of the same name and records them', () => {
    const text = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'tromsoe', obs_type: 'range', values: [6781.234] },
      ],
      stations: [{ name: 'tromsoe', lat_rad: 1.25, lon_rad: 0.35, alt_km: 0.2 }],
    })
    const result = parseObservationJson(text, AVAILABLE)
    expect(result.errors).toEqual([])
    expect(result.stations).toEqual([
      { name: 'tromsoe', latRad: 1.25, lonRad: 0.35, altKm: 0.2 },
    ])
    // The name collision is recorded so the importing panel can report
    // keeping the existing store definition.
    expect(result.overriddenStations).toEqual(['tromsoe'])
  })

  it('records no overridden stations when embedded defs are all new names', () => {
    const text = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'kerguelen', obs_type: 'range', values: [6781.234] },
      ],
      stations: [{ name: 'kerguelen', lat_rad: -0.49, lon_rad: 0.68, alt_km: 0.03 }],
    })
    const result = parseObservationJson(text, AVAILABLE)
    expect(result.errors).toEqual([])
    expect(result.overriddenStations).toEqual([])
  })

  it('augments available stations with new embedded defs', () => {
    const text = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'kerguelen', obs_type: 'range', values: [6781.234] },
        { epoch_jd: 2460310.51, station: 'goldstone', obs_type: 'range', values: [6781.5] },
      ],
      stations: [{ name: 'kerguelen', lat_rad: -0.49, lon_rad: 0.68, alt_km: 0.03 }],
    })
    const result = parseObservationJson(text, AVAILABLE)
    expect(result.errors).toEqual([])
    expect(result.stations).toHaveLength(2)
    expect(result.stations[0]!.name).toBe('kerguelen')
    expect(result.stations[1]!.name).toBe('goldstone')
  })

  it('rejects az_el observations with a clear message', () => {
    const text = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'goldstone', obs_type: 'az_el', values: [1.2, 0.5] },
      ],
    })
    const result = parseObservationJson(text, AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("obs_type 'az_el'")
    expect(result.errors[0]).toContain('not supported for import')
  })

  it('flags a values length mismatch as an observation error and keeps parsing', () => {
    const text = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'goldstone', obs_type: 'ra_dec', values: [1.2345] },
        { epoch_jd: 2460310.51, station: 'goldstone', obs_type: 'range', values: [6781.2] },
      ],
    })
    const result = parseObservationJson(text, AVAILABLE)
    expect(result.observations).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('observations[0]')
    expect(result.errors[0]).toContain('requires exactly 2 value(s)')
  })

  it('flags unknown stations with the observation index', () => {
    const text = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'unknown_site', obs_type: 'range', values: [6781.2] },
      ],
    })
    const result = parseObservationJson(text, AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('observations[0]')
    expect(result.errors[0]).toContain("unknown station 'unknown_site'")
  })

  it('does not pollute Object.prototype via a __proto__ key in an embedded station', () => {
    const text = JSON.stringify({
      observations: [
        { epoch_jd: 2460310.5, station: 'evil', obs_type: 'range', values: [6781.2] },
      ],
      stations: [
        {
          name: 'evil',
          lat_rad: 0.5,
          lon_rad: 0.5,
          alt_km: 0.1,
          __proto__: { polluted: true },
        },
      ],
    })
    const result = parseObservationJson(text, [])
    expect(result.errors).toEqual([])
    expect(result.observations).toHaveLength(1)
    // The station def is normalized to the four known fields; no leaked key.
    expect(result.stations).toEqual([{ name: 'evil', latRad: 0.5, lonRad: 0.5, altKm: 0.1 }])
    // Object.prototype and fresh objects must not gain a 'polluted' property.
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // A spread of the returned def also carries no polluted key.
    expect((({ ...result.stations[0] }) as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('returns an error for malformed JSON text', () => {
    const result = parseObservationJson('{"observations": [', AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Invalid JSON')
  })

  it('returns an error when the observations array is missing', () => {
    const result = parseObservationJson('{"stations": []}', AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Invalid schema')
  })

  it('errors on empty input', () => {
    const result = parseObservationJson('', AVAILABLE)
    expect(result.observations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Invalid JSON')
  })
})

// =============================================================================
// Import caps (reject-all policy)
// =============================================================================

describe('import caps', () => {
  it('rejects a CSV with more than MAX_IMPORT_OBS rows in full', () => {
    const rows = ['epoch_jd,station,obs_type,value1']
    for (let i = 0; i <= MAX_IMPORT_OBS; i += 1) {
      rows.push(`2460310.5,goldstone,range,6781.${String(i).padStart(3, '0')}`)
    }
    const result = parseObservationCsv(rows.join('\n'), AVAILABLE)

    expect(result.observations).toEqual([])
    expect(result.stations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('too many observations')
    expect(result.errors[0]).toContain(String(MAX_IMPORT_OBS))
  })

  it('accepts a CSV with exactly MAX_IMPORT_OBS rows', () => {
    const rows = ['epoch_jd,station,obs_type,value1']
    for (let i = 0; i < MAX_IMPORT_OBS; i += 1) {
      rows.push(`2460310.5,goldstone,range,6781.${String(i).padStart(3, '0')}`)
    }
    const result = parseObservationCsv(rows.join('\n'), AVAILABLE)

    expect(result.errors).toEqual([])
    expect(result.observations).toHaveLength(MAX_IMPORT_OBS)
  })

  it('rejects a JSON with more than MAX_IMPORT_OBS observations in full', () => {
    const observations = Array.from({ length: MAX_IMPORT_OBS + 1 }, (_, i) => ({
      epoch_jd: 2460310.5,
      station: 'goldstone',
      obs_type: 'range',
      values: [6781 + i * 1e-3],
    }))
    const result = parseObservationJson(JSON.stringify({ observations }), AVAILABLE)

    expect(result.observations).toEqual([])
    expect(result.stations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('too many observations')
  })

  it('rejects a JSON embedding more than MAX_IMPORT_STATIONS stations in full', () => {
    const stations = Array.from({ length: MAX_IMPORT_STATIONS + 1 }, (_, i) => ({
      name: `site_${i}`,
      lat_rad: 0.1,
      lon_rad: 0.2,
      alt_km: 0.05,
    }))
    const observations = [
      { epoch_jd: 2460310.5, station: 'site_0', obs_type: 'range', values: [6781.2] },
    ]
    const result = parseObservationJson(JSON.stringify({ observations, stations }), AVAILABLE)

    expect(result.observations).toEqual([])
    expect(result.stations).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('too many embedded stations')
    expect(result.errors[0]).toContain(String(MAX_IMPORT_STATIONS))
  })
})
