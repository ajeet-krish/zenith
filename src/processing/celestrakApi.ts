/**
 * CelesTrak API client for fetching TLE catalog data.
 * Uses the TLE format endpoint which returns 3-line TLEs directly.
 */

const BASE_URL = 'https://celestrak.org/NORAD/elements/gp.php'

export type CelestrakCategory =
  | 'stations'
  | 'active'
  | 'debris'
  | 'starlink'
  | 'gps'
  | 'glonass'
  | 'galileo'
  | 'beidou'
  | 'visual'
  | 'weather'

export const CATEGORY_LABELS: Record<CelestrakCategory, string> = {
  stations: 'Space Stations',
  active: 'Active Satellites',
  debris: 'Debris',
  starlink: 'Starlink',
  gps: 'GPS',
  glonass: 'GLONASS',
  galileo: 'Galileo',
  beidou: 'BeiDou',
  visual: 'Visual',
  weather: 'Weather',
}

export interface CelestrakTLE {
  name: string
  line1: string
  line2: string
  noradId: number
}

/**
 * Parse a TLE text response into structured TLE entries.
 * Format: name\nline1\nline2 repeated for each satellite.
 */
function parseTleResponse(text: string): CelestrakTLE[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const entries: CelestrakTLE[] = []

  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i] ?? ''
    const line1 = lines[i + 1] ?? ''
    const line2 = lines[i + 2] ?? ''

    // Validate TLE format: line1 starts with '1 ', line2 starts with '2 '
    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      // Extract NORAD ID from line1 (columns 2-7)
      const noradId = parseInt(line1.substring(2, 7).trim(), 10)
      if (!isNaN(noradId) && noradId > 0) {
        entries.push({ name, line1, line2, noradId })
      }
    }
  }

  return entries
}

/**
 * In-memory cache for fetched categories.
 */
const cache = new Map<CelestrakCategory, CelestrakTLE[]>()

/**
 * Fetch TLE data for a given category from CelesTrak.
 * Results are cached in memory for the session.
 */
export async function fetchCelestrakCategory(
  category: CelestrakCategory
): Promise<CelestrakTLE[]> {
  // Return cached data if available
  const cached = cache.get(category)
  if (cached) return cached

  const url = `${BASE_URL}?GROUP=${category}&FORMAT=tle`
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`CelesTrak API error: ${response.status} ${response.statusText}`)
  }

  const text = await response.text()
  const entries = parseTleResponse(text)

  // Cache the result
  cache.set(category, entries)

  return entries
}

/**
 * Get cached category data without fetching.
 */
export function getCachedCategory(category: CelestrakCategory): CelestrakTLE[] | null {
  return cache.get(category) ?? null
}
