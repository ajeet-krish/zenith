#pragma once

/// @file observations.hpp
/// @brief Observation model for orbit determination: types, configuration,
///        noise-free prediction, and noisy synthesis.
///
///        Units: km, km/s, rad, days.  States are ECI (TEME/GMST frame).
///        Noise is drawn from a seeded std::mt19937_64 with a manually
///        implemented Box-Muller transform, so a given seed produces a
///        deterministic (C++-internal) noise sequence without relying on
///        <random> distribution portability.
///
///        Reference: helio_ob src/helio/observations.py

#include <cmath>
#include <cstdint>
#include <random>
#include <vector>

#include "od_constants.hpp"
#include "orbit_types.hpp"
#include "stations.hpp"

namespace orbit {

// ============================================================================
// Observation Types
// ============================================================================

/// Observation type enumerations.
enum class ObsType : int {
    RANGE = 0,       ///< Slant range [km].
    RANGE_RATE = 1,  ///< Radial range rate [km/s].
    RA_DEC = 2,      ///< Right ascension + declination [rad].
    AZ_EL = 3        ///< Azimuth + elevation [rad].
};

/// Number of scalar values in one observation of this type (ndim).
inline int obs_ndim(ObsType obs_type) {
    switch (obs_type) {
        case ObsType::RANGE:
        case ObsType::RANGE_RATE:
            return 1;
        default:
            return 2;
    }
}

// ============================================================================
// ObsConfig: Default Measurement Sigmas
// ============================================================================

/// Default measurement sigmas for the observation types (helio ObsConfig:
/// about 1 m range, 0.1 m/s range-rate, 0.2 arcsec optical angles, 10
/// arcsec radar az/el).
struct ObsConfig {
    double sigma_range_km = SIGMA_RANGE_KM;
    double sigma_range_rate_kms = SIGMA_RANGE_RATE_KMS;
    double sigma_angles_rad[2] = {SIGMA_ANGLES_RAD, SIGMA_ANGLES_RAD};
    double sigma_az_el_rad[2] = {SIGMA_AZ_EL_RAD, SIGMA_AZ_EL_RAD};
};

// ============================================================================
// ODObservation
// ============================================================================

/// A single observation at one epoch from one station.
struct ODObservation {
    double time_jd = 0.0;       ///< Observation epoch as Julian Date [days].
    int station_index = 0;      ///< Index into the caller's station list.
    ObsType obs_type = ObsType::RANGE;
    double values[2] = {0.0, 0.0};   ///< Measured values (km, km/s, or rad).
    double sigmas[2] = {0.0, 0.0};   ///< One-sigma uncertainties.
    int ndim = 1;                    ///< Scalar components (1 or 2).
};

// ============================================================================
// Predicted (Noise-Free) Observables
// ============================================================================

/// All noise-free observable components of an ECI state from a station.
struct PredictedComponents {
    double range_km = 0.0;      ///< |r_sc - r_sta| [km].
    double range_rate_kms = 0.0;///< (r_rel . v_rel) / rho [km/s].
    double ra_rad = 0.0;        ///< Right ascension of LOS in ECI [rad].
    double dec_rad = 0.0;       ///< Declination of LOS in ECI [rad].
    double az_rad = 0.0;        ///< Azimuth from North, clockwise [rad].
    double el_rad = 0.0;        ///< Elevation above horizon [rad].
};

/// Predict the noise-free observable components of an ECI state.
///
/// Range is |r_sc - r_sta|.  Range-rate is the projection of the relative
/// velocity onto the line of sight, with the station velocity from Earth
/// rotation.  RA is the right ascension of the line of sight in ECI,
/// dec the declination.  Az/el come from the local SEZ frame (azimuth
/// measured clockwise from North).
///
/// @param r_eci    Target position in ECI [km].
/// @param v_eci    Target velocity in ECI [km/s].
/// @param station  Observing ground station.
/// @param jd       Julian Date [days].
/// @return All six observable components.
inline PredictedComponents predict_observation(const Vec3& r_eci,
                                               const Vec3& v_eci,
                                               const ODGroundStation& station,
                                               double jd) {
    const Vec3 r_sta = station.position_eci(jd);
    const Vec3 v_sta = station.velocity_eci(jd);
    const Vec3 r_rel = r_eci - r_sta;
    const Vec3 v_rel = v_eci - v_sta;
    const double range_km = r_rel.magnitude();

    PredictedComponents out;
    out.range_km = range_km;
    out.range_rate_kms = r_rel.dot(v_rel) / range_km;

    double ra = std::atan2(r_rel.y, r_rel.x);
    if (ra < 0.0) ra += TWO_PI;
    out.ra_rad = ra;
    out.dec_rad = std::asin(std::clamp(r_rel.z / range_km, -1.0, 1.0));

    const Vec3 r_rel_ecef = teme_to_ecef(r_rel, jd);
    const Vec3 sez = ecef_to_sez(r_rel_ecef, station.lat_rad,
                                 station.lon_rad);
    double az = std::atan2(sez.y, -sez.x);
    if (az < 0.0) az += TWO_PI;
    out.az_rad = az;
    out.el_rad = std::asin(std::clamp(sez.z / range_km, -1.0, 1.0));
    return out;
}

/// Select the value and sigma vectors for one observation type.
///
/// @param components  Predicted components.
/// @param obs_type    Observation type to extract.
/// @param config      Sigma configuration.
/// @param values      Output values (length obs_ndim(obs_type)).
/// @param sigmas      Output sigmas (same length).
inline void values_and_sigmas_for(const PredictedComponents& components,
                                  ObsType obs_type, const ObsConfig& config,
                                  double* values, double* sigmas) {
    switch (obs_type) {
        case ObsType::RANGE:
            values[0] = components.range_km;
            sigmas[0] = config.sigma_range_km;
            break;
        case ObsType::RANGE_RATE:
            values[0] = components.range_rate_kms;
            sigmas[0] = config.sigma_range_rate_kms;
            break;
        case ObsType::RA_DEC:
            values[0] = components.ra_rad;
            values[1] = components.dec_rad;
            sigmas[0] = config.sigma_angles_rad[0];
            sigmas[1] = config.sigma_angles_rad[1];
            break;
        case ObsType::AZ_EL:
            values[0] = components.az_rad;
            values[1] = components.el_rad;
            sigmas[0] = config.sigma_az_el_rad[0];
            sigmas[1] = config.sigma_az_el_rad[1];
            break;
    }
}

/// Build a noise-free ODObservation for one type from predicted components.
inline ODObservation make_observation(const PredictedComponents& components,
                                      double jd, int station_index,
                                      ObsType obs_type,
                                      const ObsConfig& config) {
    ODObservation obs;
    obs.time_jd = jd;
    obs.station_index = station_index;
    obs.obs_type = obs_type;
    obs.ndim = obs_ndim(obs_type);
    values_and_sigmas_for(components, obs_type, config, obs.values,
                          obs.sigmas);
    return obs;
}

// ============================================================================
// Seeded Noise Synthesis
// ============================================================================

/// Deterministic normal generator: std::mt19937_64 plus a manual
/// Box-Muller transform (avoids <random> distribution implementation
/// differences across standard libraries).
class SeededNormalGenerator {
public:
    explicit SeededNormalGenerator(std::uint64_t seed) : rng_(seed) {}

    /// Standard normal draw N(0, 1).
    double next_standard_normal() {
        if (has_spare_) {
            has_spare_ = false;
            return spare_;
        }
        // u1 in (0, 1]; u2 in [0, 1).
        const double u1 =
            static_cast<double>(rng_() >> 11) * (1.0 / 9007199254740992.0);
        const double u2 =
            static_cast<double>(rng_() >> 11) * (1.0 / 9007199254740992.0);
        const double mag = std::sqrt(-2.0 * std::log(u1 == 0.0 ? 1e-300 : u1));
        const double z0 = mag * std::cos(TWO_PI * u2);
        spare_ = mag * std::sin(TWO_PI * u2);
        has_spare_ = true;
        return z0;
    }

    /// Normal draw N(0, sigma).
    double next_normal(double sigma) {
        return sigma * next_standard_normal();
    }

private:
    std::mt19937_64 rng_;
    bool has_spare_ = false;
    double spare_ = 0.0;
};

// ============================================================================
// generate_observations
// ============================================================================

/// Simulate noisy observations of given truth states from one station.
///
/// For each epoch the noise-free components are predicted, then Gaussian
/// noise with the configured sigmas is added to each requested type.  The
/// same generator serves every component, in epoch order then obs_types
/// order, so a seeded generator gives a reproducible noise sequence.
///
/// @param states         Truth states (position, velocity, epoch) in ECI.
/// @param station        Observing ground station.
/// @param station_index  Station index recorded in each observation.
/// @param obs_types      Observation types to generate at each epoch.
/// @param config         Sigma configuration.
/// @param seed           RNG seed owned by the caller.
/// @return Noisy observations, one per (epoch, obs_type).
inline std::vector<ODObservation> generate_observations(
    const std::vector<StateVector>& states,
    const ODGroundStation& station,
    int station_index,
    const std::vector<ObsType>& obs_types,
    const ObsConfig& config,
    std::uint64_t seed) {
    std::vector<ODObservation> out;
    out.reserve(states.size() * obs_types.size());

    SeededNormalGenerator rng(seed);

    for (const auto& state : states) {
        const PredictedComponents components = predict_observation(
            state.position, state.velocity, station, state.epoch);
        for (ObsType obs_type : obs_types) {
            ODObservation obs = make_observation(components, state.epoch,
                                                 station_index, obs_type,
                                                 config);
            const int ndim = obs.ndim;
            for (int i = 0; i < ndim; ++i) {
                obs.values[i] += rng.next_normal(obs.sigmas[i]);
            }
            out.push_back(obs);
        }
    }
    return out;
}

}  // namespace orbit
