// Native tests for zenith/matrix_ops.hpp: LU solve, Cholesky, inverse,
// singular detection, and basic operations against known values.

#include <gtest/gtest.h>

#include "zenith/matrix_ops.hpp"

using orbit::Mat;
using orbit::Vec;

namespace {

Mat<3, 3> make_mat3(const double* values9) {
    Mat<3, 3> m;
    for (std::size_t i = 0; i < 9; ++i) {
        m.data[i] = values9[i];
    }
    return m;
}

// A nonsingular 3x3 test matrix with a known inverse (det = 9).
const double kA3[9] = {4.0, 7.0, 2.0,
                       3.0, 6.0, 1.0,
                       2.0, 5.0, 3.0};

// Inverse of kA3 (adjugate / det, cofactor expansion).
const double kA3Inv[9] = {13.0 / 9.0, -11.0 / 9.0, -5.0 / 9.0,
                          -7.0 / 9.0, 8.0 / 9.0, 2.0 / 9.0,
                          3.0 / 9.0, -6.0 / 9.0, 3.0 / 9.0};

}  // namespace

TEST(MatrixOps, IdentityAndMultiply) {
    auto id3 = orbit::identity<3>();
    auto a = make_mat3(kA3);
    auto prod = orbit::multiply(a, id3);
    for (std::size_t k = 0; k < 9; ++k) {
        EXPECT_DOUBLE_EQ(prod.data[k], a.data[k]);
    }

    // Mat * vec against hand-computed result.
    Vec<3> x;
    x[0] = 1.0;
    x[1] = 2.0;
    x[2] = 3.0;
    Vec<3> y = orbit::multiply(a, x);
    EXPECT_DOUBLE_EQ(y[0], 4.0 * 1 + 7.0 * 2 + 2.0 * 3);
    EXPECT_DOUBLE_EQ(y[1], 3.0 * 1 + 6.0 * 2 + 1.0 * 3);
    EXPECT_DOUBLE_EQ(y[2], 2.0 * 1 + 5.0 * 2 + 3.0 * 3);
}

TEST(MatrixOps, Transpose) {
    auto a = make_mat3(kA3);
    auto at = orbit::transpose(a);
    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 3; ++j) {
            EXPECT_DOUBLE_EQ(at(i, j), a(j, i));
        }
    }
}

TEST(MatrixOps, NormsAndSymmetrize) {
    auto a = make_mat3(kA3);
    // Frobenius: sqrt(16+49+4+9+36+1+4+25+9) = sqrt(153).
    EXPECT_NEAR(orbit::frobenius_norm(a), std::sqrt(153.0), 1e-12);
    EXPECT_DOUBLE_EQ(orbit::max_abs(a), 7.0);

    Mat<2, 2> m;
    m(0, 0) = 1.0;
    m(0, 1) = 3.0;
    m(1, 0) = -1.0;
    m(1, 1) = 2.0;
    auto sym = orbit::symmetrize(m);
    EXPECT_DOUBLE_EQ(sym(0, 0), 1.0);
    EXPECT_DOUBLE_EQ(sym(0, 1), 1.0);
    EXPECT_DOUBLE_EQ(sym(1, 0), 1.0);
    EXPECT_DOUBLE_EQ(sym(1, 1), 2.0);
}

TEST(MatrixOps, LuSolveKnownSystem) {
    auto a = make_mat3(kA3);
    Vec<3> b;
    b[0] = 1.0;
    b[1] = 2.0;
    b[2] = 3.0;

    Vec<3> x;
    ASSERT_TRUE(orbit::lu_solve(a, b, x));

    // Expected x = A^{-1} b via kA3Inv.
    for (std::size_t i = 0; i < 3; ++i) {
        double expected = 0.0;
        for (std::size_t j = 0; j < 3; ++j) {
            expected += kA3Inv[i * 3 + j] * b[j];
        }
        EXPECT_NEAR(x[i], expected, 1e-12);
    }

    // Residual check: A x - b ~ 0.
    Vec<3> ax = orbit::multiply(a, x);
    for (std::size_t i = 0; i < 3; ++i) {
        EXPECT_NEAR(ax[i] - b[i], 0.0, 1e-12);
    }
}

TEST(MatrixOps, InverseKnownMatrix) {
    auto a = make_mat3(kA3);
    Mat<3, 3> a_inv;
    ASSERT_TRUE(orbit::inverse(a, a_inv));

    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 3; ++j) {
            EXPECT_NEAR(a_inv(i, j), kA3Inv[i * 3 + j], 1e-12);
        }
    }

    // A * A^{-1} = I.
    auto prod = orbit::multiply(a, a_inv);
    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 3; ++j) {
            EXPECT_NEAR(prod(i, j), (i == j) ? 1.0 : 0.0, 1e-12);
        }
    }
}

TEST(MatrixOps, SingularMatrixDetected) {
    Mat<3, 3> singular;
    singular(0, 0) = 1.0;
    singular(0, 1) = 2.0;
    singular(0, 2) = 3.0;
    singular(1, 0) = 2.0;
    singular(1, 1) = 4.0;
    singular(1, 2) = 6.0;  // Row 1 = 2 * Row 0.
    singular(2, 0) = 1.0;
    singular(2, 1) = 1.0;
    singular(2, 2) = 1.0;

    Vec<3> b;
    b[0] = 1.0;
    Vec<3> x;
    EXPECT_FALSE(orbit::lu_solve(singular, b, x));

    Mat<3, 3> inv;
    EXPECT_FALSE(orbit::inverse(singular, inv));
}

TEST(MatrixOps, CholeskyKnownSpd) {
    // SPD matrix A = [[4, 2, 0], [2, 5, 1], [0, 1, 6]].
    Mat<3, 3> a;
    a(0, 0) = 4.0; a(0, 1) = 2.0; a(0, 2) = 0.0;
    a(1, 0) = 2.0; a(1, 1) = 5.0; a(1, 2) = 1.0;
    a(2, 0) = 0.0; a(2, 1) = 1.0; a(2, 2) = 6.0;

    Mat<3, 3> l;
    ASSERT_TRUE(orbit::cholesky(a, l));
    EXPECT_DOUBLE_EQ(l(0, 0), 2.0);
    EXPECT_DOUBLE_EQ(l(0, 1), 0.0);
    EXPECT_DOUBLE_EQ(l(1, 0), 1.0);
    EXPECT_DOUBLE_EQ(l(1, 1), 2.0);
    EXPECT_DOUBLE_EQ(l(2, 0), 0.0);
    EXPECT_DOUBLE_EQ(l(2, 1), 0.5);
    EXPECT_NEAR(l(2, 2), std::sqrt(23.0) / 2.0, 1e-12);

    // L L^T = A.
    auto llt = orbit::multiply(l, orbit::transpose(l));
    for (std::size_t i = 0; i < 3; ++i) {
        for (std::size_t j = 0; j < 3; ++j) {
            EXPECT_NEAR(llt(i, j), a(i, j), 1e-12);
        }
    }

    // Solve A x = b.
    Vec<3> b;
    b[0] = 1.0;
    b[1] = 2.0;
    b[2] = 3.0;
    Vec<3> x;
    orbit::cholesky_solve(l, b, x);
    Vec<3> ax = orbit::multiply(a, x);
    for (std::size_t i = 0; i < 3; ++i) {
        EXPECT_NEAR(ax[i] - b[i], 0.0, 1e-12);
    }
}

TEST(MatrixOps, CholeskyRejectsNonPd) {
    Mat<2, 2> not_pd;
    not_pd(0, 0) = 1.0;
    not_pd(0, 1) = 2.0;
    not_pd(1, 0) = 2.0;
    not_pd(1, 1) = 1.0;  // Eigenvalues 3 and -1: indefinite.

    Mat<2, 2> l;
    EXPECT_FALSE(orbit::cholesky(not_pd, l));
}

TEST(MatrixOps, LargerSizesInstantiate) {
    // 6x6, 7x7, 9x9 smoke tests (OD suite sizes).
    auto id6 = orbit::identity<6>();
    auto id6sq = orbit::multiply(id6, id6);
    EXPECT_DOUBLE_EQ(orbit::max_abs(orbit::add(id6sq, orbit::zeros<6, 6>())),
                     1.0);

    auto id7 = orbit::identity<7>();
    EXPECT_NEAR(orbit::frobenius_norm(id7), std::sqrt(7.0), 1e-12);

    Mat<9, 9> big;
    big(8, 8) = 2.0;
    EXPECT_DOUBLE_EQ(orbit::max_abs(big), 2.0);
    Vec<9> zero_b;
    Vec<9> zero_x;
    EXPECT_TRUE(orbit::lu_solve(orbit::identity<9>(), zero_b, zero_x));
}

TEST(MatrixOps, Vec3Conversions) {
    orbit::Vec3 v(1.5, -2.5, 3.5);
    auto big = orbit::vec_from_vec3<6>(v);
    EXPECT_DOUBLE_EQ(big[0], 1.5);
    EXPECT_DOUBLE_EQ(big[1], -2.5);
    EXPECT_DOUBLE_EQ(big[2], 3.5);
    EXPECT_DOUBLE_EQ(big[3], 0.0);

    orbit::Vec3 back = orbit::vec3_from_vec(big);
    EXPECT_DOUBLE_EQ(back.x, v.x);
    EXPECT_DOUBLE_EQ(back.y, v.y);
    EXPECT_DOUBLE_EQ(back.z, v.z);

    double buf[3] = {0.0, 0.0, 0.0};
    orbit::vec3_to_ptr(v, buf);
    orbit::Vec3 from_ptr = orbit::vec3_from_ptr(buf);
    EXPECT_DOUBLE_EQ(from_ptr.z, 3.5);
}
