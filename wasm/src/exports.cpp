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
// Embind Registration
// =============================================================================

EMSCRIPTEN_BINDINGS(zenith) {
    function("sgp4_init", &sgp4_init);
    function("sgp4_propagate", &sgp4_propagate);
    function("sgp4_get_elements", &sgp4_get_elements);
    function("sgp4_clear", &sgp4_clear);
    function("lambert_solve", &lambert_solve_js);
}
