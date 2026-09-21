#pragma once

/// @file force_models.hpp
/// @brief Perturbation force models for numerical orbit propagation.
///        Provides individual force accelerations (two-body, J2, J4, drag,
///        SRP, third-body) and a combined total acceleration function
///        for use with RK4/RK45 integrators.

#include "orbit_types.hpp"

#include <cmath>

namespace orbit {

// ============================================================================
// Constants for force models
// ============================================================================

/// Atmospheric density at sea level [kg/m^3] (standard atmosphere).
inline constexpr double RHO_0 = 1.225;

/// Solar radiation pressure at 1 AU [N/m^2].
inline constexpr double SRP_PRESSURE = 4.56e-6;

/// Typical solar reflectivity coefficient.
inline constexpr double CR_DEFAULT = 1.5;

// ============================================================================
// Force Model Function Signature
// ============================================================================

/// Signature for force model acceleration functions.
/// @param r  Position vector in ECI frame [km].
/// @param v  Velocity vector in ECI frame [km/s].
/// @param jd Julian Date of the current epoch.
/// @param params  Propagation parameters (Cd, A/m, flags).
/// @return Acceleration vector [km/s^2].
using ForceModelFunc = Vec3 (*)(const Vec3& r, const Vec3& v,
                                double jd, const PropagatorParams& params);

// ============================================================================
// Two-Body (Keplerian) Gravity
// ============================================================================

/// Pure two-body gravitational acceleration.
/// Computes a = -mu * r / |r|^3.
/// @param r   Position vector in ECI [km].
/// @param mu  Gravitational parameter [km^3/s^2]. Defaults to MU_EARTH.
/// @return Acceleration vector [km/s^2].
inline Vec3 compute_two_body_acceleration(const Vec3& r,
                                          double mu = MU_EARTH) {
    double r_mag = r.magnitude();
    double r_cubed = r_mag * r_mag * r_mag;
    if (r_cubed == 0.0) {
        return {0.0, 0.0, 0.0};
    }
    double factor = -mu / r_cubed;
    return r * factor;
}

// ============================================================================
// J2 Oblateness Perturbation
// ============================================================================

/// J2 perturbation acceleration (Earth oblateness).
/// Reference: Vallado Eq. 8-20.
/// @param r  Position vector in ECI [km].
/// @return Acceleration vector [km/s^2].
inline Vec3 compute_j2_acceleration(const Vec3& r) {
    double r_mag = r.magnitude();
    if (r_mag < 1e-15) {
        return {0.0, 0.0, 0.0};
    }
    double r2 = r_mag * r_mag;
    double r5 = r2 * r2 * r_mag;
    double z2 = r.z * r.z;
    double ratio2 = z2 / r2;

    double coeff = -1.5 * J2 * MU_EARTH * (R_EARTH * R_EARTH) / r5;

    double ax = r.x * (1.0 - 5.0 * ratio2);
    double ay = r.y * (1.0 - 5.0 * ratio2);
    double az = r.z * (3.0 - 5.0 * ratio2);

    return {coeff * ax, coeff * ay, coeff * az};
}

// ============================================================================
// J4 Oblateness Perturbation
// ============================================================================

/// J4 perturbation acceleration (Earth oblateness, higher-order term).
/// Reference: Vallado.
/// @param r  Position vector in ECI [km].
/// @return Acceleration vector [km/s^2].
inline Vec3 compute_j4_acceleration(const Vec3& r) {
    double r_mag = r.magnitude();
    if (r_mag < 1e-15) {
        return {0.0, 0.0, 0.0};
    }
    double r2 = r_mag * r_mag;
    double r7 = r2 * r2 * r2 * r_mag;
    double z2 = r.z * r.z;
    double ratio2 = z2 / r2;
    double ratio4 = ratio2 * ratio2;

    double coeff = -(15.0 / 8.0) * J4 * MU_EARTH *
                   (R_EARTH * R_EARTH * R_EARTH * R_EARTH) / r7;

    double xy_term = 3.0 - 42.0 * ratio2 + 35.0 * ratio4;
    double z_term = 15.0 - 70.0 * ratio2 + 63.0 * ratio4;

    double ax = r.x * xy_term;
    double ay = r.y * xy_term;
    double az = r.z * z_term;

    return {coeff * ax, coeff * ay, coeff * az};
}

// ============================================================================
// Atmospheric Drag Perturbation
// ============================================================================

/// Atmospheric drag acceleration.
/// Uses a simple exponential atmosphere model:
///   rho = rho0 * exp(-(r - R_EARTH) / H)
/// where rho0 = 1.225 kg/m^3, H = 8.5 km.
/// The drag acceleration is:
///   a_drag = -0.5 * rho * Cd * (A/m) * |v_rel| * v_rel
/// where v_rel = v - v_atm and v_atm = omega_earth x r.
/// @param r    Position vector in ECI [km].
/// @param v    Velocity vector in ECI [km/s].
/// @param jd   Julian Date (unused in this simplified model, kept for
///             interface consistency).
/// @param params  PropagatorParams containing Cd and A/m.
/// @return Acceleration vector [km/s^2].
inline Vec3 compute_drag_acceleration(const Vec3& r, const Vec3& v,
                                      double jd,
                                      const PropagatorParams& params) {
    (void)jd;  // Kept for interface consistency; unused in this model.

    // Altitude above Earth's surface [km].
    double r_mag = r.magnitude();
    double altitude = r_mag - R_EARTH;

    // Altitude-dependent scale height (km).
    // ~40 km at surface, increasing with altitude.
    // At 400 km altitude, effective scale height is ~80 km.
    double scale_height = 40.0 + 0.1 * altitude;
    if (scale_height < 7.0) scale_height = 7.0;

    // Exponential atmosphere density [kg/m^3].
    double rho = RHO_0 * std::exp(-altitude / scale_height);

    // Atmospheric rotation velocity: v_atm = omega_earth x r.
    // omega_earth is along the z-axis (ECI).
    Vec3 omega = {0.0, 0.0, OMEGA_EARTH};
    Vec3 v_atm = omega.cross(r);

    // Relative velocity of the satellite with respect to the atmosphere.
    Vec3 v_rel = v - v_atm;
    double v_rel_mag = v_rel.magnitude();

    // Drag acceleration: a = -0.5 * rho * Cd * (A/m) * |v_rel| * v_rel.
    // Note: A/m is in m^2/kg, rho is in kg/m^3, so rho * (A/m) has units
    // of 1/m.  Multiply by v_rel^2 [km^2/s^2] and convert to [km/s^2]
    // by dividing by 1000 (1 m = 0.001 km), giving:
    //   a [km/s^2] = -0.5 * rho * Cd * (A/m) * v_rel_mag * v_rel / 1000
    // However, a cleaner derivation: rho [kg/m^3] * Cd * (A/m) [m^2/kg]
    // gives [1/m].  We need the result in [km/s^2].
    //   a = -0.5 * rho * Cd * (A/m) * |v_rel| * v_rel
    //   rho * (A/m) is [1/m], v_rel is [km/s], |v_rel| is [km/s]
    //   So the product is [km^2/s^2 / m].  To get [km/s^2]:
    //   multiply by 1000 m/km -> [km/s^2].
    // Actually, let's be more careful:
    //   rho [kg/m^3] * Cd [dimensionless] * A/m [m^2/kg] = [1/m]
    //   |v_rel| [km/s] * v_rel [km/s] = [km^2/s^2]
    //   Product: [km^2 / (s^2 * m)].
    //   To convert m to km: divide by 1000 (1 m = 1e-3 km).
    //   So: a [km/s^2] = -0.5 * rho * Cd * (A/m) * |v_rel| * v_rel * 1e-3
    //   But this makes drag ~1000x too large.
    // Correct approach: convert v_rel to m/s first:
    //   a [m/s^2] = -0.5 * rho * Cd * (A/m) * |v_rel_m| * v_rel_m
    //   Then convert to km/s^2: divide by 1000.
    //   a [km/s^2] = -0.5 * rho * Cd * (A/m) * |v_rel| * v_rel * (1e3 / 1e3)
    //   = -0.5 * rho * Cd * (A/m) * |v_rel| * v_rel
    // since (km/s) * (km/s) * (1/m) -> need to sort units.
    // Actually: v_rel [km/s] = 1e3 * v_rel [m/s], so |v_rel|*v_rel [km^2/s^2]
    // = 1e6 * [m^2/s^2].  And rho* Cd * (A/m) [1/m].
    // Product: 1e6 / m [km^2/(s^2 m)].  To get km/s^2, need /km:
    // multiply by 1e-3 -> 1e3 [km/s^2].
    // This is clearly wrong dimensionally. Let me just use the standard form:
    // a [m/s^2] = -0.5 * rho * Cd * (A/m) * |v_rel| * v_rel
    // where everything is in SI.  Then convert to km/s^2 (divide by 1000).
    // Convert v_rel to m/s for the computation.
    double v_rel_ms = v_rel_mag * 1000.0;  // km/s -> m/s
    double a_mag_ms2 = 0.5 * rho * params.drag_coefficient *
                       params.area_mass_ratio * v_rel_ms * v_rel_ms;
    // a_mag is in m/s^2.  Convert to km/s^2.
    double a_mag = a_mag_ms2 / 1000.0;

    // Direction is opposite to v_rel.
    if (v_rel_mag == 0.0) {
        return {0.0, 0.0, 0.0};
    }
    Vec3 v_rel_hat = v_rel / v_rel_mag;
    return v_rel_hat * (-a_mag);
}

// ============================================================================
// Solar Radiation Pressure (SRP) Perturbation
// ============================================================================

/// Solar radiation pressure acceleration.
/// Computes:
///   a_srp = -P * Cr * (A/m) * (AU^2 / |r - r_sun|^2) * unit(r - r_sun)
/// where P = 4.56e-6 N/m^2 is the solar radiation pressure at 1 AU.
/// @param r       Position vector of the satellite in ECI [km].
/// @param r_sun   Position vector of the Sun in ECI [km].
/// @param jd      Julian Date (kept for interface consistency).
/// @param params  PropagatorParams containing Cr and A/m.
/// @return Acceleration vector [km/s^2].
inline Vec3 compute_srp_acceleration(const Vec3& r, const Vec3& r_sun,
                                     double jd,
                                     const PropagatorParams& params) {
    (void)jd;  // Kept for interface consistency; unused in this model.

    // Vector from satellite to Sun.
    Vec3 r_sat_sun = r_sun - r;
    double dist = r_sat_sun.magnitude();

    if (dist == 0.0) {
        return {0.0, 0.0, 0.0};
    }

    // Scale factor: (AU / dist)^2 accounts for varying distance from Sun.
    double au_dist_ratio = AU / dist;
    double scale = au_dist_ratio * au_dist_ratio;

    // SRP acceleration magnitude.
    // P [N/m^2] * Cr [dimensionless] * A/m [m^2/kg]
    //   = [N/kg] = [m/s^2]
    //   convert to [km/s^2] by dividing by 1000.
    // Scale by (AU/dist)^2 for distance correction.
    double a_mag = SRP_PRESSURE * params.srp_coefficient * params.area_mass_ratio *
                   scale / 1000.0;

    // Direction: from satellite toward Sun.
    Vec3 direction = r_sat_sun / dist;

    // SRP pushes the satellite AWAY from the Sun. The direction vector
    // r_sat_sun = (r_sun - r_sat) points from satellite toward Sun, so
    // we negate it to get the acceleration away from Sun.
    return direction * (-a_mag);
}

// ============================================================================
// Third-Body Gravitational Perturbation (Differential Gravity)
// ============================================================================

/// Third-body gravitational perturbation (tidal/differential acceleration).
/// Computes:
///   a_3rd = -mu_3rd * [r_3 / |r_3|^3 - (r_3 - r) / |r_3 - r|^3]
/// where r_3 is the position of the third body and r is the satellite.
/// @param r          Position vector of the satellite in ECI [km].
/// @param r_third    Position vector of the third body in ECI [km].
/// @param mu_third   Gravitational parameter of the third body [km^3/s^2].
/// @return Acceleration vector [km/s^2].
inline Vec3 compute_third_body_acceleration(const Vec3& r,
                                            const Vec3& r_third,
                                            double mu_third) {
    // Distance from Earth center to third body.
    double r3_mag = r_third.magnitude();
    double r3_cubed = r3_mag * r3_mag * r3_mag;

    // Vector from satellite to third body.
    Vec3 delta = r_third - r;
    double delta_mag = delta.magnitude();
    double delta_cubed = delta_mag * delta_mag * delta_mag;

    if (r3_cubed == 0.0 || delta_cubed == 0.0) {
        return {0.0, 0.0, 0.0};
    }

    // a = -mu_3rd * (r_3 / r_3^3 - (r_3 - r) / |r_3 - r|^3)
    Vec3 term1 = r_third / r3_cubed;
    Vec3 term2 = delta / delta_cubed;

    return (term1 - term2) * (-mu_third);
}

// ============================================================================
// Simplified Sun Position (Low-Precision Analytical)
// ============================================================================

/// Simplified Sun position in the ECI (GCRF) frame.
/// Uses a low-precision analytical solution valid to ~1 degree accuracy
/// over short time spans.  Sufficient for SRP and third-body calculations.
/// Reference: Vallado, "Fundamentals of Astrodynamics and Applications",
///            Chapter 5 (simplified series).
/// @param jd  Julian Date.
/// @return Sun position vector in ECI [km].
inline Vec3 compute_sun_position(double jd) {
    // Julian centuries since J2000.0.
    double t = (jd - JD_J2000) / 36525.0;

    // Mean longitude of the Sun [rad] (modified to [0, 2*pi]).
    double lambda_sun = 280.460 + 36000.77 * t;
    lambda_sun = std::fmod(lambda_sun, 360.0);
    if (lambda_sun < 0.0) {
        lambda_sun += 360.0;
    }
    double lambda_rad = lambda_sun * DEG_TO_RAD;

    // Mean anomaly of the Sun [rad].
    double M_sun = 357.528 + 35999.05 * t;
    M_sun = std::fmod(M_sun, 360.0);
    if (M_sun < 0.0) {
        M_sun += 360.0;
    }
    double M_rad = M_sun * DEG_TO_RAD;

    // Ecliptic longitude of the Sun [rad].
    double ecliptic_lon = lambda_rad + (1.915 * std::sin(M_rad) +
                           0.020 * std::sin(2.0 * M_rad)) * DEG_TO_RAD;

    // Obliquity of the ecliptic [rad].
    double obliquity = (23.439 - 0.013 * t) * DEG_TO_RAD;

    // Distance from Earth to Sun [km].
    double r_sun = AU * (1.00014 - 0.01671 * std::cos(M_rad) -
                         0.00014 * std::cos(2.0 * M_rad));

    // Convert ecliptic to equatorial (ECI) coordinates.
    double x = r_sun * std::cos(ecliptic_lon);
    double y = r_sun * std::cos(obliquity) * std::sin(ecliptic_lon);
    double z = r_sun * std::sin(obliquity) * std::sin(ecliptic_lon);

    return {x, y, z};
}

// ============================================================================
// Simplified Moon Position (Low-Precision Analytical)
// ============================================================================

/// Simplified Moon position in the ECI (GCRF) frame.
/// Uses a low-precision analytical solution valid to ~1 degree / 200 km
/// accuracy.  Sufficient for third-body perturbation calculations.
/// Reference: Vallado, "Fundamentals of Astrodynamics and Applications",
///            Chapter 5 (simplified lunar theory).
/// @param jd  Julian Date.
/// @return Moon position vector in ECI [km].
inline Vec3 compute_moon_position(double jd) {
    // Julian centuries since J2000.0.
    double t = (jd - JD_J2000) / 36525.0;

    // Mean longitude of the Moon [deg].
    double L_prime = 218.32 + 481267.8813 * t;
    L_prime = std::fmod(L_prime, 360.0);
    if (L_prime < 0.0) {
        L_prime += 360.0;
    }
    double L_rad = L_prime * DEG_TO_RAD;

    // Mean anomaly of the Moon [deg].
    double M_moon = 134.963 + 477198.8676 * t;
    M_moon = std::fmod(M_moon, 360.0);
    if (M_moon < 0.0) {
        M_moon += 360.0;
    }
    double M_moon_rad = M_moon * DEG_TO_RAD;

    // Mean anomaly of the Sun [deg].
    double M_sun_deg = 357.528 + 35999.05 * t;
    M_sun_deg = std::fmod(M_sun_deg, 360.0);
    if (M_sun_deg < 0.0) {
        M_sun_deg += 360.0;
    }
    double M_sun_rad = M_sun_deg * DEG_TO_RAD;

    // Moon's mean argument of latitude [deg].
    double F = 93.272 + 483202.0175 * t;
    F = std::fmod(F, 360.0);
    if (F < 0.0) {
        F += 360.0;
    }
    double F_rad = F * DEG_TO_RAD;

    // Ecliptic longitude [rad].
    double delta_lon = (0.0001 * (-1.274 * std::sin(M_moon_rad - 2.0 * F_rad) +
                                  0.658 * std::sin(2.0 * F_rad) +
                                  0.213 * std::sin(2.0 * M_moon_rad) -
                                  0.186 * std::sin(M_sun_rad) -
                                  0.114 * std::sin(2.0 * M_moon_rad - 2.0 * F_rad)));
    double lambda_moon = L_rad + delta_lon;

    // Ecliptic latitude [rad].
    double beta = 0.0001 * (5.128 * std::sin(F_rad) +
                            0.281 * std::sin(M_moon_rad + F_rad) +
                            0.278 * std::sin(M_moon_rad - F_rad));

    // Obliquity of the ecliptic [rad].
    double obliquity = (23.439 - 0.013 * t) * DEG_TO_RAD;

    // Distance from Earth center to Moon [km].
    double r_moon = 385000.0 - 20900.0 * std::cos(M_moon_rad) -
                    3700.0 * std::cos(2.0 * F_rad) -
                    1000.0 * std::cos(M_moon_rad - 2.0 * F_rad);

    // Convert ecliptic to equatorial (ECI) coordinates.
    double cos_beta = std::cos(beta);
    double x = r_moon * (std::cos(lambda_moon) * cos_beta);
    double y = r_moon * (std::sin(lambda_moon) * std::cos(obliquity) * cos_beta -
                         std::sin(beta) * std::sin(obliquity));
    double z = r_moon * (std::sin(lambda_moon) * std::sin(obliquity) * cos_beta +
                         std::sin(beta) * std::cos(obliquity));

    return {x, y, z};
}

// ============================================================================
// Total Acceleration (All Enabled Force Models)
// ============================================================================

/// Compute the total acceleration from all enabled force models.
/// Starts with two-body gravity, then adds perturbation terms based on
/// the flags in PropagatorParams.
/// @param r      Position vector in ECI [km].
/// @param v      Velocity vector in ECI [km/s].
/// @param jd     Julian Date of the current epoch.
/// @param params Propagation parameters controlling which models are active.
/// @return Total acceleration vector [km/s^2].
inline Vec3 compute_total_acceleration(const Vec3& r, const Vec3& v,
                                       double jd,
                                       const PropagatorParams& params) {
    // Start with two-body gravity.
    Vec3 a_total = compute_two_body_acceleration(r);

    // Add J2 perturbation if enabled.
    if (params.use_j2) {
        a_total += compute_j2_acceleration(r);
    }

    // Add J4 perturbation if enabled.
    if (params.use_j4) {
        a_total += compute_j4_acceleration(r);
    }

    // Add atmospheric drag if enabled.
    if (params.use_drag) {
        a_total += compute_drag_acceleration(r, v, jd, params);
    }

    // Add solar radiation pressure if enabled.
    if (params.use_srp) {
        Vec3 r_sun = compute_sun_position(jd);
        a_total += compute_srp_acceleration(r, r_sun, jd, params);
    }

    // Add third-body perturbations (Sun + Moon) if enabled.
    if (params.use_third_body) {
        Vec3 r_sun = compute_sun_position(jd);
        Vec3 r_moon = compute_moon_position(jd);
        a_total += compute_third_body_acceleration(r, r_sun, MU_SUN);
        a_total += compute_third_body_acceleration(r, r_moon, MU_MOON);
    }

    return a_total;
}

}  // namespace orbit
