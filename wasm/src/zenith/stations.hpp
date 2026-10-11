#pragma once

/// @file stations.hpp
/// @brief Ground station model for orbit determination.
///
///        ODGroundStation (NOT pass_predictor::GroundStation; the name
///        avoids a collision in the orbit namespace) carries geodetic
///        coordinates, a cached ECEF position, and ECI position/velocity
///        accessors for the observation model.  Units: km, km/s, rad.
///        ECI is the GMST-only frame from coordinate_frames.hpp (UT1
///        approximated by UTC, no polar motion), matching helio_ob.
///
///        The station is fixed in ECEF; its ECI velocity is the
///        Earth-rotation term omega x r_ecef rotated into ECI, which
///        range-rate observations need.
///
///        Reference: helio_ob src/helio/stations.py

#include <algorithm>
#include <cmath>
#include <string>
#include <utility>

#include "coordinate_frames.hpp"
#include "orbit_types.hpp"
#include "time_system.hpp"

namespace orbit {

// ============================================================================
// ODGroundStation
// ============================================================================

/// A tracking station on the rotating Earth (WGS-84 ellipsoid).
struct ODGroundStation {
    std::string name;      ///< Station identifier, e.g. "goldstone".
    double lat_rad = 0.0;  ///< Geodetic latitude [rad], east/north positive.
    double lon_rad = 0.0;  ///< Geodetic longitude [rad], east positive.
    double alt_km = 0.0;   ///< Height above the WGS-84 ellipsoid [km].

    /// Cached ECEF position [km]; recomputed by refresh_cache().
    Vec3 position_ecef{};

    /// Default-constructed station at the equator/prime meridian.
    ODGroundStation() { refresh_cache(); }

    /// Full construction; caches the ECEF position immediately.
    ODGroundStation(std::string name_in, double lat_rad_in, double lon_rad_in,
                    double alt_km_in)
        : name(std::move(name_in)),
          lat_rad(lat_rad_in),
          lon_rad(wrap_lon(lon_rad_in)),
          alt_km(alt_km_in) {
        refresh_cache();
    }

    /// Recompute the cached ECEF position from lat/lon/alt.
    void refresh_cache() {
        position_ecef = lla_to_ecef(lat_rad, lon_rad, alt_km);
    }

    /// Station position in ECI at a given epoch (GMST-only rotation).
    ///
    /// @param jd  Julian Date in days (UT1 approximated by UTC).
    /// @return Position in ECI [km].
    [[nodiscard]] Vec3 position_eci(double jd) const {
        return ecef_to_teme(position_ecef, jd);
    }

    /// Station velocity in ECI at a given epoch.
    ///
    /// The station is fixed in ECEF (v_ecef = 0), so its ECI velocity is
    /// the Earth-rotation term omega x r_ecef rotated into ECI; this is
    /// the corrected ecef_to_teme velocity transform.
    ///
    /// @param jd  Julian Date in days (UT1 approximated by UTC).
    /// @return Velocity in ECI [km/s].
    [[nodiscard]] Vec3 velocity_eci(double jd) const {
        return ecef_to_teme(position_ecef, Vec3(0.0, 0.0, 0.0), jd).second;
    }

    /// Elevation angle of an ECI target above the local horizon.
    ///
    /// The target is rotated to ECEF, differenced against the station,
    /// and projected into the local South-East-Zenith frame.
    ///
    /// @param r_target_eci  Target position in ECI [km].
    /// @param jd            Julian Date at which to evaluate the geometry.
    /// @return Elevation angle [rad] in [-PI/2, PI/2] (PI/2 is zenith).
    [[nodiscard]] double elevation_of(const Vec3& r_target_eci,
                                      double jd) const {
        const Vec3 r_target_ecef = teme_to_ecef(r_target_eci, jd);
        const Vec3 r_rel_ecef = r_target_ecef - position_ecef;
        const Vec3 sez = ecef_to_sez(r_rel_ecef, lat_rad, lon_rad);
        const double range = sez.magnitude();
        if (range < 1e-12) {
            return 0.0;
        }
        double el = std::asin(std::clamp(sez.z / range, -1.0, 1.0));
        return el;
    }

private:
    /// Guard against longitude wrap at construction (kept in [-PI, PI)).
    static double wrap_lon(double lon) {
        double a = std::fmod(lon, TWO_PI);
        if (a >= PI) a -= TWO_PI;
        if (a < -PI) a += TWO_PI;
        return a;
    }
};

// ============================================================================
// Canonical Stations (Helio parity, rounded public-reference coordinates)
// ============================================================================

/// Goldstone DSN complex (35.4N, 116.8W, about 1.0 km elevation).
inline ODGroundStation make_goldstone() {
    return ODGroundStation("goldstone", 35.4 * DEG_TO_RAD,
                           -116.8 * DEG_TO_RAD, 1.0);
}

/// Arecibo Observatory (18.3N, 66.75W, about 0.4 km).
inline ODGroundStation make_arecibo() {
    return ODGroundStation("arecibo", 18.3 * DEG_TO_RAD,
                           -66.75 * DEG_TO_RAD, 0.4);
}

/// EISCAT radar site near Tromso (69.6N, 18.9E, about 0.1 km).
inline ODGroundStation make_tromsoe() {
    return ODGroundStation("tromsoe", 69.6 * DEG_TO_RAD,
                           18.9 * DEG_TO_RAD, 0.1);
}

/// Look up a canonical station by lowercase name.
///
/// @param name  One of "goldstone", "arecibo", "tromsoe".
/// @return The station, or a default-constructed station if the name is
///         unknown (callers should validate via has_canonical_station).
inline ODGroundStation canonical_station(const std::string& name) {
    if (name == "goldstone") return make_goldstone();
    if (name == "arecibo") return make_arecibo();
    if (name == "tromsoe") return make_tromsoe();
    return ODGroundStation{};
}

/// Whether the given name matches a canonical station.
inline bool has_canonical_station(const std::string& name) {
    return name == "goldstone" || name == "arecibo" || name == "tromsoe";
}

}  // namespace orbit
