import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hohmannFromAltitudes, setWasmModule } from '../analysisLoader'
import { R_EARTH } from '../constants'

// Reset WASM module reference before each test
beforeEach(() => {
  setWasmModule(null)
})

describe('analysisLoader', () => {
  describe('hohmannFromAltitudes', () => {
    it('computes LEO to GEO transfer', () => {
      const result = hohmannFromAltitudes(400, 35786)
      expect(result).not.toBeNull()
      expect(result!.dvTotal).toBeGreaterThan(3.5)
      expect(result!.dvTotal).toBeLessThan(4.5)
    })

    it('returns zero delta-V for same altitude', () => {
      const result = hohmannFromAltitudes(400, 400)
      expect(result).not.toBeNull()
      expect(result!.dvTotal).toBeCloseTo(0, 10)
    })

    it('transfer time is positive', () => {
      const result = hohmannFromAltitudes(400, 35786)
      expect(result).not.toBeNull()
      expect(result!.transferTimeS).toBeGreaterThan(0)
    })

    it('uses WASM when available', () => {
      const mockWasm = {
        hohmann_from_altitudes: vi.fn(() => ({
          dv1: 0.1,
          dv2: 0.2,
          dv_total: 0.3,
          transfer_time_s: 1000,
          a_transfer: 20000,
        })),
      }
      setWasmModule(mockWasm)
      const result = hohmannFromAltitudes(400, 35786)
      expect(result).not.toBeNull()
      expect(result!.dvTotal).toBe(0.3)
      expect(mockWasm.hohmann_from_altitudes).toHaveBeenCalled()
    })

    it('falls back to TS when WASM fails', () => {
      const mockWasm = {
        hohmann_from_altitudes: vi.fn(() => { throw new Error('WASM error') }),
      }
      setWasmModule(mockWasm)
      const result = hohmannFromAltitudes(400, 35786)
      expect(result).not.toBeNull()
      expect(result!.dvTotal).toBeGreaterThan(3.5)
    })
  })
})
