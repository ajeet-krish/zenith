// Golden-master fixture-driven tests for the OD C++ core.
//
// Loads JSON fixtures exported from helio_ob (scripts/export_od_fixtures.py)
// from FIXTURES_DIR (set via target_compile_definitions in CMakeLists.txt)
// and dispatches each case by case_id to the corresponding zenith function.
// Expected values are compared element-wise with EXPECT_NEAR at the fixture
// tolerance. Future-phase case ids (batch*, ekf*) are skipped.

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "zenith/force_models.hpp"
#include "zenith/integrators.hpp"
#include "zenith/kepler.hpp"
#include "zenith/matrix_ops.hpp"
#include "zenith/observations.hpp"
#include "zenith/partials.hpp"
#include "zenith/stations.hpp"
#include "zenith/time_system.hpp"

using json = nlohmann::json;
using orbit::Vec3;

namespace {

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

json load_json_file(const std::string& path) {
    std::ifstream fh(path);
    if (!fh) {
        ADD_FAILURE() << "cannot open fixture file: " << path;
        return json{};
    }
    json j;
    fh >> j;
    return j;
}

const json& manifest() {
    static const json m = load_json_file(std::string(FIXTURES_DIR) + "/index.json");
    return m;
}

/// Load one case by id from the manifest (fails the test if missing).
json load_case(const std::string& case_id) {
    for (const auto& entry : manifest().at("cases")) {
        if (entry.at("case_id").get<std::string>() == case_id) {
            return load_json_file(std::string(FIXTURES_DIR) + "/" +
                                  entry.at("file").get<std::string>());
        }
    }
    ADD_FAILURE() << "case not found in manifest: " << case_id;
    return json{};
}

/// Future-phase ids (batch/EKF) are tolerated but not dispatched yet.
bool is_future_case(const std::string& case_id) {
    return case_id.rfind("batch", 0) == 0 || case_id.rfind("ekf", 0) == 0;
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

Vec3 vec3_from_json(const json& j) {
    return Vec3(j.at(0).get<double>(), j.at(1).get<double>(),
                j.at(2).get<double>());
}

/// Element-wise EXPECT_NEAR over a flat array; tol is absolute, or relative
/// to |expected| when relative is true.
void expect_near_flat(const std::vector<double>& actual, const json& expected,
                      double tol, bool relative, const std::string& label) {
    ASSERT_EQ(actual.size(), expected.size()) << label << " length";
    for (std::size_t i = 0; i < actual.size(); ++i) {
        const double e = expected.at(i).get<double>();
        const double t = relative ? tol * std::max(1.0, std::abs(e)) : tol;
        EXPECT_NEAR(actual[i], e, t) << label << "[" << i << "]";
    }
}

/// Canonical station lookup with validation.
orbit::ODGroundStation station_from_name(const std::string& name) {
    EXPECT_TRUE(orbit::has_canonical_station(name)) << "unknown station " << name;
    return orbit::canonical_station(name);
}

}  // namespace

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

TEST(ODFixtures, ManifestListsPhaseOneCases) {
    ASSERT_EQ(manifest().at("schema_version").get<int>(), 1);
    const json& cases = manifest().at("cases");
    ASSERT_FALSE(cases.empty());

    const std::vector<std::string> required = {
        "kepler_solver",     "j2_stm_propagation", "force_jacobians",
        "measurement_partials", "station_ecef",    "gmst",
        "observation_prediction"};
    for (const auto& id : required) {
        bool found = false;
        for (const auto& entry : cases) {
            if (entry.at("case_id").get<std::string>() == id) found = true;
        }
        EXPECT_TRUE(found) << "manifest missing required case " << id;
    }

    // Every manifest file must exist and parse.
    for (const auto& entry : cases) {
        const std::string id = entry.at("case_id").get<std::string>();
        if (is_future_case(id)) continue;
        const json c = load_case(id);
        EXPECT_EQ(c.at("case_id").get<std::string>(), id);
        EXPECT_EQ(c.at("schema_version").get<int>(), 1);
    }
}

// ---------------------------------------------------------------------------
// 1. kepler_solver
// ---------------------------------------------------------------------------

TEST(ODFixtures, KeplerSolver) {
    const json c = load_case("kepler_solver");
    const double M = c.at("inputs").at("M").get<double>();
    const double e = c.at("inputs").at("e").get<double>();
    const double tol = c.at("config").at("tol").get<double>();

    const double E = orbit::solve_kepler(M, e, tol);
    EXPECT_NEAR(E, c.at("expected").at("E").get<double>(),
                c.at("tolerances").at("E").get<double>());
}

// ---------------------------------------------------------------------------
// 2. j2_stm_propagation
// ---------------------------------------------------------------------------

TEST(ODFixtures, J2StmPropagation) {
    const json c = load_case("j2_stm_propagation");
    const auto state6 =
        c.at("inputs").at("state6").get<std::vector<double>>();
    ASSERT_EQ(state6.size(), 6u);

    // Augmented initial state y = [r, v, Phi] with Phi = identity.
    std::array<double, 42> y0{};
    std::copy(state6.begin(), state6.end(), y0.begin());
    for (int i = 0; i < 6; ++i) {
        y0[6 + i * 6 + i] = 1.0;
    }

    const double t0 = c.at("inputs").at("t0").get<double>();
    const double t1 = c.at("inputs").at("t1").get<double>();
    const int tier = c.at("config").at("force_tier").get<int>();
    const double rtol = c.at("config").at("rtol").get<double>();
    const double atol = c.at("config").at("atol").get<double>();

    const orbit::STMResult res = orbit::propagate_with_stm(y0, t0, t1, rtol,
                                                           atol, tier);
    ASSERT_TRUE(res.success);

    const json& expected = c.at("expected");
    const json& tolerances = c.at("tolerances");

    expect_near_flat({res.position.x, res.position.y, res.position.z},
                     expected.at("r"), tolerances.at("r").get<double>(), false,
                     "r");
    expect_near_flat({res.velocity.x, res.velocity.y, res.velocity.z},
                     expected.at("v"), tolerances.at("v").get<double>(), false,
                     "v");
    // STM tolerance is relative (see fixture meta note).
    const std::vector<double> stm(res.stm.begin(), res.stm.end());
    expect_near_flat(stm, expected.at("stm"), tolerances.at("stm").get<double>(),
                     true, "stm");
}

// ---------------------------------------------------------------------------
// 3. force_jacobians
// ---------------------------------------------------------------------------

TEST(ODFixtures, ForceJacobians) {
    const json c = load_case("force_jacobians");
    const Vec3 r = vec3_from_json(c.at("inputs").at("r"));

    const auto [accel, jac] = orbit::j2_accel_and_jacobian(r);
    const json& expected = c.at("expected");
    const double tol = c.at("tolerances").at("jac").get<double>();  // rel

    expect_near_flat({accel.x, accel.y, accel.z}, expected.at("accel"), tol,
                     true, "accel");
    const std::array<double, 9> jac_flat = orbit::mat3_from_mat(jac);
    expect_near_flat(std::vector<double>(jac_flat.begin(), jac_flat.end()),
                     expected.at("jac"), tol, true, "jac");
}

// ---------------------------------------------------------------------------
// 4. measurement_partials
// ---------------------------------------------------------------------------

TEST(ODFixtures, MeasurementPartials) {
    const json c = load_case("measurement_partials");
    const Vec3 r = vec3_from_json(c.at("inputs").at("r"));
    const Vec3 v = vec3_from_json(c.at("inputs").at("v"));
    const std::string station_name = c.at("inputs").at("station").get<std::string>();
    const double jd = c.at("inputs").at("jd").get<double>();
    const orbit::ODGroundStation station = station_from_name(station_name);

    const json& expected = c.at("expected");
    const json& tolerances = c.at("tolerances");

    // Predicted components at the same geometry.
    const orbit::PredictedComponents pred =
        orbit::predict_observation(r, v, station, jd);
    EXPECT_NEAR(pred.range_km, expected.at("range_km").get<double>(),
                tolerances.at("range_km").get<double>());
    EXPECT_NEAR(pred.range_rate_kms, expected.at("range_rate_kms").get<double>(),
                tolerances.at("range_rate_kms").get<double>());
    EXPECT_NEAR(pred.ra_rad, expected.at("ra_rad").get<double>(),
                tolerances.at("ra_rad").get<double>());
    EXPECT_NEAR(pred.dec_rad, expected.at("dec_rad").get<double>(),
                tolerances.at("dec_rad").get<double>());

    // RANGE partials (1 row).
    double rows[12] = {0.0};
    int nrows = 0;
    ASSERT_TRUE(orbit::measurement_partials(orbit::ObsType::RANGE, r, v,
                                            station, jd, rows, &nrows));
    ASSERT_EQ(nrows, 1);
    expect_near_flat(std::vector<double>(rows, rows + 6), expected.at("range_h"),
                     tolerances.at("range_h").get<double>(), false, "range_h");

    // RANGE_RATE partials (1 row).
    ASSERT_TRUE(orbit::measurement_partials(orbit::ObsType::RANGE_RATE, r, v,
                                            station, jd, rows, &nrows));
    ASSERT_EQ(nrows, 1);
    expect_near_flat(std::vector<double>(rows, rows + 6),
                     expected.at("range_rate_h"),
                     tolerances.at("range_rate_h").get<double>(), false,
                     "range_rate_h");

    // RA_DEC partials (2 rows).
    ASSERT_TRUE(orbit::measurement_partials(orbit::ObsType::RA_DEC, r, v,
                                            station, jd, rows, &nrows));
    ASSERT_EQ(nrows, 2);
    expect_near_flat(std::vector<double>(rows, rows + 6), expected.at("ra_h"),
                     tolerances.at("ra_h").get<double>(), false, "ra_h");
    expect_near_flat(std::vector<double>(rows + 6, rows + 12),
                     expected.at("dec_h"), tolerances.at("dec_h").get<double>(),
                     false, "dec_h");
}

// ---------------------------------------------------------------------------
// 5. station_ecef
// ---------------------------------------------------------------------------

TEST(ODFixtures, StationEcef) {
    const json c = load_case("station_ecef");
    for (const std::string& name : {"goldstone", "arecibo", "tromsoe"}) {
        const orbit::ODGroundStation station = station_from_name(name);
        const Vec3 ecef = station.position_ecef;
        const json& expected = c.at("expected").at(name + "_ecef");
        const double tol = c.at("tolerances").at(name + "_ecef").get<double>();
        expect_near_flat({ecef.x, ecef.y, ecef.z}, expected, tol, false,
                         name + "_ecef");
    }
}

// ---------------------------------------------------------------------------
// 6. gmst
// ---------------------------------------------------------------------------

TEST(ODFixtures, Gmst) {
    const json c = load_case("gmst");
    const auto jds = c.at("inputs").at("jds").get<std::vector<double>>();
    ASSERT_EQ(jds.size(), 2u);

    EXPECT_NEAR(orbit::jd_to_gmst(jds[0]),
                c.at("expected").at("gmst_j2000").get<double>(),
                c.at("tolerances").at("gmst_j2000").get<double>());
    EXPECT_NEAR(orbit::jd_to_gmst(jds[1]),
                c.at("expected").at("gmst_j2000_half").get<double>(),
                c.at("tolerances").at("gmst_j2000_half").get<double>());
}

// ---------------------------------------------------------------------------
// 7. observation_prediction
// ---------------------------------------------------------------------------

TEST(ODFixtures, ObservationPrediction) {
    const json c = load_case("observation_prediction");
    const Vec3 r = vec3_from_json(c.at("inputs").at("r"));
    const Vec3 v = vec3_from_json(c.at("inputs").at("v"));
    const std::string station_name = c.at("inputs").at("station").get<std::string>();
    const double jd = c.at("inputs").at("jd").get<double>();
    const orbit::ODGroundStation station = station_from_name(station_name);

    const orbit::PredictedComponents pred =
        orbit::predict_observation(r, v, station, jd);
    const json& expected = c.at("expected");
    const json& tolerances = c.at("tolerances");

    EXPECT_NEAR(pred.range_km, expected.at("range_km").get<double>(),
                tolerances.at("range_km").get<double>());
    EXPECT_NEAR(pred.range_rate_kms, expected.at("range_rate_kms").get<double>(),
                tolerances.at("range_rate_kms").get<double>());
    EXPECT_NEAR(pred.ra_rad, expected.at("ra_rad").get<double>(),
                tolerances.at("ra_rad").get<double>());
    EXPECT_NEAR(pred.dec_rad, expected.at("dec_rad").get<double>(),
                tolerances.at("dec_rad").get<double>());
    EXPECT_NEAR(pred.az_rad, expected.at("az_rad").get<double>(),
                tolerances.at("az_rad").get<double>());
    EXPECT_NEAR(pred.el_rad, expected.at("el_rad").get<double>(),
                tolerances.at("el_rad").get<double>());
}
