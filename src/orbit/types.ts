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

export type AnalysisTool = 'maneuver' | 'conjunction' | 'groundtrack' | 'montecarlo' | 'coverage'

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
