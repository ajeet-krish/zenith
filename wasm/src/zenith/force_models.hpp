#pragma once

/// @file force_models.hpp
/// @brief Perturbation force models for numerical orbit propagation.
///        Provides individual force accelerations (two-body, J2, J4, drag,
///        SRP, third-body), a combined total acceleration function for use
///        with RK4/RK45 integrators, and analytic Jacobians (da/dr) for
///        the two-body, J2, and drag forces used by the variational
///        (STM) propagators in the orbit-determination suite.
///
///        Drag uses Helio's Vallado Table 8-4 single-layer exponential
///        atmosphere (see od_constants.hpp) for golden-master parity.

#include "od_constants.hpp"
#include "matrix_ops.hpp"
#include "orbit_types.hpp"

#include <cmath>
#include <stdexcept>
#include <tuple>
#include <utility>

namespace orbit {

// ============================================================================
// Constants for force models
// ============================================================================

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

/// Analytic Jacobian of the two-body acceleration, da/dr (3x3).
///
///   da_i/dx_j = -mu * (delta_ij / r^3 - 3 * x_i * x_j / r^5)
///
/// @param r   Position vector in ECI [km].
/// @param mu  Gravitational parameter [km^3/s^2]. Defaults to MU_EARTH.
/// @return Jacobian matrix, units s^-2.
inline Mat3d two_body_jacobian(const Vec3& r, double mu = MU_EARTH) {
    const double r_mag = r.magnitude();
    if (r_mag < 1e-15) {
        return Mat3d{};
    }
    const double r3 = r_mag * r_mag * r_mag;
    const double r5 = r3 * r_mag * r_mag;
    const double x[3] = {r.x, r.y, r.z};

    Mat3d jac;
    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 3; ++j) {
            const double delta_ij = (i == j) ? 1.0 : 0.0;
            jac(i, j) = -mu * (delta_ij / r3 - 3.0 * x[i] * x[j] / r5);
        }
    }
    return jac;
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

/// J2 acceleration and its analytic 3x3 Jacobian da/dr.
///
/// Matches helio_ob forces.j2_accel_and_jacobian (Waltz / Vallado Eq 8-20
/// derivative form).
///
/// @param r  Position vector in ECI [km].
/// @return Pair (accel [km/s^2], jac [s^-2]).
inline std::pair<Vec3, Mat3d> j2_accel_and_jacobian(const Vec3& r) {
    const double x = r.x;
    const double y = r.y;
    const double z = r.z;
    const double r2 = x * x + y * y + z * z;
    const double r_mag = std::sqrt(r2);
    const double r7 = r_mag * r_mag * r_mag * r_mag *
                      r_mag * r_mag * r_mag;
    const double r9 = r7 * r2;
    const double k = -1.5 * J2 * MU_EARTH * (R_EARTH * R_EARTH);
    const double g = r2 - 5.0 * z * z;
    const double h = 3.0 * r2 - 5.0 * z * z;

    const Vec3 accel(k * x * g / r7, k * y * g / r7, k * z * h / r7);

    Mat3d jac;
    jac(0, 0) = k * (g / r7 + 2.0 * x * x / r7 - 7.0 * x * x * g / r9);
    jac(1, 1) = k * (g / r7 + 2.0 * y * y / r7 - 7.0 * y * y * g / r9);
    jac(2, 2) = k * (h / r7 - 4.0 * z * z / r7 - 7.0 * z * z * h / r9);
    jac(0, 1) = k * x * y * (2.0 / r7 - 7.0 * g / r9);
    jac(1, 0) = jac(0, 1);
    jac(0, 2) = k * x * z * (-8.0 / r7 - 7.0 * g / r9);
    jac(2, 0) = jac(0, 2);
    jac(1, 2) = k * y * z * (-8.0 / r7 - 7.0 * g / r9);
    jac(2, 1) = jac(1, 2);
    return {accel, jac};
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

/// Atmospheric density [kg/m^3] at a position.
///
/// Vallado Table 8-4 single-layer exponential model (helio_ob parity):
///   rho(h) = RHO0 * exp(-(h - H0_KM) / H_SCALE_KM)
/// with h = |r| - R_EARTH.  The exponent is capped at MAX_EXPONENT so
/// non-physical states deep inside the Earth cannot overflow exp().
///
/// @param r  Position vector in ECI [km].
/// @return Mass density [kg/m^3].
inline double atmospheric_density(const Vec3& r) {
    const double altitude_km = r.magnitude() - R_EARTH;
    double exponent = (H0_KM - altitude_km) / H_SCALE_KM;
    if (exponent > MAX_EXPONENT) {
        exponent = MAX_EXPONENT;
    }
    return RHO0 * std::exp(exponent);
}

/// Co-rotating atmosphere velocity in ECI, v_atm = omega_earth x r.
///
/// @param r  Position vector in ECI [km].
/// @return Atmosphere velocity [km/s].
inline Vec3 atmosphere_velocity_eci(const Vec3& r) {
    return Vec3(0.0, 0.0, OMEGA_EARTH).cross(r);
}

/// Atmospheric drag acceleration (Helio drag.drag_accel parity).
///
///   a_drag = -0.5 * rho * Cd * (A/m) * |v_rel| * v_rel
///
/// with v_rel = v - omega_earth x r against a co-rotating atmosphere.
/// Density is converted to kg/km^3 and (A/m) is converted from m^2/kg to
/// km^2/kg so the result is km/s^2.
///
/// @param r       Position vector in ECI [km].
/// @param v       Velocity vector in ECI [km/s].
/// @param params  Drag parameters (area-to-mass ratio and Cd).
/// @return Drag acceleration vector [km/s^2].
inline Vec3 drag_acceleration(const Vec3& r, const Vec3& v,
                              const DragParams& params) {
    const double rho = atmospheric_density(r) * KG_M3_TO_KG_KM3;
    const Vec3 v_rel = v - atmosphere_velocity_eci(r);
    const double speed = v_rel.magnitude();
    const double factor = 0.5 * rho * params.cd *
                          params.a_over_m_km2_kg * speed;
    return v_rel * (-factor);
}

/// Atmospheric drag acceleration from PropagatorParams (keeps the legacy
/// interface used by compute_total_acceleration).
///
/// @param r       Position vector in ECI [km].
/// @param v       Velocity vector in ECI [km/s].
/// @param jd      Julian Date (unused in this model, kept for interface
///                consistency).
/// @param params  PropagatorParams containing Cd and A/m [m^2/kg].
/// @return Drag acceleration vector [km/s^2].
inline Vec3 compute_drag_acceleration(const Vec3& r, const Vec3& v,
                                      double jd,
                                      const PropagatorParams& params) {
    (void)jd;  // Kept for interface consistency; unused in this model.
    DragParams drag = DragParams::from_m2_per_kg(params.area_mass_ratio,
                                                 params.drag_coefficient);
    return drag_acceleration(r, v, drag);
}

/// Drag acceleration with analytic Jacobians da/dr and da/dCd.
///
/// With a = -k(r) * s * v_rel (k = 0.5 * rho(r) * Cd * (A/m) in km units,
/// s = |v_rel|):
///
///   da/dr  = -(k * s * v_rel (dln rho/dr)^T + k * v_rel (ds/dr)^T
///              + k * s * M)
///   da/dCd = a / Cd        (drag is exactly linear in Cd)
///
/// where M = dv_rel/dr = -[omega_E]_x, dln rho/dr = -r / (|r| H_SCALE_KM),
/// and ds/dr = -M v_rel / s.  Matches helio_ob drag.drag_accel_and_jacobian.
///
/// @param r       Position vector in ECI [km].
/// @param v       Velocity vector in ECI [km/s].
/// @param params  Drag parameters (area-to-mass ratio and Cd).
/// @return Tuple (accel [km/s^2], da_dr [s^-1], da_dcd [km/s^2 per Cd]).
/// @throws std::invalid_argument if Cd is zero (da/dCd = a / Cd undefined).
inline std::tuple<Vec3, Mat3d, Vec3> drag_accel_and_jacobian(
    const Vec3& r, const Vec3& v, const DragParams& params) {
    if (params.cd == 0.0) {
        throw std::invalid_argument(
            "drag_accel_and_jacobian requires a nonzero Cd");
    }

    const Vec3 v_rel = v - atmosphere_velocity_eci(r);
    const double rho_km = atmospheric_density(r) * KG_M3_TO_KG_KM3;
    const double speed = v_rel.magnitude();
    const double k = 0.5 * rho_km * params.cd * params.a_over_m_km2_kg;
    const Vec3 accel = v_rel * (-k * speed);

    // dln rho/dr = -r / (|r| * H_SCALE_KM).
    const double r_norm = r.magnitude();
    const double inv_rh = -1.0 / (r_norm * H_SCALE_KM);
    const double dln_rho_dr[3] = {r.x * inv_rh, r.y * inv_rh, r.z * inv_rh};

    // M = dv_rel/dr = -[omega_E]_x (constant skew matrix).
    // [omega]_x = [[0, -w, 0], [w, 0, 0], [0, 0, 0]] so
    // M = [[0, w, 0], [-w, 0, 0], [0, 0, 0]].
    const double m[3][3] = {{0.0, OMEGA_EARTH, 0.0},
                            {-OMEGA_EARTH, 0.0, 0.0},
                            {0.0, 0.0, 0.0}};

    // ds/dr = -M v_rel / s.
    double m_v_rel[3] = {0.0, 0.0, 0.0};
    for (int i = 0; i < 3; ++i) {
        m_v_rel[i] = m[i][0] * v_rel.x + m[i][1] * v_rel.y + m[i][2] * v_rel.z;
    }
    const double inv_speed = 1.0 / speed;
    const double ds_dr[3] = {-m_v_rel[0] * inv_speed,
                             -m_v_rel[1] * inv_speed,
                             -m_v_rel[2] * inv_speed};

    const double v_rel3[3] = {v_rel.x, v_rel.y, v_rel.z};

    // da/dr = -(k s v_rel (dln rho/dr)^T + k v_rel (ds/dr)^T + k s M).
    Mat3d da_dr;
    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 3; ++j) {
            da_dr(i, j) = -(k * speed * v_rel3[i] * dln_rho_dr[j]
                            + k * v_rel3[i] * ds_dr[j]
                            + k * speed * m[i][j]);
        }
    }

    const Vec3 da_dcd = accel * (1.0 / params.cd);
    return {accel, da_dr, da_dcd};
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

// ============================================================================
// Combined Force Jacobians (Two-Body + J2 [+ Drag])
// ============================================================================

/// Combined two-body plus J2 acceleration and analytic 3x3 Jacobian da/dr.
///
/// The Helio-parity core used by the variational (STM) propagators.
/// Matches helio_ob forces.combined_accel_and_jacobian.
///
/// @param r  Position vector in ECI [km].
/// @return Pair (accel [km/s^2], jac [s^-2]).
inline std::pair<Vec3, Mat3d> combined_accel_and_jacobian(const Vec3& r) {
    const Vec3 accel_tb = compute_two_body_acceleration(r);
    const Mat3d jac_tb = two_body_jacobian(r);
    auto [accel_j2, jac_j2] = j2_accel_and_jacobian(r);
    return {accel_tb + accel_j2, jac_tb + jac_j2};
}

/// Combined acceleration and Jacobian with optional drag, driven by
/// PropagatorParams (legacy fields) plus an explicit use_drag switch.
///
/// Starts from two-body + J2 (if params.use_j2), then adds drag when
/// use_drag is true (drag parameters come from params.area_mass_ratio
/// [m^2/kg] and params.drag_coefficient).  SRP and third-body are not
/// part of the Phase 1 OD force tier set.
///
/// @param r         Position vector in ECI [km].
/// @param v         Velocity vector in ECI [km/s].
/// @param params    PropagatorParams (use_j2 flag, Cd, A/m).
/// @param use_drag  Whether to include atmospheric drag.
/// @return Pair (accel [km/s^2], jac [s^-2]).
inline std::pair<Vec3, Mat3d> combined_accel_and_jacobian(
    const Vec3& r, const Vec3& v,
    const PropagatorParams& params,
    bool use_drag) {
    auto [accel, jac] = combined_accel_and_jacobian(r);
    if (!params.use_j2) {
        // Recompute as two-body only (rare path; clarity over speed).
        accel = compute_two_body_acceleration(r);
        jac = two_body_jacobian(r);
    }
    if (use_drag) {
        DragParams drag = DragParams::from_m2_per_kg(params.area_mass_ratio,
                                                     params.drag_coefficient);
        auto [a_drag, da_dr, da_dcd] = drag_accel_and_jacobian(r, v, drag);
        (void)da_dcd;
        accel += a_drag;
        jac += da_dr;
    }
    return {accel, jac};
}

}  // namespace orbit
