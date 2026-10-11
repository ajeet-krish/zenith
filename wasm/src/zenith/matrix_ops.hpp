#pragma once

/// @file matrix_ops.hpp
/// @brief Fixed-size dense linear algebra for orbit determination.
///        Template Vec<N> and Mat<M,N> with row-major std::array storage,
///        zero heap allocation in the hot path.  Sizes needed by the OD
///        suite: 3x3 (Gauss IOD, force Jacobians), 6x6 (batch normal
///        equations, EKF covariance), 7x7 (drag-augmented STM), 9x9 plus
///        vector sizes 3, 6, 7, 9.
///
///        Distinct from orbit_types.hpp Vec3 (named struct with .x/.y/.z);
///        conversion helpers bridge at the boundary.
///
///        Reference: Golub & Van Loan, "Matrix Computations", 4th ed.

#include <array>
#include <cmath>
#include <cstddef>

#include "orbit_types.hpp"

namespace orbit {

// ============================================================================
// Vec<N>: fixed-size vector
// ============================================================================

/// Fixed-size vector of N doubles, stack allocated.
template <std::size_t N>
struct Vec {
    static constexpr std::size_t SIZE = N;

    std::array<double, N> data{};

    /// Element access.
    double& operator[](std::size_t i) { return data[i]; }
    const double& operator[](std::size_t i) const { return data[i]; }

    /// Element access with bounds contract in debug via assert-like check
    /// left to the caller; operator[] matches std::array semantics.
    double* begin() { return data.data(); }
    double* end() { return data.data() + N; }
    const double* begin() const { return data.data(); }
    const double* end() const { return data.data() + N; }

    /// Vector addition.
    Vec operator+(const Vec& rhs) const {
        Vec out;
        for (std::size_t i = 0; i < N; ++i) out.data[i] = data[i] + rhs.data[i];
        return out;
    }

    /// Vector subtraction.
    Vec operator-(const Vec& rhs) const {
        Vec out;
        for (std::size_t i = 0; i < N; ++i) out.data[i] = data[i] - rhs.data[i];
        return out;
    }

    /// Scalar multiplication.
    Vec operator*(double s) const {
        Vec out;
        for (std::size_t i = 0; i < N; ++i) out.data[i] = data[i] * s;
        return out;
    }

    /// In-place addition.
    Vec& operator+=(const Vec& rhs) {
        for (std::size_t i = 0; i < N; ++i) data[i] += rhs.data[i];
        return *this;
    }

    /// In-place subtraction.
    Vec& operator-=(const Vec& rhs) {
        for (std::size_t i = 0; i < N; ++i) data[i] -= rhs.data[i];
        return *this;
    }

    /// In-place scalar multiplication.
    Vec& operator*=(double s) {
        for (std::size_t i = 0; i < N; ++i) data[i] *= s;
        return *this;
    }

    /// Euclidean norm.
    [[nodiscard]] double norm() const {
        double sum = 0.0;
        for (std::size_t i = 0; i < N; ++i) sum += data[i] * data[i];
        return std::sqrt(sum);
    }

    /// Squared norm (avoids sqrt).
    [[nodiscard]] double squared_norm() const {
        double sum = 0.0;
        for (std::size_t i = 0; i < N; ++i) sum += data[i] * data[i];
        return sum;
    }

    /// Dot product.
    [[nodiscard]] double dot(const Vec& rhs) const {
        double sum = 0.0;
        for (std::size_t i = 0; i < N; ++i) sum += data[i] * rhs.data[i];
        return sum;
    }
};

/// Scalar * Vec.
template <std::size_t N>
inline Vec<N> operator*(double s, const Vec<N>& v) {
    return v * s;
}

// ============================================================================
// Mat<M,N>: fixed-size matrix, row-major
// ============================================================================

/// Fixed-size M x N matrix with row-major std::array storage.
template <std::size_t M, std::size_t N>
struct Mat {
    static constexpr std::size_t ROWS = M;
    static constexpr std::size_t COLS = N;

    std::array<double, M * N> data{};

    /// Element access (row, col).
    double& operator()(std::size_t i, std::size_t j) { return data[i * N + j]; }
    const double& operator()(std::size_t i, std::size_t j) const {
        return data[i * N + j];
    }

    double* begin() { return data.data(); }
    double* end() { return data.data() + M * N; }
    const double* begin() const { return data.data(); }
    const double* end() const { return data.data() + M * N; }

    /// Matrix addition.
    Mat operator+(const Mat& rhs) const {
        Mat out;
        for (std::size_t k = 0; k < M * N; ++k) out.data[k] = data[k] + rhs.data[k];
        return out;
    }

    /// Matrix subtraction.
    Mat operator-(const Mat& rhs) const {
        Mat out;
        for (std::size_t k = 0; k < M * N; ++k) out.data[k] = data[k] - rhs.data[k];
        return out;
    }

    /// Scalar multiplication.
    Mat operator*(double s) const {
        Mat out;
        for (std::size_t k = 0; k < M * N; ++k) out.data[k] = data[k] * s;
        return out;
    }

    /// In-place addition.
    Mat& operator+=(const Mat& rhs) {
        for (std::size_t k = 0; k < M * N; ++k) data[k] += rhs.data[k];
        return *this;
    }

    /// In-place scalar multiplication.
    Mat& operator*=(double s) {
        for (std::size_t k = 0; k < M * N; ++k) data[k] *= s;
        return *this;
    }
};

// ============================================================================
// Construction Helpers
// ============================================================================

/// M x N zero matrix.
template <std::size_t M, std::size_t N>
inline Mat<M, N> zeros() {
    return Mat<M, N>{};
}

/// N x N identity matrix.
template <std::size_t N>
inline Mat<N, N> identity() {
    Mat<N, N> out;
    for (std::size_t i = 0; i < N; ++i) out(i, i) = 1.0;
    return out;
}

// ============================================================================
// Multiplication
// ============================================================================

/// Matrix-matrix product C = A * B (M x K times K x N).
template <std::size_t M, std::size_t K, std::size_t N>
inline Mat<M, N> multiply(const Mat<M, K>& a, const Mat<K, N>& b) {
    Mat<M, N> out;
    for (std::size_t i = 0; i < M; ++i) {
        for (std::size_t k = 0; k < K; ++k) {
            const double aik = a(i, k);
            if (aik == 0.0) continue;
            for (std::size_t j = 0; j < N; ++j) {
                out(i, j) += aik * b(k, j);
            }
        }
    }
    return out;
}

/// Matrix-vector product y = A * x.
template <std::size_t M, std::size_t N>
inline Vec<M> multiply(const Mat<M, N>& a, const Vec<N>& x) {
    Vec<M> out;
    for (std::size_t i = 0; i < M; ++i) {
        double sum = 0.0;
        for (std::size_t j = 0; j < N; ++j) sum += a(i, j) * x[j];
        out[i] = sum;
    }
    return out;
}

/// Matrix * scalar.
template <std::size_t M, std::size_t N>
inline Mat<M, N> operator*(double s, const Mat<M, N>& m) {
    return m * s;
}

/// Matrix * matrix alias matching operator notation.
template <std::size_t M, std::size_t K, std::size_t N>
inline Mat<M, N> operator*(const Mat<M, K>& a, const Mat<K, N>& b) {
    return multiply(a, b);
}

/// Matrix * vector alias matching operator notation.
template <std::size_t M, std::size_t N>
inline Vec<M> operator*(const Mat<M, N>& a, const Vec<N>& x) {
    return multiply(a, x);
}

// ============================================================================
// Transpose / Add / Scale
// ============================================================================

/// Transpose of an M x N matrix (returns N x M).
template <std::size_t M, std::size_t N>
inline Mat<N, M> transpose(const Mat<M, N>& a) {
    Mat<N, M> out;
    for (std::size_t i = 0; i < M; ++i) {
        for (std::size_t j = 0; j < N; ++j) {
            out(j, i) = a(i, j);
        }
    }
    return out;
}

/// Element-wise matrix addition.
template <std::size_t M, std::size_t N>
inline Mat<M, N> add(const Mat<M, N>& a, const Mat<M, N>& b) {
    return a + b;
}

/// Scale a matrix by a scalar.
template <std::size_t M, std::size_t N>
inline Mat<M, N> scale(const Mat<M, N>& a, double s) {
    return a * s;
}

// ============================================================================
// Norms
// ============================================================================

/// Frobenius norm of a matrix.
template <std::size_t M, std::size_t N>
inline double frobenius_norm(const Mat<M, N>& a) {
    double sum = 0.0;
    for (double v : a.data) sum += v * v;
    return std::sqrt(sum);
}

/// Maximum absolute element of a matrix.
template <std::size_t M, std::size_t N>
inline double max_abs(const Mat<M, N>& a) {
    double m = 0.0;
    for (double v : a.data) m = std::max(m, std::abs(v));
    return m;
}

/// Symmetrize a square matrix: (A + A^T) / 2.
template <std::size_t N>
inline Mat<N, N> symmetrize(const Mat<N, N>& a) {
    Mat<N, N> out;
    for (std::size_t i = 0; i < N; ++i) {
        for (std::size_t j = 0; j < N; ++j) {
            out(i, j) = 0.5 * (a(i, j) + a(j, i));
        }
    }
    return out;
}

// ============================================================================
// LU Decomposition with Partial Pivoting
// ============================================================================

/// Smallest pivot treated as numerically singular.
inline constexpr double LU_PIVOT_TOLERANCE = 1e-14;

/// In-place LU factorization with partial pivoting (Doolittle).
///
/// Overwrites `lu` with the combined L (unit diagonal, below) and U
/// (on/above diagonal) factors; `pivots` receives the row permutation
/// (pivots[k] = row swapped into row k at step k).
///
/// @param lu      Matrix to factor (overwritten on success).
/// @param pivots  Output pivot permutation, size N.
/// @return True if factorization succeeded; false if a pivot was singular.
template <std::size_t N>
inline bool lu_factor(Mat<N, N>& lu, std::array<std::size_t, N>& pivots) {
    for (std::size_t i = 0; i < N; ++i) pivots[i] = i;

    for (std::size_t k = 0; k < N; ++k) {
        // Find pivot: row with max absolute value in column k at/below k.
        std::size_t pivot_row = k;
        double pivot_mag = std::abs(lu(k, k));
        for (std::size_t i = k + 1; i < N; ++i) {
            const double mag = std::abs(lu(i, k));
            if (mag > pivot_mag) {
                pivot_mag = mag;
                pivot_row = i;
            }
        }
        if (pivot_mag < LU_PIVOT_TOLERANCE) {
            return false;  // Singular matrix.
        }
        if (pivot_row != k) {
            for (std::size_t j = 0; j < N; ++j) {
                const double tmp = lu(k, j);
                lu(k, j) = lu(pivot_row, j);
                lu(pivot_row, j) = tmp;
            }
            const std::size_t tmp_p = pivots[k];
            pivots[k] = pivots[pivot_row];
            pivots[pivot_row] = tmp_p;
        }

        // Eliminate below the diagonal.
        const double pivot = lu(k, k);
        for (std::size_t i = k + 1; i < N; ++i) {
            const double factor = lu(i, k) / pivot;
            lu(i, k) = factor;
            if (factor == 0.0) continue;
            for (std::size_t j = k + 1; j < N; ++j) {
                lu(i, j) -= factor * lu(k, j);
            }
        }
    }
    return true;
}

/// Solve A x = b given a factored matrix from lu_factor().
template <std::size_t N>
inline void lu_solve_factored(const Mat<N, N>& lu,
                              const std::array<std::size_t, N>& pivots,
                              const Vec<N>& b,
                              Vec<N>& x) {
    // Apply permutation: x[i] = b[pivots[i]].
    for (std::size_t i = 0; i < N; ++i) x[i] = b[pivots[i]];

    // Forward substitution (L, unit diagonal).
    for (std::size_t i = 1; i < N; ++i) {
        double sum = x[i];
        for (std::size_t j = 0; j < i; ++j) sum -= lu(i, j) * x[j];
        x[i] = sum;
    }

    // Back substitution (U).
    for (std::size_t i = N; i-- > 0;) {
        double sum = x[i];
        for (std::size_t j = i + 1; j < N; ++j) sum -= lu(i, j) * x[j];
        x[i] = sum / lu(i, i);
    }
}

/// Solve A x = b in place of factorizing every call.
///
/// @param a  Coefficient matrix (copied internally; not modified).
/// @param b  Right-hand side.
/// @param x  Output solution.
/// @return True on success; false if A is numerically singular.
template <std::size_t N>
inline bool lu_solve(const Mat<N, N>& a, const Vec<N>& b, Vec<N>& x) {
    Mat<N, N> lu = a;
    std::array<std::size_t, N> pivots{};
    if (!lu_factor(lu, pivots)) {
        return false;
    }
    lu_solve_factored(lu, pivots, b, x);
    return true;
}

// ============================================================================
// Inverse via LU
// ============================================================================

/// Inverse of a square matrix via LU factorization with partial pivoting.
///
/// @param a       Matrix to invert.
/// @param a_inv   Output inverse.
/// @return True on success; false if A is numerically singular.
template <std::size_t N>
inline bool inverse(const Mat<N, N>& a, Mat<N, N>& a_inv) {
    Mat<N, N> lu = a;
    std::array<std::size_t, N> pivots{};
    if (!lu_factor(lu, pivots)) {
        return false;
    }
    for (std::size_t col = 0; col < N; ++col) {
        Vec<N> e;
        e[col] = 1.0;
        Vec<N> col_out;
        lu_solve_factored(lu, pivots, e, col_out);
        for (std::size_t i = 0; i < N; ++i) {
            a_inv(i, col) = col_out[i];
        }
    }
    return true;
}

// ============================================================================
// Cholesky Decomposition (positive definite)
// ============================================================================

/// Smallest pivot treated as numerically non-positive-definite.
inline constexpr double CHOLESKY_PIVOT_TOLERANCE = 1e-14;

/// In-place Cholesky factorization A = L * L^T for symmetric positive
/// definite A.  Only the lower triangle of `l` is written; the upper
/// triangle is left zero.
///
/// @param a  Symmetric positive definite matrix (only lower triangle read).
/// @param l  Output lower-triangular factor.
/// @return True if A is positive definite; false otherwise.
template <std::size_t N>
inline bool cholesky(const Mat<N, N>& a, Mat<N, N>& l) {
    for (std::size_t j = 0; j < N; ++j) {
        double d = a(j, j);
        for (std::size_t k = 0; k < j; ++k) {
            d -= l(j, k) * l(j, k);
        }
        if (d <= CHOLESKY_PIVOT_TOLERANCE) {
            return false;  // Not positive definite.
        }
        l(j, j) = std::sqrt(d);
        for (std::size_t i = j + 1; i < N; ++i) {
            double sum = a(i, j);
            for (std::size_t k = 0; k < j; ++k) {
                sum -= l(i, k) * l(j, k);
            }
            l(i, j) = sum / l(j, j);
        }
    }
    return true;
}

/// Solve A x = b given the Cholesky factor L of A (A = L L^T).
template <std::size_t N>
inline void cholesky_solve(const Mat<N, N>& l, const Vec<N>& b, Vec<N>& x) {
    // Forward substitution: L y = b.
    for (std::size_t i = 0; i < N; ++i) {
        double sum = b[i];
        for (std::size_t j = 0; j < i; ++j) sum -= l(i, j) * x[j];
        x[i] = sum / l(i, i);
    }
    // Back substitution: L^T x = y (x holds y on entry).
    for (std::size_t i = N; i-- > 0;) {
        double sum = x[i];
        for (std::size_t j = i + 1; j < N; ++j) sum -= l(j, i) * x[j];
        x[i] = sum / l(i, i);
    }
}

// ============================================================================
// orbit_types.hpp Vec3 Conversion Helpers
// ============================================================================

/// Copy a Vec3 into the first 3 entries of a Vec<N> (N >= 3), zeroing the rest.
template <std::size_t N>
inline Vec<N> vec_from_vec3(const Vec3& v) {
    static_assert(N >= 3, "vec_from_vec3 requires N >= 3");
    Vec<N> out;
    out[0] = v.x;
    out[1] = v.y;
    out[2] = v.z;
    return out;
}

/// Extract the first 3 entries of a Vec<N> as a Vec3.
template <std::size_t N>
inline Vec3 vec3_from_vec(const Vec<N>& v) {
    static_assert(N >= 3, "vec3_from_vec requires N >= 3");
    return Vec3(v[0], v[1], v[2]);
}

/// Wrap a raw 3-array as a Vec3.
inline Vec3 vec3_from_ptr(const double* p) {
    return Vec3(p[0], p[1], p[2]);
}

/// Write a Vec3 into a raw 3-array.
inline void vec3_to_ptr(const Vec3& v, double* p) {
    p[0] = v.x;
    p[1] = v.y;
    p[2] = v.z;
}

/// Copy the upper-left 3x3 block of a Mat<N,N> (N >= 3) into a Vec3-major
/// 9-array in row-major order (for legacy mat3_rotate-style consumers).
template <std::size_t N>
inline std::array<double, 9> mat3_from_mat(const Mat<N, N>& m) {
    static_assert(N >= 3, "mat3_from_mat requires N >= 3");
    std::array<double, 9> out{};
    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 3; ++j) {
            out[i * 3 + j] = m(i, j);
        }
    }
    return out;
}

/// 3x3 convenience aliases used throughout the OD suite.
using Vec3d = Vec<3>;
using Vec6d = Vec<6>;
using Vec7d = Vec<7>;
using Vec9d = Vec<9>;
using Mat3d = Mat<3, 3>;
using Mat6d = Mat<6, 6>;
using Mat7d = Mat<7, 7>;
using Mat9d = Mat<9, 9>;

}  // namespace orbit
