#pragma once

/// @file conjunction.hpp
/// @brief Conjunction assessment for satellite close-approach screening.
///        Provides brute-force TCA search, catalog screening, and a
///        simplified 2D probability of collision estimate.

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

#include "orbit_types.hpp"
#include "kepler.hpp"
#include "coordinate_frames.hpp"

namespace orbit {

// ============================================================================
// Conjunction Data Structures
// ============================================================================

/// Describes a single close-approach event between two objects.
struct ConjunctionEvent {
    int sat_id_1 = 0;           ///< NORAD catalog number of object 1.
    int sat_id_2 = 0;           ///< NORAD catalog number of object 2.
    double tca_jd = 0.0;        ///< Time of closest approach [Julian Date].
    double miss_distance_km = 0.0; ///< Minimum distance between objects [km].
    Vec3 relative_position;     ///< Relative position vector at TCA [km].
};

/// Configuration for the brute-force conjunction screener.
struct ConjunctionConfig {
    double screen_distance_km = 10.0;  ///< Screening threshold [km].
    double time_step_s = 60.0;         ///< Time step for TCA search [s].
    int max_time_steps = 1440;         ///< Max steps (1 day at 60 s steps).
};

// ============================================================================
// Miss Distance
// ============================================================================

/// Compute the Euclidean distance between two state vectors at the same epoch.
///
/// @param s1  State vector of object 1.
/// @param s2  State vector of object 2.
/// @return Distance between the two objects [km].
inline double compute_miss_distance(const StateVector& s1,
                                    const StateVector& s2) {
    return (s1.position - s2.position).magnitude();
}

// ============================================================================
// TCA Search (Brute Force)
// ============================================================================

/// Find the time of closest approach (TCA) by scanning two aligned trajectories.
///
/// Both trajectory vectors must have the same number of samples and correspond
/// to the same time grid.  The function performs an O(n) scan to locate the
/// minimum miss distance.
///
/// @param traj1  Trajectory of object 1 (aligned time steps).
/// @param traj2  Trajectory of object 2 (aligned time steps).
/// @return ConjunctionEvent populated with TCA, miss distance, and relative
///         position.  Returns a zero-filled event if the input is empty.
inline ConjunctionEvent find_tca_brute_force(
        const std::vector<StateVector>& traj1,
        const std::vector<StateVector>& traj2) {
    ConjunctionEvent result;

    if (traj1.empty() || traj2.empty()) {
        return result;
    }

    const std::size_t n = std::min(traj1.size(), traj2.size());
    double best_dist = std::numeric_limits<double>::max();

    for (std::size_t k = 0; k < n; ++k) {
        double dist = compute_miss_distance(traj1[k], traj2[k]);
        if (dist < best_dist) {
            best_dist = dist;
            result.tca_jd = traj1[k].epoch;
            result.miss_distance_km = dist;
            result.relative_position = traj2[k].position - traj1[k].position;
        }
    }

    return result;
}

// ============================================================================
// Catalog Screening
// ============================================================================

/// Screen a catalog of propagated trajectories for pairwise close approaches.
///
/// For every unique pair (i, j) with i < j the function computes the minimum
/// miss distance across all aligned time steps.  If that distance falls below
/// the screening threshold a ConjunctionEvent is emitted.
///
/// Complexity: O(N^2 * T) where N is the number of objects and T the number of
/// time steps.  This is acceptable for catalogs with fewer than ~1000 objects.
///
/// @param catalog  Outer vector: one trajectory per satellite.  Each inner
///                 vector must be time-aligned across satellites (same epoch
///                 grid).
/// @param config   Screening parameters (distance threshold, etc.).
/// @return Vector of ConjunctionEvent records for all pairs that violate the
///         screening distance.
inline std::vector<ConjunctionEvent> screen_conjunctions(
        const std::vector<std::vector<StateVector>>& catalog,
        const ConjunctionConfig& config) {
    std::vector<ConjunctionEvent> events;
    const std::size_t n = catalog.size();

    for (std::size_t i = 0; i < n; ++i) {
        for (std::size_t j = i + 1; j < n; ++j) {
            ConjunctionEvent evt = find_tca_brute_force(catalog[i], catalog[j]);

            if (evt.miss_distance_km < config.screen_distance_km) {
                evt.sat_id_1 = static_cast<int>(i);
                evt.sat_id_2 = static_cast<int>(j);
                events.push_back(evt);
            }
        }
    }

    return events;
}

// ============================================================================
// Probability of Collision (2D Foster Approximation)
// ============================================================================

/// Simplified 2D probability of collision using Foster's formula approximation.
///
/// Projects the combined hard-body radius onto the B-plane and integrates a
/// 2D Gaussian over the disk.  The result is an approximation suitable for
/// screening; high-fidelity Pc should use the full 3D formulation.
///
/// @param rel_pos         Relative position vector at TCA [km].
/// @param rel_vel         Relative velocity vector at TCA [km/s].
/// @param combined_radius_km  Combined hard-body radius (R_1 + R_2) [km].
/// @return Probability of collision in [0, 1].
inline double compute_pc_2d(const Vec3& rel_pos,
                            const Vec3& rel_vel,
                            double combined_radius_km) {
    // Relative velocity magnitude.
    double v_rel = rel_vel.magnitude();
    if (v_rel < 1e-15) {
        // Zero relative velocity: use static overlap check.
        return (rel_pos.magnitude() <= combined_radius_km) ? 1.0 : 0.0;
    }

    // B-plane: plane perpendicular to relative velocity, passing through
    // the origin of the relative position at TCA.
    //
    // Project the relative position onto the B-plane to get the miss
    // distance (b).  For the simplified 2D case we assume isotropic
    // 1-sigma uncertainty (a coarse approximation for demonstration).
    double b = rel_pos.magnitude();

    // Sigma: treat the positional uncertainty as ~1 km (tunable).  In a
    // real implementation this would come from covariance propagation.
    double sigma = 1.0;

    // Foster's 2D approximation: integrate a 2D Gaussian over a disk of
    // radius R centered at miss distance b.  Using the standard
    // approximation valid when R/sigma << 1:
    //   Pc ~ (R^2 / (2 * sigma^2)) * exp(-b^2 / (2 * sigma^2))
    double r = combined_radius_km;
    double pc = (r * r / (2.0 * sigma * sigma))
                * std::exp(-(b * b) / (2.0 * sigma * sigma));

    // Clamp to [0, 1].
    if (pc < 0.0) pc = 0.0;
    if (pc > 1.0) pc = 1.0;

    return pc;
}

}  // namespace orbit
