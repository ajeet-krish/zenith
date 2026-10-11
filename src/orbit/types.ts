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

export type AnalysisTool = 'maneuver' | 'lambert' | 'conjunction' | 'groundtrack' | 'passpredict' | 'montecarlo' | 'coverage' | 'eclipse' | 'gaussiod' | 'batchod'

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

// =============================================================================
// Batch Least-Squares OD (Phase 3) Types
// =============================================================================

/** BatchError status codes (matches C++ orbit::BatchError). */
export const BATCH_STATUS = {
  OK: 0,
  ERROR_INPUT: 1,
  ERROR_NOT_CONVERGED: 2,
  ERROR_SINGULAR_N: 3,
  ERROR_INTEGRATION: 4,
  ERROR_A_PRIORI_INVALID: 5,
} as const

/** Narrowed union of the batch OD status codes. */
export type BatchStatus = (typeof BATCH_STATUS)[keyof typeof BATCH_STATUS]

/** Human-readable message for each batch OD status code. */
export const BATCH_STATUS_MESSAGES: Record<number, string> = {
  [BATCH_STATUS.OK]: 'Batch least-squares solve converged',
  [BATCH_STATUS.ERROR_INPUT]:
    'Bad input: empty observations, AZ_EL rows, non-positive sigmas, or invalid state guess',
  [BATCH_STATUS.ERROR_NOT_CONVERGED]:
    'Solver finished without meeting the convergence tolerances',
  [BATCH_STATUS.ERROR_SINGULAR_N]:
    'Final covariance is singular (rank-deficient active set)',
  [BATCH_STATUS.ERROR_INTEGRATION]:
    'Variational propagation failed during the solve',
  [BATCH_STATUS.ERROR_A_PRIORI_INVALID]:
    'A-priori covariance is not symmetric positive definite',
}

/** Batch solver configuration (matches C++ orbit::BatchConfig). */
export interface BatchTsConfig {
  /** Gravitational parameter [km^3/s^2]; informational (kernel uses compiled Earth mu). */
  mu: number
  /** Force model tier: 0 = two-body, 1 = J2. */
  forceTier: number
  /** Max Gauss-Newton iterations per (re)start. */
  maxIter: number
  /** Position norm convergence tolerance [km]. */
  tolPosKm: number
  /** Velocity norm convergence tolerance [km/s]. */
  tolVelKms: number
  /** Relative WRMS-change convergence tolerance. */
  tolWrmsRel: number
  /** Residual editing threshold [sigmas]. */
  sigmaEdit: number
  /** Max removable fraction of active rows per editing round. */
  editMaxFraction: number
  /** Max warm-restart editing rounds. */
  editMaxRounds: number
  /** false disables the 3-sigma editing loop entirely. */
  enableEditing: boolean
}

/** Optional Bayesian a-priori constraint on the estimated epoch state. */
export interface BatchAPriori {
  /** A-priori state at the estimation epoch [km, km/s] (exactly 6 values). */
  x0: number[]
  /** A-priori covariance (6x6 row-major, 36 values; must be symmetric positive definite). */
  cov: number[]
}

/** One post-fit residual row (matches C++ orbit::BatchResidualRow). */
export interface BatchResidualRow {
  /** Observation epoch of the source observation [Julian Date, days]. */
  timeJd: number
  /** Source observation type ('range', 'range_rate', or 'ra_dec'). */
  obsType: ODObservationType
  /** Reserved: station index; not populated by the Phase 3 kernel. */
  stationIndex?: number
  /** Measured value(s) [km, km/s, or rad]; length matches the type's ndim. */
  value: number[]
  /** Predicted value(s) at the final state. */
  predicted: number[]
  /** Measured minus predicted (RA wrapped to [-pi, pi)). */
  residual: number[]
  /** One-sigma measurement uncertainties. */
  sigma: number[]
  /** Normalized residuals (residual / sigma). */
  normalized: number[]
  /** True when edited out of the solution (values kept for reporting). */
  edited: boolean
}

/** Typed result of a batch least-squares OD solve (6D mode). */
export interface BatchTsResult {
  /** Estimated ECI state at the solve epoch [km, km/s] (6 values). */
  state: number[]
  /** Formal covariance inv(N) at the converged active set (6x6 row-major, 36 values). */
  covariance: number[]
  /** sqrt(diag(covariance)) [km, km/s] (6 values). */
  formalSigmas: number[]
  /** Total Gauss-Newton iterations across all rounds. */
  iterations: number
  /** True when the iteration loop met the convergence tolerances. */
  converged: boolean
  /** Post-fit weighted RMS over the active rows. */
  wrms: number
  /** chi2 / (m_active - 6); null when m_active <= 6 (kernel reports NaN). */
  reducedChi2: number | null
  /** Scalar rows edited out of the solution (n_rows - n_active). */
  editedCount: number
  /** Active scalar rows at the final solution. */
  nActive: number
  /** BatchError status code (see BATCH_STATUS). */
  errorStatus: number
  /** Human-readable status message. */
  statusMessage: string
  /** Full residual table, one entry per original scalar row. */
  residuals: BatchResidualRow[]
}
