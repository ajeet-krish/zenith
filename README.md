# Zenith Web

Interactive satellite mission planner and orbital mechanics educational tool for geocentric Earth orbits.

## Tech Stack

- **Frontend**: React 19, TypeScript, Three.js, @react-three/fiber, @react-three/drei
- **State Management**: Zustand
- **Styling**: Tailwind CSS 3
- **Build**: Vite 6
- **WASM**: Emscripten (C++ to WebAssembly) for SGP4 propagation
- **Physics**: Zenith C++ core library (header-only)

## Build Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run dev` | Start dev server |
| `npm run build` | TypeScript check + production build |
| `npm run typecheck` | TypeScript type checking only |
| `npm run test` | Run Vitest test suite |
| `npm run wasm:build` | Build WASM module (requires Emscripten) |

## Architecture

```
src/
  orbit/           # Orbital mechanics TypeScript modules
    types.ts       # Type definitions (SGP4, Lambert, TLE)
    constants.ts   # Physics constants (MU_EARTH, R_EARTH, J2)
    sampleTles.ts  # Sample TLE data for demo
    wasmLoader.ts  # WASM loader with TS fallback
  processing/      # Data processing
    tle_parser.ts  # NORAD TLE parser
  styles/          # CSS
    globals.css    # Tailwind + custom dark theme
  App.tsx          # Main app shell
  main.tsx         # React entry point

wasm/              # C++ to WASM build
  CMakeLists.txt   # Emscripten CMake config
  build.sh         # Build script
  src/
    exports.cpp    # Emscripten embind bindings
    zenith/        # C++ headers (from Zenith core)
```

## Features

- SGP4/SDP4 analytical orbit propagation
- Lambert solver for orbital transfers
- Keplerian element visualization
- TLE parsing and validation
- Multiple satellite tracking
- Conjunction assessment
- Ground track computation
