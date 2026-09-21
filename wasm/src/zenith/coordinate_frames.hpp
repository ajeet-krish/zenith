#pragma once

/// @file coordinate_frames.hpp
/// @brief Coordinate frame transformations for the orbital mechanics suite.
///        Covers TEME <-> ECEF, geodetic (LLA) conversions, perifocal <-> ECI,
///        and classical element <-> state vector conversions.

#include <array>
#include <cmath>

#include "orbit_types.hpp"
#include "time_system.hpp"

namespace orbit {

// ============================================================================
// Geodetic Coordinates
// ============================================================================

/// WGS-84 geodetic position: latitude, longitude, altitude.
struct LLA {
    double lat = 0.0;  ///< Latitude [rad], range [-PI/2, PI/2].
    double lon = 0.0;  ///< Longitude [rad], range [-PI, PI].
    double alt = 0.0;  ///< Altitude above the ellipsoid [km].
};

// ============================================================================
// WGS-84 Ellipsoid Constants
// ============================================================================

/// WGS-84 semi-major axis [km].
inline constexpr double WGS84_A = 6378.137;

/// WGS-84 flattening factor.
inline constexpr double WGS84_F = 1.0 / 298.257223563;

/// WGS-84 semi-minor axis [km].
inline constexpr double WGS84_B = WGS84_A * (1.0 - WGS84_F);

/// WGS-84 first eccentricity squared (e^2).
inline constexpr double WGS84_E2 =
    1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

// ============================================================================
// GMST: Greenwich Mean Sidereal Time
// ============================================================================

/// Compute Greenwich Mean Sidereal Time [rad] from UT1 Julian Date.
///
/// Delegates to orbit::ut1_to_gmst() from time_system.hpp for the
/// IAU 1982 expression (Vallado Eq. 3-47).
inline double gmst(double jd_ut1) {
    return ut1_to_gmst(jd_ut1);
}

// ============================================================================
// Elementary Rotation Functions
// ============================================================================

/// Rotate a Vec3 about the X-axis by `angle` [rad].
///
/// ```
/// Rx(angle) = | 1       0            0      |
///             | 0   cos(angle)  -sin(angle)  |
///             | 0   sin(angle)   cos(angle)  |
/// ```
inline Vec3 rotate_x(const Vec3& v, double angle) {
    double c = std::cos(angle);
    double s = std::sin(angle);
    return {v.x,
            v.y * c - v.z * s,
            v.y * s + v.z * c};
}

/// Rotate a Vec3 about the Y-axis by `angle` [rad].
///
/// ```
/// Ry(angle) = |  cos(angle)  0   sin(angle) |
///             |      0       1       0       |
///             | -sin(angle)  0   cos(angle) |
/// ```
inline Vec3 rotate_y(const Vec3& v, double angle) {
    double c = std::cos(angle);
    double s = std::sin(angle);
    return {v.x * c + v.z * s,
            v.y,
           -v.x * s + v.z * c};
}

/// Rotate a Vec3 about the Z-axis by `angle` [rad].
///
/// ```
/// Rz(angle) = | cos(angle)  -sin(angle)  0 |
///             | sin(angle)   cos(angle)  0 |
///             |     0             0      1 |
/// ```
inline Vec3 rotate_z(const Vec3& v, double angle) {
    double c = std::cos(angle);
    double s = std::sin(angle);
    return {v.x * c - v.y * s,
            v.x * s + v.y * c,
            v.z};
}

// ============================================================================
// TEME <-> ECEF
// ============================================================================

/// Rotate position from TEME to ECEF using Earth rotation angle (GMST).
///
/// @param r_teme  Position in TEME frame [km].
/// @param jd_ut1  UT1 Julian Date for rotation angle computation.
/// @return Position in ECEF frame [km].
inline Vec3 teme_to_ecef(const Vec3& r_teme, double jd_ut1) {
    return rotate_z(r_teme, -gmst(jd_ut1));
}

/// Rotate position from ECEF to TEME (inverse of TEME -> ECEF).
///
/// @param r_ecef  Position in ECEF frame [km].
/// @param jd_ut1  UT1 Julian Date for rotation angle computation.
/// @return Position in TEME frame [km].
inline Vec3 ecef_to_teme(const Vec3& r_ecef, double jd_ut1) {
    return rotate_z(r_ecef, gmst(jd_ut1));
}

/// Transform TEME state (position + velocity) to ECEF.
///
/// Velocity includes the cross product term:
///   v_ecef = Rz(-theta) * v_teme + omega_earth x r_ecef
///
/// @param r_teme  Position in TEME [km].
/// @param v_teme  Velocity in TEME [km/s].
/// @param jd_ut1  UT1 Julian Date.
/// @return Pair of (r_ecef, v_ecef).
inline std::pair<Vec3, Vec3> teme_to_ecef(const Vec3& r_teme,
                                           const Vec3& v_teme,
                                           double jd_ut1) {
    double theta = gmst(jd_ut1);
    Vec3 r_ecef = rotate_z(r_teme, -theta);
    Vec3 v_ecef = rotate_z(v_teme, -theta);

    // Add the Earth rotation contribution: omega x r_ecef.
    // omega = [0, 0, omega_earth] in ECEF.
    // omega x r = [-omega * y, omega * x, 0].
    v_ecef.x += -OMEGA_EARTH * r_ecef.y;
    v_ecef.y +=  OMEGA_EARTH * r_ecef.x;

    return {r_ecef, v_ecef};
}

/// Transform ECEF state (position + velocity) to TEME.
///
/// Inverse of the TEME->ECEF state transformation.
inline std::pair<Vec3, Vec3> ecef_to_teme(const Vec3& r_ecef,
                                           const Vec3& v_ecef,
                                           double jd_ut1) {
    double theta = gmst(jd_ut1);
    Vec3 r_teme = rotate_z(r_ecef, theta);

    // Remove the Earth rotation contribution first.
    // v_ecef = Rz(-theta) * v_teme + omega x r_ecef
    // Rz(theta) * v_ecef = v_teme + Rz(theta) * (omega x r_ecef)
    // v_teme = Rz(theta) * (v_ecef - omega x r_ecef)
    Vec3 omega_cross_r = {-OMEGA_EARTH * r_ecef.y,
                           OMEGA_EARTH * r_ecef.x,
                           0.0};
    Vec3 v_corrected = v_ecef - omega_cross_r;
    Vec3 v_teme = rotate_z(v_corrected, theta);

    return {r_teme, v_teme};
}

// ============================================================================
// LLA Conversions
// ============================================================================

/// Convert geodetic coordinates (lat, lon, alt) to ECEF position.
///
/// Uses WGS-84 ellipsoid parameters.
///
/// @param lat_rad  Latitude [rad].
/// @param lon_rad  Longitude [rad].
/// @param alt_km   Altitude above WGS-84 ellipsoid [km].
/// @return ECEF position [km].
inline Vec3 lla_to_ecef(double lat_rad, double lon_rad, double alt_km) {
    double sin_lat = std::sin(lat_rad);
    double cos_lat = std::cos(lat_rad);
    double sin_lon = std::sin(lon_rad);
    double cos_lon = std::cos(lon_rad);

    // Radius of curvature in the prime vertical.
    double n = WGS84_A / std::sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);

    double x = (n + alt_km) * cos_lat * cos_lon;
    double y = (n + alt_km) * cos_lat * sin_lon;
    double z = (n * (1.0 - WGS84_E2) + alt_km) * sin_lat;

    return {x, y, z};
}

/// Convert TEME position to geodetic coordinates (latitude, longitude, altitude).
///
/// First rotates to ECEF, then uses an iterative method to solve for
/// geodetic latitude on the WGS-84 ellipsoid.
///
/// @param r_teme  Position in TEME [km].
/// @param jd_ut1  UT1 Julian Date.
/// @return LLA struct with lat [rad], lon [rad], alt [km].
inline LLA teme_to_lla(const Vec3& r_teme, double jd_ut1) {
    Vec3 r_ecef = teme_to_ecef(r_teme, jd_ut1);

    double x = r_ecef.x;
    double y = r_ecef.y;
    double z = r_ecef.z;

    // Longitude is straightforward.
    double lon = std::atan2(y, x);

    // Iterative solution for geodetic latitude and altitude.
    double p = std::sqrt(x * x + y * y);
    double lat = std::atan2(z, p * (1.0 - WGS84_E2));  // Initial guess.

    for (int iter = 0; iter < 20; ++iter) {
        double sin_lat = std::sin(lat);
        double n = WGS84_A / std::sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);
        double lat_new = std::atan2(z + WGS84_E2 * n * sin_lat, p);
        if (std::abs(lat_new - lat) < 1e-12) {
            lat = lat_new;
            break;
        }
        lat = lat_new;
    }

    double sin_lat = std::sin(lat);
    double n = WGS84_A / std::sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);
    double alt = p / std::cos(lat) - n;

    // Handle poles where cos(lat) ~ 0.
    if (std::abs(lat) > (PI / 2.0 - 1e-10)) {
        alt = std::abs(z) / std::abs(sin_lat) - n * (1.0 - WGS84_E2);
    }

    return {lat, lon, alt};
}

// ============================================================================
// Perifocal <-> ECI Transformations
// ============================================================================

/// Build the rotation matrix from perifocal (PQW) to ECI (TEME/GCRF).
///
/// The perifocal frame has:
///   P-axis toward perigee,
///   Q-axis in the orbital plane 90 deg ahead,
///   W-axis along the angular momentum vector.
///
/// The rotation is: R = Rz(-RAAN) * Rx(-i) * Rz(-argp)
///
/// @param raan  Right ascension of ascending node [rad].
/// @param inc   Inclination [rad].
/// @param argp  Argument of perigee [rad].
/// @return 3x3 rotation matrix stored as std::array<double, 9> in row-major order.
inline std::array<double, 9> pqw_to_eci_rotation(double raan, double inc,
                                                   double argp) {
    double cos_raan = std::cos(raan);
    double sin_raan = std::sin(raan);
    double cos_inc  = std::cos(inc);
    double sin_inc  = std::sin(inc);
    double cos_argp = std::cos(argp);
    double sin_argp = std::sin(argp);

    // R = Rz(-raan) * Rx(-inc) * Rz(-argp)
    // Expanded analytically for efficiency.
    std::array<double, 9> r;

    // Row 0.
    r[0] = cos_raan * cos_argp - sin_raan * sin_argp * cos_inc;
    r[1] = -cos_raan * sin_argp - sin_raan * cos_argp * cos_inc;
    r[2] = sin_raan * sin_inc;

    // Row 1.
    r[3] = sin_raan * cos_argp + cos_raan * sin_argp * cos_inc;
    r[4] = -sin_raan * sin_argp + cos_raan * cos_argp * cos_inc;
    r[5] = -cos_raan * sin_inc;

    // Row 2.
    r[6] = sin_argp * sin_inc;
    r[7] = cos_argp * sin_inc;
    r[8] = cos_inc;

    return r;
}

/// Multiply a 3x3 matrix (row-major) by a Vec3.
inline Vec3 mat3_rotate(const std::array<double, 9>& m, const Vec3& v) {
    return {m[0] * v.x + m[1] * v.y + m[2] * v.z,
            m[3] * v.x + m[4] * v.y + m[5] * v.z,
            m[6] * v.x + m[7] * v.y + m[8] * v.z};
}

/// Transpose a 3x3 matrix (row-major).
inline std::array<double, 9> mat3_transpose(const std::array<double, 9>& m) {
    return {m[0], m[3], m[6],
            m[1], m[4], m[7],
            m[2], m[5], m[8]};
}

/// Convert perifocal (PQW) position and velocity to ECI (TEME/GCRF).
///
/// @param r_pqw  Position in perifocal frame [km].
/// @param v_pqw  Velocity in perifocal frame [km/s].
/// @param raan   Right ascension of ascending node [rad].
/// @param argp   Argument of perigee [rad].
/// @param inc    Inclination [rad].
/// @return Pair of (r_eci, v_eci).
inline std::pair<Vec3, Vec3> perifocal_to_eci(const Vec3& r_pqw,
                                               const Vec3& v_pqw,
                                               double raan, double argp,
                                               double inc) {
    auto r = pqw_to_eci_rotation(raan, inc, argp);
    return {mat3_rotate(r, r_pqw), mat3_rotate(r, v_pqw)};
}

/// Convert ECI (TEME/GCRF) position and velocity to perifocal (PQW).
///
/// @param r_eci  Position in ECI [km].
/// @param v_eci  Velocity in ECI [km/s].
/// @param raan   Right ascension of ascending node [rad].
/// @param argp   Argument of perigee [rad].
/// @param inc    Inclination [rad].
/// @return Pair of (r_pqw, v_pqw).
inline std::pair<Vec3, Vec3> eci_to_perifocal(const Vec3& r_eci,
                                               const Vec3& v_eci,
                                               double raan, double argp,
                                               double inc) {
    auto r = pqw_to_eci_rotation(raan, inc, argp);
    auto rt = mat3_transpose(r);
    return {mat3_rotate(rt, r_eci), mat3_rotate(rt, v_eci)};
}

// ============================================================================
// Classical Elements <-> State Vector
// ============================================================================

/// Convert classical Keplerian elements to ECI state vector (position, velocity).
///
/// Computes position and velocity in the perifocal frame, then rotates to ECI.
///
/// @param elem  Classical orbital elements (a, e, i, raan, argp, ta).
/// @return StateVector in ECI frame with epoch from elem.
inline StateVector elements_to_state(const KeplerianElements& elem) {
    double a   = elem.a;
    double e   = elem.e;
    double i   = elem.i;
    double raan = elem.raan;
    double argp = elem.argp;
    double ta   = elem.ta;

    // Radius at true anomaly.
    double p = a * (1.0 - e * e);          // Semi-latus rectum.
    double r = p / (1.0 + e * std::cos(ta));

    // Position in perifocal frame.
    Vec3 r_pqw(r * std::cos(ta), r * std::sin(ta), 0.0);

    // Velocity in perifocal frame.
    double sqrt_mu_over_p = std::sqrt(MU_EARTH / p);
    Vec3 v_pqw(sqrt_mu_over_p * -std::sin(ta),
               sqrt_mu_over_p * (e + std::cos(ta)),
               0.0);

    // Rotate to ECI.
    auto [r_eci, v_eci] = perifocal_to_eci(r_pqw, v_pqw, raan, argp, i);

    return {r_eci, v_eci, elem.epoch};
}

/// Convert ECI state vector (position, velocity) to classical Keplerian elements.
///
/// Implements the standard algorithm from Vallado, "Fundamentals of Astrodynamics
/// and Applications," 4th ed., Algorithm 9.
///
/// @param r   Position in ECI [km].
/// @param v   Velocity in ECI [km/s].
/// @param jd  Epoch as Julian Date.
/// @return KeplerianElements with all six elements.
inline KeplerianElements state_to_elements(const Vec3& r, const Vec3& v,
                                           double jd) {
    double r_mag = r.magnitude();
    double v_mag = v.magnitude();

    // Angular momentum vector.
    Vec3 h = r.cross(v);
    double h_mag = h.magnitude();

    // Node vector (points toward ascending node).
    Vec3 k_hat(0.0, 0.0, 1.0);
    Vec3 n_vec = k_hat.cross(h);
    double n_mag = n_vec.magnitude();

    // Eccentricity vector.
    Vec3 e_vec = ((v.magnitude_squared() - MU_EARTH / r_mag) * r
                  - r.dot(v) * v) / MU_EARTH;
    double e = e_vec.magnitude();

    // Specific orbital energy.
    double energy = v_mag * v_mag / 2.0 - MU_EARTH / r_mag;

    // Semi-major axis.
    double a;
    if (std::abs(e - 1.0) < 1e-10) {
        // Parabolic orbit.
        a = std::numeric_limits<double>::infinity();
    } else {
        a = -MU_EARTH / (2.0 * energy);
    }

    // Inclination.
    double inc = std::acos(std::clamp(h.z / h_mag, -1.0, 1.0));

    // Right ascension of ascending node.
    double raan;
    if (n_mag < 1e-10) {
        // Equatorial orbit: RAAN undefined, set to zero.
        raan = 0.0;
    } else {
        raan = std::acos(std::clamp(n_vec.x / n_mag, -1.0, 1.0));
        if (n_vec.y < 0.0) {
            raan = TWO_PI - raan;
        }
    }

    // Argument of perigee.
    double argp;
    if (e < 1e-10) {
        // Circular orbit: argp undefined, set to zero.
        argp = 0.0;
    } else if (n_mag < 1e-10) {
        // Equatorial orbit: use longitude of periapsis (atan2 of eccentricity vector).
        argp = std::atan2(e_vec.y, e_vec.x);
        if (argp < 0.0) {
            argp += TWO_PI;
        }
    } else {
        argp = std::acos(std::clamp(n_vec.dot(e_vec) / (n_mag * e), -1.0, 1.0));
        if (e_vec.z < 0.0) {
            argp = TWO_PI - argp;
        }
    }

    // True anomaly.
    double ta;
    if (e < 1e-10) {
        // Circular orbit: use position angle.
        if (n_mag < 1e-10) {
            ta = std::atan2(r.y, r.x);
            if (ta < 0.0) {
                ta += TWO_PI;
            }
        } else {
            ta = std::acos(std::clamp(n_vec.dot(r) / (n_mag * r_mag), -1.0, 1.0));
            if (r.z < 0.0) {
                ta = TWO_PI - ta;
            }
        }
    } else {
        ta = std::acos(std::clamp(e_vec.dot(r) / (e * r_mag), -1.0, 1.0));
        if (r.dot(v) < 0.0) {
            ta = TWO_PI - ta;
        }
    }

    return KeplerianElements(a, e, inc, raan, argp, ta, jd);
}

}  // namespace orbit
