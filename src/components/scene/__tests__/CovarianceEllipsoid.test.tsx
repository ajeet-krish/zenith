import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { makeSceneBasis } from '../CovarianceEllipsoid'
import { ellipsoidAxesFromCov } from '@/orbit/covarianceUtils'

/** Embed a 3x3 position block (row-major) into a 6x6 row-major covariance. */
function cov36FromBlock(block: number[]): number[] {
  const cov = Array.from({ length: 36 }, () => 0)
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      cov[i * 6 + j] = block[i * 3 + j]!
    }
  }
  return cov
}

/** The TEME -> scene permutation applied by toScene (x, z, -y). */
function toSceneVec(v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y)
}

describe('makeSceneBasis', () => {
  it('maps a TEME z major axis onto scene y (up)', () => {
    // Variances 1, 4, 9 along TEME x, y, z: the major axis (eigenvalue 9)
    // is TEME +z, which toScene maps to scene +y (up). Before the fix the
    // ellipsoid lay flat (major axis along scene z) for this covariance.
    const ellipsoid = ellipsoidAxesFromCov(cov36FromBlock([1, 0, 0, 0, 4, 0, 0, 0, 9]))
    expect(ellipsoid).not.toBeNull()

    const basis = makeSceneBasis(ellipsoid!.rotation)
    const majorDir = new THREE.Vector3().setFromMatrixColumn(basis, 2)

    expect(majorDir.x).toBeCloseTo(0, 12)
    expect(majorDir.y).toBeCloseTo(1, 12)
    expect(majorDir.z).toBeCloseTo(0, 12)
  })

  it('permutes an identity TEME rotation exactly like toScene', () => {
    // Identity eigenvectors (axes aligned with TEME): local x/y/z must
    // image onto toScene(e_x), toScene(e_y), toScene(e_z).
    const basis = makeSceneBasis([1, 0, 0, 0, 1, 0, 0, 0, 1])

    const colX = new THREE.Vector3().setFromMatrixColumn(basis, 0)
    const colY = new THREE.Vector3().setFromMatrixColumn(basis, 1)
    const colZ = new THREE.Vector3().setFromMatrixColumn(basis, 2)

    expect(colX.distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-12)
    expect(colY.distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-12)
    expect(colZ.distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-12)
  })

  it('keeps the col k -> semiAxes[k] pairing for a fully tilted covariance', () => {
    // All off-diagonals non-zero: no eigenvector is a unit TEME axis, so
    // every basis column exercises the permutation end to end.
    const block = [4, 1.5, 0.5, 1.5, 5, 1, 0.5, 1, 3]
    const ellipsoid = ellipsoidAxesFromCov(cov36FromBlock(block))
    expect(ellipsoid).not.toBeNull()

    const basis = makeSceneBasis(ellipsoid!.rotation)
    for (let k = 0; k < 3; k += 1) {
      const temeDir = new THREE.Vector3(
        ellipsoid!.rotation[k]!,
        ellipsoid!.rotation[3 + k]!,
        ellipsoid!.rotation[6 + k]!
      )
      const sceneDir = new THREE.Vector3().setFromMatrixColumn(basis, k)
      expect(sceneDir.distanceTo(toSceneVec(temeDir))).toBeLessThan(1e-12)
    }

    // The basis is still a pure rotation (orthonormal, det +1).
    const e = basis.elements
    const det =
      e[0]! * (e[5]! * e[10]! - e[9]! * e[6]!) -
      e[4]! * (e[1]! * e[10]! - e[9]! * e[2]!) +
      e[8]! * (e[1]! * e[6]! - e[5]! * e[2]!)
    expect(det).toBeCloseTo(1, 10)
  })

  it('negates the first column when the input is a reflection (det -1)', () => {
    // jacobiEigen3 sign-normalizes eigenvector columns independently, so the
    // rotation handed to makeSceneBasis is a reflection roughly half the time.
    // Synthetic known reflection: diag(1, 1, -1), det -1 in TEME. The
    // (x, z, -y) scene permutation is itself a proper rotation, so the basis
    // inherits det -1 and would poison setFromRotationMatrix if uncorrected.
    const basis = makeSceneBasis([1, 0, 0, 0, 1, 0, 0, 0, -1])

    expect(basis.determinant()).toBeCloseTo(1, 10)

    // Column 0 is the one allowed to flip (ellipsoid is sign-invariant); the
    // remaining axes keep their TEME -> scene orientation.
    const colX = new THREE.Vector3().setFromMatrixColumn(basis, 0)
    const colY = new THREE.Vector3().setFromMatrixColumn(basis, 1)
    const colZ = new THREE.Vector3().setFromMatrixColumn(basis, 2)
    expect(colX.distanceTo(new THREE.Vector3(-1, 0, 0))).toBeLessThan(1e-12)
    expect(colY.distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-12)
    expect(colZ.distanceTo(new THREE.Vector3(0, -1, 0))).toBeLessThan(1e-12)
  })

  it('forces a sign flip on a valid rotation and keeps the other axes', () => {
    // Fully tilted covariance: its eigensolver rotation happens to have
    // det +1 after the scene permutation. Negate one input column to force
    // det -1 and check the basis corrects by re-negating column 0 only.
    const block = [4, 1.5, 0.5, 1.5, 5, 1, 0.5, 1, 3]
    const clean = ellipsoidAxesFromCov(cov36FromBlock(block))!
    const flippedRotation = [...clean.rotation]
    for (let i = 0; i < 3; i += 1) {
      flippedRotation[i] = -flippedRotation[i]! // negate column 0 (rows 0..2)
    }

    const flipped = makeSceneBasis(flippedRotation)
    expect(flipped.determinant()).toBeCloseTo(1, 10)

    // Column 0 of the output is the negated-back original: it opposes the
    // flipped input column. Columns 1 and 2 image toScene(input col) exactly,
    // so their orientation is preserved.
    for (let k = 0; k < 3; k += 1) {
      const temeDir = new THREE.Vector3(
        flippedRotation[k]!,
        flippedRotation[3 + k]!,
        flippedRotation[6 + k]!
      )
      const sceneDir = new THREE.Vector3().setFromMatrixColumn(flipped, k)
      const expected = toSceneVec(temeDir)
      if (k === 0) {
        expect(sceneDir.dot(expected)).toBeCloseTo(-1, 10)
      } else {
        expect(sceneDir.distanceTo(expected)).toBeLessThan(1e-12)
      }
    }
  })

  it('fixes a det=-1 covariance produced by jacobiEigen3 end to end', () => {
    // Symmetric block chosen so the eigensolver's per-column sign flips leave
    // V with det -1 (verified: det3(rotation) === -1 before the basis fix).
    const block = [
      5.211161, -2.785413, -3.607507,
      -2.785413, 2.263153, -1.701091,
      -3.607507, -1.701091, 9.970329,
    ]
    const ellipsoid = ellipsoidAxesFromCov(cov36FromBlock(block))
    expect(ellipsoid).not.toBeNull()

    const basis = makeSceneBasis(ellipsoid!.rotation)
    expect(basis.determinant()).toBeCloseTo(1, 10)

    // Columns 1 and 2 image toScene(eigenvector k) exactly; column 0 may be
    // negated but must stay collinear with toScene(eigenvector 0).
    for (let k = 0; k < 3; k += 1) {
      const temeDir = new THREE.Vector3(
        ellipsoid!.rotation[k]!,
        ellipsoid!.rotation[3 + k]!,
        ellipsoid!.rotation[6 + k]!
      )
      const sceneDir = new THREE.Vector3().setFromMatrixColumn(basis, k)
      const expected = toSceneVec(temeDir)
      if (k === 0) {
        expect(Math.abs(sceneDir.dot(expected))).toBeCloseTo(1, 10)
      } else {
        expect(sceneDir.distanceTo(expected)).toBeLessThan(1e-12)
      }
    }

    // setFromRotationMatrix must now yield a unit quaternion that reconstructs
    // the basis (the original bug: a reflection basis made this lossy).
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis)
    expect(quaternion.length()).toBeCloseTo(1, 10)
    const rebuilt = new THREE.Matrix4().makeRotationFromQuaternion(quaternion)
    expect(rebuilt.determinant()).toBeCloseTo(1, 10)
    for (let i = 0; i < 16; i += 1) {
      expect(rebuilt.elements[i]!).toBeCloseTo(basis.elements[i]!, 10)
    }
  })
})
