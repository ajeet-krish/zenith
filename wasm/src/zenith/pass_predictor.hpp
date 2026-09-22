#pragma once

/// @file pass_predictor.hpp
/// @brief Satellite pass prediction over ground stations.
///        Computes topocentric look angles, visibility, and pass
///        scheduling for LEO/MEO/GEO satellites relative to ground stations.

#include <algorithm>
#include <cmath>
#include <vector>

#include "orbit_types.hpp"
#include "coordinate_frames.hpp"
#include "kepler.hpp"
#include "time_system.hpp"

namespace orbit {

// ============================================================================
// Structs
// ============================================================================

/// Ground station location and observation parameters.
struct GroundStation {
    double latitude_rad = 0.0;                    ///< Station latitude [rad].
    double longitude_rad = 0.0;                   ///< Station longitude [rad].
    double altitude_km = 0.0;                     ///< Station altitude above WGS-84 ellipsoid [km].
    double elevation_mask_rad = 5.0 * (PI / 180.0);  ///< Minimum elevation for visibility [rad].
};

/// Topocentric look angles from a ground station to a satellite.
struct LookAngles {
    double azimuth_rad;       ///< Azimuth from North, clockwise [rad].
    double elevation_rad;     ///< Elevation above horizon [rad].
    double range_km;          ///< Slant range to satellite [km].
    double range_rate_km_s;   ///< Radial velocity (positive = approaching) [km/s].
};

/// Summary information for a single satellite pass.
struct PassInfo {
    double start_jd;          ///< Julian Date at pass start.
    double end_jd;            ///< Julian Date at pass end.
    double max_elevation_rad; ///< Maximum elevation during pass [rad].
    double duration_s;        ///< Pass duration [s].
    double min_range_km;      ///< Minimum slant range during pass [km].
};

// ============================================================================
// Look Angles
// ============================================================================

/// Compute topocentric look angles (azimuth, elevation, range) from a ground
/// station to a satellite.
///
/// The algorithm:
///   1. Convert station LLA to ECEF position.
///   2. Compute the range vector: rho = r_sat_ecef - r_station_ecef.
///   3. Rotate rho into the SEZ (South-East-Zenith) frame at the station.
///   4. Extract azimuth, elevation, and range from SEZ components.
///
/// @param station            Ground station with geodetic coordinates.
/// @param sat_position_ecef  Satellite position in ECEF [km].
/// @param jd_ut1             UT1 Julian Date (used only for station ECEF if needed).
/// @return LookAngles with azimuth, elevation, range, and range rate.
inline LookAngles compute_look_angles(const GroundStation& station,
                                      const Vec3& sat_position_ecef,
                                      double jd_ut1) {
    // Station ECEF position.
    Vec3 r_station = lla_to_ecef(station.latitude_rad, station.longitude_rad,
                                  station.altitude_km);

    // Range vector in ECEF: station to satellite.
    Vec3 rho_ecef = sat_position_ecef - r_station;

    // Rotate to SEZ frame.
    // SEZ axes at station:
    //   S (South) = -sin(lat)*cos(lon)*x - sin(lat)*sin(lon)*y + cos(lat)*z
    //   E (East)  = -sin(lon)*x + cos(lon)*y + 0*z
    //   Z (Zenith) = cos(lat)*cos(lon)*x + cos(lat)*sin(lon)*y + sin(lat)*z
    double cos_lat = std::cos(station.latitude_rad);
    double sin_lat = std::sin(station.latitude_rad);
    double cos_lon = std::cos(station.longitude_rad);
    double sin_lon = std::sin(station.longitude_rad);

    double rho_s = -sin_lat * cos_lon * rho_ecef.x
                   - sin_lat * sin_lon * rho_ecef.y
                   + cos_lat * rho_ecef.z;
    double rho_e = -sin_lon * rho_ecef.x + cos_lon * rho_ecef.y;
    double rho_z = cos_lat * cos_lon * rho_ecef.x
                   + cos_lat * sin_lon * rho_ecef.y
                   + sin_lat * rho_ecef.z;

    // Range.
    double range = std::sqrt(rho_s * rho_s + rho_e * rho_e + rho_z * rho_z);

    // Elevation: angle above the local horizontal plane.
    double elevation = std::asin(std::clamp(rho_z / range, -1.0, 1.0));

    // Azimuth: measured clockwise from North.
    double azimuth = std::atan2(-rho_s, rho_e);
    if (azimuth < 0.0) {
        azimuth += TWO_PI;
    }

    LookAngles angles;
    angles.azimuth_rad = azimuth;
    angles.elevation_rad = elevation;
    angles.range_km = range;
    angles.range_rate_km_s = 0.0;  // Caller must supply velocity for range rate.
    return angles;
}

// ============================================================================
// Visibility Check
// ============================================================================

/// Check whether a satellite is visible from a ground station.
///
/// A satellite is visible when its elevation above the local horizon exceeds
/// the station's elevation mask.
///
/// @param station            Ground station.
/// @param sat_position_ecef  Satellite position in ECEF [km].
/// @param jd_ut1             UT1 Julian Date.
/// @param min_elevation_rad  Minimum elevation for visibility [rad].
/// @return True if satellite is above the elevation mask.
inline bool is_visible(const GroundStation& station,
                       const Vec3& sat_position_ecef,
                       double jd_ut1,
                       double min_elevation_rad = 5.0 * PI / 180.0) {
    LookAngles angles = compute_look_angles(station, sat_position_ecef, jd_ut1);
    return angles.elevation_rad >= min_elevation_rad;
}

// ============================================================================
// Maximum Elevation
// ============================================================================

/// Compute the elevation of a satellite from a ground station for a single state.
///
/// This is a convenience wrapper that returns only the elevation angle from
/// compute_look_angles().
///
/// @param station    Ground station.
/// @param sat_state  Satellite state vector (position must be in ECEF or TEME
///                   that has been rotated to ECEF by the caller).
/// @return Elevation angle [rad].
inline double compute_max_elevation(const GroundStation& station,
                                    const StateVector& sat_state) {
    LookAngles angles = compute_look_angles(station, sat_state.position, sat_state.epoch);
    return angles.elevation_rad;
}

// ============================================================================
// Pass Prediction
// ============================================================================

/// Predict satellite passes over a ground station from a pre-propagated trajectory.
///
/// Scans the trajectory for segments where the satellite is above the elevation
/// mask. Consecutive visible points are grouped into passes. Each pass records
/// the start/end time, maximum elevation, minimum range, and duration.
///
/// @param station           Ground station.
/// @param trajectory        Pre-propagated trajectory (vector of StateVector).
///                          States should be in TEME or ECEF frame; the function
///                          assumes positions are in ECEF (caller must rotate if
///                          using TEME).
/// @param min_elevation_rad Minimum elevation for a point to be considered
///                          visible [rad].
/// @return Vector of PassInfo structs, one per detected pass.
inline std::vector<PassInfo> predict_passes(
    const GroundStation& station,
    const std::vector<StateVector>& trajectory,
    double min_elevation_rad = 5.0 * PI / 180.0) {

    std::vector<PassInfo> passes;

    if (trajectory.size() < 2) {
        return passes;
    }

    bool in_pass = false;
    PassInfo current_pass;
    double max_elev = -1.0;
    double min_range = 1e18;
    int pass_start_idx = 0;

    for (size_t idx = 0; idx < trajectory.size(); ++idx) {
        LookAngles angles = compute_look_angles(station, trajectory[idx].position,
                                                trajectory[idx].epoch);
        bool visible = angles.elevation_rad >= min_elevation_rad;

        if (visible && !in_pass) {
            // Start of a new pass.
            in_pass = true;
            pass_start_idx = idx;
            max_elev = angles.elevation_rad;
            min_range = angles.range_km;
        } else if (visible && in_pass) {
            // Continue current pass; update max elevation and min range.
            if (angles.elevation_rad > max_elev) {
                max_elev = angles.elevation_rad;
            }
            if (angles.range_km < min_range) {
                min_range = angles.range_km;
            }
        } else if (!visible && in_pass) {
            // End of current pass.
            in_pass = false;

            PassInfo pass;
            pass.start_jd = trajectory[pass_start_idx].epoch;
            pass.end_jd = trajectory[idx - 1].epoch;
            pass.max_elevation_rad = max_elev;
            pass.duration_s = (pass.end_jd - pass.start_jd) * SEC_PER_DAY;
            pass.min_range_km = min_range;
            passes.push_back(pass);
        }
    }

    // Close any pass still active at the end of the trajectory.
    if (in_pass) {
        PassInfo pass;
        pass.start_jd = trajectory[pass_start_idx].epoch;
        pass.end_jd = trajectory.back().epoch;
        pass.max_elevation_rad = max_elev;
        pass.duration_s = (pass.end_jd - pass.start_jd) * SEC_PER_DAY;
        pass.min_range_km = min_range;
        passes.push_back(pass);
    }

    return passes;
}

}  // namespace orbit
