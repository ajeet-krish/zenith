#pragma once

/// @file orbit_types.hpp
/// @brief Foundational types, constants, enums, and structs for the orbital
///        mechanics suite.  This is the single header that every other module
///        in the project includes.

#include <cmath>
#include <cstdint>
#include <ostream>
#include <string>

namespace orbit {

// ============================================================================
// Physical Constants
// ============================================================================

/// Earth gravitational parameter [km^3/s^2]
inline constexpr double MU_EARTH = 398600.4418;

/// Earth equatorial radius [km]
inline constexpr double R_EARTH = 6378.137;

/// Earth J2 oblateness coefficient (dimensionless)
inline constexpr double J2 = 1.08263e-3;

/// Earth J4 oblateness coefficient (dimensionless)
inline constexpr double J4 = -1.616e-6;

/// Sun gravitational parameter [km^3/s^2]
inline constexpr double MU_SUN = 1.32712440018e11;

/// Moon gravitational parameter [km^3/s^2]
inline constexpr double MU_MOON = 4902.800066;

/// Astronomical unit [km]
inline constexpr double AU = 149597870.7;

/// Speed of light [km/s]
inline constexpr double C_LIGHT = 299792.458;

/// Earth rotation rate [rad/s]
inline constexpr double OMEGA_EARTH = 7.2921151467e-5;

/// Pi
inline constexpr double PI = 3.14159265358979323846;

/// 2 * Pi
inline constexpr double TWO_PI = 2.0 * PI;

/// Degrees to radians conversion factor
inline constexpr double DEG_TO_RAD = PI / 180.0;

/// Radians to degrees conversion factor
inline constexpr double RAD_TO_DEG = 180.0 / PI;

/// Modified Julian Date of J2000.0 epoch
inline constexpr double MJD_J2000 = 51544.5;

/// Julian Date of J2000.0 epoch
inline constexpr double JD_J2000 = 2451545.0;

// ============================================================================
// Enums
// ============================================================================

/// Reference coordinate frame
enum class Frame { TEME, GCRF, ECEF, LLA };

/// Time system / scale
enum class TimeSystem { UTC, UT1, TAI, TT, GPS };

/// Propagation algorithm
enum class PropagatorType { Kepler, SGP4, NumericalRK4, NumericalRK45 };

/// Force model selection
enum class ForceModel { KeplerOnly, J2, J2J4, Full };

/// Orbit classification
enum class OrbitType {
    Circular,
    Elliptical,
    Parabolic,
    Hyperbolic,
    Geostationary,
    Molniya,
    LEO,
    MEO,
    GEO
};

// ============================================================================
// Vec3: 3D vector
// ============================================================================

struct Vec3 {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;

    /// Default zero-initialized vector.
    Vec3() = default;

    /// Element-wise construction.
    Vec3(double x_, double y_, double z_) : x(x_), y(y_), z(z_) {}

    /// Vector addition.
    Vec3 operator+(const Vec3& rhs) const {
        return {x + rhs.x, y + rhs.y, z + rhs.z};
    }

    /// Vector subtraction.
    Vec3 operator-(const Vec3& rhs) const {
        return {x - rhs.x, y - rhs.y, z - rhs.z};
    }

    /// Scalar multiplication (vec * scalar).
    Vec3 operator*(double s) const {
        return {x * s, y * s, z * s};
    }

    /// Scalar division.
    Vec3 operator/(double s) const {
        if (s == 0.0) return {0.0, 0.0, 0.0};
        return {x / s, y / s, z / s};
    }

    /// Unary negation.
    Vec3 operator-() const {
        return {-x, -y, -z};
    }

    /// In-place addition.
    Vec3& operator+=(const Vec3& rhs) {
        x += rhs.x;
        y += rhs.y;
        z += rhs.z;
        return *this;
    }

    /// In-place subtraction.
    Vec3& operator-=(const Vec3& rhs) {
        x -= rhs.x;
        y -= rhs.y;
        z -= rhs.z;
        return *this;
    }

    /// In-place scalar multiplication.
    Vec3& operator*=(double s) {
        x *= s;
        y *= s;
        z *= s;
        return *this;
    }

    /// In-place scalar division.
    Vec3& operator/=(double s) {
        if (s == 0.0) return *this;
        x /= s;
        y /= s;
        z /= s;
        return *this;
    }

    /// Euclidean norm.
    [[nodiscard]] double magnitude() const {
        return std::sqrt(x * x + y * y + z * z);
    }

    /// Squared magnitude (avoids sqrt, useful for comparisons).
    [[nodiscard]] double magnitude_squared() const {
        return x * x + y * y + z * z;
    }

    /// Return a unit vector in the same direction.
    [[nodiscard]] Vec3 normalized() const {
        double mag = magnitude();
        if (mag < 1e-15) {
            return {0.0, 0.0, 0.0};
        }
        return *this / mag;
    }

    /// Dot product.
    [[nodiscard]] double dot(const Vec3& rhs) const {
        return x * rhs.x + y * rhs.y + z * rhs.z;
    }

    /// Cross product.
    [[nodiscard]] Vec3 cross(const Vec3& rhs) const {
        return {y * rhs.z - z * rhs.y,
                z * rhs.x - x * rhs.z,
                x * rhs.y - y * rhs.x};
    }
};

/// Scalar * Vec3.
inline Vec3 operator*(double s, const Vec3& v) {
    return v * s;
}

/// Stream output for Vec3.
inline std::ostream& operator<<(std::ostream& os, const Vec3& v) {
    os << "(" << v.x << ", " << v.y << ", " << v.z << ")";
    return os;
}

// ============================================================================
// StateVector: position + velocity + epoch
// ============================================================================

struct StateVector {
    Vec3 position;   ///< Position in km (TEME or GCRF).
    Vec3 velocity;   ///< Velocity in km/s.
    double epoch = 0.0;  ///< Epoch as Julian Date.

    /// Default zero-initialized state.
    StateVector() = default;

    /// Full construction.
    StateVector(const Vec3& pos, const Vec3& vel, double ep)
        : position(pos), velocity(vel), epoch(ep) {}
};

/// Stream output for StateVector.
inline std::ostream& operator<<(std::ostream& os, const StateVector& sv) {
    os << "r=" << sv.position << " v=" << sv.velocity
       << " JD=" << sv.epoch;
    return os;
}

// ============================================================================
// KeplerianElements: classical orbital elements
// ============================================================================

struct KeplerianElements {
    double a     = 0.0;  ///< Semi-major axis [km].
    double e     = 0.0;  ///< Eccentricity (dimensionless).
    double i     = 0.0;  ///< Inclination [rad].
    double raan  = 0.0;  ///< Right ascension of ascending node [rad].
    double argp  = 0.0;  ///< Argument of perigee [rad].
    double ta    = 0.0;  ///< True anomaly [rad].
    double epoch = 0.0;  ///< Epoch as Julian Date.

    /// Default zero-initialized elements.
    KeplerianElements() = default;

    /// Full construction.
    KeplerianElements(double sma, double ecc, double inc,
                      double ra, double arg, double anomaly, double ep)
        : a(sma), e(ecc), i(inc), raan(ra), argp(arg), ta(anomaly), epoch(ep) {}

    /// Orbital period [s].  Returns 0 for parabolic/hyperbolic orbits.
    [[nodiscard]] double period() const {
        if (a <= 0.0) {
            return 0.0;
        }
        return TWO_PI * std::sqrt(a * a * a / MU_EARTH);
    }

    /// Mean motion [rad/s].
    [[nodiscard]] double mean_motion() const {
        if (a <= 0.0) {
            return 0.0;
        }
        return std::sqrt(MU_EARTH / (a * a * a));
    }

    /// Apogee radius [km].
    [[nodiscard]] double apogee() const {
        return a * (1.0 + e);
    }

    /// Perigee radius [km].
    [[nodiscard]] double perigee() const {
        return a * (1.0 - e);
    }

    /// Eccentricity vector (pointing toward perigee, magnitude = e).
    [[nodiscard]] Vec3 eccentricity_vector() const {
        // E = (v x h) / mu - r_hat
        // For direct use from classical elements, we compute in the perifocal
        // frame and let the caller rotate as needed.  Here we provide the
        // components in the orbital plane.
        double cos_ta = std::cos(ta);
        double sin_ta = std::sin(ta);
        double e_mag = e;
        return {e_mag * cos_ta, e_mag * sin_ta, 0.0};
    }
};

// ============================================================================
// TLEData: parsed Two-Line Element set
// ============================================================================

struct TLEData {
    int norad_id = 0;                  ///< NORAD catalog number.
    char classification = 'U';         ///< Classification (U=unclassified).
    int epoch_year = 0;                ///< Epoch year (2-digit).
    double epoch_day = 0.0;            ///< Epoch day of year (with fractional part).
    double bstar = 0.0;                ///< B* drag term [1/Earth radii].
    double inc_deg = 0.0;              ///< Inclination [deg].
    double raan_deg = 0.0;             ///< RAAN [deg].
    double ecc = 0.0;                  ///< Eccentricity (without leading decimal point).
    double argp_deg = 0.0;             ///< Argument of perigee [deg].
    double mean_anomaly_deg = 0.0;     ///< Mean anomaly [deg].
    double mean_motion_rev_day = 0.0;  ///< Mean motion [rev/day].
    int revolution_number = 0;         ///< Revolution number at epoch.
    std::string line1;                 ///< Raw TLE line 1.
    std::string line2;                 ///< Raw TLE line 2.
};

// ============================================================================
// PropagatorParams: propagation configuration
// ============================================================================

struct PropagatorParams {
    bool use_j2 = true;
    bool use_j4 = false;
    bool use_drag = false;
    bool use_srp = false;
    bool use_third_body = false;

    double drag_coefficient = 2.2;          ///< Drag coefficient Cd (dimensionless).
    double srp_coefficient = 1.5;           ///< Solar radiation pressure reflectivity Cr.
    double area_mass_ratio = 0.004;         ///< Area-to-mass ratio [m^2/kg].
    double dt_step = 60.0;                  ///< Integration step size [s].
    double end_time_days = 7.0;             ///< Propagation duration [days].

    PropagatorType propagator_type = PropagatorType::SGP4;
};

// ============================================================================
// Global Configuration Variables
// ============================================================================

/// Global flag: enable J2 perturbation in all propagators.
inline bool g_use_j2 = true;

/// Global flag: enable verbose console output.
inline bool g_verbose = false;

}  // namespace orbit
