# AGENTS.md

## Quick Commands

```bash
npm run dev          # Vite dev server at localhost:5173
npm run build        # tsc -p tsconfig.build.json --noEmit && vite build
npm run test         # vitest run (639 tests, ~3s)
npm run test:watch   # vitest watch mode
npm run test:native  # Native C++ GoogleTest (115 tests, needs cmake)
npm run bench:od     # Native OD perf benchmark (Release build, prints timings)
npm run typecheck    # tsc --noEmit (44 pre-existing errors, baseline)
npm run wasm:build   # Requires Emscripten (brew install emscripten)
```

Run `npm run test` before committing. Run `npm run typecheck` if modifying TypeScript source. For architecture depth (WASM layer, OD subsystem, fixture pipeline), read [docs/architecture.md](docs/architecture.md); this file is the working briefing, that document is the reference.

## Project Summary

Zenith is a browser-based satellite mission planner and orbital mechanics educational tool, positioned as a portfolio piece that demonstrates a production-grade physics engine in an unconventional runtime. It is pure client-side (deploys to GitHub Pages, HashRouter, no server): React 19 + Three.js (via @react-three/fiber) frontend with a C++20 header-only engine compiled to WebAssembly via Emscripten. Capabilities span SGP4/SDP4 propagation, real TLE ingestion with catalog browsing, maneuver planning (Hohmann, plane change, phasing, bi-elliptic comparison), Lambert solving, ground tracks, eclipse analysis, conjunction screening, pass prediction, Monte Carlo uncertainty, Walker constellation design, and a full angles-only orbit determination pipeline.

The OD pipeline is a six-phase port of the Helio (helio_ob) Python toolkit, which is archived locally as the `v1.0-reference-oracle` tag (git rev `bdc9ba7`). The port prioritizes numerical parity with that reference over algorithmic novelty: 27 golden-master fixtures exported from Helio pin the behavior of every OD kernel, replayed by both the native C++ suite and vitest schema tests. Perf on an Apple M5: Gauss IOD 0.3 ms, batch LSQ with 300 observations 14 ms native / 39 ms WASM, EKF 225 steps 0.3 ms native / 1.1 ms WASM.

## Architecture Map

```
src/
  orbit/           # Core: wasmLoader.ts (WASM+TS fallback), analysisLoader.ts, eclipse.ts, types.ts, constants.ts
                   # OD: iodGauss.ts, odBatch.ts, odEkf.ts, observations.ts, stations.ts, propagateStm.ts,
                   #     covarianceUtils.ts, observationImport.ts, odConstants.ts (TS mirrors of the C++ kernels)
  store/           # Zustand: useMissionStore, useAnalysisStore, useCatalogStore, useODStore
  components/
    scene/         # R3F 3D: OrbitScene, Earth, SatelliteMarker, GroundTrackLine, ConjunctionMarker, TransferOrbitPath,
                   #        OdTrajectoryOverlay, CovarianceEllipsoid, GroundStationMarkers, ObservationLosRays
    ui/            # 2D panels: SatelliteList, TimeControls, PropagationPanel, SatelliteInfo, TLEInput, CatalogBrowser,
                   #            ErrorBoundary, StatusBar, ResidualPlot, CovariancePlot, NisPlot, ResizeHandle, Starfield
    analysis/      # Collapsible panels: ManeuverPanel, LambertPanel, GroundTrackPanel, EclipsePanel, ConjunctionPanel,
                   #                   PassPredictorPanel, MonteCarloPanel, CoveragePanel,
                   #                   ObservationPanel, IodPanel, BatchPanel, EkfPanel
  pages/           # TheoryPage (KaTeX orbital mechanics guide, /guide route)
  processing/      # TLE parser (tle_parser.ts), CelesTrak API client (celestrakApi.ts)
  utils/           # orbitTrail.ts, missionExport.ts, timeFormat.ts (consolidated JD formatting)
  hooks/           # useKeyboardShortcuts.ts
wasm/              # C++ to WASM build
  src/exports.cpp  # Emscripten embind bindings (27 exports; flat-array layout comments)
  src/zenith/      # 22 header-only C++ modules
                   # OD: iod_gauss.hpp, od_batch.hpp, od_ekf.hpp, stations.hpp, observations.hpp,
                   #     partials.hpp, matrix_ops.hpp, od_constants.hpp, integrators.hpp, force_models.hpp
                   # Other: sgp4_parser/propagator, kepler, time_system, coordinate_frames, maneuver,
                   #        ground_track, monte_carlo, coverage, pass_predictor, conjunction, orbit_types
  tests/           # Native GoogleTest suite (test_od_*.cpp) + bench_od.cpp perf benchmark
fixtures/od/       # 27 golden-master JSON cases (index.json manifest)
public/wasm/       # Compiled WASM output (zenith.js + zenith.wasm.wasm, tracked in git)
scripts/           # export_od_fixtures.py (Helio -> fixtures/od export)
```

## Module Inventory Quick Table

| Area | Key files | Role |
|------|-----------|------|
| WASM loading | `src/orbit/wasmLoader.ts` | Script-tag load of `/wasm/zenith.js`; TS Keplerian fallback; `wasm_to_ts_handle` mapping |
| Analysis wrappers | `src/orbit/analysisLoader.ts` | Hohmann/plane-change/phasing/bi-elliptic, ground track, Monte Carlo, Walker (WASM with TS fallback) |
| OD wrappers | `src/orbit/iodGauss.ts`, `odBatch.ts`, `odEkf.ts`, `stations.ts`, `observations.ts` | Flat-array codecs + TS mirror kernels for the OD pipeline |
| OD import | `src/orbit/observationImport.ts` | CSV/JSON observation parsing (station defs embedded in JSON) |
| Covariance viz math | `src/orbit/covarianceUtils.ts` | 3x3 Jacobi eigen decomposition, 3-sigma ellipsoid axes |
| STM propagation | `src/orbit/propagateStm.ts` | TS wrapper for 42-dim STM propagation (two-body/J2 tiers) |
| Stores | `useMissionStore`, `useAnalysisStore`, `useCatalogStore`, `useODStore` | See responsibilities table below |
| OD panels | `ObservationPanel`, `IodPanel`, `BatchPanel`, `EkfPanel` | Right sidebar workflow (stations/import, Gauss IOD, batch LSQ, EKF) |
| OD scene | `OdTrajectoryOverlay`, `CovarianceEllipsoid`, `GroundStationMarkers`, `ObservationLosRays` | TEME-mapped 3D overlays, toggled from ObservationPanel |
| OD plots | `ResidualPlot`, `CovariancePlot`, `NisPlot` (in `components/ui/`) | Post-fit residuals, sigma history, NIS vs gate |
| OD kernels (C++) | `wasm/src/zenith/od_batch.hpp`, `od_ekf.hpp`, `iod_gauss.hpp` | Helio-parity solvers; do not alter without fixture regeneration |
| Fixtures | `fixtures/od/` + `scripts/export_od_fixtures.py` + `wasm/tests/test_od_fixtures.cpp` | Golden-master validation chain |

### Store responsibilities

| Store | Owns |
|-------|------|
| `useMissionStore` | Satellites, SGP4 handles, simulation time, playback, propagation method/force models, WASM readiness |
| `useAnalysisStore` | Per-tool results and state for maneuver/Lambert/ground track/eclipse/conjunction/pass predictor/Monte Carlo/Walker |
| `useCatalogStore` | CelesTrak catalog cache, search/filter state |
| `useODStore` | Ground stations (owning WASM handles), observations, sim config, IOD/batch/EKF results, OD scene toggles, scheduled maneuvers |

## OD Subsystem Rules

- **Golden-master parity**: the C++ solvers reproduce Helio (helio_ob) outputs to full double precision. Do not "improve" an algorithm (convergence criteria, editing thresholds, integrators) versus the reference without regenerating fixtures from the updated Helio. A parity break that is not an intentional, fixture-regenerating change is a bug.
- **Helio is read-only**: `../helio_ob` is the oracle. Changes flow one way: change Helio upstream, regenerate fixtures, then port to C++. The fixture manifest (`fixtures/od/index.json`) pins the exact reference git rev (`bdc9ba7`).
- **Fixture regeneration**: `uv run --with numpy scripts/export_od_fixtures.py` (or Helio's venv; options `--helio-path`, `--out`). Never hand-edit fixture JSON. New cases need a `case_id` dispatch entry in `wasm/tests/test_od_fixtures.cpp` and, for new payload shapes, an update to `src/orbit/__tests__/od_fixtures.test.ts`.
- **Flat-array boundary**: OD kernels cross WASM as flat double arrays. The obs table is `9 + 2*ndim` doubles per record (header: time_jd, sta_pos_eci x3, sta_vel_eci x3, obs_type, ndim; then values and sigmas). Batch uses `config10` and a 56-double result header; EKF uses `config16` and a 60-double result header; scheduled burns are 4 doubles each. Full layouts are documented in comment blocks in `wasm/src/exports.cpp` (search "WASM flat-array layouts"). These layouts are a contract shared by C++ serializers, TS codecs (`odBatch.ts`/`odEkf.ts`), and fixtures: change all in lockstep.
- **Station geometry is pre-resolved**: solvers receive station ECI position/velocity baked into each obs record via `od_station_position_eci`/`od_station_velocity_eci`. There are no station handles inside `od_batch_solve`/`od_ekf_solve`.
- **Scalar residual rows**: RA/Dec observations expand to two scalar rows (companion component in the off slot); results report both `n_obs` and `n_rows`.

## Build, Test, and Typecheck Matrix

| Command | Toolchain | Scope | Notes |
|---------|-----------|-------|-------|
| `npm run test` | Vitest + jsdom | 639 TS tests (wrappers, stores, panels, fixtures schema) | Run before every commit |
| `npm run test:native` | cmake + ctest + GoogleTest | 115 C++ tests incl. all 27 golden-master fixtures | Host compiler, no Emscripten needed |
| `npm run bench:od` | cmake Release | `wasm/tests/bench_od.cpp` timings | M5 reference: IOD 0.3 ms, batch 300 obs 14 ms native, EKF 225 steps 0.3 ms native |
| `npm run build` | tsc (build config) + Vite | Production bundle | The clean gate: excludes tests, must pass |
| `npm run typecheck` | tsc (full project) | Everything incl. tests | 44 pre-existing errors in test files is the accepted baseline; source files must stay clean |
| `npm run wasm:build` | Emscripten (Homebrew) | C++ -> `public/wasm/zenith.js` + `zenith.wasm.wasm` | `build.sh` auto-discovers newest emsdk under `/opt/homebrew/Cellar/emscripten/` (`EMSCRIPTEN_DIR` override); symlinks Python 3.10+ into `/tmp/emscripten-python-bin` for emcc. On "python 3.10 or above" errors, ensure `python3.14` exists via Homebrew |

WASM artifacts in `public/wasm/` are tracked in git. After any C++ change: `npm run wasm:build`, then commit the regenerated artifacts alongside the source change, or the deployed app drifts from source.

## Conventions

- **Indentation (actual practice)**: C++ is 4-space with K&R braces; TS/TSX is 2-space (this supersedes older notes claiming 4-space everywhere).
- **Naming**: snake_case locals/functions in C++, camelCase in TS, PascalCase types and components.
- **No em dashes** anywhere in any file, including docs and comments.
- **TypeScript**: strict mode with `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`. Path alias `@/` maps to `src/`.
- **React**: functional components only, Zustand for state, no context providers. The only class component is ErrorBoundary (React API requirement).
- **Styling**: Tailwind with the Dracula palette. Accents via `neon-*` classes (purple, cyan, green, orange, red, yellow); backgrounds `void`, `deep-space`, `nebula`, `card-surface`. Shared component classes: `panel`, `panel-header`, `panel-label`, `btn-primary`, `btn-secondary`, `btn-icon`, `input-field`.
- **Testing**: mock `@/orbit/wasmLoader` in component tests that touch WASM; pure function tests need no mocks. Reset stores in `beforeEach` (pattern below).
- **Date formatting**: all Julian Date formatting goes through `utils/timeFormat.ts`; do not create local duplicates.

## Panel and Store Inventories

Right sidebar analysis panel order (fixed in `AnalysisPanel.tsx`): Maneuver, Lambert, Ground Track, Eclipse, Conjunction, Pass Predictor, Monte Carlo, Walker Constellation, Observations, Gauss IOD, Batch OD, EKF OD. Multiple panels can be open at once. ManeuverPanel has sub-tabs: Hohmann, Plane Change, Phasing, Comparison.

The four OD panels form the workflow: Observations (stations + import + scene toggles), Gauss IOD (angles-only initial orbit), Batch OD (least-squares refinement), EKF OD (sequential tracking). The pipeline estimates one satellite at a time.

## Common Pitfalls

- **TEME-to-scene mapping**: TEME x -> scene x, TEME z -> scene y (up), TEME -y -> scene z, at km/1000 scale. This applies to covariance ellipsoid orientations and trajectory overlays too, not just satellite positions. Reuse the mapping; never improvise an axis swap.
- **Typecheck baseline**: `npm run typecheck` shows 44 pre-existing errors, all in test files. The build gate (`tsconfig.build.json`) excludes tests and is clean. Do not treat the 44 as regressions, and do not add new ones in source.
- **WASM artifacts tracked**: forgetting to rebuild and commit `public/wasm/` after C++ changes leaves the deployed app running stale physics.
- **Station handle lifecycle**: `useODStore.addStation`/`removeStation`/`clearAll` own WASM station handles. Observation import must merge stations by name and remap ids through the store; never create orphan station handles in panels.
- **Angle units**: WASM `KeplerianElements` may return degrees; `sgp4GetElements` defensively normalizes (values above 2*PI convert to radians). TS fallback always returns radians.
- **WASM handle fallback**: `sgp4Init` allocates both a WASM and TS handle linked by `wasm_to_ts_handle`; if WASM propagation fails mid-flight, the TS fallback engages automatically. Do not bypass the loader and call the WASM module directly from components.
- **dateToJd/UTC handling**: OD epochs are Julian Dates in UTC; the OD frame model uses GMST with UT1 approximated by UTC (no dut1, precession, nutation, or polar motion), matching the Helio reference. Do not "fix" this by adding frame corrections; it would break golden-master parity.
- **CelesTrak 403s**: large catalog groups can be rate-limited; error handling already suggests manual TLE input as fallback.

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
