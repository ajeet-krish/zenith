/** ISS TLE with valid checksums */
export const ISS_TLE = {
  line1: '1 25544U 98067A   24100.50000000  .00016717  00000-0  10270-3 0  9009',
  line2: '2 25544  51.6400 200.0000 0005000  50.0000 310.0000 15.49000000 10004',
}

/** Hubble TLE */
export const HUBBLE_TLE = {
  line1: '1 20580U 90037B   24100.50000000  .00001200  00000-0  70000-4 0  9002',
  line2: '2 20580  28.4700 100.0000 0002800 120.0000 240.0000 15.09000000 10004',
}

/** GEO satellite */
export const GOES_TLE = {
  line1: '1 41888U 16080A   24100.50000000  .00000010  00000-0  00000-0 0  9009',
  line2: '2 41888   0.5000 280.0000 0001000  90.0000 270.0000  1.00270000 10006',
}

/** Intentionally broken TLE for error testing (bad checksums on both lines) */
export const BROKEN_TLE = {
  line1: '1 25544U 98067A   24100.50000000  .00016717  00000-0  10270-3 0  9990',
  line2: '2 25544  51.6400 200.0000 0005000  50.0000 310.0000 15.49000000 10001',
}

/** Reference orbital elements for validation */
export const ISS_REFERENCE = {
  altitude_km: 408,
  velocity_kms: 7.66,
  period_min: 92.68,
  inclination_deg: 51.64,
}
