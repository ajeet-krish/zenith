import type { SampleTLE } from './types'

/**
 * Sample TLE data for demo and testing.
 * These are representative TLEs for various orbit categories.
 * Use with sgp4Init(line1, line2) to initialize propagators.
 */
export const SAMPLE_TLES: SampleTLE[] = [
  // LEO - Active satellites
  {
    name: 'ISS (ZARYA)',
    noradId: 25544,
    line1: '1 25544U 98067A   24100.50000000  .00016717  00000-0  10270-3 0  9002',
    line2: '2 25544  51.6400 200.0000 0005000  50.0000 310.0000 15.49000000 10000',
    category: 'LEO',
  },
  {
    name: 'HUBBLE SPACE TELESCOPE',
    noradId: 20580,
    line1: '1 20580U 90037B   24100.50000000  .00001200  00000-0  70000-4 0  9001',
    line2: '2 20580  28.4700 100.0000 0002800 120.0000 240.0000 15.09000000 10000',
    category: 'LEO',
  },
  {
    name: 'STARLINK-1007',
    noradId: 44713,
    line1: '1 44713U 19074A   24100.50000000  .00001500  00000-0  80000-4 0  9004',
    line2: '2 44713  53.0000 250.0000 0002000  70.0000 290.0000 15.06000000 10000',
    category: 'LEO',
  },
  {
    name: 'TIANGONG',
    noradId: 48274,
    line1: '1 48274U 21035A   24100.50000000  .00020000  00000-0  12000-3 0  9006',
    line2: '2 48274  41.5000 150.0000 0006000  40.0000 320.0000 15.60000000 10000',
    category: 'LEO',
  },

  // MEO - Navigation satellites
  {
    name: 'GPS BIIR-01',
    noradId: 24873,
    line1: '1 24873U 97035A   24100.50000000  .00000050  00000-0  00000-0 0  9003',
    line2: '2 24873  55.0000  50.0000 0005000  30.0000 330.0000  2.00560000 10000',
    category: 'MEO',
  },
  {
    name: 'BEIDOU-3 M1',
    noradId: 44203,
    line1: '1 44203U 19023A   24100.50000000  .00000030  00000-0  00000-0 0  9007',
    line2: '2 44203  55.0000 120.0000 0003000  60.0000 300.0000  2.00000000 10000',
    category: 'MEO',
  },

  // GEO - Geostationary
  {
    name: 'GOES-16',
    noradId: 41888,
    line1: '1 41888U 16080A   24100.50000000  .00000010  00000-0  00000-0 0  9005',
    line2: '2 41888   0.5000 280.0000 0001000  90.0000 270.0000  1.00270000 10000',
    category: 'GEO',
  },

  // Debris - collision avoidance examples
  {
    name: 'COSMOS 2251',
    noradId: 22674,
    line1: '1 22674U 93036B   24100.50000000  .00000100  00000-0  50000-4 0  9008',
    line2: '2 22674  74.0000 180.0000 0010000  20.0000 340.0000 14.10000000 10000',
    category: 'DEBRIS',
  },
  {
    name: 'IRIDIUM 33',
    noradId: 24793,
    line1: '1 24793U 97020B   24100.50000000  .00000200  00000-0  60000-4 0  9009',
    line2: '2 24793  86.4000 270.0000 0003000  90.0000 270.0000 14.30000000 10000',
    category: 'DEBRIS',
  },
]

/**
 * Get TLE lines for a satellite by NORAD ID.
 * Returns [line1, line2] or undefined if not found.
 */
export function getTleByNoradId(noradId: number): [string, string] | undefined {
  const tle = SAMPLE_TLES.find((t) => t.noradId === noradId)
  return tle ? [tle.line1, tle.line2] : undefined
}

/**
 * Get TLE lines for a satellite by name (case-insensitive partial match).
 * Returns [line1, line2] or undefined if not found.
 */
export function getTleByName(name: string): [string, string] | undefined {
  const lower = name.toLowerCase()
  const tle = SAMPLE_TLES.find((t) => t.name.toLowerCase().includes(lower))
  return tle ? [tle.line1, tle.line2] : undefined
}

/**
 * Get all TLEs matching a given category.
 */
export function getTlesByCategory(category: SampleTLE['category']): SampleTLE[] {
  return SAMPLE_TLES.filter((t) => t.category === category)
}
