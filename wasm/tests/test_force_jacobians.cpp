// Native tests for the analytic force Jacobians in zenith/force_models.hpp:
// two-body, J2, combined, and drag (da/dr and da/dCd) checked against
// central finite differences.

#include <gtest/gtest.h>

#include "zenith/force_models.hpp"

using orbit::Mat3d;
using orbit::Vec3;

namespace {

// Central finite-difference Jacobian of a Vec3-valued function of r.
template <typename F>
Mat3d finite_difference_jacobian(const F& func, const Vec3& r, double eps) {
    Mat3d jac;
    for (std::size_t j = 0; j < 3; ++j) {
        Vec3 rp = r;
        Vec3 rm = r;
        if (j == 0) { rp.x += eps; rm.x -= eps; }
        if (j == 1) { rp.y += eps; rm.y -= eps; }
        if (j == 2) { rp.z += eps; rm.z -= eps; }
        const Vec3 fp = func(rp);
        const Vec3 fm = func(rm);
        jac(0, j) = (fp.x - fm.x) / (2.0 * eps);
        jac(1, j) = (fp.y - fm.y) / (2.0 * eps);
        jac(2, j) = (fp.z - fm.z) / (2.0 * eps);
    }
    return jac;
}

void expect_jacobians_close(const Mat3d& analytic, const Mat3d& numeric,
                            double rtol, double scale) {
    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 3; ++j) {
            EXPECT_NEAR(analytic(i, j), numeric(i, j),
                        rtol * scale + 1e-14)
                << "element (" << i << ", " << j << ")";
        }
    }
}

// Typical LEO position away from coordinate singularities.
const Vec3 kR(7000.0, 1500.0, -2000.0);
const Vec3 kV(1.0, 7.0, 2.0);

}  // namespace

TEST(ForceJacobians, TwoBodyMatchesFiniteDifference) {
    auto jac = orbit::two_body_jacobian(kR);
    auto numeric = finite_difference_jacobian(
        [](const Vec3& r) { return orbit::compute_two_body_acceleration(r); },
        kR, 1.0);

    // da/dr scale ~ mu / r^3 ~ 1.2e-6 s^-2.
    expect_jacobians_close(jac, numeric, 1e-5, 1.2e-6);
}

TEST(ForceJacobians, TwoBodyAnalyticForm) {
    // da_ij/dx_j = -mu (delta_ij / r^3 - 3 x_i x_j / r^5).
    const double r = kR.magnitude();
    auto jac = orbit::two_body_jacobian(kR);
    const double x[3] = {kR.x, kR.y, kR.z};
    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 3; ++j) {
            const double delta = (i == j) ? 1.0 : 0.0;
            const double expected =
                -orbit::MU_EARTH * (delta / (r * r * r) -
                                    3.0 * x[i] * x[j] / (r * r * r * r * r));
            EXPECT_NEAR(jac(i, j), expected, 1e-15);
        }
    }
}

TEST(ForceJacobians, J2MatchesFiniteDifference) {
    auto [accel, jac] = orbit::j2_accel_and_jacobian(kR);

    // Cross-check the acceleration against the standalone J2 function.
    Vec3 accel_ref = orbit::compute_j2_acceleration(kR);
    EXPECT_NEAR((accel - accel_ref).magnitude(), 0.0, 1e-18);

    auto numeric = finite_difference_jacobian(
        [](const Vec3& rr) { return orbit::compute_j2_acceleration(rr); },
        kR, 1.0);

    // J2 accel scale ~ 1e-5 km/s^2 at LEO; jac entries ~ 1e-9 s^-2.
    expect_jacobians_close(jac, numeric, 1e-5, 1e-9);
}

TEST(ForceJacobians, CombinedMatchesFiniteDifference) {
    auto [accel, jac] = orbit::combined_accel_and_jacobian(kR);

    Vec3 accel_ref = orbit::compute_two_body_acceleration(kR) +
                     orbit::compute_j2_acceleration(kR);
    EXPECT_NEAR((accel - accel_ref).magnitude(), 0.0, 1e-18);

    auto numeric = finite_difference_jacobian(
        [](const Vec3& rr) {
            return orbit::compute_two_body_acceleration(rr) +
                   orbit::compute_j2_acceleration(rr);
        },
        kR, 1.0);
    expect_jacobians_close(jac, numeric, 1e-5, 1.2e-6);
}

TEST(ForceJacobians, CombinedWithDragMatchesFiniteDifference) {
    orbit::PropagatorParams params;  // use_j2 defaults to true.
    auto [accel, jac] =
        orbit::combined_accel_and_jacobian(kR, kV, params, true);

    auto numeric = finite_difference_jacobian(
        [&params](const Vec3& rr) {
            return orbit::compute_two_body_acceleration(rr) +
                   orbit::compute_j2_acceleration(rr) +
                   orbit::compute_drag_acceleration(rr, kV, 0.0, params);
        },
        kR, 0.1);
    expect_jacobians_close(jac, numeric, 1e-5, 1.2e-6);
}

TEST(ForceJacobians, DragDensityAtReferenceAltitude) {
    // At |r| = R_EARTH + 400 km the model returns exactly RHO0.
    const double alt = 400.0;
    Vec3 r(orbit::R_EARTH + alt, 0.0, 0.0);
    EXPECT_DOUBLE_EQ(orbit::atmospheric_density(r), orbit::RHO0);

    // One scale height up: density drops by e.
    Vec3 r2(orbit::R_EARTH + alt + orbit::H_SCALE_KM, 0.0, 0.0);
    EXPECT_NEAR(orbit::atmospheric_density(r2), orbit::RHO0 / std::exp(1.0),
                1e-24);

    // Deep inside the Earth: exponent cap prevents overflow.
    Vec3 r_center(1.0, 0.0, 0.0);
    double rho = orbit::atmospheric_density(r_center);
    EXPECT_TRUE(std::isfinite(rho));
    EXPECT_GT(rho, 0.0);
}

TEST(ForceJacobians, DragJacobianMatchesFiniteDifference) {
    orbit::DragParams drag = orbit::DragParams::from_m2_per_kg(0.01);
    auto [accel, da_dr, da_dcd] =
        orbit::drag_accel_and_jacobian(kR, kV, drag);

    // Acceleration must agree with the plain drag function.
    Vec3 accel_ref = orbit::drag_acceleration(kR, kV, drag);
    EXPECT_NEAR((accel - accel_ref).magnitude(), 0.0, 1e-24);

    // da/dCd = a / Cd exactly (drag is linear in Cd).
    for (std::size_t i = 0; i < 3; ++i) {
        double a_i = (i == 0) ? accel.x : (i == 1) ? accel.y : accel.z;
        double d_i = (i == 0) ? da_dcd.x : (i == 1) ? da_dcd.y : da_dcd.z;
        EXPECT_NEAR(d_i, a_i / drag.cd, 1e-24);
    }

    // da/dr vs central finite differences.
    auto numeric = finite_difference_jacobian(
        [&drag](const Vec3& rr) {
            return orbit::drag_acceleration(rr, kV, drag);
        },
        kR, 0.01);
    // Drag is tiny (~1e-9 km/s^2); use absolute tolerance scaled to it.
    expect_jacobians_close(da_dr, numeric, 1e-4, 1e-9);
}

TEST(ForceJacobians, DragZeroCdThrows) {
    orbit::DragParams drag;
    drag.cd = 0.0;
    drag.a_over_m_km2_kg = 1e-8;
    EXPECT_THROW(orbit::drag_accel_and_jacobian(kR, kV, drag),
                 std::invalid_argument);
}
