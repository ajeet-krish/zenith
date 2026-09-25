#!/bin/bash
set -e

echo "Building Zenith WASM module..."

# Find Python 3.10+ (required by Emscripten 6.x)
PYTHON=""
for candidate in python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" &> /dev/null; then
        PYTHON="$(command -v "$candidate")"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "Error: Python 3.10+ required for Emscripten. Install via: brew install python@3.14"
    exit 1
fi

# Check for Emscripten
EMSCRIPTEN_DIR="${EMSCRIPTEN_DIR:-/opt/homebrew/Cellar/emscripten/6.0.9_1/libexec}"
if [ ! -f "$EMSCRIPTEN_DIR/emcc.py" ]; then
    echo "Error: Emscripten not found at $EMSCRIPTEN_DIR"
    echo "Set EMSCRIPTEN_DIR or install emscripten via: brew install emscripten"
    exit 1
fi

echo "Using Python: $PYTHON ($($PYTHON --version))"
echo "Emscripten: $EMSCRIPTEN_DIR"

# Set up Python symlinks so em++/emcc find Python 3.10+ via env
mkdir -p /tmp/emscripten-python-bin
ln -sf "$PYTHON" /tmp/emscripten-python-bin/python3
ln -sf "$PYTHON" /tmp/emscripten-python-bin/python

# PATH must have our python3 FIRST for the entire build (cmake + make)
export PATH="/tmp/emscripten-python-bin:$PATH"

# Verify python3 is now 3.10+
echo "Active python3: $(python3 --version) at $(which python3)"

# LLVM bundled with Emscripten
LLVM_DIR="$EMSCRIPTEN_DIR/llvm"

# Create build directory
rm -rf build
mkdir -p build

# Build with Emscripten
LLVM="$LLVM_DIR" \
$PYTHON "$EMSCRIPTEN_DIR/emcmake.py" cmake -B build -DCMAKE_BUILD_TYPE=Release

# Cross-platform parallel build (PATH carries through to em++ invocations)
cmake --build build -j$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

# Copy output to public directory
mkdir -p ../public/wasm
cp build/zenith.wasm.js ../public/wasm/zenith.js
cp build/zenith.wasm.wasm ../public/wasm/zenith.wasm.wasm

echo ""
echo "WASM build complete!"
echo "Output: ../public/wasm/zenith.js"
echo "Output: ../public/wasm/zenith.wasm.wasm"
