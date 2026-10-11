import { describe, it, expect } from 'vitest'

// Golden-master fixture schema validation. The numeric expected values are
// consumed primarily by the native C++ suite (wasm/tests/test_od_fixtures.cpp);
// this test guards the JSON schema so a future TS fallback can rely on it.
// Fixtures are loaded via import.meta.glob (no node builtins needed).

interface FixtureCase {
  schema_version: number
  case_id: string
  module: string
  function: string
  inputs: Record<string, unknown>
  config: Record<string, unknown>
  expected: Record<string, unknown>
  tolerances: Record<string, unknown>
  meta: Record<string, unknown>
}

interface Manifest {
  schema_version: number
  helio_git_rev: string
  generated_utc: string
  cases: Array<{ case_id: string; file: string; module: string; function: string }>
}

// Eagerly load every JSON fixture under fixtures/od/.
const fixture_modules = import.meta.glob('../../../fixtures/od/*.json', {
  eager: true,
}) as Record<string, { default: FixtureCase | Manifest }>

function fixture_path(name: string): string {
  const suffix = `/fixtures/od/${name}`
  const match = Object.keys(fixture_modules).find((p) => p.endsWith(suffix))
  if (!match) throw new Error(`fixture not found: ${name}`)
  return match
}

function loadManifest(): Manifest {
  return fixture_modules[fixture_path('index.json')]!.default as Manifest
}

function loadCase(caseId: string): FixtureCase {
  return fixture_modules[fixture_path(`${caseId}.json`)]!.default as FixtureCase
}

const REQUIRED_CASE_KEYS = [
  'schema_version',
  'case_id',
  'module',
  'function',
  'inputs',
  'config',
  'expected',
  'tolerances',
  'meta',
]

// Phase 1 case ids that must be present.
const PHASE1_CASES = [
  'kepler_solver',
  'j2_stm_propagation',
  'force_jacobians',
  'measurement_partials',
  'station_ecef',
  'gmst',
  'observation_prediction',
]

/** Recursively assert that every number in a value is finite. */
function expectFiniteNumbers(value: unknown, context: string): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${context} should be finite`).toBe(true)
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => expectFiniteNumbers(v, `${context}[${i}]`))
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      expectFiniteNumbers(v, `${context}.${k}`)
    }
  }
}

describe('OD fixtures manifest', () => {
  it('index.json exists and parses', () => {
    expect(() => loadManifest()).not.toThrow()
  })

  it('has schema_version 1 and provenance fields', () => {
    const manifest = loadManifest()
    expect(manifest.schema_version).toBe(1)
    expect(typeof manifest.helio_git_rev).toBe('string')
    expect(manifest.helio_git_rev.length).toBeGreaterThanOrEqual(7)
    expect(typeof manifest.generated_utc).toBe('string')
    expect(manifest.generated_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('lists all Phase 1 cases', () => {
    const manifest = loadManifest()
    const ids = manifest.cases.map((c) => c.case_id)
    for (const id of PHASE1_CASES) {
      expect(ids, `manifest should list ${id}`).toContain(id)
    }
  })

  it('every manifest entry has a matching file with consistent metadata', () => {
    const manifest = loadManifest()
    expect(manifest.cases.length).toBeGreaterThanOrEqual(PHASE1_CASES.length)
    for (const entry of manifest.cases) {
      expect(() => loadCase(entry.case_id), `${entry.case_id} should load`).not.toThrow()
      const c = loadCase(entry.case_id)
      expect(c.case_id, `${entry.case_id} case_id`).toBe(entry.case_id)
      expect(c.module, `${entry.case_id} module`).toBe(entry.module)
      expect(c.function, `${entry.case_id} function`).toBe(entry.function)
    }
  })
})

describe('OD fixture case schema', () => {
  it.each(PHASE1_CASES)('%s has the required schema keys and finite numbers', (caseId) => {
    const c = loadCase(caseId)
    for (const key of REQUIRED_CASE_KEYS) {
      expect(Object.keys(c), `${caseId} should have ${key}`).toContain(key)
    }
    expect(c.schema_version).toBe(1)
    expect(c.case_id).toBe(caseId)
    expect(typeof c.module).toBe('string')
    expect(typeof c.function).toBe('string')
    expect(typeof c.inputs).toBe('object')
    expect(typeof c.config).toBe('object')
    expect(typeof c.meta).toBe('object')

    // Expected values and tolerances: finite numbers only.
    expectFiniteNumbers(c.expected, `${caseId}.expected`)
    expectFiniteNumbers(c.tolerances, `${caseId}.tolerances`)

    // Tolerances must be positive numbers.
    for (const [key, tol] of Object.entries(c.tolerances)) {
      expect(typeof tol, `${caseId}.tolerances.${key} should be a number`).toBe('number')
      expect(tol as number, `${caseId}.tolerances.${key} should be > 0`).toBeGreaterThan(0)
    }

    // Meta should record provenance.
    expect(typeof c.meta.source).toBe('string')
  })
})

describe('OD fixture case contents', () => {
  it('kepler_solver has scalar M, e inputs and E expected', () => {
    const c = loadCase('kepler_solver')
    const inputs = c.inputs as Record<string, number>
    expect(inputs.M).toBeCloseTo(2.3456, 12)
    expect(inputs.e).toBeCloseTo(0.65, 12)
    expect(typeof (c.expected as Record<string, number>).E).toBe('number')
  })

  it('j2_stm_propagation has 6-element state and 36-element stm', () => {
    const c = loadCase('j2_stm_propagation')
    const inputs = c.inputs as { state6: number[]; t1: number }
    expect(inputs.state6).toHaveLength(6)
    expect(inputs.t1).toBe(3600)
    const expected = c.expected as { r: number[]; v: number[]; stm: number[] }
    expect(expected.r).toHaveLength(3)
    expect(expected.v).toHaveLength(3)
    expect(expected.stm).toHaveLength(36)
    const config = c.config as Record<string, number>
    expect(config.force_tier).toBe(1)
  })

  it('force_jacobians has 3-element accel and 9-element jac', () => {
    const c = loadCase('force_jacobians')
    const inputs = c.inputs as { r: number[] }
    expect(inputs.r).toHaveLength(3)
    const expected = c.expected as { accel: number[]; jac: number[] }
    expect(expected.accel).toHaveLength(3)
    expect(expected.jac).toHaveLength(9)
  })

  it('measurement_partials has H rows of 6 columns per type', () => {
    const c = loadCase('measurement_partials')
    const expected = c.expected as Record<string, number[]>
    expect(expected.range_h).toHaveLength(6)
    expect(expected.range_rate_h).toHaveLength(6)
    expect(expected.ra_h).toHaveLength(6)
    expect(expected.dec_h).toHaveLength(6)
  })

  it('station_ecef covers all three canonical stations', () => {
    const c = loadCase('station_ecef')
    const expected = c.expected as Record<string, number[]>
    for (const name of ['goldstone', 'arecibo', 'tromsoe']) {
      expect(expected[`${name}_ecef`], `${name} ecef`).toHaveLength(3)
    }
  })

  it('gmst has two epochs', () => {
    const c = loadCase('gmst')
    const inputs = c.inputs as { jds: number[] }
    expect(inputs.jds).toHaveLength(2)
    expect(inputs.jds[0]).toBeCloseTo(2451545.0, 9)
    const expected = c.expected as Record<string, number>
    expect(expected.gmst_j2000).toBeGreaterThanOrEqual(0)
    expect(expected.gmst_j2000).toBeLessThanOrEqual(2 * Math.PI)
  })

  it('observation_prediction has all six observable components', () => {
    const c = loadCase('observation_prediction')
    const expected = c.expected as Record<string, number>
    for (const key of ['range_km', 'range_rate_kms', 'ra_rad', 'dec_rad', 'az_rad', 'el_rad']) {
      expect(typeof expected[key], `${key} should be a number`).toBe('number')
    }
    expect(expected.range_km).toBeGreaterThan(0)
  })
})

describe('future-proofing', () => {
  it('every globbed fixture file is a valid Phase 1 or recognized future case', () => {
    const manifest = loadManifest()
    const knownIds = new Set(manifest.cases.map((c) => c.case_id))
    // Any future batch/ekf ids must still parse via the manifest.
    for (const id of knownIds) {
      expect(() => loadCase(id), `${id} should parse`).not.toThrow()
    }
  })
})
