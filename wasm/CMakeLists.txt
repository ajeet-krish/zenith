cmake_minimum_required(VERSION 3.20)
project(zenith_wasm)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Include path: zenith/ subdirectory sits under src/
# Headers use #include "zenith/orbit_types.hpp" etc.
include_directories(${CMAKE_SOURCE_DIR}/src)

# Single compilation unit: exports.cpp includes all Zenith headers inline.
# All Zenith headers are header-only with inline implementations.
add_executable(zenith.wasm
    src/exports.cpp
)

# Emscripten link flags for embind
# -s flags must go through target_link_options (not target_link_libraries)
target_link_options(zenith.wasm PRIVATE
    "SHELL:-s WASM=1"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_NAME=ZenithWasm"
    "SHELL:-s NO_EXIT_RUNTIME=1"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=[\"ccall\",\"cwrap\"]"
    "--bind"
)
