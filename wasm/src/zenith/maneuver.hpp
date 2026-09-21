#pragma once

/// @file maneuver.hpp
/// @brief Orbit transfer maneuver planning.
///        Provides Hohmann transfers, bi-elliptic transfers, Lambert's
///        problem solver, and delta-v budget estimation including plane
///        changes.

#include <algorithm>
#include <cmath>
#include <utility>

#include "../core/orbit_types.hpp"
#include "../core/kepler.hpp"
#include "../core/coordinate_frames.hpp"

namespace orbit {

// ============================================================================
// Transfer Result Structures
// ============================================================================

/// Result of a Hohmann transfer computation.
struct HohmannResult {
    double dv1 = 0.0;             ///< First burn delta-v [km/s].
    double dv2 = 0.0;             ///< Second burn delta-v [km/s].
    double dv_total = 0.0;        ///< Total delta-v [km/s].
    double transfer_time_s = 0.0; ///< Transfer time [seconds].
    double a_transfer = 0.0;      ///< Transfer orbit semi-major axis [km].
};

/// Result of a Lambert solver computation.
struct LambertResult {
    Vec3 v1;                  ///< Departure velocity [km/s].
    Vec3 v2;                  ///< Arrival velocity [km/s].
    double a = 0.0;           ///< Semi-major axis [km].
    double tof = 0.0;         ///< Time of flight used [seconds].
    bool converged = false;   ///< Did the solver converge?
};

// ============================================================================
// Stumpff Functions
// ============================================================================

/// Compute the Stumpff functions C(z) and S(z).
///
/// These universal functions arise in the solution of Lambert's problem
/// and in universal variable formulations of Keplerian motion.  They
/// reduce to elementary trigonometric or hyperbolic functions depending
/// on the sign and magnitude of z.
///
/// @param z  Universal variable parameter (dimensionless).
/// @return std::pair<double, double> containing (C(z), S(z)).
inline std::pair<double, double> stumpff(double z) {
    double c_val;
    double s_val;

    if (z > 1e-6) {
        // Elliptic case: z > 0.
        double sz = std::sqrt(z);
        double cz = std::cos(sz);
        c_val = (1.0 - cz) / z;
        s_val = (sz - std::sin(sz)) / (sz * sz * sz);
    } else if (z < -1e-6) {
        // Hyperbolic case: z < 0.
        double sz = std::sqrt(-z);
        double czh = std::cosh(sz);
        c_val = (czh - 1.0) / (-z);
        s_val = (sz - std::sinh(sz)) / (sz * sz * sz);
    } else {
        // Near-parabolic: Taylor series expansion around z = 0.
        c_val = 0.5 - z / 24.0;
        s_val = 1.0 / 6.0 - z / 120.0;
    }

    return {c_val, s_val};
}

// ============================================================================
// Hohmann Transfer
// ============================================================================

/// Compute a standard Hohmann transfer between two coplanar circular orbits.
///
/// The Hohmann transfer is the minimum-energy two-impulse transfer between
/// two circular, coplanar orbits.  It consists of a prograde burn at the
/// initial orbit to enter an elliptical transfer orbit, followed by a
/// second prograde burn at the target orbit to circularize.
///
/// @param r1_km  Radius of the initial circular orbit [km].
/// @param r2_km  Radius of the target circular orbit [km].
/// @param mu     Gravitational parameter [km^3/s^2] (default: Earth).
/// @return HohmannResult populated with delta-v values, transfer time,
///         and transfer orbit semi-major axis.
inline HohmannResult hohmann_transfer(double r1_km, double r2_km,
                                      double mu = MU_EARTH) {
    HohmannResult result;

    // Handle degenerate case: same orbit.
    if (std::abs(r2_km - r1_km) < 1e-10) {
        return result;
    }

    // Transfer orbit semi-major axis.
    double a_t = (r1_km + r2_km) / 2.0;
    result.a_transfer = a_t;

    // Circular velocities.
    double v1_circ = std::sqrt(mu / r1_km);
    double v2_circ = std::sqrt(mu / r2_km);

    // Transfer orbit velocities at departure and arrival.
    double v1_transfer = std::sqrt(mu * (2.0 / r1_km - 1.0 / a_t));
    double v2_transfer = std::sqrt(mu * (2.0 / r2_km - 1.0 / a_t));

    // Delta-v magnitudes.
    result.dv1 = std::abs(v1_transfer - v1_circ);
    result.dv2 = std::abs(v2_circ - v2_transfer);
    result.dv_total = result.dv1 + result.dv2;

    // Transfer time: half the period of the transfer orbit.
    result.transfer_time_s = PI * std::sqrt(a_t * a_t * a_t / mu);

    return result;
}

/// Convenience wrapper: Hohmann transfer specified by altitudes above Earth.
///
/// @param alt1_km  Altitude of the initial circular orbit [km].
/// @param alt2_km  Altitude of the target circular orbit [km].
/// @return HohmannResult (same as hohmann_transfer).
inline HohmannResult hohmann_from_altitudes(double alt1_km, double alt2_km) {
    return hohmann_transfer(R_EARTH + alt1_km, R_EARTH + alt2_km);
}

// ============================================================================
// Bi-Elliptic Transfer
// ============================================================================

/// Compute a three-burn bi-elliptic transfer via an intermediate orbit.
///
/// The bi-elliptic transfer uses three impulsive burns:
///   1. Boost from r1 to an intermediate apogee r_intermediate.
///   2. Coast to r_intermediate, then boost to transfer to r2.
///   3. Circularize at r2.
///
/// This can be more efficient than Hohmann when the ratio of final to
/// initial radius exceeds approximately 11.94.
///
/// @param r1_km               Initial circular orbit radius [km].
/// @param r2_km               Target circular orbit radius [km].
/// @param r_intermediate_km   Intermediate orbit radius [km].
/// @param mu                  Gravitational parameter [km^3/s^2].
/// @return HohmannResult with dv1, dv2, dv3 (in dv_total), and total
///         transfer time.  Note: dv_total includes all three burns,
///         and dv2/dv3 are stored separately in the result.
inline HohmannResult bielliptic_transfer(double r1_km, double r2_km,
                                         double r_intermediate_km,
                                         double mu = MU_EARTH) {
    HohmannResult result;

    // Intermediate orbit must be larger than both r1 and r2 for the
    // classic bi-elliptic case.  Allow either direction.
    double ri = std::max(r1_km, std::max(r2_km, r_intermediate_km));

    // Semi-major axes of the two transfer ellipses.
    // Transfer 1: from r1 to ri.
    double a1 = (r1_km + ri) / 2.0;
    // Transfer 2: from ri to r2.
    double a2 = (ri + r2_km) / 2.0;

    // Circular velocities.
    double v1_circ = std::sqrt(mu / r1_km);
    double v2_circ = std::sqrt(mu / r2_km);

    // Transfer ellipse velocities at the departure and arrival points.
    double v1_dep = std::sqrt(mu * (2.0 / r1_km - 1.0 / a1));
    double v1_arr = std::sqrt(mu * (2.0 / ri - 1.0 / a1));
    double v2_dep = std::sqrt(mu * (2.0 / ri - 1.0 / a2));
    double v2_arr = std::sqrt(mu * (2.0 / r2_km - 1.0 / a2));

    // Three delta-v magnitudes.
    double dv_1 = std::abs(v1_dep - v1_circ);
    double dv_2 = std::abs(v2_dep - v1_arr);
    double dv_3 = std::abs(v2_circ - v2_arr);

    result.dv1 = dv_1;
    result.dv2 = dv_2;
    result.dv_total = dv_1 + dv_2 + dv_3;

    // Transfer times: half-period of each transfer ellipse.
    double t1 = PI * std::sqrt(a1 * a1 * a1 / mu);
    double t2 = PI * std::sqrt(a2 * a2 * a2 / mu);
    result.transfer_time_s = t1 + t2;

    // Store the average transfer semi-major axis as a reference.
    result.a_transfer = (a1 + a2) / 2.0;

    return result;
}

/// Check whether a bi-elliptic transfer is more efficient than Hohmann.
///
/// The breakeven ratio for a bi-elliptic transfer compared to Hohmann
/// is approximately 11.94.  If r2/r1 or r1/r2 exceeds this value, the
/// bi-elliptic transfer requires less total delta-v.
///
/// @param r1_km  Initial circular orbit radius [km].
/// @param r2_km  Target circular orbit radius [km].
/// @return True if bi-elliptic is more efficient (ratio > 11.94).
inline bool bielliptic_more_efficient(double r1_km, double r2_km) {
    if (r1_km <= 0.0 || r2_km <= 0.0) {
        return false;
    }
    double ratio = r2_km / r1_km;
    if (ratio < 1.0) {
        ratio = 1.0 / ratio;
    }
    return ratio > 11.94;
}

// ============================================================================
// Lambert Solver (Universal Variable)
// ============================================================================

/// Solve Lambert's problem: find the orbit connecting two position vectors
/// in a specified time of flight.
///
/// Uses the universal variable formulation with Newton-Raphson iteration
/// on the Stumpff-based residual.  This solver handles elliptic, parabolic,
/// and hyperbolic transfer orbits.
///
/// Reference: Vallado, "Fundamentals of Astrodynamics and Applications,"
///            4th ed., Algorithm 58.
///
/// @param r1       Departure position vector [km].
/// @param r2       Arrival position vector [km].
/// @param tof_s    Time of flight [seconds].
/// @param mu       Gravitational parameter [km^3/s^2].
/// @param direction  1 for prograde, -1 for retrograde.
/// @return LambertResult with departure/arrival velocities, semi-major axis,
///         and convergence status.
inline LambertResult lambert_solve(const Vec3& r1, const Vec3& r2,
                                   double tof_s, double mu = MU_EARTH,
                                   int direction = 1) {
    LambertResult result;
    result.tof = tof_s;

    double r1_mag = r1.magnitude();
    double r2_mag = r2.magnitude();

    // Trivial case: same position.
    if (r1_mag < 1e-10 || r2_mag < 1e-10) {
        return result;
    }

    // Cross product of r1 and r2 gives the angular momentum direction.
    Vec3 cross_r = r1.cross(r2);
    double cross_mag = cross_r.magnitude();

    // Transfer angle (true anomaly difference).
    double cos_dnu = r1.dot(r2) / (r1_mag * r2_mag);
    cos_dnu = std::clamp(cos_dnu, -1.0, 1.0);
    double dnu = std::acos(cos_dnu);

    // Determine transfer direction.
    if (cross_mag < 1e-10) {
        // Vectors are collinear.
        if (r1.dot(r2) > 0.0) {
            // Same direction: full revolution.
            dnu = TWO_PI;
        } else {
            // Opposite direction: half revolution.
            dnu = PI;
        }
    } else {
        // Use cross product z-component to determine direction.
        if (direction > 0 && cross_r.z < 0.0) {
            dnu = TWO_PI - dnu;
        } else if (direction < 0 && cross_r.z > 0.0) {
            dnu = TWO_PI - dnu;
        }
    }

    // Chord length.
    Vec3 chord = r2 - r1;
    double chord_mag = chord.magnitude();

    // Semi-perimeter.
    double s = (r1_mag + r2_mag + chord_mag) / 2.0;

    // Guard against degenerate transfer (coincident points).
    if (s < 1e-10) {
        return result;
    }

    // Universal variable initial guess.
    // x = sqrt(2*mu) * tof / (r1 + r2) is a simple estimate.
    double alpha = 2.0 * std::sqrt(s / (2.0 * mu));
    double chi_sq = alpha * s;

    // For the initial guess, we use the parabolic estimate.
    double chi_init = std::sqrt(chi_sq);
    if (dnu > PI) {
        chi_init = -chi_init;
    }

    // Newton iteration on the universal variable.
    double chi = chi_init;
    bool converged = false;

    for (int iter = 0; iter < 50; ++iter) {
        double chi_sq_val = chi * chi;

        auto [c_val, s_val] = stumpff(chi_sq_val / mu);

        // Universal variable relations.
        double a_univ = chi_sq_val / (mu * (1.0 - c_val));

        // Check for negative semi-major axis (hyperbolic).
        // For now, keep iterating even for negative a.

        // Y = r1_mag + r2_mag + A * (chi * S(z) - 1) / sqrt(mu)
        // where A = sqrt(r1_mag * r2_mag / mu) * sin(dnu).
        double y = r1_mag + r2_mag
                   + (chi_sq_val * s_val - std::sqrt(chi_sq_val))
                     * std::sqrt(chi_sq_val / mu);

        // Guard against negative y (non-physical).
        if (y < 0.0) {
            // Overshot: reduce chi.
            double delta = 0.1;
            chi = (1.0 - delta) * chi;
            continue;
        }

        // Residual: F(chi) = y^(3/2) * S(z) + A * sqrt(y) - sqrt(mu) * tof.
        double sqrt_y = std::sqrt(y);
        double f_chi = sqrt_y * sqrt_y * sqrt_y * s_val
                       + std::sqrt(r1_mag * r2_mag / mu)
                         * std::sin(dnu) * sqrt_y
                       - std::sqrt(mu) * tof_s;

        // Derivative: dF/dchi = (y/x) * [C(z) - 3*S(z)/2] + ... (Vallado).
        // Simplified derivative for the Newton step.
        double df_dchi;
        if (std::abs(chi) > 1e-8) {
            df_dchi = (sqrt_y / chi) * (chi_sq_val * s_val - chi)
                      + std::sqrt(r1_mag * r2_mag / mu) * std::sin(dnu)
                        * (chi / (2.0 * sqrt_y));
        } else {
            // Near zero: use the parabolic approximation.
            df_dchi = std::sqrt(s) + std::sqrt(r1_mag * r2_mag / mu)
                      * std::sin(dnu) / (2.0 * std::sqrt(s));
        }

        if (std::abs(df_dchi) < 1e-15) {
            break;
        }

        double delta_chi = f_chi / df_dchi;
        chi -= delta_chi;

        if (std::abs(delta_chi) < 1e-10) {
            converged = true;
            break;
        }
    }

    result.converged = converged;

    if (!converged) {
        return result;
    }

    // Compute Lagrange coefficients f, g, g_dot.
    double chi_sq_final = chi * chi;
    auto [c_val, s_val] = stumpff(chi_sq_final / mu);

    double a_val = chi_sq_final / (mu * (1.0 - c_val));
    result.a = a_val;

    double y_final = r1_mag + r2_mag
                     + (chi_sq_final * s_val - chi) * std::sqrt(chi_sq_final / mu);
    double sqrt_y = std::sqrt(y_final);

    // Lagrange coefficients.
    double f_coeff = 1.0 - y_final / r1_mag;
    double g_coeff = r1_mag * r2_mag * std::sin(dnu) / std::sqrt(mu * y_final);
    double g_dot_coeff = 1.0 - y_final / r2_mag;

    // Solve for v1 and v2.
    // v1 = (r2 - f * r1) / g
    // v2 = (g_dot * r2 - r1) / g
    if (std::abs(g_coeff) < 1e-15) {
        result.converged = false;
        return result;
    }

    result.v1 = (r2 - r1 * f_coeff) / g_coeff;
    result.v2 = (r2 * g_dot_coeff - r1) / g_coeff;

    return result;
}

// ============================================================================
// Delta-v Budget with Plane Change
// ============================================================================

/// Compute the total delta-v budget for a circular orbit transfer including
/// an inclination change (plane change).
///
/// The plane change is applied at the node of the target orbit, where the
/// velocity is smallest (for an apogee node change), minimizing the plane
/// change cost.  The combined transfer plus plane change delta-v is computed
/// using the vector sum approximation:
///   dv_total = sqrt(dv_hohmann^2 + dv_plane^2)
///
/// This is an approximation that works well for small plane changes.
///
/// @param r1_km                Initial circular orbit radius [km].
/// @param r2_km                Target circular orbit radius [km].
/// @param inclination_change_rad  Desired inclination change [rad].
/// @param mu                   Gravitational parameter [km^3/s^2].
/// @return Total delta-v [km/s] including both the Hohmann transfer and
///         the plane change.
inline double delta_v_budget_circular(double r1_km, double r2_km,
                                      double inclination_change_rad = 0.0,
                                      double mu = MU_EARTH) {
    // Hohmann transfer delta-v.
    HohmannResult hoh = hohmann_transfer(r1_km, r2_km, mu);

    // Plane change delta-v at the target orbit.
    // dv_plane = 2 * v2 * sin(d_i / 2)
    double v2 = std::sqrt(mu / r2_km);
    double dv_plane = 2.0 * v2 * std::sin(inclination_change_rad / 2.0);

    // Combined delta-v (vector sum approximation).
    double dv_total = std::sqrt(hoh.dv_total * hoh.dv_total
                                + dv_plane * dv_plane);

    return dv_total;
}

}  // namespace orbit
