#pragma once

/// @file coverage.hpp
/// @brief Constellation coverage analysis.
///        Generates Walker Delta constellations and computes single-point
///        and global coverage statistics.

#include <algorithm>
#include <cmath>
#include <vector>

#include "orbit_types.hpp"
#include "coordinate_frames.hpp"
#include "kepler.hpp"
#include "time_system.hpp"
#include "pass_predictor.hpp"

namespace orbit {

// ============================================================================
// Structs
// ============================================================================

/// Walker Delta constellation parameters.
struct WalkerDelta {
    double inclination_rad;   ///< Orbital inclination [rad].
    int total_sats;           ///< Total number of satellites.
    int num_planes;           ///< Number of orbital planes.
    int phasing_factor;       ///< Phasing factor F (inter-plane phase offset).
    double altitude_km;       ///< Circular orbit altitude [km].
};

/// Result of a coverage analysis over a single point or global grid.
struct CoverageResult {
    double coverage_fraction;   ///< Fraction of time target is covered [0,1].
    double max_gap_s;           ///< Maximum gap between passes [s].
    double avg_pass_duration_s; ///< Average pass duration [s].
    int total_passes;           ///< Total number of passes observed.
};

// ============================================================================
// Walker Constellation Generation
// ============================================================================

/// Generate initial state vectors for a Walker Delta constellation.
///
/// The Walker Delta pattern (i:T/P/F) distributes satellites uniformly
/// across orbital planes with a relative phase offset between planes:
///   - RAAN spacing: delta_raan = 2*PI / num_planes
///   - Mean anomaly offset per plane: delta_ma = 2*PI * phasing_factor / total_sats
///   - Mean anomaly of satellite j in plane p: ma = 2*PI * j / (total_sats/num_planes) + p * delta_ma
///
/// All satellites are placed in circular orbits at the specified altitude.
///
/// @param walker    Walker Delta constellation parameters.
/// @param jd_epoch  Epoch for the generated states [Julian Date].
/// @return Vector of StateVector in ECI (TEME) frame, one per satellite.
inline std::vector<StateVector> generate_walker(const WalkerDelta& walker,
                                                double jd_epoch) {
    std::vector<StateVector> states;
    states.reserve(walker.total_sats);

    double a = R_EARTH + walker.altitude_km;  // Semi-major axis for circular orbit.
    double e = 0.0;                            // Circular orbit.
    double ta = 0.0;                           // Start at ascending node.

    int sats_per_plane = walker.total_sats / walker.num_planes;
    double delta_raan = TWO_PI / walker.num_planes;
    double delta_ma = TWO_PI * walker.phasing_factor / walker.total_sats;

    for (int p = 0; p < walker.num_planes; ++p) {
        double raan = p * delta_raan;

        for (int j = 0; j < sats_per_plane; ++j) {
            // Mean anomaly offset within the plane plus inter-plane phasing.
            double ma = TWO_PI * static_cast<double>(j) / static_cast<double>(sats_per_plane)
                      + p * delta_ma;

            // For circular orbits, mean anomaly = true anomaly (argument of perigee is arbitrary).
            KeplerianElements elem(a, e, walker.inclination_rad, raan, 0.0, ma, jd_epoch);
            states.push_back(elements_to_state(elem));
        }
    }

    return states;
}

// ============================================================================
// Single-Point Coverage
// ============================================================================

/// Compute coverage of a ground target by a constellation.
///
/// For each satellite in the constellation, iterates through the time window
/// in 60-second steps, checking visibility at each epoch. Overlapping pass
/// intervals from different satellites are merged to compute total coverage.
///
/// @param constellation  Initial state vectors for the constellation (ECI frame).
/// @param target         Ground station to evaluate coverage for.
/// @param jd_start       Start of analysis window [Julian Date].
/// @param duration_days  Analysis duration [days].
/// @param min_elevation_rad  Minimum elevation for visibility [rad].
/// @return CoverageResult with coverage fraction, max gap, avg duration, pass count.
inline CoverageResult compute_point_coverage(
    const std::vector<StateVector>& constellation,
    const GroundStation& target,
    double jd_start,
    double duration_days,
    double min_elevation_rad = 5.0 * PI / 180.0) {

    CoverageResult result;
    result.coverage_fraction = 0.0;
    result.max_gap_s = 0.0;
    result.avg_pass_duration_s = 0.0;
    result.total_passes = 0;

    if (constellation.empty() || duration_days <= 0.0) {
        return result;
    }

    double jd_end = jd_start + duration_days;
    double dt_s = 60.0;  // 60-second time step.
    double total_s = duration_days * SEC_PER_DAY;

    // Collect all visibility intervals from all satellites.
    // Each interval is [start_jd, end_jd].
    std::vector<std::pair<double, double>> intervals;

    for (const auto& initial_state : constellation) {
        // Propagate satellite through the analysis window.
        std::vector<StateVector> trajectory;
        double t_s = 0.0;

        StateVector current = initial_state;
        trajectory.push_back(current);

        while (current.epoch < jd_end) {
            current = propagate_kepler_state(current, dt_s);
            trajectory.push_back(current);
            t_s += dt_s;
        }

        // Find passes for this satellite.
        std::vector<PassInfo> passes = predict_passes(target, trajectory, min_elevation_rad);

        for (const auto& pass : passes) {
            intervals.push_back({pass.start_jd, pass.end_jd});
            result.total_passes += 1;
        }
    }

    if (intervals.empty()) {
        result.max_gap_s = total_s;
        return result;
    }

    // Sort intervals by start time.
    std::sort(intervals.begin(), intervals.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });

    // Merge overlapping intervals.
    std::vector<std::pair<double, double>> merged;
    merged.push_back(intervals[0]);

    for (size_t i = 1; i < intervals.size(); ++i) {
        auto& last = merged.back();
        if (intervals[i].first <= last.second) {
            // Overlap: extend the end time if needed.
            last.second = std::max(last.second, intervals[i].second);
        } else {
            merged.push_back(intervals[i]);
        }
    }

    // Compute coverage fraction and max gap.
    double covered_s = 0.0;
    double prev_end_jd = jd_start;

    for (const auto& iv : merged) {
        // Gap before this interval.
        double gap_s = (iv.first - prev_end_jd) * SEC_PER_DAY;
        if (gap_s > result.max_gap_s) {
            result.max_gap_s = gap_s;
        }

        // Clamp interval to analysis window.
        double start = std::max(iv.first, jd_start);
        double end = std::min(iv.second, jd_end);

        covered_s += (end - start) * SEC_PER_DAY;
        prev_end_jd = iv.second;
    }

    // Gap after the last interval.
    double final_gap_s = (jd_end - prev_end_jd) * SEC_PER_DAY;
    if (final_gap_s > result.max_gap_s) {
        result.max_gap_s = final_gap_s;
    }

    result.coverage_fraction = std::clamp(covered_s / total_s, 0.0, 1.0);

    // Average pass duration.
    if (result.total_passes > 0) {
        result.avg_pass_duration_s = covered_s / static_cast<double>(result.total_passes);
    }

    return result;
}

// ============================================================================
// Global Coverage
// ============================================================================

/// Compute average global coverage fraction over a latitude/longitude grid.
///
/// Places ground stations at grid intersections and computes coverage fraction
/// at each point. The grid resolution is approximately 10 degrees (19 latitudes
/// from -80 to +80, 36 longitudes from 0 to 350).
///
/// @param constellation  Initial state vectors for the constellation (ECI frame).
/// @param jd_start       Start of analysis window [Julian Date].
/// @param duration_days  Analysis duration [days].
/// @param lat_res        Number of latitude points (default 19).
/// @param lon_res        Number of longitude points (default 36).
/// @return Average coverage fraction over the grid [0,1].
inline double compute_global_coverage(
    const std::vector<StateVector>& constellation,
    double jd_start,
    double duration_days,
    int lat_res = 19,
    int lon_res = 36) {

    if (constellation.empty() || duration_days <= 0.0) {
        return 0.0;
    }

    double total_coverage = 0.0;
    int num_points = 0;

    for (int lat_idx = 0; lat_idx < lat_res; ++lat_idx) {
        // Latitude from -80 to +80 degrees (skip poles).
        double lat_deg = -80.0 + (160.0 * lat_idx) / (lat_res - 1);
        double lat_rad = lat_deg * DEG_TO_RAD;

        for (int lon_idx = 0; lon_idx < lon_res; ++lon_idx) {
            // Longitude from 0 to 350 degrees.
            double lon_deg = (360.0 * lon_idx) / lon_res;
            double lon_rad = lon_deg * DEG_TO_RAD;

            GroundStation station;
            station.latitude_rad = lat_rad;
            station.longitude_rad = lon_rad;
            station.altitude_km = 0.0;
            station.elevation_mask_rad = 5.0 * DEG_TO_RAD;

            CoverageResult point_result = compute_point_coverage(
                constellation, station, jd_start, duration_days);

            total_coverage += point_result.coverage_fraction;
            num_points += 1;
        }
    }

    if (num_points == 0) {
        return 0.0;
    }

    return total_coverage / static_cast<double>(num_points);
}

}  // namespace orbit
