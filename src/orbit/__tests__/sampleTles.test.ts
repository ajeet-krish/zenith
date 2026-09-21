import { describe, it, expect } from 'vitest'
import {
  SAMPLE_TLES,
  getTleByNoradId,
  getTleByName,
  getTlesByCategory,
} from '../sampleTles'

describe('Sample TLEs', () => {
  describe('SAMPLE_TLES collection', () => {
    it('has 9 entries', () => {
      expect(SAMPLE_TLES).toHaveLength(9)
    })

    it('contains all categories (LEO, MEO, GEO, DEBRIS)', () => {
      const categories = new Set(SAMPLE_TLES.map((t) => t.category))
      expect(categories.has('LEO')).toBe(true)
      expect(categories.has('MEO')).toBe(true)
      expect(categories.has('GEO')).toBe(true)
      expect(categories.has('DEBRIS')).toBe(true)
    })

    it('all TLE line1 entries are at least 69 characters', () => {
      for (const tle of SAMPLE_TLES) {
        expect(tle.line1.length).toBeGreaterThanOrEqual(69)
      }
    })

    it('all TLE line2 entries are at least 69 characters', () => {
      for (const tle of SAMPLE_TLES) {
        expect(tle.line2.length).toBeGreaterThanOrEqual(69)
      }
    })

    it('all TLE line1 entries start with "1"', () => {
      for (const tle of SAMPLE_TLES) {
        expect(tle.line1.startsWith('1')).toBe(true)
      }
    })

    it('all TLE line2 entries start with "2"', () => {
      for (const tle of SAMPLE_TLES) {
        expect(tle.line2.startsWith('2')).toBe(true)
      }
    })

    it('all noradId values are unique', () => {
      const ids = SAMPLE_TLES.map((t) => t.noradId)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })

    it('all entries have valid category values', () => {
      const validCategories = ['LEO', 'MEO', 'GEO', 'HEO', 'DEBRIS']
      for (const tle of SAMPLE_TLES) {
        expect(validCategories).toContain(tle.category)
      }
    })
  })

  describe('getTleByNoradId', () => {
    it('returns ISS TLE for noradId 25544', () => {
      const result = getTleByNoradId(25544)
      expect(result).toBeDefined()
      expect(result![0]).toBe(SAMPLE_TLES[0].line1)
      expect(result![1]).toBe(SAMPLE_TLES[0].line2)
    })

    it('returns undefined for non-existent noradId 99999', () => {
      const result = getTleByNoradId(99999)
      expect(result).toBeUndefined()
    })
  })

  describe('getTleByName', () => {
    it('returns ISS TLE for "ISS"', () => {
      const result = getTleByName('ISS')
      expect(result).toBeDefined()
      expect(result![0]).toBe(SAMPLE_TLES[0].line1)
      expect(result![1]).toBe(SAMPLE_TLES[0].line2)
    })

    it('returns ISS TLE for "iss" (case insensitive)', () => {
      const result = getTleByName('iss')
      expect(result).toBeDefined()
      expect(result![0]).toBe(SAMPLE_TLES[0].line1)
      expect(result![1]).toBe(SAMPLE_TLES[0].line2)
    })

    it('returns undefined for non-existent name "nonexistent"', () => {
      const result = getTleByName('nonexistent')
      expect(result).toBeUndefined()
    })
  })

  describe('getTlesByCategory', () => {
    it('returns 4 entries for LEO', () => {
      const result = getTlesByCategory('LEO')
      expect(result).toHaveLength(4)
    })

    it('returns 2 entries for MEO', () => {
      const result = getTlesByCategory('MEO')
      expect(result).toHaveLength(2)
    })

    it('returns 1 entry for GEO', () => {
      const result = getTlesByCategory('GEO')
      expect(result).toHaveLength(1)
    })

    it('returns 2 entries for DEBRIS', () => {
      const result = getTlesByCategory('DEBRIS')
      expect(result).toHaveLength(2)
    })

    it('returns 0 entries for HEO', () => {
      const result = getTlesByCategory('HEO')
      expect(result).toHaveLength(0)
    })
  })
})
