// Native tests for zenith/od_ekf.hpp (sequential EKF OD kernel).
//
// Golden-master port validation against helio_ob tests/test_ekf.py
// semantics, without golden fixtures (fixture-driven parity lives in
// test_od_fixtures.cpp): input validation (empty obs, unsorted epochs,
// AZ_EL rejection, non-positive sigmas, bad p0_diag, unsorted
// scheduled burns, reserved estimate_cd), single-observation
// gracefulness, noise-free short-arc convergence (pos < 1e-3 km,
// vel < 1e-6 km/s), 100-sigma outlier gating, scheduled-maneuver
// reconstruction with a no-schedule negative control, maneuver
// detection with dv estimation within the documented 5e-4 km/s
// observability ceiling, covariance diagonal positivity after many
// updates, empty-flat parse routing for the [0] vs [59] error-header
// contract, and a zero-dv scheduled burn negative control.
//
// Observation epochs follow the Helio truth-generation convention:
// jd = epoch_jd + dt / 86400, then the truth is propagated with the
// same dt, so noise-free residuals vanish at the truth. Stations:
// Goldstone + Tromsoe; types: RANGE, RANGE_RATE, RA_DEC (6 obs per
// epoch, matching helio OBS_PER_EPOCH).

#include <gtest/gtest.h>

#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "zenith/coordinate_frames.hpp"
#include "zenith/integrators.hpp"
#include "zenith/observations.hpp"
#include "zenith/od_batch.hpp"
#include "zenith/od_ekf.hpp"
#include "zenith/orbit_types.hpp"
#include "zenith/stations.hpp"
#include "zenith/time_system.hpp"

using orbit::BatchObs;
using orbit::EKFConfig;
using orbit::EKFError;
using orbit::EKFResult;
using orbit::ODGroundStation;
using orbit::ObsType;
using orbit::ScheduledBurn;
using orbit::StateVector;
using orbit::Vec3;

namespace {

constexpr double kDeg = orbit::DEG_TO_RAD;
constexpr double kJdEpoch = 2460310.5;  // utc_to_jd(2024, 1, 1, 0, 0, 0)
constexpr int kObsPerEpoch = 6;  // 2 stations x 3 types.

/// Circular LEO truth state at the epoch: a = 6778.137 km, i = 51.6 deg
/// (helio conftest leo_state).
std::array<double, 6> leo_state() {
    orbit::KeplerianElements elem(6778.137, 0.0, 51.6 * kDeg, 0.0, 0.0,
                                  30.0 * kDeg, kJdEpoch);
    const StateVector s = orbit::elements_to_state(elem);
    return {s.position.x, s.position.y, s.position.z,
            s.velocity.x, s.velocity.y, s.velocity.z};
}

/// Propagate a 6-state with the variational J2 tier by dt seconds.
std::array<double, 6> propagate_j2(const std::array<double, 6>& state,
                                   double dt) {
    std::array<double, 42> y0{};
    for (int i = 0; i < 6; ++i) {
        y0[static_cast<std::size_t>(i)] = state[static_cast<std::size_t>(i)];
    }
    for (int i = 0; i < 6; ++i) {
        y0[6 + static_cast<std::size_t>(i * 6 + i)] = 1.0;
    }
    const orbit::STMResult res = orbit::propagate_with_stm(
        y0, 0.0, dt, orbit::EKF_STM_RTOL, orbit::EKF_STM_ATOL, 1);
    EXPECT_TRUE(res.success);
    return {res.position.x, res.position.y, res.position.z,
            res.velocity.x, res.velocity.y, res.velocity.z};
}

/// Truth state at dt seconds after the epoch, with an optional burn
/// (helio test_ekf._truth_state).
std::array<double, 6> truth_state(const std::array<double, 6>& truth0,
                                  double dt, double burn_dt = -1.0,
                                  const std::array<double, 3>& burn_dv = {0, 0, 0}) {
    if (burn_dt < 0.0 || dt <= burn_dt) {
        return propagate_j2(truth0, dt);
    }
    const std::array<double, 6> at_burn = propagate_j2(truth0, burn_dt);
    std::array<double, 6> post_burn = at_burn;
    for (int i = 0; i < 3; ++i) {
        post_burn[static_cast<std::size_t>(3 + i)] +=
            burn_dv[static_cast<std::size_t>(i)];
    }
    return propagate_j2(post_burn, dt - burn_dt);
}

/// Truth plus the deterministic Helio offset guess (1 m-class position,
/// 0.1 mm/s-class velocity).
std::array<double, 6> offset_guess(const std::array<double, 6>& truth) {
    std::array<double, 6> guess = truth;
    const double dr[3] = {5e-4, -4e-4, 3e-4};
    const double dv[3] = {2e-7, -1e-7, 1e-7};
    for (int i = 0; i < 3; ++i) {
        guess[static_cast<std::size_t>(i)] += dr[i];
        guess[static_cast<std::size_t>(3 + i)] += dv[i];
    }
    return guess;
}

std::vector<ODGroundStation*> two_stations() {
    static ODGroundStation goldstone = orbit::canonical_station("goldstone");
    static ODGroundStation tromsoe = orbit::canonical_station("tromsoe");
    return {&goldstone, &tromsoe};
}

/// Simulate observations at the given times from every station (helio
/// test_ekf._make_arc; noise-free; time-major, station-major, type-
/// minor order).
std::vector<BatchObs> make_arc(const std::array<double, 6>& truth0,
                               const std::vector<double>& times_s,
                               const std::vector<ODGroundStation*>& stations,
                               double burn_dt = -1.0,
                               const std::array<double, 3>& burn_dv = {0, 0, 0}) {
    std::vector<BatchObs> obs;
    const ObsType types[3] = {ObsType::RANGE, ObsType::RANGE_RATE,
                              ObsType::RA_DEC};
    const orbit::ObsConfig sig_cfg;
    for (double dt_nom : times_s) {
        const double jd = kJdEpoch + dt_nom / 86400.0;
        const double dt = (jd - kJdEpoch) * 86400.0;
        const std::array<double, 6> s = truth_state(truth0, dt, burn_dt, burn_dv);
        for (const ODGroundStation* station : stations) {
            const orbit::PredictedComponents c = orbit::predict_observation(
                Vec3(s[0], s[1], s[2]), Vec3(s[3], s[4], s[5]), *station, jd);
            for (const ObsType type : types) {
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

/// Standard 11-epoch short arc: (m - 5) * 120 s, m = 0..10.
std::vector<double> short_arc_times() {
    std::vector<double> times;
    for (int m = 0; m < 11; ++m) {
        times.push_back((m - 5) * 120.0);
    }
    return times;
}

/// Position/velocity error norms of a 6-vector vs truth.
std::pair<double, double> errs(const std::array<double, 6>& state,
                               const std::array<double, 6>& truth) {
    double pos = 0.0;
    double vel = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double dp = state[static_cast<std::size_t>(i)] -
                          truth[static_cast<std::size_t>(i)];
        const double dv = state[static_cast<std::size_t>(3 + i)] -
                          truth[static_cast<std::size_t>(3 + i)];
        pos += dp * dp;
        vel += dv * dv;
    }
    return {std::sqrt(pos), std::sqrt(vel)};
}

EKFConfig noise_free_config() {
    EKFConfig cfg;
    cfg.process.q_a = 0.0;
    return cfg;
}

}  // namespace

// ---------------------------------------------------------------------------
// Validation paths (helio ekf_solve ValueErrors -> EKFError::ERROR_INPUT)
// ---------------------------------------------------------------------------

TEST(EKF, EmptyObsIsInputError) {
    const std::array<double, 6> truth = leo_state();
    const std::array<double, 6> guess = offset_guess(truth);
    const EKFResult res = orbit::ekf_solve({}, guess.data(), kJdEpoch,
                                           EKFConfig{});
    EXPECT_EQ(res.error, EKFError::ERROR_INPUT);
}

TEST(EKF, UnsortedObsIsInputError) {
    const std::array<double, 6> truth = leo_state();
    std::vector<BatchObs> obs = make_arc(truth, short_arc_times(),
                                         two_stations());
    std::vector<BatchObs> reversed(obs.rbegin(), obs.rend());
    const std::array<double, 6> guess = offset_guess(truth);
    const EKFResult res = orbit::ekf_solve(reversed, guess.data(), kJdEpoch,
                                           EKFConfig{});
    EXPECT_EQ(res.error, EKFError::ERROR_INPUT);
}

TEST(EKF, EstimateCdIsReservedInputError) {
    const std::array<double, 6> truth = leo_state();
    std::vector<BatchObs> obs = make_arc(truth, {0.0}, two_stations());
    const std::array<double, 6> guess = offset_guess(truth);
    EKFConfig cfg;
    cfg.estimate_cd = true;
    const EKFResult res = orbit::ekf_solve(obs, guess.data(), kJdEpoch, cfg);
    EXPECT_EQ(res.error, EKFError::ERROR_INPUT);
}

TEST(EKF, ValidationErrorsAreInputErrors) {
    const std::array<double, 6> truth = leo_state();
    std::vector<BatchObs> obs = make_arc(truth, short_arc_times(),
                                         two_stations());
    const std::array<double, 6> guess = offset_guess(truth);
    const auto run = [&](const std::vector<BatchObs>& o, const EKFConfig& cfg,
                         const std::vector<ScheduledBurn>& burns = {}) {
        return orbit::ekf_solve(o, guess.data(), kJdEpoch, cfg, burns);
    };

    // AZ_EL row.
    {
        std::vector<BatchObs> az = make_arc(truth, {0.0}, two_stations());
        az[0].obs_type = ObsType::AZ_EL;
        az[0].ndim = 2;
        EXPECT_EQ(run(az, EKFConfig{}).error, EKFError::ERROR_INPUT);
    }
    // Non-positive sigma.
    {
        std::vector<BatchObs> bad = make_arc(truth, {0.0}, two_stations());
        bad[0].sigmas[0] = 0.0;
        EXPECT_EQ(run(bad, EKFConfig{}).error, EKFError::ERROR_INPUT);
    }
    // Bad p0_diag.
    {
        EKFConfig cfg;
        cfg.p0_diag[3] = -1e-6;
        EXPECT_EQ(run(obs, cfg).error, EKFError::ERROR_INPUT);
    }
    // Non-positive threshold / bad counts / inflate <= 1.
    {
        EKFConfig cfg;
        cfg.maneuver.nis_sigma_threshold = 0.0;
        EXPECT_EQ(run(obs, cfg).error, EKFError::ERROR_INPUT);
        cfg = EKFConfig{};
        cfg.maneuver.consecutive_exceedances = 0;
        EXPECT_EQ(run(obs, cfg).error, EKFError::ERROR_INPUT);
        cfg = EKFConfig{};
        cfg.maneuver.reentry_window_obs = 0;
        EXPECT_EQ(run(obs, cfg).error, EKFError::ERROR_INPUT);
        cfg = EKFConfig{};
        cfg.recovery.sustained_nis_count = 0;
        EXPECT_EQ(run(obs, cfg).error, EKFError::ERROR_INPUT);
        cfg = EKFConfig{};
        cfg.recovery.inflate_factor = 1.0;
        EXPECT_EQ(run(obs, cfg).error, EKFError::ERROR_INPUT);
        cfg = EKFConfig{};
        cfg.process.q_a = -1.0;
        EXPECT_EQ(run(obs, cfg).error, EKFError::ERROR_INPUT);
    }
    // Unsorted scheduled burns.
    {
        ScheduledBurn b0;
        b0.epoch_jd = kJdEpoch + 200.0 / 86400.0;
        ScheduledBurn b1;
        b1.epoch_jd = kJdEpoch + 100.0 / 86400.0;
        EXPECT_EQ(run(obs, EKFConfig{}, {b0, b1}).error,
                  EKFError::ERROR_INPUT);
    }
}

// ---------------------------------------------------------------------------
// WASM-boundary error-header contract: status at [0] for BOTH the normal
// serializer and od_ekf_error_header (malformed / oversized tables)
// ---------------------------------------------------------------------------

TEST(EKF, EmptyObsFlatRoutesToStatusZeroNormalHeader) {
    // exports.cpp od_ekf_solve_js contract: an empty obs flat parses as
    // zero records (parse_obs_flat's loop never runs, so ok=true), the
    // empty arc reaches the kernel, and ERROR_INPUT comes back through
    // the NORMAL serializer, which writes the status at header slot
    // [0]. od_ekf_error_header (malformed or oversized tables) writes
    // the status at the same [0] slot followed by 59 zeros, so every
    // result honors the documented header layout; that slot layout is
    // pinned vitest-side by the header-only fallback test in
    // od_ekf.test.ts.
    const double dummy = 0.0;
    const orbit::BatchObsTable table = orbit::parse_obs_flat(&dummy, 0);
    EXPECT_TRUE(table.ok);
    EXPECT_TRUE(table.obs.empty());

    const std::array<double, 6> guess = offset_guess(leo_state());
    const EKFResult res =
        orbit::ekf_solve({}, guess.data(), kJdEpoch, EKFConfig{});
    EXPECT_EQ(res.error, EKFError::ERROR_INPUT);
    EXPECT_EQ(res.n_obs, 0);
}

TEST(EKF, MalformedObsFlatRoutesToStatusZeroErrorHeader) {
    // A truncated record (9 header doubles, missing the value and
    // sigma slots) fails parse_obs_flat, which is exactly the
    // exports.cpp condition that emits od_ekf_error_header with the
    // status at slot [0] followed by 59 zeros (matching the normal
    // serializer's layout). This pins the malformed-table trigger side
    // of the header contract natively; the empty-flat case above pins
    // the kernel-rejected side. The [0] status slot of the error
    // header itself is pinned vitest-side by the header-only fallback
    // test in od_ekf.test.ts.
    const double flat[] = {
        2460310.5, 1.0, 2.0, 3.0, 0.1, 0.2, 0.3, 0.0, 1.0,
    };
    const orbit::BatchObsTable table =
        orbit::parse_obs_flat(flat, sizeof(flat) / sizeof(flat[0]));
    EXPECT_FALSE(table.ok);
    EXPECT_TRUE(table.obs.empty());
}

TEST(EKF, SingleObsIsGraceful) {
    const std::array<double, 6> truth = leo_state();
    std::vector<BatchObs> obs = make_arc(truth, {0.0}, two_stations());
    const std::array<double, 6> guess = offset_guess(truth);
    const EKFResult res =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, noise_free_config());
    ASSERT_EQ(res.error, EKFError::OK);
    EXPECT_EQ(res.n_obs, static_cast<int>(obs.size()));
    for (double v : res.final_state) {
        EXPECT_TRUE(std::isfinite(v));
    }
    for (double v : res.final_cov_diag) {
        EXPECT_TRUE(std::isfinite(v));
        EXPECT_GT(v, 0.0);
    }
}

// ---------------------------------------------------------------------------
// Tier 1: noise-free convergence (helio test_noise_free_convergence)
// ---------------------------------------------------------------------------

TEST(EKF, NoiseFreeConvergence) {
    const std::array<double, 6> truth = leo_state();
    const std::vector<double> times = short_arc_times();
    std::vector<BatchObs> obs = make_arc(truth, times, two_stations());
    const std::array<double, 6> guess = offset_guess(truth);

    const EKFResult res =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, noise_free_config());
    ASSERT_EQ(res.error, EKFError::OK);

    std::array<double, 6> last{};
    for (int i = 0; i < 6; ++i) {
        last[static_cast<std::size_t>(i)] =
            res.state_hist[static_cast<std::size_t>(res.n_obs * 6 - 6 + i)];
    }
    const std::array<double, 6> truth_final = truth_state(truth, times.back());
    const auto [pos_err, vel_err] = errs(last, truth_final);
    EXPECT_LT(pos_err, 1e-3);
    EXPECT_LT(vel_err, 1e-6);

    EXPECT_FALSE(res.divergence_flag);
    EXPECT_EQ(res.n_recoveries, 0);
    EXPECT_FALSE(res.augmented_active_final);
    EXPECT_TRUE(res.maneuver_records.empty());
    EXPECT_EQ(res.n_gated, 0);
    EXPECT_EQ(res.n_updated, res.n_rows);
    EXPECT_LT(res.nis_max, 25.0);
    EXPECT_FALSE(res.maneuver_flag[0]);
}

// ---------------------------------------------------------------------------
// Tier 2: 100-sigma outlier gating (helio test_outlier_gate)
// ---------------------------------------------------------------------------

TEST(EKF, OutlierGateSkipsLargeInnovation) {
    const std::array<double, 6> truth = leo_state();
    const std::vector<double> times = short_arc_times();
    std::vector<BatchObs> obs = make_arc(truth, times, two_stations());
    const std::array<double, 6> guess = offset_guess(truth);

    // Corrupt the mid observation (index 33, tromsoe RANGE at the
    // center epoch) by +100 sigma (helio test_outlier_gate).
    const std::size_t mid = obs.size() / 2;
    for (int i = 0; i < obs[mid].ndim; ++i) {
        obs[mid].values[static_cast<std::size_t>(i)] +=
            100.0 * obs[mid].sigmas[static_cast<std::size_t>(i)];
    }

    const EKFResult res =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, noise_free_config());
    ASSERT_EQ(res.error, EKFError::OK);

    for (int i = 0; i < obs[mid].ndim; ++i) {
        const std::size_t row = 2 * mid + static_cast<std::size_t>(i);
        EXPECT_FALSE(res.updated_mask[row]) << "row " << row;
        EXPECT_GT(res.nis[row], 25.0) << "row " << row;
    }
    EXPECT_GT(res.n_gated, 0);
    // The gated outlier does not bias the reconstruction.
    std::array<double, 6> last{};
    for (int i = 0; i < 6; ++i) {
        last[static_cast<std::size_t>(i)] =
            res.state_hist[static_cast<std::size_t>(res.n_obs * 6 - 6 + i)];
    }
    const std::array<double, 6> truth_final = truth_state(truth, times.back());
    const auto [pos_err, vel_err] = errs(last, truth_final);
    EXPECT_LT(pos_err, 1e-3);
    EXPECT_LT(vel_err, 1e-6);
}

// ---------------------------------------------------------------------------
// Tier 3: scheduled maneuver + negative control (helio test_scheduled_maneuver)
// ---------------------------------------------------------------------------

TEST(EKF, ScheduledManeuverReconstructsTrajectory) {
    const std::array<double, 6> truth = leo_state();
    const std::vector<double> times = short_arc_times();
    const double burn_dt = 60.0;
    const std::array<double, 3> burn_dv = {1e-4, -2e-4, 3e-4};
    std::vector<BatchObs> obs =
        make_arc(truth, times, two_stations(), burn_dt, burn_dv);
    const std::array<double, 6> guess = offset_guess(truth);

    ScheduledBurn burn;
    burn.epoch_jd = kJdEpoch + burn_dt / 86400.0;
    burn.dv = burn_dv;
    EKFConfig cfg = noise_free_config();
    cfg.maneuver.scheduled_inflate_kms = 1e-4;  // default; kept explicit.

    const EKFResult res =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, cfg, {burn});
    ASSERT_EQ(res.error, EKFError::OK);

    std::array<double, 6> last{};
    for (int i = 0; i < 6; ++i) {
        last[static_cast<std::size_t>(i)] =
            res.state_hist[static_cast<std::size_t>(res.n_obs * 6 - 6 + i)];
    }
    const std::array<double, 6> truth_final =
        truth_state(truth, times.back(), burn_dt, burn_dv);
    const auto [pos_err, vel_err] = errs(last, truth_final);
    EXPECT_LT(pos_err, 1e-3);
    EXPECT_LT(vel_err, 1e-6);

    // The first observation after the burn is flagged.
    const std::size_t first_post = 6 * kObsPerEpoch;  // epoch index 6.
    bool any_flag = false;
    for (int i = 0; i < kObsPerEpoch; ++i) {
        any_flag = any_flag ||
                   res.maneuver_flag[first_post + static_cast<std::size_t>(i)];
    }
    EXPECT_TRUE(any_flag);

    // Negative control: without the scheduled entry the burn is
    // unmodeled and the reconstruction fails at the 0.37 m/s level.
    const EKFResult control =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, noise_free_config());
    ASSERT_EQ(control.error, EKFError::OK);
    std::array<double, 6> ctrl_last{};
    for (int i = 0; i < 6; ++i) {
        ctrl_last[static_cast<std::size_t>(i)] =
            control.state_hist[static_cast<std::size_t>(control.n_obs * 6 - 6 + i)];
    }
    const auto [ctrl_pos_err, ctrl_vel_err] = errs(ctrl_last, truth_final);
    (void)ctrl_vel_err;
    EXPECT_GT(ctrl_pos_err, 0.05);
}

TEST(EKF, ScheduledZeroDvBurnBehavesLikeNoBurn) {
    // Negative control: a scheduled burn whose dv is exactly zero must
    // not move the reconstructed trajectory relative to a no-burn run
    // (the impulse adds nothing; only roundoff-level splitting of the
    // predict interval differs). The record is still consumed: the
    // post-burn observation is flagged and no maneuver is ESTIMATED.
    // A real dv at the same epoch does perturb the reconstruction, so
    // the zero-dv no-op above is not vacuous. Bounds measured with
    // clang -O0 and -O2 (identical to 3 digits).
    const std::array<double, 6> truth = leo_state();
    const std::vector<double> times = short_arc_times();
    const std::vector<BatchObs> obs = make_arc(truth, times, two_stations());
    const std::array<double, 6> guess = offset_guess(truth);
    const EKFConfig cfg = noise_free_config();

    // Baseline: no scheduled burns at all.
    const EKFResult baseline =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, cfg);
    ASSERT_EQ(baseline.error, EKFError::OK);

    // Zero-dv burn inside (480 s, 600 s]: the last observation epoch.
    ScheduledBurn zero_burn;
    zero_burn.epoch_jd = kJdEpoch + 540.0 / 86400.0;
    zero_burn.dv = {0.0, 0.0, 0.0};
    const EKFResult zero =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, cfg, {zero_burn});
    ASSERT_EQ(zero.error, EKFError::OK);

    // State-level no-op versus the no-burn reconstruction.
    std::array<double, 6> base_last{};
    std::array<double, 6> zero_last{};
    for (int i = 0; i < 6; ++i) {
        base_last[static_cast<std::size_t>(i)] =
            baseline.state_hist[static_cast<std::size_t>(
                baseline.n_obs * 6 - 6 + i)];
        zero_last[static_cast<std::size_t>(i)] =
            zero.state_hist[static_cast<std::size_t>(zero.n_obs * 6 - 6 + i)];
    }
    const auto [dpos, dvel] = errs(zero_last, base_last);
    EXPECT_LT(dpos, 1e-4);   // measured 6.7e-6 km
    EXPECT_LT(dvel, 1e-6);   // measured 1.5e-7 km/s

    // The zero-dv record is still consumed: exactly one flagged step,
    // at the first observation after the burn epoch (obs index 60,
    // epoch index 10), and nothing is estimated.
    int flag_count = 0;
    for (int k = 0; k < zero.n_obs; ++k) {
        if (zero.maneuver_flag[static_cast<std::size_t>(k)]) {
            ++flag_count;
            // First observation after the 540 s burn epoch is epoch
            // index 10 (t=600 s): obs index 10 * kObsPerEpoch.
            EXPECT_EQ(k, 10 * kObsPerEpoch) << "flagged step " << k;
        }
    }
    EXPECT_EQ(flag_count, 1);
    EXPECT_TRUE(zero.maneuver_records.empty());
    EXPECT_TRUE(baseline.maneuver_records.empty());

    // Reconstruction still converges to the burn-free truth.
    const std::array<double, 6> truth_final = truth_state(truth, times.back());
    const auto [pos_err, vel_err] = errs(zero_last, truth_final);
    (void)vel_err;
    EXPECT_LT(pos_err, 1e-3);

    // Positive control: a real 3.7e-4 km/s dv at the same epoch
    // perturbs the reconstruction well beyond the zero-dv envelope, so
    // the scheduled-burn mechanism is live and the no-op above is a
    // meaningful bound.
    ScheduledBurn real_burn = zero_burn;
    real_burn.dv = {1e-4, -2e-4, 3e-4};
    const EKFResult phantom =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, cfg, {real_burn});
    ASSERT_EQ(phantom.error, EKFError::OK);
    std::array<double, 6> phantom_last{};
    for (int i = 0; i < 6; ++i) {
        phantom_last[static_cast<std::size_t>(i)] =
            phantom.state_hist[static_cast<std::size_t>(
                phantom.n_obs * 6 - 6 + i)];
    }
    const auto [phantom_dpos, phantom_dvel] = errs(phantom_last, base_last);
    (void)phantom_dvel;
    EXPECT_GT(phantom_dpos, 1e-3);  // measured 4.4e-3 km
}

// ---------------------------------------------------------------------------
// Tier 3: maneuver detection + dv estimation (helio test_maneuver_detection)
// ---------------------------------------------------------------------------

TEST(EKF, ManeuverDetectionEstimatesDv) {
    const std::array<double, 6> truth = leo_state();
    std::vector<double> times;
    for (int m = 0; m < 21; ++m) {
        times.push_back((m - 10) * 120.0);
    }
    const double burn_dt = 60.0;
    const double speed = std::sqrt(truth[3] * truth[3] + truth[4] * truth[4] +
                                   truth[5] * truth[5]);
    const std::array<double, 3> burn_dv = {1e-3 * truth[3] / speed,
                                           1e-3 * truth[4] / speed,
                                           1e-3 * truth[5] / speed};
    std::vector<BatchObs> obs =
        make_arc(truth, times, two_stations(), burn_dt, burn_dv);
    const std::array<double, 6> guess = offset_guess(truth);

    EKFConfig cfg;
    cfg.process.q_a = 0.0;
    cfg.process.q_a_maneuver = 1e-9;
    cfg.maneuver.estimate_maneuver = true;
    cfg.maneuver.consecutive_exceedances = 2;
    cfg.maneuver.reentry_window_obs = 6;

    const EKFResult res =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, cfg);
    ASSERT_EQ(res.error, EKFError::OK);

    // Detection within 5 epochs of the burn epoch.
    std::size_t detected_at = res.maneuver_flag.size();
    for (std::size_t i = 0; i < res.maneuver_flag.size(); ++i) {
        if (res.maneuver_flag[i]) {
            detected_at = i;
            break;
        }
    }
    ASSERT_LT(detected_at, res.maneuver_flag.size()) << "no detection";
    // Helio: burn_epoch = searchsorted(times, 60 s) = 11 (first time
    // >= 60 is 120 s at index 11); detection must land within 5
    // epochs of that.
    const int burn_epoch = 11;
    EXPECT_LE(static_cast<int>(detected_at / kObsPerEpoch) - burn_epoch, 5);

    // One dv estimate within the documented observability ceiling
    // (20-50 percent of a 1 m/s burn; bound 5e-4 km/s = 0.5 m/s).
    ASSERT_EQ(res.maneuver_records.size(), 1u);
    double dv_err_sq = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double d = res.maneuver_records[0].dv[static_cast<std::size_t>(i)] -
                         burn_dv[static_cast<std::size_t>(i)];
        dv_err_sq += d * d;
    }
    EXPECT_LT(std::sqrt(dv_err_sq), 5e-4);

    std::array<double, 6> last{};
    for (int i = 0; i < 6; ++i) {
        last[static_cast<std::size_t>(i)] =
            res.state_hist[static_cast<std::size_t>(res.n_obs * 6 - 6 + i)];
    }
    const std::array<double, 6> truth_final =
        truth_state(truth, times.back(), burn_dt, burn_dv);
    const auto [pos_err, vel_err] = errs(last, truth_final);
    (void)vel_err;
    EXPECT_LT(pos_err, 0.01);
    EXPECT_FALSE(res.augmented_active_final);
}

// ---------------------------------------------------------------------------
// Covariance stays SPD-ish (positive diagonal) after many updates
// ---------------------------------------------------------------------------

TEST(EKF, CovarianceDiagonalStaysPositive) {
    const std::array<double, 6> truth = leo_state();
    std::vector<double> times;
    for (int m = 0; m < 31; ++m) {
        times.push_back(m * 60.0);
    }
    std::vector<BatchObs> obs = make_arc(truth, times, two_stations());
    const std::array<double, 6> guess = offset_guess(truth);

    const EKFResult res =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, noise_free_config());
    ASSERT_EQ(res.error, EKFError::OK);
    ASSERT_EQ(static_cast<int>(res.sigma_hist.size()), res.n_obs * 6);
    for (std::size_t i = 0; i < res.sigma_hist.size(); ++i) {
        ASSERT_TRUE(std::isfinite(res.sigma_hist[i])) << "sigma[" << i << "]";
        EXPECT_GE(res.sigma_hist[i], 0.0) << "sigma[" << i << "]";
    }
    for (double v : res.final_cov_diag) {
        EXPECT_GT(v, 0.0);
    }
    // Symmetric final covariance.
    for (int i = 0; i < 6; ++i) {
        for (int j = 0; j < 6; ++j) {
            EXPECT_NEAR(res.final_cov[static_cast<std::size_t>(i * 6 + j)],
                        res.final_cov[static_cast<std::size_t>(j * 6 + i)],
                        1e-12);
        }
    }
}

// ---------------------------------------------------------------------------
// Divergence recovery (helio test_divergence_recovery, native smoke)
// ---------------------------------------------------------------------------

TEST(EKF, DivergenceRecoveryReconverges) {
    const std::array<double, 6> truth = leo_state();
    std::vector<double> times;
    for (int m = 0; m < 21; ++m) {
        times.push_back((m - 10) * 120.0);
    }
    const double burn_dt = 60.0;
    const double speed = std::sqrt(truth[3] * truth[3] + truth[4] * truth[4] +
                                   truth[5] * truth[5]);
    const std::array<double, 3> burn_dv = {1e-3 * truth[3] / speed,
                                           1e-3 * truth[4] / speed,
                                           1e-3 * truth[5] / speed};
    std::vector<BatchObs> obs =
        make_arc(truth, times, two_stations(), burn_dt, burn_dv);
    const std::array<double, 6> guess = offset_guess(truth);

    EKFConfig cfg;
    cfg.process.q_a = 0.0;
    cfg.recovery.sustained_nis_count = 5;

    const EKFResult res = orbit::ekf_solve(obs, guess.data(), kJdEpoch, cfg);
    ASSERT_EQ(res.error, EKFError::OK);
    EXPECT_TRUE(res.divergence_flag);
    EXPECT_GE(res.n_recoveries, 1);

    std::array<double, 6> last{};
    for (int i = 0; i < 6; ++i) {
        last[static_cast<std::size_t>(i)] =
            res.state_hist[static_cast<std::size_t>(res.n_obs * 6 - 6 + i)];
    }
    const std::array<double, 6> truth_final =
        truth_state(truth, times.back(), burn_dt, burn_dv);
    const auto [pos_err, vel_err] = errs(last, truth_final);
    (void)vel_err;
    EXPECT_LT(pos_err, 0.5);

    // Negative control: unreachable sustained count never recovers and
    // stays far off the truth.
    EKFConfig control_cfg = cfg;
    control_cfg.recovery.sustained_nis_count = 10000;
    const EKFResult control =
        orbit::ekf_solve(obs, guess.data(), kJdEpoch, control_cfg);
    ASSERT_EQ(control.error, EKFError::OK);
    EXPECT_FALSE(control.divergence_flag);
    std::array<double, 6> ctrl_last{};
    for (int i = 0; i < 6; ++i) {
        ctrl_last[static_cast<std::size_t>(i)] =
            control.state_hist[static_cast<std::size_t>(control.n_obs * 6 - 6 + i)];
    }
    const auto [ctrl_pos_err, ctrl_vel_err] = errs(ctrl_last, truth_final);
    (void)ctrl_vel_err;
    EXPECT_GT(ctrl_pos_err, 1.0);
}
