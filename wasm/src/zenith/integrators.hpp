#pragma once

/// @file integrators.hpp
/// @brief Numerical ODE integrators for orbit propagation.
///        Provides classical RK4 (fixed step) and Dormand-Prince RK45
///        (adaptive step) integrators for numerical orbit propagation
///        with configurable force models.

#include <algorithm>
#include <cmath>
#include <vector>

#include "orbit_types.hpp"
#include "force_models.hpp"

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

}  // namespace orbit
