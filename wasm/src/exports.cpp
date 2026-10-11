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
#include <array>
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
#include "zenith/pass_predictor.hpp"
#include "zenith/conjunction.hpp"
#include "zenith/integrators.hpp"
#include "zenith/stations.hpp"
#include "zenith/observations.hpp"
#include "zenith/partials.hpp"
#include "zenith/iod_gauss.hpp"
#include "zenith/od_batch.hpp"

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

/// Destroy a single propagator handle.
void sgp4_destroy(int handle) {
    g_propagators.erase(handle);
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
// Pass Predictor
// =============================================================================

/// Predict satellite passes over a ground station.
/// Input: flat trajectory array [x1,y1,z1,vx1,vy1,vz1,jd1, ...]
/// and station parameters.
val predict_passes_js(val flat_trajectory,
                     double station_lat_rad, double station_lon_rad,
                     double station_alt_km, double elevation_mask_rad) {
    int len = flat_trajectory["length"].as<int>();
    int n = len / 7;
    
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
    
    orbit::GroundStation station;
    station.latitude_rad = station_lat_rad;
    station.longitude_rad = station_lon_rad;
    station.altitude_km = station_alt_km;
    station.elevation_mask_rad = elevation_mask_rad;
    
    std::vector<orbit::PassInfo> passes = orbit::predict_passes(station, trajectory);
    
    val result = val::array();
    for (const auto& p : passes) {
        val pass = val::object();
        pass.set("start_jd", p.start_jd);
        pass.set("end_jd", p.end_jd);
        pass.set("max_elevation_rad", p.max_elevation_rad);
        pass.set("duration_s", p.duration_s);
        pass.set("min_range_km", p.min_range_km);
        result.call<void>("push", pass);
    }
    return result;
}

// =============================================================================
// Conjunction Screening (time-window)
// =============================================================================

/// Screen all satellite pairs for close approaches over a time window.
/// Input: catalog of trajectories (array of flat trajectory arrays).
val screen_conjunctions_js(val catalog, double screen_distance_km) {
    int n_sats = catalog["length"].as<int>();
    std::vector<std::vector<orbit::StateVector>> traj_catalog;
    traj_catalog.reserve(n_sats);
    
    for (int s = 0; s < n_sats; ++s) {
        val traj = catalog[s];
        int len = traj["length"].as<int>();
        int n = len / 7;
        std::vector<orbit::StateVector> trajectory;
        trajectory.reserve(n);
        for (int i = 0; i < n; ++i) {
            orbit::StateVector sv;
            sv.position.x = traj[i * 7 + 0].as<double>();
            sv.position.y = traj[i * 7 + 1].as<double>();
            sv.position.z = traj[i * 7 + 2].as<double>();
            sv.velocity.x = traj[i * 7 + 3].as<double>();
            sv.velocity.y = traj[i * 7 + 4].as<double>();
            sv.velocity.z = traj[i * 7 + 5].as<double>();
            sv.epoch = traj[i * 7 + 6].as<double>();
            trajectory.push_back(sv);
        }
        traj_catalog.push_back(trajectory);
    }
    
    orbit::ConjunctionConfig config;
    config.screen_distance_km = screen_distance_km;
    
    std::vector<orbit::ConjunctionEvent> events = orbit::screen_conjunctions(traj_catalog, config);
    
    val result = val::array();
    for (const auto& evt : events) {
        val e = val::object();
        e.set("sat_id_1", evt.sat_id_1);
        e.set("sat_id_2", evt.sat_id_2);
        e.set("tca_jd", evt.tca_jd);
        e.set("miss_distance_km", evt.miss_distance_km);
        result.call<void>("push", e);
    }
    return result;
}

// =============================================================================
// Orbit Determination (Phase 1): Stations, Observations, Partials, STM
// =============================================================================
// Handle-based ground station store (same pattern as sgp4 propagators).

static std::map<int, orbit::ODGroundStation> g_od_stations;
static int g_next_od_station_handle = 1;

/// Create an OD ground station and return its handle (0 = failure).
///
/// @param name      Station identifier.
/// @param lat_rad   Geodetic latitude [rad].
/// @param lon_rad   Geodetic longitude [rad].
/// @param alt_km    Altitude above WGS-84 ellipsoid [km].
int od_station_create(const std::string& name, double lat_rad,
                      double lon_rad, double alt_km) {
    int handle = g_next_od_station_handle++;
    g_od_stations[handle] = orbit::ODGroundStation(name, lat_rad, lon_rad,
                                                   alt_km);
    return handle;
}

/// Destroy a single OD ground station handle.
void od_station_destroy(int handle) {
    g_od_stations.erase(handle);
}

/// Predict noise-free observables for an ECI state from an OD station.
///
/// @return Flat array [range_km, range_rate_kms, ra_rad, dec_rad, az_rad,
///         el_rad], or null on invalid handle.
val od_predict_observation_js(int station_h,
                              double rx, double ry, double rz,
                              double vx, double vy, double vz,
                              double jd) {
    auto it = g_od_stations.find(station_h);
    if (it == g_od_stations.end()) {
        return val::null();
    }
    const orbit::ODGroundStation& station = it->second;
    orbit::PredictedComponents c = orbit::predict_observation(
        orbit::Vec3(rx, ry, rz), orbit::Vec3(vx, vy, vz), station, jd);

    val result = val::array();
    result.call<void>("push", c.range_km);
    result.call<void>("push", c.range_rate_kms);
    result.call<void>("push", c.ra_rad);
    result.call<void>("push", c.dec_rad);
    result.call<void>("push", c.az_rad);
    result.call<void>("push", c.el_rad);
    return result;
}

/// Analytic measurement partials for one observation type.
///
/// @param station_h  Station handle.
/// @param obs_type   0=RANGE, 1=RANGE_RATE, 2=RA_DEC, 3=AZ_EL.
/// @return Flat array [nrows, nrows x 6 partials row-major], or null on
///         invalid handle or singular geometry.
val od_measurement_partials_js(int station_h, int obs_type,
                               double rx, double ry, double rz,
                               double vx, double vy, double vz,
                               double jd) {
    auto it = g_od_stations.find(station_h);
    if (it == g_od_stations.end()) {
        return val::null();
    }
    if (obs_type < 0 || obs_type > 3) {
        return val::null();
    }

    double rows[12] = {0.0};
    int nrows = 0;
    bool ok = orbit::measurement_partials(
        static_cast<orbit::ObsType>(obs_type),
        orbit::Vec3(rx, ry, rz), orbit::Vec3(vx, vy, vz), it->second, jd,
        rows, &nrows);
    if (!ok) {
        return val::null();
    }

    val result = val::array();
    result.call<void>("push", nrows);
    for (int i = 0; i < nrows * 6; ++i) {
        result.call<void>("push", rows[i]);
    }
    return result;
}

/// Propagate a 6-dim state with the 42-dim J2 variational system (DOP853).
///
/// @param state6  Flat array [rx, ry, rz, vx, vy, vz] in ECI [km, km/s].
/// @param tier    Force tier: 0 = two-body, 1 = J2.
/// @param rtol    Relative tolerance.
/// @param atol    Absolute tolerance.
/// @param t0      Start time [s].
/// @param t1      End time [s].
/// @return Flat array [r(3), v(3), stm(36)] (42 doubles), or null if the
///         input length is wrong or integration failed.
val od_propagate_with_stm_js(val state6, int tier, double rtol, double atol,
                             double t0, double t1) {
    int len = state6["length"].as<int>();
    if (len != 6) {
        return val::null();
    }

    // Augmented initial state: y = [r, v, Phi] with Phi = identity.
    std::array<double, 42> y0{};
    for (int i = 0; i < 6; ++i) {
        y0[i] = state6[i].as<double>();
    }
    for (int i = 0; i < 6; ++i) {
        y0[6 + i * 6 + i] = 1.0;
    }

    orbit::STMResult res = orbit::propagate_with_stm(y0, t0, t1, rtol, atol,
                                                     tier);
    if (!res.success) {
        return val::null();
    }

    val result = val::array();
    result.call<void>("push", res.position.x);
    result.call<void>("push", res.position.y);
    result.call<void>("push", res.position.z);
    result.call<void>("push", res.velocity.x);
    result.call<void>("push", res.velocity.y);
    result.call<void>("push", res.velocity.z);
    for (double s : res.stm) {
        result.call<void>("push", s);
    }
    return result;
}

// =============================================================================
// Orbit Determination (Phase 2): Gauss IOD, Herrick-Gibbs, Station Geometry
// =============================================================================
// WASM flat-array layouts (tech-lead design):
//   od_gauss_iod input obs: 12 doubles = 3 obs x {jd, ra_rad, dec_rad, pad}
//   od_gauss_iod config: 6 doubles = {mu, residual_tol_rad, enable_corr,
//                        max_dc_iter, cond_singular, cond_warning}
//   od_gauss_iod result: 16 doubles = {r[3], v[3], converged, iterations,
//                        residual_norm, cond_number, error_code, ranges[3],
//                        pad[2]}
// Station geometry comes from g_od_stations handles (Phase 1 pattern).

/// Station position in ECI at a given epoch.
///
/// @return Flat array [x, y, z] in ECI [km], or null on invalid handle.
val od_station_position_eci_js(int handle, double jd) {
    auto it = g_od_stations.find(handle);
    if (it == g_od_stations.end()) {
        return val::null();
    }
    const orbit::Vec3 r = it->second.position_eci(jd);
    val result = val::array();
    result.call<void>("push", r.x);
    result.call<void>("push", r.y);
    result.call<void>("push", r.z);
    return result;
}

/// Station velocity in ECI at a given epoch (Earth-rotation term).
///
/// @return Flat array [vx, vy, vz] in ECI [km/s], or null on invalid
///         handle.
val od_station_velocity_eci_js(int handle, double jd) {
    auto it = g_od_stations.find(handle);
    if (it == g_od_stations.end()) {
        return val::null();
    }
    const orbit::Vec3 v = it->second.velocity_eci(jd);
    val result = val::array();
    result.call<void>("push", v.x);
    result.call<void>("push", v.y);
    result.call<void>("push", v.z);
    return result;
}

/// Elevation angle of an ECI target above the station horizon.
///
/// @return Elevation [rad], or null on invalid handle.
val od_station_elevation_js(int handle, double rx, double ry, double rz,
                            double jd) {
    auto it = g_od_stations.find(handle);
    if (it == g_od_stations.end()) {
        return val::null();
    }
    return val(it->second.elevation_of(orbit::Vec3(rx, ry, rz), jd));
}

/// Herrick-Gibbs velocity at the middle of three ECI positions.
///
/// @return JS object {vx, vy, vz, status} (status is the GaussIodError
///         int; 0 = OK, 2 = ERROR_INPUT for non-increasing epochs).
val od_herrick_gibbs_js(double r1x, double r1y, double r1z,
                        double r2x, double r2y, double r2z,
                        double r3x, double r3y, double r3z,
                        double t1, double t2, double t3, double mu) {
    const orbit::HerrickGibbsResult hg = orbit::herrick_gibbs(
        orbit::Vec3(r1x, r1y, r1z), orbit::Vec3(r2x, r2y, r2z),
        orbit::Vec3(r3x, r3y, r3z), t1, t2, t3, mu);
    val result = val::object();
    result.set("vx", hg.v[0]);
    result.set("vy", hg.v[1]);
    result.set("vz", hg.v[2]);
    result.set("status", static_cast<int>(hg.status));
    return result;
}

/// Gauss angles-only IOD from three RA/Dec observations.
///
/// @param h1, h2, h3  Station handles (from od_station_create) for the
///                    three observations.
/// @param obs32       12 doubles: 3 obs x {jd, ra_rad, dec_rad, pad}.
/// @param config6     6 doubles: {mu, residual_tol_rad, enable_corr
///                    (0/1), max_dc_iter, cond_singular, cond_warning}.
/// @return Flat array of 16 doubles per the Phase 2 layout above, or
///         null if any station handle is invalid or the obs array is
///         shorter than 12.
val od_gauss_iod_js(int h1, int h2, int h3, val obs32, val config6) {
    auto it1 = g_od_stations.find(h1);
    auto it2 = g_od_stations.find(h2);
    auto it3 = g_od_stations.find(h3);
    if (it1 == g_od_stations.end() || it2 == g_od_stations.end() ||
        it3 == g_od_stations.end()) {
        return val::null();
    }
    if (obs32["length"].as<int>() < 12 || config6["length"].as<int>() < 6) {
        return val::null();
    }

    orbit::GaussIodObs obs[3];
    const orbit::ODGroundStation* stations[3] = {&it1->second, &it2->second,
                                                 &it3->second};
    for (int k = 0; k < 3; ++k) {
        obs[k].time_jd = obs32[4 * k + 0].as<double>();
        obs[k].ra_rad = obs32[4 * k + 1].as<double>();
        obs[k].dec_rad = obs32[4 * k + 2].as<double>();
        obs[k].station = stations[k];
    }

    orbit::GaussIodConfig config;
    config.mu = config6[0].as<double>();
    config.residual_tol_rad = config6[1].as<double>();
    config.enable_correction = config6[2].as<double>() != 0.0;
    // Defense-in-depth: clamp the iteration budget from untrusted WASM
    // callers to the documented [1, 100] range.
    config.max_dc_iter =
        std::clamp(static_cast<int>(config6[3].as<double>()), 1, 100);
    config.cond_singular = config6[4].as<double>();
    config.cond_warning = config6[5].as<double>();

    const orbit::GaussIodResult res = orbit::gauss_iod(obs, config);
    const bool ok = res.status == orbit::GaussIodError::OK ||
                    res.status == orbit::GaussIodError::WARNING_ILL_CONDITIONED;

    val out = val::array();
    for (double v : res.r) {
        out.call<void>("push", v);
    }
    for (double v : res.v) {
        out.call<void>("push", v);
    }
    out.call<void>("push", ok ? 1.0 : 0.0);
    out.call<void>("push", static_cast<double>(res.iterations));
    out.call<void>("push", res.residual_norm);
    out.call<void>("push", res.condition_number);
    out.call<void>("push", static_cast<double>(res.status));
    for (double v : res.ranges) {
        out.call<void>("push", v);
    }
    out.call<void>("push", 0.0);  // pad[0]
    out.call<void>("push", 0.0);  // pad[1]
    return out;
}

// =============================================================================
// Orbit Determination (Phase 3): Batch Least-Squares OD
// =============================================================================
// WASM flat-array layouts (tech-lead Phase 3 design):
//   od_batch_solve obs table: N concatenated records of
//     [time_jd(1), sta_pos_eci(3), sta_vel_eci(3), obs_type(1), ndim(1),
//      values(ndim), sigmas(ndim)]
//     i.e. 9 + 2*ndim doubles per record (9 header fields: time_jd,
//     sta_pos x3, sta_vel x3, obs_type, ndim). Station ECI geometry is
//     PRE-RESOLVED by the caller via od_station_position_eci /
//     od_station_velocity_eci at each observation epoch (no station
//     handles inside the solver; it is a pure compute kernel).
//     obs_type: 0=RANGE, 1=RANGE_RATE, 2=RA_DEC (3=AZ_EL is rejected by
//     the solver and returns status ERROR_INPUT). ndim must match the
//     type (1, 1, 2 respectively).
//   od_batch_solve state6: 6 doubles [rx, ry, rz, vx, vy, vz] ECI guess
//     at epoch_jd [km, km/s].
//   od_batch_solve config10: 10 doubles
//     {mu, force_tier (0=two-body, 1=J2), max_iter, tol_pos_km,
//      tol_vel_kms, tol_wrms_rel, sigma_edit, edit_max_fraction,
//      edit_max_rounds, enable_editing (0/1)}.
//     Pass an empty array for defaults; short arrays apply partially
//     over defaults. mu is informational (arc propagation uses the
//     compiled MU_EARTH, helio batch_od parity).
//   od_batch_solve apriori42: 42 doubles {x0(6), cov(36 row-major)}, or
//     null / empty for no a-priori constraint. Non-SPD covariances are
//     rejected with status ERROR_A_PRIORI_INVALID.
//   od_batch_solve result: flat array
//     [state(6), cov(36 row-major), formal_sigmas(6), iterations(1),
//      converged(1), wrms(1), reduced_chi2(1; NaN when n_active <= 6),
//      edited_count(1), n_active(1), status(1 BatchError int),
//      n_residual_rows(1), residual_rows(N x 14)]
//     14 doubles per residual row:
//     {time_jd, obs_type, ndim, values(2), computed(2), residual(2),
//      sigma(2), normalized(2), edited (0/1)}.
//     For RA_DEC records each of the two scalar rows carries its own
//     component in [0] and the companion component in [1] (RA row =
//     [RA, Dec], Dec row = [Dec, RA]). Tables with more than
//     MAX_OBS_RECORDS records are rejected with status ERROR_INPUT.
//   od_batch_config_defaults: 10 doubles in config10 order.
// status codes (orbit::BatchError): 0=OK (converged), 1=ERROR_INPUT,
//   2=ERROR_NOT_CONVERGED, 3=ERROR_SINGULAR_N, 4=ERROR_INTEGRATION,
//   5=ERROR_A_PRIORI_INVALID.

/// Upper bound on observation records accepted by od_batch_solve
/// (defense-in-depth against pathological JS inputs).
constexpr int kMaxObsRecords = 10000;

/// Empty 56-double result header with the given status and zero
/// residual rows (malformed / oversized input path).
val od_batch_error_header(orbit::BatchError status) {
    val out = val::array();
    for (int i = 0; i < 54; ++i) {
        out.call<void>("push", 0.0);
    }
    out.call<void>("push", static_cast<double>(status));
    out.call<void>("push", 0.0);  // n_residual_rows
    return out;
}

/// Default batch OD configuration as a flat 10-double array (config10
/// layout above).
val od_batch_config_defaults_js() {
    orbit::BatchConfig cfg;
    val out = val::array();
    out.call<void>("push", cfg.mu);
    out.call<void>("push", static_cast<double>(cfg.force_tier));
    out.call<void>("push", static_cast<double>(cfg.max_iter));
    out.call<void>("push", cfg.tol_pos_km);
    out.call<void>("push", cfg.tol_vel_kms);
    out.call<void>("push", cfg.tol_wrms_rel);
    out.call<void>("push", cfg.sigma_edit);
    out.call<void>("push", cfg.edit_max_fraction);
    out.call<void>("push", static_cast<double>(cfg.edit_max_rounds));
    out.call<void>("push", cfg.enable_editing ? 1.0 : 0.0);
    return out;
}

/// Batch least-squares orbit determination (Phase 3).
///
/// @param obs_flat   Observation table (flat array; layout above). May
///                   contain zero observations (returns status
///                   ERROR_INPUT with an empty result). Tables with
///                   more than kMaxObsRecords records are rejected the
///                   same way, before parsing.
/// @param state6     ECI state guess at epoch_jd (6 doubles).
/// @param epoch_jd   Estimation epoch as Julian Date [days].
/// @param config10   Config array (10 doubles; defaults when shorter).
/// @param apriori42  Optional a-priori {x0(6), cov(36)} (42 doubles);
///                   null/empty disables the constraint.
/// @return Flat result array per the layout above, or null if an input
///         array has the wrong length (state6 != 6).
val od_batch_solve_js(val obs_flat, val state6, double epoch_jd,
                      val config10, val apriori42) {
    if (state6["length"].as<int>() != 6) {
        return val::null();
    }

    const int obs_len = obs_flat["length"].as<int>();
    std::vector<double> obs_buf(static_cast<std::size_t>(obs_len));
    for (int i = 0; i < obs_len; ++i) {
        obs_buf[static_cast<std::size_t>(i)] = obs_flat[i].as<double>();
    }

    // Record-count cap (defense-in-depth): walk record HEADERS only,
    // before the full parse. Malformed tails fall through to
    // parse_obs_flat's own rejection below.
    int n_records = 0;
    for (int i = 0; i < obs_len;) {
        if (obs_len - i < 9) break;
        const int ndim =
            static_cast<int>(obs_buf[static_cast<std::size_t>(i + 8)]);
        if (ndim != 1 && ndim != 2) break;  // malformed; full parse rejects
        i += 9 + 2 * ndim;
        if (++n_records > kMaxObsRecords) {
            return od_batch_error_header(orbit::BatchError::ERROR_INPUT);
        }
    }

    const orbit::BatchObsTable table =
        orbit::parse_obs_flat(obs_buf.data(), obs_buf.size());
    if (!table.ok) {
        // Malformed table: report as input error with an empty result
        // (header only: status at index 54, n_residual_rows = 0 at 55).
        return od_batch_error_header(orbit::BatchError::ERROR_INPUT);
    }

    double guess[6];
    for (int i = 0; i < 6; ++i) {
        guess[i] = state6[i].as<double>();
    }

    orbit::BatchConfig config;
    const int cfg_len = config10["length"].as<int>();
    if (cfg_len > 0) {
        double cfg_buf[10] = {0.0};
        for (int i = 0; i < cfg_len && i < 10; ++i) {
            cfg_buf[i] = config10[i].as<double>();
        }
        orbit::parse_config_flat(cfg_buf,
                                 static_cast<std::size_t>(std::min(cfg_len, 10)),
                                 config);
    }

    orbit::APrioriState apriori;
    bool has_apriori = false;
    if (!apriori42.isNull() && !apriori42.isUndefined()) {
        const int ap_len = apriori42["length"].as<int>();
        if (ap_len >= 42) {
            double ap_buf[42];
            for (int i = 0; i < 42; ++i) {
                ap_buf[i] = apriori42[i].as<double>();
            }
            has_apriori = orbit::parse_apriori_flat(ap_buf, 42, apriori);
        }
    }

    const orbit::BatchResult res =
        orbit::batch_od_solve(table.obs, guess, epoch_jd, config,
                              has_apriori ? &apriori : nullptr);

    val out = val::array();
    for (double v : res.state) {
        out.call<void>("push", v);
    }
    for (double v : res.cov) {
        out.call<void>("push", v);
    }
    for (double v : res.formal_sigmas) {
        out.call<void>("push", v);
    }
    out.call<void>("push", static_cast<double>(res.iterations));
    out.call<void>("push", res.converged ? 1.0 : 0.0);
    out.call<void>("push", res.wrms);
    out.call<void>("push", res.reduced_chi2);  // NaN when n_active <= 6.
    out.call<void>("push", static_cast<double>(res.edited_count));
    out.call<void>("push", static_cast<double>(res.n_active));
    out.call<void>("push", static_cast<double>(res.error));
    out.call<void>("push", static_cast<double>(res.residuals.size()));
    for (const orbit::BatchResidualRow& rr : res.residuals) {
        out.call<void>("push", rr.time_jd);
        out.call<void>("push", static_cast<double>(rr.obs_type));
        out.call<void>("push", static_cast<double>(rr.ndim));
        out.call<void>("push", rr.values[0]);
        out.call<void>("push", rr.values[1]);
        out.call<void>("push", rr.predicted[0]);
        out.call<void>("push", rr.predicted[1]);
        out.call<void>("push", rr.residual[0]);
        out.call<void>("push", rr.residual[1]);
        out.call<void>("push", rr.sigma[0]);
        out.call<void>("push", rr.sigma[1]);
        out.call<void>("push", rr.normalized[0]);
        out.call<void>("push", rr.normalized[1]);
        out.call<void>("push", rr.edited ? 1.0 : 0.0);
    }
    return out;
}

// =============================================================================
// Embind Registration
// =============================================================================

EMSCRIPTEN_BINDINGS(zenith) {
    function("sgp4_init", &sgp4_init);
    function("sgp4_propagate", &sgp4_propagate);
    function("sgp4_get_elements", &sgp4_get_elements);
    function("sgp4_clear", &sgp4_clear);
    function("sgp4_destroy", &sgp4_destroy);
    function("lambert_solve", &lambert_solve_js);
    function("hohmann_from_altitudes", &hohmann_from_altitudes_js);
    function("bielliptic_transfer", &bielliptic_transfer_js);
    function("compute_ground_track", &compute_ground_track_js);
    function("mc_propagate", &mc_propagate_js);
    function("generate_walker", &generate_walker_js);
    function("predict_passes", &predict_passes_js);
    function("screen_conjunctions", &screen_conjunctions_js);
    function("od_station_create", &od_station_create);
    function("od_station_destroy", &od_station_destroy);
    function("od_predict_observation", &od_predict_observation_js);
    function("od_measurement_partials", &od_measurement_partials_js);
    function("od_propagate_with_stm", &od_propagate_with_stm_js);
    function("od_station_position_eci", &od_station_position_eci_js);
    function("od_station_velocity_eci", &od_station_velocity_eci_js);
    function("od_station_elevation", &od_station_elevation_js);
    function("od_herrick_gibbs", &od_herrick_gibbs_js);
    function("od_gauss_iod", &od_gauss_iod_js);
    function("od_batch_config_defaults", &od_batch_config_defaults_js);
    function("od_batch_solve", &od_batch_solve_js);
}
