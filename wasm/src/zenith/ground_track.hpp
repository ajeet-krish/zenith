#pragma once

/// @file ground_track.hpp
/// @brief Ground track computation from ECI state vectors.
///        Converts orbital trajectories to geodetic latitude, longitude, and
///        altitude, and provides utilities for ground track analysis including
///        longitude shift per orbit and repeat ground track period.

#include <cmath>
#include <utility>
#include <vector>

#include "orbit_types.hpp"
#include "kepler.hpp"
#include "coordinate_frames.hpp"
#include "time_system.hpp"

namespace orbit {

// ============================================================================
// Structs
// ============================================================================

/// A single point on the ground track.
struct GroundTrackPoint {
    double latitude_rad = 0.0;   ///< Geodetic latitude [rad], range [-PI/2, PI/2].
    double longitude_rad = 0.0;  ///< Geodetic longitude [rad], range [-PI, PI].
    double altitude_km = 0.0;    ///< Altitude above WGS-84 ellipsoid [km].
    double jd_utc = 0.0;         ///< UTC Julian Date of this point.
};

/// Configuration for ground track generation.
struct GroundTrackConfig {
    double time_step_s = 60.0;  ///< Time step between ground track points [s].
    int num_orbits = 1;         ///< Number of orbits to track.
};

// ============================================================================
// Ground Track Computation
// ============================================================================

/// Compute ground track from a trajectory (list of ECI state vectors).
///
/// For each state vector in the trajectory, the function converts the TEME
/// position to geodetic coordinates (latitude, longitude, altitude) using
/// the WGS-84 ellipsoid model.
///
/// @param trajectory  Vector of state vectors in TEME frame.
/// @return Vector of GroundTrackPoint with lat, lon, alt, and epoch.
inline std::vector<GroundTrackPoint> compute_ground_track(
        const std::vector<StateVector>& trajectory) {
    std::vector<GroundTrackPoint> track;
    track.reserve(trajectory.size());

    for (const auto& state : trajectory) {
        // Use UT1 ~ UTC for the rotation (no dut1 correction).
        LLA lla = teme_to_lla(state.position, state.epoch);

        GroundTrackPoint point;
        point.latitude_rad = lla.lat;
        point.longitude_rad = lla.lon;
        point.altitude_km = lla.alt;
        point.jd_utc = state.epoch;
        track.push_back(point);
    }

    return track;
}

/// Compute ground track from Keplerian elements.
///
/// Convenience function that first generates a trajectory by propagating the
/// given Keplerian elements, then converts to ground track points.
///
/// @param elem          Initial Keplerian elements.
/// @param jd_start      Start Julian Date.
/// @param duration_days Propagation duration [days].
/// @param time_step_s   Time step between points [s] (default 60 s).
/// @return Vector of GroundTrackPoint.
inline std::vector<GroundTrackPoint> compute_ground_track_from_element(
        const KeplerianElements& elem,
        double jd_start,
        double duration_days,
        double time_step_s = 60.0) {
    // Convert elements to initial state vector.
    KeplerianElements start_elem = elem;
    start_elem.epoch = jd_start;
    StateVector initial = elements_to_state(start_elem);

    // Generate trajectory.
    double total_s = duration_days * SEC_PER_DAY;
    int n_steps = static_cast<int>(std::ceil(total_s / time_step_s));

    std::vector<StateVector> trajectory;
    trajectory.reserve(static_cast<size_t>(n_steps + 1));

    for (int k = 0; k <= n_steps; ++k) {
        double t = static_cast<double>(k) * time_step_s;
        StateVector state = propagate_kepler_state(initial, t);
        trajectory.push_back(state);
    }

    return compute_ground_track(trajectory);
}

// ============================================================================
// Ground Track Analysis
// ============================================================================

/// Compute longitude shift per orbit due to Earth rotation.
///
/// While the satellite completes one orbit, Earth rotates underneath it.
/// The sub-satellite point shifts westward by:
///   delta_lon = -TWO_PI * T_orbit / T_sidereal_day
///
/// The negative sign indicates westward (retrograde) shift.
///
/// @param altitude_km  Circular orbit altitude [km].
/// @return Longitude shift per orbit [rad] (negative = westward).
inline double ground_track_shift_per_orbit(double altitude_km) {
    // Circular orbit radius.
    double r = R_EARTH + altitude_km;

    // Orbital period [s]: T = 2*PI * sqrt(a^3 / mu).
    double T_orbit = TWO_PI * std::sqrt(r * r * r / MU_EARTH);

    // Sidereal day [s]: 2*PI / omega_earth.
    double T_sidereal_day = TWO_PI / OMEGA_EARTH;

    // Longitude shift per orbit [rad].
    return -TWO_PI * T_orbit / T_sidereal_day;
}

/// Compute the repeat ground track period.
///
/// A ground track repeats when the satellite completes N orbits in the same
/// time that Earth rotates through M complete revolutions.  This function
/// finds the smallest integers (N, M) such that:
///   N * T_orbit approximately equals M * T_sidereal_day
///
/// Uses a brute-force search over small values of N and M (suitable for
/// LEO through GEO altitudes).
///
/// @param altitude_km     Circular orbit altitude [km].
/// @param inclination_rad Orbital inclination [rad] (currently unused in
///                        simplified model, reserved for future latitude
///                        repeat analysis).
/// @return Pair (N, M) where N is the number of orbits and M is the number
///         of sidereal days for one repeat cycle.
inline std::pair<int, int> repeat_ground_track_period(
        double altitude_km,
        double inclination_rad) {
    // Suppress unused parameter warning.
    (void)inclination_rad;

    // Circular orbit radius.
    double r = R_EARTH + altitude_km;

    // Orbital period [s].
    double T_orbit = TWO_PI * std::sqrt(r * r * r / MU_EARTH);

    // Sidereal day [s].
    double T_sidereal_day = TWO_PI / OMEGA_EARTH;

    // Search for the best rational approximation N/M of the ratio.
    // We want N * T_orbit ~ M * T_sidereal_day, i.e. N/M ~ T_sidereal_day / T_orbit.
    double target = T_sidereal_day / T_orbit;

    int best_n = 1;
    int best_m = 1;
    double best_error = std::abs(static_cast<double>(best_m) / static_cast<double>(best_n) - target);

    // Search up to N = 1000 orbits (covers LEO through GEO).
    for (int n = 1; n <= 1000; ++n) {
        int m = static_cast<int>(std::round(target * static_cast<double>(n)));
        if (m < 1) {
            m = 1;
        }

        double approx = static_cast<double>(m) / static_cast<double>(n);
        double error = std::abs(approx - target);

        if (error < best_error) {
            best_error = error;
            best_n = n;
            best_m = m;
        }

        // Stop early if we find a very good match (relative error < 1e-6).
        if (error / target < 1e-6) {
            break;
        }
    }

    return {best_n, best_m};
}

}  // namespace orbit
