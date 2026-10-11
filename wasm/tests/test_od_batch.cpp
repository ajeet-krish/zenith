// Native tests for zenith/od_batch.hpp (batch least-squares OD kernel).
//
// Golden-master port validation against helio_ob tests/test_od_batch.py
// semantics, without golden fixtures (fixture-driven parity lives in
// test_od_fixtures.cpp): input validation (empty obs, AZ_EL rejection,
// non-positive sigmas), the non-convergence flag path (max_iter=1 with a
// bad guess), graceful ERROR_SINGULAR_N on rank-deficient arcs (Helio
// raises an uncaught LinAlgError there; C++ must not crash), noise-free
// two-body recovery within Helio's CI-verified bounds (pos < 1e-4 km,
// vel < 1e-7 km/s), 3-sigma editing of a planted 10-sigma outlier,
// a-priori SPD validation, and the dt = 0 identity-STM path.
//
// Observation epochs follow the Helio truth-generation convention:
// jd = epoch_jd + dt / 86400, then dt = (jd - epoch_jd) * 86400 so the
// solver and the truth share the exact same dt (Julian Date round trips
// lose about 4e-5 s, which would otherwise bias noise-free residuals).

#include <gtest/gtest.h>

#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "zenith/coordinate_frames.hpp"
#include "zenith/integrators.hpp"
#include "zenith/observations.hpp"
#include "zenith/od_batch.hpp"
#include "zenith/orbit_types.hpp"
#include "zenith/stations.hpp"
#include "zenith/time_system.hpp"

using orbit::APrioriState;
using orbit::BatchConfig;
using orbit::BatchError;
using orbit::BatchObs;
using orbit::BatchResult;
using orbit::ODGroundStation;
using orbit::ObsType;
using orbit::StateVector;
using orbit::Vec3;

namespace {

constexpr double kDeg = orbit::DEG_TO_RAD;
constexpr double kJdEpoch0 = 2460310.5;  // utc_to_jd(2024, 1, 1, 0, 0, 0)
constexpr double kEpochOffsetS = 600.0;
constexpr double kJdEst = kJdEpoch0 + kEpochOffsetS / 86400.0;

/// Truth state at the mid-arc estimation epoch (helio
/// test_od_batch._truth_epoch_state; j2 = 0.0 two-body).
std::array<double, 6> truth_epoch_state_two_body() {
    orbit::KeplerianElements elem(6778.137, 0.0, 51.6 * kDeg, 0.0, 0.0,
                                  30.0 * kDeg, kJdEpoch0);
    const StateVector s0 = orbit::elements_to_state(elem);
    std::array<double, 42> y0{};
    y0[0] = s0.position.x;
    y0[1] = s0.position.y;
    y0[2] = s0.position.z;
    y0[3] = s0.velocity.x;
    y0[4] = s0.velocity.y;
    y0[5] = s0.velocity.z;
    for (int i = 0; i < 6; ++i) {
        y0[6 + static_cast<std::size_t>(i * 6 + i)] = 1.0;
    }
    const orbit::STMResult res = orbit::propagate_with_stm(
        y0, 0.0, kEpochOffsetS, orbit::BATCH_STM_RTOL, orbit::BATCH_STM_ATOL,
        0);
    EXPECT_TRUE(res.success);
    return {res.position.x, res.position.y, res.position.z,
            res.velocity.x, res.velocity.y, res.velocity.z};
}

/// Propagate a 6-state with the variational two-body tier by dt seconds.
std::array<double, 6> propagate_state(const std::array<double, 6>& state,
                                      double dt) {
    std::array<double, 42> y0{};
    for (int i = 0; i < 6; ++i) {
        y0[static_cast<std::size_t>(i)] = state[static_cast<std::size_t>(i)];
    }
    for (int i = 0; i < 6; ++i) {
        y0[6 + static_cast<std::size_t>(i * 6 + i)] = 1.0;
    }
    const orbit::STMResult res = orbit::propagate_with_stm(
        y0, 0.0, dt, orbit::BATCH_STM_RTOL, orbit::BATCH_STM_ATOL, 0);
    EXPECT_TRUE(res.success);
    return {res.position.x, res.position.y, res.position.z,
            res.velocity.x, res.velocity.y, res.velocity.z};
}

/// Simulate observations over an arc around the estimation epoch
/// (helio test_od_batch._make_arc, noise-free, station-major order).
std::vector<BatchObs> make_arc(const std::array<double, 6>& truth,
                               const std::vector<ODGroundStation*>& stations,
                               int n_epochs, double step_s,
                               const std::vector<ObsType>& obs_types) {
    std::vector<BatchObs> obs;
    for (const ODGroundStation* station : stations) {
        for (int m = 0; m < n_epochs; ++m) {
            const double dt_nom =
                (static_cast<double>(m) - (n_epochs - 1) / 2.0) * step_s;
            const double jd = kJdEst + dt_nom / 86400.0;
            const double dt = (jd - kJdEst) * 86400.0;
            const std::array<double, 6> s = propagate_state(truth, dt);
            const orbit::PredictedComponents c = orbit::predict_observation(
                Vec3(s[0], s[1], s[2]), Vec3(s[3], s[4], s[5]), *station, jd);
            const orbit::ObsConfig sig_cfg;
            for (const ObsType type : obs_types) {
                BatchObs o;
                o.time_jd = jd;
                o.sta_pos = station->position_eci(jd);
                o.sta_vel = station->velocity_eci(jd);
                o.obs_type = type;
                o.ndim = orbit::obs_ndim(type);
                switch (type) {
                    case ObsType::RANGE:
                        o.values[0] = c.range_km;
                        o.sigmas[0] = sig_cfg.sigma_range_km;
                        break;
                    case ObsType::RANGE_RATE:
                        o.values[0] = c.range_rate_kms;
                        o.sigmas[0] = sig_cfg.sigma_range_rate_kms;
                        break;
                    case ObsType::RA_DEC:
                        o.values[0] = c.ra_rad;
                        o.values[1] = c.dec_rad;
                        o.sigmas[0] = sig_cfg.sigma_angles_rad[0];
                        o.sigmas[1] = sig_cfg.sigma_angles_rad[1];
                        break;
                    default:
                        break;
                }
                obs.push_back(o);
            }
        }
    }
    return obs;
}

/// Deterministic nonzero guess offset: 1 km position, 1 m/s velocity.
std::array<double, 6> offset_guess(const std::array<double, 6>& truth) {
    std::array<double, 6> guess = truth;
    for (int i = 0; i < 3; ++i) {
        guess[static_cast<std::size_t>(i)] += 1e-3;
        guess[static_cast<std::size_t>(3 + i)] += 1e-3;
    }
    return guess;
}

std::vector<ODGroundStation*> three_stations() {
    static ODGroundStation gs = orbit::make_goldstone();
    static ODGroundStation ac = orbit::make_arecibo();
    static ODGroundStation tr = orbit::make_tromsoe();
    return {&gs, &ac, &tr};
}

}  // namespace

// ---------------------------------------------------------------------------
// Input validation (helio ValueError paths -> ERROR_INPUT)
// ---------------------------------------------------------------------------

TEST(OdBatch, EmptyObservationsRejected) {
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    const BatchResult res = orbit::batch_od_solve({}, truth.data(), kJdEst,
                                                  BatchConfig{});
    EXPECT_EQ(res.error, BatchError::ERROR_INPUT);
    EXPECT_FALSE(res.converged);
    EXPECT_EQ(res.n_rows, 0);
}

TEST(OdBatch, AzElObservationsRejected) {
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    ODGroundStation gs = orbit::make_goldstone();
    BatchObs o;
    o.time_jd = kJdEst;
    o.sta_pos = gs.position_eci(kJdEst);
    o.sta_vel = gs.velocity_eci(kJdEst);
    o.obs_type = ObsType::AZ_EL;
    o.ndim = 2;
    o.values[0] = 0.1;
    o.values[1] = 0.2;
    o.sigmas[0] = 5e-5;
    o.sigmas[1] = 5e-5;
    const BatchResult res = orbit::batch_od_solve({o}, truth.data(), kJdEst,
                                                  BatchConfig{});
    EXPECT_EQ(res.error, BatchError::ERROR_INPUT);
}

TEST(OdBatch, NonPositiveSigmasRejected) {
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    ODGroundStation gs = orbit::make_goldstone();
    for (const double bad_sigma : {0.0, -1e-3}) {
        BatchObs o;
        o.time_jd = kJdEst;
        o.sta_pos = gs.position_eci(kJdEst);
        o.sta_vel = gs.velocity_eci(kJdEst);
        o.obs_type = ObsType::RANGE;
        o.ndim = 1;
        o.values[0] = 7000.0;
        o.sigmas[0] = bad_sigma;
        const BatchResult res = orbit::batch_od_solve({o}, truth.data(),
                                                      kJdEst, BatchConfig{});
        EXPECT_EQ(res.error, BatchError::ERROR_INPUT);
    }
}

// ---------------------------------------------------------------------------
// Non-convergence flag (helio test_batch_non_convergence_flag)
// ---------------------------------------------------------------------------

TEST(OdBatch, MaxIterOneBadGuessFlagsNonConvergence) {
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    const std::vector<BatchObs> obs = make_arc(
        truth, three_stations(), 5, 120.0,
        {ObsType::RANGE, ObsType::RANGE_RATE, ObsType::RA_DEC});

    std::array<double, 6> bad_guess = truth;
    for (int i = 0; i < 3; ++i) {
        bad_guess[static_cast<std::size_t>(i)] += 0.01;      // 10 km
        bad_guess[static_cast<std::size_t>(3 + i)] += 0.1;   // 100 m/s
    }
    BatchConfig cfg;
    cfg.force_tier = 0;
    cfg.max_iter = 1;
    const BatchResult res =
        orbit::batch_od_solve(obs, bad_guess.data(), kJdEst, cfg);
    EXPECT_FALSE(res.converged);
    EXPECT_EQ(res.error, BatchError::ERROR_NOT_CONVERGED);
    // Editing may warm-restart once (Helio reports 2 total iterations on
    // this arc); the flag, not the count, is the contract here.
    EXPECT_GE(res.iterations, 1);
    for (double v : res.state) {
        EXPECT_TRUE(std::isfinite(v));
    }
}

// ---------------------------------------------------------------------------
// Rank-deficient arc -> ERROR_SINGULAR_N, graceful (documented divergence:
// Helio raises an uncaught np.linalg.LinAlgError on the final inv(N))
// ---------------------------------------------------------------------------

TEST(OdBatch, RankDeficientArcReportsSingularN) {
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    ODGroundStation gs = orbit::make_goldstone();
    // A single range observation: 1 scalar row cannot constrain 6
    // states, so both the iteration normal equations and the final
    // covariance inverse are singular.
    BatchObs o;
    o.time_jd = kJdEst;
    o.sta_pos = gs.position_eci(kJdEst);
    o.sta_vel = gs.velocity_eci(kJdEst);
    o.obs_type = ObsType::RANGE;
    o.ndim = 1;
    const std::array<double, 6> s = propagate_state(truth, 0.0);
    o.values[0] =
        orbit::predict_observation(Vec3(s[0], s[1], s[2]),
                                   Vec3(s[3], s[4], s[5]), gs, kJdEst)
            .range_km;
    o.sigmas[0] = 1e-3;

    BatchConfig cfg;
    cfg.force_tier = 0;
    const BatchResult res =
        orbit::batch_od_solve({o}, truth.data(), kJdEst, cfg);
    // The iteration loop bails (non-converged) but the solver must reach
    // the final covariance and report the singular-N error, not crash.
    EXPECT_EQ(res.error, BatchError::ERROR_SINGULAR_N);
    EXPECT_FALSE(res.converged);
    EXPECT_EQ(res.n_rows, 1);
    for (double v : res.state) {
        EXPECT_TRUE(std::isfinite(v));
    }
    for (double v : res.cov) {
        EXPECT_EQ(v, 0.0);  // Zeroed on the singular path.
    }
}

// ---------------------------------------------------------------------------
// Noise-free two-body recovery (B1-style, simplified; helio
// test_batch_noise_free_converges bounds)
// ---------------------------------------------------------------------------

TEST(OdBatch, NoiseFreeArcConvergesToTruth) {
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    const std::vector<BatchObs> obs = make_arc(
        truth, three_stations(), 5, 120.0,
        {ObsType::RANGE, ObsType::RANGE_RATE, ObsType::RA_DEC});
    const std::array<double, 6> guess = offset_guess(truth);

    BatchConfig cfg;
    cfg.force_tier = 0;  // Two-body (helio j2_for_stm = 0.0).
    const BatchResult res =
        orbit::batch_od_solve(obs, guess.data(), kJdEst, cfg);

    EXPECT_EQ(res.error, BatchError::OK);
    EXPECT_TRUE(res.converged);
    EXPECT_LE(res.iterations, 5);
    EXPECT_EQ(res.n_rows, 60);
    EXPECT_EQ(res.n_active, 60);
    EXPECT_EQ(res.edited_count, 0);

    double pos_err = 0.0;
    double vel_err = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double dp =
            res.state[static_cast<std::size_t>(i)] - truth[static_cast<std::size_t>(i)];
        const double dv = res.state[static_cast<std::size_t>(3 + i)] -
                          truth[static_cast<std::size_t>(3 + i)];
        pos_err += dp * dp;
        vel_err += dv * dv;
    }
    pos_err = std::sqrt(pos_err);
    vel_err = std::sqrt(vel_err);
    EXPECT_LT(pos_err, 1e-4);
    EXPECT_LT(vel_err, 1e-7);
    EXPECT_LT(res.wrms, 1e-6);

    // Residual table covers every original scalar row in sequence order.
    ASSERT_EQ(res.residuals.size(), 60u);
    EXPECT_EQ(res.residuals.front().time_jd, obs.front().time_jd);
    EXPECT_FALSE(res.residuals.front().edited);
}

// ---------------------------------------------------------------------------
// Editing removes a planted 10-sigma outlier (helio
// test_batch_outlier_editing)
// ---------------------------------------------------------------------------

TEST(OdBatch, EditingRemovesPlantedTenSigmaOutlier) {
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    std::vector<BatchObs> obs = make_arc(
        truth, three_stations(), 5, 120.0,
        {ObsType::RANGE, ObsType::RANGE_RATE, ObsType::RA_DEC});

    // Corrupt the first Arecibo range observation by 10 sigma (station-
    // major order puts it after goldstone's 5 epochs x 4 scalar rows).
    const ODGroundStation arecibo = orbit::make_arecibo();
    int corrupted_row = -1;
    for (std::size_t i = 0; i < obs.size(); ++i) {
        if (obs[i].obs_type != ObsType::RANGE) {
            continue;
        }
        const Vec3 ac_pos = arecibo.position_eci(obs[i].time_jd);
        const Vec3 d = obs[i].sta_pos - ac_pos;
        if (d.magnitude_squared() > 1e-12) {
            continue;  // Not the Arecibo station.
        }
        obs[i].values[0] += 10.0 * obs[i].sigmas[0];
        // Row index: sum of ndim of preceding observations.
        corrupted_row = 0;
        for (std::size_t k = 0; k < i; ++k) {
            corrupted_row += obs[k].ndim;
        }
        break;
    }
    ASSERT_GE(corrupted_row, 0);

    const std::array<double, 6> guess = offset_guess(truth);
    BatchConfig cfg;
    cfg.force_tier = 0;
    const BatchResult res =
        orbit::batch_od_solve(obs, guess.data(), kJdEst, cfg);

    EXPECT_EQ(res.error, BatchError::OK);
    EXPECT_TRUE(res.converged);
    ASSERT_LT(static_cast<std::size_t>(corrupted_row), res.residuals.size());
    EXPECT_TRUE(res.residuals[static_cast<std::size_t>(corrupted_row)].edited);
    // The short 5-epoch arc flags one extra pass-boundary row alongside
    // the planted outlier (Helio parity: edited_count = 2, iterations = 5
    // on this geometry); the planted row must be among the removals.
    EXPECT_GE(res.edited_count, 1);
    EXPECT_EQ(res.n_rows, 60);
    EXPECT_EQ(res.n_active, res.n_rows - res.edited_count);
    EXPECT_GE(res.iterations, 2);

    // After editing, the noise-free solution returns to the truth.
    double pos_err = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double dp =
            res.state[static_cast<std::size_t>(i)] - truth[static_cast<std::size_t>(i)];
        pos_err += dp * dp;
    }
    EXPECT_LT(std::sqrt(pos_err), 1e-4);
}

// ---------------------------------------------------------------------------
// A-priori SPD validation (helio test_apriori_spd_validation)
// ---------------------------------------------------------------------------

TEST(OdBatch, APrioriSpdValidation) {
    APrioriState ap;
    ap.valid = true;
    for (std::size_t i = 0; i < 6; ++i) {
        ap.cov[i * 6 + i] = 1e-8;
    }
    EXPECT_TRUE(orbit::apriori_validate(ap));

    // Not positive definite.
    APrioriState bad = ap;
    bad.cov[0] = -1.0;
    EXPECT_FALSE(orbit::apriori_validate(bad));

    // Not symmetric (off-diagonal mismatch beyond atol 1e-12).
    APrioriState asym = ap;
    asym.cov[1] = 1e-3;
    EXPECT_FALSE(orbit::apriori_validate(asym));

    // A solve with a non-SPD prior reports ERROR_A_PRIORI_INVALID.
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    const std::vector<BatchObs> obs = make_arc(truth, three_stations(), 3,
                                               120.0, {ObsType::RANGE});
    const std::array<double, 6> guess = offset_guess(truth);
    const BatchResult res = orbit::batch_od_solve(obs, guess.data(), kJdEst,
                                                  BatchConfig{}, &bad);
    EXPECT_EQ(res.error, BatchError::ERROR_A_PRIORI_INVALID);
}

// ---------------------------------------------------------------------------
// dt = 0 observation at the estimation epoch (identity STM path)
// ---------------------------------------------------------------------------

TEST(OdBatch, ZeroDtObservationAtEpochWorks) {
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    // All observations at the estimation epoch: the STM is the identity
    // and the solve must still converge (exercises the dt = 0 branch of
    // the variational propagator).
    std::vector<BatchObs> obs;
    for (const ODGroundStation* station : three_stations()) {
        const orbit::PredictedComponents c = orbit::predict_observation(
            Vec3(truth[0], truth[1], truth[2]), Vec3(truth[3], truth[4],
                                                     truth[5]),
            *station, kJdEst);
        const orbit::ObsConfig sig_cfg;
        for (const ObsType type :
             {ObsType::RANGE, ObsType::RANGE_RATE, ObsType::RA_DEC}) {
            BatchObs o;
            o.time_jd = kJdEst;
            o.sta_pos = station->position_eci(kJdEst);
            o.sta_vel = station->velocity_eci(kJdEst);
            o.obs_type = type;
            o.ndim = orbit::obs_ndim(type);
            switch (type) {
                case ObsType::RANGE:
                    o.values[0] = c.range_km;
                    o.sigmas[0] = sig_cfg.sigma_range_km;
                    break;
                case ObsType::RANGE_RATE:
                    o.values[0] = c.range_rate_kms;
                    o.sigmas[0] = sig_cfg.sigma_range_rate_kms;
                    break;
                case ObsType::RA_DEC:
                    o.values[0] = c.ra_rad;
                    o.values[1] = c.dec_rad;
                    o.sigmas[0] = sig_cfg.sigma_angles_rad[0];
                    o.sigmas[1] = sig_cfg.sigma_angles_rad[1];
                    break;
                default:
                    break;
            }
            obs.push_back(o);
        }
    }
    ASSERT_EQ(obs.size(), 9u);
    ASSERT_EQ(obs[0].time_jd, obs[8].time_jd);  // All at the epoch.

    // A tight a-priori keeps the exactly-plus-three-determined arc well
    // conditioned (12 rows, 6 unknowns, prior stabilizes velocity).
    APrioriState ap;
    ap.valid = true;
    ap.x0 = truth;
    for (std::size_t i = 0; i < 6; ++i) {
        ap.cov[i * 6 + i] = 1.0e4;  // Loose prior (100 km-class).
    }

    std::array<double, 6> guess = offset_guess(truth);
    BatchConfig cfg;
    cfg.force_tier = 0;
    cfg.max_iter = 15;
    const BatchResult res =
        orbit::batch_od_solve(obs, guess.data(), kJdEst, cfg, &ap);

    EXPECT_EQ(res.error, BatchError::OK);
    EXPECT_TRUE(res.converged);
    double pos_err = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double dp =
            res.state[static_cast<std::size_t>(i)] - truth[static_cast<std::size_t>(i)];
        pos_err += dp * dp;
    }
    EXPECT_LT(std::sqrt(pos_err), 1e-3);
}

// ---------------------------------------------------------------------------
// Residual table layout for a mixed range + ra_dec arc (guards the
// one-row-per-scalar-row expansion and the per-row slot semantics)
// ---------------------------------------------------------------------------

TEST(OdBatch, MixedRangeRaDecResidualTableLayout) {
    // Mixed arc: 2 stations x 3 epochs x {RA_DEC, RANGE} records. The
    // kernel must emit ONE residual row per SCALAR row, so each ra_dec
    // record expands to two consecutive rows (RA then Dec). Ordered
    // RA_DEC-before-RANGE per epoch so the final record is ndim = 1.
    // RA and Dec use DISTINCT sigmas so the per-row slot assertions
    // below discriminate which sigma lands in sigma[0].
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    static ODGroundStation gs = orbit::make_goldstone();
    static ODGroundStation ac = orbit::make_arecibo();
    const std::vector<ODGroundStation*> stations = {&gs, &ac};
    const int n_epochs = 3;
    const double step_s = 120.0;
    const double kSigmaRa = 1.0e-6;
    const double kSigmaDec = 2.5e-6;  // deliberately != kSigmaRa

    std::vector<BatchObs> obs;
    for (const ODGroundStation* station : stations) {
        for (int m = 0; m < n_epochs; ++m) {
            const double dt_nom = (static_cast<double>(m) - (n_epochs - 1) / 2.0) * step_s;
            const double jd = kJdEst + dt_nom / 86400.0;
            const double dt = (jd - kJdEst) * 86400.0;
            const std::array<double, 6> s = propagate_state(truth, dt);
            const orbit::PredictedComponents c = orbit::predict_observation(
                Vec3(s[0], s[1], s[2]), Vec3(s[3], s[4], s[5]), *station, jd);
            // RA_DEC first, RANGE second (trailing record is ndim = 1).
            BatchObs o;
            o.time_jd = jd;
            o.sta_pos = station->position_eci(jd);
            o.sta_vel = station->velocity_eci(jd);
            o.obs_type = ObsType::RA_DEC;
            o.ndim = 2;
            o.values[0] = c.ra_rad;
            o.values[1] = c.dec_rad;
            o.sigmas[0] = kSigmaRa;
            o.sigmas[1] = kSigmaDec;
            obs.push_back(o);
            BatchObs r;
            r.time_jd = jd;
            r.sta_pos = station->position_eci(jd);
            r.sta_vel = station->velocity_eci(jd);
            r.obs_type = ObsType::RANGE;
            r.ndim = 1;
            r.values[0] = c.range_km;
            const orbit::ObsConfig sig_cfg;
            r.sigmas[0] = sig_cfg.sigma_range_km;
            obs.push_back(r);
        }
    }
    // 2 stations x 3 epochs x 2 records = 12 records; scalar rows =
    // 6 ra_dec x 2 + 6 range x 1 = 18.
    ASSERT_EQ(obs.size(), 12u);

    const std::array<double, 6> guess = offset_guess(truth);
    BatchConfig cfg;
    cfg.force_tier = 0;
    const BatchResult res = orbit::batch_od_solve(obs, guess.data(), kJdEst, cfg);

    EXPECT_EQ(res.error, BatchError::OK);
    EXPECT_TRUE(res.converged);
    EXPECT_EQ(res.n_rows, 18);
    ASSERT_EQ(res.residuals.size(), 18u);
    EXPECT_EQ(res.n_active, 18);
    EXPECT_EQ(res.edited_count, 0);

    // Walk the table in sequence: every (station, epoch) contributes a
    // ra_dec PAIR then a range row. Contract per ra_dec pair: slot [0]
    // carries that row's OWN scalar component and slot [1] the
    // companion component of the SAME observation, so the RA row is
    // [RA, Dec] and the Dec row is [Dec, RA]. Per-row normalized[0] is
    // that row's scalar residual over that row's sigma. Also pinned:
    // normalized[i] == residual[i] / sigma[i] on every populated slot,
    // sigma[1] padding is zero on ndim = 1 rows, and nothing was
    // edited.
    std::size_t row = 0;
    for (int e = 0; e < 2 * n_epochs; ++e) {
        const orbit::BatchResidualRow& ra_row = res.residuals[row];
        const orbit::BatchResidualRow& dec_row = res.residuals[row + 1];
        const orbit::BatchResidualRow& range_row = res.residuals[row + 2];

        EXPECT_EQ(ra_row.obs_type, 2);  // RA_DEC
        EXPECT_EQ(ra_row.ndim, 2);
        EXPECT_EQ(dec_row.obs_type, 2);
        EXPECT_EQ(dec_row.ndim, 2);
        EXPECT_EQ(range_row.obs_type, 0);  // RANGE
        EXPECT_EQ(range_row.ndim, 1);

        // normalized[0] is the per-row scalar residual over its sigma.
        EXPECT_NEAR(ra_row.normalized[0], ra_row.residual[0] / ra_row.sigma[0], 1e-12);
        EXPECT_NEAR(dec_row.normalized[0], dec_row.residual[0] / dec_row.sigma[0], 1e-12);
        EXPECT_NEAR(range_row.normalized[0],
                    range_row.residual[0] / range_row.sigma[0], 1e-12);

        // RA row layout: [0] is RA, [1] is Dec.
        EXPECT_DOUBLE_EQ(ra_row.sigma[0], kSigmaRa);
        EXPECT_DOUBLE_EQ(ra_row.sigma[1], kSigmaDec);

        // Dec row layout: [0] is Dec, [1] is RA (the companion slots
        // of the SAME observation, never the next record).
        EXPECT_NEAR(dec_row.residual[0], ra_row.residual[1], 1e-15);
        EXPECT_NEAR(dec_row.sigma[0], ra_row.sigma[1], 1e-15);
        EXPECT_DOUBLE_EQ(dec_row.sigma[0], kSigmaDec);
        EXPECT_NEAR(dec_row.residual[1], ra_row.residual[0], 1e-15);
        EXPECT_NEAR(dec_row.sigma[1], ra_row.sigma[0], 1e-15);
        EXPECT_DOUBLE_EQ(dec_row.sigma[1], kSigmaRa);

        // Per-row normalized[0] uses that row's OWN sigma: the Dec
        // row's normalized[0] is dec_resid / sigma_dec.
        EXPECT_NEAR(dec_row.normalized[0],
                    ra_row.residual[1] / kSigmaDec, 1e-12);
        EXPECT_NEAR(ra_row.normalized[0],
                    dec_row.residual[1] / kSigmaRa, 1e-12);

        // Companion predicted/values slots mirror the residuals.
        EXPECT_NEAR(dec_row.predicted[1], ra_row.predicted[0], 1e-15);
        EXPECT_NEAR(dec_row.values[0], ra_row.values[1], 1e-15);
        EXPECT_NEAR(dec_row.values[1], ra_row.values[0], 1e-15);

        // normalized[i] == residual[i] / sigma[i] on every slot.
        EXPECT_NEAR(dec_row.normalized[1], dec_row.residual[1] / dec_row.sigma[1], 1e-12);

        // ndim = 1 padding on the range row.
        EXPECT_DOUBLE_EQ(range_row.sigma[1], 0.0);
        EXPECT_DOUBLE_EQ(range_row.normalized[1], 0.0);
        EXPECT_DOUBLE_EQ(range_row.residual[1], 0.0);

        // All rows active on this noise-free arc.
        EXPECT_FALSE(ra_row.edited);
        EXPECT_FALSE(dec_row.edited);
        EXPECT_FALSE(range_row.edited);

        row += 3;
    }
    EXPECT_EQ(row, 18u);
}

// ---------------------------------------------------------------------------
// Trailing ra_dec at the END of the table: the Dec row's companion
// slots must read the SAME observation's RA (flat indices first /
// first + 1), never flat index n_rows (one past the vector end; the
// pre-fix kernel read ev.residuals[row + 1] there, which is OOB for
// the last record). Deterministic slot-value asserts; an ASAN build
// additionally traps the pre-fix read.
// ---------------------------------------------------------------------------

TEST(OdBatch, TrailingRaDecAtTableEndReadsNoOutOfBounds) {
    // Same well-conditioned mixed arc as above, but RANGE-first per
    // (station, epoch), so the FINAL record is RA_DEC (ndim = 2) and
    // its Dec scalar row is the very last row of the table.
    const std::array<double, 6> truth = truth_epoch_state_two_body();
    static ODGroundStation gs = orbit::make_goldstone();
    static ODGroundStation ac = orbit::make_arecibo();
    const std::vector<ODGroundStation*> stations = {&gs, &ac};
    const int n_epochs = 3;
    const double step_s = 120.0;
    const double kSigmaRa = 1.0e-6;
    const double kSigmaDec = 2.5e-6;

    std::vector<BatchObs> obs;
    for (const ODGroundStation* station : stations) {
        for (int m = 0; m < n_epochs; ++m) {
            const double dt_nom = (static_cast<double>(m) - (n_epochs - 1) / 2.0) * step_s;
            const double jd = kJdEst + dt_nom / 86400.0;
            const double dt = (jd - kJdEst) * 86400.0;
            const std::array<double, 6> s = propagate_state(truth, dt);
            const orbit::PredictedComponents c = orbit::predict_observation(
                Vec3(s[0], s[1], s[2]), Vec3(s[3], s[4], s[5]), *station, jd);
            const orbit::ObsConfig sig_cfg;
            // RANGE first, RA_DEC second (trailing record is ndim = 2).
            BatchObs r;
            r.time_jd = jd;
            r.sta_pos = station->position_eci(jd);
            r.sta_vel = station->velocity_eci(jd);
            r.obs_type = ObsType::RANGE;
            r.ndim = 1;
            r.values[0] = c.range_km;
            r.sigmas[0] = sig_cfg.sigma_range_km;
            obs.push_back(r);
            BatchObs o;
            o.time_jd = jd;
            o.sta_pos = station->position_eci(jd);
            o.sta_vel = station->velocity_eci(jd);
            o.obs_type = ObsType::RA_DEC;
            o.ndim = 2;
            o.values[0] = c.ra_rad;
            o.values[1] = c.dec_rad;
            o.sigmas[0] = kSigmaRa;
            o.sigmas[1] = kSigmaDec;
            obs.push_back(o);
        }
    }
    ASSERT_EQ(obs.size(), 12u);

    const std::array<double, 6> guess = offset_guess(truth);
    BatchConfig cfg;
    cfg.force_tier = 0;
    const BatchResult res = orbit::batch_od_solve(obs, guess.data(), kJdEst, cfg);

    EXPECT_EQ(res.error, BatchError::OK);
    EXPECT_TRUE(res.converged);
    EXPECT_EQ(res.n_rows, 18);
    ASSERT_EQ(res.residuals.size(), 18u);

    // The final record is the trailing RA_DEC: rows 16 (RA) and 17
    // (Dec). Row 17's companion [1] slots must equal row 16's own RA
    // slots (the pre-fix code read ev.residuals[18] here: OOB).
    const orbit::BatchResidualRow& ra_row = res.residuals[16];
    const orbit::BatchResidualRow& dec_row = res.residuals[17];
    EXPECT_EQ(ra_row.obs_type, 2);
    EXPECT_EQ(ra_row.ndim, 2);
    EXPECT_EQ(dec_row.obs_type, 2);
    EXPECT_EQ(dec_row.ndim, 2);

    // Dec row (last row): [0] is Dec, [1] is the SAME record's RA.
    EXPECT_DOUBLE_EQ(dec_row.sigma[0], kSigmaDec);
    EXPECT_DOUBLE_EQ(dec_row.sigma[1], kSigmaRa);
    EXPECT_NEAR(dec_row.residual[0], ra_row.residual[1], 1e-15);
    EXPECT_NEAR(dec_row.residual[1], ra_row.residual[0], 1e-15);
    EXPECT_NEAR(dec_row.predicted[1], ra_row.predicted[0], 1e-15);
    EXPECT_NEAR(dec_row.normalized[0], dec_row.residual[0] / kSigmaDec, 1e-12);
    EXPECT_NEAR(dec_row.normalized[1], ra_row.residual[0] / kSigmaRa, 1e-12);

    // Structural walk: every ra_dec pair in the table follows the
    // [own, companion] contract and every row stays in-bounds.
    std::size_t row = 0;
    while (row < res.residuals.size()) {
        const orbit::BatchResidualRow& rr = res.residuals[row];
        if (rr.ndim == 2) {
            const orbit::BatchResidualRow& dr = res.residuals[row + 1];
            EXPECT_NEAR(dr.residual[0], rr.residual[1], 1e-15) << "row " << row;
            EXPECT_NEAR(dr.residual[1], rr.residual[0], 1e-15) << "row " << row;
            row += 2;
        } else {
            EXPECT_DOUBLE_EQ(rr.residual[1], 0.0) << "row " << row;
            row += 1;
        }
    }
    EXPECT_EQ(row, 18u);
}

// ---------------------------------------------------------------------------
// Flat-array parsing (WASM boundary layouts)
// ---------------------------------------------------------------------------

TEST(OdBatch, ParsesFlatObsTable) {
    // Two records: RANGE (12 doubles) + RA_DEC (14 doubles).
    const double flat[] = {
        2460310.5, 1.0, 2.0, 3.0, 0.1, 0.2, 0.3, 0.0, 1.0,
        7000.0, 1e-3,                       // RANGE record
        2460310.6, 4.0, 5.0, 6.0, 0.4, 0.5, 0.6, 2.0, 2.0,
        1.1, 0.9, 1e-6, 1e-6,               // RA_DEC record
    };
    const orbit::BatchObsTable table =
        orbit::parse_obs_flat(flat, sizeof(flat) / sizeof(flat[0]));
    ASSERT_TRUE(table.ok);
    ASSERT_EQ(table.obs.size(), 2u);
    EXPECT_EQ(table.obs[0].obs_type, ObsType::RANGE);
    EXPECT_EQ(table.obs[0].ndim, 1);
    EXPECT_DOUBLE_EQ(table.obs[0].values[0], 7000.0);
    EXPECT_EQ(table.obs[1].obs_type, ObsType::RA_DEC);
    EXPECT_EQ(table.obs[1].ndim, 2);
    EXPECT_DOUBLE_EQ(table.obs[1].values[1], 0.9);
    EXPECT_DOUBLE_EQ(table.obs[1].sigmas[1], 1e-6);

    // Truncated tail is rejected.
    const orbit::BatchObsTable bad =
        orbit::parse_obs_flat(flat, sizeof(flat) / sizeof(flat[0]) - 1);
    EXPECT_FALSE(bad.ok);
    EXPECT_TRUE(bad.obs.empty());
}

TEST(OdBatch, ParsesFlatConfigAndApriori) {
    BatchConfig cfg;
    const double cfg_flat[10] = {398600.4418, 0.0, 20.0, 1e-6, 1e-9,
                                 1e-3,        3.0, 0.10,  3.0,  0.0};
    EXPECT_TRUE(orbit::parse_config_flat(cfg_flat, 10, cfg));
    EXPECT_EQ(cfg.force_tier, 0);
    EXPECT_EQ(cfg.max_iter, 20);
    EXPECT_DOUBLE_EQ(cfg.sigma_edit, 3.0);
    EXPECT_DOUBLE_EQ(cfg.edit_max_fraction, 0.10);
    EXPECT_FALSE(cfg.enable_editing);

    // Out-of-range fields clamp: max_iter to [1, 100], sigma_edit to
    // [0.1, 100.0], edit_max_fraction to [0.0, 0.5].
    BatchConfig clamped;
    const double too_low[10] = {398600.4418, 0.0, -5.0, 1e-6, 1e-9,
                                1e-3,        -1.0, -0.4, 3.0,  0.0};
    EXPECT_TRUE(orbit::parse_config_flat(too_low, 10, clamped));
    EXPECT_EQ(clamped.max_iter, 1);
    EXPECT_DOUBLE_EQ(clamped.sigma_edit, 0.1);
    EXPECT_DOUBLE_EQ(clamped.edit_max_fraction, 0.0);

    BatchConfig too_high;
    const double high_flat[10] = {398600.4418, 0.0, 500.0, 1e-6, 1e-9,
                                  1e-3,        1e6, 0.9,   3.0,  0.0};
    EXPECT_TRUE(orbit::parse_config_flat(high_flat, 10, too_high));
    EXPECT_EQ(too_high.max_iter, 100);
    EXPECT_DOUBLE_EQ(too_high.sigma_edit, 100.0);
    EXPECT_DOUBLE_EQ(too_high.edit_max_fraction, 0.5);

    APrioriState ap;
    double ap_flat[42] = {};
    for (int i = 0; i < 6; ++i) ap_flat[i] = 1.0 + i;
    for (int i = 0; i < 6; ++i) ap_flat[6 + i * 6 + i] = 1e-8;
    ASSERT_TRUE(orbit::parse_apriori_flat(ap_flat, 42, ap));
    EXPECT_TRUE(ap.valid);
    EXPECT_DOUBLE_EQ(ap.x0[5], 6.0);
    EXPECT_DOUBLE_EQ(ap.cov[0], 1e-8);
    EXPECT_FALSE(orbit::parse_apriori_flat(ap_flat, 41, ap));
}
