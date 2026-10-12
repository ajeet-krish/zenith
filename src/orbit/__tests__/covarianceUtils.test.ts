import { describe, it, expect } from 'vitest'
import { jacobiEigen3, ellipsoidAxesFromCov } from '../covarianceUtils'

// =============================================================================
// Helpers
// =============================================================================

/** Multiply two 3x3 matrices given as row-major arrays. */
function mat3Mul(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0)
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let sum = 0
      for (let k = 0; k < 3; k += 1) {
        sum += a[i * 3 + k]! * b[k * 3 + j]!
      }
      out[i * 3 + j] = sum
    }
  }
  return out
}

/** Transpose a row-major 3x3 matrix. */
function mat3T(a: number[]): number[] {
  return [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!]
}

/** 3x3 rotation about the X axis [rad] (row-major). */
function rotX(angle: number): number[] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [1, 0, 0, 0, c, -s, 0, s, c]
}

/** 3x3 rotation about the Z axis [rad] (row-major). */
function rotZ(angle: number): number[] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

/** diag(d0, d1, d2) as a row-major 3x3. */
function diag3(d0: number, d1: number, d2: number): number[] {
  return [d0, 0, 0, 0, d1, 0, 0, 0, d2]
}

/** Build R diag(w) R^T for a rotation R and diagonal w (all row-major). */
function rotatedDiag(w: number[], rotation: number[]): number[] {
  return mat3Mul(mat3Mul(rotation, diag3(w[0]!, w[1]!, w[2]!)), mat3T(rotation))
}

/** Embed a 3x3 position block into a 6x6 row-major covariance (36 values). */
function cov6FromPositionBlock(block: number[]): number[] {
  const cov = new Array<number>(36).fill(0)
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      cov[r * 6 + c] = block[r * 3 + c]!
    }
  }
  return cov
}

/** Row-major 3x3 product V diag(w) V^T (the reconstruction of the input). */
function reconstruct(eigenvalues: [number, number, number], eigenvectors: number[]): number[] {
  return rotatedDiag([...eigenvalues], eigenvectors)
}

/** Assert V V^T = I within tolerance. */
function expectOrthonormal(v: number[]): void {
  const identity = mat3Mul(v, mat3T(v))
  for (let i = 0; i < 9; i += 1) {
    expect(identity[i]!).toBeCloseTo(i % 4 === 0 ? 1 : 0, 10)
  }
}

// =============================================================================
// jacobiEigen3
// =============================================================================

describe('jacobiEigen3', () => {
  it('identity matrix yields ascending unit eigenvalues and an orthonormal V', () => {
    const { eigenvalues, eigenvectors } = jacobiEigen3([1, 0, 0, 0, 1, 0, 0, 0, 1])
    expect(eigenvalues).toEqual([1, 1, 1])
    expectOrthonormal(eigenvectors)
    // Reconstruction of the identity.
    const reconstructed = reconstruct(eigenvalues, eigenvectors)
    for (let i = 0; i < 9; i += 1) {
      expect(reconstructed[i]!).toBeCloseTo(i % 4 === 0 ? 1 : 0, 10)
    }
  })

  it('diagonal covariance (4, 1, 0.25) yields ascending eigenvalues with matching columns', () => {
    const { eigenvalues, eigenvectors } = jacobiEigen3(diag3(4, 1, 0.25))
    expect(eigenvalues[0]).toBeCloseTo(0.25, 12)
    expect(eigenvalues[1]).toBeCloseTo(1, 12)
    expect(eigenvalues[2]).toBeCloseTo(4, 12)
    // Columns of V are the coordinate axes permuted to the ascending order:
    // col0 = e_z (eigenvalue 0.25), col1 = e_y, col2 = e_x.
    expect(eigenvectors).toEqual([0, 0, 1, 0, 1, 0, 1, 0, 0])
    expectOrthonormal(eigenvectors)
  })

  it('known rotated covariance matches analytic eigenvalues with orthonormal eigenvectors', () => {
    const w = [4, 1, 0.25]
    const rotation = mat3Mul(rotZ(0.7), rotX(0.4))
    const cov = rotatedDiag(w, rotation)
    const { eigenvalues, eigenvectors } = jacobiEigen3(cov)

    expect(eigenvalues[0]).toBeCloseTo(0.25, 9)
    expect(eigenvalues[1]).toBeCloseTo(1, 9)
    expect(eigenvalues[2]).toBeCloseTo(4, 9)
    expectOrthonormal(eigenvectors)

    // Reconstruction: V diag(w) V^T must reproduce the input covariance.
    const reconstructed = reconstruct(eigenvalues, eigenvectors)
    for (let i = 0; i < 9; i += 1) {
      expect(reconstructed[i]!).toBeCloseTo(cov[i]!, 9)
    }
  })

  it('clamps tiny negative eigenvalues (numerical noise) to zero', () => {
    const { eigenvalues } = jacobiEigen3(diag3(4, 1, -1e-15))
    expect(eigenvalues[0]).toBe(0)
    expect(eigenvalues[1]).toBeCloseTo(1, 12)
    expect(eigenvalues[2]).toBeCloseTo(4, 12)
  })

  it('keeps large negative eigenvalues for the caller to guard', () => {
    const { eigenvalues } = jacobiEigen3(diag3(4, 1, -2))
    expect(eigenvalues[0]).toBeCloseTo(-2, 12)
    expect(eigenvalues[1]).toBeCloseTo(1, 12)
    expect(eigenvalues[2]).toBeCloseTo(4, 12)
  })

  it('symmetrizes mildly asymmetric input', () => {
    // Asymmetric pair (0.5, 0.3) is treated as its average 0.4.
    const { eigenvalues } = jacobiEigen3([2, 0.5, 0, 0.3, 2, 0, 0, 0, 2])
    // Eigenvalues of the symmetrized matrix: 2 - 0.4, 2, 2 + 0.4.
    expect(eigenvalues[0]).toBeCloseTo(1.6, 12)
    expect(eigenvalues[1]).toBeCloseTo(2, 12)
    expect(eigenvalues[2]).toBeCloseTo(2.4, 12)
  })

  it('throws on input that is not exactly 9 values', () => {
    expect(() => jacobiEigen3([1, 0, 0])).toThrow(/exactly 9 values/)
  })
})

// =============================================================================
// ellipsoidAxesFromCov
// =============================================================================

describe('ellipsoidAxesFromCov', () => {
  it('identity covariance yields sigma-scaled unit axes aligned with the scene', () => {
    const result = ellipsoidAxesFromCov(cov6FromPositionBlock(diag3(1, 1, 1)))
    expect(result).not.toBeNull()
    expect(result!.semiAxes[0]).toBeCloseTo(3, 12)
    expect(result!.semiAxes[1]).toBeCloseTo(3, 12)
    expect(result!.semiAxes[2]).toBeCloseTo(3, 12)
    // Identity input: sign-normalized eigenvector matrix is the identity.
    expect(result!.rotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])

    // Custom sigma scales the axes.
    const oneSigma = ellipsoidAxesFromCov(cov6FromPositionBlock(diag3(1, 1, 1)), 1)
    expect(oneSigma!.semiAxes).toEqual([1, 1, 1])
  })

  it('diagonal covariance (4, 1, 0.25) yields ascending axes sigma*(0.5, 1, 2)', () => {
    const result = ellipsoidAxesFromCov(cov6FromPositionBlock(diag3(4, 1, 0.25)))
    expect(result).not.toBeNull()
    expect(result!.semiAxes[0]).toBeCloseTo(1.5, 12) // 3 * sqrt(0.25)
    expect(result!.semiAxes[1]).toBeCloseTo(3, 12) // 3 * sqrt(1)
    expect(result!.semiAxes[2]).toBeCloseTo(6, 12) // 3 * sqrt(4)
    expectOrthonormal(result!.rotation)
  })

  it('rotated covariance reconstructs the position block from axes and rotation', () => {
    const w = [4, 1, 0.25]
    const rotation = mat3Mul(rotZ(0.7), rotX(0.4))
    const block = rotatedDiag(w, rotation)
    const result = ellipsoidAxesFromCov(cov6FromPositionBlock(block))
    expect(result).not.toBeNull()
    expect(result!.semiAxes[0]).toBeCloseTo(3 * Math.sqrt(0.25), 9)
    expect(result!.semiAxes[1]).toBeCloseTo(3 * 1, 9)
    expect(result!.semiAxes[2]).toBeCloseTo(3 * 2, 9)
    expectOrthonormal(result!.rotation)

    // R diag((axes/sigma)^2) R^T must reproduce the original block: the
    // squared semi-axes divided by sigma^2 are the eigenvalues.
    const eigenvalues: [number, number, number] = [
      (result!.semiAxes[0] / 3) ** 2,
      (result!.semiAxes[1] / 3) ** 2,
      (result!.semiAxes[2] / 3) ** 2,
    ]
    const reconstructed = reconstruct(eigenvalues, result!.rotation)
    for (let i = 0; i < 9; i += 1) {
      expect(reconstructed[i]!).toBeCloseTo(block[i]!, 9)
    }
  })

  it('all-zero covariance returns null', () => {
    expect(ellipsoidAxesFromCov(new Array<number>(36).fill(0))).toBeNull()
  })

  it('all-zero position block returns null even when the velocity block is non-zero', () => {
    const cov = new Array<number>(36).fill(0)
    // Velocity block (indices 21, 28, 35) is non-zero; position block stays zero.
    cov[21] = 1e-6
    cov[28] = 1e-6
    cov[35] = 1e-6
    expect(ellipsoidAxesFromCov(cov)).toBeNull()
  })

  it('input of the wrong length returns null', () => {
    expect(ellipsoidAxesFromCov(diag3(1, 1, 1))).toBeNull()
  })

  it('non-finite entries return null', () => {
    const cov = cov6FromPositionBlock(diag3(1, 1, 1))
    cov[0] = Number.NaN
    expect(ellipsoidAxesFromCov(cov)).toBeNull()
  })

  it('clamps a tiny negative eigenvalue so the minor axis is zero', () => {
    const result = ellipsoidAxesFromCov(cov6FromPositionBlock(diag3(4, 1, -1e-15)))
    expect(result).not.toBeNull()
    expect(result!.semiAxes[0]).toBe(0)
    expect(result!.semiAxes[1]).toBeCloseTo(3, 12)
    expect(result!.semiAxes[2]).toBeCloseTo(6, 12)
  })
})
