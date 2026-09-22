// =============================================================================
// Zenith Web - TypeScript Type Definitions
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

export interface SGP4Output {
  x: number // TEME position (km)
  y: number
  z: number
  vx: number // TEME velocity (km/s)
  vy: number
  vz: number
}

export interface StateVector {
  position: { x: number; y: number; z: number }
  velocity: { x: number; y: number; z: number }
  epoch: number // Julian Date
}

export interface KeplerianElements {
  a: number // Semi-major axis (km)
  e: number // Eccentricity
  i: number // Inclination (rad)
  raan: number // RAAN (rad)
  argp: number // Argument of perigee (rad)
  ta: number // True anomaly (rad)
  epoch: number // Julian Date
}

export interface TLEData {
  norad_id: number
  name: string
  line1: string
  line2: string
  classification: 'U' | 'C' | 'S'
  intl_designator: string
  epoch_jd: number
  mean_motion: number // rev/day
  mean_motion_dot: number
  mean_motion_ddot: number
  bstar: number
  inclination: number // deg
  raan: number // deg
  eccentricity: number
  arg_perigee: number // deg
  mean_anomaly: number // deg
  revolution_number: number
}

export interface LambertInput {
  r1: [number, number, number] // Position vector 1 (km)
  r2: [number, number, number] // Position vector 2 (km)
  dt: number // Time of flight (seconds)
  mu: number // Gravitational parameter (km^3/s^2)
}

export interface LambertOutput {
  v1: [number, number, number] // Departure velocity (km/s)
  v2: [number, number, number] // Arrival velocity (km/s)
  iterations: number
  converged: boolean
  a?: number // Semi-major axis (km), from WASM only
  tof?: number // Time of flight used (s), from WASM only
}

/** Sample TLE entry for demo/testing */
export interface SampleTLE {
  name: string
  noradId: number
  line1: string
  line2: string
  category: 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'DEBRIS'
}

// =============================================================================
// Force model configuration
// =============================================================================

export interface ForceModelConfig {
  useJ2: boolean
  useJ4: boolean
  useDrag: boolean
  useSRP: boolean
  useThirdBody: boolean
}

// =============================================================================
// Propagation configuration
// =============================================================================

export interface PropagationConfig {
  startEpoch: number // Julian Date
  endEpoch: number // Julian Date
  timeStep: number // seconds
  forceModel: ForceModelConfig
}

// =============================================================================
// Mission configuration
// =============================================================================

export interface MissionConfig {
  name: string
  description: string
  targetOrbit: {
    altitude: number // km
    inclination: number // deg
    eccentricity: number
  }
  transferType: 'hohmann' | 'lambert' | 'bielliptic'
}

// =============================================================================
// WASM embind API types
// =============================================================================

/** SGP4 propagator handle result */
export interface SGP4InitResult {
  handle: number
  success: boolean
}

/** Keplerian elements from SGP4 */
export interface SGP4KeplerianElements {
  a: number // Semi-major axis (km)
  e: number // Eccentricity
  i: number // Inclination (degrees)
  raan: number // RAAN (degrees)
  argp: number // Argument of perigee (degrees)
  ta: number // True anomaly (degrees)
}

/** Lambert solver WASM result */
export interface LambertWasmResult {
  v1x: number
  v1y: number
  v1z: number
  v2x: number
  v2y: number
  v2z: number
  converged: boolean
}

// =============================================================================
// Analysis Types
// =============================================================================

export interface HohmannResult {
  dv1: number           // km/s
  dv2: number           // km/s
  dvTotal: number       // km/s
  transferTimeS: number // seconds
  aTransfer: number     // km
}

export interface ConjunctionEvent {
  satId1: number
  satId2: number
  tcaJd: number
  missDistanceKm: number
  relPosition: { x: number; y: number; z: number }
}

export interface ConjunctionConfig {
  screenDistanceKm: number
  timeStepS: number
  maxTimeSteps: number
}

export interface GroundTrackPoint {
  latitudeRad: number
  longitudeRad: number
  altitudeKm: number
  jdUtc: number
}

export interface MonteCarloConfig {
  nSamples: number
  endTimeDays: number
  positionStddevKm: number
  velocityStddevKmS: number
  seed: number
}

export interface MonteCarloResult {
  meanState: StateVector
  positionStddev: [number, number, number]
  velocityStddev: [number, number, number]
  samples: Array<{ x: number; y: number; z: number }>
}

export interface WalkerDeltaConfig {
  inclinationRad: number
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

export type AnalysisTool = 'maneuver' | 'conjunction' | 'groundtrack' | 'montecarlo' | 'coverage'
