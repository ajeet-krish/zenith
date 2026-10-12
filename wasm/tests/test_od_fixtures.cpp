// Golden-master fixture-driven tests for the OD C++ core.
//
// Loads JSON fixtures exported from helio_ob (scripts/export_od_fixtures.py)
// from FIXTURES_DIR (set via target_compile_definitions in CMakeLists.txt)
// and dispatches each case by case_id to the corresponding zenith function.
// Expected values are compared element-wise with EXPECT_NEAR at the fixture
// tolerance.

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
#include "zenith/iod_gauss.hpp"
#include "zenith/kepler.hpp"
#include "zenith/matrix_ops.hpp"
#include "zenith/observations.hpp"
#include "zenith/od_batch.hpp"
#include "zenith/od_ekf.hpp"
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
        "observation_prediction",
        // Phase 2 (Gauss IOD + Herrick-Gibbs).
        "gauss_iod_leo_3sta_clean", "gauss_iod_leo_1sta_clean",
        "gauss_iod_meo_ecc_clean",  "gauss_iod_geo_1sta_clean",
        "gauss_iod_leo_noisy_seed42", "herrick_gibbs",
        // Phase 3 (batch least-squares OD).
        "batch_noise_free", "batch_noisy_seed42", "batch_outlier_editing",
        "batch_apriori", "batch_j2_truth", "batch_refines_iod",
        // Phase 4 (sequential EKF OD).
        "ekf_noise_free", "ekf_noisy_seed42", "ekf_observation_gap",
        "ekf_outlier_gate", "ekf_scheduled_maneuver",
        "ekf_maneuver_detection", "ekf_maneuver_forced_contraction",
        "ekf_divergence_recovery"};
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

// ---------------------------------------------------------------------------
// Phase 2: gauss_iod_* and herrick_gibbs dispatch
// ---------------------------------------------------------------------------

namespace {

/// Run one gauss_iod fixture case on its baked observations and compare
/// the recovered state and status against the helio export.
void run_gauss_iod_case(const std::string& case_id) {
    const json c = load_case(case_id);
    const json& inputs = c.at("inputs");
    const auto jd = inputs.at("jd").get<std::vector<double>>();
    const auto ra = inputs.at("ra_rad").get<std::vector<double>>();
    const auto dec = inputs.at("dec_rad").get<std::vector<double>>();
    const auto station_names =
        inputs.at("stations").get<std::vector<std::string>>();
    ASSERT_EQ(jd.size(), 3u);
    ASSERT_EQ(ra.size(), 3u);
    ASSERT_EQ(dec.size(), 3u);
    ASSERT_EQ(station_names.size(), 3u);

    // Station lifetimes span the gauss_iod call.
    const orbit::ODGroundStation s0 = station_from_name(station_names[0]);
    const orbit::ODGroundStation s1 = station_from_name(station_names[1]);
    const orbit::ODGroundStation s2 = station_from_name(station_names[2]);
    const orbit::ODGroundStation* sts[3] = {&s0, &s1, &s2};

    orbit::GaussIodObs obs[3];
    for (int k = 0; k < 3; ++k) {
        obs[k].time_jd = jd[k];
        obs[k].ra_rad = ra[k];
        obs[k].dec_rad = dec[k];
        obs[k].station = sts[k];
    }

    orbit::GaussIodConfig config;
    config.mu = c.at("config").at("mu").get<double>();
    config.residual_tol_rad = c.at("config").at("residual_tol_rad").get<double>();
    config.max_dc_iter = c.at("config").at("max_dc_iter").get<int>();

    const orbit::GaussIodResult res = orbit::gauss_iod(obs, config);
    const json& expected = c.at("expected");
    const json& tolerances = c.at("tolerances");

    EXPECT_EQ(static_cast<int>(res.status),
              expected.at("status").get<int>())
        << case_id << " status";
    expect_near_flat({res.r[0], res.r[1], res.r[2]}, expected.at("r"),
                     tolerances.at("r").get<double>(), false, "r");
    expect_near_flat({res.v[0], res.v[1], res.v[2]}, expected.at("v"),
                     tolerances.at("v").get<double>(), false, "v");
}

}  // namespace

TEST(ODFixtures, GaussIodLeo3StaClean) {
    run_gauss_iod_case("gauss_iod_leo_3sta_clean");
}

TEST(ODFixtures, GaussIodLeo1StaClean) {
    run_gauss_iod_case("gauss_iod_leo_1sta_clean");
}

TEST(ODFixtures, GaussIodMeoEccClean) {
    run_gauss_iod_case("gauss_iod_meo_ecc_clean");
}

TEST(ODFixtures, GaussIodGeo1StaClean) {
    run_gauss_iod_case("gauss_iod_geo_1sta_clean");
}

TEST(ODFixtures, GaussIodLeoNoisySeed42) {
    // Baked noisy RA/Dec values from the helio export (numpy RNG seed
    // 42); C++ consumes the baked angles directly.
    run_gauss_iod_case("gauss_iod_leo_noisy_seed42");
}

TEST(ODFixtures, HerrickGibbs) {
    const json c = load_case("herrick_gibbs");
    const Vec3 r1 = vec3_from_json(c.at("inputs").at("r1"));
    const Vec3 r2 = vec3_from_json(c.at("inputs").at("r2"));
    const Vec3 r3 = vec3_from_json(c.at("inputs").at("r3"));
    const double t1 = c.at("inputs").at("t1").get<double>();
    const double t2 = c.at("inputs").at("t2").get<double>();
    const double t3 = c.at("inputs").at("t3").get<double>();
    const double mu = c.at("inputs").at("mu").get<double>();

    const orbit::HerrickGibbsResult hg =
        orbit::herrick_gibbs(r1, r2, r3, t1, t2, t3, mu);
    const json& expected = c.at("expected");
    const double tol = c.at("tolerances").at("v2").get<double>();

    EXPECT_EQ(static_cast<int>(hg.status), expected.at("status").get<int>());
    expect_near_flat({hg.v[0], hg.v[1], hg.v[2]}, expected.at("v2"), tol,
                     false, "v2");
}

// ---------------------------------------------------------------------------
// Phase 3: batch_* dispatch (batch least-squares OD golden masters)
// ---------------------------------------------------------------------------

namespace {

/// BatchConfig from the fixture config dict (WASM config10 field names).
orbit::BatchConfig batch_config_from_json(const json& c) {
    orbit::BatchConfig cfg;
    cfg.force_tier = c.at("force_tier").get<int>();
    cfg.max_iter = c.at("max_iter").get<int>();
    cfg.tol_pos_km = c.at("tol_pos_km").get<double>();
    cfg.tol_vel_kms = c.at("tol_vel_kms").get<double>();
    cfg.tol_wrms_rel = c.at("tol_wrms_rel").get<double>();
    cfg.sigma_edit = c.at("sigma_edit").get<double>();
    cfg.edit_max_fraction = c.at("edit_max_fraction").get<double>();
    cfg.edit_max_rounds = c.at("edit_max_rounds").get<int>();
    cfg.enable_editing = c.at("enable_editing").get<bool>();
    return cfg;
}

/// Parse the baked flat observation table (WASM record layout).
std::vector<orbit::BatchObs> batch_obs_from_json(const json& flat) {
    const std::vector<double> buf = flat.get<std::vector<double>>();
    const orbit::BatchObsTable table =
        orbit::parse_obs_flat(buf.data(), buf.size());
    EXPECT_TRUE(table.ok) << "fixture obs table malformed";
    return table.obs;
}

/// Compare one BatchResult against the baked Helio result.
///
/// Tolerance semantics: state positions absolute (state_pos km), state
/// velocities absolute (state_vel km/s), covariance and formal sigmas
/// relative (floor 1e-12), wrms relative (floor 1e-8), reduced_chi2
/// relative in the signal regime and presence-only in the roundoff
/// regime (|expected| < 1e-6), iterations exact unless the fixture
/// grants a tolerance, edited_mask exact.
void check_batch_result(const orbit::BatchResult& res, const json& expected,
                        const json& tolerances, const std::string& label) {
    // Status: OK iff converged (all golden cases complete a solve).
    if (expected.at("converged").get<bool>()) {
        EXPECT_EQ(res.error, orbit::BatchError::OK) << label << " error";
    } else {
        EXPECT_EQ(res.error, orbit::BatchError::ERROR_NOT_CONVERGED)
            << label << " error";
    }
    EXPECT_EQ(res.converged, expected.at("converged").get<bool>())
        << label << " converged";

    // Iterations: exact, or within the per-fixture tolerance.
    const int iter_expected = expected.at("iterations").get<int>();
    const int iter_tol = tolerances.at("iterations").get<int>();
    EXPECT_NEAR(static_cast<double>(res.iterations),
                static_cast<double>(iter_expected),
                static_cast<double>(iter_tol))
        << label << " iterations";

    // State: [0..2] km atol, [3..5] km/s atol.
    const auto state = expected.at("state").get<std::vector<double>>();
    ASSERT_EQ(state.size(), 6u) << label << " state length";
    for (int i = 0; i < 3; ++i) {
        EXPECT_NEAR(res.state[static_cast<std::size_t>(i)], state[i],
                    tolerances.at("state_pos").get<double>())
            << label << " state[" << i << "]";
    }
    for (int i = 3; i < 6; ++i) {
        EXPECT_NEAR(res.state[static_cast<std::size_t>(i)], state[i],
                    tolerances.at("state_vel").get<double>())
            << label << " state[" << i << "]";
    }

    // Covariance: relative tolerance with an absolute floor (near-zero
    // cross terms would otherwise demand impossible absolute parity).
    const auto cov = expected.at("covariance").get<std::vector<double>>();
    ASSERT_EQ(cov.size(), 36u) << label << " covariance length";
    const double cov_tol = tolerances.at("covariance").get<double>();
    for (std::size_t k = 0; k < 36; ++k) {
        EXPECT_NEAR(res.cov[k], cov[k],
                    std::max(cov_tol * std::abs(cov[k]), 1e-12))
            << label << " covariance[" << k << "]";
    }

    // Formal sigmas: relative tolerance.
    const auto sigmas =
        expected.at("formal_sigmas").get<std::vector<double>>();
    ASSERT_EQ(sigmas.size(), 6u) << label << " sigmas length";
    const double sig_tol = tolerances.at("formal_sigmas").get<double>();
    for (std::size_t i = 0; i < 6; ++i) {
        EXPECT_NEAR(res.formal_sigmas[i], sigmas[i],
                    std::max(sig_tol * std::abs(sigmas[i]), 1e-15))
            << label << " formal_sigmas[" << i << "]";
    }

    // WRMS: relative tolerance with an absolute floor (noise-free arcs
    // sit at roundoff ~1e-9).
    const double wrms_expected = expected.at("wrms").get<double>();
    EXPECT_NEAR(res.wrms, wrms_expected,
                std::max(tolerances.at("wrms").get<double>() *
                             std::abs(wrms_expected),
                         1e-8))
        << label << " wrms";

    // Reduced chi-squared: null encodes Helio NaN (m_active <= 6).
    if (expected.at("reduced_chi2").is_null()) {
        EXPECT_TRUE(std::isnan(res.reduced_chi2))
            << label << " reduced_chi2 should be NaN";
    } else {
        const double rc = expected.at("reduced_chi2").get<double>();
        if (std::abs(rc) < 1e-6) {
            // Roundoff-regime value (noise-free arcs): presence and sign
            // only; the exact magnitude is implementation noise.
            EXPECT_TRUE(std::isfinite(res.reduced_chi2))
                << label << " reduced_chi2 finite";
            EXPECT_GE(res.reduced_chi2, 0.0) << label << " reduced_chi2 >= 0";
        } else {
            EXPECT_NEAR(res.reduced_chi2, rc, 1e-2 * std::abs(rc))
                << label << " reduced_chi2";
        }
    }

    // Residual table: length, edited mask (exact), edited count.
    const auto edited_mask =
        expected.at("edited_mask").get<std::vector<bool>>();
    const int n_rows = expected.at("n_rows").get<int>();
    ASSERT_EQ(res.n_rows, n_rows) << label << " n_rows";
    ASSERT_EQ(res.residuals.size(), static_cast<std::size_t>(n_rows))
        << label << " residual table length";
    for (int i = 0; i < n_rows; ++i) {
        EXPECT_EQ(res.residuals[static_cast<std::size_t>(i)].edited,
                  edited_mask[static_cast<std::size_t>(i)])
            << label << " edited_mask[" << i << "]";
    }
    EXPECT_EQ(res.edited_count, expected.at("edited_count").get<int>())
        << label << " edited_count";
}

/// Position/velocity error norms of a result state against the baked
/// truth state.
std::pair<double, double> state_errors(const orbit::BatchResult& res,
                                       const std::vector<double>& truth) {
    double pos = 0.0;
    double vel = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double dp =
            res.state[static_cast<std::size_t>(i)] - truth[static_cast<std::size_t>(i)];
        const double dv = res.state[static_cast<std::size_t>(3 + i)] -
                          truth[static_cast<std::size_t>(3 + i)];
        pos += dp * dp;
        vel += dv * dv;
    }
    return {std::sqrt(pos), std::sqrt(vel)};
}

/// Run one single-result batch fixture case (B1, B2, B3, B5) and check
/// golden parity plus the baked physics bounds from meta.
void run_batch_case(const std::string& case_id) {
    const json c = load_case(case_id);
    const json& inputs = c.at("inputs");
    const double epoch_jd = inputs.at("epoch_jd").get<double>();
    const std::vector<orbit::BatchObs> obs =
        batch_obs_from_json(inputs.at("observations"));
    const auto guess = inputs.at("state_guess").get<std::vector<double>>();
    ASSERT_EQ(guess.size(), 6u);
    const orbit::BatchConfig config = batch_config_from_json(c.at("config"));

    const orbit::BatchResult res =
        orbit::batch_od_solve(obs, guess.data(), epoch_jd, config);
    check_batch_result(res, c.at("expected"), c.at("tolerances"), case_id);

    // Physics bounds from meta (state vs baked truth).
    const auto truth = inputs.at("truth_state").get<std::vector<double>>();
    ASSERT_EQ(truth.size(), 6u);
    const auto [pos_err, vel_err] = state_errors(res, truth);
    const json& meta = c.at("meta");
    if (meta.contains("pos_err_max_km")) {
        EXPECT_LT(pos_err, meta.at("pos_err_max_km").get<double>())
            << case_id << " pos_err";
    }
    if (meta.contains("vel_err_max_kms")) {
        EXPECT_LT(vel_err, meta.at("vel_err_max_kms").get<double>())
            << case_id << " vel_err";
    }
    if (meta.contains("wrms_max")) {
        EXPECT_LT(res.wrms, meta.at("wrms_max").get<double>())
            << case_id << " wrms_max";
    }
    if (meta.contains("iterations_max")) {
        EXPECT_LE(res.iterations, meta.at("iterations_max").get<int>())
            << case_id << " iterations_max";
    }
    if (meta.contains("wrms_band")) {
        const double lo = meta.at("wrms_band").at(0).get<double>();
        const double hi = meta.at("wrms_band").at(1).get<double>();
        EXPECT_GE(res.wrms, lo) << case_id << " wrms band low";
        EXPECT_LE(res.wrms, hi) << case_id << " wrms band high";
    }
}

}  // namespace

TEST(ODFixtures, BatchNoiseFree) {
    run_batch_case("batch_noise_free");
}

TEST(ODFixtures, BatchNoisySeed42) {
    // Baked rng(42) observation values from the helio export; C++
    // consumes the baked values directly (numpy RNG not reproduced).
    run_batch_case("batch_noisy_seed42");
}

TEST(ODFixtures, BatchOutlierEditing) {
    run_batch_case("batch_outlier_editing");
}

TEST(ODFixtures, BatchJ2Truth) {
    run_batch_case("batch_j2_truth");
}

TEST(ODFixtures, BatchApriori) {
    // Sparse noisy angle arc solved with and without a tight a-priori;
    // both results are golden and the prior must pull the solution
    // toward x0 and the truth (helio test_batch_a_priori_pull).
    const json c = load_case("batch_apriori");
    const json& inputs = c.at("inputs");
    const double epoch_jd = inputs.at("epoch_jd").get<double>();
    const std::vector<orbit::BatchObs> obs =
        batch_obs_from_json(inputs.at("observations"));
    const auto guess = inputs.at("state_guess").get<std::vector<double>>();
    const auto truth = inputs.at("truth_state").get<std::vector<double>>();
    const auto x0 = inputs.at("a_priori").at("x0").get<std::vector<double>>();
    const auto p0 = inputs.at("a_priori").at("cov").get<std::vector<double>>();
    ASSERT_EQ(guess.size(), 6u);
    ASSERT_EQ(truth.size(), 6u);
    ASSERT_EQ(x0.size(), 6u);
    ASSERT_EQ(p0.size(), 36u);
    const orbit::BatchConfig config = batch_config_from_json(c.at("config"));

    orbit::APrioriState apriori;
    apriori.valid = true;
    for (std::size_t i = 0; i < 6; ++i) apriori.x0[i] = x0[i];
    for (std::size_t k = 0; k < 36; ++k) apriori.cov[k] = p0[k];

    const orbit::BatchResult with_prior =
        orbit::batch_od_solve(obs, guess.data(), epoch_jd, config, &apriori);
    const orbit::BatchResult without_prior =
        orbit::batch_od_solve(obs, guess.data(), epoch_jd, config);
    check_batch_result(with_prior, c.at("expected").at("with_prior"),
                       c.at("tolerances"), "batch_apriori/with");
    check_batch_result(without_prior, c.at("expected").at("without_prior"),
                       c.at("tolerances"), "batch_apriori/without");

    // The pull: with-prior sits closer to x0 and to the truth.
    double dist_with = 0.0;
    double dist_without = 0.0;
    double err_with = 0.0;
    double err_without = 0.0;
    for (std::size_t i = 0; i < 6; ++i) {
        const double dw = with_prior.state[i] - x0[i];
        const double dow = without_prior.state[i] - x0[i];
        const double ew = with_prior.state[i] - truth[i];
        const double eow = without_prior.state[i] - truth[i];
        dist_with += dw * dw;
        dist_without += dow * dow;
        err_with += ew * ew;
        err_without += eow * eow;
    }
    EXPECT_LT(dist_with, dist_without) << "prior pull toward x0";
    EXPECT_LT(err_with, err_without) << "prior pull toward truth";
}

TEST(ODFixtures, BatchRefinesIod) {
    // Noisy angles-only triple seeds gauss_iod (C++ re-solves from the
    // baked angles); the batch arc refines the seed with clean
    // radiometric data and must beat the IOD errors (helio
    // test_batch_refines_gauss_iod).
    const json c = load_case("batch_refines_iod");
    const json& inputs = c.at("inputs");
    const double epoch_jd = inputs.at("epoch_jd").get<double>();
    const auto truth = inputs.at("truth_state").get<std::vector<double>>();
    ASSERT_EQ(truth.size(), 6u);

    // --- Gauss IOD seed from the baked noisy angles ---
    const json& iod = inputs.at("iod");
    const auto jd3 = iod.at("jd").get<std::vector<double>>();
    const auto ra3 = iod.at("ra_rad").get<std::vector<double>>();
    const auto dec3 = iod.at("dec_rad").get<std::vector<double>>();
    const auto iod_stations =
        iod.at("stations").get<std::vector<std::string>>();
    ASSERT_EQ(jd3.size(), 3u);
    ASSERT_EQ(ra3.size(), 3u);
    ASSERT_EQ(dec3.size(), 3u);
    ASSERT_EQ(iod_stations.size(), 3u);

    const orbit::ODGroundStation s0 = station_from_name(iod_stations[0]);
    const orbit::ODGroundStation s1 = station_from_name(iod_stations[1]);
    const orbit::ODGroundStation s2 = station_from_name(iod_stations[2]);
    const orbit::ODGroundStation* sts[3] = {&s0, &s1, &s2};
    orbit::GaussIodObs iod_obs[3];
    for (int k = 0; k < 3; ++k) {
        iod_obs[k].time_jd = jd3[static_cast<std::size_t>(k)];
        iod_obs[k].ra_rad = ra3[static_cast<std::size_t>(k)];
        iod_obs[k].dec_rad = dec3[static_cast<std::size_t>(k)];
        iod_obs[k].station = sts[k];
    }
    const orbit::GaussIodResult iod_res = orbit::gauss_iod(iod_obs);
    ASSERT_EQ(iod_res.status, orbit::GaussIodError::OK);

    // IOD state golden (cross-implementation tolerance looser than the
    // batch solve: the C++ seed differs at its own fixture tolerance).
    const auto iod_state_expected =
        c.at("expected").at("iod_state").get<std::vector<double>>();
    ASSERT_EQ(iod_state_expected.size(), 6u);
    std::array<double, 6> iod_state{};
    for (int i = 0; i < 3; ++i) {
        iod_state[static_cast<std::size_t>(i)] = iod_res.r[static_cast<std::size_t>(i)];
        iod_state[static_cast<std::size_t>(3 + i)] =
            iod_res.v[static_cast<std::size_t>(i)];
        EXPECT_NEAR(iod_state[static_cast<std::size_t>(i)],
                    iod_state_expected[static_cast<std::size_t>(i)],
                    c.at("tolerances").at("iod_state_pos").get<double>())
            << "iod_state[" << i << "]";
        EXPECT_NEAR(iod_state[static_cast<std::size_t>(3 + i)],
                    iod_state_expected[static_cast<std::size_t>(3 + i)],
                    c.at("tolerances").at("iod_state_vel").get<double>())
            << "iod_state[" << (3 + i) << "]";
    }

    // --- Batch refinement seeded from the C++ IOD state ---
    const std::vector<orbit::BatchObs> obs =
        batch_obs_from_json(inputs.at("observations"));
    const orbit::BatchConfig config = batch_config_from_json(c.at("config"));
    const orbit::BatchResult res = orbit::batch_od_solve(
        obs, iod_state.data(), epoch_jd, config);
    check_batch_result(res, c.at("expected").at("batch"),
                       c.at("tolerances"), "batch_refines_iod/batch");

    // The refinement must beat the IOD seed (physics bounds).
    const auto [iod_pos_err, iod_vel_err] = [&]() {
        double pos = 0.0;
        double vel = 0.0;
        for (int i = 0; i < 3; ++i) {
            const double dp = iod_state[static_cast<std::size_t>(i)] -
                              truth[static_cast<std::size_t>(i)];
            const double dv = iod_state[static_cast<std::size_t>(3 + i)] -
                              truth[static_cast<std::size_t>(3 + i)];
            pos += dp * dp;
            vel += dv * dv;
        }
        return std::pair{std::sqrt(pos), std::sqrt(vel)};
    }();
    const auto [batch_pos_err, batch_vel_err] = state_errors(res, truth);
    EXPECT_LT(batch_pos_err, iod_pos_err) << "batch beats IOD position";
    EXPECT_LT(batch_vel_err, 0.6 * iod_vel_err) << "batch beats IOD velocity";
}

// ---------------------------------------------------------------------------
// Phase 4: ekf_* dispatch (sequential EKF OD golden masters)
// ---------------------------------------------------------------------------

namespace {

/// EKFConfig from the fixture config dict (WASM config16 field names).
orbit::EKFConfig ekf_config_from_json(const json& c) {
    orbit::EKFConfig cfg;
    cfg.process.q_a = c.at("q_a").get<double>();
    cfg.process.q_a_maneuver = c.at("q_a_maneuver").get<double>();
    cfg.maneuver.estimate_maneuver = c.at("estimate_maneuver").get<bool>();
    cfg.maneuver.nis_sigma_threshold =
        c.at("nis_sigma_threshold").get<double>();
    cfg.maneuver.consecutive_exceedances =
        c.at("consecutive_exceedances").get<int>();
    cfg.maneuver.reentry_window_obs = c.at("reentry_window_obs").get<int>();
    cfg.maneuver.scheduled_inflate_kms =
        c.at("scheduled_inflate_kms").get<double>();
    cfg.recovery.sustained_nis_count =
        c.at("sustained_nis_count").get<int>();
    cfg.recovery.inflate_factor = c.at("inflate_factor").get<double>();
    const auto p0 = c.at("p0_diag").get<std::vector<double>>();
    EXPECT_EQ(p0.size(), 6u);
    for (std::size_t i = 0; i < 6 && i < p0.size(); ++i) {
        cfg.p0_diag[i] = p0[i];
    }
    cfg.force_tier = c.at("force_tier").get<int>();
    return cfg;
}

/// Scheduled burns from the fixture list (empty / missing = none).
std::vector<orbit::ScheduledBurn> ekf_burns_from_json(const json& j) {
    std::vector<orbit::ScheduledBurn> burns;
    if (j.is_null() || j.is_array() == false) {
        return burns;
    }
    for (const auto& b : j) {
        orbit::ScheduledBurn burn;
        burn.epoch_jd = b.at("epoch_jd").get<double>();
        const auto dv = b.at("dv").get<std::vector<double>>();
        EXPECT_EQ(dv.size(), 3u);
        for (std::size_t i = 0; i < 3 && i < dv.size(); ++i) {
            burn.dv[i] = dv[i];
        }
        burns.push_back(burn);
    }
    return burns;
}

/// Position/velocity error norms of an EKF state vs truth.
std::pair<double, double> ekf_state_errors(const std::array<double, 6>& state,
                                           const std::vector<double>& truth) {
    double pos = 0.0;
    double vel = 0.0;
    for (int i = 0; i < 3; ++i) {
        const double dp =
            state[static_cast<std::size_t>(i)] - truth[static_cast<std::size_t>(i)];
        const double dv = state[static_cast<std::size_t>(3 + i)] -
                          truth[static_cast<std::size_t>(3 + i)];
        pos += dp * dp;
        vel += dv * dv;
    }
    return {std::sqrt(pos), std::sqrt(vel)};
}

/// Last stored physical state from state_hist (N x 6 row-major).
std::array<double, 6> ekf_last_state(const orbit::EKFResult& res) {
    std::array<double, 6> last{};
    for (int i = 0; i < 6; ++i) {
        last[static_cast<std::size_t>(i)] =
            res.state_hist[static_cast<std::size_t>(res.n_obs * 6 - 6 + i)];
    }
    return last;
}

/// Run one ekf_* fixture case on its baked observations and compare the
/// golden Helio result plus the baked physics bounds from meta.
void run_ekf_case(const std::string& case_id) {
    const json c = load_case(case_id);
    const json& inputs = c.at("inputs");
    const double epoch_jd = inputs.at("epoch_jd").get<double>();
    const std::vector<orbit::BatchObs> obs =
        batch_obs_from_json(inputs.at("observations"));
    const auto guess = inputs.at("state_guess").get<std::vector<double>>();
    ASSERT_EQ(guess.size(), 6u);
    const auto truth_final =
        inputs.at("truth_state_final").get<std::vector<double>>();
    ASSERT_EQ(truth_final.size(), 6u);
    const orbit::EKFConfig config = ekf_config_from_json(c.at("config"));
    std::vector<orbit::ScheduledBurn> burns;
    if (inputs.contains("scheduled_burns")) {
        burns = ekf_burns_from_json(inputs.at("scheduled_burns"));
    }

    const orbit::EKFResult res =
        orbit::ekf_solve(obs, guess.data(), epoch_jd, config, burns);
    ASSERT_EQ(res.error, orbit::EKFError::OK) << case_id << " error";

    const json& expected = c.at("expected");
    const json& tolerances = c.at("tolerances");
    const json& meta = c.at("meta");

    // Header counts: exact parity.
    EXPECT_EQ(res.n_rows, expected.at("n_rows").get<int>())
        << case_id << " n_rows";
    EXPECT_EQ(res.n_updated, expected.at("n_updated").get<int>())
        << case_id << " n_updated";
    EXPECT_EQ(res.n_gated, expected.at("n_gated").get<int>())
        << case_id << " n_gated";
    EXPECT_EQ(res.n_nis_exceed, expected.at("n_nis_exceed").get<int>())
        << case_id << " n_nis_exceed";
    EXPECT_EQ(res.n_recoveries, expected.at("n_recoveries").get<int>())
        << case_id << " n_recoveries";
    EXPECT_EQ(res.divergence_flag, expected.at("divergence_flag").get<bool>())
        << case_id << " divergence_flag";
    EXPECT_EQ(res.augmented_active_final,
              expected.at("augmented_active_final").get<bool>())
        << case_id << " augmented_active_final";

    // First detection epoch: exact (discrete event driven by NIS gates).
    std::size_t detected_at = res.maneuver_flag.size();
    for (std::size_t i = 0; i < res.maneuver_flag.size(); ++i) {
        if (res.maneuver_flag[i]) {
            detected_at = i;
            break;
        }
    }
    const int detected_epoch =
        detected_at < res.maneuver_flag.size()
            ? static_cast<int>(detected_at / 6)
            : -1;
    EXPECT_EQ(detected_epoch, expected.at("detected_epoch").get<int>())
        << case_id << " detected_epoch";

    // Final state: positions absolute km, velocities absolute km/s.
    const auto final_state = expected.at("final_state").get<std::vector<double>>();
    ASSERT_EQ(final_state.size(), 6u);
    for (int i = 0; i < 3; ++i) {
        EXPECT_NEAR(res.final_state[static_cast<std::size_t>(i)], final_state[i],
                    tolerances.at("state_pos").get<double>())
            << case_id << " final_state[" << i << "]";
    }
    for (int i = 3; i < 6; ++i) {
        EXPECT_NEAR(res.final_state[static_cast<std::size_t>(i)], final_state[i],
                    tolerances.at("state_vel").get<double>())
            << case_id << " final_state[" << i << "]";
    }

    // Final covariance diagonal and full matrix: relative tolerance.
    const auto cov_diag =
        expected.at("final_cov_diag").get<std::vector<double>>();
    ASSERT_EQ(cov_diag.size(), 6u);
    const double diag_tol = tolerances.at("final_cov_diag").get<double>();
    for (std::size_t i = 0; i < 6; ++i) {
        EXPECT_NEAR(res.final_cov_diag[i], cov_diag[i],
                    std::max(diag_tol * std::abs(cov_diag[i]), 1e-15))
            << case_id << " final_cov_diag[" << i << "]";
    }
    const auto cov = expected.at("final_cov").get<std::vector<double>>();
    ASSERT_EQ(cov.size(), 36u);
    const double cov_tol = tolerances.at("final_cov").get<double>();
    for (std::size_t k = 0; k < 36; ++k) {
        EXPECT_NEAR(res.final_cov[k], cov[k],
                    std::max(cov_tol * std::abs(cov[k]), 1e-12))
            << case_id << " final_cov[" << k << "]";
    }

    // NIS statistics: relative bands (peak statistics are more
    // sensitive to roundoff than means; bands live in tolerances).
    EXPECT_NEAR(res.nis_mean, expected.at("nis_mean").get<double>(),
                std::max(tolerances.at("nis_mean").get<double>() *
                             std::abs(expected.at("nis_mean").get<double>()),
                         1e-9))
        << case_id << " nis_mean";
    EXPECT_NEAR(res.nis_max, expected.at("nis_max").get<double>(),
                std::max(tolerances.at("nis_max").get<double>() *
                             std::abs(expected.at("nis_max").get<double>()),
                         1e-6))
        << case_id << " nis_max";

    // Maneuver records: count exact; dv within the documented
    // detection-mode observability ceiling; stamped epochs tight.
    const auto records_expected = expected.at("maneuver_records");
    ASSERT_EQ(res.maneuver_records.size(), records_expected.size())
        << case_id << " maneuver_records size";
    for (std::size_t r = 0; r < records_expected.size(); ++r) {
        EXPECT_NEAR(res.maneuver_records[r].epoch_jd,
                    records_expected[r].at("epoch_jd").get<double>(),
                    tolerances.at("epoch_jd").get<double>())
            << case_id << " record[" << r << "] epoch_jd";
        const auto dv =
            records_expected[r].at("dv").get<std::vector<double>>();
        ASSERT_EQ(dv.size(), 3u);
        for (std::size_t i = 0; i < 3; ++i) {
            EXPECT_NEAR(res.maneuver_records[r].dv[i], dv[i],
                        tolerances.at("dv").get<double>())
                << case_id << " record[" << r << "].dv[" << i << "]";
        }
    }

    // Physics bounds from meta (last stored state vs baked truth).
    const auto [pos_err, vel_err] = ekf_state_errors(ekf_last_state(res), truth_final);
    if (meta.contains("pos_err_max_km")) {
        EXPECT_LT(pos_err, meta.at("pos_err_max_km").get<double>())
            << case_id << " pos_err";
    }
    if (meta.contains("vel_err_max_kms")) {
        EXPECT_LT(vel_err, meta.at("vel_err_max_kms").get<double>())
            << case_id << " vel_err";
    }
    if (meta.contains("nis_max_gate")) {
        EXPECT_LT(res.nis_max, meta.at("nis_max_gate").get<double>())
            << case_id << " nis_max_gate";
    }
    if (meta.contains("n_gated_max")) {
        EXPECT_LE(res.n_gated, meta.at("n_gated_max").get<int>())
            << case_id << " n_gated_max";
    }
    if (meta.contains("n_recoveries_min")) {
        EXPECT_GE(res.n_recoveries, meta.at("n_recoveries_min").get<int>())
            << case_id << " n_recoveries_min";
    }
    if (meta.contains("three_sigma_containment") &&
        meta.at("three_sigma_containment").get<bool>()) {
        // |final - truth| <= 3 formal sigmas from the last sigma_hist
        // row (per-component containment, helio test_noisy_three_sigma).
        const auto last = ekf_last_state(res);
        for (int i = 0; i < 6; ++i) {
            const double sig =
                res.sigma_hist[static_cast<std::size_t>(res.n_obs * 6 - 6 + i)];
            const double err =
                last[static_cast<std::size_t>(i)] - truth_final[i];
            EXPECT_LE(std::abs(err), 3.0 * sig)
                << case_id << " three-sigma component " << i;
        }
    }
    if (meta.contains("gap_min_s")) {
        double gap = 0.0;
        for (std::size_t i = 1; i < res.obs_times.size(); ++i) {
            gap = std::max(gap,
                           (res.obs_times[i] - res.obs_times[i - 1]) * 86400.0);
        }
        EXPECT_GT(gap, meta.at("gap_min_s").get<double>())
            << case_id << " gap_min_s";
    }
    // State history finite through predict-only steps (gap coast).
    for (double v : res.state_hist) {
        ASSERT_TRUE(std::isfinite(v)) << case_id << " state_hist finite";
    }
    if (meta.contains("corrupted_rows_gated") &&
        meta.at("corrupted_rows_gated").get<bool>()) {
        // Map the baked TRUE row index to the padded per-obs slots and
        // assert the corrupted observation's components were gated.
        const int row0 = expected.at("corrupted_row0").get<int>();
        const int ndim = expected.at("corrupted_ndim").get<int>();
        int true_row = 0;
        bool checked = false;
        for (std::size_t k = 0; k < obs.size() && !checked; ++k) {
            if (true_row == row0) {
                for (int i = 0; i < ndim; ++i) {
                    const std::size_t slot = 2 * k + static_cast<std::size_t>(i);
                    EXPECT_FALSE(res.updated_mask[slot])
                        << case_id << " corrupted slot " << slot;
                    EXPECT_GT(res.nis[slot], 25.0)
                        << case_id << " corrupted nis " << slot;
                }
                checked = true;
            }
            true_row += obs[k].ndim;
        }
        EXPECT_TRUE(checked) << case_id << " corrupted_row0 not found";
    }

    // Negative control (E5/E7): rerun with the baked control config and
    // assert the failure trajectory (golden) and error bound.
    if (inputs.contains("control_config")) {
        const orbit::EKFConfig control_cfg =
            ekf_config_from_json(inputs.at("control_config"));
        const orbit::EKFResult control = orbit::ekf_solve(
            obs, guess.data(), epoch_jd, control_cfg, {});
        ASSERT_EQ(control.error, orbit::EKFError::OK)
            << case_id << " control error";
        const auto control_state =
            expected.at("control_final_state").get<std::vector<double>>();
        ASSERT_EQ(control_state.size(), 6u);
        for (int i = 0; i < 3; ++i) {
            EXPECT_NEAR(control.final_state[static_cast<std::size_t>(i)],
                        control_state[i],
                        tolerances.at("state_pos").get<double>())
                << case_id << " control final_state[" << i << "]";
        }
        for (int i = 3; i < 6; ++i) {
            EXPECT_NEAR(control.final_state[static_cast<std::size_t>(i)],
                        control_state[i],
                        tolerances.at("state_vel").get<double>())
                << case_id << " control final_state[" << i << "]";
        }
        if (meta.contains("control_pos_err_min_km")) {
            const auto [ctrl_pos_err, ctrl_vel_err] =
                ekf_state_errors(ekf_last_state(control), truth_final);
            (void)ctrl_vel_err;
            EXPECT_GT(ctrl_pos_err, meta.at("control_pos_err_min_km").get<double>())
                << case_id << " control_pos_err";
        }
    }
}

}  // namespace

TEST(ODFixtures, EkfNoiseFree) {
    run_ekf_case("ekf_noise_free");
}

TEST(ODFixtures, EkfNoisySeed42) {
    // Baked rng(42) observation values from the helio export; C++
    // consumes the baked values directly (numpy RNG not reproduced).
    run_ekf_case("ekf_noisy_seed42");
}

TEST(ODFixtures, EkfObservationGap) {
    run_ekf_case("ekf_observation_gap");
}

TEST(ODFixtures, EkfOutlierGate) {
    run_ekf_case("ekf_outlier_gate");
}

TEST(ODFixtures, EkfScheduledManeuver) {
    run_ekf_case("ekf_scheduled_maneuver");
}

TEST(ODFixtures, EkfManeuverDetection) {
    run_ekf_case("ekf_maneuver_detection");
}

TEST(ODFixtures, EkfManeuverForcedContraction) {
    run_ekf_case("ekf_maneuver_forced_contraction");
}

TEST(ODFixtures, EkfDivergenceRecovery) {
    run_ekf_case("ekf_divergence_recovery");
}
