// =============================================================================
// Zenith Web - Covariance Utilities (Phase 5: OD Visualization)
// =============================================================================
// Pure-TS symmetric 3x3 eigendecomposition and covariance-to-ellipsoid
// extraction for rendering uncertainty ellipsoids in the 3D scene. No WASM,
// store, or DOM dependencies so the logic is fully unit-testable.

/** Convergence tolerance for the cyclic Jacobi eigensolver (relative to matrix scale). */
const JACOBI_TOL = 1e-12

/** Defensive cap on cyclic sweeps; Jacobi on 3x3 converges in far fewer. */
const JACOBI_MAX_SWEEPS = 30

/**
 * Eigenpair result for a symmetric 3x3 matrix.
 *
 * Eigenvector convention: `eigenvectors` holds 9 values in row-major order
 * (the 3x3 matrix V). The eigenvector for `eigenvalues[k]` is COLUMN k of V:
 * `[V[k], V[3 + k], V[6 + k]]`. V is orthonormal (V V^T = I), eigenvalues are
 * sorted ASCENDING, and each column is sign-normalized so its
 * largest-magnitude component is positive (deterministic output; the
 * reconstruction V diag(w) V^T is sign-invariant).
 */
export interface JacobiEigen3Result {
  /** Eigenvalues sorted ASCENDING. */
  eigenvalues: [number, number, number]
  /** Orthonormal eigenvector matrix V (9 values, row-major); column k belongs to eigenvalues[k]. */
  eigenvectors: number[]
}

/**
 * Position uncertainty ellipsoid derived from a 6x6 state covariance.
 *
 * `semiAxes` are sorted ASCENDING and `rotation` (9 values, row-major) has the
 * matching eigenvectors as COLUMNS, so the ellipsoid surface point in body
 * axes is `rotation * (a*cos(u), b*sin(u)*cos(v), c*sin(u)*sin(v))`.
 */
export interface CovarianceEllipsoid {
  /** Ellipsoid semi-axes [minor, medium, major] in km (sigma * sqrt(eigenvalue)). */
  semiAxes: [number, number, number]
  /** Rotation matrix (3x3 row-major) whose columns are the covariance eigenvectors. */
  rotation: number[]
}

/**
 * Cyclic Jacobi eigendecomposition of a symmetric 3x3 matrix.
 *
 * @param cov9 3x3 matrix in row-major order (9 values). Mild asymmetry is
 *   tolerated: off-diagonal pairs are averaged before the solve.
 * @returns Eigenvalues ASCENDING with matching eigenvector COLUMNS (see
 *   JacobiEigen3Result). Tiny negative eigenvalues (numerical noise, magnitude
 *   <= 1e-12 * max(1, max|eigenvalue|)) are clamped to 0; larger negatives are
 *   returned as-is and the caller guards.
 * @throws Error when cov9 does not contain exactly 9 values.
 */
export function jacobiEigen3(cov9: number[]): JacobiEigen3Result {
  if (cov9.length !== 9) {
    throw new Error(`jacobiEigen3 requires exactly 9 values, got ${cov9.length}`)
  }

  // Working copy, symmetrized defensively (Jacobi assumes exact symmetry).
  const a = [
    cov9[0]!, (cov9[1]! + cov9[3]!) / 2, (cov9[2]! + cov9[6]!) / 2,
    (cov9[1]! + cov9[3]!) / 2, cov9[4]!, (cov9[5]! + cov9[7]!) / 2,
    (cov9[2]! + cov9[6]!) / 2, (cov9[5]! + cov9[7]!) / 2, cov9[8]!,
  ]
  // Accumulator: eigenvector matrix V, starts as identity.
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]

  // Deterministic pivot sweep order for 3x3.
  const pairs: Array<[number, number]> = [[0, 1], [0, 2], [1, 2]]

  for (let sweep = 0; sweep < JACOBI_MAX_SWEEPS; sweep += 1) {
    const off = Math.hypot(a[1]!, a[2]!, a[5]!)
    const scale = Math.max(1, Math.abs(a[0]!), Math.abs(a[4]!), Math.abs(a[8]!))
    if (off <= JACOBI_TOL * scale) {
      break
    }
    for (const [p, q] of pairs) {
      rotateJacobi(a, v, p, q)
    }
  }

  const eigenvalues: [number, number, number] = [a[0]!, a[4]!, a[8]!]

  // Clamp tiny negatives from numerical noise; keep large negatives as-is.
  const maxAbs = Math.max(Math.abs(eigenvalues[0]), Math.abs(eigenvalues[1]), Math.abs(eigenvalues[2]))
  const clampBound = JACOBI_TOL * Math.max(1, maxAbs)
  for (let i = 0; i < 3; i += 1) {
    if (eigenvalues[i]! < 0 && eigenvalues[i]! >= -clampBound) {
      eigenvalues[i] = 0
    }
  }

  // Sort eigenvalues ascending, permuting eigenvector columns to match.
  sortEigenpairsAscending(eigenvalues, v)

  // Deterministic sign convention: largest-magnitude component of each
  // eigenvector column is positive.
  for (let k = 0; k < 3; k += 1) {
    let maxIdx = 0
    for (let i = 1; i < 3; i += 1) {
      if (Math.abs(v[i * 3 + k]!) > Math.abs(v[maxIdx * 3 + k]!)) {
        maxIdx = i
      }
    }
    if (v[maxIdx * 3 + k]! < 0) {
      for (let i = 0; i < 3; i += 1) {
        v[i * 3 + k] = -v[i * 3 + k]!
      }
    }
  }

  return { eigenvalues, eigenvectors: v }
}

/**
 * Extract the 3-sigma position uncertainty ellipsoid from a 6x6 state
 * covariance (row-major, [x, y, z, vx, vy, vz]).
 *
 * Uses the position block cov[0..2, 0..2], eigendecomposes it, and returns
 * semi-axes = sigma * sqrt(max(eigenvalue, 0)) with the matching eigenvector
 * rotation.
 *
 * @param cov36 6x6 covariance in row-major order (36 values).
 * @param sigma Scale factor in sigmas (default 3 for a 3-sigma ellipsoid).
 * @returns The ellipsoid, or null when cov36 is not length 36, contains
 *   non-finite entries, or its position block is all-zero (degenerate).
 */
export function ellipsoidAxesFromCov(cov36: number[], sigma = 3): CovarianceEllipsoid | null {
  if (cov36.length !== 36) {
    return null
  }

  // Position block rows 0..2, cols 0..2 of the row-major 6x6, symmetrized.
  const block = [
    cov36[0]!, (cov36[1]! + cov36[6]!) / 2, (cov36[2]! + cov36[12]!) / 2,
    (cov36[1]! + cov36[6]!) / 2, cov36[7]!, (cov36[8]! + cov36[13]!) / 2,
    (cov36[2]! + cov36[12]!) / 2, (cov36[8]! + cov36[13]!) / 2, cov36[14]!,
  ]

  for (const entry of block) {
    if (!Number.isFinite(entry)) {
      return null
    }
  }
  const maxAbs = Math.max(...block.map((x) => Math.abs(x)))
  if (maxAbs === 0) {
    return null
  }

  const { eigenvalues, eigenvectors } = jacobiEigen3(block)
  const semiAxes: [number, number, number] = [
    sigma * Math.sqrt(Math.max(eigenvalues[0], 0)),
    sigma * Math.sqrt(Math.max(eigenvalues[1], 0)),
    sigma * Math.sqrt(Math.max(eigenvalues[2], 0)),
  ]
  return { semiAxes, rotation: eigenvectors }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Zero out a_pq with a Jacobi rotation and accumulate it into V.
 * `a` and `v` are row-major 3x3 arrays updated in place.
 */
function rotateJacobi(a: number[], v: number[], p: number, q: number): void {
  const apq = a[p * 3 + q]!
  if (apq === 0) {
    return
  }
  const app = a[p * 3 + p]!
  const aqq = a[q * 3 + q]!

  const tau = (aqq - app) / (2 * apq)
  const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau))
  const c = 1 / Math.sqrt(1 + t * t)
  const s = t * c

  // Update the pivot rows/columns.
  a[p * 3 + p] = app - t * apq
  a[q * 3 + q] = aqq + t * apq
  a[p * 3 + q] = 0
  a[q * 3 + p] = 0

  // Update the remaining rows/columns k != p, q.
  for (let k = 0; k < 3; k += 1) {
    if (k === p || k === q) {
      continue
    }
    const akp = a[k * 3 + p]!
    const akq = a[k * 3 + q]!
    a[k * 3 + p] = c * akp - s * akq
    a[p * 3 + k] = a[k * 3 + p]!
    a[k * 3 + q] = s * akp + c * akq
    a[q * 3 + k] = a[k * 3 + q]!
  }

  // Accumulate the rotation into the eigenvector columns.
  for (let i = 0; i < 3; i += 1) {
    const vip = v[i * 3 + p]!
    const viq = v[i * 3 + q]!
    v[i * 3 + p] = c * vip - s * viq
    v[i * 3 + q] = s * vip + c * viq
  }
}

/** Insertion-sort 3 eigenvalues ascending, permuting eigenvector columns to match. */
function sortEigenpairsAscending(w: [number, number, number], v: number[]): void {
  for (let i = 1; i < 3; i += 1) {
    for (let j = i; j > 0 && w[j - 1]! > w[j]!; j -= 1) {
      const tmp = w[j - 1]!
      w[j - 1] = w[j]!
      w[j] = tmp
      // Swap eigenvector columns j-1 and j.
      for (let row = 0; row < 3; row += 1) {
        const t = v[row * 3 + j - 1]!
        v[row * 3 + j - 1] = v[row * 3 + j]!
        v[row * 3 + j] = t
      }
    }
  }
}
