// Native tests for zenith/observations.hpp and zenith/partials.hpp:
// prediction against helio_ob cross-checked values, analytic measurement
// partials against central finite differences, and deterministic seeded
// synthesis.

#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <vector>

#include "zenith/observations.hpp"
#include "zenith/partials.hpp"

using orbit::ObsType;
using orbit::Vec3;

namespace {

// Cross-check epoch and truth state used for the helio_ob reference
// values below (generated from helio.observations.predict_observation and
// helio.partials.measurement_partials with the same inputs).
constexpr double kJd = 2501911.5;
const Vec3 kR(6781.0, 1000.0, 2000.0);
const Vec3 kV(1.0, 7.0, 2.0);

// Central finite difference of a scalar observable w.r.t. a component of
// the ECI state.
template <typename F>
double fd_partial(const F& observable, const Vec3& r, const Vec3& v,
                  int component, double eps) {
    Vec3 rp = r;
    Vec3 rm = r;
    Vec3 vp = v;
    Vec3 vm = v;
    if (component < 3) {
        if (component == 0) { rp.x += eps; rm.x -= eps; }
        if (component == 1) { rp.y += eps; rm.y -= eps; }
        if (component == 2) { rp.z += eps; rm.z -= eps; }
    } else {
        if (component == 3) { vp.x += eps; vm.x -= eps; }
        if (component == 4) { vp.y += eps; vm.y -= eps; }
        if (component == 5) { vp.z += eps; vm.z -= eps; }
    }
    return (observable(rp, vp) - observable(rm, vm)) / (2.0 * eps);
}

}  // namespace

TEST(Observations, PredictMatchesHelioReference) {
    orbit::ODGroundStation gs = orbit::make_goldstone();
    orbit::PredictedComponents c =
        orbit::predict_observation(kR, kV, gs, kJd);

    // helio_ob reference values (same inputs, same station, same GMST).
    EXPECT_NEAR(c.range_km, 6.512948939010e3, 1e-8);
    EXPECT_NEAR(c.range_rate_kms, 5.220282589456, 1e-10);
    EXPECT_NEAR(c.ra_rad, 9.563235333554e-1, 1e-11);
    EXPECT_NEAR(c.dec_rad, -2.600566598404e-1, 1e-11);
    EXPECT_NEAR(c.az_rad, 1.615301318580, 1e-11);
    EXPECT_NEAR(c.el_rad, -3.964416688045e-1, 1e-11);

    // Range is positive and RA is in [0, 2*PI).
    EXPECT_GT(c.range_km, 0.0);
    EXPECT_GE(c.ra_rad, 0.0);
    EXPECT_LT(c.ra_rad, 2.0 * orbit::PI);
    EXPECT_GE(c.az_rad, 0.0);
    EXPECT_LT(c.az_rad, 2.0 * orbit::PI);
}

TEST(Observations, MakeObservationValuesAndSigmas) {
    orbit::ODGroundStation gs = orbit::make_goldstone();
    orbit::ObsConfig config;
    auto c = orbit::predict_observation(kR, kV, gs, kJd);

    orbit::ODObservation range_obs =
        orbit::make_observation(c, kJd, 0, ObsType::RANGE, config);
    EXPECT_EQ(range_obs.ndim, 1);
    EXPECT_DOUBLE_EQ(range_obs.values[0], c.range_km);
    EXPECT_DOUBLE_EQ(range_obs.sigmas[0], orbit::SIGMA_RANGE_KM);

    orbit::ODObservation rr_obs =
        orbit::make_observation(c, kJd, 2, ObsType::RANGE_RATE, config);
    EXPECT_EQ(rr_obs.ndim, 1);
    EXPECT_EQ(rr_obs.station_index, 2);
    EXPECT_DOUBLE_EQ(rr_obs.sigmas[0], orbit::SIGMA_RANGE_RATE_KMS);

    orbit::ODObservation radec_obs =
        orbit::make_observation(c, kJd, 0, ObsType::RA_DEC, config);
    EXPECT_EQ(radec_obs.ndim, 2);
    EXPECT_DOUBLE_EQ(radec_obs.values[0], c.ra_rad);
    EXPECT_DOUBLE_EQ(radec_obs.values[1], c.dec_rad);
    EXPECT_DOUBLE_EQ(radec_obs.sigmas[0], orbit::SIGMA_ANGLES_RAD);

    orbit::ODObservation azel_obs =
        orbit::make_observation(c, kJd, 0, ObsType::AZ_EL, config);
    EXPECT_EQ(azel_obs.ndim, 2);
    EXPECT_DOUBLE_EQ(azel_obs.values[0], c.az_rad);
    EXPECT_DOUBLE_EQ(azel_obs.values[1], c.el_rad);
    EXPECT_DOUBLE_EQ(azel_obs.sigmas[0], orbit::SIGMA_AZ_EL_RAD);
}

TEST(Observations, RangePartialsMatchFiniteDifference) {
    orbit::ODGroundStation gs = orbit::make_goldstone();

    auto observable = [&](const Vec3& r, const Vec3& v) {
        return orbit::predict_observation(r, v, gs, kJd).range_km;
    };

    double rows[12] = {0.0};
    int nrows = 0;
    ASSERT_TRUE(orbit::measurement_partials(ObsType::RANGE, kR, kV, gs, kJd,
                                            rows, &nrows));
    ASSERT_EQ(nrows, 1);

    for (int j = 0; j < 6; ++j) {
        const double eps = (j < 3) ? 1e-4 : 1e-7;
        const double numeric = fd_partial(observable, kR, kV, j, eps);
        EXPECT_NEAR(rows[j], numeric, 1e-5 * std::max(1.0, std::abs(rows[j])))
            << "range partial col " << j;
    }
}

TEST(Observations, RangeRatePartialsMatchFiniteDifference) {
    orbit::ODGroundStation gs = orbit::make_goldstone();

    auto observable = [&](const Vec3& r, const Vec3& v) {
        return orbit::predict_observation(r, v, gs, kJd).range_rate_kms;
    };

    double rows[12] = {0.0};
    int nrows = 0;
    ASSERT_TRUE(orbit::measurement_partials(ObsType::RANGE_RATE, kR, kV, gs,
                                            kJd, rows, &nrows));
    ASSERT_EQ(nrows, 1);

    for (int j = 0; j < 6; ++j) {
        const double eps = (j < 3) ? 1e-4 : 1e-7;
        const double numeric = fd_partial(observable, kR, kV, j, eps);
        EXPECT_NEAR(rows[j], numeric, 1e-5 * std::max(1e-4, std::abs(rows[j])))
            << "range-rate partial col " << j;
    }
}

TEST(Observations, RaDecPartialsMatchFiniteDifference) {
    orbit::ODGroundStation gs = orbit::make_goldstone();

    auto ra = [&](const Vec3& r, const Vec3& v) {
        return orbit::predict_observation(r, v, gs, kJd).ra_rad;
    };
    auto dec = [&](const Vec3& r, const Vec3& v) {
        return orbit::predict_observation(r, v, gs, kJd).dec_rad;
    };

    double rows[12] = {0.0};
    int nrows = 0;
    ASSERT_TRUE(orbit::measurement_partials(ObsType::RA_DEC, kR, kV, gs, kJd,
                                            rows, &nrows));
    ASSERT_EQ(nrows, 2);

    for (int j = 0; j < 3; ++j) {
        const double eps = 1e-4;
        EXPECT_NEAR(rows[j], fd_partial(ra, kR, kV, j, eps),
                    1e-5 * std::max(1e-4, std::abs(rows[j])))
            << "RA partial col " << j;
        EXPECT_NEAR(rows[6 + j], fd_partial(dec, kR, kV, j, eps),
                    1e-5 * std::max(1e-4, std::abs(rows[6 + j])))
            << "Dec partial col " << j;
    }
    // Velocity columns are zero (light time ignored).
    for (int j = 3; j < 6; ++j) {
        EXPECT_DOUBLE_EQ(rows[j], 0.0);
        EXPECT_DOUBLE_EQ(rows[6 + j], 0.0);
    }
}

TEST(Observations, AzElPartialsMatchFiniteDifference) {
    orbit::ODGroundStation gs = orbit::make_goldstone();

    auto az = [&](const Vec3& r, const Vec3& v) {
        return orbit::predict_observation(r, v, gs, kJd).az_rad;
    };
    auto el = [&](const Vec3& r, const Vec3& v) {
        return orbit::predict_observation(r, v, gs, kJd).el_rad;
    };

    double rows[12] = {0.0};
    int nrows = 0;
    ASSERT_TRUE(orbit::measurement_partials(ObsType::AZ_EL, kR, kV, gs, kJd,
                                            rows, &nrows));
    ASSERT_EQ(nrows, 2);

    for (int j = 0; j < 3; ++j) {
        const double eps = 1e-4;
        EXPECT_NEAR(rows[j], fd_partial(az, kR, kV, j, eps),
                    1e-5 * std::max(1e-4, std::abs(rows[j])))
            << "Az partial col " << j;
        EXPECT_NEAR(rows[6 + j], fd_partial(el, kR, kV, j, eps),
                    1e-5 * std::max(1e-4, std::abs(rows[6 + j])))
            << "El partial col " << j;
    }
    for (int j = 3; j < 6; ++j) {
        EXPECT_DOUBLE_EQ(rows[j], 0.0);
        EXPECT_DOUBLE_EQ(rows[6 + j], 0.0);
    }
}

TEST(Observations, PartialsHelioReference) {
    // Golden-master spot check against helio_ob measurement_partials.
    orbit::ODGroundStation gs = orbit::make_goldstone();

    double rows[12] = {0.0};
    int nrows = 0;
    ASSERT_TRUE(orbit::measurement_partials(ObsType::RANGE, kR, kV, gs, kJd,
                                            rows, &nrows));
    EXPECT_NEAR(rows[0], 0.557142322022, 1e-11);
    EXPECT_NEAR(rows[1], 0.789603613793, 1e-11);
    EXPECT_NEAR(rows[2], -0.257135306981, 1e-11);

    ASSERT_TRUE(orbit::measurement_partials(ObsType::RANGE_RATE, kR, kV, gs,
                                            kJd, rows, &nrows));
    EXPECT_NEAR(rows[0], -3.394049374328e-04, 1e-15);
    EXPECT_NEAR(rows[1], 4.066011063938e-04, 1e-15);
    EXPECT_NEAR(rows[2], 5.131805880053e-04, 1e-15);
    EXPECT_NEAR(rows[3], 0.5571423220224, 1e-11);
}

TEST(Observations, SeededSynthesisDeterministic) {
    orbit::ODGroundStation gs = orbit::make_goldstone();
    orbit::ObsConfig config;

    std::vector<orbit::StateVector> states(3);
    for (int i = 0; i < 3; ++i) {
        states[i] = orbit::StateVector(kR + Vec3(100.0 * i, 0.0, 0.0),
                                       kV, kJd + 0.001 * i);
    }
    const std::vector<ObsType> types = {ObsType::RANGE, ObsType::RA_DEC};

    auto run1 = orbit::generate_observations(states, gs, 0, types, config, 42);
    auto run2 = orbit::generate_observations(states, gs, 0, types, config, 42);
    auto run3 = orbit::generate_observations(states, gs, 0, types, config, 7);

    ASSERT_EQ(run1.size(), 6u);
    ASSERT_EQ(run2.size(), run1.size());
    ASSERT_EQ(run3.size(), run1.size());

    // Same seed: bit-identical noise sequence.
    for (std::size_t k = 0; k < run1.size(); ++k) {
        EXPECT_EQ(run1[k].values[0], run2[k].values[0]);
        if (run1[k].ndim == 2) {
            EXPECT_EQ(run1[k].values[1], run2[k].values[1]);
        }
    }

    // Different seed: different noise.
    bool any_diff = false;
    for (std::size_t k = 0; k < run1.size(); ++k) {
        if (run1[k].values[0] != run3[k].values[0]) {
            any_diff = true;
        }
    }
    EXPECT_TRUE(any_diff);

    // Noise stays within 5 sigma of the noise-free prediction.
    for (std::size_t k = 0; k < run1.size(); ++k) {
        const auto& obs = run1[k];
        auto truth = orbit::predict_observation(
            states[k / 2].position, states[k / 2].velocity, gs,
            states[k / 2].epoch);
        if (obs.obs_type == ObsType::RANGE) {
            EXPECT_LT(std::abs(obs.values[0] - truth.range_km),
                      5.0 * config.sigma_range_km);
        } else {
            EXPECT_LT(std::abs(obs.values[0] - truth.ra_rad),
                      5.0 * config.sigma_angles_rad[0]);
            EXPECT_LT(std::abs(obs.values[1] - truth.dec_rad),
                      5.0 * config.sigma_angles_rad[1]);
        }
    }
}

TEST(Observations, PartialsSingularGuards) {
    orbit::ODGroundStation gs = orbit::make_goldstone();

    // Satellite on the station: rho < 1e-9 km.
    double rows[12] = {0.0};
    int nrows = 0;
    const Vec3 r_sta = gs.position_eci(kJd);
    EXPECT_FALSE(orbit::measurement_partials(ObsType::RANGE, r_sta, kV, gs,
                                             kJd, rows, &nrows));

    // LOS along the ECI z axis: RA/Dec singular.
    const Vec3 r_pole = gs.position_eci(kJd) + Vec3(0.0, 0.0, 8000.0);
    EXPECT_FALSE(orbit::measurement_partials(ObsType::RA_DEC, r_pole, kV, gs,
                                             kJd, rows, &nrows));
}
