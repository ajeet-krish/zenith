#!/bin/bash
set -e

echo "Building Zenith WASM module..."

# Find Python 3.10+ (required by Emscripten 6.x)
PYTHON=""
for candidate in python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" &> /dev/null; then
        PYTHON="$candidate"
        break
    fi
done

# Check for Emscripten
EMSCRIPTEN_DIR="${EMSCRIPTEN_DIR:-/opt/homebrew/Cellar/emscripten/6.0.9_1/libexec}"
if [ ! -f "$EMSCRIPTEN_DIR/emcc.py" ]; then
    echo "Error: Emscripten not found at $EMSCRIPTEN_DIR"
    echo "Set EMSCRIPTEN_DIR or install emscripten via: brew install emscripten"
    exit 1
fi

if [ -z "$PYTHON" ]; then
    echo "Error: Python 3.10+ required for Emscripten. Install via: brew install python@3.14"
    exit 1
fi

echo "Using Python: $PYTHON ($(which $PYTHON))"
echo "Emscripten: $EMSCRIPTEN_DIR"

# LLVM bundled with Emscripten (has WASM backend)
LLVM_DIR="$EMSCRIPTEN_DIR/llvm"

# Create build directory
rm -rf build
mkdir -p build

# Build with Emscripten
PATH="/tmp/emscripten-python-bin:$PATH" \
LLVM="$LLVM_DIR" \
$PYTHON "$EMSCRIPTEN_DIR/emcmake.py" cmake -B build -DCMAKE_BUILD_TYPE=Release

# Cross-platform parallel build
cmake --build build -j$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

# Copy output to public directory
# Emscripten names output <target>.js and <target>.wasm, but we need:
#   zenith.js        (JS glue, loaded via <script> tag)
#   zenith.wasm.wasm (WASM binary, loaded by JS glue)
mkdir -p ../public/wasm
cp build/zenith.wasm.js ../public/wasm/zenith.js
cp build/zenith.wasm.wasm ../public/wasm/zenith.wasm.wasm

echo ""
echo "WASM build complete!"
echo "Output: ../public/wasm/zenith.js"
echo "Output: ../public/wasm/zenith.wasm.wasm"
