// Native tests for zenith/stations.hpp (ODGroundStation) and the frame
// fixes it depends on: known Goldstone ECEF/ECI values (cross-checked
// against helio_ob), Earth-rotation velocity magnitude, elevation
// sanity, SEZ round trips, GMST, and the TEME<->ECEF velocity sign fix.

#include <gtest/gtest.h>

#include <cmath>

#include "zenith/coordinate_frames.hpp"
#include "zenith/stations.hpp"
#include "zenith/time_system.hpp"

using orbit::Vec3;

namespace {

// Cross-check epoch: 2026-10-11T00:00:00 UTC = JD 2501911.5.
constexpr double kJd = 2501911.5;

}  // namespace

TEST(Stations, GoldstoneEcefKnownValue) {
    orbit::ODGroundStation gs = orbit::make_goldstone();
    EXPECT_EQ(gs.name, "goldstone");

    // lla_to_ecef(35.4N, 116.8W, 1.0 km) on WGS-84 (helio cross-check).
    EXPECT_NEAR(gs.position_ecef.x, -2347.115755483799, 1e-9);
    EXPECT_NEAR(gs.position_ecef.y, -4646.499433985879, 1e-9);
    EXPECT_NEAR(gs.position_ecef.z, 3674.709124786819, 1e-9);
}

TEST(Stations, CanonicalStationsHelioValues) {
    orbit::ODGroundStation gs = orbit::make_goldstone();
    EXPECT_NEAR(gs.lat_rad, 35.4 * orbit::DEG_TO_RAD, 1e-15);
    EXPECT_NEAR(gs.lon_rad, -116.8 * orbit::DEG_TO_RAD, 1e-15);
    EXPECT_DOUBLE_EQ(gs.alt_km, 1.0);

    orbit::ODGroundStation ar = orbit::make_arecibo();
    EXPECT_EQ(ar.name, "arecibo");
    EXPECT_NEAR(ar.lat_rad, 18.3 * orbit::DEG_TO_RAD, 1e-15);
    EXPECT_NEAR(ar.lon_rad, -66.75 * orbit::DEG_TO_RAD, 1e-15);
    EXPECT_DOUBLE_EQ(ar.alt_km, 0.4);
    EXPECT_NEAR(ar.position_ecef.x, 2391.336526321806, 1e-9);
    EXPECT_NEAR(ar.position_ecef.y, -5565.986513425679, 1e-9);
    EXPECT_NEAR(ar.position_ecef.z, 1990.062545912089, 1e-9);

    orbit::ODGroundStation tr = orbit::make_tromsoe();
    EXPECT_EQ(tr.name, "tromsoe");
    EXPECT_NEAR(tr.lat_rad, 69.6 * orbit::DEG_TO_RAD, 1e-15);
    EXPECT_NEAR(tr.lon_rad, 18.9 * orbit::DEG_TO_RAD, 1e-15);
    EXPECT_DOUBLE_EQ(tr.alt_km, 0.1);
    EXPECT_NEAR(tr.position_ecef.x, 2109.620433768311, 1e-9);
    EXPECT_NEAR(tr.position_ecef.y, 722.284514719832, 1e-9);
    EXPECT_NEAR(tr.position_ecef.z, 5955.725252345503, 1e-9);

    EXPECT_TRUE(orbit::has_canonical_station("goldstone"));
    EXPECT_TRUE(orbit::has_canonical_station("arecibo"));
    EXPECT_TRUE(orbit::has_canonical_station("tromsoe"));
    EXPECT_FALSE(orbit::has_canonical_station("kourou"));
}

TEST(Stations, GmstSecondsForm) {
    // helio_ob jd_to_gmst(2501911.5) = 1.118222504078439 rad.
    EXPECT_NEAR(orbit::jd_to_gmst(kJd), 1.118222504078439, 1e-12);
    // Wrapper keeps existing callers on the same value.
    EXPECT_DOUBLE_EQ(orbit::ut1_to_gmst(kJd), orbit::jd_to_gmst(kJd));
}

TEST(Stations, GoldstoneEciPositionAndVelocity) {
    orbit::ODGroundStation gs = orbit::make_goldstone();

    // helio_ob position_eci (GMST-only rotation).
    Vec3 r_eci = gs.position_eci(kJd);
    EXPECT_NEAR(r_eci.x, 3152.360504906787, 1e-9);
    EXPECT_NEAR(r_eci.y, -4142.648018692295, 1e-9);
    EXPECT_NEAR(r_eci.z, 3674.709124786819, 1e-9);

    // helio_ob velocity_eci: omega x r_ecef rotated into ECI.
    Vec3 v_eci = gs.velocity_eci(kJd);
    EXPECT_NEAR(v_eci.x, 0.3020866636455, 1e-12);
    EXPECT_NEAR(v_eci.y, 0.2298737578569, 1e-12);
    EXPECT_NEAR(v_eci.z, 0.0, 1e-15);

    // Magnitude equals omega * p, p = distance from the spin axis.
    const double p = std::hypot(gs.position_ecef.x, gs.position_ecef.y);
    EXPECT_NEAR(v_eci.magnitude(), orbit::OMEGA_EARTH * p, 1e-12);
}

TEST(Stations, ElevationSanity) {
    orbit::ODGroundStation gs = orbit::make_goldstone();

    // Target 500 km along the local zenith: elevation = pi/2.
    const Vec3 up_ecef = gs.position_ecef +
                         orbit::sez_to_ecef(Vec3(0.0, 0.0, 500.0),
                                            gs.lat_rad, gs.lon_rad);
    const Vec3 overhead_eci = orbit::ecef_to_teme(up_ecef, kJd);
    EXPECT_NEAR(gs.elevation_of(overhead_eci, kJd), orbit::PI / 2.0, 1e-9);

    // Target under the opposite side of the Earth: elevation negative.
    const Vec3 below_ecef = -gs.position_ecef;
    const Vec3 below_eci = orbit::ecef_to_teme(below_ecef, kJd);
    EXPECT_LT(gs.elevation_of(below_eci, kJd), 0.0);

    // A LEO satellite at the recorded helio geometry has elevation below
    // the horizon (-0.396 rad), matching the observation-model check.
    const Vec3 r_sat_eci(6781.0, 1000.0, 2000.0);
    EXPECT_NEAR(gs.elevation_of(r_sat_eci, kJd), -0.3964416688045, 1e-9);
}

TEST(Stations, SezRoundTrip) {
    const double lat = 35.4 * orbit::DEG_TO_RAD;
    const double lon = -116.8 * orbit::DEG_TO_RAD;
    const Vec3 r_ecef(-2347.1, -4646.5, 3674.7);

    const Vec3 sez = orbit::ecef_to_sez(r_ecef, lat, lon);
    const Vec3 back = orbit::sez_to_ecef(sez, lat, lon);
    EXPECT_NEAR((back - r_ecef).magnitude(), 0.0, 1e-9);

    // Zenith axis check: the SEZ z-axis is the WGS-84 geodetic surface
    // normal (cos(lat)cos(lon), cos(lat)sin(lon), sin(lat)).
    const Vec3 zenith_dir = orbit::sez_to_ecef(Vec3(0.0, 0.0, 1.0), lat, lon);
    EXPECT_NEAR(zenith_dir.x, std::cos(lat) * std::cos(lon), 1e-12);
    EXPECT_NEAR(zenith_dir.y, std::cos(lat) * std::sin(lon), 1e-12);
    EXPECT_NEAR(zenith_dir.z, std::sin(lat), 1e-12);
    const Vec3 sez_zenith = orbit::ecef_to_sez(zenith_dir, lat, lon);
    EXPECT_NEAR(sez_zenith.x, 0.0, 1e-12);
    EXPECT_NEAR(sez_zenith.y, 0.0, 1e-12);
    EXPECT_NEAR(sez_zenith.z, 1.0, 1e-12);
}

TEST(Stations, TemeEcefVelocitySignFix) {
    // Regression for the omega-cross-r sign bug: a geostationary ECI state
    // (r on the equator, v = omega x r) must map to zero ECEF velocity
    // with the corrected transform.
    const double r_geo = 42164.0;
    const Vec3 r_teme(r_geo, 0.0, 0.0);
    const Vec3 v_teme(0.0, orbit::OMEGA_EARTH * r_geo, 0.0);

    auto [r_ecef, v_ecef] = orbit::teme_to_ecef(r_teme, v_teme, kJd);
    EXPECT_LT(v_ecef.magnitude(), 1e-12);

    // And the inverse recovers the ECI state exactly.
    auto [r_back, v_back] = orbit::ecef_to_teme(r_ecef, v_ecef, kJd);
    EXPECT_NEAR((r_back - r_teme).magnitude(), 0.0, 1e-9);
    EXPECT_NEAR((v_back - v_teme).magnitude(), 0.0, 1e-12);

    // Round trip of an arbitrary state.
    const Vec3 r2(7000.0, 1000.0, 2000.0);
    const Vec3 v2(1.0, 7.0, 2.0);
    auto [re2, ve2] = orbit::teme_to_ecef(r2, v2, kJd);
    auto [rb2, vb2] = orbit::ecef_to_teme(re2, ve2, kJd);
    EXPECT_NEAR((rb2 - r2).magnitude(), 0.0, 1e-9);
    EXPECT_NEAR((vb2 - v2).magnitude(), 0.0, 1e-12);
}

TEST(Stations, EcefToLlaRoundTrip) {
    orbit::ODGroundStation gs = orbit::make_tromsoe();
    orbit::LLA lla = orbit::ecef_to_lla(gs.position_ecef);
    EXPECT_NEAR(lla.lat, gs.lat_rad, 1e-10);
    EXPECT_NEAR(lla.lon, gs.lon_rad, 1e-10);
    EXPECT_NEAR(lla.alt, gs.alt_km, 1e-9);

    // Wrapper keeps teme_to_lla consistent.
    const Vec3 r_teme = orbit::ecef_to_teme(gs.position_ecef, kJd);
    orbit::LLA lla_teme = orbit::teme_to_lla(r_teme, kJd);
    EXPECT_NEAR(lla_teme.lat, gs.lat_rad, 1e-10);
    EXPECT_NEAR(lla_teme.alt, gs.alt_km, 1e-9);
}
