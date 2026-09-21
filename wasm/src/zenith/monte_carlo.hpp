#pragma once

/// @file monte_carlo.hpp
/// @brief Monte Carlo uncertainty propagation engine.
///        Generates state samples from a Gaussian distribution around a nominal
///        state, propagates each sample via Keplerian dynamics, and computes
///        statistics (mean, standard deviations) over the ensemble.

#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <vector>

#include "core/orbit_types.hpp"
#include "core/kepler.hpp"

namespace orbit {

// ============================================================================
// Configuration & Result Structs
// ============================================================================

/// Configuration for a Monte Carlo propagation run.
struct MonteCarloConfig {
    int n_samples = 1000;             ///< Number of samples to propagate.
    double end_time_days = 1.0;       ///< Propagation duration [days].
    double position_stddev_km = 0.1;  ///< Position uncertainty [km] per axis.
    double velocity_stddev_km_s = 0.001;  ///< Velocity uncertainty [km/s] per axis.
    uint64_t seed = 42;               ///< Random seed for reproducibility.
};

/// Results from a Monte Carlo propagation run.
struct MonteCarloResult {
    StateVector mean_state;                    ///< Mean state at final epoch.
    std::vector<double> position_stddev;       ///< [x, y, z] standard deviations [km].
    std::vector<double> velocity_stddev;       ///< [vx, vy, vz] standard deviations [km/s].
    std::vector<StateVector> samples;          ///< All propagated samples.
};

// ============================================================================
// Random Number Generation
// ============================================================================

/// Generate 6 independent standard normal samples using the Box-Muller transform.
///
/// Uses a simple linear congruential generator (LCG) for the uniform random
/// numbers.  The LCG parameters are from Numerical Recipes.
///
/// @param[in,out] seed  LCG state; updated in place.
/// @return Array of 6 standard normal random variates.
inline std::array<double, 6> box_muller_sample(uint64_t& seed) {
    // LCG: seed = seed * 6364136223846793005 + 1
    auto next_uniform = [&seed]() -> double {
        seed = seed * 6364136223846793005ULL + 1ULL;
        // Map to (0, 1) exclusive.
        return static_cast<double>(seed >> 33) / static_cast<double>(1ULL << 31);
    };

    std::array<double, 6> result{};

    // Box-Muller produces pairs of independent normals from pairs of uniforms.
    for (int i = 0; i < 3; ++i) {
        double u1 = next_uniform();
        double u2 = next_uniform();

        // Avoid log(0).
        if (u1 < 1e-15) {
            u1 = 1e-15;
        }

        double r = std::sqrt(-2.0 * std::log(u1));
        double theta = TWO_PI * u2;

        result[2 * i]     = r * std::cos(theta);
        result[2 * i + 1] = r * std::sin(theta);
    }

    return result;
}

// ============================================================================
// Cholesky Decomposition
// ============================================================================

/// Cholesky decomposition of a 6x6 symmetric positive-definite matrix.
///
/// Computes the lower triangular matrix L such that A = L * L^T.
/// Uses the standard in-place algorithm.  Returns an empty optional if the
/// matrix is not positive definite (encounters a non-positive diagonal element).
///
/// @param A  6x6 symmetric positive-definite matrix (row-major storage).
/// @return Lower triangular matrix L, or empty optional on failure.
inline std::optional<std::array<std::array<double, 6>, 6>> cholesky_6x6(
        const std::array<std::array<double, 6>, 6>& A) {
    std::array<std::array<double, 6>, 6> L{};

    for (int j = 0; j < 6; ++j) {
        // Diagonal element.
        double sum_diag = 0.0;
        for (int k = 0; k < j; ++k) {
            sum_diag += L[j][k] * L[j][k];
        }
        double diag = A[j][j] - sum_diag;

        if (diag <= 0.0) {
            return std::nullopt;  // Not positive definite.
        }
        L[j][j] = std::sqrt(diag);

        // Off-diagonal elements in column j.
        for (int i = j + 1; i < 6; ++i) {
            double sum_off = 0.0;
            for (int k = 0; k < j; ++k) {
                sum_off += L[i][k] * L[j][k];
            }
            L[i][j] = (A[i][j] - sum_off) / L[j][j];
        }
    }

    return L;
}

// ============================================================================
// Monte Carlo Propagation
// ============================================================================

/// Propagate N samples from a Gaussian distribution around a nominal state.
///
/// For each sample:
///   1. Draw 6 standard normal variates via Box-Muller.
///   2. Scale by the configured standard deviations (independent per axis).
///   3. Perturb the nominal state vector.
///   4. Propagate using two-body Kepler dynamics.
///
/// After all samples are propagated, the function computes the mean state and
/// the standard deviation of each Cartesian component.
///
/// @param nominal  Nominal (mean) state vector at the initial epoch.
/// @param config   Monte Carlo configuration (sample count, uncertainties, seed).
/// @return MonteCarloResult with mean state, standard deviations, and all samples.
inline MonteCarloResult monte_carlo_propagate(
        const StateVector& nominal,
        const MonteCarloConfig& config) {
    MonteCarloResult result;
    result.samples.reserve(static_cast<size_t>(config.n_samples));
    result.position_stddev.resize(3, 0.0);
    result.velocity_stddev.resize(3, 0.0);

    double dt_s = config.end_time_days * SEC_PER_DAY;

    uint64_t rng_seed = config.seed;

    // Accumulators for mean computation.
    double mean_px = 0.0, mean_py = 0.0, mean_pz = 0.0;
    double mean_vx = 0.0, mean_vy = 0.0, mean_vz = 0.0;

    // First pass: propagate all samples and accumulate means.
    for (int i = 0; i < config.n_samples; ++i) {
        auto z = box_muller_sample(rng_seed);

        // Build perturbed state.
        StateVector perturbed;
        perturbed.position.x = nominal.position.x + z[0] * config.position_stddev_km;
        perturbed.position.y = nominal.position.y + z[1] * config.position_stddev_km;
        perturbed.position.z = nominal.position.z + z[2] * config.position_stddev_km;
        perturbed.velocity.x = nominal.velocity.x + z[3] * config.velocity_stddev_km_s;
        perturbed.velocity.y = nominal.velocity.y + z[4] * config.velocity_stddev_km_s;
        perturbed.velocity.z = nominal.velocity.z + z[5] * config.velocity_stddev_km_s;
        perturbed.epoch = nominal.epoch;

        // Propagate.
        StateVector propagated = propagate_kepler_state(perturbed, dt_s);
        result.samples.push_back(propagated);

        mean_px += propagated.position.x;
        mean_py += propagated.position.y;
        mean_pz += propagated.position.z;
        mean_vx += propagated.velocity.x;
        mean_vy += propagated.velocity.y;
        mean_vz += propagated.velocity.z;
    }

    double n = static_cast<double>(config.n_samples);

    mean_px /= n;
    mean_py /= n;
    mean_pz /= n;
    mean_vx /= n;
    mean_vy /= n;
    mean_vz /= n;

    // Build mean state.
    result.mean_state.position = Vec3(mean_px, mean_py, mean_pz);
    result.mean_state.velocity = Vec3(mean_vx, mean_vy, mean_vz);
    if (!result.samples.empty()) {
        result.mean_state.epoch = result.samples[0].epoch;
    }

    // Second pass: compute standard deviations.
    double var_px = 0.0, var_py = 0.0, var_pz = 0.0;
    double var_vx = 0.0, var_vy = 0.0, var_vz = 0.0;

    for (const auto& s : result.samples) {
        double dx = s.position.x - mean_px;
        double dy = s.position.y - mean_py;
        double dz = s.position.z - mean_pz;
        double dvx = s.velocity.x - mean_vx;
        double dvy = s.velocity.y - mean_vy;
        double dvz = s.velocity.z - mean_vz;

        var_px += dx * dx;
        var_py += dy * dy;
        var_pz += dz * dz;
        var_vx += dvx * dvx;
        var_vy += dvy * dvy;
        var_vz += dvz * dvz;
    }

    // Use Bessel's correction (n-1) for sample standard deviation.
    double denom = n - 1.0;
    if (denom < 1.0) {
        denom = 1.0;  // Degenerate case: n=1.
    }

    result.position_stddev[0] = std::sqrt(var_px / denom);
    result.position_stddev[1] = std::sqrt(var_py / denom);
    result.position_stddev[2] = std::sqrt(var_pz / denom);
    result.velocity_stddev[0] = std::sqrt(var_vx / denom);
    result.velocity_stddev[1] = std::sqrt(var_vy / denom);
    result.velocity_stddev[2] = std::sqrt(var_vz / denom);

    return result;
}

}  // namespace orbit
