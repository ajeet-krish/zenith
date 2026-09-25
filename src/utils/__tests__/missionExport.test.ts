import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportMission, importMission } from '../missionExport'
import { useMissionStore } from '@/store/useMissionStore'

vi.mock('@/orbit/wasmLoader', () => ({
  sgp4Init: vi.fn(() => 1),
  sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
  sgp4GetElements: vi.fn(() => ({ a: 6781, e: 0.0007, i: 0.9, raan: 3.49, argp: 0.87, ta: 5.41 })),
  sgp4Clear: vi.fn(),
  sgp4Destroy: vi.fn(),
  initWasm: vi.fn(async () => false),
}))

vi.mock('@/orbit/sampleTles', () => ({
  SAMPLE_TLES: [],
}))

beforeEach(() => {
  useMissionStore.setState({
    satellites: [],
    selectedSatelliteId: null,
    isPlaying: false,
    timeSpeed: 1,
    propagationMethod: 'sgp4',
    forceModels: { j2: true, drag: false, srp: false, thirdBody: false },
    wasmReady: false,
  })
})

describe('missionExport', () => {
  describe('exportMission', () => {
    it('produces valid JSON', () => {
      const json = exportMission()
      const data = JSON.parse(json)
      expect(data.version).toBe(1)
      expect(Array.isArray(data.satellites)).toBe(true)
    })

    it('includes timeSpeed and propagationMethod', () => {
      useMissionStore.getState().setTimeSpeed(5)
      const json = exportMission()
      const data = JSON.parse(json)
      expect(data.timeSpeed).toBe(5)
      expect(data.propagationMethod).toBe('sgp4')
    })

    it('serializes satellite fields', () => {
      useMissionStore.getState().addSatellite({
        name: 'TEST',
        noradId: 99999,
        line1: '1 99999U 00000A   24100.50000000  .00000000  00000-0  00000-0 0  0000',
        line2: '2 99999   0.0000   0.0000 0000000   0.0000   0.0000  1.00000000    00',
        category: 'LEO',
        color: '#8be9fd',
        visible: true,
      })
      const json = exportMission()
      const data = JSON.parse(json)
      expect(data.satellites).toHaveLength(1)
      expect(data.satellites[0].name).toBe('TEST')
      expect(data.satellites[0].noradId).toBe(99999)
    })
  })

  describe('importMission', () => {
    it('imports valid data', () => {
      const mission = {
        version: 1,
        satellites: [{
          name: 'IMPORTED',
          noradId: 12345,
          line1: '1 12345U 00000A   24100.50000000  .00000000  00000-0  00000-0 0  0000',
          line2: '2 12345   0.0000   0.0000 0000000   0.0000   0.0000  1.00000000    00',
          category: 'LEO',
          color: '#8be9fd',
          visible: true,
        }],
        timeSpeed: 2,
        propagationMethod: 'kepler',
        exportDate: '2024-01-01',
      }
      const result = importMission(JSON.stringify(mission))
      expect(result.success).toBe(true)
      expect(useMissionStore.getState().satellites).toHaveLength(1)
      expect(useMissionStore.getState().timeSpeed).toBe(2)
    })

    it('rejects wrong version', () => {
      const result = importMission('{"version":2,"satellites":[]}')
      expect(result.success).toBe(false)
      expect(result.error).toContain('version')
    })

    it('rejects invalid category', () => {
      const mission = {
        version: 1,
        satellites: [{ name: 'X', noradId: 1, line1: 'x'.repeat(69), line2: 'x'.repeat(69), category: 'INVALID' }],
        timeSpeed: 1,
        propagationMethod: 'sgp4',
      }
      const result = importMission(JSON.stringify(mission))
      expect(result.success).toBe(true) // invalid satellite is skipped, not rejected
      expect(useMissionStore.getState().satellites).toHaveLength(0)
    })

    it('rejects invalid propagationMethod', () => {
      const mission = { version: 1, satellites: [], timeSpeed: 1, propagationMethod: 'invalid' }
      const result = importMission(JSON.stringify(mission))
      expect(result.success).toBe(false)
    })

    it('rejects malformed JSON', () => {
      const result = importMission('not json')
      expect(result.success).toBe(false)
    })

    it('rejects missing satellites array', () => {
      const result = importMission('{"version":1}')
      expect(result.success).toBe(false)
    })

    it('handles empty satellites', () => {
      const mission = { version: 1, satellites: [], timeSpeed: 1, propagationMethod: 'sgp4' }
      const result = importMission(JSON.stringify(mission))
      expect(result.success).toBe(true)
    })
  })
})
