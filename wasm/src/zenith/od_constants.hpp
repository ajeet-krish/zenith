#pragma once

/// @file od_constants.hpp
/// @brief Orbit-determination-specific constants and parameter structs.
///        Keeps OD constants (atmosphere model, estimator measurement
///        sigmas, default drag parameters) out of the shared
///        orbit_types.hpp header.  Values match helio_ob (Python) so
///        golden-master fixtures agree.
///
/// References:
///   - Vallado, "Fundamentals of Astrodynamics and Applications", 4th ed.,
///     Table 8-4 (single-layer exponential atmosphere).
///   - helio_ob: src/helio/constants.py, src/helio/drag.py,
///     src/helio/observations.py

#include <cmath>

#include "orbit_types.hpp"

namespace orbit {

// ============================================================================
// Atmosphere Model (Vallado Table 8-4 single-layer exponential)
// ============================================================================

/// Atmospheric density at the reference altitude [kg/m^3].
inline constexpr double RHO0 = 3.6e-12;

/// Reference altitude for RHO0 [km].
inline constexpr double H0_KM = 400.0;

/// Atmospheric scale height [km].
inline constexpr double H_SCALE_KM = 60.0;

/// Cap on the exponential argument so non-physical states deep inside the
/// Earth cannot overflow exp(); the valid altitude range never approaches
/// this (exponent = (H0_KM - altitude) / H_SCALE_KM).
inline constexpr double MAX_EXPONENT = 700.0;

/// kg/m^3 to kg/km^3 conversion: 1 m^3 = 1e-9 km^3, so 1 kg/m^3 = 1e9 kg/km^3.
inline constexpr double KG_M3_TO_KG_KM3 = 1.0e9;

/// m^2/kg to km^2/kg conversion for area-to-mass ratios (factor squared).
inline constexpr double ATM_KM_FACTOR = 1.0e-3;

// ============================================================================
// Default Drag Parameters
// ============================================================================

/// Default drag coefficient Cd (dimensionless).
inline constexpr double CD_DEFAULT = 2.2;

/// Default area-to-mass ratio [m^2/kg] (Helio default for LEO objects).
inline constexpr double A_M_DEFAULT_M2KG = 0.01;

// ============================================================================
// Estimator Default Measurement Sigmas (helio observations.ObsConfig)
// ============================================================================

/// Default one-sigma range noise [km] (~1 m, radiometric tracking).
inline constexpr double SIGMA_RANGE_KM = 1e-3;

/// Default one-sigma range-rate noise [km/s] (~0.1 m/s).
inline constexpr double SIGMA_RANGE_RATE_KMS = 1e-4;

/// Default one-sigma (RA, Dec) noise [rad] (~0.2 arcsec, optical angles).
inline constexpr double SIGMA_ANGLES_RAD = 1e-6;

/// Default one-sigma (Az, El) noise [rad] (~10 arcsec, radar pointing).
inline constexpr double SIGMA_AZ_EL_RAD = 5e-5;

// ============================================================================
// DragParams
// ============================================================================

/// Drag model parameters.
///
/// The area-to-mass ratio is carried in km^2/kg internally so drag
/// accelerations come out in km/s^2 when density is in kg/km^3; construct
/// with from_m2_per_kg() to convert from the usual m^2/kg units once.
struct DragParams {
    double a_over_m_km2_kg = A_M_DEFAULT_M2KG * ATM_KM_FACTOR * ATM_KM_FACTOR;
    double cd = CD_DEFAULT;

    /// Construct from an area-to-mass ratio in m^2/kg (typical LEO values
    /// 0.005 to 0.02).
    ///
    /// @param a_over_m_m2_kg  Area-to-mass ratio [m^2/kg].
    /// @param cd              Drag coefficient (dimensionless).
    /// @return DragParams with the ratio converted to km^2/kg (*1e-6).
    static DragParams from_m2_per_kg(double a_over_m_m2_kg,
                                     double cd = CD_DEFAULT) {
        DragParams params;
        params.a_over_m_km2_kg = a_over_m_m2_kg * ATM_KM_FACTOR * ATM_KM_FACTOR;
        params.cd = cd;
        return params;
    }
};

/// DragParams built from the constant defaults (A_M_DEFAULT_M2KG, CD_DEFAULT).
inline DragParams default_drag_params() {
    return DragParams::from_m2_per_kg(A_M_DEFAULT_M2KG);
}

}  // namespace orbit
