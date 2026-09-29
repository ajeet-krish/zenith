# AGENTS.md

## Quick Commands

```bash
npm run dev          # Vite dev server at localhost:5173
npm run build        # tsc -p tsconfig.build.json --noEmit && vite build
npm run test         # vitest run (272 tests, ~1.5s)
npm run test:watch   # vitest watch mode
npm run typecheck    # tsc --noEmit
npm run wasm:build   # Requires Emscripten (brew install emscripten)
```

Run `npm run test` before committing. Run `npm run typecheck` if modifying TypeScript source.

## Architecture

React 19 + Three.js (via @react-three/fiber) frontend with a C++ WASM backend compiled via Emscripten. Uses HashRouter for GitHub Pages compatibility.

```
src/
  orbit/           # Core: wasmLoader.ts (WASM+TS fallback), analysisLoader.ts, eclipse.ts, types.ts, constants.ts
  store/           # Zustand: useMissionStore, useAnalysisStore, useCatalogStore
  components/
    scene/         # R3F 3D: OrbitScene, Earth, SatelliteMarker, GroundTrackLine, ConjunctionMarker, TransferOrbitPath
    ui/            # 2D panels: SatelliteList, TimeControls, PropagationPanel, SatelliteInfo, TLEInput, CatalogBrowser, ErrorBoundary, StatusBar
    analysis/      # Collapsible panels: ManeuverPanel, LambertPanel, GroundTrackPanel, EclipsePanel, ConjunctionPanel, PassPredictorPanel, MonteCarloPanel, CoveragePanel
  processing/      # TLE parser (tle_parser.ts), CelesTrak API client (celestrakApi.ts)
  utils/           # orbitTrail.ts, missionExport.ts, timeFormat.ts (consolidated JD formatting)
  hooks/           # useKeyboardShortcuts.ts
wasm/              # C++ to WASM build
  src/exports.cpp  # Emscripten embind bindings
  src/zenith/      # C++ header-only analysis modules
public/wasm/       # Compiled WASM output (zenith.js + zenith.wasm.wasm)
```

## Key Quirks

- **WASM loading**: `wasmLoader.ts` loads `/wasm/zenith.js` via `<script>` tag. WASM must be in `public/wasm/`. The TS fallback runs when WASM fails to load.
- **WASM handle mapping**: `sgp4Init` returns a WASM handle AND stores a TS fallback handle. `wasm_to_ts_handle` Map links them. If WASM propagation fails, the TS fallback kicks in automatically.
- **Angle units**: WASM C++ `KeplerianElements` may return degrees. `sgp4GetElements` applies defensive normalization (if value > 2*PI, convert to radians). TS fallback always returns radians.
- **Coordinate system**: Satellite positions are TEME (km). Scene uses km/1000 scale. Axis mapping: TEME x -> scene x, TEME z -> scene y (up), TEME -y -> scene z.
- **Color theme**: Dracula palette. Use `neon-*` Tailwind classes for accents (purple, cyan, green, orange, red, yellow). Backgrounds use `void`, `deep-space`, `nebula`, `card-surface`.
- **Path alias**: `@/` maps to `src/` (configured in tsconfig, vite, vitest).
- **Analysis panels**: Collapsible sections in the right sidebar. Multiple can be open simultaneously. Order: Maneuver, Lambert, Ground Track, Eclipse, Conjunction, Pass Predictor, Monte Carlo, Walker Constellation.
- **ManeuverPanel sub-tabs**: Hohmann, Plane Change, Phasing, Comparison (Hohmann vs Bi-Elliptic).
- **CelesTrak API**: `celestrakApi.ts` fetches TLE data. May return 403 for large groups (rate limiting). Error handling suggests TLE input as fallback.
- **Date formatting**: All Julian Date formatting consolidated in `utils/timeFormat.ts`. Import from there, do not create local duplicates.

## Conventions

- **TypeScript**: strict mode. `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` enabled.
- **React**: Functional components only. Zustand for state. No context providers. Class component only for ErrorBoundary (React API requirement).
- **Testing**: Vitest + jsdom + @testing-library/react. Mock `@/orbit/wasmLoader` in component tests. Pure function tests need no mocks.
- **Styling**: Tailwind CSS. Custom classes: `panel`, `panel-header`, `panel-label`, `btn-primary`, `btn-secondary`, `btn-icon`, `input-field`.
- **No em dashes** anywhere in any file.
- **4-space indent, K&R braces, snake_case locals, PascalCase types**.

## WASM Build

Requires Emscripten installed via Homebrew. The build script (`wasm/build.sh`) has a known issue: it must be run from the `wasm/` directory, and the Python path hack (`/tmp/emscripten-python-bin`) must have the correct symlinks. If `emcmake.py` fails with "python 3.10 or above" error, ensure `python3.14` is available via Homebrew.

## Test Mocking Pattern

Component tests that depend on WASM should mock the loader:

```typescript
vi.mock('@/orbit/wasmLoader', () => ({
  sgp4Init: vi.fn(() => 1),
  sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
  sgp4GetElements: vi.fn(() => ({ a: 6781, e: 0.0007, i: 0.9, raan: 3.49, argp: 0.87, ta: 5.41 })),
  sgp4Clear: vi.fn(),
  initWasm: vi.fn(async () => false),
}))
```

Reset the store in `beforeEach`:

```typescript
beforeEach(() => {
  useMissionStore.setState({ satellites: [], selectedSatelliteId: null, isPlaying: false, timeSpeed: 1 })
})
```
