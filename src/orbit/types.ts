// =============================================================================
// Zenith Web - TypeScript Type Definitions
// =============================================================================

/** Sample TLE entry for demo/testing */
export interface SampleTLE {
  name: string
  noradId: number
  line1: string
  line2: string
  category: 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'DEBRIS'
}

export type AnalysisTool = 'maneuver' | 'lambert' | 'conjunction' | 'groundtrack' | 'passpredict' | 'montecarlo' | 'coverage' | 'eclipse' | 'gaussiod'

// =============================================================================
// SGP4 Input (used by TLE parser)
// =============================================================================

export interface SGP4Input {
  epoch: number // Julian Date
  meanMotion: number // Revolutions per day
  eccentricity: number
  inclination: number // Degrees
  raan: number // Degrees
  argPerigee: number // Degrees
  meanAnomaly: number // Degrees
  bstar: number // Drag term
}

// =============================================================================
// State & Elements
// =============================================================================

export interface StateVector {
  position: { x: number; y: number; z: number }
  velocity: { x: number; y: number; z: number }
  epoch: number // Julian Date
}

// =============================================================================
// Analysis Types (canonical definitions - analysisLoader imports from here)
// =============================================================================

export interface HohmannResult {
  dv1: number           // km/s
  dv2: number           // km/s
  dvTotal: number       // km/s
  transferTimeS: number // seconds
  aTransfer: number     // km
}

export interface ConjunctionEvent {
  sat1Name: string
  sat2Name: string
  sat1Id: string
  sat2Id: string
  missDistanceKm: number
  riskLevel: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW'
  tcaJd?: number
  position1: { x: number; y: number; z: number }
  position2: { x: number; y: number; z: number }
}

export interface GroundTrackPoint {
  lat: number
  lon: number
  alt: number
  jd: number
}

export interface MonteCarloConfig {
  nSamples: number
  endTimeDays: number
  positionStddevKm: number
  velocityStddevKmS: number
  seed: number
}

export interface MonteCarloResult {
  mean: { x: number; y: number; z: number; vx: number; vy: number; vz: number }
  positionStddev: number[]
  velocityStddev: number[]
  samples: Array<{ x: number; y: number; z: number }>
}

export interface WalkerDeltaConfig {
  inclinationDeg: number
  totalSats: number
  numPlanes: number
  phasingFactor: number
  altitudeKm: number
}

export interface CoverageResult {
  coverageFraction: number
  maxGapS: number
  avgPassDurationS: number
  totalPasses: number
}

// =============================================================================
// Orbit Determination (OD) Types
// =============================================================================

/** A ground station used for OD observations. Handle is the WASM station id. */
export interface ODStation {
  id: string
  name: string
  latRad: number
  lonRad: number
  altKm: number
  handle: number | null
}

/** Scalar observation type discriminator (matches C++ orbit::ObsType). */
export type ODObservationType = 'range' | 'range_rate' | 'ra_dec' | 'az_el'

/** A single observation at one epoch from one station. */
export interface ODObservation {
  timeJd: number
  stationId: string
  obsType: ODObservationType
  values: number[]
  sigmas: number[]
}

/** Default measurement sigmas (matches C++ orbit::ObsConfig / helio ObsConfig). */
export interface ObsConfig {
  sigmaRangeKm: number
  sigmaRangeRateKms: number
  sigmaAnglesRad: [number, number]
  sigmaAzElRad: [number, number]
}

/** Configuration for the TS-side observation simulator. */
export interface ObservationSimConfig {
  noiseScale: number
  cadenceSec: number
  arcHours: number
  stationNames: string[]
}

/** All six noise-free observables predicted for one epoch. */
export interface ObsPrediction {
  rangeKm: number
  rangeRateKms: number
  raRad: number
  decRad: number
  azRad: number
  elRad: number
}

/** Analytic measurement partials H = dh/d(r, v), one row per observable. */
export interface MeasurementPartials {
  rangeH: number[]
  rangeRateH: number[]
  raH: number[]
  decH: number[]
}

/** Result of a variational (STM) propagation. */
export interface STMPropagationResult {
  r: [number, number, number]
  v: [number, number, number]
  stm: number[]
}

// =============================================================================
// Gauss IOD (Phase 2) Types
// =============================================================================

/** GaussIodError status codes (matches C++ orbit::GaussIodError). */
export const GAUSS_IOD_STATUS = {
  OK: 0,
  WARNING_ILL_CONDITIONED: 1,
  ERROR_INPUT: 2,
  ERROR_SINGULAR: 3,
  ERROR_NO_SOLUTION: 4,
  ERROR_INCONSISTENT_ROOTS: 5,
} as const

/** Narrowed union of the Gauss IOD status codes. */
export type GaussIodStatus = (typeof GAUSS_IOD_STATUS)[keyof typeof GAUSS_IOD_STATUS]

/** Human-readable message for each Gauss IOD status code. */
export const GAUSS_IOD_STATUS_MESSAGES: Record<number, string> = {
  [GAUSS_IOD_STATUS.OK]: 'Solution found with nominal geometry',
  [GAUSS_IOD_STATUS.WARNING_ILL_CONDITIONED]:
    'Ill-conditioned geometry: state may be inaccurate',
  [GAUSS_IOD_STATUS.ERROR_INPUT]: 'Bad input: non-increasing epochs or invalid config',
  [GAUSS_IOD_STATUS.ERROR_SINGULAR]:
    'Singular geometry: LOS matrix ill-conditioned or coplanar with origin',
  [GAUSS_IOD_STATUS.ERROR_NO_SOLUTION]: 'No root converged to a consistent physical orbit',
  [GAUSS_IOD_STATUS.ERROR_INCONSISTENT_ROOTS]: 'Independent roots disagree by more than 1 km',
}

/** One RA/Dec observation for Gauss angles-only IOD. */
export interface GaussIodObservation {
  /** Observation epoch as Julian Date [days]. */
  epochJd: number
  /** Right ascension of the line of sight [rad]. */
  raRad: number
  /** Declination of the line of sight [rad]. */
  decRad: number
  /** Station id: a useODStore station id ('sta-N') or a raw WASM handle as a numeric string. */
  stationId: string
}

/** Gauss IOD solver configuration (defaults match C++ orbit::GaussIodConfig). */
export interface GaussIodConfig {
  /** Gravitational parameter [km^3/s^2]. */
  mu: number
  /** Max acceptable angular residual [rad]. */
  residualTolRad: number
  /** GN differential-correction polish; false keeps the Herrick-Gibbs seed. */
  enableCorrection: boolean
  /** Max Gauss-Newton differential correction iterations. */
  maxDcIter: number
  /** Hard singular rejection threshold on the LOS matrix condition number. */
  condSingular: number
  /** Ill-conditioning warning threshold on the LOS matrix condition number. */
  condWarning: number
}

/** Typed result of a Gauss angles-only IOD solve (state at the middle epoch). */
export interface GaussIodTsResult {
  /** Position at the middle epoch [km, ECI/TEME]. */
  r: [number, number, number]
  /** Velocity at the middle epoch [km/s, ECI/TEME]. */
  v: [number, number, number]
  /** GaussIodError status code (see GAUSS_IOD_STATUS). */
  status: number
  /** Human-readable status message. */
  statusMessage: string
  /** True when status is OK or WARNING_ILL_CONDITIONED (state is usable). */
  converged: boolean
  /** GN iterations spent on the best candidate. */
  iterations: number
  /** Max angular residual of the best candidate [rad]. */
  residualNorm: number
  /** 2-norm condition number of the LOS matrix. */
  conditionNumber: number
  /** Best-root slant ranges (rho1, rho2, rho3) [km]. */
  ranges: [number, number, number]
}

/** Typed result of a Herrick-Gibbs velocity estimate. */
export interface HerrickGibbsTsResult {
  /** Velocity at the middle epoch [km/s, ECI/TEME]. */
  v: [number, number, number]
  /** GaussIodError status code (see GAUSS_IOD_STATUS). */
  status: number
  /** Human-readable status message. */
  statusMessage: string
}
