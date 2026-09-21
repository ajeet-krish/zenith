#pragma once

/// @file sgp4_propagator.hpp
/// @brief SGP4/SDP4 analytical orbit propagator for Earth-orbiting satellites.
///        Implements the simplified general perturbations model as described in
///        Vallado et al., "Revisiting Spacetrack Report #3", AIAA 2006-6753.
///
///        SGP4 handles near-Earth objects (period < 225 min).  SDP4 handles
///        deep-space objects (period >= 225 min).  Both share the same
///        propagation framework; the deep-space variant adds resonance and
///        lunisolar perturbation terms.
///
///        Output is in the TEME (True Equator Mean Equinox) frame, which is
///        the standard reference frame for SGP4/SDP4 as defined by NORAD.
///
/// References:
///   - Vallado, Crawford, Hujsak, Kelso, "Revisiting Spacetrack Report #3",
///     AIAA 2006-6753, 2006.
///   - Hoots, Roehrich, "Spacetrack Report #3", 1980.
///   - Vallado, "Fundamentals of Astrodynamics and Applications", 4th ed.
///
/// Conventions:
///   - All internal distances in Earth radii (R_EARTH = 6378.137 km).
///   - All internal times in minutes.
///   - Mean motion in rad/min.
///   - Output position in km, velocity in km/s.

#include <cmath>
#include <algorithm>
#include <limits>

#include "orbit_types.hpp"
#include "coordinate_frames.hpp"
#include "sgp4_parser.hpp"
#include "time_system.hpp"

namespace orbit {

// ============================================================================
// SGP4 Constants
// ============================================================================

/// Mean-motion constant: XKE = sqrt(mu * 3600 / R_EARTH^3) [Earth radii/min].
/// Converts mu from km^3/s^2 to Earth radii^3/min^2, then takes sqrt.
inline const double XKE =
    std::sqrt(MU_EARTH * 3600.0 / (R_EARTH * R_EARTH * R_EARTH));

/// Earth J3 zonal harmonic coefficient (dimensionless).
inline constexpr double J3_SGP4 = -2.53881e-6;

/// CK2 = J2 / 2 (dimensionless).
inline constexpr double CK2 = 0.5 * J2;

/// CK4 = -3/8 * J4 (dimensionless).
inline constexpr double CK4 = -0.375 * J4;

/// SGP4 perigee altitude threshold [km], converted to Earth radii.
/// Used to detect very low perigee orbits where SGP4 adjusts coefficients.
inline constexpr double S_PERIGEE = 78.0 / R_EARTH;

/// QOMS24 = ((120 - 78) / R_EARTH)^4.  Perigee-dependent coefficient.
inline const double QOMS24 = std::pow((120.0 - 78.0) / R_EARTH, 4.0);

/// Minutes per day.
inline constexpr double MINUTES_PER_DAY = 1440.0;

/// Deep-space period threshold [minutes].
/// Orbits with period >= this use SDP4 (deep-space) algorithms.
inline constexpr double DEEP_SPACE_PERIOD = 225.0;

/// Two-thirds constant for semi-major axis computation.
inline constexpr double TWO_THIRDS = 2.0 / 3.0;

/// Conversion factor: Earth radii/min -> km/s.
/// 1 Earth radius/min = R_EARTH km / 60 s = R_EARTH/60 km/s.
inline constexpr double RE_PER_MIN_TO_KM_PER_SEC = R_EARTH / 60.0;

// ============================================================================
// Internal Helper: Kepler Equation Solver
// ============================================================================

/// Solve Kepler's equation M = E - e*sin(E) for eccentric anomaly E.
///
/// Uses Newton-Raphson iteration with a robust initial guess.
///
/// @param M   Mean anomaly [rad], normalized to [0, 2*PI].
/// @param e   Eccentricity [0, 1).
/// @return Eccentric anomaly E [rad] in [0, 2*PI].
inline double solve_kepler_sgp4(double M, double e) {
    // Normalize M to [0, 2*PI].
    M = std::fmod(M, TWO_PI);
    if (M < 0.0) {
        M += TWO_PI;
    }

    // Initial guess: E0 = M + e*sin(M) for moderate e.
    double E = M + e * std::sin(M);

    // Newton-Raphson iteration (max 20 iterations, tolerance ~1e-12).
    for (int iter = 0; iter < 20; ++iter) {
        double sin_E = std::sin(E);
        double cos_E = std::cos(E);
        double f  = E - e * sin_E - M;
        double fp = 1.0 - e * cos_E;
        double dE = f / fp;
        E -= dE;
        if (std::abs(dE) < 1e-12) {
            break;
        }
    }

    // Normalize result to [0, 2*PI].
    E = std::fmod(E, TWO_PI);
    if (E < 0.0) {
        E += TWO_PI;
    }

    return E;
}

// ============================================================================
// SGP4Propagator Class
// ============================================================================

class SGP4Propagator {
public:
    SGP4Propagator() = default;

    /// Initialize the propagator from a parsed TLE.
    ///
    /// Converts TLE elements from Kozai mean elements to internal Brouwer
    /// mean elements and pre-computes all perturbation coefficients.
    ///
    /// @param tle  Parsed TLE data.
    void init(const TLEData& tle);

    /// Propagate to a given Julian Date.
    ///
    /// Computes position and velocity in the TEME frame.
    ///
    /// @param jd  Target epoch as Julian Date (UTC).
    /// @return State vector in TEME frame [km, km/s].
    [[nodiscard]] StateVector propagate(double jd) const;

    /// Get Keplerian elements at a given Julian Date.
    ///
    /// Converts the TEME state vector to classical orbital elements.
    ///
    /// @param jd  Target epoch as Julian Date.
    /// @return Classical orbital elements.
    [[nodiscard]] KeplerianElements get_elements(double jd) const;

    /// Check if the orbit is deep-space (period >= 225 min).
    [[nodiscard]] bool is_deep_space() const { return m_is_deep_space; }

    /// Get the TLE epoch as Julian Date.
    [[nodiscard]] double epoch_jd() const { return m_jd_epoch; }

    /// Get the mean motion at epoch [rad/min].
    [[nodiscard]] double mean_motion() const { return m_n0; }

private:
    // == Epoch ==
    double m_jd_epoch = 0.0;

    // == Original (Kozai) orbital elements from TLE ==
    double m_no_kozai = 0.0;    ///< Mean motion [rad/min].
    double m_ecco = 0.0;        ///< Eccentricity (dimensionless).
    double m_inclo = 0.0;       ///< Inclination [rad].
    double m_nodeo = 0.0;       ///< RAAN [rad].
    double m_argpo = 0.0;       ///< Argument of perigee [rad].
    double m_mo = 0.0;          ///< Mean anomaly [rad].
    double m_bstar = 0.0;       ///< B* drag term [1/Earth radii].

    // == Corrected (Brouwer) mean elements ==
    double m_aodp = 0.0;        ///< Osculating semi-major axis at epoch [Earth radii].
    double m_argpp = 0.0;       ///< Corrected argument of perigee [rad].
    double m_nodepp = 0.0;      ///< Corrected RAAN [rad].
    double m_n0 = 0.0;          ///< Corrected mean motion [rad/min].

    // == Pre-computed trigonometric quantities ==
    double m_cosio = 0.0;       ///< cos(inclination).
    double m_sinio = 0.0;       ///< sin(inclination).
    double m_omeosq = 0.0;      ///< 1 - e^2.
    double m_eosq = 0.0;        ///< e^2.
    double m_betao = 0.0;       ///< sqrt(1 - e^2).
    double m_betao2 = 0.0;      ///< 1 - e^2.
    double m_theta2 = 0.0;      ///< cos^2(i).
    double m_x3thm1 = 0.0;     ///< 3*cos^2(i) - 1.
    double m_x1m5th = 0.0;     ///< 1 - 5*cos^2(i).
    double m_x1m3th = 0.0;     ///< 1 - 3*cos^2(i).
    double m_x7thm1 = 0.0;     ///< 7*cos^2(i) - 1.

    // == Perturbation coefficients ==
    double m_c1 = 0.0;          ///< B* drag coefficient (mean motion rate).
    double m_c2 = 0.0;          ///< Drag coefficient (eccentricity rate).
    double m_c3 = 0.0;          ///< Drag coefficient (argument of perigee rate).
    double m_c4 = 0.0;          ///< Drag coefficient (mean motion rate, 2nd order).
    double m_c5 = 0.0;          ///< Drag coefficient (mean motion rate, 3rd order).
    double m_d2 = 0.0;          ///< Second-order drag coefficient.
    double m_d3 = 0.0;          ///< Third-order drag coefficient.
    double m_d4 = 0.0;          ///< Fourth-order drag coefficient.
    double m_delmo = 0.0;       ///< Mean anomaly correction factor.
    double m_mojfr = 0.0;       ///< Mean anomaly J2 rate factor.
    double m_xmcof = 0.0;       ///< Mean anomaly coefficient for drag secular.
    double m_eta = 0.0;         ///< Eccentricity factor for secular perturbations.

    // == Deep-space flag ==
    bool m_is_deep_space = false;

    // == Internal methods ==

    /// Perform SGP4/SDP4 initialization (compute all coefficients from
    /// the Kozai mean elements).
    void sgp4_init();

    /// Core SGP4 propagation algorithm.
    ///
    /// @param tsince_min  Time since epoch [minutes].
    /// @return State vector in TEME frame [km, km/s].
    StateVector sgp4_core(double tsince_min) const;
};

// ============================================================================
// SGP4 Propagator Implementation
// ============================================================================

inline void SGP4Propagator::init(const TLEData& tle) {
    // == Store raw TLE elements ==
    m_ecco = tle.ecc;
    m_bstar = tle.bstar;

    // == Convert 2-digit epoch year to 4-digit ==
    int year = tle.epoch_year;
    if (year < 57) {
        year += 2000;
    } else {
        year += 1900;
    }

    // == Convert day-of-year to month/day for jday() ==
    int day_of_year = static_cast<int>(tle.epoch_day);
    double day_frac = tle.epoch_day - static_cast<double>(day_of_year);

    // Day-of-year to month/day conversion.
    static constexpr int DAYS_IN_MONTH[] = {
        0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31
    };
    bool leap = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
    int month = 1;
    int remaining = day_of_year;
    for (int m = 1; m <= 12; ++m) {
        int days_in_m = DAYS_IN_MONTH[m];
        if (m == 2 && leap) {
            days_in_m = 29;
        }
        if (remaining <= days_in_m) {
            month = m;
            break;
        }
        remaining -= days_in_m;
    }
    int day = remaining;

    // == Compute Julian Date of epoch ==
    m_jd_epoch = jday(year, month, day, 0, 0, 0.0) + day_frac;

    // == Convert angles to radians ==
    m_inclo = tle.inc_deg * DEG_TO_RAD;
    m_nodeo = tle.raan_deg * DEG_TO_RAD;
    m_argpo = tle.argp_deg * DEG_TO_RAD;
    m_mo    = tle.mean_anomaly_deg * DEG_TO_RAD;

    // == Mean motion [rev/day] -> [rad/min] ==
    m_no_kozai = tle.mean_motion_rev_day * TWO_PI / MINUTES_PER_DAY;

    sgp4_init();
}

// ---------------------------------------------------------------------------
// SGP4 Initialization
// ---------------------------------------------------------------------------
//
// This routine converts the Kozai mean elements stored in the TLE to
// internal Brouwer mean elements and computes all perturbation coefficients
// needed by the SGP4/SDP4 propagation algorithms.
//
// Reference: Vallado et al., "Revisiting Spacetrack Report #3", 2006,
//            Appendix D (SGP4/SDP4 initialization).

inline void SGP4Propagator::sgp4_init() {
    // == Pre-compute trigonometric quantities ==
    m_cosio  = std::cos(m_inclo);
    m_sinio  = std::sin(m_inclo);
    m_theta2 = m_cosio * m_cosio;
    m_x3thm1 = 3.0 * m_theta2 - 1.0;
    m_x1m5th = 1.0 - 5.0 * m_theta2;
    m_x1m3th = 1.0 - 3.0 * m_theta2;
    m_x7thm1 = 7.0 * m_theta2 - 1.0;

    m_eosq    = m_ecco * m_ecco;
    m_omeosq  = 1.0 - m_eosq;
    m_betao2  = m_omeosq;
    m_betao   = std::sqrt(m_betao2);

    // == Corrected mean motion and semi-major axis ==
    //
    // The TLE stores "Kozai" mean elements which include J2 short-period
    // perturbations.  We convert to "Brouwer" mean elements by iterating
    // on the semi-major axis correction.
    //
    // First-order approximation:
    //   a1 = (XKE / no_kozai)^(2/3)
    //   d1 = (3/2) * CK2 * (3*cos^2(i) - 1) / (a1^2 * (1-e^2)^2)
    //   del = d1 / no_kozai^2
    //   a0 = a1 * (1 - del)
    //   no = no_kozai / (1 + del)

    double a1 = std::pow(XKE / m_no_kozai, TWO_THIRDS);

    double d1 = 1.5 * CK2 * m_x3thm1 /
                (a1 * a1 * m_omeosq * m_omeosq);
    double del0 = d1 / (m_no_kozai * m_no_kozai);
    double a0   = a1 * (1.0 - del0);

    // Second-order correction.
    del0 = d1 / (a0 * a0);

    // Corrected mean motion and semi-major axis.
    m_n0   = m_no_kozai / (1.0 + del0);
    m_aodp = std::pow(XKE / m_n0, TWO_THIRDS);

    // == Perigee-dependent adjustments ==
    //
    // For very low perigee orbits (perigee altitude < 156 km), the
    // SGP4 model adjusts the s4 and qoms24 constants to maintain
    // numerical accuracy.

    double s4    = S_PERIGEE;
    double qoms24 = QOMS24;

    double perigee_alt = (m_aodp * (1.0 - m_ecco) - 1.0) * R_EARTH;
    if (perigee_alt < 156.0) {
        s4 = 1.0 + 12.0 / (m_aodp * (1.0 - m_ecco) - 1.0);
        qoms24 = std::pow((120.0 / R_EARTH - s4), 4.0);
        s4 = s4 / R_EARTH;
    }

    // == Semi-empirical coefficients ==
    //
    // These combine the drag term (B*), the atmospheric model, and the
    // gravitational harmonics into a set of coefficients used during
    // propagation.

    double pinvsq = 1.0 / (m_aodp * m_aodp * m_omeosq * m_omeosq);

    double coef1 = qoms24 * pinvsq * pinvsq * m_n0;
    double coef2 = coef1 * pinvsq;

    // c1: primary drag coefficient (mean motion secular rate).
    m_c1 = m_bstar * coef1 * (1.0 + 1.5 * m_betao2 * CK2 * pinvsq *
           (1.0 + 3.75 * m_betao2 * CK2 * pinvsq));

    // c2: eccentricity secular rate coefficient.
    m_c2 = coef1 * m_n0 * m_aodp * m_omeosq *
           (CK2 * pinvsq * (1.5 + 7.5 * CK2 * pinvsq *
            (1.0 + 1.875 * CK2 * pinvsq)) +
            CK4 * pinvsq * pinvsq *
            (3.0 + 8.25 * CK2 * pinvsq));

    // c3: argument of perigee secular rate coefficient.
    m_c3 = coef1 * pinvsq * m_aodp * m_omeosq *
           CK2 * pinvsq * m_ecco * m_ecco * m_betao;

    // c4: mean motion rate coefficient (2nd order drag).
    m_c4 = 2.0 * coef2 * m_aodp * m_omeosq *
           (m_n0 * m_aodp * pinvsq *
            (2.0 + 5.0 * m_betao2 * CK2 * pinvsq) +
            CK2 * pinvsq * (3.0 + 5.0 * m_betao2) * 0.25);

    // c5: mean motion rate coefficient (3rd order drag).
    m_c5 = 2.0 * coef2 * m_aodp * m_omeosq *
           (1.0 + (2.0 + 5.0 * m_betao2) * CK2 * pinvsq);

    // d2, d3, d4: higher-order drag coefficients.
    m_d2 = coef1 * 4.0 * m_aodp * pinvsq *
           (m_n0 * m_aodp *
            (1.0 + 2.5 * m_betao2 * CK2 * pinvsq) +
            CK2 * pinvsq * (2.0 + m_betao2));

    m_d3 = coef1 * (4.0 / 3.0) * m_aodp * m_aodp *
           pinvsq * pinvsq *
           (m_n0 * m_aodp *
            (3.0 + 7.0 * m_betao2 * CK2 * pinvsq) +
            CK2 * pinvsq * (3.0 + 7.0 * m_betao2));

    m_d4 = coef2 * (2.0 / 3.0) * m_aodp * m_aodp * m_aodp *
           pinvsq * pinvsq * m_n0 *
           (m_n0 * m_aodp *
            (5.0 + 14.0 * m_betao2 * CK2 * pinvsq) +
            CK2 * pinvsq * (5.0 + 21.0 * m_betao2) * 0.25);

    // == Eccentricity factor for secular perturbations ==
    m_eta = 1.0 + m_betao * CK2 * pinvsq *
            (0.5 - 0.75 * m_betao2 * CK2 * pinvsq);

    // == Mean anomaly correction ==
    m_delmo = std::pow(1.0 + m_eta * std::cos(m_mo), 3.0);

    // Mean anomaly J2 rate factor.
    m_mojfr = 1.0 + m_betao * CK2 * pinvsq *
              (0.5 - 0.75 * m_betao2 * CK2 * pinvsq);

    // == Mean anomaly drag coefficient ==
    m_xmcof = m_bstar * m_c3 / m_eta;

    // == Initialize corrected elements at epoch ==
    m_argpp  = m_argpo;
    m_nodepp = m_nodeo;

    // == Determine near-Earth vs deep-space ==
    double period_min = TWO_PI / m_n0;
    m_is_deep_space = (period_min >= DEEP_SPACE_PERIOD);
}

// ---------------------------------------------------------------------------
// SGP4 Core Propagation
// ---------------------------------------------------------------------------
//
// This routine computes the position and velocity of a satellite at a given
// time tsince (minutes since TLE epoch) using the SGP4 algorithm.
//
// Steps:
//   1. Compute secular perturbations (drag, J2 long-period).
//   2. Solve Kepler's equation for eccentric anomaly.
//   3. Compute true anomaly.
//   4. Compute position and velocity in the perifocal (PQW) frame.
//   5. Rotate to TEME frame via argument of perigee, inclination, and RAAN.
//   6. Apply J2 short-period corrections.
//   7. Convert from Earth radii/min to km/km/s.
//
// Reference: Vallado et al., "Revisiting Spacetrack Report #3", 2006,
//            Appendix D (SGP4/SDP4 propagation).

inline StateVector SGP4Propagator::sgp4_core(double tsince_min) const {
    // == Time since epoch [minutes] ==
    double tsince = tsince_min;

    // == Step 1: Secular perturbations ==
    //
    // Mean anomaly secular: M(t) = M0 + (n0 + dM)*t + dM2*t^2 + ...
    // The drag secular is modeled as a quadratic in the mean anomaly.
    //
    // Argument of perigee secular: omega(t) = omega0 + C3*t^3
    // RAAN secular: Omega(t) = Omega0 + 3.5*(1-5*cos^2(i))*C1*t^2

    // Mean anomaly secular (including drag secular term).
    double mm = m_mo + m_n0 * tsince +
                m_c1 * tsince * tsince * tsince * m_xmcof;

    // Argument of perigee secular (J2 + drag).
    double argpp_sec = m_argpp + m_c3 * tsince * tsince * tsince;

    // RAAN secular (J2 + drag).
    double nodepp_sec = m_nodepp +
                        3.5 * m_betao2 * m_x1m5th * m_c1 * tsince * tsince;

    // == Step 2: Solve Kepler's equation ==
    //
    //   E - e*sin(E) = M
    //
    // Solved by Newton-Raphson iteration.

    double e  = m_ecco;
    double M  = std::fmod(mm, TWO_PI);
    if (M < 0.0) {
        M += TWO_PI;
    }

    double E = solve_kepler_sgp4(M, e);

    // == Step 3: True anomaly ==
    //
    //   cos(theta) = (cos(E) - e) / (1 - e*cos(E))
    //   sin(theta) = sqrt(1-e^2) * sin(E) / (1 - e*cos(E))

    double cos_E = std::cos(E);
    double sin_E = std::sin(E);
    double denom = 1.0 - e * cos_E;

    double cos_ta = (cos_E - e) / denom;
    double sin_ta = std::sqrt(1.0 - e * e) * sin_E / denom;
    double ta     = std::atan2(sin_ta, cos_ta);
    if (ta < 0.0) {
        ta += TWO_PI;
    }

    // == Step 4: Position and velocity in perifocal (PQW) frame ==
    //
    //   r = p / (1 + e*cos(theta)) * [cos(theta), sin(theta), 0]
    //   v = sqrt(mu/p) * [-sin(theta), e+cos(theta), 0]
    //
    // where p = a*(1-e^2) is the semi-latus rectum [Earth radii].
    //
    // Note: all distances in Earth radii, times in minutes.
    //   sqrt(mu/p) in standard units is km/s.
    //   In SGP4 units: XKE / sqrt(p) gives Earth radii/min.

    double p   = m_aodp * m_omeosq;        // semi-latus rectum [Earth radii]
    double r_mag = p / (1.0 + e * cos_ta); // radius [Earth radii]

    // Position in perifocal.
    double r_pqw_x = r_mag * cos_ta;
    double r_pqw_y = r_mag * sin_ta;
    // r_pqw_z = 0 (orbital plane)

    // Velocity in perifocal [Earth radii/min].
    double sqrt_mu_over_p = XKE / std::sqrt(p);
    double v_pqw_x = sqrt_mu_over_p * (-sin_ta);
    double v_pqw_y = sqrt_mu_over_p * (e + cos_ta);
    // v_pqw_z = 0 (orbital plane)

    // == Step 5: Rotate from perifocal to TEME ==
    //
    // The rotation sequence is:
    //   1. Rotate by argument of perigee (omega) about Z-axis.
    //   2. Rotate by inclination (i) about X-axis.
    //   3. Rotate by RAAN (Omega) about Z-axis.

    // Rotation 1: argument of perigee.
    double cos_w = std::cos(argpp_sec);
    double sin_w = std::sin(argpp_sec);

    double r_x_w = r_pqw_x * cos_w - r_pqw_y * sin_w;
    double r_y_w = r_pqw_x * sin_w + r_pqw_y * cos_w;
    double v_x_w = v_pqw_x * cos_w - v_pqw_y * sin_w;
    double v_y_w = v_pqw_x * sin_w + v_pqw_y * cos_w;

    // Rotation 2: inclination.
    double cos_i = m_cosio;
    double sin_i = m_sinio;

    double r_x_i = r_x_w;
    double r_y_i = r_y_w * cos_i;
    double r_z_i = r_y_w * sin_i;
    double v_x_i = v_x_w;
    double v_y_i = v_y_w * cos_i;
    double v_z_i = v_y_w * sin_i;

    // Rotation 3: RAAN.
    double cos_O = std::cos(nodepp_sec);
    double sin_O = std::sin(nodepp_sec);

    double x_teme  = r_x_i * cos_O - r_y_i * sin_O;
    double y_teme  = r_x_i * sin_O + r_y_i * cos_O;
    double z_teme  = r_z_i;
    double vx_teme = v_x_i * cos_O - v_y_i * sin_O;
    double vy_teme = v_x_i * sin_O + v_y_i * cos_O;
    double vz_teme = v_z_i;

    // == Step 6: J2 short-period corrections ==
    //
    // The SGP4 model includes short-period J2 corrections that modify
    // the position and velocity.  These are applied after the secular
    // propagation and Kepler equation solve.
    //
    // For a simplified but accurate LEO model, we apply the dominant
    // short-period terms from Vallado Eq. 9-1 through 9-3.

    double m_theta  = argpp_sec + ta;  // argument of latitude

    // J2 short-period position corrections [Earth radii].
    double r2 = r_mag * r_mag;
    double rk = 1.5 * CK2 * m_x3thm1 / r2;
    double xj2_cor = -rk * m_x1m5th * std::cos(2.0 * m_theta);
    double yj2_cor =  rk * (4.0 * m_x1m3th - 1.0) * std::sin(2.0 * m_theta);
    double zj2_cor =  rk * m_x1m5th * 3.0 * m_sinio * std::cos(m_theta) * std::cos(argpp_sec);

    x_teme  += xj2_cor;
    y_teme  += yj2_cor;
    z_teme  += zj2_cor;

    // J2 short-period velocity corrections [Earth radii/min].
    double rk_v = 3.0 * CK2 * m_n0 * m_x3thm1 / r2;
    double vxj2_cor =  rk_v * m_x1m5th * std::sin(2.0 * m_theta);
    double vyj2_cor =  rk_v * (4.0 * m_x1m3th - 1.0) * std::cos(2.0 * m_theta);
    double vzj2_cor = -rk_v * m_x1m5th * 3.0 * m_sinio * std::sin(m_theta) * std::cos(argpp_sec);

    vx_teme += vxj2_cor;
    vy_teme += vyj2_cor;
    vz_teme += vzj2_cor;

    // == Step 7: Unit conversion ==
    //
    // Position: Earth radii -> km.
    // Velocity: Earth radii/min -> km/s.

    double x_km    = x_teme * R_EARTH;
    double y_km    = y_teme * R_EARTH;
    double z_km    = z_teme * R_EARTH;
    double vx_kms  = vx_teme * RE_PER_MIN_TO_KM_PER_SEC;
    double vy_kms  = vy_teme * RE_PER_MIN_TO_KM_PER_SEC;
    double vz_kms  = vz_teme * RE_PER_MIN_TO_KM_PER_SEC;

    // ---- Compute propagation epoch ----
    double jd_prop = m_jd_epoch + tsince_min / MINUTES_PER_DAY;

    return StateVector({x_km, y_km, z_km},
                       {vx_kms, vy_kms, vz_kms},
                       jd_prop);
}

// ---------------------------------------------------------------------------
// Public Interface: propagate()
// ---------------------------------------------------------------------------

inline StateVector SGP4Propagator::propagate(double jd) const {
    double tsince_min = (jd - m_jd_epoch) * MINUTES_PER_DAY;
    return sgp4_core(tsince_min);
}

// ---------------------------------------------------------------------------
// Public Interface: get_elements()
// ---------------------------------------------------------------------------

inline KeplerianElements SGP4Propagator::get_elements(double jd) const {
    StateVector sv = propagate(jd);
    return state_to_elements(sv.position, sv.velocity, jd);
}

}  // namespace orbit
