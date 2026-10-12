// bench_od.cpp
//
// Phase 6 OD performance benchmark (native). Times the three OD solve
// entry points on deterministic, synthetic workloads built in-process
// (no fixtures, no gtest):
//
//   1. gauss_iod       - F1-style 3-observation LEO geometry (three
//                        canonical stations, 600 s spacing; the same
//                        geometry as the gauss_iod_leo_3sta_clean golden
//                        fixture, angles regenerated in-process).
//   2. batch_od_solve  - 25-epoch x 3-station x (range, range-rate,
//                        RA/DEC) arc = 225 observations / 300 scalar
//                        rows, J2 force tier, seeded gaussian noise
//                        (seed 42, od_constants sigmas).
//   3. ekf_solve       - The same arc assimilated sequentially with the
//                        default 6D EKF configuration.
//
// Every solve self-validates (OK status, converged batch, states close
// to the injected truth); any validation failure exits nonzero so the
// benchmark doubles as a smoke test.
//
// Build: cmake -S wasm/tests -B build-native-tests -DBUILD_BENCH=ON
//        cmake --build build-native-tests -j --target bench_od
// Run:   ./build-native-tests/bench_od
// Or:    npm run bench:od

#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <random>
#include <vector>

#include "zenith/coordinate_frames.hpp"
#include "zenith/integrators.hpp"
#include "zenith/iod_gauss.hpp"
#include "zenith/kepler.hpp"
#include "zenith/observations.hpp"
#include "zenith/od_batch.hpp"
#include "zenith/od_constants.hpp"
#include "zenith/od_ekf.hpp"
#include "zenith/orbit_types.hpp"
#include "zenith/stations.hpp"
#include "zenith/time_system.hpp"

namespace {

using Clock = std::chrono::steady_clock;

/// Wall-clock milliseconds between t0 and now.
double elapsed_ms(Clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t0)
        .count();
}

struct TimingStats {
    double mean_ms = 0.0;
    double min_ms = 0.0;
    double max_ms = 0.0;
};

/// Mean/min/max over per-solve wall-clock samples.
TimingStats summarize(const std::vector<double>& samples) {
    TimingStats s;
    if (samples.empty()) {
        return s;
    }
    s.min_ms = samples[0];
    s.max_ms = samples[0];
    double acc = 0.0;
    for (const double v : samples) {
        acc += v;
        s.min_ms = (v < s.min_ms) ? v : s.min_ms;
        s.max_ms = (v > s.max_ms) ? v : s.max_ms;
    }
    s.mean_ms = acc / static_cast<double>(samples.size());
    return s;
}

// ---------------------------------------------------------------------------
// Shared workload constants (F1 geometry from references/standards.md)
// ---------------------------------------------------------------------------

constexpr double kEpochJd = 2460310.5;
constexpr double kF1SmaKm = 6778.137;
constexpr double kF1IncRad = 70.0 * orbit::DEG_TO_RAD;
constexpr double kF1TaRad = 30.0 * orbit::DEG_TO_RAD;

constexpr int kGaussIters = 50;
constexpr int kBatchIters = 3;
constexpr int kEkfIters = 3;

constexpr int kArcEpochs = 25;
constexpr double kArcSpacingS = 300.0;

/// The F1 circular LEO truth state at kEpochJd (two-body elements).
orbit::StateVector f1_truth_state() {
    const orbit::KeplerianElements elem(kF1SmaKm, 0.0, kF1IncRad, 0.0, 0.0,
                                        kF1TaRad, kEpochJd);
    return orbit::elements_to_state(elem);
}

// ---------------------------------------------------------------------------
// Workload 1: Gauss IOD on F1-style 3-obs geometry
// ---------------------------------------------------------------------------

/// Build the F1 three-station RA/Dec geometry (truth angles regenerated
/// from the two-body orbit each call).
void build_f1_gauss_obs(orbit::GaussIodObs (&obs3)[3],
                        orbit::ODGroundStation (&stations)[3]) {
    using namespace orbit;
    const StateVector s0 = f1_truth_state();
    stations[0] = canonical_station("goldstone");
    stations[1] = canonical_station("arecibo");
    stations[2] = canonical_station("tromsoe");
    const double dts[3] = {0.0, 600.0, 1200.0};
    for (int k = 0; k < 3; ++k) {
        const double jd = kEpochJd + dts[k] / SEC_PER_DAY;
        const StateVector sk = propagate_kepler_state(s0, dts[k]);
        const PredictedComponents c =
            predict_observation(sk.position, sk.velocity, stations[k], jd);
        obs3[k].time_jd = jd;
        obs3[k].ra_rad = c.ra_rad;
        obs3[k].dec_rad = c.dec_rad;
        obs3[k].station = &stations[k];
    }
}

struct GaussBenchOutcome {
    bool ok = false;
    orbit::GaussIodError status = orbit::GaussIodError::ERROR_NO_SOLUTION;
    double pos_err_km = 0.0;
};

/// Solve the F1 three-station geometry once and check the recovered
/// middle-epoch state against the two-body truth.
GaussBenchOutcome solve_gauss_once() {
    using namespace orbit;
    GaussIodObs obs3[3];
    ODGroundStation stations[3];
    build_f1_gauss_obs(obs3, stations);

    const GaussIodResult res = gauss_iod(obs3);
    const StateVector s0 = f1_truth_state();
    const StateVector truth_mid = propagate_kepler_state(s0, 600.0);
    const Vec3 dr(res.r[0] - truth_mid.position.x,
                  res.r[1] - truth_mid.position.y,
                  res.r[2] - truth_mid.position.z);

    GaussBenchOutcome out;
    out.status = res.status;
    out.pos_err_km = dr.magnitude();
    out.ok = (res.status == GaussIodError::OK ||
              res.status == GaussIodError::WARNING_ILL_CONDITIONED) &&
             out.pos_err_km < 1.0e-2;
    return out;
}

/// Time kGaussIters Gauss IOD solves; prints stats and validates.
bool bench_gauss_iod() {
    using namespace orbit;
    const GaussBenchOutcome check = solve_gauss_once();
    std::printf(
        "gauss_iod   (F1 LEO 3-sta, 600 s spacing, %d solves): "
        "status=%d pos_err=%.3e km\n",
        kGaussIters, static_cast<int>(check.status), check.pos_err_km);
    if (!check.ok) {
        std::printf("  FAIL: solve did not recover the truth state\n");
        return false;
    }

    // Geometry is immutable across solves; build it once outside the
    // timed loop so only gauss_iod itself is measured.
    GaussIodObs obs3[3];
    ODGroundStation stations[3];
    build_f1_gauss_obs(obs3, stations);

    std::vector<double> samples;
    samples.reserve(kGaussIters);
    for (int i = 0; i < kGaussIters; ++i) {
        const Clock::time_point t0 = Clock::now();
        const GaussIodResult res = gauss_iod(obs3);
        samples.push_back(elapsed_ms(t0));
        if (res.status != check.status) {
            std::printf("  FAIL: non-deterministic status at solve %d\n", i);
            return false;
        }
    }
    const TimingStats s = summarize(samples);
    std::printf("  mean %.3f ms   min %.3f ms   max %.3f ms\n", s.mean_ms,
                s.min_ms, s.max_ms);
    return s.max_ms < 1000.0;  // generous cap; target is < 10 ms typical
}

// ---------------------------------------------------------------------------
// Workloads 2 and 3: shared multi-epoch arc (batch + EKF)
// ---------------------------------------------------------------------------

struct Arc {
    std::vector<orbit::BatchObs> obs;
    std::array<double, 6> truth0{};
    int n_rows = 0;
    int n_epochs = 0;
};

/// Build the 25-epoch x 3-station radiometric + angles arc with seeded
/// gaussian noise; truth propagated with the J2 variational integrator
/// (same tier the solvers run at).
Arc build_arc() {
    using namespace orbit;
    Arc arc;
    arc.n_epochs = kArcEpochs;

    const StateVector s0 = f1_truth_state();
    for (int i = 0; i < 3; ++i) {
        arc.truth0[static_cast<std::size_t>(i)] =
            (i == 0) ? s0.position.x
                     : (i == 1) ? s0.position.y : s0.position.z;
        arc.truth0[static_cast<std::size_t>(3 + i)] =
            (i == 0) ? s0.velocity.x
                     : (i == 1) ? s0.velocity.y : s0.velocity.z;
    }

    std::array<double, 42> y0{};
    y0[0] = s0.position.x;
    y0[1] = s0.position.y;
    y0[2] = s0.position.z;
    y0[3] = s0.velocity.x;
    y0[4] = s0.velocity.y;
    y0[5] = s0.velocity.z;
    for (int i = 0; i < 6; ++i) {
        y0[static_cast<std::size_t>(6 + i * 6 + i)] = 1.0;
    }

    const ODGroundStation stations[3] = {
        canonical_station("goldstone"), canonical_station("arecibo"),
        canonical_station("tromsoe")};

    std::mt19937 rng(42);
    std::normal_distribution<double> normal(0.0, 1.0);

    arc.obs.reserve(static_cast<std::size_t>(kArcEpochs * 9));
    for (int k = 0; k < kArcEpochs; ++k) {
        const double dt = static_cast<double>(k) * kArcSpacingS;
        const STMResult stm = propagate_with_stm(
            y0, 0.0, dt, BATCH_STM_RTOL, BATCH_STM_ATOL, /*force_tier=*/1);
        if (!stm.success) {
            std::printf("FAIL: truth propagation failed at epoch %d\n", k);
            return arc;
        }
        const double jd = kEpochJd + dt / SEC_PER_DAY;

        for (const ODGroundStation& sta : stations) {
            BatchObs base;
            base.time_jd = jd;
            base.sta_pos = sta.position_eci(jd);
            base.sta_vel = sta.velocity_eci(jd);
            const PredictedComponents c = predict_observation(
                stm.position, stm.velocity, sta, jd);

            BatchObs range = base;
            range.obs_type = ObsType::RANGE;
            range.ndim = 1;
            range.values[0] = c.range_km + SIGMA_RANGE_KM * normal(rng);
            range.sigmas[0] = SIGMA_RANGE_KM;
            arc.obs.push_back(range);

            BatchObs rate = base;
            rate.obs_type = ObsType::RANGE_RATE;
            rate.ndim = 1;
            rate.values[0] =
                c.range_rate_kms + SIGMA_RANGE_RATE_KMS * normal(rng);
            rate.sigmas[0] = SIGMA_RANGE_RATE_KMS;
            arc.obs.push_back(rate);

            BatchObs angles = base;
            angles.obs_type = ObsType::RA_DEC;
            angles.ndim = 2;
            angles.values[0] = c.ra_rad + SIGMA_ANGLES_RAD * normal(rng);
            angles.values[1] = c.dec_rad + SIGMA_ANGLES_RAD * normal(rng);
            angles.sigmas[0] = SIGMA_ANGLES_RAD;
            angles.sigmas[1] = SIGMA_ANGLES_RAD;
            arc.obs.push_back(angles);
        }
    }

    for (const BatchObs& o : arc.obs) {
        arc.n_rows += o.ndim;
    }
    return arc;
}

/// Truth state guess: injected truth perturbed by 0.5 km / 0.2 m/s so the
/// solvers actually iterate.
std::array<double, 6> perturbed_guess(const Arc& arc) {
    std::array<double, 6> guess = arc.truth0;
    guess[0] += 0.5;
    guess[1] -= 0.3;
    guess[2] += 0.4;
    guess[3] += 1.0e-4;
    guess[4] += 2.0e-4;
    guess[5] -= 1.0e-4;
    return guess;
}

/// Position error norm of a 6-vector against the arc truth [km].
double pos_err_vs_truth(const double* state, const Arc& arc) {
    double acc = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double d = state[i] - arc.truth0[static_cast<std::size_t>(i)];
        acc += d * d;
    }
    return std::sqrt(acc);
}

/// Time kBatchIters batch solves on the arc; prints stats and validates.
bool bench_batch(const Arc& arc) {
    using namespace orbit;
    const std::array<double, 6> guess = perturbed_guess(arc);
    const BatchConfig config;  // defaults: J2 tier, editing enabled

    const BatchResult check =
        batch_od_solve(arc.obs, guess.data(), kEpochJd, config);
    const double check_err = pos_err_vs_truth(check.state.data(), arc);
    std::printf(
        "batch_od    (%d obs / %d rows / %d epochs, %d solves): "
        "error=%d converged=%d iters=%d wrms=%.3e pos_err=%.3e km\n",
        static_cast<int>(arc.obs.size()), arc.n_rows, arc.n_epochs,
        kBatchIters, static_cast<int>(check.error),
        check.converged ? 1 : 0, check.iterations, check.wrms, check_err);
    if (check.error != BatchError::OK || check_err > 1.0e-2) {
        std::printf("  FAIL: batch solve did not converge to truth\n");
        return false;
    }

    std::vector<double> samples;
    samples.reserve(kBatchIters);
    for (int i = 0; i < kBatchIters; ++i) {
        const Clock::time_point t0 = Clock::now();
        const BatchResult res = batch_od_solve(arc.obs, guess.data(), kEpochJd,
                                               config);
        samples.push_back(elapsed_ms(t0));
        if (res.error != BatchError::OK) {
            std::printf("  FAIL: non-deterministic batch error at run %d\n",
                        i);
            return false;
        }
    }
    const TimingStats s = summarize(samples);
    std::printf("  mean %.1f ms   min %.1f ms   max %.1f ms\n", s.mean_ms,
                s.min_ms, s.max_ms);
    return s.max_ms < 5000.0;  // generous cap; target is < 2 s typical
}

/// Time kEkfIters EKF solves on the same arc; prints stats and validates
/// the final state against the J2 truth at the last observation epoch.
bool bench_ekf(const Arc& arc) {
    using namespace orbit;
    const std::array<double, 6> guess = perturbed_guess(arc);
    const EKFConfig config;  // defaults: J2 tier, 6D, no maneuver mode

    // Truth at the last observation epoch for the final-state check.
    std::array<double, 42> y0{};
    for (int i = 0; i < 6; ++i) {
        y0[static_cast<std::size_t>(i)] =
            arc.truth0[static_cast<std::size_t>(i)];
        y0[static_cast<std::size_t>(6 + i * 6 + i)] = 1.0;
    }
    const double last_dt =
        static_cast<double>(kArcEpochs - 1) * kArcSpacingS;
    const STMResult truth_last = propagate_with_stm(
        y0, 0.0, last_dt, EKF_STM_RTOL, EKF_STM_ATOL, /*force_tier=*/1);
    if (!truth_last.success) {
        std::printf("FAIL: EKF truth propagation failed\n");
        return false;
    }

    const EKFResult check =
        ekf_solve(arc.obs, guess.data(), kEpochJd, config);
    double final_err = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double d = check.final_state[static_cast<std::size_t>(i)] -
                         (i == 0 ? truth_last.position.x
                                 : (i == 1 ? truth_last.position.y
                                           : truth_last.position.z));
        final_err += d * d;
    }
    final_err = std::sqrt(final_err);
    std::printf(
        "ekf_solve   (%d obs steps / %d rows, %d solves): "
        "error=%d updated=%d gated=%d final_pos_err=%.3e km\n",
        check.n_obs, check.n_rows, kEkfIters, static_cast<int>(check.error),
        check.n_updated, check.n_gated, final_err);
    if (check.error != EKFError::OK || final_err > 0.5) {
        std::printf("  FAIL: EKF did not track the truth arc\n");
        return false;
    }

    std::vector<double> samples;
    samples.reserve(kEkfIters);
    for (int i = 0; i < kEkfIters; ++i) {
        const Clock::time_point t0 = Clock::now();
        const EKFResult res = ekf_solve(arc.obs, guess.data(), kEpochJd,
                                        config);
        samples.push_back(elapsed_ms(t0));
        if (res.error != EKFError::OK) {
            std::printf("  FAIL: non-deterministic EKF error at run %d\n", i);
            return false;
        }
    }
    const TimingStats s = summarize(samples);
    std::printf("  mean %.1f ms   min %.1f ms   max %.1f ms\n", s.mean_ms,
                s.min_ms, s.max_ms);
    return s.max_ms < 5000.0;  // generous cap; target is < 2 s typical
}

}  // namespace

int main() {
#if defined(__OPTIMIZE__)
    const char* build = "optimized";
#else
    const char* build = "no optimization";
#endif
    std::printf("Zenith OD benchmark (native, %s)\n\n", build);

    bool ok = bench_gauss_iod();
    const Arc arc = build_arc();
    ok = bench_batch(arc) && ok;
    ok = bench_ekf(arc) && ok;

    std::printf("\n%s\n", ok ? "ALL BENCHMARKS PASSED"
                             : "BENCHMARK FAILURES DETECTED");
    return ok ? 0 : 1;
}
