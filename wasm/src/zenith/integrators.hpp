#pragma once

/// @file integrators.hpp
/// @brief Numerical ODE integrators for orbit propagation.
///        Provides classical RK4 (fixed step) and Dormand-Prince RK45
///        (adaptive step) integrators for numerical orbit propagation
///        with configurable force models, plus a generic n-dim ODE core
///        (RK4 fixed step, DOP853 adaptive) used by the orbit-
///        determination variational (STM) propagators.
///
///        DOP853 coefficients follow Hairer, Norsett & Wanner "Solving
///        ODEs I", Sec. II.2 (Table 5.2), cross-checked against scipy's
///        scipy/integrate/_ivp/dop853_coefficients.py.

#include <algorithm>
#include <cmath>
#include <functional>
#include <stdexcept>
#include <vector>

#include "orbit_types.hpp"
#include "force_models.hpp"
#include "matrix_ops.hpp"

namespace orbit {

// ============================================================================
// Integration State
// ============================================================================

/// State vector for numerical integration.
/// Contains position, velocity, and elapsed time from the initial epoch.
struct IntegrationState {
    Vec3 position;      ///< Position vector [km].
    Vec3 velocity;      ///< Velocity vector [km/s].
    double time = 0.0;  ///< Elapsed time from initial epoch [s].
};

// ============================================================================
// Derivative Function Type
// ============================================================================

/// Function pointer type for computing state derivatives.
/// @param state   Current integration state.
/// @param deriv   Output: derivative of state (dr/dt, dv/dt, dt/dt).
/// @param jd      Current Julian Date.
/// @param params  Propagation parameters (force model flags, etc.).
using DerivativeFunc = void (*)(const IntegrationState& state,
                                IntegrationState& deriv,
                                double jd,
                                const PropagatorParams& params);

// ============================================================================
// Default Orbital Derivatives
// ============================================================================

/// Compute derivatives for orbital motion under central gravity plus
/// perturbations.
///
/// The equations of motion are:
///   d(position)/dt = velocity
///   d(velocity)/dt = a_total (from force_models.hpp)
///   d(time)/dt      = 1
///
/// @param state   Current integration state.
/// @param deriv   Output derivative state.
/// @param jd      Current Julian Date.
/// @param params  Propagation parameters controlling active force models.
inline void orbital_derivatives(const IntegrationState& state,
                                IntegrationState& deriv,
                                double jd,
                                const PropagatorParams& params) {
    deriv.position = state.velocity;
    deriv.velocity = compute_total_acceleration(state.position, state.velocity,
                                                jd, params);
    deriv.time = 1.0;
}

// ============================================================================
// RK4 Integrator (Fixed Step)
// ============================================================================

/// Classical 4th-order Runge-Kutta integrator with fixed step size.
///
/// Uses the standard RK4 coefficients:
///   k1 = f(t, y)
///   k2 = f(t + h/2, y + h/2 * k1)
///   k3 = f(t + h/2, y + h/2 * k2)
///   k4 = f(t + h,   y + h   * k3)
///   y_new = y + h/6 * (k1 + 2*k2 + 2*k3 + k4)
///
/// @param initial_state  Starting state (position, velocity, time=0).
/// @param jd_start       Julian Date at the initial epoch.
/// @param dt_step        Fixed step size [s].
/// @param num_steps      Number of integration steps.
/// @param params         Propagation parameters.
/// @return Vector of states at each step, including the initial state.
inline std::vector<IntegrationState> rk4_integrate(
    const IntegrationState& initial_state,
    double jd_start,
    double dt_step,
    int num_steps,
    const PropagatorParams& params) {

    std::vector<IntegrationState> trajectory;
    trajectory.reserve(num_steps + 1);
    trajectory.push_back(initial_state);

    IntegrationState current = initial_state;
    double jd = jd_start;
    double h = dt_step;

    for (int step = 0; step < num_steps; ++step) {
        IntegrationState k1, k2, k3, k4;
        IntegrationState temp;

        // Stage 1: derivative at current state.
        orbital_derivatives(current, k1, jd, params);

        // Stage 2: derivative at midpoint using k1.
        temp.position = current.position + k1.position * (h * 0.5);
        temp.velocity = current.velocity + k1.velocity * (h * 0.5);
        temp.time = current.time + h * 0.5;
        orbital_derivatives(temp, k2, jd + h * 0.5 / 86400.0, params);

        // Stage 3: derivative at midpoint using k2.
        temp.position = current.position + k2.position * (h * 0.5);
        temp.velocity = current.velocity + k2.velocity * (h * 0.5);
        temp.time = current.time + h * 0.5;
        orbital_derivatives(temp, k3, jd + h * 0.5 / 86400.0, params);

        // Stage 4: derivative at endpoint using k3.
        temp.position = current.position + k3.position * h;
        temp.velocity = current.velocity + k3.velocity * h;
        temp.time = current.time + h;
        orbital_derivatives(temp, k4, jd + h / 86400.0, params);

        // Update state using weighted average of derivatives.
        current.position = current.position +
            (k1.position + 2.0 * k2.position +
             2.0 * k3.position + k4.position) * (h / 6.0);
        current.velocity = current.velocity +
            (k1.velocity + 2.0 * k2.velocity +
             2.0 * k3.velocity + k4.velocity) * (h / 6.0);
        current.time += h;
        jd = jd_start + current.time / 86400.0;

        trajectory.push_back(current);
    }

    return trajectory;
}

// ============================================================================
// RK45 Integrator (Dormand-Prince, Adaptive Step)
// ============================================================================

/// Dormand-Prince 5(4) adaptive step integrator.
///
/// Uses the Dormand-Prince embedded Runge-Kutta pair for adaptive step
/// size control.  The 5th-order solution is used for advancing the state,
/// and the difference between 5th and 4th order solutions provides the
/// local error estimate for step size control.
///
/// Dormand-Prince tableau (non-zero entries):
///   a21 = 1/5
///   a31 = 3/40,      a32 = 9/40
///   a41 = 44/45,     a42 = -56/15,    a43 = 32/9
///   a51 = 19372/6561, a52 = -25360/2187, a53 = 64448/6561, a54 = -212/729
///   a61 = 9017/3168, a62 = -355/33,   a63 = 46732/5247, a64 = 49/176,
///         a65 = -5103/18656
///
/// 5th-order weights: b1 = 35/384, b3 = 500/1113, b4 = 125/192,
///   b5 = -2187/6784, b6 = 11/84
///
/// Error coefficients (5th minus 4th order):
///   e1 = 71/57600, e3 = -71/16695, e4 = 71/1920,
///   e5 = -17253/339200, e6 = 22/525, e7 = -1/40
///
/// @param initial_state    Starting state (position, velocity, time=0).
/// @param jd_start         Julian Date at the initial epoch.
/// @param dt_step_initial  Initial step size [s].
/// @param end_time         Propagation end time [s] from initial epoch.
/// @param params           Propagation parameters.
/// @param rtol             Relative tolerance for step size control.
/// @param atol             Absolute tolerance for step size control.
/// @return Vector of states at each accepted step, including the initial state.
inline std::vector<IntegrationState> rk45_integrate(
    const IntegrationState& initial_state,
    double jd_start,
    double dt_step_initial,
    double end_time,
    const PropagatorParams& params,
    double rtol = 1e-10,
    double atol = 1e-12) {

    const double dt_min = 0.01;    // Minimum step size [s].
    const double dt_max = 3600.0;  // Maximum step size [s].
    const double safety = 0.9;     // Safety factor for step size growth.

    std::vector<IntegrationState> trajectory;
    trajectory.push_back(initial_state);

    IntegrationState current = initial_state;
    double jd = jd_start;
    double dt = dt_step_initial;

    while (current.time < end_time) {
        // Clamp step to not overshoot end time.
        if (current.time + dt > end_time) {
            dt = end_time - current.time;
        }
        if (dt < dt_min) {
            dt = dt_min;
        }

        double h = dt;

        IntegrationState k1, k2, k3, k4, k5, k6, k7;
        IntegrationState temp;

        // Stage 1: k1 = f(t, y)
        orbital_derivatives(current, k1, jd, params);

        // Stage 2: k2 = f(t + h/5, y + h * a21 * k1)
        temp.position = current.position + k1.position * (h / 5.0);
        temp.velocity = current.velocity + k1.velocity * (h / 5.0);
        temp.time = current.time + h / 5.0;
        orbital_derivatives(temp, k2, jd + h / 5.0 / 86400.0, params);

        // Stage 3: k3 = f(t + 3h/10, y + h * (a31*k1 + a32*k2))
        temp.position = current.position +
            k1.position * (h * 3.0 / 40.0) +
            k2.position * (h * 9.0 / 40.0);
        temp.velocity = current.velocity +
            k1.velocity * (h * 3.0 / 40.0) +
            k2.velocity * (h * 9.0 / 40.0);
        temp.time = current.time + h * 3.0 / 10.0;
        orbital_derivatives(temp, k3, jd + h * 3.0 / 10.0 / 86400.0, params);

        // Stage 4: k4 = f(t + 4h/5, y + h * (a41*k1 + a42*k2 + a43*k3))
        temp.position = current.position +
            k1.position * (h * 44.0 / 45.0) +
            k2.position * (h * -56.0 / 15.0) +
            k3.position * (h * 32.0 / 9.0);
        temp.velocity = current.velocity +
            k1.velocity * (h * 44.0 / 45.0) +
            k2.velocity * (h * -56.0 / 15.0) +
            k3.velocity * (h * 32.0 / 9.0);
        temp.time = current.time + h * 4.0 / 5.0;
        orbital_derivatives(temp, k4, jd + h * 4.0 / 5.0 / 86400.0, params);

        // Stage 5: k5 = f(t + 8h/9, y + h * (a51*k1 + ... + a54*k4))
        temp.position = current.position +
            k1.position * (h * 19372.0 / 6561.0) +
            k2.position * (h * -25360.0 / 2187.0) +
            k3.position * (h * 64448.0 / 6561.0) +
            k4.position * (h * -212.0 / 729.0);
        temp.velocity = current.velocity +
            k1.velocity * (h * 19372.0 / 6561.0) +
            k2.velocity * (h * -25360.0 / 2187.0) +
            k3.velocity * (h * 64448.0 / 6561.0) +
            k4.velocity * (h * -212.0 / 729.0);
        temp.time = current.time + h * 8.0 / 9.0;
        orbital_derivatives(temp, k5, jd + h * 8.0 / 9.0 / 86400.0, params);

        // Stage 6: k6 = f(t + h, y + h * (a61*k1 + ... + a65*k5))
        temp.position = current.position +
            k1.position * (h * 9017.0 / 3168.0) +
            k2.position * (h * -355.0 / 33.0) +
            k3.position * (h * 46732.0 / 5247.0) +
            k4.position * (h * 49.0 / 176.0) +
            k5.position * (h * -5103.0 / 18656.0);
        temp.velocity = current.velocity +
            k1.velocity * (h * 9017.0 / 3168.0) +
            k2.velocity * (h * -355.0 / 33.0) +
            k3.velocity * (h * 46732.0 / 5247.0) +
            k4.velocity * (h * 49.0 / 176.0) +
            k5.velocity * (h * -5103.0 / 18656.0);
        temp.time = current.time + h;
        orbital_derivatives(temp, k6, jd + h / 86400.0, params);

        // 5th-order solution for advancing the state.
        // y_new = y + h * (b1*k1 + b3*k3 + b4*k4 + b5*k5 + b6*k6)
        IntegrationState next;
        next.position = current.position +
            k1.position * (h * 35.0 / 384.0) +
            k3.position * (h * 500.0 / 1113.0) +
            k4.position * (h * 125.0 / 192.0) +
            k5.position * (h * -2187.0 / 6784.0) +
            k6.position * (h * 11.0 / 84.0);
        next.velocity = current.velocity +
            k1.velocity * (h * 35.0 / 384.0) +
            k3.velocity * (h * 500.0 / 1113.0) +
            k4.velocity * (h * 125.0 / 192.0) +
            k5.velocity * (h * -2187.0 / 6784.0) +
            k6.velocity * (h * 11.0 / 84.0);
        next.time = current.time + h;

        // Stage 7: k7 = f(t + h, y_new)  [FSAL point]
        orbital_derivatives(next, k7, jd + h / 86400.0, params);

        // Error estimate: difference between 5th and 4th order solutions.
        // err = h * (e1*k1 + e3*k3 + e4*k4 + e5*k5 + e6*k6 + e7*k7)
        Vec3 err_pos;
        err_pos.x = h * (71.0 / 57600.0 * k1.position.x
                        + (-71.0 / 16695.0) * k3.position.x
                        + 71.0 / 1920.0 * k4.position.x
                        + (-17253.0 / 339200.0) * k5.position.x
                        + 22.0 / 525.0 * k6.position.x
                        + (-1.0 / 40.0) * k7.position.x);
        err_pos.y = h * (71.0 / 57600.0 * k1.position.y
                        + (-71.0 / 16695.0) * k3.position.y
                        + 71.0 / 1920.0 * k4.position.y
                        + (-17253.0 / 339200.0) * k5.position.y
                        + 22.0 / 525.0 * k6.position.y
                        + (-1.0 / 40.0) * k7.position.y);
        err_pos.z = h * (71.0 / 57600.0 * k1.position.z
                        + (-71.0 / 16695.0) * k3.position.z
                        + 71.0 / 1920.0 * k4.position.z
                        + (-17253.0 / 339200.0) * k5.position.z
                        + 22.0 / 525.0 * k6.position.z
                        + (-1.0 / 40.0) * k7.position.z);

        Vec3 err_vel;
        err_vel.x = h * (71.0 / 57600.0 * k1.velocity.x
                        + (-71.0 / 16695.0) * k3.velocity.x
                        + 71.0 / 1920.0 * k4.velocity.x
                        + (-17253.0 / 339200.0) * k5.velocity.x
                        + 22.0 / 525.0 * k6.velocity.x
                        + (-1.0 / 40.0) * k7.velocity.x);
        err_vel.y = h * (71.0 / 57600.0 * k1.velocity.y
                        + (-71.0 / 16695.0) * k3.velocity.y
                        + 71.0 / 1920.0 * k4.velocity.y
                        + (-17253.0 / 339200.0) * k5.velocity.y
                        + 22.0 / 525.0 * k6.velocity.y
                        + (-1.0 / 40.0) * k7.velocity.y);
        err_vel.z = h * (71.0 / 57600.0 * k1.velocity.z
                        + (-71.0 / 16695.0) * k3.velocity.z
                        + 71.0 / 1920.0 * k4.velocity.z
                        + (-17253.0 / 339200.0) * k5.velocity.z
                        + 22.0 / 525.0 * k6.velocity.z
                        + (-1.0 / 40.0) * k7.velocity.z);

        // RMS normalized error across all 6 state components.
        double scale_px = rtol * std::abs(current.position.x) + atol;
        double scale_py = rtol * std::abs(current.position.y) + atol;
        double scale_pz = rtol * std::abs(current.position.z) + atol;
        double scale_vx = rtol * std::abs(current.velocity.x) + atol;
        double scale_vy = rtol * std::abs(current.velocity.y) + atol;
        double scale_vz = rtol * std::abs(current.velocity.z) + atol;

        double err_sum = 0.0;
        err_sum += (err_pos.x / scale_px) * (err_pos.x / scale_px);
        err_sum += (err_pos.y / scale_py) * (err_pos.y / scale_py);
        err_sum += (err_pos.z / scale_pz) * (err_pos.z / scale_pz);
        err_sum += (err_vel.x / scale_vx) * (err_vel.x / scale_vx);
        err_sum += (err_vel.y / scale_vy) * (err_vel.y / scale_vy);
        err_sum += (err_vel.z / scale_vz) * (err_vel.z / scale_vz);

        double err = std::sqrt(err_sum / 6.0);

        // Step rejected: error too large, halve step and retry.
        if (err > 1.0) {
            dt *= 0.5;
            if (dt < dt_min) {
                dt = dt_min;
            }
            continue;
        }

        // Step accepted: advance state.
        current = next;
        jd = jd_start + current.time / 86400.0;
        trajectory.push_back(current);

        // Adjust step size for the next step.
        if (err < 0.1) {
            // Error very small, double the step size.
            dt *= 2.0;
        } else {
            // Compute optimal step size using safety factor.
            // The 1/5 power comes from the 5th-order method.
            double new_dt = dt * safety * std::pow(1.0 / err, 1.0 / 5.0);
            dt = std::min(new_dt, 2.0 * dt);
        }

        // Clamp to allowed range.
        dt = std::max(dt, dt_min);
        dt = std::min(dt, dt_max);
    }

    return trajectory;
}

// ============================================================================
// High-Level Orbit Propagation Wrapper
// ============================================================================

/// High-level wrapper that selects the integrator and converts between
/// the public StateVector type and the internal IntegrationState type.
///
/// @param initial_state   Starting state vector (position, velocity, epoch).
/// @param integrator      Propagation algorithm to use (NumericalRK4 or
///                        NumericalRK45).
/// @param dt_step         Step size [s] (fixed for RK4, initial for RK45).
/// @param end_time_days   Propagation duration [days].
/// @param params          Propagation parameters (force model flags, etc.).
/// @return Vector of StateVectors at each integration step.  Returns empty
///         vector if the integrator type is not a numerical method.
inline std::vector<StateVector> propagate_orbit(
    const StateVector& initial_state,
    PropagatorType integrator,
    double dt_step,
    double end_time_days,
    const PropagatorParams& params) {

    // Convert StateVector to IntegrationState.
    IntegrationState init;
    init.position = initial_state.position;
    init.velocity = initial_state.velocity;
    init.time = 0.0;
    double jd_start = initial_state.epoch;

    std::vector<IntegrationState> states;

    if (integrator == PropagatorType::NumericalRK4) {
        double end_time_s = end_time_days * 86400.0;
        int num_steps = static_cast<int>(std::ceil(end_time_s / dt_step));
        states = rk4_integrate(init, jd_start, dt_step, num_steps, params);
    } else if (integrator == PropagatorType::NumericalRK45) {
        double end_time_s = end_time_days * 86400.0;
        states = rk45_integrate(init, jd_start, dt_step, end_time_s, params);
    } else {
        // Non-numerical integrator (Kepler, SGP4); caller should use
        // the dedicated propagators instead.
        return {};
    }

    // Convert IntegrationState results back to StateVector.
    std::vector<StateVector> result;
    result.reserve(states.size());
    for (const auto& s : states) {
        result.emplace_back(s.position, s.velocity,
                           jd_start + s.time / 86400.0);
    }

    return result;
}

// ============================================================================
// Generic n-Dimensional ODE Core
// ============================================================================

/// Generic RHS callback: dy/dt = f(t, y, user).
///
/// State lives in plain double arrays of length n; `user` carries caller
/// context (epochs, force tier, parameters) so the core stays allocation
/// free in the hot path.
using OdeFunc = std::function<void(double t, const double* y, double* dydt,
                                   void* user)>;

/// Classical RK4 fixed-step integration of an n-dim ODE.
///
/// Helio rk4_fixed_step parity.  y_out receives (n_steps + 1) states of
/// length n each, including y0 at index 0: y_out[k] is the state at
/// t0 + k * dt.
///
/// @param f       RHS callback.
/// @param user    Opaque caller context passed to f.
/// @param n       State dimension.
/// @param y0      Initial state (length n, not modified).
/// @param t0      Initial time [s].
/// @param dt      Fixed step size [s].
/// @param n_steps Number of steps to take.
/// @param y_out   Output buffer, size (n_steps + 1) * n.
inline void rk4_fixed_step(const OdeFunc& f, void* user, std::size_t n,
                           const double* y0, double t0, double dt, int n_steps,
                           double* y_out) {
    std::vector<double> y(y0, y0 + n);
    std::vector<double> y_next(n);
    std::vector<double> k1(n), k2(n), k3(n), k4(n), tmp(n);

    std::copy(y.begin(), y.end(), y_out);

    for (int step = 0; step < n_steps; ++step) {
        const double t = t0 + step * dt;

        f(t, y.data(), k1.data(), user);

        for (std::size_t i = 0; i < n; ++i) tmp[i] = y[i] + 0.5 * dt * k1[i];
        f(t + 0.5 * dt, tmp.data(), k2.data(), user);

        for (std::size_t i = 0; i < n; ++i) tmp[i] = y[i] + 0.5 * dt * k2[i];
        f(t + 0.5 * dt, tmp.data(), k3.data(), user);

        for (std::size_t i = 0; i < n; ++i) tmp[i] = y[i] + dt * k3[i];
        f(t + dt, tmp.data(), k4.data(), user);

        for (std::size_t i = 0; i < n; ++i) {
            y[i] += (dt / 6.0) * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
            y_next[i] = y[i];
        }

        std::copy(y_next.begin(), y_next.end(), y_out + (step + 1) * n);
    }
}

// ============================================================================
// DOP853 (Hairer Order 8, 12 Stages + FSAL)
// ============================================================================

namespace dop853_detail {

// Number of stages (FSAL included).
inline constexpr std::size_t N_STAGES = 12;

// Step-controller constants (Hairer / scipy defaults).
inline constexpr double SAFETY = 0.9;
inline constexpr double MIN_FACTOR = 0.2;
inline constexpr double MAX_FACTOR = 10.0;

// Nodes C[0..12] (C[12] = 1.0 is the FSAL node; extra entries unused).
inline constexpr double C[13] = {
    0.0, 0.05260015195876773, 0.0789002279381516, 0.1183503419072274,
    0.2816496580927726, 0.3333333333333333, 0.25, 0.3076923076923077,
    0.6512820512820513, 0.6, 0.8571428571428571, 1.0, 1.0};

// Butcher tableau A[13][16]; rows 0..11 are the stage increments, row 12
// equals B (FSAL).  Only columns < stage index are used (explicit method).
inline constexpr double A[13][16] = {
    {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
     0.0, 0.0},
    {0.05260015195876773, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
     0.0, 0.0, 0.0, 0.0, 0.0},
    {0.0197250569845379, 0.0591751709536137, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
     0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.02958758547680685, 0.0, 0.08876275643042054, 0.0, 0.0, 0.0, 0.0, 0.0,
     0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.2413651341592667, 0.0, -0.8845494793282861, 0.924834003261792, 0.0,
     0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.037037037037037035, 0.0, 0.0, 0.17082860872947386, 0.12546768756682242,
     0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.037109375, 0.0, 0.0, 0.17025221101954405, 0.06021653898045596,
     -0.017578125, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.03709200011850479, 0.0, 0.0, 0.17038392571223998, 0.10726203044637328,
     -0.015319437748624402, 0.008273789163814023, 0.0, 0.0, 0.0, 0.0, 0.0,
     0.0, 0.0, 0.0, 0.0},
    {0.6241109587160757, 0.0, 0.0, -3.3608926294469414, -0.868219346841726,
     27.59209969944671, 20.154067550477894, -43.48988418106996, 0.0, 0.0, 0.0,
     0.0, 0.0, 0.0, 0.0, 0.0},
    {0.47766253643826434, 0.0, 0.0, -2.4881146199716677, -0.590290826836843,
     21.230051448181193, 15.279233632882423, -33.28821096898486,
     -0.020331201708508627, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {-0.9371424300859873, 0.0, 0.0, 5.186372428844064, 1.0914373489967295,
     -8.149787010746927, -18.52006565999696, 22.739487099350505,
     2.4936055526796523, -3.0467644718982196, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {2.273310147516538, 0.0, 0.0, -10.53449546673725, -2.0008720582248625,
     -17.9589318631188, 27.94888452941996, -2.8589982771350235,
     -8.87285693353063, 12.360567175794303, 0.6433927460157636, 0.0, 0.0, 0.0,
     0.0, 0.0},
    {0.054293734116568765, 0.0, 0.0, 0.0, 0.0, 4.450312892752409,
     1.8915178993145003, -5.801203960010585, 0.3111643669578199,
     -0.1521609496625161, 0.20136540080403034, 0.04471061572777259, 0.0, 0.0,
     0.0, 0.0}};

// 8th-order solution weights.
inline constexpr double B[12] = {
    0.054293734116568765, 0.0, 0.0, 0.0, 0.0, 4.450312892752409,
    1.8915178993145003, -5.801203960010585, 0.3111643669578199,
    -0.1521609496625161, 0.20136540080403034, 0.04471061572777259};

// Order-3 error coefficients (step-size controller companion).
inline constexpr double E3[13] = {
    -0.18980075407240762, 0.0, 0.0, 0.0, 0.0, 4.450312892752409,
    1.8915178993145003, -5.801203960010585, -0.4226823213237919,
    -0.1521609496625161, 0.20136540080403034, 0.02265179219836082, 0.0};

// Order-5 (7th-order estimator) error coefficients.
inline constexpr double E5[13] = {
    0.01312004499419488, 0.0, 0.0, 0.0, 0.0, -1.2251564463762044,
    -0.4957589496572502, 1.6643771824549864, -0.35032884874997366,
    0.3341791187130175, 0.08192320648511571, -0.022355307863886294, 0.0};

}  // namespace dop853_detail

/// Options controlling a DOP853 integration.
struct Dop853Options {
    double rtol = 1e-10;
    double atol = 1e-12;
    double dt_initial = 0.0;   ///< 0 selects the Hairer automatic guess.
    double dt_min = 1e-8;      ///< Minimum step [s].
    double dt_max = 3600.0;    ///< Maximum step [s].
    int max_steps = 10000000;  ///< Hard cap on accepted+rejected steps.
};

/// Integrate an n-dim ODE with DOP853 (adaptive step, FSAL).
///
/// Order-8 propagator with order-7 error estimate; step control matches
/// scipy's solve_ivp(method="DOP853"): RMS error norm over
/// atol + rtol * max(|y|, |y_new|) with safety factor 0.9 and exponent
/// -1/8 (error estimator order 7).
///
/// @param f       RHS callback.
/// @param user    Opaque caller context passed to f.
/// @param n       State dimension.
/// @param y0      Initial state (length n, not modified).
/// @param t0      Initial time [s].
/// @param t1      End time [s]; may be before t0 for backward integration.
/// @param y_out   Output buffer, size n; receives the final state.
/// @param opts    Tolerances and step limits.
/// @param nfev_out  Optional output: number of RHS evaluations.
/// @return True on success; false if the step limit was hit or the step
///         size fell below dt_min.
inline bool dop853_integrate(const OdeFunc& f, void* user, std::size_t n,
                             const double* y0, double t0, double t1,
                             double* y_out,
                             const Dop853Options& opts = Dop853Options{},
                             int* nfev_out = nullptr) {
    namespace d = dop853_detail;

    if (n == 0) {
        return false;
    }
    if (t0 == t1) {
        std::copy(y0, y0 + n, y_out);
        if (nfev_out != nullptr) *nfev_out = 0;
        return true;
    }

    const double direction = (t1 > t0) ? 1.0 : -1.0;
    const double error_exponent = -1.0 / 8.0;  // estimator order 7.

    // Scratch: y, y_new, y_stage, stage derivatives K[0..12].
    std::vector<double> y(y0, y0 + n);
    std::vector<double> y_new(n);
    std::vector<double> y_stage(n);
    std::vector<double> K((d::N_STAGES + 1) * n);

    auto k_row = [&](std::size_t s) -> double* { return K.data() + s * n; };

    int nfev = 0;
    double t = t0;

    // FSAL seed: K[0] = f(t0, y0).
    f(t, y.data(), k_row(0), user);
    ++nfev;

    // --- Initial step size (Hairer's empirical selection, scipy parity) ---
    double h_abs = 0.0;
    if (opts.dt_initial > 0.0) {
        h_abs = opts.dt_initial;
    } else {
        std::vector<double> scale(n);
        std::vector<double> f0(k_row(0), k_row(0) + n);

        auto scaled_norm = [&](const double* vec) {
            double sum = 0.0;
            for (std::size_t i = 0; i < n; ++i) {
                const double s = vec[i] / scale[i];
                sum += s * s;
            }
            return std::sqrt(sum);
        };

        for (std::size_t i = 0; i < n; ++i) {
            scale[i] = opts.atol + std::abs(y[i]) * opts.rtol;
        }
        const double d0 = scaled_norm(y.data());
        const double d1 = scaled_norm(f0.data());

        double h0;
        if (d0 < 1e-5 || d1 < 1e-5) {
            h0 = 1e-6;
        } else {
            h0 = 0.01 * d0 / d1;
        }

        // One probe step to measure curvature.
        for (std::size_t i = 0; i < n; ++i) {
            y_stage[i] = y[i] + h0 * direction * f0[i];
        }
        std::vector<double> f1(n);
        f(t0 + h0 * direction, y_stage.data(), f1.data(), user);
        ++nfev;

        std::vector<double> diff(n);
        for (std::size_t i = 0; i < n; ++i) {
            diff[i] = (f1[i] - f0[i]) / scale[i];
        }
        const double d2 = scaled_norm(diff.data()) / h0;

        double h1;
        if (d1 <= 1e-15 && d2 <= 1e-15) {
            h1 = std::max(1e-6, h0 * 1e-3);
        } else {
            h1 = std::pow(0.01 / std::max(d1, d2), 1.0 / 8.0);
        }
        h_abs = std::min(100.0 * h0, h1);
    }
    h_abs = std::clamp(h_abs, opts.dt_min, opts.dt_max);

    // --- Main stepping loop ---
    bool step_rejected = false;
    int steps = 0;

    while (direction * (t - t1) < 0.0) {
        if (++steps > opts.max_steps) {
            if (nfev_out != nullptr) *nfev_out = nfev;
            return false;
        }
        if (h_abs < opts.dt_min) {
            if (nfev_out != nullptr) *nfev_out = nfev;
            return false;
        }

        double h = direction * h_abs;
        double t_new = t + h;
        // Clamp to the boundary so we land exactly on t1.
        if (direction * (t_new - t1) > 0.0) {
            t_new = t1;
            h = t_new - t;
            h_abs = std::abs(h);
        }

        // Stages 2..12: K[s] = f(t + C[s]*h, y + h * sum_{j<s} A[s][j] K[j]).
        for (std::size_t s = 1; s < d::N_STAGES; ++s) {
            for (std::size_t i = 0; i < n; ++i) {
                double dy = 0.0;
                for (std::size_t j = 0; j < s; ++j) {
                    dy += d::A[s][j] * k_row(j)[i];
                }
                y_stage[i] = y[i] + h * dy;
            }
            f(t + d::C[s] * h, y_stage.data(), k_row(s), user);
            ++nfev;
        }

        // 8th-order solution: y_new = y + h * sum_j B[j] K[j].
        for (std::size_t i = 0; i < n; ++i) {
            double dy = 0.0;
            for (std::size_t j = 0; j < d::N_STAGES; ++j) {
                dy += d::B[j] * k_row(j)[i];
            }
            y_new[i] = y[i] + h * dy;
        }

        // FSAL: K[12] = f(t + h, y_new).
        f(t + h, y_new.data(), k_row(d::N_STAGES), user);
        ++nfev;

        // Error norm (scipy DOP853._estimate_error_norm):
        //   err5 = K^T E5 / scale, err3 = K^T E3 / scale
        //   error_norm = |h| * ||err5||^2 / sqrt((||err5||^2 + 0.01||err3||^2) n)
        std::vector<double> scale(n);
        for (std::size_t i = 0; i < n; ++i) {
            scale[i] = opts.atol +
                       std::max(std::abs(y[i]), std::abs(y_new[i])) * opts.rtol;
        }

        double err5_norm_2 = 0.0;
        double err3_norm_2 = 0.0;
        for (std::size_t i = 0; i < n; ++i) {
            double err5 = 0.0;
            double err3 = 0.0;
            for (std::size_t j = 0; j <= d::N_STAGES; ++j) {
                err5 += d::E5[j] * k_row(j)[i];
                err3 += d::E3[j] * k_row(j)[i];
            }
            err5 /= scale[i];
            err3 /= scale[i];
            err5_norm_2 += err5 * err5;
            err3_norm_2 += err3 * err3;
        }

        double error_norm;
        if (err5_norm_2 == 0.0 && err3_norm_2 == 0.0) {
            error_norm = 0.0;
        } else {
            const double denom = err5_norm_2 + 0.01 * err3_norm_2;
            error_norm = std::abs(h) * err5_norm_2 /
                         std::sqrt(denom * static_cast<double>(n));
        }

        if (error_norm < 1.0) {
            // Accept the step.
            double factor;
            if (error_norm == 0.0) {
                factor = d::MAX_FACTOR;
            } else {
                factor = std::min(d::MAX_FACTOR,
                                  d::SAFETY * std::pow(error_norm,
                                                       error_exponent));
            }
            if (step_rejected) {
                factor = std::min(1.0, factor);
            }
            h_abs *= factor;

            t = t_new;
            std::copy(y_new.begin(), y_new.end(), y.begin());
            // FSAL: next step's K[0] is this step's f_new.
            std::copy(k_row(d::N_STAGES), k_row(d::N_STAGES) + n, k_row(0));
            step_rejected = false;
        } else {
            // Reject: shrink the step and retry.
            h_abs *= std::max(d::MIN_FACTOR,
                              d::SAFETY * std::pow(error_norm,
                                                   error_exponent));
            step_rejected = true;
        }

        h_abs = std::min(h_abs, opts.dt_max);
    }

    std::copy(y.begin(), y.end(), y_out);
    if (nfev_out != nullptr) *nfev_out = nfev;
    return true;
}

// ============================================================================
// Variational (STM) Propagation: 42-Dim J2-Augmented State
// ============================================================================

/// Force-model fidelity tier for the variational propagator.
enum class ForceTier : int {
    TWO_BODY = 0,  ///< Point-mass gravity only.
    J2 = 1         ///< Two-body plus J2 zonal harmonic (Phase 1 default).
};

/// Caller context for j2_augmented_derivatives.
struct VariationalContext {
    double jd0 = 0.0;           ///< Julian Date at t = 0 [days].
    int force_tier = 1;         ///< ForceTier as int (0=two-body, 1=J2).
};

/// 42-dim augmented-state RHS: y = [r(3), v(3), Phi_flat(36)].
///
/// dPhi/dt = F(t) Phi with the 6x6 state Jacobian
///   F = [[0, I], [da/dr, 0]]
/// evaluated along the trajectory (Phi flattened row-major).  Matches
/// helio_ob integrators.build_j2_augmented_ode.
///
/// @param t      Time [s] since the initial epoch (autonomous forces).
/// @param y      Augmented state (length 42).
/// @param dydt   Output derivatives (length 42).
/// @param user   VariationalContext (may be null -> defaults to J2).
inline void j2_augmented_derivatives(double t, const double* y, double* dydt,
                                     void* user) {
    (void)t;  // Forces are autonomous (J2/two-body; drag density too).

    const VariationalContext* ctx =
        static_cast<const VariationalContext*>(user);
    const int tier = (ctx != nullptr) ? ctx->force_tier : 1;

    const Vec3 r(y[0], y[1], y[2]);
    const Vec3 v(y[3], y[4], y[5]);

    Vec3 accel;
    Mat3d da_dr;
    if (tier == static_cast<int>(ForceTier::TWO_BODY)) {
        accel = compute_two_body_acceleration(r);
        da_dr = two_body_jacobian(r);
    } else {
        auto [a, jac] = combined_accel_and_jacobian(r);
        accel = a;
        da_dr = jac;
    }

    // d r/dt = v, d v/dt = a.
    dydt[0] = v.x;
    dydt[1] = v.y;
    dydt[2] = v.z;
    dydt[3] = accel.x;
    dydt[4] = accel.y;
    dydt[5] = accel.z;

    // dPhi = F @ Phi.  F = [[0, I], [da/dr, 0]] so:
    //   rows 0..2: dPhi(i, :) = Phi(i+3, :)
    //   rows 3..5: dPhi(3+i, :) = sum_j da_dr(i, j) * Phi(j, :)
    for (std::size_t j = 0; j < 6; ++j) {
        dydt[6 + 0 * 6 + j] = y[6 + 3 * 6 + j];
        dydt[6 + 1 * 6 + j] = y[6 + 4 * 6 + j];
        dydt[6 + 2 * 6 + j] = y[6 + 5 * 6 + j];
    }
    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 6; ++j) {
            double sum = 0.0;
            for (std::size_t k = 0; k < 3; ++k) {
                sum += da_dr(i, k) * y[6 + k * 6 + j];
            }
            dydt[6 + (3 + i) * 6 + j] = sum;
        }
    }
}

/// Result of a variational (STM) propagation.
struct STMResult {
    Vec3 position;                      ///< Final position [km].
    Vec3 velocity;                      ///< Final velocity [km/s].
    std::array<double, 36> stm{};       ///< 6x6 STM, row-major.
    bool success = false;               ///< Integration status.
    int nfev = 0;                       ///< RHS evaluations used.
};

/// Propagate a 42-dim augmented state [r, v, Phi] with DOP853.
///
/// Phase 1 supports the two nested tiers TWO_BODY and J2 (drag-augmented
/// 56-dim states are deferred to Phase 4).
///
/// @param y0_42       Initial augmented state (length 42; Phi row-major).
/// @param t0          Start time [s].
/// @param t1          End time [s].
/// @param rtol        Relative tolerance.
/// @param atol        Absolute tolerance.
/// @param force_tier  ForceTier as int (0 = two-body, 1 = J2).
/// @param jd0         Julian Date at t = 0 (reserved for time-dependent
///                    forces; unused by the autonomous J2 tier).
/// @return STMResult with final r, v, and the 6x6 STM.
inline STMResult propagate_with_stm(const double* y0_42, double t0, double t1,
                                    double rtol, double atol, int force_tier,
                                    double jd0 = 0.0) {
    VariationalContext ctx;
    ctx.jd0 = jd0;
    ctx.force_tier = force_tier;

    std::array<double, 42> y_out{};

    Dop853Options opts;
    opts.rtol = rtol;
    opts.atol = atol;

    STMResult result;
    result.success = dop853_integrate(j2_augmented_derivatives, &ctx, 42,
                                      y0_42, t0, t1, y_out.data(), opts,
                                      &result.nfev);
    result.position = Vec3(y_out[0], y_out[1], y_out[2]);
    result.velocity = Vec3(y_out[3], y_out[4], y_out[5]);
    for (std::size_t i = 0; i < 36; ++i) {
        result.stm[i] = y_out[6 + i];
    }
    return result;
}

/// Convenience overload taking std::array<double, 42>.
inline STMResult propagate_with_stm(const std::array<double, 42>& y0_42,
                                    double t0, double t1, double rtol,
                                    double atol, int force_tier,
                                    double jd0 = 0.0) {
    return propagate_with_stm(y0_42.data(), t0, t1, rtol, atol, force_tier,
                              jd0);
}

}  // namespace orbit
