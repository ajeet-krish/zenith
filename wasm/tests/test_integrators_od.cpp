// Native tests for the generic ODE core in zenith/integrators.hpp:
// DOP853 accuracy against the analytic Kepler solution, DOP853 J2 STM
// against finite-difference perturbed states, and generic RK4 parity
// with the legacy IntegrationState RK4.

#include <gtest/gtest.h>

#include <cmath>

#include "zenith/coordinate_frames.hpp"
#include "zenith/integrators.hpp"
#include "zenith/kepler.hpp"

using orbit::Vec3;

namespace {

// Two-body 6-dim RHS for the generic core: y = [r(3), v(3)], t in seconds.
void two_body_rhs(double /*t*/, const double* y, double* dydt, void* user) {
    const double mu = (user != nullptr) ? *static_cast<const double*>(user)
                                        : orbit::MU_EARTH;
    (void)mu;
    const Vec3 r(y[0], y[1], y[2]);
    const Vec3 a = orbit::compute_two_body_acceleration(r);
    dydt[0] = y[3];
    dydt[1] = y[4];
    dydt[2] = y[5];
    dydt[3] = a.x;
    dydt[4] = a.y;
    dydt[5] = a.z;
}

// Two-body plus J2 6-dim RHS (accel from the combined analytic model).
void j2_rhs(double /*t*/, const double* y, double* dydt, void* /*user*/) {
    const Vec3 r(y[0], y[1], y[2]);
    auto [accel, jac] = orbit::combined_accel_and_jacobian(r);
    (void)jac;
    dydt[0] = y[3];
    dydt[1] = y[4];
    dydt[2] = y[5];
    dydt[3] = accel.x;
    dydt[4] = accel.y;
    dydt[5] = accel.z;
}

// Circular-ish test orbit: a = 7000 km, e = 0.05, i = 30 deg.
orbit::KeplerianElements test_elements() {
    return orbit::KeplerianElements(
        7000.0, 0.05, 30.0 * orbit::DEG_TO_RAD,
        40.0 * orbit::DEG_TO_RAD, 60.0 * orbit::DEG_TO_RAD,
        10.0 * orbit::DEG_TO_RAD, 2461000.5);
}

}  // namespace

TEST(IntegratorsOd, Dop853TwoBodyMatchesAnalyticKepler) {
    const orbit::KeplerianElements elem = test_elements();
    const orbit::StateVector y0 = orbit::elements_to_state(elem);
    const double period = elem.period();
    ASSERT_GT(period, 0.0);

    double y_init[6] = {y0.position.x, y0.position.y, y0.position.z,
                        y0.velocity.x, y0.velocity.y, y0.velocity.z};
    double y_end[6] = {0.0};

    orbit::Dop853Options opts;
    opts.rtol = 1e-13;
    opts.atol = 1e-15;
    ASSERT_TRUE(orbit::dop853_integrate(two_body_rhs, nullptr, 6, y_init, 0.0,
                                        period, y_end, opts));

    // One full period: the state must return to the initial conditions.
    const Vec3 r_end(y_end[0], y_end[1], y_end[2]);
    const Vec3 v_end(y_end[3], y_end[4], y_end[5]);
    EXPECT_LT((r_end - y0.position).magnitude(), 1e-7);
    EXPECT_LT((v_end - y0.velocity).magnitude(), 1e-10);

    // Half period: analytic comparison via Kepler propagation.
    double y_half[6] = {0.0};
    ASSERT_TRUE(orbit::dop853_integrate(two_body_rhs, nullptr, 6, y_init, 0.0,
                                        0.5 * period, y_half, opts));
    const orbit::StateVector analytic_half =
        orbit::propagate_kepler_state(y0, 0.5 * period);
    const Vec3 r_half(y_half[0], y_half[1], y_half[2]);
    EXPECT_LT((r_half - analytic_half.position).magnitude(), 1e-7);
}

TEST(IntegratorsOd, Dop853J2StmMatchesFiniteDifference) {
    const orbit::KeplerianElements elem = test_elements();
    const orbit::StateVector y0 = orbit::elements_to_state(elem);

    // Augmented initial state: Phi = identity.
    std::array<double, 42> y0_42{};
    y0_42[0] = y0.position.x;
    y0_42[1] = y0.position.y;
    y0_42[2] = y0.position.z;
    y0_42[3] = y0.velocity.x;
    y0_42[4] = y0.velocity.y;
    y0_42[5] = y0.velocity.z;
    for (int i = 0; i < 6; ++i) {
        y0_42[6 + i * 6 + i] = 1.0;
    }

    const double arc = 1800.0;  // 30 minutes.
    orbit::STMResult res = orbit::propagate_with_stm(
        y0_42, 0.0, arc, 1e-13, 1e-15,
        static_cast<int>(orbit::ForceTier::J2));
    ASSERT_TRUE(res.success);

    // Finite-difference STM: perturb each of the 6 state components.
    orbit::Mat6d stm_fd;
    orbit::Dop853Options opts;
    opts.rtol = 1e-13;
    opts.atol = 1e-15;

    const double eps_pos = 1e-4;    // km.
    const double eps_vel = 1e-7;    // km/s.

    for (int k = 0; k < 6; ++k) {
        const double eps = (k < 3) ? eps_pos : eps_vel;

        std::array<double, 6> yp{};
        std::array<double, 6> ym{};
        for (int i = 0; i < 6; ++i) {
            yp[i] = y0_42[i];
            ym[i] = y0_42[i];
        }
        yp[k] += eps;
        ym[k] -= eps;

        std::array<double, 6> fp{};
        std::array<double, 6> fm{};
        ASSERT_TRUE(orbit::dop853_integrate(j2_rhs, nullptr, 6, yp.data(), 0.0,
                                            arc, fp.data(), opts));
        ASSERT_TRUE(orbit::dop853_integrate(j2_rhs, nullptr, 6, ym.data(), 0.0,
                                            arc, fm.data(), opts));

        for (int i = 0; i < 6; ++i) {
            stm_fd(i, k) = (fp[i] - fm[i]) / (2.0 * eps);
        }
    }

    // Compare the analytic STM with the finite-difference STM.
    for (int i = 0; i < 6; ++i) {
        for (int j = 0; j < 6; ++j) {
            const double analytic = res.stm[i * 6 + j];
            const double numeric = stm_fd(i, j);
            const double scale = std::max(std::abs(analytic), 1e-3);
            EXPECT_NEAR(analytic, numeric, 1e-5 * scale)
                << "STM(" << i << ", " << j << ")";
        }
    }
}

TEST(IntegratorsOd, StmPropagateReturnsConsistentState) {
    // With Phi = 0 initial conditions the STM block must stay zero and the
    // trajectory must match a plain 6-dim J2 integration.
    orbit::KeplerianElements elem = test_elements();
    orbit::StateVector y0 = orbit::elements_to_state(elem);

    std::array<double, 42> y0_42{};
    for (int i = 0; i < 6; ++i) {
        y0_42[i] = (i == 0) ? y0.position.x : (i == 1) ? y0.position.y
                    : (i == 2) ? y0.position.z : (i == 3) ? y0.velocity.x
                    : (i == 4) ? y0.velocity.y : y0.velocity.z;
    }

    const double arc = 600.0;
    orbit::STMResult res = orbit::propagate_with_stm(
        y0_42, 0.0, arc, 1e-12, 1e-14,
        static_cast<int>(orbit::ForceTier::J2));
    ASSERT_TRUE(res.success);

    double y6[6] = {y0_42[0], y0_42[1], y0_42[2], y0_42[3], y0_42[4],
                    y0_42[5]};
    double y6_end[6] = {0.0};
    orbit::Dop853Options opts;
    opts.rtol = 1e-12;
    opts.atol = 1e-14;
    ASSERT_TRUE(orbit::dop853_integrate(j2_rhs, nullptr, 6, y6, 0.0, arc,
                                        y6_end, opts));

    EXPECT_NEAR(res.position.x, y6_end[0], 1e-9);
    EXPECT_NEAR(res.position.y, y6_end[1], 1e-9);
    EXPECT_NEAR(res.position.z, y6_end[2], 1e-9);
    EXPECT_NEAR(res.velocity.x, y6_end[3], 1e-10);
    EXPECT_NEAR(res.velocity.y, y6_end[4], 1e-10);
    EXPECT_NEAR(res.velocity.z, y6_end[5], 1e-10);

    // Zero initial STM stays zero.
    for (double s : res.stm) {
        EXPECT_DOUBLE_EQ(s, 0.0);
    }
}

TEST(IntegratorsOd, TwoBodyTierDiffersFromJ2Tier) {
    orbit::KeplerianElements elem = test_elements();
    orbit::StateVector y0 = orbit::elements_to_state(elem);

    std::array<double, 42> y0_42{};
    y0_42[0] = y0.position.x;
    y0_42[1] = y0.position.y;
    y0_42[2] = y0.position.z;
    y0_42[3] = y0.velocity.x;
    y0_42[4] = y0.velocity.y;
    y0_42[5] = y0.velocity.z;
    for (int i = 0; i < 6; ++i) {
        y0_42[6 + i * 6 + i] = 1.0;
    }

    const double arc = 5400.0;  // 90 minutes, most of an orbit.
    auto res_tb = orbit::propagate_with_stm(
        y0_42, 0.0, arc, 1e-12, 1e-14,
        static_cast<int>(orbit::ForceTier::TWO_BODY));
    auto res_j2 = orbit::propagate_with_stm(
        y0_42, 0.0, arc, 1e-12, 1e-14,
        static_cast<int>(orbit::ForceTier::J2));
    ASSERT_TRUE(res_tb.success);
    ASSERT_TRUE(res_j2.success);

    // J2 shifts the position by meters to kilometers over 90 min.
    const double diff = (res_tb.position - res_j2.position).magnitude();
    EXPECT_GT(diff, 1e-4);
    EXPECT_LT(diff, 200.0);
}

TEST(IntegratorsOd, Rk4GenericParityWithLegacy) {
    orbit::KeplerianElements elem = test_elements();
    orbit::StateVector y0 = orbit::elements_to_state(elem);

    // Legacy IntegrationState RK4 with a two-body-only params set.
    orbit::PropagatorParams params;
    params.use_j2 = false;
    params.use_j4 = false;
    params.use_drag = false;
    params.use_srp = false;
    params.use_third_body = false;

    orbit::IntegrationState init;
    init.position = y0.position;
    init.velocity = y0.velocity;
    init.time = 0.0;

    const double dt = 10.0;
    const int n_steps = 100;
    auto legacy = orbit::rk4_integrate(init, y0.epoch, dt, n_steps, params);
    ASSERT_EQ(static_cast<int>(legacy.size()), n_steps + 1);

    // Generic n-dim RK4 on the same two-body force model.
    double y0_6[6] = {y0.position.x, y0.position.y, y0.position.z,
                      y0.velocity.x, y0.velocity.y, y0.velocity.z};
    std::vector<double> out(6 * (n_steps + 1), 0.0);
    orbit::rk4_fixed_step(two_body_rhs, nullptr, 6, y0_6, 0.0, dt, n_steps,
                          out.data());

    for (int k = 0; k <= n_steps; ++k) {
        EXPECT_NEAR(out[6 * k + 0], legacy[k].position.x, 1e-12) << "step " << k;
        EXPECT_NEAR(out[6 * k + 1], legacy[k].position.y, 1e-12);
        EXPECT_NEAR(out[6 * k + 2], legacy[k].position.z, 1e-12);
        EXPECT_NEAR(out[6 * k + 3], legacy[k].velocity.x, 1e-15);
        EXPECT_NEAR(out[6 * k + 4], legacy[k].velocity.y, 1e-15);
        EXPECT_NEAR(out[6 * k + 5], legacy[k].velocity.z, 1e-15);
    }
}

TEST(IntegratorsOd, Dop853StepUnderflowReturnsFailure) {
    // Stiff linear RHS y' = lambda*y with lambda so large that even the
    // minimum step dt_min is unstable: every step is rejected, h shrinks
    // below dt_min, and the integrator must fail cleanly (return false)
    // instead of looping forever or silently accepting garbage.
    double lambda = 1e12;
    auto stiff_rhs = [](double /*t*/, const double* y, double* dydt,
                        void* user) {
        const double lam = *static_cast<const double*>(user);
        dydt[0] = lam * y[0];
    };

    double y0[1] = {1.0};
    double y_end[1] = {0.0};
    orbit::Dop853Options opts;
    opts.rtol = 1e-10;
    opts.atol = 1e-12;
    opts.dt_initial = 1.0;
    opts.dt_min = 1e-8;

    int nfev = 0;
    EXPECT_FALSE(orbit::dop853_integrate(stiff_rhs, &lambda, 1, y0, 0.0, 1.0,
                                         y_end, opts, &nfev));
    // The failed attempt must have evaluated the RHS at least once.
    EXPECT_GT(nfev, 0);
}

TEST(IntegratorsOd, Dop853MaxStepsReturnsFailure) {
    // max_steps = 1 cannot complete a full orbit; the hard step cap must
    // abort with return false rather than overrun.
    const orbit::KeplerianElements elem = test_elements();
    const orbit::StateVector y0 = orbit::elements_to_state(elem);

    double y_init[6] = {y0.position.x, y0.position.y, y0.position.z,
                        y0.velocity.x, y0.velocity.y, y0.velocity.z};
    double y_end[6] = {0.0};

    orbit::Dop853Options opts;
    opts.max_steps = 1;
    EXPECT_FALSE(orbit::dop853_integrate(two_body_rhs, nullptr, 6, y_init,
                                         0.0, elem.period(), y_end, opts));
}

TEST(IntegratorsOd, Dop853BoundaryCases) {
    // n == 0 is rejected before any buffer is touched.
    EXPECT_FALSE(orbit::dop853_integrate(two_body_rhs, nullptr, 0, nullptr,
                                         0.0, 1.0, nullptr));

    // t0 == t1 copies the state and succeeds without stepping.
    double y0[6] = {1.0, 2.0, 3.0, 4.0, 5.0, 6.0};
    double y_end[6] = {0.0};
    EXPECT_TRUE(orbit::dop853_integrate(two_body_rhs, nullptr, 6, y0, 0.0,
                                        0.0, y_end));
    for (int i = 0; i < 6; ++i) {
        EXPECT_DOUBLE_EQ(y_end[i], y0[i]);
    }
}

TEST(IntegratorsOd, KeplerAnomalyGapFunctions) {
    // Round-trip: true -> eccentric -> mean -> true.
    const double e = 0.3;
    const double nu = 1.1;
    const double E = orbit::true_to_eccentric(nu, e);
    const double M = orbit::eccentric_to_mean(E, e);
    const double nu_back = orbit::mean_to_true(M, e);
    EXPECT_NEAR(nu_back, nu, 1e-12);

    // solve_kepler rejects e >= 1 (helio ValueError semantics).
    EXPECT_THROW(orbit::solve_kepler(0.5, 1.0), std::invalid_argument);
    EXPECT_THROW(orbit::solve_kepler(0.5, -0.1), std::invalid_argument);
}
