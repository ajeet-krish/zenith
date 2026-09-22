// =============================================================================
// Zenith WASM Bindings
// =============================================================================
// Embind bindings exposing Zenith's SGP4 propagator and Lambert solver
// to JavaScript via Emscripten embind.
//
// API:
//   sgp4_init(line1, line2)           -> handle (int, 0 = error)
//   sgp4_propagate(handle, jd)        -> {x, y, z, vx, vy, vz} or null
//   sgp4_get_elements(handle, jd)     -> {a, e, i, raan, argp, ta} or null
//   lambert_solve(r1x,r1y,r1z,
//                 r2x,r2y,r2z,
//                 dt, mu)             -> {v1x, v1y, v1z, v2x, v2y, v2z, converged}
//   sgp4_clear()                      -> void
// =============================================================================

#include <algorithm>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <map>
#include <string>

#include "zenith/orbit_types.hpp"
#include "zenith/time_system.hpp"
#include "zenith/coordinate_frames.hpp"
#include "zenith/kepler.hpp"
#include "zenith/sgp4_parser.hpp"
#include "zenith/sgp4_propagator.hpp"
#include "zenith/maneuver.hpp"
#include "zenith/force_models.hpp"
#include "zenith/ground_track.hpp"
#include "zenith/monte_carlo.hpp"
#include "zenith/coverage.hpp"

using namespace emscripten;

// =============================================================================
// Satellite Handle Store
// =============================================================================

/// Map from handle ID to initialized SGP4Propagator.
/// Handles are 1-indexed; 0 means "invalid/failed".
static std::map<int, orbit::SGP4Propagator> g_propagators;
static int g_next_handle = 1;

// =============================================================================
// SGP4 Functions
// =============================================================================

/// Parse a TLE pair and initialize an SGP4Propagator.
///
/// @param line1  TLE line 1 (69 chars).
/// @param line2  TLE line 2 (69 chars).
/// @return Satellite handle (>= 1) on success, 0 on parse failure.
int sgp4_init(const std::string& line1, const std::string& line2) {
    orbit::TLEData tle = orbit::parse_tle(line1, line2);
    if (tle.norad_id <= 0) {
        return 0;
    }

    int handle = g_next_handle++;
    g_propagators[handle].init(tle);
    return handle;
}

/// Propagate a satellite to a given Julian Date.
///
/// @param handle  Satellite handle from sgp4_init().
/// @param jd      Target epoch as Julian Date (UTC).
/// @return JS object {x, y, z, vx, vy, vz} in TEME frame [km, km/s], or null.
val sgp4_propagate(int handle, double jd) {
    auto it = g_propagators.find(handle);
    if (it == g_propagators.end()) {
        return val::null();
    }

    orbit::StateVector sv = it->second.propagate(jd);

    val result = val::object();
    result.set("x", sv.position.x);
    result.set("y", sv.position.y);
    result.set("z", sv.position.z);
    result.set("vx", sv.velocity.x);
    result.set("vy", sv.velocity.y);
    result.set("vz", sv.velocity.z);
    return result;
}

/// Get Keplerian elements at a given Julian Date.
///
/// @param handle  Satellite handle from sgp4_init().
/// @param jd      Target epoch as Julian Date.
/// @return JS object {a, e, i, raan, argp, ta} or null.
val sgp4_get_elements(int handle, double jd) {
    auto it = g_propagators.find(handle);
    if (it == g_propagators.end()) {
        return val::null();
    }

    orbit::KeplerianElements elem = it->second.get_elements(jd);

    val result = val::object();
    result.set("a", elem.a);
    result.set("e", elem.e);
    result.set("i", elem.i);
    result.set("raan", elem.raan);
    result.set("argp", elem.argp);
    result.set("ta", elem.ta);
    return result;
}

/// Clear all stored propagator handles.
void sgp4_clear() {
    g_propagators.clear();
    g_next_handle = 1;
}

// =============================================================================
// Lambert Solver
// =============================================================================

/// Solve Lambert's problem given scalar position components.
///
/// @param r1x, r1y, r1z  Departure position [km].
/// @param r2x, r2y, r2z  Arrival position [km].
/// @param dt              Time of flight [seconds].
/// @param mu              Gravitational parameter [km^3/s^2].
/// @return JS object {v1x, v1y, v1z, v2x, v2y, v2z, converged}.
val lambert_solve_js(double r1x, double r1y, double r1z,
                     double r2x, double r2y, double r2z,
                     double dt, double mu) {
    orbit::Vec3 r1(r1x, r1y, r1z);
    orbit::Vec3 r2(r2x, r2y, r2z);

    orbit::LambertResult lr = orbit::lambert_solve(r1, r2, dt, mu);

    val result = val::object();
    result.set("v1x", lr.v1.x);
    result.set("v1y", lr.v1.y);
    result.set("v1z", lr.v1.z);
    result.set("v2x", lr.v2.x);
    result.set("v2y", lr.v2.y);
    result.set("v2z", lr.v2.z);
    result.set("converged", lr.converged);
    return result;
}

// =============================================================================
// Maneuver Planning
// =============================================================================

/// Compute Hohmann transfer from altitudes above Earth.
val hohmann_from_altitudes_js(double alt1_km, double alt2_km) {
    orbit::HohmannResult hr = orbit::hohmann_from_altitudes(alt1_km, alt2_km);
    
    val result = val::object();
    result.set("dv1", hr.dv1);
    result.set("dv2", hr.dv2);
    result.set("dv_total", hr.dv_total);
    result.set("transfer_time_s", hr.transfer_time_s);
    result.set("a_transfer", hr.a_transfer);
    return result;
}

/// Compute bi-elliptic transfer.
val bielliptic_transfer_js(double r1_km, double r2_km, double r_intermediate_km) {
    orbit::HohmannResult hr = orbit::bielliptic_transfer(r1_km, r2_km, r_intermediate_km);
    
    val result = val::object();
    result.set("dv1", hr.dv1);
    result.set("dv2", hr.dv2);
    result.set("dv_total", hr.dv_total);
    result.set("transfer_time_s", hr.transfer_time_s);
    result.set("a_transfer", hr.a_transfer);
    return result;
}

// =============================================================================
// Ground Track
// =============================================================================

/// Compute ground track from flat trajectory array.
/// Input: flat array [x1,y1,z1,jd1, x2,y2,z2,jd2, ...]
/// Output: flat array [lat1,lon1,alt1, lat2,lon2,alt2, ...]
val compute_ground_track_js(val flat_trajectory) {
    // Parse flat array into StateVectors
    int len = flat_trajectory["length"].as<int>();
    int n = len / 7; // 7 doubles per state: x,y,z,vx,vy,vz,jd
    
    std::vector<orbit::StateVector> trajectory;
    trajectory.reserve(n);
    
    for (int i = 0; i < n; ++i) {
        orbit::StateVector sv;
        sv.position.x = flat_trajectory[i * 7 + 0].as<double>();
        sv.position.y = flat_trajectory[i * 7 + 1].as<double>();
        sv.position.z = flat_trajectory[i * 7 + 2].as<double>();
        sv.velocity.x = flat_trajectory[i * 7 + 3].as<double>();
        sv.velocity.y = flat_trajectory[i * 7 + 4].as<double>();
        sv.velocity.z = flat_trajectory[i * 7 + 5].as<double>();
        sv.epoch = flat_trajectory[i * 7 + 6].as<double>();
        trajectory.push_back(sv);
    }
    
    std::vector<orbit::GroundTrackPoint> track = orbit::compute_ground_track(trajectory);
    
    // Return as flat array [lat,lon,alt,jd, ...]
    val result = val::array();
    for (const auto& pt : track) {
        result.call<void>("push", pt.latitude_rad);
        result.call<void>("push", pt.longitude_rad);
        result.call<void>("push", pt.altitude_km);
        result.call<void>("push", pt.jd_utc);
    }
    return result;
}

// =============================================================================
// Monte Carlo
// =============================================================================

/// Run Monte Carlo propagation.
val mc_propagate_js(double px, double py, double pz,
                    double vx, double vy, double vz,
                    double epoch_jd,
                    int n_samples, double end_time_days,
                    double pos_stddev, double vel_stddev,
                    uint64_t seed) {
    // Clamp to prevent unbounded memory allocation
    constexpr int MAX_SAMPLES = 10000;
    n_samples = std::clamp(n_samples, 1, MAX_SAMPLES);

    orbit::MonteCarloConfig config;
    config.n_samples = n_samples;
    config.end_time_days = end_time_days;
    config.position_stddev_km = pos_stddev;
    config.velocity_stddev_km_s = vel_stddev;
    config.seed = seed;
    
    orbit::StateVector nominal;
    nominal.position = orbit::Vec3(px, py, pz);
    nominal.velocity = orbit::Vec3(vx, vy, vz);
    nominal.epoch = epoch_jd;
    
    orbit::MonteCarloResult mc_result = orbit::monte_carlo_propagate(nominal, config);
    
    val result = val::object();
    
    // Mean state
    val mean = val::object();
    mean.set("x", mc_result.mean_state.position.x);
    mean.set("y", mc_result.mean_state.position.y);
    mean.set("z", mc_result.mean_state.position.z);
    mean.set("vx", mc_result.mean_state.velocity.x);
    mean.set("vy", mc_result.mean_state.velocity.y);
    mean.set("vz", mc_result.mean_state.velocity.z);
    result.set("mean", mean);
    
    // Position stddev
    val pos_std = val::array();
    for (double s : mc_result.position_stddev) {
        pos_std.call<void>("push", s);
    }
    result.set("positionStddev", pos_std);
    
    // Velocity stddev
    val vel_std = val::array();
    for (double s : mc_result.velocity_stddev) {
        vel_std.call<void>("push", s);
    }
    result.set("velocityStddev", vel_std);
    
    // Samples (only positions for visualization, to keep data size manageable)
    val samples = val::array();
    for (const auto& sv : mc_result.samples) {
        val s = val::object();
        s.set("x", sv.position.x);
        s.set("y", sv.position.y);
        s.set("z", sv.position.z);
        samples.call<void>("push", s);
    }
    result.set("samples", samples);
    
    return result;
}

// =============================================================================
// Coverage / Walker Constellation
// =============================================================================

/// Generate Walker Delta constellation states.
val generate_walker_js(double inc_rad, int total_sats, int num_planes,
                       int phasing, double alt_km, double jd_epoch) {
    orbit::WalkerDelta walker;
    walker.inclination_rad = inc_rad;
    walker.total_sats = total_sats;
    walker.num_planes = num_planes;
    walker.phasing_factor = phasing;
    walker.altitude_km = alt_km;
    
    std::vector<orbit::StateVector> states = orbit::generate_walker(walker, jd_epoch);
    
    val result = val::array();
    for (const auto& sv : states) {
        val s = val::object();
        s.set("x", sv.position.x);
        s.set("y", sv.position.y);
        s.set("z", sv.position.z);
        s.set("vx", sv.velocity.x);
        s.set("vy", sv.velocity.y);
        s.set("vz", sv.velocity.z);
        s.set("jd", sv.epoch);
        result.call<void>("push", s);
    }
    return result;
}

// =============================================================================
// Embind Registration
// =============================================================================

EMSCRIPTEN_BINDINGS(zenith) {
    function("sgp4_init", &sgp4_init);
    function("sgp4_propagate", &sgp4_propagate);
    function("sgp4_get_elements", &sgp4_get_elements);
    function("sgp4_clear", &sgp4_clear);
    function("lambert_solve", &lambert_solve_js);
    function("hohmann_from_altitudes", &hohmann_from_altitudes_js);
    function("bielliptic_transfer", &bielliptic_transfer_js);
    function("compute_ground_track", &compute_ground_track_js);
    function("mc_propagate", &mc_propagate_js);
    function("generate_walker", &generate_walker_js);
}
