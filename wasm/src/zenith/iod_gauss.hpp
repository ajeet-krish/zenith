#pragma once

/// @file iod_gauss.hpp
/// @brief Angles-only initial orbit determination: Herrick-Gibbs velocity
///        and the Gauss method from three RA/Dec observations.
///
///        Golden-master port of helio_ob src/helio/iod_gauss.py. The
///        numerics are replicated exactly (no analytic Jacobians, no LM,
///        same root scan, same Brent parameters, same differential
///        correction steps) so golden-master fixtures agree with the
///        Python reference.
///
///        Units: km, km/s, rad, s, days (epochs as JD). States are ECI
///        (GMST-only frame, matching stations.hpp). gauss_iod takes
///        exactly three RA/Dec observations (one to three stations,
///        strictly increasing epochs) and returns the state at the
///        middle epoch.
///
///        Method (helio iod_gauss.py docstring; Vallado Algorithm 7-4
///        style geometry): the classic cross-product equations (Vallado
///        Eq 7-37 to 7-40, also Escobal) reduce the three slant ranges
///        to a single scalar equation in the middle range rho2; the
///        short-arc f and g series enter at third order with r2.v2
///        approximated by (r3^2 - r1^2) / (2 tau). The scalar equation is
///        solved by a bracketing root scan on a log grid instead of
///        expanding the 8th-order polynomial. Positions follow from the
///        slant ranges and the middle-epoch velocity from Herrick-Gibbs
///        (quartic fit with two-body endpoint accelerations, the
///        formulation behind Vallado Eq 7-46/7-47), and each root is
///        then polished with Gauss-Newton differential correction on the
///        six angle residuals so the returned state exactly fits a
///        two-body trajectory through the observations. Residual,
///        element-sanity, and cross-root consistency checks report
///        error codes on weak geometry (no exceptions across the WASM
///        boundary).
///
///        Reference: helio_ob src/helio/iod_gauss.py (source of truth),
///        Vallado 4th ed. Sec 7.3.2 and 7.5.2.

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <vector>

#include "coordinate_frames.hpp"
#include "kepler.hpp"
#include "matrix_ops.hpp"
#include "observations.hpp"
#include "od_constants.hpp"
#include "orbit_types.hpp"
#include "stations.hpp"
#include "time_system.hpp"

namespace orbit {

// ============================================================================
// GaussIodError: status codes (helio exception taxonomy, no exceptions)
// ============================================================================

/// Status / error codes for gauss_iod and herrick_gibbs results.
///
/// Mirrors helio_ob's exception split: ValueErrors (bad input, singular
/// geometry) map to ERROR_INPUT / ERROR_SINGULAR, RuntimeErrors (no
/// consistent candidate, inconsistent roots) map to ERROR_NO_SOLUTION /
/// ERROR_INCONSISTENT_ROOTS, and the solvable ill-conditioning
/// UserWarning maps to WARNING_ILL_CONDITIONED (result still valid).
enum class GaussIodError : int {
    OK = 0,                        ///< Solution found with nominal geometry.
    WARNING_ILL_CONDITIONED = 1,   ///< 1e8 < cond(L) <= 1e12; state may be inaccurate.
    ERROR_INPUT = 2,               ///< Bad epochs/config (non-increasing, non-positive mu).
    ERROR_SINGULAR = 3,            ///< cond(L) > 1e12 or LOS coplanar with origin (|D0| < 1e-12).
    ERROR_NO_SOLUTION = 4,         ///< No root converged to a consistent physical orbit.
    ERROR_INCONSISTENT_ROOTS = 5   ///< Independent roots disagree by more than 1 km.
};

// ============================================================================
// GaussIodConfig
// ============================================================================

/// Configuration for gauss_iod (helio gauss_iod defaults).
struct GaussIodConfig {
    double mu = MU_EARTH;             ///< Gravitational parameter [km^3/s^2].
    double residual_tol_rad = 1.0e-6; ///< Max acceptable angular residual [rad].
    int max_dc_iter = 25;             ///< Max Gauss-Newton differential correction iterations.
    bool enable_correction = true;    ///< GN polish; false keeps the Herrick-Gibbs seed.
    double cond_warning = 1.0e8;      ///< Ill-conditioning warning threshold.
    double cond_singular = 1.0e12;    ///< Hard singular rejection threshold.
};

// ============================================================================
// GaussIodObs / GaussIodResult / HerrickGibbsResult
// ============================================================================

/// One RA/Dec observation from one station at one epoch.
struct GaussIodObs {
    double time_jd = 0.0;   ///< Observation epoch as Julian Date [days].
    double ra_rad = 0.0;    ///< Right ascension of the line of sight [rad].
    double dec_rad = 0.0;   ///< Declination of the line of sight [rad].
    const ODGroundStation* station = nullptr;  ///< Non-owning station pointer.
};

/// Result of a gauss_iod solve: state at the middle epoch plus diagnostics.
struct GaussIodResult {
    double r[3] = {0.0, 0.0, 0.0};  ///< Position at the middle epoch [km].
    double v[3] = {0.0, 0.0, 0.0};  ///< Velocity at the middle epoch [km/s].
    GaussIodError status = GaussIodError::ERROR_NO_SOLUTION;
    int iterations = 0;             ///< GN iterations on the best candidate.
    double residual_norm = 0.0;     ///< Max angular residual of the best candidate [rad].
    double condition_number = 0.0;  ///< 2-norm condition number of the LOS matrix.
    double ranges[3] = {0.0, 0.0, 0.0};  ///< Best-root slant ranges (rho1, rho2, rho3) [km].
};

/// Result of a herrick_gibbs velocity estimate.
struct HerrickGibbsResult {
    double v[3] = {0.0, 0.0, 0.0};  ///< Velocity at the middle epoch [km/s].
    GaussIodError status = GaussIodError::OK;  ///< OK, or ERROR_INPUT for bad epochs / near-zero positions.
};

// ============================================================================
// Herrick-Gibbs (helio quartic-fit form)
// ============================================================================

/// Velocity at the middle of three positions via Herrick-Gibbs.
///
/// Herrick's formulation underlying Vallado Eq 7-46/7-47: a quartic
/// polynomial in (t - t2) is fit to the three position vectors plus the
/// two-body osculating accelerations a = -mu r / |r|^3 at the two end
/// epochs, and the velocity is the quartic's first derivative at t2.
/// The 4x4 linear system (rows [s, s^2, s^3, s^4], [0, 2, 6s, 12s^2] at
/// s1 = t1 - t2 and s3 = t3 - t2) is solved per component with the
/// Phase 1 LU solver; v2 is the first coefficient row.
///
/// @param r1  Position at t1 [km].
/// @param r2  Position at t2 [km].
/// @param r3  Position at t3 [km].
/// @param t1  First epoch [s].
/// @param t2  Middle epoch [s].
/// @param t3  Last epoch [s].
/// @param mu  Gravitational parameter [km^3/s^2].
/// @return Velocity at t2; status is ERROR_INPUT unless t1 < t2 < t3, the
///         end positions are far from the origin (|r|^3 division guard),
///         and the system is solvable.
inline HerrickGibbsResult herrick_gibbs(const Vec3& r1, const Vec3& r2,
                                        const Vec3& r3, double t1, double t2,
                                        double t3, double mu = MU_EARTH) {
    HerrickGibbsResult out;
    if (!(t1 < t2 && t2 < t3)) {
        out.status = GaussIodError::ERROR_INPUT;
        return out;
    }

    // Guard the two-body accelerations a = -mu r / |r|^3 at the end
    // epochs: a zero or sub-millimeter position vector would produce
    // inf/NaN through the |r|^3 divisor.
    const double r1_norm_sq = r1.dot(r1);
    const double r3_norm_sq = r3.dot(r3);
    constexpr double MIN_NORM_SQ = 1.0e-12;  // |r| < 1e-6 km = 1 mm.
    if (r1_norm_sq < MIN_NORM_SQ || r3_norm_sq < MIN_NORM_SQ) {
        out.status = GaussIodError::ERROR_INPUT;
        return out;
    }

    const double s1 = t1 - t2;
    const double s3 = t3 - t2;
    const Vec3 a1 = r1 * (-mu / std::pow(r1_norm_sq, 1.5));
    const Vec3 a3 = r3 * (-mu / std::pow(r3_norm_sq, 1.5));

    // Unknowns per component: c1 (velocity), c2, c3, c4 with c0 = r2 and
    // r''(0) = 2 c2 free; four equations from the two end positions and
    // the two end accelerations.
    Mat<4, 4> coeff;
    coeff(0, 0) = s1;             coeff(0, 1) = s1 * s1;
    coeff(0, 2) = s1 * s1 * s1;   coeff(0, 3) = s1 * s1 * s1 * s1;
    coeff(1, 0) = s3;             coeff(1, 1) = s3 * s3;
    coeff(1, 2) = s3 * s3 * s3;   coeff(1, 3) = s3 * s3 * s3 * s3;
    coeff(2, 0) = 0.0;            coeff(2, 1) = 2.0;
    coeff(2, 2) = 6.0 * s1;       coeff(2, 3) = 12.0 * s1 * s1;
    coeff(3, 0) = 0.0;            coeff(3, 1) = 2.0;
    coeff(3, 2) = 6.0 * s3;       coeff(3, 3) = 12.0 * s3 * s3;

    // Solve one 4x4 system per Cartesian component; v2 is row 0 of each.
    const double r1c[3] = {r1.x, r1.y, r1.z};
    const double r2c[3] = {r2.x, r2.y, r2.z};
    const double r3c[3] = {r3.x, r3.y, r3.z};
    const double a1c[3] = {a1.x, a1.y, a1.z};
    const double a3c[3] = {a3.x, a3.y, a3.z};
    for (int comp = 0; comp < 3; ++comp) {
        Vec<4> b;
        b[0] = r1c[comp] - r2c[comp];
        b[1] = r3c[comp] - r2c[comp];
        b[2] = a1c[comp];
        b[3] = a3c[comp];
        Vec<4> x;
        if (!lu_solve(coeff, b, x)) {
            out.status = GaussIodError::ERROR_SINGULAR;
            return out;
        }
        out.v[comp] = x[0];
    }
    out.status = GaussIodError::OK;
    return out;
}

// ============================================================================
// Internal helpers (helio private functions, ported 1:1)
// ============================================================================

namespace iod_detail {

/// Slant range scan bounds and resolution for the middle-epoch root find
/// (helio _RHO2_MIN_KM, _RHO2_MAX_KM, _RHO2_SCAN_POINTS).
inline constexpr double RHO2_MIN_KM = 50.0;
inline constexpr double RHO2_MAX_KM = 4.0e5;
inline constexpr int RHO2_SCAN_POINTS = 2000;

/// Delta self-consistency iteration cap (helio: 40).
inline constexpr int MAX_DELTA_ITER = 40;

/// Series-coefficient vanish threshold (helio: 1e-12).
inline constexpr double SERIES_EPS = 1.0e-12;

/// Delta self-consistency relative tolerance (helio: 1e-9).
inline constexpr double DELTA_TOL = 1.0e-9;

/// Line-of-sight coplanarity threshold on |D0| (helio: 1e-12).
inline constexpr double D0_EPS = 1.0e-12;

/// Root dedup radius on middle positions [km] (helio: 1e-3).
inline constexpr double ROOT_DEDUP_KM = 1.0e-3;

/// Cross-root consistency radius [km] (helio: 1.0).
inline constexpr double CROSS_ROOT_KM = 1.0;

/// Differential correction finite-difference steps (helio defaults).
inline constexpr double DC_POS_STEP_KM = 1.0e-4;
inline constexpr double DC_VEL_STEP_KMS = 1.0e-8;

/// Differential correction convergence thresholds (helio defaults).
inline constexpr double DC_POS_TOL_KM = 1.0e-8;
inline constexpr double DC_VEL_TOL_KMS = 1.0e-11;

/// Line-of-sight unit vector in ECI from right ascension and declination
/// (helio _los_unit).
inline Vec3 los_unit(double ra_rad, double dec_rad) {
    const double cd = std::cos(dec_rad);
    return Vec3(cd * std::cos(ra_rad), cd * std::sin(ra_rad),
                std::sin(dec_rad));
}

/// Precomputed geometry for the Gauss scalar range equation
/// (helio _GaussGeometry).
struct GaussGeometry {
    Mat3d l_mat;           ///< LOS unit vectors as COLUMNS: col j = L_j.
    Vec3 r_sites[3];       ///< Site positions in ECI [km].
    double tau1 = 0.0;     ///< t1 - t2 [s] (negative).
    double tau3 = 0.0;     ///< t3 - t2 [s] (positive).
    double tau = 0.0;      ///< t3 - t1 [s].
    Vec3 d1;               ///< L2 x L3.
    Vec3 d2;               ///< L1 x L3.
    Vec3 d3;               ///< L1 x L2.
    double d0 = 0.0;       ///< L1 . (L2 x L3).

    /// LOS unit vector L_j (column j of l_mat).
    Vec3 los(int j) const {
        return Vec3(l_mat(0, j), l_mat(1, j), l_mat(2, j));
    }
};

/// One evaluated point of the Gauss closing equation (helio _GaussRoot).
struct GaussRoot {
    Vec3 ranges;            ///< Slant ranges (rho1, rho2, rho3) [km].
    double f1 = 0.0;        ///< Short-arc coefficient at t1.
    double f3 = 0.0;        ///< Short-arc coefficient at t3.
    double g = 0.0;         ///< Short-arc coefficient g(t3 - t1) [s].
    double rho2_implied = 0.0;  ///< Middle range implied by the closing equation [km].
};

/// Solve the Gauss cross-product equations for a fixed middle range
/// (helio _solve_ranges_fg).
///
/// Given rho2, r2 = |R2 + rho2 L2| fixes g1 and g3. The first-order
/// range term delta = r3^2 - r1^2 is iterated to self-consistency (max
/// 40 iterations, 0.5 damping blend, 1e-9 relative tol), then the three
/// ranges are read off the shared numerator vector
/// N = g R2 + g1 R3 - g3 R1 with denominators g3 D0, g D0, and -g1 D0
/// (Vallado Eq 7-37 to 7-40 structure), and the closing equation gives
/// the implied middle range.
///
/// @param rho2  Middle-epoch slant range [km], must be positive.
/// @param geom  Precomputed geometry.
/// @param mu    Gravitational parameter [km^3/s^2].
/// @param out   Evaluated root.
/// @return True if the evaluation is numerically valid; false for
///         non-physical ranges, r2 below R_EARTH, or vanishing series
///         coefficients.
inline bool solve_ranges_fg(double rho2, const GaussGeometry& geom, double mu,
                            GaussRoot& out) {
    if (rho2 <= 0.0) {
        return false;
    }
    const Vec3 r2_vec = geom.r_sites[1] + geom.los(1) * rho2;
    const double r2 = r2_vec.magnitude();
    if (r2 < R_EARTH) {
        return false;
    }
    const double r2_cubed = r2 * r2 * r2;
    const double r2_fifth = r2_cubed * r2 * r2;

    const double g1 =
        geom.tau1 - mu * geom.tau1 * geom.tau1 * geom.tau1 / (6.0 * r2_cubed);
    const double g3 =
        geom.tau3 - mu * geom.tau3 * geom.tau3 * geom.tau3 / (6.0 * r2_cubed);
    if (std::fabs(g1) < SERIES_EPS || std::fabs(g3) < SERIES_EPS) {
        return false;
    }

    double f1 = 0.0;
    double f3 = 0.0;
    double g = 0.0;
    Vec3 n_vec;
    const double mu_over_4tau_r5 = mu / (4.0 * geom.tau * r2_fifth);
    const auto fg_and_n = [&](double delta) {
        f1 = 1.0 - mu * geom.tau1 * geom.tau1 / (2.0 * r2_cubed) +
             mu_over_4tau_r5 * geom.tau1 * geom.tau1 * geom.tau1 * delta;
        f3 = 1.0 - mu * geom.tau3 * geom.tau3 / (2.0 * r2_cubed) +
             mu_over_4tau_r5 * geom.tau3 * geom.tau3 * geom.tau3 * delta;
        g = f1 * g3 - f3 * g1;
        n_vec = geom.r_sites[1] * g + geom.r_sites[2] * g1 -
                geom.r_sites[0] * g3;
    };

    double delta = 0.0;
    for (int iter = 0; iter < MAX_DELTA_ITER; ++iter) {
        fg_and_n(delta);
        if (std::fabs(g) < SERIES_EPS) {
            return false;
        }
        const double rho1 = n_vec.dot(geom.d1) / (g3 * geom.d0);
        const double rho3 = -n_vec.dot(geom.d3) / (g1 * geom.d0);
        if (rho1 <= 0.0 || rho3 <= 0.0) {
            return false;
        }
        const Vec3 r1_vec = geom.r_sites[0] + geom.los(0) * rho1;
        const Vec3 r3_vec = geom.r_sites[2] + geom.los(2) * rho3;
        const double delta_new =
            r3_vec.dot(r3_vec) - r1_vec.dot(r1_vec);
        if (std::fabs(delta_new - delta) <
            DELTA_TOL * std::max(1.0, std::fabs(delta_new))) {
            delta = delta_new;
            break;
        }
        delta = 0.5 * delta + 0.5 * delta_new;
    }

    fg_and_n(delta);
    if (std::fabs(g) < SERIES_EPS) {
        return false;
    }
    const double rho1 = n_vec.dot(geom.d1) / (g3 * geom.d0);
    const double rho3 = -n_vec.dot(geom.d3) / (g1 * geom.d0);
    if (rho1 <= 0.0 || rho3 <= 0.0) {
        return false;
    }
    out.ranges = Vec3(rho1, rho2, rho3);
    out.f1 = f1;
    out.f3 = f3;
    out.g = g;
    out.rho2_implied = n_vec.dot(geom.d2) / (g * geom.d0);
    return true;
}

/// Closing-equation residual of the Gauss scalar root find (helio
/// _closing_residual): implied middle range minus the trial rho2, or
/// NaN where the evaluation is invalid.
inline double closing_residual(double rho2, const GaussGeometry& geom,
                               double mu) {
    GaussRoot solved;
    if (!solve_ranges_fg(rho2, geom, mu, solved)) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return solved.rho2_implied - rho2;
}

// ---------------------------------------------------------------------------
// Brent's method (scipy.optimize.brentq port)
// ---------------------------------------------------------------------------

/// Brent's method root finder on a bracketing interval, ported from
/// scipy's brentq (Netlib zeroin lineage) so the closing-equation root
/// refinement matches helio_ob bit-for-bit at the fixture tolerance.
///
/// @param f        Callable returning the residual at a point.
/// @param xa       Left bracket.
/// @param xb       Right bracket (must opposite-sign residual).
/// @param xtol     Absolute tolerance [same units as x].
/// @param rtol     Relative tolerance.
/// @param maxiter  Maximum iterations.
/// @param root_out Output root (valid on both convergence and maxiter).
/// @return True if a root was found (f == 0 or |step| < delta); false if
///         the interval does not bracket a root or maxiter was exhausted
///         (matches scipy ValueError / RuntimeError semantics for the
///         caller to skip).
template <typename Func>
inline bool brentq(Func f, double xa, double xb, double xtol, double rtol,
                   int maxiter, double& root_out) {
    double xpre = xa;
    double xcur = xb;
    double xblk = 0.0;
    double fblk = 0.0;
    double spre = 0.0;
    double scur = 0.0;

    double fpre = f(xpre);
    double fcur = f(xcur);
    if (fpre == 0.0) {
        root_out = xpre;
        return true;
    }
    if (fcur == 0.0) {
        root_out = xcur;
        return true;
    }
    if ((fpre > 0.0) == (fcur > 0.0)) {
        return false;  // No sign change (scipy SIGNERR).
    }

    for (int iter = 0; iter < maxiter; ++iter) {
        if (fpre * fcur < 0.0) {
            xblk = xpre;
            fblk = fpre;
            spre = scur;
        }
        if (std::fabs(fblk) < std::fabs(fcur)) {
            xpre = xcur;
            xcur = xblk;
            xblk = xpre;
            fpre = fcur;
            fcur = fblk;
            fblk = fpre;
        }
        const double delta = (xtol + rtol * std::fabs(xcur)) / 2.0;
        const double sbis = (xblk - xcur) / 2.0;
        if (fcur == 0.0 || std::fabs(sbis) < delta) {
            root_out = xcur;
            return true;
        }
        if (std::fabs(spre) > delta && std::fabs(fcur) < std::fabs(fpre)) {
            double stry;
            if (xpre == xblk) {
                // Secant (single-step) interpolation.
                stry = -fcur * (xcur - xpre) / (fcur - fpre);
            } else {
                // Inverse quadratic extrapolation.
                const double dpre = (fpre - fcur) / (xpre - xcur);
                const double dblk = (fblk - fcur) / (xblk - xcur);
                stry = -fcur * (fblk * dblk - fpre * dpre) /
                       (dblk * dpre * (fblk - fpre));
            }
            const double upper = 3.0 * std::fabs(sbis) - delta;
            const double bound =
                std::min(std::fabs(spre), upper);
            if (2.0 * std::fabs(stry) < bound) {
                spre = scur;
                scur = stry;
            } else {
                spre = sbis;
                scur = sbis;
            }
        } else {
            spre = sbis;
            scur = sbis;
        }
        xpre = xcur;
        fpre = fcur;
        if (std::fabs(scur) > delta) {
            xcur = xcur + scur;
        } else {
            xcur = xcur + (sbis > 0.0 ? delta : -delta);
        }
        fcur = f(xcur);
    }
    root_out = xcur;
    return false;  // Maxiter exhausted (scipy MAXITERERR).
}

// ---------------------------------------------------------------------------
// 2-norm condition number (numpy.linalg.cond default p=None parity)
// ---------------------------------------------------------------------------

/// 2-norm condition number of a 3x3 matrix via one-sided Jacobi SVD
/// (Hestenes): the columns of A are orthogonalized by a sequence of
/// plane rotations; the singular values are the final column norms.
///
/// One-sided Jacobi keeps full relative accuracy for small singular
/// values (unlike the A^T A eigenvalue route, which squares the
/// condition number), so the 1e8 warning and 1e12 rejection thresholds
/// behave like numpy's SVD-based cond.
///
/// @param a  3x3 matrix.
/// @return s_max / s_min, or +inf when the matrix is numerically
///         rank-deficient.
inline double cond2_3x3(const Mat3d& a) {
    // Working copy; columns are rotated toward orthogonality.
    Mat3d u = a;
    auto col_dot = [&](int p, int q) {
        return u(0, p) * u(0, q) + u(1, p) * u(1, q) + u(2, p) * u(2, q);
    };
    auto col_norm = [&](int p) {
        return std::sqrt(u(0, p) * u(0, p) + u(1, p) * u(1, p) +
                         u(2, p) * u(2, p));
    };

    for (int sweep = 0; sweep < 30; ++sweep) {
        double max_corr = 0.0;
        for (int p = 0; p < 2; ++p) {
            for (int q = p + 1; q < 3; ++q) {
                const double alpha = col_dot(p, q);
                const double np_ = col_norm(p);
                const double nq = col_norm(q);
                if (np_ == 0.0 || nq == 0.0) {
                    continue;
                }
                const double corr = std::fabs(alpha) / (np_ * nq);
                max_corr = std::max(max_corr, corr);
                if (corr <= 1e-16) {
                    continue;
                }
                // Rotation that zeroes the p-q column correlation.
                const double zeta = (nq * nq - np_ * np_) / (2.0 * alpha);
                const double t = (zeta >= 0.0 ? 1.0 : -1.0) /
                                 (std::fabs(zeta) +
                                  std::sqrt(zeta * zeta + 1.0));
                const double c = 1.0 / std::sqrt(t * t + 1.0);
                const double s = c * t;
                for (int k = 0; k < 3; ++k) {
                    const double kp = u(k, p);
                    const double kq = u(k, q);
                    u(k, p) = c * kp - s * kq;
                    u(k, q) = s * kp + c * kq;
                }
            }
        }
        if (max_corr <= 1e-16) {
            break;
        }
    }

    double smax = 0.0;
    double smin = std::numeric_limits<double>::max();
    for (int p = 0; p < 3; ++p) {
        const double n = col_norm(p);
        smax = std::max(smax, n);
        smin = std::min(smin, n);
    }
    if (smin <= 0.0 || smax <= 0.0 || !std::isfinite(smin) ||
        !std::isfinite(smax)) {
        return std::numeric_limits<double>::infinity();
    }
    return smax / smin;
}

// ---------------------------------------------------------------------------
// mu-parameterized two-body helpers (helio propagate_kepler_analytic)
// ---------------------------------------------------------------------------

/// State to classical elements with explicit mu (helio frames
/// state_to_elements, Vallado Algorithm 9 special cases). Only the six
/// classical elements are needed by the IOD pipeline.
inline bool state_to_elements_mu(const Vec3& r_vec, const Vec3& v_vec,
                                 double mu, double& a, double& e, double& inc,
                                 double& raan, double& argp, double& ta) {
    const double r = r_vec.magnitude();
    const double v = v_vec.magnitude();
    if (r <= 0.0 || !std::isfinite(r) || !std::isfinite(v)) {
        return false;
    }
    const Vec3 h_vec = r_vec.cross(v_vec);
    const double h = h_vec.magnitude();
    if (h <= 0.0 || !std::isfinite(h)) {
        return false;
    }
    const Vec3 n_vec = Vec3(0.0, 0.0, 1.0).cross(h_vec);
    const double n = n_vec.magnitude();

    // Specific energy and semimajor axis (helio guard on |energy|).
    const double energy = v * v / 2.0 - mu / r;
    if (std::fabs(energy) > 1e-14) {
        a = -mu / (2.0 * energy);
    } else {
        a = std::numeric_limits<double>::infinity();
    }

    // Eccentricity (helio form: cross(v, h)/mu - r_vec/r).
    const Vec3 e_vec = v_vec.cross(h_vec) / mu - r_vec / r;
    e = e_vec.magnitude();

    inc = std::acos(std::clamp(h_vec.z / h, -1.0, 1.0));

    const bool equatorial = n < 1e-10;
    if (equatorial) {
        raan = 0.0;
    } else {
        raan = normalize_angle(std::atan2(n_vec.y, n_vec.x));
    }

    if (equatorial) {
        if (e < 1e-10) {
            argp = 0.0;
            ta = std::atan2(r_vec.y, r_vec.x);
        } else {
            argp = normalize_angle(std::atan2(e_vec.y, e_vec.x));
            ta = std::atan2((e_vec.cross(r_vec)).z / e, e_vec.dot(r_vec) / (e * r));
        }
    } else {
        const double cos_argp =
            std::clamp(n_vec.dot(e_vec) / (n * e), -1.0, 1.0);
        argp = std::acos(cos_argp);
        if (e_vec.z < 0.0) {
            argp = normalize_angle(TWO_PI - argp);
        }
        const double cos_ta = std::clamp(e_vec.dot(r_vec) / (e * r), -1.0, 1.0);
        ta = std::acos(cos_ta);
        if (r_vec.dot(v_vec) < 0.0) {
            ta = normalize_angle(TWO_PI - ta);
        }
    }

    // Circular special case: true anomaly measured from ascending node.
    if (e < 1e-10) {
        if (!equatorial) {
            const double cos_u = std::clamp(n_vec.dot(r_vec) / (n * r), -1.0, 1.0);
            ta = std::acos(cos_u);
            if (r_vec.z < 0.0) {
                ta = normalize_angle(TWO_PI - ta);
            }
        }
        argp = 0.0;
    }

    ta = normalize_angle(ta);
    return true;
}

/// Classical elements to ECI state with explicit mu (helio frames
/// elements_to_state).
inline StateVector elements_to_state_mu(double a, double e, double i,
                                        double raan, double argp, double ta,
                                        double mu) {
    const double p = a * (1.0 - e * e);
    const double r = p / (1.0 + e * std::cos(ta));

    const Vec3 r_pqw(r * std::cos(ta), r * std::sin(ta), 0.0);
    const double sqrt_mu_over_p = std::sqrt(mu / p);
    const Vec3 v_pqw(sqrt_mu_over_p * -std::sin(ta),
                     sqrt_mu_over_p * (e + std::cos(ta)), 0.0);

    // Perifocal to ECI rotation (Vallado pqw_to_eci).
    const double cos_o = std::cos(raan);
    const double sin_o = std::sin(raan);
    const double cos_i = std::cos(i);
    const double sin_i = std::sin(i);
    const double cos_w = std::cos(argp);
    const double sin_w = std::sin(argp);

    const Vec3 r_eci(
        (cos_o * cos_w - sin_o * sin_w * cos_i) * r_pqw.x +
            (-cos_o * sin_w - sin_o * cos_w * cos_i) * r_pqw.y,
        (sin_o * cos_w + cos_o * sin_w * cos_i) * r_pqw.x +
            (-sin_o * sin_w + cos_o * cos_w * cos_i) * r_pqw.y,
        (sin_w * sin_i) * r_pqw.x + (cos_w * sin_i) * r_pqw.y);
    const Vec3 v_eci(
        (cos_o * cos_w - sin_o * sin_w * cos_i) * v_pqw.x +
            (-cos_o * sin_w - sin_o * cos_w * cos_i) * v_pqw.y,
        (sin_o * cos_w + cos_o * sin_w * cos_i) * v_pqw.x +
            (-sin_o * sin_w + cos_o * cos_w * cos_i) * v_pqw.y,
        (sin_w * sin_i) * v_pqw.x + (cos_w * sin_i) * v_pqw.y);

    return StateVector{r_eci, v_eci, 0.0};
}

/// Two-body analytic propagation matching helio propagate_kepler_analytic:
/// converts to classical elements, advances the mean anomaly by n * dt,
/// and converts back. Elliptical orbits only.
///
/// @param r_in   Initial position [km].
/// @param v_in   Initial velocity [km/s].
/// @param dt     Time of flight [s] (negative for backward).
/// @param mu     Gravitational parameter [km^3/s^2].
/// @param r_out  Propagated position.
/// @param v_out  Propagated velocity.
/// @return False if the orbit is not elliptical (a <= 0 or non-finite),
///         matching helio's ValueError that the caller treats as an
///         invalid intermediate state.
inline bool propagate_kepler_analytic(const Vec3& r_in, const Vec3& v_in,
                                      double dt, double mu, Vec3& r_out,
                                      Vec3& v_out) {
    double a, e, i, raan, argp, nu;
    if (!state_to_elements_mu(r_in, v_in, mu, a, e, i, raan, argp, nu)) {
        return false;
    }
    if (!std::isfinite(a) || a <= 0.0) {
        return false;
    }
    const double mean_motion = std::sqrt(mu / (a * a * a));
    const double m0 = true_to_mean(nu, e);
    const double m1 = m0 + mean_motion * dt;
    const double nu1 = mean_to_true(m1, e);
    const StateVector s = elements_to_state_mu(a, e, i, raan, argp, nu1, mu);
    r_out = s.position;
    v_out = s.velocity;
    return true;
}

// ---------------------------------------------------------------------------
// Differential correction and candidate filters (helio privates)
// ---------------------------------------------------------------------------

/// Six angle residuals (wrapped dRA, dDec at 3 epochs) of a middle-epoch
/// state after two-body propagation to each observation time.
inline bool residual_vec(const Vec6d& x, const GaussIodObs (&obs3)[3],
                         double mu, Vec6d& out) {
    const double t2 = obs3[1].time_jd;
    for (int k = 0; k < 3; ++k) {
        const double dt = (obs3[k].time_jd - t2) * SEC_PER_DAY;
        Vec3 r_i;
        Vec3 v_i;
        if (!propagate_kepler_analytic(Vec3(x[0], x[1], x[2]),
                                       Vec3(x[3], x[4], x[5]), dt, mu, r_i,
                                       v_i)) {
            return false;
        }
        const PredictedComponents pred =
            predict_observation(r_i, v_i, *obs3[k].station, obs3[k].time_jd);
        out[2 * k] = wrap_angle(pred.ra_rad - obs3[k].ra_rad);
        out[2 * k + 1] = pred.dec_rad - obs3[k].dec_rad;
    }
    return true;
}

/// Outcome of the Gauss-Newton polish (helio _differential_correct).
struct DcOutcome {
    bool valid = false;  ///< False: use the Herrick-Gibbs seed instead.
    Vec3 r2;             ///< Refined position at the middle epoch [km].
    Vec3 v2;             ///< Refined velocity at the middle epoch [km/s].
    int iterations = 0;  ///< Completed Gauss-Newton iterations.
};

/// Refine a candidate state by differential correction on RA/Dec (helio
/// _differential_correct).
///
/// Gauss-Newton least squares on the six state components at the middle
/// epoch: residuals are the wrapped angle differences between observed
/// and re-predicted RA/Dec at each of the three epochs (6 residuals),
/// the Jacobian is central finite differences (pos step 1e-4 km, vel
/// step 1e-8 km/s, 12 two-body propagations per iteration), and each
/// step solves the 6x6 linear system. One step halving is attempted if
/// the residual norm increases; a second increase breaks keeping the
/// previous iterate. Convergence: ||dx_r|| < 1e-8 km AND ||dx_v|| <
/// 1e-11 km/s, max 25 iterations.
inline DcOutcome differential_correct(const Vec6d& state,
                                      const GaussIodObs (&obs3)[3], double mu,
                                      int max_iter) {
    DcOutcome out;
    Vec6d x = state;
    Vec6d resid;
    if (!residual_vec(x, obs3, mu, resid)) {
        return out;  // Invalid seed state; helio returns None.
    }

    for (int iter = 0; iter < max_iter; ++iter) {
        out.iterations = iter + 1;
        Mat6d jac;
        bool fd_ok = true;
        for (int j = 0; j < 6 && fd_ok; ++j) {
            const double step =
                (j < 3) ? DC_POS_STEP_KM : DC_VEL_STEP_KMS;
            Vec6d x_plus = x;
            x_plus[j] += step;
            Vec6d x_minus = x;
            x_minus[j] -= step;
            Vec6d r_plus;
            Vec6d r_minus;
            if (!residual_vec(x_plus, obs3, mu, r_plus) ||
                !residual_vec(x_minus, obs3, mu, r_minus)) {
                fd_ok = false;
                break;
            }
            for (int i = 0; i < 6; ++i) {
                jac(i, j) = (r_plus[i] - r_minus[i]) / (2.0 * step);
            }
        }
        if (!fd_ok) {
            break;  // Keep the current iterate (helio LinAlg/InvalidState break).
        }

        Vec6d dx;
        if (!lu_solve(jac, resid * (-1.0), dx)) {
            break;  // Singular Jacobian: keep current iterate.
        }
        bool dx_finite = true;
        for (int i = 0; i < 6; ++i) {
            if (!std::isfinite(dx[i])) {
                dx_finite = false;
                break;
            }
        }
        if (!dx_finite) {
            return out;  // helio returns None; caller falls back to seed.
        }

        Vec6d x_new = x + dx;
        Vec6d resid_new;
        if (!residual_vec(x_new, obs3, mu, resid_new)) {
            break;  // Invalid proposed state: keep previous iterate.
        }
        if (resid_new.norm() > resid.norm()) {
            x_new = x + dx * 0.5;
            if (!residual_vec(x_new, obs3, mu, resid_new)) {
                break;  // Invalid half step: keep previous iterate.
            }
            if (resid_new.norm() > resid.norm()) {
                break;  // Keep previous iterate.
            }
        }
        x = x_new;
        resid = resid_new;

        const double dx_pos = Vec3(dx[0], dx[1], dx[2]).magnitude();
        const double dx_vel = Vec3(dx[3], dx[4], dx[5]).magnitude();
        if (dx_pos < DC_POS_TOL_KM && dx_vel < DC_VEL_TOL_KMS) {
            break;
        }
    }

    out.valid = true;
    out.r2 = Vec3(x[0], x[1], x[2]);
    out.v2 = Vec3(x[3], x[4], x[5]);
    return out;
}

/// Maximum angular residual between observed and re-predicted RA/Dec
/// (helio _angular_residual_rad): the middle-epoch state is propagated
/// to each observation time with two-body Kepler propagation and the
/// line of sight re-predicted; returns the max angle between observed
/// and predicted LOS unit vectors, or +inf if the state cannot be
/// propagated to one of the epochs.
inline double angular_residual_rad(const Vec3& r2, const Vec3& v2,
                                   const GaussIodObs (&obs3)[3], double mu) {
    const double t2 = obs3[1].time_jd;
    double worst = 0.0;
    for (int k = 0; k < 3; ++k) {
        const double dt = (obs3[k].time_jd - t2) * SEC_PER_DAY;
        Vec3 r_i;
        Vec3 v_i;
        if (!propagate_kepler_analytic(r2, v2, dt, mu, r_i, v_i)) {
            return std::numeric_limits<double>::infinity();
        }
        const PredictedComponents pred =
            predict_observation(r_i, v_i, *obs3[k].station, obs3[k].time_jd);
        const Vec3 l_obs = los_unit(obs3[k].ra_rad, obs3[k].dec_rad);
        const Vec3 l_pred = los_unit(pred.ra_rad, pred.dec_rad);
        const double cosang =
            std::clamp(l_obs.dot(l_pred), -1.0, 1.0);
        worst = std::max(worst, std::acos(cosang));
    }
    return worst;
}

/// Check that the recovered state is a sane elliptical Earth orbit
/// (helio _orbit_is_physical): 0 < a < 1e7 km and e < 1 via state to
/// elements with the solve mu.
inline bool orbit_is_physical(const Vec3& r2, const Vec3& v2, double mu) {
    double a, e, i, raan, argp, ta;
    if (!state_to_elements_mu(r2, v2, mu, a, e, i, raan, argp, ta)) {
        return false;
    }
    return std::isfinite(a) && std::isfinite(e) && a > 0.0 && a < 1.0e7 &&
           e < 1.0;
}

}  // namespace iod_detail

// ============================================================================
// gauss_iod
// ============================================================================

/// Initial orbit determination from three RA/Dec observations.
///
/// Polynomial-free cross-product formulation of Gauss's method (Vallado
/// Algorithm 7-4 style geometry): the slant ranges solve through the
/// closing equation in the middle range rho2 on a log grid scan (50 to
/// 4e5 km, 2000 points) with Brent refinement (xtol=1e-6 km,
/// rtol=1e-12, maxiter=200); positions and the Herrick-Gibbs velocity
/// seed feed a Gauss-Newton differential correction that polishes the
/// state to the exact angle fit. The observations may come from one to
/// three stations; epochs must be strictly increasing.
///
/// Filters replicate helio: root dedup at 1e-3 km, physicality
/// (0 < a < 1e7 km, e < 1), angular residual <= residual_tol_rad, and
/// cross-root consistency at 1 km.
///
/// @param obs3     Exactly three RA/Dec observations in chronological
///                 order (station pointers must be non-null).
/// @param config   Solver configuration (mu, residual tolerance, GN caps,
///                 conditioning thresholds).
/// @return Result with status OK or WARNING_ILL_CONDITIONED on success;
///         ERROR_INPUT for bad epochs/config; ERROR_SINGULAR for
///         cond(L) > 1e12 or coplanar LOS (|D0| < 1e-12);
///         ERROR_NO_SOLUTION when every root is filtered;
///         ERROR_INCONSISTENT_ROOTS when independent roots disagree by
///         more than 1 km. On success, r/v hold the middle-epoch state.
inline GaussIodResult gauss_iod(const GaussIodObs (&obs3)[3],
                                const GaussIodConfig& config =
                                    GaussIodConfig{}) {
    GaussIodResult result;

    // Input validation (helio ValueError: epochs strictly increasing).
    if (obs3[0].station == nullptr || obs3[1].station == nullptr ||
        obs3[2].station == nullptr) {
        result.status = GaussIodError::ERROR_INPUT;
        return result;
    }
    const double t0 = obs3[0].time_jd;
    const double t1 = obs3[1].time_jd;
    const double t2 = obs3[2].time_jd;
    if (!(t0 < t1 && t1 < t2)) {
        result.status = GaussIodError::ERROR_INPUT;
        return result;
    }
    if (!(config.mu > 0.0) || config.max_dc_iter < 0) {
        result.status = GaussIodError::ERROR_INPUT;
        return result;
    }
    const double mu = config.mu;

    // LOS matrix (columns are the LOS unit vectors) and site positions.
    iod_detail::GaussGeometry geom;
    for (int j = 0; j < 3; ++j) {
        const Vec3 los =
            iod_detail::los_unit(obs3[j].ra_rad, obs3[j].dec_rad);
        geom.l_mat(0, j) = los.x;
        geom.l_mat(1, j) = los.y;
        geom.l_mat(2, j) = los.z;
        geom.r_sites[j] = obs3[j].station->position_eci(obs3[j].time_jd);
    }

    // Conditioning guards (helio ValueError > 1e12, UserWarning > 1e8).
    const double cond = iod_detail::cond2_3x3(geom.l_mat);
    result.condition_number = cond;
    GaussIodError status = GaussIodError::OK;
    if (cond > config.cond_singular) {
        result.status = GaussIodError::ERROR_SINGULAR;
        return result;
    }
    if (cond > config.cond_warning) {
        status = GaussIodError::WARNING_ILL_CONDITIONED;
    }

    geom.tau1 = (t0 - t1) * SEC_PER_DAY;
    geom.tau3 = (t2 - t1) * SEC_PER_DAY;
    geom.tau = (t2 - t0) * SEC_PER_DAY;
    geom.d1 = geom.los(1).cross(geom.los(2));
    geom.d2 = geom.los(0).cross(geom.los(2));
    geom.d3 = geom.los(0).cross(geom.los(1));
    geom.d0 = geom.los(0).dot(geom.d1);
    if (std::fabs(geom.d0) < iod_detail::D0_EPS) {
        result.status = GaussIodError::ERROR_SINGULAR;
        return result;
    }

    // Root scan: evaluate the closing residual on a log grid, then refine
    // every sign change (non-finite segments are skipped; helio uses
    // scipy brentq with xtol=1e-6 km, rtol=1e-12, maxiter=200).
    std::vector<double> grid(iod_detail::RHO2_SCAN_POINTS);
    std::vector<double> residuals(iod_detail::RHO2_SCAN_POINTS);
    for (int i = 0; i < iod_detail::RHO2_SCAN_POINTS; ++i) {
        grid[i] = iod_detail::RHO2_MIN_KM *
                  std::pow(iod_detail::RHO2_MAX_KM / iod_detail::RHO2_MIN_KM,
                           static_cast<double>(i) /
                               (iod_detail::RHO2_SCAN_POINTS - 1));
        residuals[i] =
            iod_detail::closing_residual(grid[i], geom, mu);
    }

    std::vector<double> roots;
    for (int i = 0; i + 1 < iod_detail::RHO2_SCAN_POINTS; ++i) {
        const double r_lo = residuals[i];
        const double r_hi = residuals[i + 1];
        if (!(std::isfinite(r_lo) && std::isfinite(r_hi))) {
            continue;
        }
        if (r_lo == 0.0) {
            roots.push_back(grid[i]);
        } else if (r_lo * r_hi < 0.0) {
            double root = 0.0;
            const auto eval = [&](double x) {
                return iod_detail::closing_residual(x, geom, mu);
            };
            if (iod_detail::brentq(eval, grid[i], grid[i + 1], 1.0e-6, 1.0e-12,
                                  200, root)) {
                roots.push_back(root);
            }
        }
    }

    // Candidate loop: solve ranges, seed with Herrick-Gibbs, polish with
    // differential correction, then dedup / physicality / residual filters.
    struct Candidate {
        double residual_rad;
        Vec3 r2;
        Vec3 v2;
        Vec3 ranges;
        int iterations;
    };
    std::vector<Candidate> candidates;
    std::vector<Vec3> seen_r2;
    const double t_sec[3] = {t0 * SEC_PER_DAY, t1 * SEC_PER_DAY,
                             t2 * SEC_PER_DAY};

    for (const double rho2 : roots) {
        iod_detail::GaussRoot solved;
        if (!iod_detail::solve_ranges_fg(rho2, geom, mu, solved)) {
            continue;
        }
        // Positions: r_i = R_i + rho_i L_i.
        const Vec3 pos[3] = {
            geom.r_sites[0] + geom.los(0) * solved.ranges.x,
            geom.r_sites[1] + geom.los(1) * solved.ranges.y,
            geom.r_sites[2] + geom.los(2) * solved.ranges.z};

        const HerrickGibbsResult hg =
            herrick_gibbs(pos[0], pos[1], pos[2], t_sec[0], t_sec[1],
                          t_sec[2], mu);
        if (hg.status != GaussIodError::OK) {
            continue;
        }
        Vec3 r2 = pos[1];
        Vec3 v2(hg.v[0], hg.v[1], hg.v[2]);
        int dc_iters = 0;
        if (config.enable_correction) {
            Vec6d seed;
            seed[0] = pos[1].x;
            seed[1] = pos[1].y;
            seed[2] = pos[1].z;
            seed[3] = v2.x;
            seed[4] = v2.y;
            seed[5] = v2.z;
            const iod_detail::DcOutcome dc = iod_detail::differential_correct(
                seed, obs3, mu, config.max_dc_iter);
            if (dc.valid) {
                r2 = dc.r2;
                v2 = dc.v2;
                dc_iters = dc.iterations;
            }
        }

        bool duplicate = false;
        for (const Vec3& prev : seen_r2) {
            if ((r2 - prev).magnitude() < iod_detail::ROOT_DEDUP_KM) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) {
            continue;
        }
        seen_r2.push_back(r2);

        if (!iod_detail::orbit_is_physical(r2, v2, mu)) {
            continue;
        }
        const double resid = iod_detail::angular_residual_rad(r2, v2, obs3, mu);
        if (resid > config.residual_tol_rad) {
            continue;
        }
        candidates.push_back(
            Candidate{resid, r2, v2, solved.ranges, dc_iters});
    }

    if (candidates.empty()) {
        result.status = GaussIodError::ERROR_NO_SOLUTION;
        return result;
    }

    std::sort(candidates.begin(), candidates.end(),
              [](const Candidate& a, const Candidate& b) {
                  return a.residual_rad < b.residual_rad;
              });
    const Candidate& best = candidates[0];

    // Weak-geometry guard: independent roots must agree on the solution.
    for (std::size_t k = 1; k < candidates.size(); ++k) {
        const double sep = (candidates[k].r2 - best.r2).magnitude();
        if (sep > iod_detail::CROSS_ROOT_KM) {
            result.status = GaussIodError::ERROR_INCONSISTENT_ROOTS;
            return result;
        }
    }

    // Defensive (unreachable: solve_ranges_fg enforces positive ranges).
    if (best.ranges.x < 0.0 || best.ranges.y < 0.0 || best.ranges.z < 0.0) {
        result.status = GaussIodError::ERROR_INPUT;
        return result;
    }

    result.r[0] = best.r2.x;
    result.r[1] = best.r2.y;
    result.r[2] = best.r2.z;
    result.v[0] = best.v2.x;
    result.v[1] = best.v2.y;
    result.v[2] = best.v2.z;
    result.status = status;
    result.iterations = best.iterations;
    result.residual_norm = best.residual_rad;
    result.ranges[0] = best.ranges.x;
    result.ranges[1] = best.ranges.y;
    result.ranges[2] = best.ranges.z;
    return result;
}

}  // namespace orbit
