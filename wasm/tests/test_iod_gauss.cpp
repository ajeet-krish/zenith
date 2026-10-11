// Native tests for zenith/iod_gauss.hpp (Gauss IOD + Herrick-Gibbs).
//
// Golden-master port validation against helio_ob tests/test_iod_gauss.py
// semantics: Herrick-Gibbs velocity on a two-body arc, input validation,
// geometry guards (equatorial coplanar, rapid cadence), noise-free
// recovery within Helio's CI-verified element bounds (da/a < 5e-3,
// de < 5e-3, di < 0.5 deg for LEO; da/a < 1e-2, de < 1e-2 for e = 0.3
// MEO; da/a < 1e-3 for GEO), and condition-number sanity.

#include <gtest/gtest.h>

#include <cmath>
#include <vector>

#include "zenith/coordinate_frames.hpp"
#include "zenith/iod_gauss.hpp"
#include "zenith/kepler.hpp"
#include "zenith/observations.hpp"
#include "zenith/stations.hpp"
#include "zenith/time_system.hpp"

using orbit::GaussIodConfig;
using orbit::GaussIodError;
using orbit::GaussIodObs;
using orbit::GaussIodResult;
using orbit::HerrickGibbsResult;
using orbit::ODGroundStation;
using orbit::StateVector;
using orbit::Vec3;

namespace {

constexpr double kDeg = orbit::DEG_TO_RAD;
constexpr double kJd0 = 2460310.5;  // utc_to_jd(2024, 1, 1, 0, 0, 0)

/// Truth state from classical elements at kJd0 (helio elements_to_state).
StateVector truth_state(double a, double e, double i_deg, double raan_deg,
                        double argp_deg, double ta_deg) {
    orbit::KeplerianElements elem(a, e, i_deg * kDeg, raan_deg * kDeg,
                                  argp_deg * kDeg, ta_deg * kDeg, kJd0);
    return orbit::elements_to_state(elem);
}

/// Build three noise-free RA/Dec observations of a truth state at the
/// given dt offsets from kJd0 (helio test _make_ra_dec_obs, noise-free).
std::vector<GaussIodObs> make_obs3(const StateVector& state0,
                                   const std::vector<double>& dts,
                                   const std::vector<ODGroundStation*>& sts) {
    std::vector<GaussIodObs> obs(3);
    for (int k = 0; k < 3; ++k) {
        const StateVector s = orbit::propagate_kepler_state(state0, dts[k]);
        const double jd = kJd0 + dts[k] / 86400.0;
        const orbit::PredictedComponents c = orbit::predict_observation(
            s.position, s.velocity, *sts[k], jd);
        obs[k].time_jd = jd;
        obs[k].ra_rad = c.ra_rad;
        obs[k].dec_rad = c.dec_rad;
        obs[k].station = sts[k];
    }
    return obs;
}

/// GaussIodObs array reference from a std::vector (size 3).
const GaussIodObs (&as_obs3(const std::vector<GaussIodObs>& v))[3] {
    return *reinterpret_cast<const GaussIodObs(*)[3]>(v.data());
}

}  // namespace

// ---------------------------------------------------------------------------
// Herrick-Gibbs
// ---------------------------------------------------------------------------

TEST(IodGauss, HerrickGibbsTwoBodyArc) {
    // helio conftest leo_state: a = 6778.137 km, e = 0, i = 51.6 deg.
    const StateVector leo =
        truth_state(6778.137, 0.0, 51.6, 0.0, 0.0, 30.0);
    const StateVector back = orbit::propagate_kepler_state(leo, -30.0);
    const StateVector fwd = orbit::propagate_kepler_state(leo, 30.0);

    const HerrickGibbsResult hg =
        orbit::herrick_gibbs(back.position, leo.position, fwd.position,
                             -30.0, 0.0, 30.0);
    ASSERT_EQ(hg.status, GaussIodError::OK);

    const Vec3 v_hg(hg.v[0], hg.v[1], hg.v[2]);
    const double tol = 1e-6 * leo.velocity.magnitude();
    EXPECT_LT(std::abs(v_hg.x - leo.velocity.x), tol);
    EXPECT_LT(std::abs(v_hg.y - leo.velocity.y), tol);
    EXPECT_LT(std::abs(v_hg.z - leo.velocity.z), tol);
}

TEST(IodGauss, HerrickGibbsRejectsBadTimes) {
    const Vec3 r(6778.0, 0.0, 0.0);
    // Non-increasing epochs (helio ValueError cases).
    EXPECT_EQ(orbit::herrick_gibbs(r, r, r, 0.0, 0.0, 100.0).status,
              GaussIodError::ERROR_INPUT);
    EXPECT_EQ(orbit::herrick_gibbs(r, r, r, 200.0, 100.0, 0.0).status,
              GaussIodError::ERROR_INPUT);
    EXPECT_EQ(orbit::herrick_gibbs(r, r, r, 0.0, 100.0, 100.0).status,
              GaussIodError::ERROR_INPUT);
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

TEST(IodGauss, RejectsNonIncreasingEpochs) {
    ODGroundStation gs = orbit::make_goldstone();
    const StateVector state0 = truth_state(6778.137, 0.0, 70.0, 0.0, 0.0, 30.0);
    std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 600.0, 1200.0}, {&gs, &gs, &gs});
    // Equal middle/last epochs (helio test_gauss_rejects_non_increasing_times).
    obs[2].time_jd = obs[1].time_jd;
    EXPECT_EQ(orbit::gauss_iod(as_obs3(obs)).status, GaussIodError::ERROR_INPUT);

    // Decreasing epochs.
    obs[2].time_jd = obs[0].time_jd - 1.0;
    EXPECT_EQ(orbit::gauss_iod(as_obs3(obs)).status, GaussIodError::ERROR_INPUT);
}

TEST(IodGauss, RejectsNullStation) {
    ODGroundStation gs = orbit::make_goldstone();
    const StateVector state0 = truth_state(6778.137, 0.0, 70.0, 0.0, 0.0, 30.0);
    std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 600.0, 1200.0}, {&gs, &gs, &gs});
    obs[1].station = nullptr;
    EXPECT_EQ(orbit::gauss_iod(as_obs3(obs)).status, GaussIodError::ERROR_INPUT);
}

TEST(IodGauss, RejectsNonPositiveMu) {
    ODGroundStation gs = orbit::make_goldstone();
    const StateVector state0 = truth_state(6778.137, 0.0, 70.0, 0.0, 0.0, 30.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 600.0, 1200.0}, {&gs, &gs, &gs});
    GaussIodConfig cfg;
    cfg.mu = 0.0;
    EXPECT_EQ(orbit::gauss_iod(as_obs3(obs), cfg).status,
              GaussIodError::ERROR_INPUT);
}

// ---------------------------------------------------------------------------
// Geometry guards (Helio F6-F8 equivalents)
// ---------------------------------------------------------------------------

TEST(IodGauss, RapidCadenceTwentyMsSingular) {
    // 20 ms spacing: near-parallel LOS and unusable D0 volume; helio
    // raises (ValueError after UserWarning). C++ reports ERROR_SINGULAR.
    ODGroundStation gs = orbit::make_goldstone();
    const StateVector state0 = truth_state(6778.137, 0.0, 70.0, 0.0, 0.0, 30.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 0.02, 0.04}, {&gs, &gs, &gs});
    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs));
    EXPECT_TRUE(res.status == GaussIodError::ERROR_SINGULAR ||
                res.status == GaussIodError::ERROR_NO_SOLUTION)
        << "status " << static_cast<int>(res.status);
}

TEST(IodGauss, IllConditionedTenthSecondWarnsAndSolves) {
    // 0.1 s spacing: cond ~ 1.5e8 (helio-measured), above the warning
    // threshold but solvable; helio warns and returns a finite state.
    ODGroundStation gs = orbit::make_goldstone();
    const StateVector state0 = truth_state(6778.137, 0.0, 70.0, 0.0, 0.0, 30.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 0.1, 0.2}, {&gs, &gs, &gs});
    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs));
    EXPECT_EQ(res.status, GaussIodError::WARNING_ILL_CONDITIONED);
    EXPECT_GT(res.condition_number, 1.0e8);
    EXPECT_LE(res.condition_number, 1.0e12);
    for (double v : res.r) {
        EXPECT_TRUE(std::isfinite(v));
    }
    for (double v : res.v) {
        EXPECT_TRUE(std::isfinite(v));
    }
}

TEST(IodGauss, EquatorialStationGeoCoplanarSingular) {
    // Equatorial station + equatorial GEO: every LOS lies in the
    // equatorial plane, so D0 ~ 0 and cond = inf (helio
    // test_gauss_geo_equatorial_station_singular raises ValueError).
    ODGroundStation eq("equatorial", 0.0, 0.0, 0.0);
    const StateVector state0 = truth_state(42164.137, 0.0, 0.0, 0.0, 0.0, 45.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 1200.0, 2400.0}, {&eq, &eq, &eq});
    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs));
    EXPECT_TRUE(res.status == GaussIodError::ERROR_SINGULAR ||
                res.status == GaussIodError::ERROR_INPUT)
        << "status " << static_cast<int>(res.status);
}

// ---------------------------------------------------------------------------
// Noise-free recovery (Helio tier-1 element bounds)
// ---------------------------------------------------------------------------

TEST(IodGauss, NoiseFreeLeoThreeStations) {
    // helio test_gauss_noise_free_leo: G/A/T at 10-minute spacing;
    // da/a < 5e-3, de < 5e-3, di < 0.5 deg.
    ODGroundStation gs = orbit::make_goldstone();
    ODGroundStation ar = orbit::make_arecibo();
    ODGroundStation tr = orbit::make_tromsoe();
    const StateVector state0 = truth_state(6778.137, 0.0, 70.0, 0.0, 0.0, 30.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 600.0, 1200.0}, {&gs, &ar, &tr});

    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs));
    ASSERT_TRUE(res.status == GaussIodError::OK ||
                res.status == GaussIodError::WARNING_ILL_CONDITIONED)
        << "status " << static_cast<int>(res.status);

    const StateVector truth = orbit::propagate_kepler_state(state0, 600.0);
    const orbit::KeplerianElements rec =
        orbit::state_to_elements(Vec3(res.r[0], res.r[1], res.r[2]),
                                 Vec3(res.v[0], res.v[1], res.v[2]), kJd0);
    const orbit::KeplerianElements els_true = orbit::state_to_elements(
        truth.position, truth.velocity, kJd0);

    EXPECT_LT(std::abs(rec.a - els_true.a) / els_true.a, 5e-3);
    EXPECT_LT(std::abs(rec.e - els_true.e), 5e-3);
    EXPECT_LT(std::abs(rec.i - els_true.i), 0.5 * kDeg);

    // Condition number sane for nominal multi-station geometry.
    EXPECT_LT(res.condition_number, 1.0e8);
    EXPECT_GT(res.condition_number, 1.0);
    EXPECT_LT(res.residual_norm, 1.0e-6);
    EXPECT_GT(res.iterations, 0);
}

TEST(IodGauss, NoiseFreeLeoSingleStation) {
    // helio test_gauss_noise_free_single_station: goldstone x3;
    // da/a < 5e-3, de < 5e-3.
    ODGroundStation gs = orbit::make_goldstone();
    const StateVector state0 = truth_state(6778.137, 0.0, 70.0, 0.0, 0.0, 30.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 600.0, 1200.0}, {&gs, &gs, &gs});

    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs));
    ASSERT_TRUE(res.status == GaussIodError::OK ||
                res.status == GaussIodError::WARNING_ILL_CONDITIONED);

    const StateVector truth = orbit::propagate_kepler_state(state0, 600.0);
    const orbit::KeplerianElements rec =
        orbit::state_to_elements(Vec3(res.r[0], res.r[1], res.r[2]),
                                 Vec3(res.v[0], res.v[1], res.v[2]), kJd0);
    const orbit::KeplerianElements els_true = orbit::state_to_elements(
        truth.position, truth.velocity, kJd0);
    EXPECT_LT(std::abs(rec.a - els_true.a) / els_true.a, 5e-3);
    EXPECT_LT(std::abs(rec.e - els_true.e), 5e-3);
}

TEST(IodGauss, NoiseFreeEccentricMeo) {
    // helio test_gauss_noise_free_eccentric: a = 24000 km, e = 0.3;
    // da/a < 1e-2, de < 1e-2.
    ODGroundStation gs = orbit::make_goldstone();
    ODGroundStation ar = orbit::make_arecibo();
    ODGroundStation tr = orbit::make_tromsoe();
    const StateVector state0 =
        truth_state(24000.0, 0.3, 63.0, 40.0, 90.0, 0.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 600.0, 1200.0}, {&gs, &ar, &tr});

    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs));
    ASSERT_TRUE(res.status == GaussIodError::OK ||
                res.status == GaussIodError::WARNING_ILL_CONDITIONED);

    const StateVector truth = orbit::propagate_kepler_state(state0, 600.0);
    const orbit::KeplerianElements rec =
        orbit::state_to_elements(Vec3(res.r[0], res.r[1], res.r[2]),
                                 Vec3(res.v[0], res.v[1], res.v[2]), kJd0);
    const orbit::KeplerianElements els_true = orbit::state_to_elements(
        truth.position, truth.velocity, kJd0);
    EXPECT_LT(std::abs(rec.a - els_true.a) / els_true.a, 1e-2);
    EXPECT_LT(std::abs(rec.e - els_true.e), 1e-2);
}

TEST(IodGauss, NoiseFreeGeoSingleStation) {
    // helio test_gauss_geo_from_goldstone: 20-minute spacing;
    // da/a < 1e-3, di < 0.5 deg.
    ODGroundStation gs = orbit::make_goldstone();
    const StateVector state0 = truth_state(42164.137, 0.0, 0.0, 0.0, 0.0, 45.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 1200.0, 2400.0}, {&gs, &gs, &gs});

    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs));
    ASSERT_TRUE(res.status == GaussIodError::OK ||
                res.status == GaussIodError::WARNING_ILL_CONDITIONED);

    const StateVector truth = orbit::propagate_kepler_state(state0, 1200.0);
    const orbit::KeplerianElements rec =
        orbit::state_to_elements(Vec3(res.r[0], res.r[1], res.r[2]),
                                 Vec3(res.v[0], res.v[1], res.v[2]), kJd0);
    const orbit::KeplerianElements els_true = orbit::state_to_elements(
        truth.position, truth.velocity, kJd0);
    EXPECT_LT(std::abs(rec.a - els_true.a) / els_true.a, 1e-3);
    EXPECT_LT(std::abs(rec.i - els_true.i), 0.5 * kDeg);
}

// ---------------------------------------------------------------------------
// Gap probes: uncorrected (HG-seeded) path and solver failure statuses
// ---------------------------------------------------------------------------

TEST(IodGauss, CorrectionDisabledKeepsHerrickGibbsSeed) {
    // enable_correction=false must skip differential correction and return
    // the Herrick-Gibbs seed built from the solved ranges. The seed is only
    // good to ~1e-4 rad of angular residual at 2-minute spacing, so the
    // residual tolerance is loosened to let it pass the filter.
    ODGroundStation gs = orbit::make_goldstone();
    ODGroundStation ar = orbit::make_arecibo();
    ODGroundStation tr = orbit::make_tromsoe();
    const StateVector state0 = truth_state(6778.137, 0.0, 70.0, 0.0, 0.0, 30.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 120.0, 240.0}, {&gs, &ar, &tr});

    GaussIodConfig cfg;
    cfg.enable_correction = false;
    cfg.residual_tol_rad = 1.0e-4;
    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs), cfg);
    ASSERT_TRUE(res.status == GaussIodError::OK ||
                res.status == GaussIodError::WARNING_ILL_CONDITIONED)
        << "status " << static_cast<int>(res.status);

    // No differential correction ran: the DC iteration count stays zero.
    EXPECT_EQ(res.iterations, 0);

    // The reported velocity must equal the Herrick-Gibbs estimate of the
    // three positions reconstructed from station + range * LOS (exactly
    // the seed pipeline the uncorrected path keeps).
    const GaussIodObs (&o3)[3] = as_obs3(obs);
    Vec3 pos[3];
    for (int k = 0; k < 3; ++k) {
        const Vec3 los = orbit::iod_detail::los_unit(o3[k].ra_rad, o3[k].dec_rad);
        pos[k] = o3[k].station->position_eci(o3[k].time_jd) +
                 los * res.ranges[k];
    }
    const HerrickGibbsResult hg = orbit::herrick_gibbs(
        pos[0], pos[1], pos[2], o3[0].time_jd * orbit::SEC_PER_DAY,
        o3[1].time_jd * orbit::SEC_PER_DAY, o3[2].time_jd * orbit::SEC_PER_DAY);
    ASSERT_EQ(hg.status, GaussIodError::OK);
    const Vec3 v_hg(hg.v[0], hg.v[1], hg.v[2]);
    const Vec3 v_res(res.v[0], res.v[1], res.v[2]);
    EXPECT_LT((v_hg - v_res).magnitude(), 1.0e-9);

    // The seed is still a usable estimate (sub-km position, sub-m/s-class
    // velocity at 2-minute spacing), just less accurate than the polished
    // solution.
    const StateVector truth = orbit::propagate_kepler_state(state0, 120.0);
    const Vec3 r_res(res.r[0], res.r[1], res.r[2]);
    EXPECT_LT((r_res - truth.position).magnitude(), 1.0);
    EXPECT_LT((v_res - truth.velocity).magnitude(), 1.0e-2);

    // Contrast: the corrected run polishes further (more iterations, the
    // DC path really is a different branch).
    const GaussIodResult corrected = orbit::gauss_iod(as_obs3(obs));
    ASSERT_EQ(corrected.status, GaussIodError::OK);
    EXPECT_GT(corrected.iterations, 0);
    EXPECT_LT((Vec3(corrected.r[0], corrected.r[1], corrected.r[2]) -
               truth.position)
                  .magnitude(),
              (r_res - truth.position).magnitude());
}

TEST(IodGauss, InconsistentAnglesReportNoSolution) {
    // Three arbitrary RA/Dec values that no single orbit can fit: every
    // scanned root fails the physicality or residual filter, so the
    // solver reports ERROR_NO_SOLUTION (the candidates.empty() branch).
    ODGroundStation gs = orbit::make_goldstone();
    ODGroundStation ar = orbit::make_arecibo();
    ODGroundStation tr = orbit::make_tromsoe();
    ODGroundStation* sts[3] = {&gs, &ar, &tr};
    const double ras[3] = {0.5, 2.1, 4.9};
    const double decs[3] = {0.3, -0.1, 0.8};

    GaussIodObs obs[3];
    for (int k = 0; k < 3; ++k) {
        obs[k].time_jd = kJd0 + k * 600.0 / 86400.0;
        obs[k].ra_rad = ras[k];
        obs[k].dec_rad = decs[k];
        obs[k].station = sts[k];
    }
    const GaussIodResult res = orbit::gauss_iod(obs);
    EXPECT_EQ(res.status, GaussIodError::ERROR_NO_SOLUTION);
}

TEST(IodGauss, DualRootGeometryReportsInconsistentRoots) {
    // MEO a=12000 km observed at 8-minute spacing near the Gauss range
    // ambiguity: two independent physical roots survive all filters and
    // disagree by more than CROSS_ROOT_KM (1 km), so the cross-root
    // consistency guard reports ERROR_INCONSISTENT_ROOTS.
    ODGroundStation gs = orbit::make_goldstone();
    ODGroundStation ar = orbit::make_arecibo();
    const StateVector state0 =
        truth_state(12000.0, 0.0, 35.0, 10.0, 80.0, 60.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 480.0, 960.0}, {&gs, &gs, &ar});
    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs));
    EXPECT_EQ(res.status, GaussIodError::ERROR_INCONSISTENT_ROOTS);
}

TEST(IodGauss, ConditionNumberSaneForNominalGeometry) {
    // Explicit cond check: three-station LEO geometry must report a
    // modest condition number and OK status.
    ODGroundStation gs = orbit::make_goldstone();
    ODGroundStation ar = orbit::make_arecibo();
    ODGroundStation tr = orbit::make_tromsoe();
    const StateVector state0 = truth_state(6778.137, 0.0, 70.0, 0.0, 0.0, 30.0);
    const std::vector<GaussIodObs> obs =
        make_obs3(state0, {0.0, 600.0, 1200.0}, {&gs, &ar, &tr});
    const GaussIodResult res = orbit::gauss_iod(as_obs3(obs));
    ASSERT_TRUE(std::isfinite(res.condition_number));
    EXPECT_GT(res.condition_number, 1.0);
    EXPECT_LT(res.condition_number, 100.0);
    EXPECT_EQ(res.status, GaussIodError::OK);
    // Ranges must be positive and plausible (satellite above the surface).
    for (double rho : res.ranges) {
        EXPECT_GT(rho, 0.0);
        EXPECT_LT(rho, 4.0e5);
    }
}
