#pragma once

/// @file time_system.hpp
/// @brief Time system conversions for orbital mechanics.
///        Julian Date, Modified Julian Date, calendar dates, sidereal time,
///        and utility angle-normalization functions.
///
/// References:
///   - Meeus, "Astronomical Algorithms", 2nd ed.
///   - Vallado, "Fundamentals of Astrodynamics and Applications", 4th ed.

#include "orbit_types.hpp"

#include <cmath>
#include <cstdint>

namespace orbit {

// ============================================================================
// Structs
// ============================================================================

/// Calendar date with fractional day-of-month.
struct CalendarDate {
    int year = 0;
    int month = 0;
    double day = 0.0;  ///< Day of month, including fractional part (e.g. 15.75).
};

// ============================================================================
// Constants
// ============================================================================

/// Julian Date offset used in MJD conversion.
inline constexpr double JD_MJD_OFFSET = 2400000.5;

/// Seconds per day.
inline constexpr double SEC_PER_DAY = 86400.0;

/// Julian centuries from J2000.0.
inline constexpr double J2000_CENTURIES = 36525.0;

// ============================================================================
// Basic JD <-> MJD conversions
// ============================================================================

/// Convert Julian Date to Modified Julian Date.
/// MJD = JD - 2400000.5
inline double jd_to_mjd(double jd) {
    return jd - JD_MJD_OFFSET;
}

/// Convert Modified Julian Date to Julian Date.
/// JD = MJD + 2400000.5
inline double mjd_to_jd(double mjd) {
    return mjd + JD_MJD_OFFSET;
}

// ============================================================================
// Julian Date <-> Calendar Date
// ============================================================================

/// Convert Julian Date to calendar date (year, month, day).
/// Uses the algorithm from Meeus, "Astronomical Algorithms", Ch. 7.
inline CalendarDate jd_to_date(double jd) {
    // Shift to J2000.0 epoch for numerical stability.
    double z = std::floor(jd + 0.5);
    double f = (jd + 0.5) - z;

    double a = z;
    if (z >= 2299161.0) {
        double alpha = std::floor((z - 1867216.25) / 36524.25);
        a = z + 1.0 + alpha - std::floor(alpha / 4.0);
    }

    double b = a + 1524.0;
    double c = std::floor((b - 122.1) / 365.25);
    double d = std::floor(365.25 * c);
    double e = std::floor((b - d) / 30.6001);

    double day_frac = b - d - std::floor(30.6001 * e) + f;

    // Meeus algorithm: e is in range [1, 15].
    // If e < 14: month = e - 1 (e=13 -> month=12, e=3 -> month=2)
    // If e >= 14: month = e - 13 (e=14 -> month=1, e=15 -> month=2)
    int month;
    if (static_cast<int>(e) < 14) {
        month = static_cast<int>(e) - 1;
    } else {
        month = static_cast<int>(e) - 13;
    }
    int year = static_cast<int>(c);
    if (month > 2) {
        year -= 4716;
    } else {
        year -= 4715;
    }

    CalendarDate date;
    date.year = year;
    date.month = month;
    date.day = day_frac;
    return date;
}

/// Convert calendar date to Julian Date.
/// Uses the algorithm from Meeus, "Astronomical Algorithms", Ch. 7.
/// January and February are treated as months 13 and 14 of the previous year.
inline double date_to_jd(int year, int month, double day) {
    int y = year;
    int m = month;

    if (m <= 2) {
        y -= 1;
        m += 12;
    }

    int a = static_cast<int>(std::floor(y / 100.0));
    int b = 2 - a + static_cast<int>(std::floor(a / 4.0));

    double jd_frac = std::floor(365.25 * (y + 4716.0))
                   + std::floor(30.6001 * (m + 1.0))
                   + day + b - 1524.5;
    return jd_frac;
}

/// Convert calendar components to Julian Date.
/// Standard formula from Vallado, "Fundamentals of Astrodynamics", Eq. 3-12.
inline double jday(int year, int month, int day,
                   int hour, int minute, double second) {
    // Vallado's formulation.
    int y = year;
    int m = month;

    if (m <= 2) {
        y -= 1;
        m += 12;
    }

    double day_frac = static_cast<double>(day)
                    + static_cast<double>(hour) / 24.0
                    + static_cast<double>(minute) / 1440.0
                    + second / 86400.0;

    int a = static_cast<int>(std::floor(y / 100.0));
    int b = 2 - a + static_cast<int>(std::floor(a / 4.0));

    double jd = std::floor(365.25 * (y + 4716.0))
              + std::floor(30.6001 * (m + 1.0))
              + day_frac + b - 1524.5;
    return jd;
}

// ============================================================================
// Fractional Year
// ============================================================================

/// Convert Julian Date to fractional year (for solar position calculations).
/// Returns year + (day_of_year - 1) / days_in_year.
inline double jd_to_yearfrac(double jd) {
    CalendarDate date = jd_to_date(jd);

    // JD of January 0.0 of this year (i.e. Dec 31 of previous year).
    double jd_jan0 = date_to_jd(date.year, 1, 0.0);
    double jd_jan0_next = date_to_jd(date.year + 1, 1, 0.0);

    double day_of_year = jd - jd_jan0;
    double days_in_year = jd_jan0_next - jd_jan0;

    return static_cast<double>(date.year) + (day_of_year - 1.0) / days_in_year;
}

// ============================================================================
// Time Scale Conversions
// ============================================================================

/// Convert UTC to UT1.
/// UT1 = UTC + dut1 / 86400.0
/// @param jd_utc  Julian Date in UTC.
/// @param dut1_seconds  UT1 - UTC offset in seconds.
/// @return Julian Date in UT1.
inline double utc_to_ut1(double jd_utc, double dut1_seconds) {
    return jd_utc + dut1_seconds / SEC_PER_DAY;
}

// ============================================================================
// Sidereal Time
// ============================================================================

/// Compute Greenwich Mean Sidereal Time from UT1 Julian Date.
/// Uses the IAU formula from Vallado, Eq. 3-47.
/// Returns GMST in radians, normalized to [0, 2*PI].
inline double ut1_to_gmst(double jd_ut1) {
    // Julian centuries from J2000.0.
    double t = (jd_ut1 - JD_J2000) / J2000_CENTURIES;

    // Hours of UT1 (fractional part of JD * 24).
    // JD convention: JD x.0 = noon, JD x.5 = midnight.
    // Add 0.5 to convert from noon-based to midnight-based hours.
    double ut1_hours = std::fmod(jd_ut1 + 0.5, 1.0) * 24.0;
    if (ut1_hours < 0.0) {
        ut1_hours += 24.0;
    }

    // GMST in hours of time (Vallado Eq. 3-47).
    double gmst_hours = 6.697374558
                      + 0.06570982441908 * (jd_ut1 - JD_J2000)
                      + 1.00273790935 * ut1_hours
                      + 0.000026 * t * t;

    // Convert hours to radians, normalize to [0, 2*PI].
    double gmst_rad = gmst_hours * (TWO_PI / 24.0);
    return std::fmod(gmst_rad, TWO_PI);
}

/// Compute Greenwich Apparent Sidereal Time from UT1 Julian Date.
/// GAST = GMST + equation_of_equinoxes.
/// For most applications the nutation correction is negligible;
/// this implementation uses GMST as the approximation.
inline double jd_ut1_to_gast(double jd_ut1) {
    // Simplified: GAST = GMST (nutation correction omitted).
    return ut1_to_gmst(jd_ut1);
}

// ============================================================================
// Day of Year
// ============================================================================

/// Compute the day-of-year (1-based) from a Julian Date.
/// Day 1.0 = midnight on January 1 of that year.
inline double day_of_year(double jd) {
    CalendarDate date = jd_to_date(jd);
    // JD of midnight on Jan 1 (date_to_jd takes fractional day from midnight).
    double jd_jan1 = date_to_jd(date.year, 1, 1.0);
    return jd - jd_jan1 + 1.0;
}

// ============================================================================
// Angle Utilities
// ============================================================================

/// Normalize an angle to [0, 2*PI).
inline double normalize_angle(double angle) {
    double a = std::fmod(angle, TWO_PI);
    if (a < 0.0) {
        a += TWO_PI;
    }
    return a;
}

/// Normalize an angle to [-PI, PI).
inline double wrap_angle(double angle) {
    double a = std::fmod(angle, TWO_PI);
    if (a > PI) {
        a -= TWO_PI;
    } else if (a < -PI) {
        a += TWO_PI;
    }
    return a;
}

}  // namespace orbit
