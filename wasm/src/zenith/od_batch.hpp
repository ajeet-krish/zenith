#pragma once

/// @file od_batch.hpp
/// @brief Batch least-squares orbit determination: Gauss-Newton with step
///        halving, 3-sigma residual editing with warm restarts, Bayesian
///        a-priori constraint, and formal covariance.
///
///        Golden-master port of helio_ob src/helio/od_batch.py (6D mode
///        only; the 7D drag estimator is a Phase 4 fast-follow and the
///        estimate_cd field is reserved, always false here). The numerics
///        are replicated exactly so golden-master fixtures agree with the
///        Python reference. Do NOT optimize away these parity quirks:
///
///        - Objective evaluations during step halving use the SAME
///          variational propagator (propagate_with_stm) as Jacobian
///          epochs, so halving objective values are bit-identical to
///          Jacobian-linearization evaluations.
///        - Per-epoch independent propagation from the estimation epoch
///          (NO sequential STM composition); propagations are cached on
///          exact observation-epoch float equality.
///        - Two-body arcs use the same variational path with the J2 tier
///          disabled (force_tier = TWO_BODY; helio passes j2=0.0, whose
///          J2 term is exactly zero).
///        - Step halving tries factors {1, 1/2, ..., 1/256} (max 8
///          halvings), accepting the first trial with
///          obj_try <= obj * (1 + 1e-12); a step already below BOTH dx
///          tolerances is accepted unconditionally (roundoff-floor
///          guard).
///        - Convergence requires all three of ||dx_r|| < 1e-6 km,
///          ||dx_v|| < 1e-9 km/s, and (wrms <= 1e-7 floor OR relative
///          wrms change < 1e-3).
///        - Editing flags |b/sigma| > 3.0 rows, removes at most
///          floor(0.10 * m_active) worst-first (stable order) per round,
///          warm-restarts from the CURRENT accepted state, max 3 rounds,
///          max 10 iterations per (re)start.
///        - Final covariance = inv(N_active + P0^-1); wrms =
///          sqrt(chi2 / m_active); reduced_chi2 = chi2 / (m_active - 6),
///          NaN when m_active <= 6 (reported only, never inflates P).
///        - RA residuals are wrapped via wrap_angle to [-pi, pi).
///        - A-priori enters iterations AND final covariance
///          (N += P0^-1, rhs += P0^-1 (x0 - x)); its covariance is
///          validated SPD via Cholesky at input.
///
///        Documented divergences from Helio (error-status mapping; no
///        exceptions cross the WASM boundary):
///        - Helio raises uncaught np.linalg.LinAlgError when the FINAL
///          covariance inv(N) is singular (rank-deficient arcs reach it
///          even after the iteration loop bailed); C++ returns
///          ERROR_SINGULAR_N with a finite state instead of crashing.
///        - Mid-iteration singular normal equations return the current
///          state with converged = false (Helio parity: caught
///          LinAlgError path), reported as ERROR_NOT_CONVERGED.
///        - scipy integration RuntimeError maps to ERROR_INTEGRATION.
///
///        Units: km, km/s, rad, s, days (epochs as JD). States are ECI
///        (GMST-only frame). Station geometry is PRE-RESOLVED by the
///        caller into each observation record (tech-lead decision: no
///        station handles inside the pure compute kernel).
///
///        Reference: helio_ob src/helio/od_batch.py (source of truth),
///        Escobal, Methods of Orbit Determination (1965), batch LSQ
///        chapter.

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <vector>

#include "integrators.hpp"
#include "matrix_ops.hpp"
#include "observations.hpp"
#include "od_constants.hpp"
#include "orbit_types.hpp"
#include "partials.hpp"
#include "time_system.hpp"

namespace orbit {

// ============================================================================
// Module Constants (helio parity)
// ============================================================================

/// Below this WRMS the relative-change convergence test is numerically
/// meaningless: noise-free radiometric arcs sit at a roundoff WRMS of
/// about 3e-8, so the floor must sit above that. Any WRMS at or below
/// the floor counts as converged. (helio od_batch._WRMS_FLOOR)
inline constexpr double BATCH_WRMS_FLOOR = 1e-7;

/// Maximum step-halvings per Gauss-Newton iteration; trial factors are
/// 1, 1/2, ..., 1/256 (i.e. _MAX_HALVINGS + 1 = 9 trials).
inline constexpr int BATCH_MAX_HALVINGS = 8;

/// Variational propagator tolerances (helio propagate_j2_with_stm
/// defaults: rtol 1e-10, atol 1e-12).
inline constexpr double BATCH_STM_RTOL = 1e-10;
inline constexpr double BATCH_STM_ATOL = 1e-12;

/// Step-halving objective acceptance band (obj_try <= obj * (1 + eps)).
inline constexpr double BATCH_HALVING_EPS = 1e-12;

// ============================================================================
// BatchError: status codes (helio exception taxonomy, no exceptions)
// ============================================================================

/// Status / error codes for batch_od_solve results.
///
/// Mirrors helio_ob's exception split: ValueErrors (empty observations,
/// AZ_EL rows, non-positive sigmas, bad guess shape) map to
/// ERROR_INPUT; a-priori validation failures map to
/// ERROR_A_PRIORI_INVALID; scipy integration RuntimeErrors map to
/// ERROR_INTEGRATION; the uncaught final-covariance LinAlgError maps to
/// ERROR_SINGULAR_N; a completed solve that did not meet the
/// convergence tolerances reports ERROR_NOT_CONVERGED (the converged
/// flag carries the same information).
enum class BatchError : int {
    OK = 0,                     ///< Solve completed and converged.
    ERROR_INPUT = 1,            ///< Empty obs, AZ_EL rows, non-positive sigmas, bad guess, estimate_cd.
    ERROR_NOT_CONVERGED = 2,    ///< Solver completed but tolerances were not met.
    ERROR_SINGULAR_N = 3,       ///< Final covariance inv(N) singular (rank-deficient active set).
    ERROR_INTEGRATION = 4,      ///< Variational propagation failed (step limit / bad state).
    ERROR_A_PRIORI_INVALID = 5  ///< A-priori covariance not symmetric positive definite.
};

// ============================================================================
// BatchConfig
// ============================================================================

/// Configuration knobs for the batch least-squares solver (helio
/// BatchConfig port, plus the Phase 1 force-tier selector).
struct BatchConfig {
    double mu = MU_EARTH;         ///< Reserved: arc propagation uses the compiled MU_EARTH (helio propagate_j2_with_stm defaults; batch_od has no mu knob).
    int force_tier = 1;           ///< 0 = TWO_BODY (helio j2_for_stm=0.0), 1 = J2 default constant (helio j2_for_stm=None).
    int max_iter = 10;            ///< Max Gauss-Newton iterations per (re)start.
    double tol_pos_km = 1e-6;     ///< dx position norm convergence tolerance [km].
    double tol_vel_kms = 1e-9;    ///< dx velocity norm convergence tolerance [km/s].
    double tol_wrms_rel = 1e-3;   ///< Relative WRMS-change convergence tolerance.
    double sigma_edit = 3.0;      ///< Residual editing threshold [sigmas].
    double edit_max_fraction = 0.10;  ///< Max removable fraction of active rows per round.
    int edit_max_rounds = 3;      ///< Max warm-restart editing rounds.
    bool enable_editing = true;   ///< false disables the editing loop entirely.
    bool estimate_cd = false;     ///< Reserved for Phase 4 drag mode; always false in Phase 3 (rejected if true).
};

// ============================================================================
// APrioriState
// ============================================================================

/// Bayesian a-priori constraint on the estimated epoch state.
///
/// The covariance must be symmetric positive definite; validate with
/// apriori_validate() (Cholesky, helio __post_init__ parity) before
/// solving. Row-major 6x6 covariance.
struct APrioriState {
    bool valid = false;                    ///< When false the solver ignores the constraint.
    std::array<double, 6> x0{};            ///< A-priori state at the estimation epoch [km, km/s].
    std::array<double, 36> cov{};          ///< A-priori covariance (6x6 row-major).
};

/// Validate an a-priori covariance: symmetric (atol 1e-12) and positive
/// definite (Cholesky). Helio APrioriState.__post_init__ parity.
///
/// @param ap  A-priori constraint (valid flag ignored; fields checked).
/// @return True when the covariance is symmetric positive definite.
inline bool apriori_validate(const APrioriState& ap) {
    Mat6d c;
    for (std::size_t k = 0; k < 36; ++k) c.data[k] = ap.cov[k];
    for (std::size_t i = 0; i < 6; ++i) {
        for (std::size_t j = 0; j < 6; ++j) {
            if (std::abs(c(i, j) - c(j, i)) > 1e-12) {
                return false;  // Not symmetric.
            }
        }
    }
    Mat6d l;
    return cholesky(c, l);  // false when not positive definite.
}

// ============================================================================
// BatchObs / ResidualRow / BatchResult
// ============================================================================

/// One observation with station geometry pre-resolved at its epoch.
///
/// The caller (WASM wrapper or native test) evaluates the station ECI
/// position and velocity at time_jd via od_station_position_eci /
/// od_station_velocity_eci (or the canonical stations natively), so the
/// kernel never touches the station store. AZ_EL is rejected by the
/// solver (batch estimation supports RANGE, RANGE_RATE, RA_DEC only).
struct BatchObs {
    double time_jd = 0.0;   ///< Observation epoch as Julian Date [days].
    Vec3 sta_pos{};         ///< Station position in ECI at time_jd [km].
    Vec3 sta_vel{};         ///< Station velocity in ECI at time_jd [km/s].
    ObsType obs_type = ObsType::RANGE;
    int ndim = 1;           ///< Scalar components (1 or 2); must match obs_ndim(obs_type).
    double values[2] = {0.0, 0.0};  ///< Measured values (km, km/s, or rad).
    double sigmas[2] = {0.0, 0.0};  ///< One-sigma uncertainties (must be > 0).
};

/// Post-fit residual summary, one entry per original scalar row (helio
/// ResidualTable). Edited rows keep their residual values for reporting
/// but were excluded from the solution.
///
/// Slot layout: [0] carries the row's OWN scalar component (the k-th
/// component of the source observation); [1] carries the companion
/// component of the SAME observation for 2-dim (RA_DEC) rows (RA row =
/// [RA, Dec], Dec row = [Dec, RA]) and stays 0 for scalar rows. Thus
/// normalized[i] == residual[i] / sigma[i] for every populated slot.
struct BatchResidualRow {
    double time_jd = 0.0;        ///< Observation epoch of the source observation [days].
    int obs_type = 0;            ///< ObsType as int (0=RANGE, 1=RANGE_RATE, 2=RA_DEC).
    int ndim = 1;                ///< Component count of the source observation (1 or 2).
    double values[2] = {0.0, 0.0};      ///< Measured values; [0] is this row's component.
    double predicted[2] = {0.0, 0.0};   ///< Predicted values at the final state.
    double residual[2] = {0.0, 0.0};    ///< measured - predicted (RA wrapped).
    double sigma[2] = {0.0, 0.0};       ///< Original measurement sigmas.
    double normalized[2] = {0.0, 0.0};  ///< residual / sigma.
    bool edited = false;                ///< True when edited out of the solution.
};

/// Result of a batch least-squares orbit determination run (helio
/// BatchODResult, 6D mode).
struct BatchResult {
    BatchError error = BatchError::OK;   ///< Status code (OK when converged).
    bool converged = false;              ///< Final iteration loop met the tolerances.
    int iterations = 0;                  ///< Total Gauss-Newton iterations across all rounds.
    std::array<double, 6> state{};       ///< ECI state at epoch_jd [km, km/s].
    std::array<double, 36> cov{};        ///< Formal covariance inv(N) at the converged active set (6x6 row-major).
    std::array<double, 6> formal_sigmas{};  ///< sqrt(diag(cov)).
    double wrms = 0.0;                   ///< Post-fit sqrt(chi2 / m_active) over active rows.
    double reduced_chi2 = 0.0;           ///< chi2 / (m_active - 6); NaN when m_active <= 6.
    int n_rows = 0;                      ///< Total scalar rows (sum of obs ndim).
    int n_active = 0;                    ///< Active scalar rows at the final solution.
    int edited_count = 0;                ///< n_rows - n_active.
    std::vector<BatchResidualRow> residuals;  ///< Full residual table, all original rows.
};

// ============================================================================
// Flat-Array Parsing (WASM boundary; see exports.cpp for layouts)
// ============================================================================

/// Parsed observation table outcome.
struct BatchObsTable {
    std::vector<BatchObs> obs;
    bool ok = false;  ///< False when the flat buffer is malformed.
};

/// Parse the WASM flat observation table.
///
/// Layout: N concatenated records of
///   [time_jd(1), sta_pos(3), sta_vel(3), obs_type(1), ndim(1),
///    values(ndim), sigmas(ndim)]
/// i.e. 9 + 2*ndim doubles per record (tech-lead Phase 3 design:
/// station ECI pre-resolved by the caller, no handles inside).
inline BatchObsTable parse_obs_flat(const double* flat, std::size_t len) {
    BatchObsTable table;
    std::size_t i = 0;
    while (i < len) {
        if (len - i < 9) {
            table.ok = false;
            table.obs.clear();
            return table;
        }
        BatchObs o;
        o.time_jd = flat[i + 0];
        o.sta_pos = Vec3(flat[i + 1], flat[i + 2], flat[i + 3]);
        o.sta_vel = Vec3(flat[i + 4], flat[i + 5], flat[i + 6]);
        const int type_int = static_cast<int>(flat[i + 7]);
        o.ndim = static_cast<int>(flat[i + 8]);
        if (type_int < 0 || type_int > 3 || (o.ndim != 1 && o.ndim != 2)) {
            table.ok = false;
            table.obs.clear();
            return table;
        }
        o.obs_type = static_cast<ObsType>(type_int);
        if (len - i < 9 + static_cast<std::size_t>(2 * o.ndim)) {
            table.ok = false;
            table.obs.clear();
            return table;
        }
        for (int k = 0; k < o.ndim; ++k) {
            o.values[k] = flat[i + 9 + k];
            o.sigmas[k] = flat[i + 9 + o.ndim + k];
        }
        table.obs.push_back(o);
        i += 9 + static_cast<std::size_t>(2 * o.ndim);
    }
    table.ok = true;
    return table;
}

/// Parse the WASM flat config array (10 doubles):
///   [mu, force_tier, max_iter, tol_pos_km, tol_vel_kms, tol_wrms_rel,
///    sigma_edit, edit_max_fraction, edit_max_rounds, enable_editing].
///
/// Short buffers are partially applied over defaults; iteration budget
/// is clamped to [1, 100], sigma_edit to [0.1, 100.0], and
/// edit_max_fraction to [0.0, 0.5] (defense-in-depth, matching
/// od_gauss_iod for the iteration budget).
inline bool parse_config_flat(const double* flat, std::size_t len,
                              BatchConfig& cfg) {
    if (len > 0) cfg.mu = flat[0];
    if (len > 1) cfg.force_tier = static_cast<int>(flat[1]);
    if (len > 2) {
        cfg.max_iter =
            std::clamp(static_cast<int>(flat[2]), 1, 100);
    }
    if (len > 3) cfg.tol_pos_km = flat[3];
    if (len > 4) cfg.tol_vel_kms = flat[4];
    if (len > 5) cfg.tol_wrms_rel = flat[5];
    if (len > 6) cfg.sigma_edit = std::clamp(flat[6], 0.1, 100.0);
    if (len > 7) cfg.edit_max_fraction = std::clamp(flat[7], 0.0, 0.5);
    if (len > 8) {
        cfg.edit_max_rounds =
            std::clamp(static_cast<int>(flat[8]), 0, 10);
    }
    if (len > 9) cfg.enable_editing = flat[9] != 0.0;
    return len >= 10;
}

/// Parse the WASM flat a-priori array (42 doubles):
///   [x0(6), cov(36 row-major)].
inline bool parse_apriori_flat(const double* flat, std::size_t len,
                               APrioriState& ap) {
    if (len < 42) {
        return false;
    }
    ap.valid = true;
    for (std::size_t k = 0; k < 6; ++k) ap.x0[k] = flat[k];
    for (std::size_t k = 0; k < 36; ++k) ap.cov[k] = flat[6 + k];
    return true;
}

// ============================================================================
// Internal Evaluation (helio _evaluate parity, variational path always)
// ============================================================================

namespace batch_detail {

/// Cached propagation from the estimation epoch to one unique epoch.
struct EpochState {
    Vec3 r{};
    Vec3 v{};
    std::array<double, 36> stm{};  ///< 6x6 STM, row-major (Phi from epoch).
};

/// Residual / prediction / Jacobian evaluation output (helio _evaluate).
struct EvalOutput {
    std::vector<double> residuals;  ///< Length n_rows; measured - predicted (RA wrapped).
    std::vector<double> predicted;  ///< Length n_rows.
    std::vector<double> jac;        ///< Length n_rows * 6 (row-major), empty when !with_partials.
    bool ok = true;                 ///< False on propagation or geometry failure.
};

/// Predict the value vector of one observation at a propagated epoch.
///
/// Range = |r_rel|, range-rate = (r_rel . v_rel) / rho, RA = atan2 of the
/// LOS x/y components normalized to [0, 2pi), dec = asin(u_z). Matches
/// helio predict_observation for the four batch-estimated components
/// (az/el are never estimated and are not computed).
inline void predict_values(const Vec3& r, const Vec3& v, const BatchObs& obs,
                           double* values) {
    const Vec3 r_rel = r - obs.sta_pos;
    const Vec3 v_rel = v - obs.sta_vel;
    const double rho = r_rel.magnitude();
    switch (obs.obs_type) {
        case ObsType::RANGE:
            values[0] = rho;
            return;
        case ObsType::RANGE_RATE:
            values[0] = r_rel.dot(v_rel) / rho;
            return;
        case ObsType::RA_DEC: {
            double ra = std::atan2(r_rel.y, r_rel.x);
            if (ra < 0.0) ra += TWO_PI;
            values[0] = ra;
            values[1] =
                std::asin(std::clamp(r_rel.z / rho, -1.0, 1.0));
            return;
        }
        default:
            return;  // AZ_EL rejected at input validation.
    }
}

/// Evaluate residuals, predictions, and optionally the arc Jacobian.
///
/// Residuals are measured minus predicted with the RA component wrapped
/// to [-pi, pi). Propagations from the estimation epoch to each unique
/// observation epoch are cached on exact float equality (stations
/// sharing an epoch propagate once). The variational propagator is used
/// EVEN WHEN with_partials is false, so halving objective evaluations
/// are bit-identical to Jacobian epochs (helio parity quirk; do not
/// substitute a cheaper propagator).
///
/// @param observations  All observations (active or not).
/// @param state6        Trial ECI state at epoch_jd (length 6).
/// @param epoch_jd      Estimation epoch [days].
/// @param force_tier    0 = two-body, 1 = J2.
/// @param with_partials Also return the arc Jacobian.
/// @return EvalOutput; ok is false on propagation or geometry failure.
inline EvalOutput evaluate(const std::vector<BatchObs>& observations,
                           const double* state6, double epoch_jd,
                           int force_tier, bool with_partials) {
    EvalOutput out;
    const std::size_t n_rows = [&observations]() {
        std::size_t n = 0;
        for (const BatchObs& o : observations) {
            n += static_cast<std::size_t>(o.ndim);
        }
        return n;
    }();
    out.residuals.resize(n_rows);
    out.predicted.resize(n_rows);
    if (with_partials) {
        out.jac.assign(n_rows * 6, 0.0);
    }

    std::map<double, EpochState> cache;
    std::size_t row = 0;
    for (const BatchObs& o : observations) {
        auto it = cache.find(o.time_jd);
        if (it == cache.end()) {
            const double dt = (o.time_jd - epoch_jd) * SEC_PER_DAY;
            std::array<double, 42> y0{};
            for (int i = 0; i < 6; ++i) y0[static_cast<std::size_t>(i)] = state6[i];
            for (int i = 0; i < 6; ++i) {
                y0[6 + static_cast<std::size_t>(i * 6 + i)] = 1.0;
            }
            const STMResult res = propagate_with_stm(
                y0, 0.0, dt, BATCH_STM_RTOL, BATCH_STM_ATOL, force_tier);
            if (!res.success) {
                out.ok = false;
                return out;
            }
            EpochState e;
            e.r = res.position;
            e.v = res.velocity;
            e.stm = res.stm;
            it = cache.emplace(o.time_jd, e).first;
        }
        const EpochState& e = it->second;

        const Vec3 r_rel = e.r - o.sta_pos;
        const Vec3 v_rel = e.v - o.sta_vel;
        const double rho = r_rel.magnitude();
        if (rho < PARTIAL_RHO_MIN_KM) {
            out.ok = false;  // Satellite coincides with the station.
            return out;
        }
        const Vec3 u = r_rel / rho;

        double pred[2] = {0.0, 0.0};
        predict_values(e.r, e.v, o, pred);

        // Residual rows for this observation (sequence order, ndim rows).
        const std::size_t nd = static_cast<std::size_t>(o.ndim);
        for (std::size_t k = 0; k < nd; ++k) {
            double b = o.values[k] - pred[k];
            if (o.obs_type == ObsType::RA_DEC && k == 0) {
                b = wrap_angle(b);
            }
            out.residuals[row + k] = b;
            out.predicted[row + k] = pred[k];
        }

        if (with_partials) {
            // Analytic G = dh/d(r, v) at the observation epoch, then
            // jac_rows = G @ Phi (H_k = G_k @ Phi(t_k, epoch)).
            double g_rows[12] = {0.0};
            int g_nrows = 0;
            switch (o.obs_type) {
                case ObsType::RANGE:
                    range_partial(u, g_rows);
                    g_nrows = 1;
                    break;
                case ObsType::RANGE_RATE:
                    range_rate_partial(r_rel, v_rel, rho, u, g_rows);
                    g_nrows = 1;
                    break;
                case ObsType::RA_DEC:
                    if (!ra_dec_partials(r_rel, rho, u, g_rows)) {
                        out.ok = false;
                        return out;
                    }
                    g_nrows = 2;
                    break;
                default:
                    out.ok = false;
                    return out;  // AZ_EL never reaches here.
            }
            for (int gr = 0; gr < g_nrows; ++gr) {
                for (std::size_t j = 0; j < 6; ++j) {
                    double sum = 0.0;
                    for (std::size_t k = 0; k < 6; ++k) {
                        sum += g_rows[static_cast<std::size_t>(gr) * 6 + k] *
                               e.stm[k * 6 + j];
                    }
                    out.jac[(row + static_cast<std::size_t>(gr)) * 6 + j] = sum;
                }
            }
        }
        row += nd;
    }
    out.ok = true;
    return out;
}

/// Weighted chi2 sum((residual / sigma)^2) over active rows (helio
/// _chi2_of on the active slice).
inline double chi2_of(const std::vector<double>& residuals,
                      const std::vector<double>& sigmas,
                      const std::vector<bool>& active) {
    double acc = 0.0;
    for (std::size_t i = 0; i < residuals.size(); ++i) {
        if (!active[i]) continue;
        const double w = residuals[i] / sigmas[i];
        acc += w * w;
    }
    return acc;
}

/// Scalar minimized by the solver: active-set chi2 plus the a-priori
/// quadratic term dp^T P0^-1 dp (helio _objective).
inline double objective(const std::vector<double>& residuals,
                        const std::vector<double>& sigmas,
                        const std::vector<bool>& active, const double* state,
                        const APrioriState* a_priori,
                        const Mat6d& prior_prec) {
    double obj = chi2_of(residuals, sigmas, active);
    if (a_priori != nullptr) {
        double dp[6];
        for (std::size_t i = 0; i < 6; ++i) dp[i] = state[i] - a_priori->x0[i];
        // dp^T P0^-1 dp.
        double acc = 0.0;
        for (std::size_t i = 0; i < 6; ++i) {
            double row_sum = 0.0;
            for (std::size_t j = 0; j < 6; ++j) {
                row_sum += prior_prec(i, j) * dp[j];
            }
            acc += dp[i] * row_sum;
        }
        obj += acc;
    }
    return obj;
}

/// Relative WRMS-change convergence test with the noise-free floor
/// (helio _wrms_converged). wrms_old_known = false on the first
/// iteration of a round (helio wrms_old is None).
inline bool wrms_converged(double wrms_new, bool wrms_old_known,
                           double wrms_old, double tol_rel) {
    if (wrms_new <= BATCH_WRMS_FLOOR) {
        return true;
    }
    if (!wrms_old_known) {
        return false;
    }
    const double denom = std::max(wrms_old, BATCH_WRMS_FLOOR);
    return std::abs(wrms_new - wrms_old) / denom < tol_rel;
}

/// Outcome of one Gauss-Newton iteration loop (helio _run_iterations).
struct IterOutcome {
    std::array<double, 6> state{};
    int iterations = 0;
    bool converged = false;
    double wrms = 0.0;
    bool failed = false;  ///< True on integration failure (Helio: uncaught).
};

/// Run Gauss-Newton iterations with step halving to convergence.
///
/// @param observations  Full observation sequence.
/// @param state_in      Initial state at epoch_jd (length 6).
/// @param epoch_jd      Estimation epoch [days].
/// @param force_tier    0 = two-body, 1 = J2.
/// @param config        Solver configuration.
/// @param active        Active-row mask (length n_rows).
/// @param sigmas        Full sigma vector (length n_rows).
/// @param a_priori      Optional a-priori constraint (nullptr = pure batch).
/// @param prior_prec    P0^-1 (only read when a_priori != nullptr).
inline IterOutcome run_iterations(const std::vector<BatchObs>& observations,
                                  const double* state_in, double epoch_jd,
                                  int force_tier, const BatchConfig& config,
                                  const std::vector<bool>& active,
                                  const std::vector<double>& sigmas,
                                  const APrioriState* a_priori,
                                  const Mat6d& prior_prec) {
    IterOutcome outcome;
    for (std::size_t i = 0; i < 6; ++i) outcome.state[i] = state_in[i];

    std::size_t m_active = 0;
    for (bool a : active) {
        if (a) ++m_active;
    }

    bool wrms_old_known = false;
    double wrms_old = 0.0;

    for (int iter = 0; iter < config.max_iter; ++iter) {
        const EvalOutput ev = evaluate(observations, outcome.state.data(),
                                       epoch_jd, force_tier, true);
        if (!ev.ok) {
            outcome.failed = true;
            return outcome;
        }
        const double chi2 = chi2_of(ev.residuals, sigmas, active);
        const double wrms = std::sqrt(chi2 / static_cast<double>(m_active));
        const double obj =
            objective(ev.residuals, sigmas, active, outcome.state.data(),
                      a_priori, prior_prec);

        // Weighted normal equations N = A^T W A (+ P0^-1),
        // rhs = A^T W b (+ P0^-1 (x0 - x)).
        Mat6d normal;
        Vec6d rhs;
        for (std::size_t r = 0; r < active.size(); ++r) {
            if (!active[r]) continue;
            const double w = 1.0 / (sigmas[r] * sigmas[r]);
            const double b = ev.residuals[r];
            for (std::size_t i = 0; i < 6; ++i) {
                const double gi = ev.jac[r * 6 + i];
                rhs[i] += w * gi * b;
                for (std::size_t j = 0; j < 6; ++j) {
                    normal(i, j) += w * gi * ev.jac[r * 6 + j];
                }
            }
        }
        if (a_priori != nullptr) {
            for (std::size_t i = 0; i < 6; ++i) {
                double row_sum = 0.0;
                for (std::size_t j = 0; j < 6; ++j) {
                    normal(i, j) += prior_prec(i, j);
                    row_sum += prior_prec(i, j) * (a_priori->x0[j] - outcome.state[j]);
                }
                rhs[i] += row_sum;
            }
        }

        Vec6d dx;
        if (!lu_solve(normal, rhs, dx)) {
            // Helio: caught LinAlgError -> return current x, converged=False.
            outcome.iterations = iter;  // dx never counted.
            outcome.converged = false;
            outcome.wrms = wrms;
            return outcome;
        }
        for (std::size_t i = 0; i < 6; ++i) {
            if (!std::isfinite(dx[i])) {
                outcome.iterations = iter;
                outcome.converged = false;
                outcome.wrms = wrms;
                return outcome;
            }
        }
        ++outcome.iterations;

        // Step halving: accept the first trial that does not increase the
        // objective. A step already below the dx tolerances is accepted
        // unconditionally: at the noise-free floor the objective wobbles
        // at roundoff and would otherwise reject a converged micro-step.
        const double dx_pos = Vec3(dx[0], dx[1], dx[2]).magnitude();
        const double dx_vel = Vec3(dx[3], dx[4], dx[5]).magnitude();
        const bool step_is_tiny = dx_pos < config.tol_pos_km &&
                                  dx_vel < config.tol_vel_kms;
        double factor = 1.0;
        bool accepted = false;
        std::array<double, 6> x_new{};
        std::vector<double> b_new;
        for (std::size_t i = 0; i < 6; ++i) {
            x_new[i] = outcome.state[i] + dx[i];
        }
        b_new = ev.residuals;
        for (int h = 0; h <= BATCH_MAX_HALVINGS; ++h) {
            double x_try[6];
            for (std::size_t i = 0; i < 6; ++i) {
                x_try[i] = outcome.state[i] + factor * dx[i];
            }
            const EvalOutput ev_try =
                evaluate(observations, x_try, epoch_jd, force_tier, false);
            if (!ev_try.ok) {
                outcome.failed = true;
                return outcome;
            }
            const double obj_try =
                objective(ev_try.residuals, sigmas, active, x_try, a_priori,
                          prior_prec);
            if (obj_try <= obj * (1.0 + BATCH_HALVING_EPS) || step_is_tiny) {
                x_new = {};
                for (std::size_t i = 0; i < 6; ++i) x_new[i] = x_try[i];
                b_new = ev_try.residuals;
                accepted = true;
                break;
            }
            factor *= 0.5;
        }
        if (!accepted) {
            outcome.converged = false;
            outcome.wrms = wrms;
            return outcome;
        }

        double chi2_new = 0.0;
        for (std::size_t r = 0; r < active.size(); ++r) {
            if (!active[r]) continue;
            const double w = b_new[r] / sigmas[r];
            chi2_new += w * w;
        }
        const double wrms_new =
            std::sqrt(chi2_new / static_cast<double>(m_active));
        outcome.state = x_new;
        if (dx_pos < config.tol_pos_km && dx_vel < config.tol_vel_kms &&
            wrms_converged(wrms_new, wrms_old_known, wrms_old,
                           config.tol_wrms_rel)) {
            outcome.converged = true;
            outcome.wrms = wrms_new;
            return outcome;
        }
        // Compare with the WRMS one iteration ago (the accepted trial's
        // WRMS), the standard relative-change criterion.
        wrms_old = wrms_new;
        wrms_old_known = true;
    }
    outcome.converged = false;
    outcome.wrms = wrms_old_known ? wrms_old : BATCH_WRMS_FLOOR;
    return outcome;
}

/// Flag the worst over-sigma active rows for removal this round (helio
/// _edit_rows): |residual/sigma| > sigma_edit, worst first with stable
/// ordering (ties keep the lower row index first), capped at
/// floor(edit_max_fraction * m_active).
inline std::vector<bool> edit_rows(const std::vector<double>& residuals,
                                   const std::vector<double>& sigmas,
                                   const std::vector<bool>& active,
                                   const BatchConfig& config) {
    std::vector<bool> updated = active;
    std::vector<std::pair<double, std::size_t>> flagged;  // (normalized, row)
    for (std::size_t i = 0; i < residuals.size(); ++i) {
        if (!active[i]) continue;
        const double norm = std::abs(residuals[i] / sigmas[i]);
        if (norm > config.sigma_edit) {
            flagged.emplace_back(norm, i);
        }
    }
    if (flagged.empty()) {
        return updated;
    }
    std::size_t m_active = 0;
    for (bool a : active) {
        if (a) ++m_active;
    }
    const std::size_t max_removals = static_cast<std::size_t>(
        std::floor(config.edit_max_fraction * static_cast<double>(m_active)));
    if (max_removals < 1) {
        return updated;  // Tiny arcs never edit.
    }
    // Stable worst-first: sort by normalized descending; std::stable_sort
    // preserves row-index order for equal magnitudes.
    std::stable_sort(flagged.begin(), flagged.end(),
                     [](const std::pair<double, std::size_t>& a,
                        const std::pair<double, std::size_t>& b) {
                         return a.first > b.first;
                     });
    const std::size_t n_remove =
        std::min(flagged.size(), max_removals);
    for (std::size_t k = 0; k < n_remove; ++k) {
        updated[flagged[k].second] = false;
    }
    return updated;
}

}  // namespace batch_detail

// ============================================================================
// batch_od_solve: main entry
// ============================================================================

/// Estimate an ECI state at epoch_jd by batch least squares.
///
/// Gauss-Newton with step halving on the scalar residual rows of RANGE,
/// RANGE_RATE, and RA_DEC observations (AZ_EL rejected). Each iteration
/// propagates the current epoch state to every unique observation epoch
/// with the 42-dim variational propagator (backward when the observation
/// precedes the epoch), chains the analytic measurement partials with
/// the STM, and solves the weighted normal equations (optionally
/// augmented by the a-priori precision). After the iteration loop,
/// over-sigma normalized residuals trigger hard row editing (worst rows
/// first, capped at edit_max_fraction per round) followed by a warm
/// restart from the current state, for at most edit_max_rounds rounds.
/// The final covariance is inv(N) at the converged active set;
/// reduced_chi2 is reported but does not inflate the covariance.
///
/// @param observations  Observations with pre-resolved station ECI
///                      geometry; every observation must be RANGE,
///                      RANGE_RATE, or RA_DEC with positive sigmas.
/// @param state_guess   Initial ECI state at epoch_jd (length 6).
/// @param epoch_jd      Estimation epoch [days]; the guess must be here.
/// @param config        Solver configuration (defaults: J2 tier, editing).
/// @param a_priori      Optional a-priori constraint (validated SPD);
///                      nullptr solves the pure batch problem.
/// @return BatchResult; error == OK iff the solve converged. On
///         ERROR_SINGULAR_N the state and residual table are still
///         populated but cov/sigmas are zeroed.
inline BatchResult batch_od_solve(const std::vector<BatchObs>& observations,
                                  const double* state_guess, double epoch_jd,
                                  const BatchConfig& config,
                                  const APrioriState* a_priori = nullptr) {
    BatchResult result;

    // ---- Input validation (helio batch_od ValueErrors) ----
    if (observations.empty()) {
        result.error = BatchError::ERROR_INPUT;
        return result;
    }
    for (const BatchObs& o : observations) {
        if (o.obs_type == ObsType::AZ_EL) {
            result.error = BatchError::ERROR_INPUT;
            return result;
        }
        const int nd = obs_ndim(o.obs_type);
        if (o.ndim != nd) {
            result.error = BatchError::ERROR_INPUT;
            return result;
        }
        for (int k = 0; k < nd; ++k) {
            if (!(o.sigmas[k] > 0.0)) {
                result.error = BatchError::ERROR_INPUT;
                return result;
            }
        }
    }
    for (int i = 0; i < 6; ++i) {
        if (!std::isfinite(state_guess[i])) {
            result.error = BatchError::ERROR_INPUT;
            return result;
        }
    }
    if (config.estimate_cd) {
        // Phase 3 is 6D-only; the 7D drag estimator is a Phase 4
        // fast-follow (helio estimate_cd branch not ported yet).
        result.error = BatchError::ERROR_INPUT;
        return result;
    }
    if (config.force_tier != 0 && config.force_tier != 1) {
        result.error = BatchError::ERROR_INPUT;
        return result;
    }
    if (a_priori != nullptr && a_priori->valid) {
        if (!apriori_validate(*a_priori)) {
            result.error = BatchError::ERROR_A_PRIORI_INVALID;
            return result;
        }
    }
    const APrioriState* prior =
        (a_priori != nullptr && a_priori->valid) ? a_priori : nullptr;

    // ---- Scalar row expansion (obs sequence order, ndim rows each) ----
    std::vector<double> sigmas;
    std::size_t n_rows = 0;
    for (const BatchObs& o : observations) {
        n_rows += static_cast<std::size_t>(o.ndim);
    }
    sigmas.reserve(n_rows);
    for (const BatchObs& o : observations) {
        for (int k = 0; k < o.ndim; ++k) {
            sigmas.push_back(o.sigmas[k]);
        }
    }
    result.n_rows = static_cast<int>(n_rows);

    // ---- A-priori precision P0^-1 ----
    Mat6d prior_prec;
    if (prior != nullptr) {
        Mat6d c;
        for (std::size_t k = 0; k < 36; ++k) c.data[k] = prior->cov[k];
        if (!inverse(c, prior_prec)) {
            result.error = BatchError::ERROR_A_PRIORI_INVALID;
            return result;
        }
    }

    // ---- Iteration loop ----
    std::vector<bool> active(n_rows, true);
    double x[6];
    for (int i = 0; i < 6; ++i) x[i] = state_guess[i];

    batch_detail::IterOutcome it = batch_detail::run_iterations(
        observations, x, epoch_jd, config.force_tier, config, active, sigmas,
        prior, prior_prec);
    if (it.failed) {
        result.error = BatchError::ERROR_INTEGRATION;
        for (int i = 0; i < 6; ++i) result.state[static_cast<std::size_t>(i)] = x[i];
        return result;
    }
    for (int i = 0; i < 6; ++i) x[i] = it.state[static_cast<std::size_t>(i)];
    result.iterations = it.iterations;
    result.converged = it.converged;
    result.wrms = it.wrms;

    // ---- Editing rounds with warm restarts (helio parity) ----
    if (config.enable_editing) {
        for (int round = 0; round < config.edit_max_rounds; ++round) {
            const batch_detail::EvalOutput ev = batch_detail::evaluate(
                observations, x, epoch_jd, config.force_tier, false);
            if (!ev.ok) {
                result.error = BatchError::ERROR_INTEGRATION;
                for (int i = 0; i < 6; ++i) {
                    result.state[static_cast<std::size_t>(i)] = x[i];
                }
                return result;
            }
            std::vector<bool> updated =
                batch_detail::edit_rows(ev.residuals, sigmas, active, config);
            if (updated == active) {
                break;  // Unchanged active set.
            }
            active = updated;
            // Warm restart from the CURRENT accepted state (not the
            // original guess) with the updated active mask.
            it = batch_detail::run_iterations(observations, x, epoch_jd,
                                              config.force_tier, config,
                                              active, sigmas, prior,
                                              prior_prec);
            if (it.failed) {
                result.error = BatchError::ERROR_INTEGRATION;
                for (int i = 0; i < 6; ++i) {
                    result.state[static_cast<std::size_t>(i)] = x[i];
                }
                return result;
            }
            for (int i = 0; i < 6; ++i) {
                x[i] = it.state[static_cast<std::size_t>(i)];
            }
            result.iterations += it.iterations;
            result.converged = it.converged;
            result.wrms = it.wrms;
        }
    }

    // ---- Final linearization at the converged state ----
    // Covariance on the active set, full residual table over every
    // original row.
    const batch_detail::EvalOutput ev = batch_detail::evaluate(
        observations, x, epoch_jd, config.force_tier, true);
    if (!ev.ok) {
        result.error = BatchError::ERROR_INTEGRATION;
        for (int i = 0; i < 6; ++i) result.state[static_cast<std::size_t>(i)] = x[i];
        return result;
    }

    Mat6d normal;
    for (std::size_t r = 0; r < active.size(); ++r) {
        if (!active[r]) continue;
        const double w = 1.0 / (sigmas[r] * sigmas[r]);
        for (std::size_t i = 0; i < 6; ++i) {
            const double gi = ev.jac[r * 6 + i];
            for (std::size_t j = 0; j < 6; ++j) {
                normal(i, j) += w * gi * ev.jac[r * 6 + j];
            }
        }
    }
    if (prior != nullptr) {
        for (std::size_t i = 0; i < 6; ++i) {
            for (std::size_t j = 0; j < 6; ++j) {
                normal(i, j) += prior_prec(i, j);
            }
        }
    }
    Mat6d cov;
    const bool cov_ok = inverse(normal, cov);

    std::size_t m_active = 0;
    for (bool a : active) {
        if (a) ++m_active;
    }
    const double chi2 = batch_detail::chi2_of(ev.residuals, sigmas, active);
    const double wrms =
        std::sqrt(chi2 / static_cast<double>(m_active));
    double reduced_chi2 = std::numeric_limits<double>::quiet_NaN();
    if (m_active > 6) {
        reduced_chi2 = chi2 / static_cast<double>(m_active - 6);
    }

    // ---- Residual table (all original rows; edited rows keep values) ----
    // One row per SCALAR row: a 2-dim (RA_DEC) record expands to two
    // rows, RA (k = 0) then Dec (k = 1). Each row's [0] slots carry its
    // OWN scalar component; the [1] slots carry the companion component
    // of the SAME observation (RA row: [RA, Dec], Dec row: [Dec, RA]).
    // All flat reads stay within [first, first + ndim); never one past
    // the observation (which would read the next record, or one past
    // the vector end for the last record).
    result.residuals.clear();
    result.residuals.reserve(n_rows);
    std::size_t row = 0;
    for (const BatchObs& o : observations) {
        const std::size_t first = row;
        for (int k = 0; k < o.ndim; ++k) {
            const std::size_t own = first + static_cast<std::size_t>(k);
            const std::size_t mate =
                first + static_cast<std::size_t>(1 - k);
            BatchResidualRow rr;
            rr.time_jd = o.time_jd;
            rr.obs_type = static_cast<int>(o.obs_type);
            rr.ndim = o.ndim;
            rr.values[0] = o.values[k];
            rr.values[1] = (o.ndim == 2) ? o.values[1 - k] : 0.0;
            rr.predicted[0] = ev.predicted[own];
            rr.predicted[1] = (o.ndim == 2) ? ev.predicted[mate] : 0.0;
            rr.residual[0] = ev.residuals[own];
            rr.residual[1] = (o.ndim == 2) ? ev.residuals[mate] : 0.0;
            rr.sigma[0] = o.sigmas[k];
            rr.sigma[1] = (o.ndim == 2) ? o.sigmas[1 - k] : 0.0;
            rr.normalized[0] = ev.residuals[own] / o.sigmas[k];
            rr.normalized[1] =
                (o.ndim == 2) ? ev.residuals[mate] / o.sigmas[1 - k] : 0.0;
            rr.edited = !active[own];
            result.residuals.push_back(rr);
            ++row;
        }
    }

    for (int i = 0; i < 6; ++i) {
        result.state[static_cast<std::size_t>(i)] = x[i];
    }
    result.n_active = static_cast<int>(m_active);
    result.edited_count = static_cast<int>(n_rows - m_active);
    result.wrms = wrms;
    result.reduced_chi2 = reduced_chi2;

    if (!cov_ok) {
        // Documented divergence: Helio raises an uncaught LinAlgError
        // here for rank-deficient active sets; C++ reports the error
        // status with a finite state instead of crashing.
        result.error = BatchError::ERROR_SINGULAR_N;
        return result;
    }
    for (std::size_t k = 0; k < 36; ++k) {
        result.cov[k] = cov.data[k];
    }
    for (std::size_t i = 0; i < 6; ++i) {
        const double d = cov(i, i);
        result.formal_sigmas[i] = d > 0.0 ? std::sqrt(d) : 0.0;
    }
    result.error =
        result.converged ? BatchError::OK : BatchError::ERROR_NOT_CONVERGED;
    return result;
}

}  // namespace orbit
