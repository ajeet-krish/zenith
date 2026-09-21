import { describe, it, expect } from 'vitest'
import {
  MU_EARTH,
  R_EARTH,
  J2,
  J4,
  DEG_TO_RAD,
  RAD_TO_DEG,
  JD_J2000,
  C_LIGHT,
  AU_KM,
  SEC_PER_DAY,
  MIN_PER_DAY,
  OMEGA_EARTH,
  RHO_0,
  H_SCALE,
  SRP_1AU,
} from '../constants'

describe('Orbit Constants', () => {
  describe('Earth parameters', () => {
    it('MU_EARTH is 398600.4418', () => {
      expect(MU_EARTH).toBe(398600.4418)
    })

    it('R_EARTH is 6378.137', () => {
      expect(R_EARTH).toBe(6378.137)
    })

    it('J2 is 0.00108263', () => {
      expect(J2).toBe(0.00108263)
    })

    it('J4 is -0.00000161', () => {
      expect(J4).toBe(-0.00000161)
    })

    it('OMEGA_EARTH is 7.2921151467e-5', () => {
      expect(OMEGA_EARTH).toBe(7.2921151467e-5)
    })
  })

  describe('Angular conversions', () => {
    it('DEG_TO_RAD * RAD_TO_DEG equals 1 within floating point', () => {
      expect(DEG_TO_RAD * RAD_TO_DEG).toBeCloseTo(1, 10)
    })

    it('DEG_TO_RAD is approximately 0.017453292519943295', () => {
      expect(DEG_TO_RAD).toBeCloseTo(0.017453292519943295, 15)
    })

    it('RAD_TO_DEG is approximately 57.29577951308232', () => {
      expect(RAD_TO_DEG).toBeCloseTo(57.29577951308232, 12)
    })
  })

  describe('Time constants', () => {
    it('JD_J2000 is 2451545.0', () => {
      expect(JD_J2000).toBe(2451545.0)
    })

    it('SEC_PER_DAY is 86400', () => {
      expect(SEC_PER_DAY).toBe(86400)
    })

    it('MIN_PER_DAY is 1440', () => {
      expect(MIN_PER_DAY).toBe(1440)
    })
  })

  describe('Physical constants', () => {
    it('C_LIGHT is 299792.458', () => {
      expect(C_LIGHT).toBe(299792.458)
    })

    it('AU_KM is 149597870.7', () => {
      expect(AU_KM).toBe(149597870.7)
    })

    it('RHO_0 is 1.225', () => {
      expect(RHO_0).toBe(1.225)
    })

    it('H_SCALE is 8.5', () => {
      expect(H_SCALE).toBe(8.5)
    })

    it('SRP_1AU is 4.56e-6', () => {
      expect(SRP_1AU).toBe(4.56e-6)
    })
  })
})
