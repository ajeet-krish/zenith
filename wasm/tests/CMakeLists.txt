# Standalone native test target for the zenith-web C++ headers.
# Configured with the system compiler (NO Emscripten); wasm/build.sh only
# configures the parent wasm/CMakeLists.txt so the two never interfere.
#
# Usage:
#   cmake -S wasm/tests -B build-native-tests
#   cmake --build build-native-tests -j
#   ctest --test-dir build-native-tests --output-on-failure
# or: npm run test:native

cmake_minimum_required(VERSION 3.20)
project(zenith_native_tests CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# GoogleTest v1.15.2 via FetchContent (repo-wide convention; no vendoring).
include(FetchContent)
set(BUILD_GMOCK OFF CACHE BOOL "" FORCE)
set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.15.2.zip
    URL_HASH SHA256=f179ec217f9b3b3f3c6e8b02d3e7eda997b49e4ce26d6b235c9053bec9c0bf9f
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(googletest)

# nlohmann/json v3.11.3 single-header library via FetchContent (same
# no-vendoring convention as googletest; tests/install disabled).
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
set(JSON_Install OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    nlohmann_json
    URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
    URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(nlohmann_json)

enable_testing()

add_executable(ZenithTests
    test_matrix_ops.cpp
    test_force_jacobians.cpp
    test_integrators_od.cpp
    test_stations.cpp
    test_observations.cpp
    test_iod_gauss.cpp
    test_od_batch.cpp
    test_od_fixtures.cpp
)

# Headers live under wasm/src and are included as "zenith/xxx.hpp".
target_include_directories(ZenithTests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../src)
target_link_libraries(ZenithTests PRIVATE GTest::gtest_main nlohmann_json::nlohmann_json)

# Absolute path to the golden-master fixture directory (native-only; the
# compiled WASM never ships fixtures).
get_filename_component(FIXTURES_OD_DIR
    ${CMAKE_CURRENT_SOURCE_DIR}/../../fixtures/od ABSOLUTE)
target_compile_definitions(ZenithTests PRIVATE
    FIXTURES_DIR="${FIXTURES_OD_DIR}")

include(GoogleTest)
gtest_discover_tests(ZenithTests)
