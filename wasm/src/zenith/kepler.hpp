#pragma once

/// @file kepler.hpp
/// @brief Two-body Keplerian orbit propagation.
///        Provides Kepler's equation solver, anomaly conversions, and
///        analytical propagation of classical elements and state vectors.

#include <cmath>

#include "orbit_types.hpp"
#include "coordinate_frames.hpp"

namespace orbit {

// ============================================================================
// Kepler's Equation Solver
// ============================================================================

/// Solve Kepler's equation M = E - e*sin(E) for eccentric anomaly E.
///
/// Uses Newton-Raphson iteration with a robust initial guess strategy.
/// For low eccentricity (e <= 0.8), the initial guess is E0 = M + e*sin(M).
/// For high eccentricity (e > 0.8), the initial guess is E0 = PI, which
/// converges reliably even near parabolic orbits.
///
/// @param M   Mean anomaly [rad], will be normalized to [0, 2*PI].
/// @param e   Eccentricity [0, 1).
/// @param tol Convergence tolerance on E [rad].
/// @return Eccentric anomaly E [rad] in [0, 2*PI].
inline double solve_kepler(double M, double e, double tol = 1e-12) {
    // Normalize M to [0, 2*PI].
    M = std::fmod(M, TWO_PI);
    if (M < 0.0) {
        M += TWO_PI;
    }

    // Initial guess.
    double E;
    if (e > 0.8) {
        E = PI;
    } else {
        E = M + e * std::sin(M);
    }

    // Newton-Raphson iteration.
    for (int iter = 0; iter < 50; ++iter) {
        double f  = E - e * std::sin(E) - M;
        double fp = 1.0 - e * std::cos(E);
        double dE = f / fp;
        E -= dE;
        if (std::abs(dE) < tol) {
            break;
        }
    }

    // Normalize result to [0, 2*PI].
    E = std::fmod(E, TWO_PI);
    if (E < 0.0) {
        E += TWO_PI;
    }

    return E;
}

// ============================================================================
// Anomaly Conversions
// ============================================================================

/// Convert mean anomaly to eccentric anomaly.
///
/// Alias for solve_kepler() with a descriptive name.
///
/// @param M  Mean anomaly [rad].
/// @param e  Eccentricity [0, 1).
/// @return Eccentric anomaly E [rad].
inline double mean_to_eccentric(double M, double e) {
    return solve_kepler(M, e);
}

/// Convert mean anomaly to true anomaly.
///
/// Solves Kepler's equation for E, then converts to true anomaly using:
///   ta = 2 * atan2(sqrt(1+e)*sin(E/2), sqrt(1-e)*cos(E/2))
///
/// @param M  Mean anomaly [rad].
/// @param e  Eccentricity [0, 1).
/// @return True anomaly [rad] in [0, 2*PI].
inline double mean_to_true(double M, double e) {
    double E = solve_kepler(M, e);
    double sin_half = std::sin(E / 2.0);
    double cos_half = std::cos(E / 2.0);
    double ta = 2.0 * std::atan2(std::sqrt(1.0 + e) * sin_half,
                                  std::sqrt(1.0 - e) * cos_half);

    // Normalize to [0, 2*PI].
    if (ta < 0.0) {
        ta += TWO_PI;
    }

    return ta;
}

/// Convert eccentric anomaly to true anomaly.
///
/// Uses the half-angle formula for correct quadrant handling:
///   ta = 2 * atan2(sqrt(1+e)*sin(E/2), sqrt(1-e)*cos(E/2))
///
/// @param E  Eccentric anomaly [rad].
/// @param e  Eccentricity [0, 1).
/// @return True anomaly [rad] in [0, 2*PI].
inline double eccentric_to_true(double E, double e) {
    double sin_half = std::sin(E / 2.0);
    double cos_half = std::cos(E / 2.0);
    double ta = 2.0 * std::atan2(std::sqrt(1.0 + e) * sin_half,
                                  std::sqrt(1.0 - e) * cos_half);

    // Normalize to [0, 2*PI].
    if (ta < 0.0) {
        ta += TWO_PI;
    }

    return ta;
}

/// Convert true anomaly to mean anomaly.
///
/// First converts true anomaly to eccentric anomaly using:
///   E = 2 * atan(sqrt((1-e)/(1+e)) * tan(ta/2))
/// Then applies Kepler's equation: M = E - e*sin(E).
///
/// @param ta  True anomaly [rad].
/// @param e   Eccentricity [0, 1).
/// @return Mean anomaly [rad] in [0, 2*PI].
inline double true_to_mean(double ta, double e) {
    // True anomaly to eccentric anomaly.
    double half_ecc_factor = std::sqrt((1.0 - e) / (1.0 + e));
    double E = 2.0 * std::atan2(half_ecc_factor * std::sin(ta / 2.0), std::cos(ta / 2.0));

    // Eccentric anomaly to mean anomaly.
    double M = E - e * std::sin(E);

    // Normalize to [0, 2*PI].
    M = std::fmod(M, TWO_PI);
    if (M < 0.0) {
        M += TWO_PI;
    }

    return M;
}

// ============================================================================
// Keplerian Propagation
// ============================================================================

/// Propagate classical Keplerian elements by a time interval dt.
///
/// Computes the change in mean anomaly over dt, updates the true anomaly,
/// and returns new elements with all other parameters unchanged.
///
/// @param elem  Initial Keplerian elements.
/// @param dt    Propagation time [s]. Positive = forward, negative = backward.
/// @return Propagated Keplerian elements with updated true anomaly and epoch.
inline KeplerianElements propagate_kepler(const KeplerianElements& elem,
                                          double dt) {
    double e = elem.e;

    // Convert current true anomaly to mean anomaly.
    double M0 = true_to_mean(elem.ta, e);

    // Compute new mean anomaly: M = M0 + n * dt.
    double n = elem.mean_motion();
    double M = M0 + n * dt;

    // Normalize to [0, 2*PI].
    M = std::fmod(M, TWO_PI);
    if (M < 0.0) {
        M += TWO_PI;
    }

    // Convert back to true anomaly.
    double ta_new = mean_to_true(M, e);

    // Build result with updated ta and epoch.
    KeplerianElements result = elem;
    result.ta = ta_new;
    result.epoch = elem.epoch + dt / 86400.0;  // dt [s] -> [days].

    return result;
}

/// Propagate a state vector by time dt using two-body Kepler dynamics.
///
/// Converts the state to classical elements, propagates the elements
/// analytically via Kepler's equation, and converts back to a state vector.
/// This is the primary entry point for Keplerian propagation.
///
/// @param state  Initial state vector (position, velocity, epoch).
/// @param dt     Propagation time [s].
/// @return Propagated state vector.
inline StateVector propagate_kepler_state(const StateVector& state, double dt) {
    // Convert state vector to classical elements.
    KeplerianElements elem = state_to_elements(state.position, state.velocity,
                                                state.epoch);

    // Propagate elements.
    KeplerianElements elem_prop = propagate_kepler(elem, dt);

    // Convert back to state vector.
    StateVector result = elements_to_state(elem_prop);

    return result;
}

}  // namespace orbit
