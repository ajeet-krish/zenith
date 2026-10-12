#pragma once

/// @file od_ekf.hpp
/// @brief Sequential extended Kalman filter orbit determination with
///        NIS innovation gating, 9D maneuver detection/estimation,
///        scheduled burns, and divergence recovery.
///
///        Golden-master port of helio_ob src/helio/od_ekf.py (6D mode
///        only; the 7D drag estimator is a Phase 5 fast-follow and the
///        estimate_cd field is reserved, rejected when true). The
///        numerics are replicated exactly so golden-master fixtures agree
///        with the Python reference. Do NOT optimize away these parity
///        quirks:
///
///        - Sequential SCALAR updates: each observation component (range,
///          range-rate, RA, Dec) is an independent 1D Kalman update with
///          a per-row NIS gate (nu^2 / S vs nis_sigma_threshold^2,
///          1-dof chi-square equivalence). Rows with NIS above the gate
///          are skipped (mask false) but their innovation and NIS are
///          STILL RECORDED (the NIS is what drives the gate). RA
///          innovation is wrapped via wrap_angle.
///        - Joseph-form covariance update P = (I - K h) P (I - K h)^T +
///          K sigma^2 K^T (valid for any K; keeps P symmetric positive
///          definite). Every P mutation ends with (P + P^T) / 2; PSD Q +
///          additive floors mean P stays SPD with no Cholesky in the hot
///          loop; S >= sigma^2 > 0 always.
///        - Predict: between consecutive observation epochs the mean and
///          covariance are propagated with the 42-dim variational DOP853
///          propagator (propagate_with_stm, helio
///          propagate_j2_with_stm); P maps as Phi P Phi^T + Q(|dt|).
///          dt == 0 (equal epochs sharing a predict) returns unchanged.
///        - Process noise Q: integrated Wiener-acceleration PSD, Q =
///          q_a * [[|dt|^5/20 I3, |dt|^4/8 I3], [|dt|^4/8 I3,
///          |dt|^3/3 I3]] (Eade 2017 Eq 45 blocks; NOT the white-accel
///          dt^3/3 form). q_a in km^2/s^5.
///        - Maneuver detection: consecutive observation EPOCHS with any
///          gated NIS exceedance (streaks count epochs, not station/type
///          observations; bookkeeping runs once after the last obs
///          sharing an epoch). On reaching consecutive_exceedances the
///          maneuver is flagged at that epoch and, when
///          estimate_maneuver is true, the filter enters the 9D
///          augmented state [r_nominal, v_nominal, dv] with dv a
///          constant velocity bias (d dv/dt = 0).
///        - 9D mechanics (PORT GOTCHA 1): the nominal 6D state
///          propagates WITHOUT the dv folding; the physical state the
///          measurement sees is s = x6 + Psi(t - t_entry) dv with
///          Psi = [[dt*I3], [I3]] (signed dt); the measurement Jacobian
///          is H = [G, G @ Psi] (dv columns MUST be G @ Psi; zero
///          columns make dv unobservable and were explicitly rejected in
///          review). STM9 = blockdiag(Phi6, I3); Q9 embeds q6 with a
///          zero dv block.
///        - Augmented entry (PORT GOTCHA 3): dv covariance starts at
///          _DV_P0 = (3e-3 km/s)^2 per axis AND the 6D velocity block
///          P[3:6, 3:6] is opened by the same amount (the detection is
///          itself evidence of an unmodeled velocity change; a
///          collapsed P66 would gate every post-detection observation
///          and dv could never be observed).
///        - Re-entry: after reentry_window_obs observation epochs in
///          augmented mode (or at the end of the arc, forced), the
///          filter contracts back to 6D by folding dv into the state
///          (x6 = x6_nominal + Psi_end dv; P6 from the congruence
///          J P J^T with J = [[I, Psi_end], [0, I]]); the dv estimate
///          is stamped with the detection epoch and stored.
///        - Scheduled burns: known a-priori burns inside
///          (t_prev, t_obs] are applied mid-predict (propagate to the
///          burn, x[3:6] += dv, P[3:6, 3:6] += scheduled_inflate_kms^2
///          I3, symmetrize, continue). A burn exactly at t_prev is
///          silently skipped (fold into state0); a burn after the last
///          observation is never applied.
///        - Divergence recovery (PORT GOTCHA 2): a sustained streak of
///          NIS-exceedance epochs (sustained_nis_count) triggers
///          recovery: P *= inflate_factor (WHOLE-MATRIX: preserves
///          symmetry/PD/correlations) PLUS additive position (0.5 km)
///          and velocity (10 m/s) covariance floors. Multiplicative
///          inflation alone fails when P has collapsed: NIS scales only
///          as the factor while the implied error can exceed the gate
///          by orders of magnitude. The velocity floor touches only the
///          6D block (rows 3..5) even in 9D mode; the dv block gets
///          inflation only. Both NIS streaks reset after recovery.
///
///        Documented divergences from Helio (no exceptions across the
///        WASM boundary):
///        - Helio raises ValueError on all input problems; C++ returns
///          EKFError::ERROR_INPUT.
///        - Helio lets a NaN state propagate silently (no validation);
///          C++ adds a non-finite state/covariance guard after each
///          predict, returning ERROR_DIVERGENCE (documented), and
///          propagator failure returns ERROR_INTEGRATION.
///        - estimate_cd (7D drag mode) is reserved and rejected with
///          ERROR_INPUT.
///        - Per-step full cov_hist (n_obs, dim, dim) is not carried in
///          EKFResult (WASM memory); per-step sigmas from the
///          congruence-transformed covariance plus the final 6x6
///          covariance are exported instead.
///
///        Units: km, km/s, rad, s, days (epochs as JD). States are ECI
///        (GMST-only frame). Station geometry is PRE-RESOLVED by the
///        caller into each observation record (Phase 3 BatchObs table;
///        no station handles inside the pure compute kernel).
///
///        Reference: helio_ob src/helio/od_ekf.py (source of truth),
///        Eade (2017), Bar-Shalom et al. (2001), MIT OCW 2.160 L8.

#include <array>
#include <cmath>
#include <limits>
#include <vector>

#include "integrators.hpp"
#include "matrix_ops.hpp"
#include "observations.hpp"
#include "od_batch.hpp"
#include "od_constants.hpp"
#include "orbit_types.hpp"
#include "partials.hpp"
#include "time_system.hpp"

namespace orbit {

// ============================================================================
// Module Constants (helio parity)
// ============================================================================

/// Initial dv variance per axis when entering augmented mode: the
/// square of a 3 m/s 1-sigma, sized to typical LEO impulsive burns
/// (mm/s to a few m/s). A much larger prior (e.g. 0.1 km/s) makes the
/// Psi Pdv Psi^T position uncertainty tens of km per predict and the
/// resulting gains pathologically large; a much tighter prior rejects
/// real burns. (helio od_ekf._DV_P0)
inline constexpr double EKF_DV_P0 = (3e-3) * (3e-3);

/// Position covariance floor (500 m 1-sigma) added to P[:3, :3] on
/// divergence recovery. (helio _RECOVERY_POS_FLOOR_KM)
inline constexpr double EKF_RECOVERY_POS_FLOOR_KM = 0.5;

/// Velocity covariance floor (10 m/s 1-sigma) added to P[3:6, 3:6] on
/// divergence recovery. (helio _RECOVERY_VEL_FLOOR_KMS)
inline constexpr double EKF_RECOVERY_VEL_FLOOR_KMS = 1e-2;

/// Variational propagator tolerances (helio propagate_j2_with_stm
/// defaults: rtol 1e-10, atol 1e-12).
inline constexpr double EKF_STM_RTOL = 1e-10;
inline constexpr double EKF_STM_ATOL = 1e-12;

// ============================================================================
// EKFError: status codes (helio exception taxonomy, no exceptions)
// ============================================================================

/// Status / error codes for ekf_solve results.
///
/// Mirrors helio_ob's exception split: all ValueErrors (empty
/// observations, unsorted epochs, AZ_EL rows, non-positive sigmas, bad
/// state/config/scheduled list, estimate_cd reserved) map to
/// ERROR_INPUT; variational propagation failure maps to
/// ERROR_INTEGRATION; a non-finite state or covariance detected after a
/// predict maps to ERROR_DIVERGENCE (C++-only guard; Helio would let
/// the NaN propagate).
enum class EKFError : int {
    OK = 0,                ///< Solve completed.
    ERROR_INPUT = 1,       ///< Empty/unsorted/AZ_EL/bad sigma/bad config/estimate_cd.
    ERROR_INTEGRATION = 2, ///< Variational propagation failed (step limit).
    ERROR_DIVERGENCE = 3   ///< Non-finite state or covariance after predict.
};

// ============================================================================
// Configuration (helio frozen dataclasses, flattened)
// ============================================================================

/// Continuous white-noise acceleration process noise settings.
///
/// q_a follows the Wiener-acceleration PSD convention, km^2/s^5 (see
/// the module docstring Q block). Defaults ported verbatim.
struct ProcessNoiseConfig {
    double q_a = 1e-10;           ///< 6D-mode Wiener acceleration PSD [km^2/s^5].
    double q_a_maneuver = 1e-6;   ///< 9D augmented-mode PSD [km^2/s^5].
};

/// Maneuver detection, estimation, and scheduling settings.
///
/// Scheduled burns are passed to ekf_solve separately (C++ flat-array
/// boundary) rather than living inside the config struct; ordering is
/// validated at solve time.
struct ManeuverConfig {
    bool estimate_maneuver = false;   ///< Enter 9D mode on detection.
    double nis_sigma_threshold = 5.0; ///< Gate in Gaussian sigmas (NIS gate = squared).
    int consecutive_exceedances = 3;  ///< Epoch streak that flags a maneuver.
    int reentry_window_obs = 20;      ///< Augmented epochs before contraction.
    double scheduled_inflate_kms = 1e-4;  ///< Velocity 1-sigma inflation at scheduled burns.
};

/// Divergence detection and covariance recovery settings.
struct RecoveryConfig {
    int sustained_nis_count = 10;   ///< Epoch streak that counts as divergence.
    double inflate_factor = 100.0;  ///< Whole-matrix covariance inflation (> 1).
};

/// Top-level EKF configuration (helio EKFConfig port, 6D mode).
struct EKFConfig {
    std::array<double, 6> p0_diag = {1.0, 1.0, 1.0, 1e-6, 1e-6, 1e-6};
    int force_tier = 1;   ///< 0 = TWO_BODY (helio j2=0.0), 1 = J2 default constant (helio j2=None).
    bool estimate_cd = false;  ///< Reserved for Phase 5 drag mode; rejected if true.
    ProcessNoiseConfig process;
    ManeuverConfig maneuver;
    RecoveryConfig recovery;
};

/// One known impulsive burn applied during the EKF predict step.
struct ScheduledBurn {
    double epoch_jd = 0.0;  ///< Burn epoch [days]; must satisfy t_prev < epoch <= t_obs.
    std::array<double, 3> dv = {0.0, 0.0, 0.0};  ///< Impulsive dv [km/s] added to ECI velocity.
};

/// One stored delta-v estimate from an augmented-mode episode,
/// stamped with the maneuver detection epoch.
struct ManeuverRecord {
    double epoch_jd = 0.0;
    std::array<double, 3> dv = {0.0, 0.0, 0.0};
};

// ============================================================================
// EKFResult
// ============================================================================

/// Result of a sequential EKF orbit determination run.
///
/// Per-step histories are indexed by observation step k (0..n_obs-1).
/// innovations / nis / updated_mask are PADDED to two slots per
/// observation (max_ndim = 2 for RA_DEC): step k component i lives at
/// index 2*k + i; the second slot of a scalar observation is padding
/// (NaN innovation/NIS, false mask). n_rows carries the true scalar-row
/// count (sum of obs ndim). state_hist holds the PHYSICAL state
/// (nominal + Psi dv while augmented); sigma_hist holds
/// sqrt(max(diag(J P J^T), 0)) of the congruence-transformed covariance
/// (6 columns; the dv variance is not per-step exported).
struct EKFResult {
    EKFError error = EKFError::OK;
    int n_obs = 0;               ///< Number of observation steps.
    int n_rows = 0;              ///< True scalar rows (sum of ndim).
    int n_updated = 0;           ///< Scalar rows whose update was applied.
    int n_gated = 0;             ///< Scalar rows skipped by the NIS gate.
    bool divergence_flag = false;///< Sustained-NIS divergence ever detected.
    int n_recoveries = 0;        ///< Covariance inflations performed.
    bool augmented_active_final = false;  ///< Arc ended while 9D augmented.
    double nis_mean = 0.0;       ///< Mean NIS over true scalar rows.
    double nis_max = 0.0;        ///< Max NIS over true scalar rows.
    int n_nis_exceed = 0;        ///< True rows with NIS above the gate.
    std::array<double, 6> final_state{};      ///< ECI state at last obs / epoch_jd [km, km/s].
    std::array<double, 6> final_cov_diag{};   ///< diag of the final 6x6 covariance.
    std::array<double, 36> final_cov{};       ///< Final 6x6 covariance, row-major.
    std::vector<double> obs_times;            ///< N observation epochs [days].
    std::vector<int> obs_types;               ///< N ObsType codes (0/1/2).
    std::vector<bool> maneuver_flag;          ///< N per-step maneuver/scheduled flags.
    std::vector<double> state_hist;           ///< N x 6 physical state, row-major.
    std::vector<double> sigma_hist;           ///< N x 6 post-update sigmas, row-major.
    std::vector<double> innovations;          ///< 2*N padded measured-minus-predicted.
    std::vector<double> nis;                  ///< 2*N padded nu^2 / S.
    std::vector<bool> updated_mask;           ///< 2*N padded per-row apply mask.
    std::vector<ManeuverRecord> maneuver_records;  ///< Stored dv estimates.
};

// ============================================================================
// Flat-Array Parsing (WASM boundary; see exports.cpp for layouts)
// ============================================================================

/// Parse the WASM flat config array (16 doubles):
///   [q_a, q_a_maneuver, estimate_maneuver (0/1), nis_sigma_threshold,
///    consecutive_exceedances, reentry_window_obs, scheduled_inflate_kms,
///    sustained_nis_count, inflate_factor, p0_diag(6), force_tier].
///
/// Short buffers are partially applied over defaults (defense-in-depth,
/// matching od_batch parse_config_flat). scheduled_inflate_kms is
/// clamped to >= 0 so a negative parse can never inject negative
/// covariance inflation (std::max also maps NaN to the 0.0 floor).
inline bool parse_ekf_config_flat(const double* flat, std::size_t len,
                                  EKFConfig& cfg) {
    if (len > 0) cfg.process.q_a = flat[0];
    if (len > 1) cfg.process.q_a_maneuver = flat[1];
    if (len > 2) cfg.maneuver.estimate_maneuver = flat[2] != 0.0;
    if (len > 3) cfg.maneuver.nis_sigma_threshold = flat[3];
    if (len > 4) cfg.maneuver.consecutive_exceedances = static_cast<int>(flat[4]);
    if (len > 5) cfg.maneuver.reentry_window_obs = static_cast<int>(flat[5]);
    if (len > 6) {
        cfg.maneuver.scheduled_inflate_kms = std::max(0.0, flat[6]);
    }
    if (len > 7) cfg.recovery.sustained_nis_count = static_cast<int>(flat[7]);
    if (len > 8) cfg.recovery.inflate_factor = flat[8];
    for (std::size_t i = 0; i < 6 && len > 9 + i; ++i) {
        cfg.p0_diag[i] = flat[9 + i];
    }
    if (len > 15) cfg.force_tier = static_cast<int>(flat[15]);
    return len >= 16;
}

/// Parse the WASM flat scheduled-burns array (4 doubles per burn):
///   [epoch_jd, dv_x, dv_y, dv_z] * n_burns (ascending epochs required).
inline std::vector<ScheduledBurn> parse_burns_flat(const double* flat,
                                                   std::size_t len) {
    std::vector<ScheduledBurn> burns;
    const std::size_t n = len / 4;
    burns.reserve(n);
    for (std::size_t i = 0; i < n; ++i) {
        ScheduledBurn b;
        b.epoch_jd = flat[4 * i + 0];
        b.dv = {flat[4 * i + 1], flat[4 * i + 2], flat[4 * i + 3]};
        burns.push_back(b);
    }
    return burns;
}

// ============================================================================
// Internal Helpers (helio _build_discrete_q / _psi_matrix parity)
// ============================================================================

namespace ekf_detail {

/// Discrete process noise Q for a Wiener-acceleration over |dt| (helio
/// _build_discrete_q): q_a * [[|dt|^5/20 I3, |dt|^4/8 I3],
/// [|dt|^4/8 I3, |dt|^3/3 I3]]. Backward predicts (dt < 0) get a
/// positive semi-definite Q via |dt|.
inline Mat6d build_discrete_q(double q_a, double dt) {
    const double dt_abs = std::abs(dt);
    const double dt2 = dt_abs * dt_abs;
    const double dt3 = dt2 * dt_abs;
    const double dt4 = dt3 * dt_abs;
    const double dt5 = dt4 * dt_abs;
    Mat6d q6;
    const double q_pos = q_a * dt5 / 20.0;
    const double q_cross = q_a * dt4 / 8.0;
    const double q_vel = q_a * dt3 / 3.0;
    for (std::size_t i = 0; i < 3; ++i) {
        q6(i, i) = q_pos;
        q6(i, 3 + i) = q_cross;
        q6(3 + i, i) = q_cross;
        q6(3 + i, 3 + i) = q_vel;
    }
    return q6;
}

/// dv-to-state coupling block Psi = [[dt*I3], [I3]] (helio _psi_matrix),
/// shape 6x3 packed as row-major 18 doubles. dt is signed so backward
/// predicts are consistent.
inline std::array<double, 18> psi_matrix(double dt) {
    std::array<double, 18> psi{};
    for (std::size_t i = 0; i < 3; ++i) {
        psi[i * 3 + i] = dt;          // rows 0..2: dt * I3.
        psi[(3 + i) * 3 + i] = 1.0;   // rows 3..5: I3.
    }
    return psi;
}

/// In-place symmetrization of the active dim x dim block: (P + P^T) / 2.
inline void symmetrize_active(Mat9d& p, int dim) {
    for (int i = 0; i < dim; ++i) {
        for (int j = i + 1; j < dim; ++j) {
            const double avg = 0.5 * (p(static_cast<std::size_t>(i),
                                        static_cast<std::size_t>(j)) +
                                      p(static_cast<std::size_t>(j),
                                        static_cast<std::size_t>(i)));
            p(static_cast<std::size_t>(i), static_cast<std::size_t>(j)) = avg;
            p(static_cast<std::size_t>(j), static_cast<std::size_t>(i)) = avg;
        }
    }
}

/// Whether all dim active entries of x / P are finite (C++-only guard;
/// Helio lets NaNs propagate).
inline bool state_finite(const Vec9d& x, const Mat9d& p, int dim) {
    for (int i = 0; i < dim; ++i) {
        if (!std::isfinite(x[static_cast<std::size_t>(i)])) return false;
        for (int j = 0; j < dim; ++j) {
            if (!std::isfinite(
                    p(static_cast<std::size_t>(i), static_cast<std::size_t>(j)))) {
                return false;
            }
        }
    }
    return true;
}

/// Predict the mean state and covariance over one interval (helio
/// _predict, 6D and 9D paths). x holds 6 or 9 active entries; the mean
/// 6D block propagates with propagate_with_stm (WITHOUT the dv folding
/// while augmented); P maps as Phi P Phi^T + Q with the augmented
/// blockdiag(Phi6, I3) / zero-dv-block embeddings. dt == 0 returns the
/// inputs unchanged. All paths re-symmetrize P.
///
/// @return False on propagator failure (caller maps to ERROR_INTEGRATION).
inline bool predict_segment(Vec9d& x, Mat9d& p, int& dim, double dt,
                            double q_a, int force_tier) {
    if (dt == 0.0) {
        return true;
    }
    std::array<double, 42> y0{};
    for (int i = 0; i < 6; ++i) {
        y0[static_cast<std::size_t>(i)] = x[static_cast<std::size_t>(i)];
    }
    for (int i = 0; i < 6; ++i) {
        y0[6 + static_cast<std::size_t>(i * 6 + i)] = 1.0;
    }
    const STMResult res =
        propagate_with_stm(y0, 0.0, dt, EKF_STM_RTOL, EKF_STM_ATOL, force_tier);
    if (!res.success) {
        return false;
    }
    const double r_end[3] = {res.position.x, res.position.y, res.position.z};
    const double v_end[3] = {res.velocity.x, res.velocity.y, res.velocity.z};
    for (int i = 0; i < 3; ++i) {
        x[static_cast<std::size_t>(i)] = r_end[i];
        x[static_cast<std::size_t>(3 + i)] = v_end[i];
    }

    const Mat6d q6 = build_discrete_q(q_a, dt);
    if (dim == 6) {
        // P6 = Phi P6 Phi^T + Q6.
        Mat6d p6;
        for (std::size_t a = 0; a < 6; ++a) {
            for (std::size_t b = 0; b < 6; ++b) {
                p6(a, b) = p(a, b);
            }
        }
        Mat6d phi;
        for (std::size_t a = 0; a < 6; ++a) {
            for (std::size_t b = 0; b < 6; ++b) {
                phi(a, b) = res.stm[a * 6 + b];
            }
        }
        const Mat6d phi_p = multiply(phi, p6);
        const Mat6d pp = multiply(phi_p, transpose(phi));
        for (std::size_t a = 0; a < 6; ++a) {
            for (std::size_t b = 0; b < 6; ++b) {
                p(a, b) = pp(a, b) + q6(a, b);
            }
        }
        symmetrize_active(p, 6);
        return true;
    }
    // Augmented 9D: STM9 = blockdiag(Phi6, I3), Q9 = embed(q6, zeros).
    Mat9d phi9;
    for (std::size_t a = 0; a < 6; ++a) {
        for (std::size_t b = 0; b < 6; ++b) {
            phi9(a, b) = res.stm[a * 6 + b];
        }
    }
    for (std::size_t a = 6; a < 9; ++a) {
        phi9(a, a) = 1.0;
    }
    const Mat9d phi_p = multiply(phi9, p);
    const Mat9d pp = multiply(phi_p, transpose(phi9));
    for (std::size_t a = 0; a < 9; ++a) {
        for (std::size_t b = 0; b < 9; ++b) {
            p(a, b) = pp(a, b);
        }
    }
    for (std::size_t a = 0; a < 6; ++a) {
        for (std::size_t b = 0; b < 6; ++b) {
            p(a, b) += q6(a, b);
        }
    }
    symmetrize_active(p, 9);
    return true;
}

/// Expand a 6D state and covariance to 9D with a zero dv estimate
/// (helio _enter_augmented_mode; PORT GOTCHA 3). The dv block starts at
/// zero with variance _DV_P0 per axis; the 6D velocity block P[3:6,
/// 3:6] is ALSO opened by _DV_P0 (detection is evidence of an unmodeled
/// velocity change; without it a collapsed P66 gates every
/// post-detection observation). Cross-covariance starts at zero.
inline void enter_augmented_mode(Vec9d& x, Mat9d& p, int& dim) {
    for (std::size_t i = 6; i < 9; ++i) {
        x[i] = 0.0;
    }
    // Cross-covariance and dv block start at zero (helio P9 = zeros
    // then P9[:6, :6] = P): a previous contraction may have left stale
    // entries in rows/columns 6..8 of the fixed 9x9 storage.
    for (std::size_t i = 0; i < 6; ++i) {
        for (std::size_t j = 6; j < 9; ++j) {
            p(i, j) = 0.0;
            p(j, i) = 0.0;
        }
    }
    for (std::size_t i = 3; i < 6; ++i) {
        p(i, i) += EKF_DV_P0;
    }
    for (std::size_t i = 6; i < 9; ++i) {
        for (std::size_t j = 6; j < 9; ++j) {
            p(i, j) = (i == j) ? EKF_DV_P0 : 0.0;
        }
    }
    dim = 9;
}

/// Leave augmented mode: store the dv estimate and fold dv into 6D
/// (helio _contract_to_6d). x6 = x6_nominal + psi_end @ dv (physical
/// state at the contraction epoch); P6 maps with the congruence
/// J P J^T, J = [[I, psi_end], [0, I]] (top-left 6x6 kept), so the 6D
/// filter continues on the physical trajectory with the burn absorbed.
inline void contract_to_6d(Vec9d& x, Mat9d& p, int& dim,
                           const std::array<double, 18>& psi_end,
                           double detection_jd,
                           std::vector<ManeuverRecord>& records) {
    ManeuverRecord rec;
    rec.epoch_jd = detection_jd;
    for (std::size_t m = 0; m < 3; ++m) {
        rec.dv[m] = x[6 + m];
    }
    records.push_back(rec);

    // x6 = x6_nom + psi_end @ dv.
    Vec9d x_new = x;
    for (std::size_t i = 0; i < 6; ++i) {
        double sum = x[i];
        for (std::size_t m = 0; m < 3; ++m) {
            sum += psi_end[i * 3 + m] * x[6 + m];
        }
        x_new[i] = sum;
    }
    x = x_new;

    // P6 = (J P J^T)[:6, :6] with J = [[I, psi_end], [0, I]]:
    // (JPJ^T)(i,j) = P(i,j) + sum_m psi(i,m) P(6+m,j)
    //              + sum_n P(i,6+n) psi(j,n)
    //              + sum_{m,n} psi(i,m) P(6+m,6+n) psi(j,n).
    Mat9d p_new = p;
    for (int i = 0; i < 6; ++i) {
        for (int j = 0; j < 6; ++j) {
            double sum = p(static_cast<std::size_t>(i), static_cast<std::size_t>(j));
            for (std::size_t m = 0; m < 3; ++m) {
                sum += psi_end[static_cast<std::size_t>(i) * 3 + m] *
                       p(6 + m, static_cast<std::size_t>(j));
                sum += p(static_cast<std::size_t>(i), 6 + m) *
                       psi_end[static_cast<std::size_t>(j) * 3 + m];
                for (std::size_t n = 0; n < 3; ++n) {
                    sum += psi_end[static_cast<std::size_t>(i) * 3 + m] *
                           p(6 + m, 6 + n) *
                           psi_end[static_cast<std::size_t>(j) * 3 + n];
                }
            }
            p_new(static_cast<std::size_t>(i), static_cast<std::size_t>(j)) = sum;
        }
    }
    for (std::size_t i = 0; i < 6; ++i) {
        for (std::size_t j = 0; j < 6; ++j) {
            p(i, j) = p_new(i, j);
        }
    }
    dim = 6;
    symmetrize_active(p, 6);
}

/// Assimilate one observation with sequential scalar Kalman updates
/// (helio _sequential_update). Each scalar component gets its own 1D
/// update: innovation nu = measured - predicted (RA wrapped),
/// innovation variance S = h P h^T + sigma^2, NIS = nu^2 / S. Rows
/// above the gate are skipped (mask false, NIS/innovation still
/// recorded); accepted rows apply K = P h^T / S and the Joseph-form
/// update (I - K h) P (I - K h)^T + K sigma^2 K^T. In augmented mode
/// the physical state is s = x6 + psi_a @ dv and H = [G, G @ psi_a]
/// (dv columns G @ Psi REQUIRED; zero columns make dv unobservable).
struct UpdateOutcome {
    std::array<double, 2> innovations = {0.0, 0.0};
    std::array<double, 2> nis = {0.0, 0.0};
    std::array<bool, 2> updated = {false, false};
    bool exceeded = false;   ///< Any row NIS above the gate.
    bool ok = true;          ///< False on singular geometry.
};

inline UpdateOutcome sequential_update(const BatchObs& obs, Vec9d& x,
                                       Mat9d& p, int dim, double threshold,
                                       const double* psi_a /* 18 doubles or null */) {
    UpdateOutcome out;

    // Physical state the measurement sees.
    Vec9d phys = x;
    if (psi_a != nullptr) {
        for (std::size_t i = 0; i < 6; ++i) {
            double sum = x[i];
            for (std::size_t m = 0; m < 3; ++m) {
                sum += psi_a[i * 3 + m] * x[6 + m];
            }
            phys[i] = sum;
        }
    }
    const Vec3 r(phys[0], phys[1], phys[2]);
    const Vec3 v(phys[3], phys[4], phys[5]);
    const Vec3 r_rel = r - obs.sta_pos;
    const Vec3 v_rel = v - obs.sta_vel;
    const double rho = r_rel.magnitude();
    if (rho < PARTIAL_RHO_MIN_KM) {
        out.ok = false;  // Satellite coincides with the station.
        return out;
    }
    const Vec3 u = r_rel / rho;

    double pred[2] = {0.0, 0.0};
    batch_detail::predict_values(r, v, obs, pred);

    // Analytic G = dh/d(r, v) at the physical state (2x6 max, row-major).
    double g_rows[12] = {0.0};
    int g_nrows = 0;
    switch (obs.obs_type) {
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
            out.ok = false;  // AZ_EL rejected at input validation.
            return out;
    }
    if (g_nrows != obs.ndim) {
        out.ok = false;
        return out;
    }

    // H row builder: 6D h = G row; 9D h = [G row, G row @ psi_a].
    auto fill_h = [&](int i, Vec9d& h) {
        for (std::size_t j = 0; j < 6; ++j) {
            h[j] = g_rows[static_cast<std::size_t>(i) * 6 + j];
        }
        if (psi_a != nullptr) {
            for (std::size_t m = 0; m < 3; ++m) {
                double sum = 0.0;
                for (std::size_t j = 0; j < 6; ++j) {
                    sum += g_rows[static_cast<std::size_t>(i) * 6 + j] *
                           psi_a[j * 3 + m];
                }
                h[6 + m] = sum;
            }
        } else {
            for (std::size_t j = 6; j < 9; ++j) {
                h[j] = 0.0;
            }
        }
    };

    for (int i = 0; i < obs.ndim; ++i) {
        double nu = obs.values[static_cast<std::size_t>(i)] -
                    pred[static_cast<std::size_t>(i)];
        if (obs.obs_type == ObsType::RA_DEC && i == 0) {
            nu = wrap_angle(nu);
        }
        out.innovations[static_cast<std::size_t>(i)] = nu;

        Vec9d h;
        fill_h(i, h);

        // S = h P h^T + sigma^2 (scalar; P updated by prior rows).
        double s = 0.0;
        for (int a = 0; a < dim; ++a) {
            double row_sum = 0.0;
            for (int b = 0; b < dim; ++b) {
                row_sum += p(static_cast<std::size_t>(a),
                             static_cast<std::size_t>(b)) *
                           h[static_cast<std::size_t>(b)];
            }
            s += h[static_cast<std::size_t>(a)] * row_sum;
        }
        const double sigma = obs.sigmas[static_cast<std::size_t>(i)];
        s += sigma * sigma;
        const double nis_i = (nu * nu) / s;
        out.nis[static_cast<std::size_t>(i)] = nis_i;
        if (nis_i > threshold) {
            continue;  // Gated: mask stays false, NIS/innovation recorded.
        }

        // K = P h^T / S; x += K nu.
        Vec9d k;
        for (int a = 0; a < dim; ++a) {
            double row_sum = 0.0;
            for (int b = 0; b < dim; ++b) {
                row_sum += p(static_cast<std::size_t>(a),
                             static_cast<std::size_t>(b)) *
                           h[static_cast<std::size_t>(b)];
            }
            k[static_cast<std::size_t>(a)] = row_sum / s;
        }
        for (int a = 0; a < dim; ++a) {
            x[static_cast<std::size_t>(a)] +=
                k[static_cast<std::size_t>(a)] * nu;
        }

        // Joseph: P = (I - K h^T) P (I - K h^T)^T + K sigma^2 K^T.
        Mat9d mikh;  // I - K h^T over the active block.
        for (int a = 0; a < dim; ++a) {
            for (int b = 0; b < dim; ++b) {
                const double kh = k[static_cast<std::size_t>(a)] *
                                  h[static_cast<std::size_t>(b)];
                mikh(static_cast<std::size_t>(a), static_cast<std::size_t>(b)) =
                    (a == b) ? 1.0 - kh : -kh;
            }
        }
        // M P M^T (only the active block is meaningful; the remainder
        // of the 9x9 storage is carried but never read below dim).
        Mat9d m_p;
        for (int a = 0; a < dim; ++a) {
            for (int b = 0; b < dim; ++b) {
                double sum = 0.0;
                for (int c = 0; c < dim; ++c) {
                    sum += mikh(static_cast<std::size_t>(a),
                                static_cast<std::size_t>(c)) *
                           p(static_cast<std::size_t>(c),
                             static_cast<std::size_t>(b));
                }
                m_p(static_cast<std::size_t>(a), static_cast<std::size_t>(b)) =
                    sum;
            }
        }
        Mat9d p_new = p;
        for (int a = 0; a < dim; ++a) {
            for (int b = 0; b < dim; ++b) {
                double sum = 0.0;
                for (int c = 0; c < dim; ++c) {
                    sum += m_p(static_cast<std::size_t>(a),
                               static_cast<std::size_t>(c)) *
                           mikh(static_cast<std::size_t>(b),
                                static_cast<std::size_t>(c));  // M P M^T.
                }
                sum += sigma * sigma * k[static_cast<std::size_t>(a)] *
                       k[static_cast<std::size_t>(b)];
                p_new(static_cast<std::size_t>(a), static_cast<std::size_t>(b)) =
                    sum;
            }
        }
        for (int a = 0; a < dim; ++a) {
            for (int b = 0; b < dim; ++b) {
                p(static_cast<std::size_t>(a), static_cast<std::size_t>(b)) =
                    p_new(static_cast<std::size_t>(a),
                          static_cast<std::size_t>(b));
            }
        }
        symmetrize_active(p, dim);
        out.updated[static_cast<std::size_t>(i)] = true;
    }
    out.exceeded = out.nis[0] > threshold ||
                   (obs.ndim > 1 && out.nis[1] > threshold);
    return out;
}

}  // namespace ekf_detail

// ============================================================================
// ekf_solve: main entry
// ============================================================================

/// Estimate an ECI trajectory with a sequential extended Kalman filter.
///
/// The filter starts from state0 at epoch_jd with diagonal covariance
/// diag(config.p0_diag) and walks the observation sequence in time
/// order. Before each observation the state and covariance are
/// propagated to the observation epoch (42-dim variational propagator,
/// 9x9 augmented form while in augmented mode); scheduled burns inside
/// the interval are applied mid-predict. At each observation every
/// scalar component is assimilated with gated sequential scalar updates
/// (Joseph form). A streak of consecutive NIS-exceedance observation
/// epochs flags a maneuver at that epoch and, when estimate_maneuver
/// is true, switches the filter to the 9D augmented state [r, v, dv]
/// until reentry_window_obs epochs later (or the end of the arc), when
/// the dv estimate is stored and the filter contracts back to 6D. A
/// longer sustained NIS streak triggers divergence recovery (whole-
/// matrix inflation plus position/velocity floors).
///
/// Observations must be time-sorted ascending (equal epochs allowed;
/// they share a predict). RANGE, RANGE_RATE, and RA_DEC are supported;
/// station ECI geometry is pre-resolved into each BatchObs.
///
/// @param observations  Time-sorted observations with pre-resolved
///                      station ECI geometry.
/// @param state0        Initial ECI state at epoch_jd (length 6).
/// @param epoch_jd      Initial filter epoch [days].
/// @param config        Filter configuration (defaults: J2 tier, 6D,
///                      no scheduled burns).
/// @param burns         Known scheduled burns, ascending by epoch (a
///                      burn at or before epoch_jd is silently skipped;
///                      fold it into state0 instead).
/// @return EKFResult; error == OK unless propagation fails or a
///         non-finite state is detected (histories are still populated
///         up to the failing step).
inline EKFResult ekf_solve(const std::vector<BatchObs>& observations,
                           const double* state0, double epoch_jd,
                           const EKFConfig& config,
                           const std::vector<ScheduledBurn>& burns = {}) {
    EKFResult result;

    // ---- Input validation (helio ekf_solve ValueErrors) ----
    if (observations.empty()) {
        result.error = EKFError::ERROR_INPUT;
        return result;
    }
    {
        double prev_jd = 0.0;
        bool have_prev = false;
        for (const BatchObs& o : observations) {
            if (o.obs_type == ObsType::AZ_EL) {
                result.error = EKFError::ERROR_INPUT;
                return result;
            }
            const int nd = obs_ndim(o.obs_type);
            if (o.ndim != nd) {
                result.error = EKFError::ERROR_INPUT;
                return result;
            }
            for (int k = 0; k < nd; ++k) {
                if (!(o.sigmas[static_cast<std::size_t>(k)] > 0.0)) {
                    result.error = EKFError::ERROR_INPUT;
                    return result;
                }
            }
            if (have_prev && o.time_jd < prev_jd) {
                result.error = EKFError::ERROR_INPUT;
                return result;
            }
            prev_jd = o.time_jd;
            have_prev = true;
        }
    }
    for (int i = 0; i < 6; ++i) {
        if (!std::isfinite(state0[static_cast<std::size_t>(i)])) {
            result.error = EKFError::ERROR_INPUT;
            return result;
        }
    }
    if (config.estimate_cd) {
        // Phase 4 is 6D-only; the 7D drag estimator is a Phase 5
        // fast-follow (helio estimate_cd branch not ported yet).
        result.error = EKFError::ERROR_INPUT;
        return result;
    }
    if (config.force_tier != 0 && config.force_tier != 1) {
        result.error = EKFError::ERROR_INPUT;
        return result;
    }
    for (std::size_t i = 0; i < 6; ++i) {
        if (!(config.p0_diag[i] > 0.0)) {
            result.error = EKFError::ERROR_INPUT;
            return result;
        }
    }
    if (config.process.q_a < 0.0 || config.process.q_a_maneuver < 0.0) {
        result.error = EKFError::ERROR_INPUT;
        return result;
    }
    if (config.maneuver.nis_sigma_threshold <= 0.0) {
        result.error = EKFError::ERROR_INPUT;
        return result;
    }
    if (config.maneuver.consecutive_exceedances < 1 ||
        config.maneuver.reentry_window_obs < 1 ||
        config.recovery.sustained_nis_count < 1) {
        result.error = EKFError::ERROR_INPUT;
        return result;
    }
    if (config.recovery.inflate_factor <= 1.0) {
        result.error = EKFError::ERROR_INPUT;
        return result;
    }
    for (std::size_t i = 1; i < burns.size(); ++i) {
        if (burns[i].epoch_jd < burns[i - 1].epoch_jd) {
            result.error = EKFError::ERROR_INPUT;
            return result;
        }
    }

    const double threshold =
        config.maneuver.nis_sigma_threshold *
        config.maneuver.nis_sigma_threshold;
    const double q_a = config.process.q_a;
    const double q_a_maneuver = config.process.q_a_maneuver;
    const int force_tier = config.force_tier;

    // ---- Histories ----
    const std::size_t n_obs = observations.size();
    std::size_t n_rows = 0;
    for (const BatchObs& o : observations) {
        n_rows += static_cast<std::size_t>(o.ndim);
    }
    result.n_obs = static_cast<int>(n_obs);
    result.n_rows = static_cast<int>(n_rows);
    result.obs_times.resize(n_obs);
    result.obs_types.resize(n_obs);
    result.maneuver_flag.assign(n_obs, false);
    result.state_hist.assign(n_obs * 6,
                             std::numeric_limits<double>::quiet_NaN());
    result.sigma_hist.assign(n_obs * 6,
                             std::numeric_limits<double>::quiet_NaN());
    result.innovations.assign(n_obs * 2,
                              std::numeric_limits<double>::quiet_NaN());
    result.nis.assign(n_obs * 2, std::numeric_limits<double>::quiet_NaN());
    result.updated_mask.assign(n_obs * 2, false);

    // ---- Filter state (9-slot storage; dim = 6 or 9) ----
    Vec9d x;
    Mat9d p;
    int dim = 6;
    for (int i = 0; i < 6; ++i) {
        x[static_cast<std::size_t>(i)] = state0[static_cast<std::size_t>(i)];
        p(static_cast<std::size_t>(i), static_cast<std::size_t>(i)) =
            config.p0_diag[static_cast<std::size_t>(i)];
    }

    bool augmented = false;
    double detection_jd = std::numeric_limits<double>::quiet_NaN();
    int n_augmented_obs = 0;
    int consec_exceed = 0;
    int consec_high = 0;
    std::vector<bool> burn_used(burns.size(), false);
    double t_prev = epoch_jd;
    double nis_acc = 0.0;
    int nis_count = 0;

    bool epoch_exceeded = false;
    for (std::size_t k = 0; k < n_obs; ++k) {
        const BatchObs& obs = observations[k];
        result.obs_times[k] = obs.time_jd;
        result.obs_types[k] = static_cast<int>(obs.obs_type);
        if (k == 0 || obs.time_jd != observations[k - 1].time_jd) {
            epoch_exceeded = false;
        }
        const double q_active = augmented ? q_a_maneuver : q_a;

        // Scheduled burns inside (t_prev, obs.time_jd]: propagate to the
        // burn epoch, add dv to the velocity, inflate the velocity
        // covariance, then continue with the remaining interval.
        bool burn_applied = false;
        for (std::size_t bi = 0; bi < burns.size(); ++bi) {
            if (burn_used[bi]) {
                continue;
            }
            const ScheduledBurn& burn = burns[bi];
            if (!(t_prev < burn.epoch_jd && burn.epoch_jd <= obs.time_jd)) {
                continue;
            }
            burn_used[bi] = true;
            const double dt_burn = (burn.epoch_jd - t_prev) * SEC_PER_DAY;
            if (!ekf_detail::predict_segment(x, p, dim, dt_burn, q_active,
                                             force_tier)) {
                result.error = EKFError::ERROR_INTEGRATION;
                return result;
            }
            for (std::size_t i = 0; i < 3; ++i) {
                x[3 + i] += burn.dv[i];
            }
            const double inflate =
                config.maneuver.scheduled_inflate_kms *
                config.maneuver.scheduled_inflate_kms;
            for (std::size_t i = 3; i < 6; ++i) {
                p(i, i) += inflate;
            }
            ekf_detail::symmetrize_active(p, dim);
            t_prev = burn.epoch_jd;
            burn_applied = true;
        }

        const double dt = (obs.time_jd - t_prev) * SEC_PER_DAY;
        if (!ekf_detail::predict_segment(x, p, dim, dt, q_active,
                                         force_tier)) {
            result.error = EKFError::ERROR_INTEGRATION;
            return result;
        }
        t_prev = obs.time_jd;
        if (!ekf_detail::state_finite(x, p, dim)) {
            // C++-only guard (documented divergence from Helio, which
            // lets NaNs propagate silently).
            result.error = EKFError::ERROR_DIVERGENCE;
            return result;
        }

        // dv-to-state coupling at this observation epoch while
        // augmented; null in the 6D mode.
        std::array<double, 18> psi_a{};
        const double* psi_ptr = nullptr;
        if (augmented) {
            psi_a = ekf_detail::psi_matrix((obs.time_jd - detection_jd) *
                                           SEC_PER_DAY);
            psi_ptr = psi_a.data();
        }
        const ekf_detail::UpdateOutcome upd = ekf_detail::sequential_update(
            obs, x, p, dim, threshold, psi_ptr);
        if (!upd.ok) {
            result.error = EKFError::ERROR_INTEGRATION;
            return result;
        }
        if (!ekf_detail::state_finite(x, p, dim)) {
            // C++-only guard (documented divergence from Helio, which
            // lets NaNs propagate silently): a non-finite update would
            // otherwise poison the next predict and the stored history.
            result.error = EKFError::ERROR_DIVERGENCE;
            return result;
        }
        const std::size_t nd = static_cast<std::size_t>(obs.ndim);
        for (std::size_t i = 0; i < nd; ++i) {
            result.innovations[2 * k + i] = upd.innovations[i];
            result.nis[2 * k + i] = upd.nis[i];
            result.updated_mask[2 * k + i] = upd.updated[i];
            if (upd.updated[i]) {
                ++result.n_updated;
            } else {
                ++result.n_gated;
            }
            nis_acc += upd.nis[i];
            ++nis_count;
            if (upd.nis[i] > result.nis_max) {
                result.nis_max = upd.nis[i];
            }
            if (upd.nis[i] > threshold) {
                ++result.n_nis_exceed;
            }
        }

        // Store the physical (r, v) state (nominal + dv offset while
        // augmented) and the matching sigmas from the congruence-
        // transformed covariance, so state_hist tracks the estimated
        // trajectory.
        if (psi_ptr != nullptr) {
            Vec9d x_stored;
            for (std::size_t i = 0; i < 6; ++i) {
                double sum = x[i];
                for (std::size_t m = 0; m < 3; ++m) {
                    sum += psi_a[i * 3 + m] * x[6 + m];
                }
                x_stored[i] = sum;
            }
            // sig = sqrt(max(diag(J P J^T), 0)), J = [[I, psi_a], [0, I]].
            for (std::size_t i = 0; i < 6; ++i) {
                double diag = p(i, i);
                for (std::size_t m = 0; m < 3; ++m) {
                    diag += 2.0 * psi_a[i * 3 + m] * p(i, 6 + m);
                    for (std::size_t n = 0; n < 3; ++n) {
                        diag += psi_a[i * 3 + m] * p(6 + m, 6 + n) *
                                psi_a[i * 3 + n];
                    }
                }
                result.state_hist[k * 6 + i] = x_stored[i];
                result.sigma_hist[k * 6 + i] =
                    diag > 0.0 ? std::sqrt(diag) : 0.0;
            }
        } else {
            for (std::size_t i = 0; i < 6; ++i) {
                result.state_hist[k * 6 + i] = x[i];
                const double d = p(i, i);
                result.sigma_hist[k * 6 + i] = d > 0.0 ? std::sqrt(d) : 0.0;
            }
        }
        if (burn_applied) {
            result.maneuver_flag[k] = true;
        }
        epoch_exceeded = epoch_exceeded || upd.exceeded;

        // Per-epoch bookkeeping (detection, re-entry, divergence) runs
        // once after the last observation sharing this epoch, so a
        // streak counts consecutive observation EPOCHS with any NIS
        // exceedance rather than consecutive station/type observations.
        const bool last_of_epoch =
            (k + 1 == n_obs) ||
            (observations[k + 1].time_jd != obs.time_jd);
        if (!last_of_epoch) {
            continue;
        }

        // Maneuver detection: a streak of NIS-exceedance observation
        // epochs flags the maneuver at the current epoch; with
        // estimation enabled this also enters 9D augmented mode.
        consec_exceed = epoch_exceeded ? consec_exceed + 1 : 0;
        if (config.maneuver.estimate_maneuver && !augmented &&
            consec_exceed >= config.maneuver.consecutive_exceedances) {
            result.maneuver_flag[k] = true;
            ekf_detail::enter_augmented_mode(x, p, dim);
            augmented = true;
            detection_jd = obs.time_jd;
            n_augmented_obs = 0;
            consec_exceed = 0;
        } else if (!config.maneuver.estimate_maneuver &&
                   consec_exceed >= config.maneuver.consecutive_exceedances) {
            result.maneuver_flag[k] = true;
            consec_exceed = 0;
        }

        if (augmented) {
            ++n_augmented_obs;
            if (n_augmented_obs >= config.maneuver.reentry_window_obs) {
                const std::array<double, 18> psi_end =
                    ekf_detail::psi_matrix((obs.time_jd - detection_jd) *
                                           SEC_PER_DAY);
                ekf_detail::contract_to_6d(x, p, dim, psi_end, detection_jd,
                                           result.maneuver_records);
                augmented = false;
            }
        }

        // Divergence check: sustained NIS exceedances (with or without
        // maneuver estimation) trigger recovery. The WHOLE covariance
        // is scaled by inflate_factor (preserving symmetry, positive
        // definiteness, and correlations) and detection-implied floors
        // open the position and velocity blocks: a sustained NIS streak
        // is evidence of a model error of at least the class the gate
        // can see, and a converged (collapsed) P would otherwise stay
        // gated no matter how large the multiplicative factor.
        consec_high = epoch_exceeded ? consec_high + 1 : 0;
        if (consec_high >= config.recovery.sustained_nis_count) {
            for (int i = 0; i < dim; ++i) {
                for (int j = 0; j < dim; ++j) {
                    p(static_cast<std::size_t>(i),
                      static_cast<std::size_t>(j)) *=
                        config.recovery.inflate_factor;
                }
            }
            const double pos_floor =
                EKF_RECOVERY_POS_FLOOR_KM * EKF_RECOVERY_POS_FLOOR_KM;
            const double vel_floor =
                EKF_RECOVERY_VEL_FLOOR_KMS * EKF_RECOVERY_VEL_FLOOR_KMS;
            for (std::size_t i = 0; i < 3; ++i) {
                p(i, i) += pos_floor;
            }
            const int dim6 = dim < 6 ? dim : 6;
            for (int i = 3; i < dim6; ++i) {
                p(static_cast<std::size_t>(i),
                  static_cast<std::size_t>(i)) += vel_floor;
            }
            ekf_detail::symmetrize_active(p, dim);
            ++result.n_recoveries;
            result.divergence_flag = true;
            consec_high = 0;
            consec_exceed = 0;
        }
    }

    result.augmented_active_final = augmented;
    if (augmented) {
        // Forced end-of-arc contraction: store the dv estimate and fold
        // it into the 6D state (final covariance is always 6x6).
        const std::array<double, 18> psi_end =
            ekf_detail::psi_matrix((t_prev - detection_jd) * SEC_PER_DAY);
        ekf_detail::contract_to_6d(x, p, dim, psi_end, detection_jd,
                                   result.maneuver_records);
        augmented = false;
    }

    if (nis_count > 0) {
        result.nis_mean = nis_acc / static_cast<double>(nis_count);
    }
    for (int i = 0; i < 6; ++i) {
        result.final_state[static_cast<std::size_t>(i)] =
            x[static_cast<std::size_t>(i)];
        result.final_cov_diag[static_cast<std::size_t>(i)] =
            p(static_cast<std::size_t>(i), static_cast<std::size_t>(i));
        for (int j = 0; j < 6; ++j) {
            result.final_cov[static_cast<std::size_t>(i * 6 + j)] =
                p(static_cast<std::size_t>(i), static_cast<std::size_t>(j));
        }
    }
    return result;
}

}  // namespace orbit
