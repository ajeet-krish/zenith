#pragma once

/// @file partials.hpp
/// @brief Analytic measurement partials (H matrix rows) for the OD
///        estimators: range, range-rate, RA/Dec, and (for simulation
///        completeness) Az/El.
///
///        Partials are evaluated at the observation epoch against the ECI
///        state [r(3), v(3)] at that same epoch; the velocity columns are
///        zero for the angle types because the angles depend on position
///        only when light time is ignored (the Phase 1-3 simplification
///        set).
///
///        Geometry: r_rel = r_sc - r_sta, v_rel = v_sc - v_sta,
///        rho = |r_rel|, u = r_rel / rho.  The station position and
///        velocity are evaluated at the given epoch (Earth rotation).
///
///        Reference: helio_ob src/helio/partials.py

#include <cmath>

#include "observations.hpp"
#include "orbit_types.hpp"
#include "stations.hpp"

namespace orbit {

// ============================================================================
// Singular-Guard Constants (helio parity)
// ============================================================================

/// Rho below this [km] is treated as the satellite sitting on the station.
inline constexpr double PARTIAL_RHO_MIN_KM = 1e-9;

/// |u_z| within this distance of 1 (Dec within about 1e-8 rad of the
/// pole) makes RA/Dec singular.
inline constexpr double PARTIAL_UZ_POLE_TOL = 1.0 - 1e-16;

// ============================================================================
// Individual Partial Rows
// ============================================================================

/// Range partial row [drho/dr, drho/dv] = [u^T, 0] (shape 1x6).
///
/// @param u    Line-of-sight unit vector.
/// @param row  Output row of 6 doubles.
inline void range_partial(const Vec3& u, double* row) {
    row[0] = u.x;
    row[1] = u.y;
    row[2] = u.z;
    row[3] = 0.0;
    row[4] = 0.0;
    row[5] = 0.0;
}

/// Range-rate partial row d(rr)/d(r, v) (shape 1x6).
///
/// With rr = (r_rel . v_rel) / rho the position block is
/// v_rel^T / rho - rr * u^T / rho and the velocity block is u^T.
inline void range_rate_partial(const Vec3& r_rel, const Vec3& v_rel,
                               double rho, const Vec3& u, double* row) {
    const double range_rate = r_rel.dot(v_rel) / rho;
    row[0] = v_rel.x / rho - (range_rate / rho) * u.x;
    row[1] = v_rel.y / rho - (range_rate / rho) * u.y;
    row[2] = v_rel.z / rho - (range_rate / rho) * u.z;
    row[3] = u.x;
    row[4] = u.y;
    row[5] = u.z;
}

/// RA/Dec partial rows d(ra, dec)/d(r, v) (shape 2x6, row-major).
///
/// RA = atan2(ry, rx), Dec = asin(rz / rho) of the line of sight, so both
/// depend on position only; the velocity columns are zero (light time
/// ignored).  With rho_xy^2 = rx^2 + ry^2 and s = sqrt(1 - u_z^2):
///
///   dRA/dr  = [-ry / rho_xy^2, rx / rho_xy^2, 0]
///   dDec/dr = [-u_x u_z / (rho s), -u_y u_z / (rho s), s / rho]
///
/// @return True on success; false if the geometry is singular (line of
///         sight along the ECI z axis).
inline bool ra_dec_partials(const Vec3& r_rel, double rho, const Vec3& u,
                            double* rows2x6) {
    const double rho_xy_sq = r_rel.x * r_rel.x + r_rel.y * r_rel.y;
    const double u_z = u.z;
    if (rho_xy_sq <= 0.0 || u_z >= PARTIAL_UZ_POLE_TOL ||
        u_z <= -PARTIAL_UZ_POLE_TOL) {
        return false;
    }
    const double s = std::sqrt(1.0 - u_z * u_z);

    // Row 0: dRA/dr, zero velocity columns.
    rows2x6[0] = -r_rel.y / rho_xy_sq;
    rows2x6[1] = r_rel.x / rho_xy_sq;
    rows2x6[2] = 0.0;
    rows2x6[3] = 0.0;
    rows2x6[4] = 0.0;
    rows2x6[5] = 0.0;

    // Row 1: dDec/dr, zero velocity columns.
    rows2x6[6] = -u.x * u_z / (rho * s);
    rows2x6[7] = -u.y * u_z / (rho * s);
    rows2x6[8] = s / rho;
    rows2x6[9] = 0.0;
    rows2x6[10] = 0.0;
    rows2x6[11] = 0.0;
    return true;
}

/// Az/El partial rows d(az, el)/d(r, v) (shape 2x6, row-major).
///
/// Included for simulation completeness (helio's estimator rejects AZ_EL;
/// these rows let the observation-synthesis path validate its own
/// geometry).  With sez = T r_rel (T = SEZ rotation of the ECI->ECEF
/// rotation), az = atan2(sez_e, -sez_s), el = asin(sez_z / rho), and
/// q = sqrt(sez_s^2 + sez_e^2):
///
///   d az/d sez = [e / q^2, -s / q^2, 0]
///   d el/d sez = [-z s / (q rho^2), -z e / (q rho^2), q / rho^2]
///
/// and d sez/d r_eci = SEZ * Rz(-gmst).
///
/// @return True on success; false if the geometry is singular (LOS along
///         the zenith axis makes az undefined).
inline bool az_el_partials(const Vec3& r_rel_eci, double rho, double jd,
                           const ODGroundStation& station,
                           double* rows2x6) {
    const Vec3 r_rel_ecef = teme_to_ecef(r_rel_eci, jd);
    const Vec3 sez = ecef_to_sez(r_rel_ecef, station.lat_rad,
                                 station.lon_rad);
    const double s = sez.x;
    const double e = sez.y;
    const double z = sez.z;
    const double q_sq = s * s + e * e;
    if (q_sq <= 0.0) {
        return false;  // LOS along the zenith: az undefined.
    }
    const double q = std::sqrt(q_sq);
    const double rho_sq = rho * rho;

    // d az/d sez and d el/d sez (2x3 each).
    const double daz[3] = {e / q_sq, -s / q_sq, 0.0};
    const double del[3] = {-z * s / (q * rho_sq), -z * e / (q * rho_sq),
                           q / rho_sq};

    // d sez/d r_eci = SEZ(lat, lon) * Rz(-gmst).  Build it explicitly.
    const double gmst_rad = gmst(jd);
    const double cg = std::cos(gmst_rad);
    const double sg = std::sin(gmst_rad);
    // Rz(-gmst) = [[cg, sg, 0], [-sg, cg, 0], [0, 0, 1]].
    const double sin_lat = std::sin(station.lat_rad);
    const double cos_lat = std::cos(station.lat_rad);
    const double sin_lon = std::sin(station.lon_rad);
    const double cos_lon = std::cos(station.lon_rad);
    // SEZ rows (south, east, zenith) times Rz(-gmst).
    const double sez_row_s[3] = {sin_lat * cos_lon * cg - sin_lat * sin_lon * sg,
                                 sin_lat * cos_lon * sg + sin_lat * sin_lon * cg,
                                 -cos_lat};
    const double sez_row_e[3] = {-sin_lon * cg - cos_lon * sg,
                                 -sin_lon * sg + cos_lon * cg,
                                 0.0};
    const double sez_row_z[3] = {cos_lat * cos_lon * cg - cos_lat * sin_lon * sg,
                                 cos_lat * cos_lon * sg + cos_lat * sin_lon * cg,
                                 sin_lat};

    // d az/d r_eci = (d az/d sez) * d sez/d r_eci (and same for el).
    for (int j = 0; j < 3; ++j) {
        rows2x6[j] = daz[0] * sez_row_s[j] + daz[1] * sez_row_e[j] +
                     daz[2] * sez_row_z[j];
        rows2x6[6 + j] = del[0] * sez_row_s[j] + del[1] * sez_row_e[j] +
                         del[2] * sez_row_z[j];
    }
    // Zero velocity columns for both rows.
    for (int j = 3; j < 6; ++j) {
        rows2x6[j] = 0.0;
        rows2x6[6 + j] = 0.0;
    }
    return true;
}

// ============================================================================
// measurement_partials: H Matrix for One Observation Type
// ============================================================================

/// Analytic measurement partials G = dh/d(r, v) at the observation epoch.
///
/// The station position and velocity are evaluated at `jd`; the supplied
/// satellite state must be the ECI state at that same epoch.  RANGE and
/// RANGE_RATE fill 1 row, RA_DEC and AZ_EL fill 2 rows; all rows have 6
/// columns (position then velocity), row-major.
///
/// @param obs_type  Observation type.
/// @param r_eci     Satellite position at jd [km].
/// @param v_eci     Satellite velocity at jd [km/s].
/// @param station   Observing ground station.
/// @param jd        Observation epoch [days].
/// @param out_rows  Output buffer, at least 12 doubles (2x6 row-major).
/// @param out_nrows Output: number of rows filled (1 or 2).
/// @return True on success; false if the geometry is singular (rho below
///         PARTIAL_RHO_MIN_KM, RA/Dec at the pole, or az at the zenith).
inline bool measurement_partials(ObsType obs_type, const Vec3& r_eci,
                                 const Vec3& v_eci,
                                 const ODGroundStation& station, double jd,
                                 double* out_rows, int* out_nrows) {
    const Vec3 r_sta = station.position_eci(jd);
    const Vec3 v_sta = station.velocity_eci(jd);
    const Vec3 r_rel = r_eci - r_sta;
    const Vec3 v_rel = v_eci - v_sta;
    const double rho = r_rel.magnitude();
    if (rho < PARTIAL_RHO_MIN_KM) {
        return false;  // Satellite coincides with the station.
    }
    const Vec3 u = r_rel / rho;

    switch (obs_type) {
        case ObsType::RANGE:
            range_partial(u, out_rows);
            *out_nrows = 1;
            return true;
        case ObsType::RANGE_RATE:
            range_rate_partial(r_rel, v_rel, rho, u, out_rows);
            *out_nrows = 1;
            return true;
        case ObsType::RA_DEC:
            if (!ra_dec_partials(r_rel, rho, u, out_rows)) {
                return false;
            }
            *out_nrows = 2;
            return true;
        case ObsType::AZ_EL:
            if (!az_el_partials(r_rel, rho, jd, station, out_rows)) {
                return false;
            }
            *out_nrows = 2;
            return true;
    }
    return false;
}

}  // namespace orbit
