import { R_EARTH } from '@/orbit/constants'

/** Circular LEO state vector at ~400 km altitude */
export const LEO_STATE = {
  position: { x: 6781.0, y: 0.0, z: 0.0 },
  velocity: { x: 0.0, y: 7.669, z: 0.0 },
  epoch: 2451545.0, // J2000
}

/** Hohmann transfer reference: LEO (400 km) to GEO (35786 km) */
export const HOHMANN_REFERENCE = {
  r1_km: R_EARTH + 400.0,
  r2_km: R_EARTH + 35786.0,
  dv_total_kms: 3.935,
  transfer_time_s: 18936,
}
