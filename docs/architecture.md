# Zenith Architecture

This document describes how Zenith is put together: the React frontend, the C++ WebAssembly engine, the orbit determination subsystem, and the validation infrastructure that keeps the port honest against its Python reference. For agent-facing conventions and quick commands, see [AGENTS.md](../AGENTS.md).

## 1. System Overview

Zenith is a pure client-side satellite mission planner. There is no backend server: all computation happens in the browser, either in TypeScript or in a C++ engine compiled to WebAssembly. The frontend is React 19 with Three.js rendering (via @react-three/fiber), state flows through four Zustand stores, and the heavy orbital mechanics (SGP4, Lambert, conjunction screening, Monte Carlo, and the full orbit determination pipeline) live in 22 header-only C++ modules exposed through 27 embind exports. The app deploys to GitHub Pages behind a HashRouter, which is why every route lives under `#/`.

```
+--------------------------- Browser (GitHub Pages) ---------------------------+
|                                                                               |
|  React 19 UI                                                                  |
|  +----------------+   +---------------------+   +--------------------------+   |
|  | Left sidebar   |   | OrbitScene (R3F)    |   | Right sidebar            |   |
|  | SatelliteList  |   | Earth, markers,     |   | AnalysisPanel            |   |
|  | TLEInput       |   | orbit paths, OD     |   | 12 collapsible tool      |   |
|  | CatalogBrowser |   | overlays            |   | panels (maneuver..EKF)   |   |
|  +-------+--------+   +----------+----------+   +-------------+------------+   |
|          |                       |                            |                |
|          +-----------+-----------+------------+----------------+              |
|                      |  Zustand stores (mission/analysis/catalog/od)          |
|                      +----------------+---------------------------------------+   |
|                                       |                                       |
|                  +--------------------+--------------------+                  |
|                  v                                         v                  |
|   TypeScript orbit layer (src/orbit/)          WASM loader (wasmLoader.ts)   |
|   TS fallbacks + flat-array codecs             script-tag load of            |
|                                                public/wasm/zenith.js         |
|                                                             |                |
|                                                             v                |
|                                       C++ engine (Emscripten embind,         |
|                                       27 exports over 22 headers)            |
+-------------------------------------------------------------------------------+
```

## 2. Frontend Architecture

### React tree

`App.tsx` sets up the HashRouter, a shared header (logo, Orbit/Guide nav, Export button), and an ErrorBoundary around two routes: the main `OrbitToolPage` and a static `TheoryPage` (KaTeX-rendered orbital mechanics guide). `OrbitToolPage` composes the three-panel layout:

```
OrbitToolPage
  +-- Left sidebar: SatelliteList (opens TLEInput / CatalogBrowser modals)
  +-- ResizeHandle
  +-- Main column
  |     +-- PropagationPanel, TimeControls, StatusBar (pinned top)
  |     +-- OrbitScene (R3F Canvas, fills remaining space)
  +-- ResizeHandle
  +-- Right sidebar: AnalysisPanel (12 collapsible sections)
```

Both sidebars are resizable between fixed min/max widths. Analysis panels are independent collapsible sections; multiple can be open at once, and their order is fixed (see section 8).

### Zustand stores

| Store | Owns | Key actions |
|-------|------|-------------|
| `useMissionStore` | Satellites, SGP4 handles, simulation time, playback, propagation settings, WASM readiness | add/remove satellite, tick time, set propagation method/force models |
| `useAnalysisStore` | Per-tool results and transient UI state (Hohmann, Lambert, ground track, eclipse, conjunction, pass predictor, Monte Carlo, Walker) | compute and clear results per tool |
| `useCatalogStore` | CelesTrak catalog cache, search/filter state for the CatalogBrowser modal | fetch catalog groups, search, add TLEs |
| `useODStore` | Ground stations (owning WASM handles), observations, simulator config, Gauss/batch/EKF results, OD scene toggles, scheduled maneuvers | add/remove station, import/simulate observations, runIod/runBatch/runEkf, scene toggles |

The OD store deliberately owns station WASM handle lifecycle in `addStation`/`removeStation`/`clearAll`; there is no `importObservations` action, because the importing panel merges station definitions by name and remaps station ids before calling `setObservations`.

### Routing and theming

HashRouter keeps GitHub Pages happy without server-side rewrite rules. The theme is Dracula, expressed as Tailwind classes: `neon-*` accents (purple, cyan, green, orange, red, yellow), `void`/`deep-space`/`nebula`/`card-surface` backgrounds, and shared component classes (`panel`, `panel-header`, `btn-primary`, `btn-secondary`, `btn-icon`, `input-field`).

## 3. WASM Layer

### Build pipeline

`wasm/build.sh` (run via `npm run wasm:build`) requires Emscripten (Homebrew). It auto-discovers the newest installed emsdk under `/opt/homebrew/Cellar/emscripten/` (override with `EMSCRIPTEN_DIR`), finds a Python 3.10+ interpreter and symlinks it into `/tmp/emscripten-python-bin` so em++/emcc resolve it, then runs `emcmake cmake` + a parallel `cmake --build`. Output artifacts `zenith.wasm.js` and `zenith.wasm.wasm` are copied to `public/wasm/` as `zenith.js` and `zenith.wasm.wasm`. The WASM artifacts are tracked in git: after changing any C++ under `wasm/src/`, rebuild and commit the regenerated artifacts.

`wasm/CMakeLists.txt` builds a single `zenith` executable target (JS glue + WASM binary). `wasm/tests/CMakeLists.txt` is a separate CMake project for the native GoogleTest suite and the `bench_od` benchmark; it compiles the same headers with the host compiler, no Emscripten needed.

### Header-only module inventory

All physics and estimation code lives in `wasm/src/zenith/*.hpp` (22 headers, no .cpp files besides the embind bindings in `wasm/src/exports.cpp`):

| Module | Purpose |
|--------|---------|
| `orbit_types.hpp` | Shared structs: Vec3, StateVector, KeplerianElements, TLEData |
| `time_system.hpp` | Julian Date conversions, GMST (UT1 approximated by UTC) |
| `coordinate_frames.hpp` | TEME/ECEF/geodetic transforms, LLA to ECEF (WGS-84) |
| `kepler.hpp` | Kepler equation solver, mean/eccentric anomaly conversions |
| `sgp4_parser.hpp` | TLE line parsing into TLEData with checksum handling |
| `sgp4_propagator.hpp` | Full SGP4/SDP4 propagation |
| `force_models.hpp` | J2, drag, and SRP accelerations plus analytic Jacobians |
| `integrators.hpp` | RK4 and DOP853 integrators, STM propagation (42-dim augmented state) |
| `maneuver.hpp` | Hohmann, plane change, phasing, bi-elliptic comparison |
| `ground_track.hpp` | Sub-satellite point computation with anti-meridian handling |
| `monte_carlo.hpp` | Gaussian sampling, sample propagation, ellipsoid statistics |
| `coverage.hpp` | Walker Delta constellation generation |
| `pass_predictor.hpp` | Elevation-mask pass windows with AOS/LOS |
| `conjunction.hpp` | Pairwise screening, miss distance, risk classification |
| `stations.hpp` | OD ground station model (GMST-only ECI frames), canonical stations |
| `observations.hpp` | Measurement prediction, seeded observation simulator |
| `partials.hpp` | Measurement partial derivatives (range, range-rate, RA/Dec) |
| `iod_gauss.hpp` | Gauss angles-only IOD + Herrick-Gibbs velocity estimation |
| `od_batch.hpp` | Batch least-squares OD solver (Helio port) |
| `od_ekf.hpp` | Sequential EKF OD with NIS gating and maneuver detection (Helio port) |
| `matrix_ops.hpp` | Small dense matrix ops: inverse, SPD checks, symmetric eigen |
| `od_constants.hpp` | Shared OD constants, obs-type enums, status codes |

### Embind export conventions

`wasm/src/exports.cpp` exposes 27 functions via embind. Two patterns cover everything:

- **Handle pattern** (SGP4, ground stations): `sgp4_init`/`od_station_create` parse input and return an integer handle (>= 1; 0 = error). State lives in module-level `std::map` stores (`g_propagators`, `g_od_stations`). Subsequent calls (`sgp4_propagate`, `od_station_position_eci`) take the handle, look up state, and return plain JS objects or flat arrays. The caller is responsible for calling `sgp4_clear`/station destroy functions; handles leak otherwise.

- **Flat-array pattern** (OD solvers and most analysis kernels): complex records cross the boundary as `Float64Array`-shaped flat arrays with fixed layouts documented in comment blocks in `exports.cpp` (search for "WASM flat-array layouts"). The important OD layouts:

  - **Observation table** (batch and EKF): N records of `[time_jd(1), sta_pos_eci(3), sta_vel_eci(3), obs_type(1), ndim(1), values(ndim), sigmas(ndim)]`, i.e. `9 + 2*ndim` doubles per record. `obs_type`: 0=RANGE, 1=RANGE_RATE, 2=RA_DEC. Station ECI geometry is pre-resolved by the caller via `od_station_position_eci`/`od_station_velocity_eci` at each epoch; the solvers are pure compute kernels with no station handles inside.
  - **Batch config10**: `{mu, force_tier, max_iter, tol_pos_km, tol_vel_kms, tol_wrms_rel, sigma_edit, edit_max_fraction, edit_max_rounds, enable_editing}`. Short arrays apply partially over defaults; empty means all defaults. Optional `apriori42` = `{x0(6), cov(36 row-major)}`.
  - **Batch result**: 56-double header (`state(6), cov(36), formal_sigmas(6), iterations, converged, wrms, reduced_chi2, edited_count, n_active, status, n_residual_rows`) followed by N x 14 residual rows.
  - **EKF config16**: `{q_a, q_a_maneuver, estimate_maneuver, nis_sigma_threshold, consecutive_exceedances, reentry_window_obs, scheduled_inflate_kms, sustained_nis_count, inflate_factor, p0_diag(6), force_tier}`. Scheduled burns pass separately as 4 doubles each `{epoch_jd, dv(3)}`.
  - **EKF result**: 60-double header (error, counts, NIS stats, final state, final covariance) followed by payload arrays (state history, sigma history, innovations, NIS, updated mask, maneuver records).

The TS wrappers in `src/orbit/odBatch.ts` and `src/orbit/odEkf.ts` own the pack/unpack codecs; panels never touch raw arrays.

### Loading and TS fallback

`src/orbit/wasmLoader.ts` injects `/wasm/zenith.js` via a `<script>` tag (the Emscripten glue is not an ES module import), then instantiates the global `ZenithWasm` factory and wires the module into `analysisLoader.ts`. If loading or instantiation fails, `initWasm` resolves false, the UI flags TS-fallback mode, and TS implementations take over: a simplified Keplerian propagator for SGP4, TS analysis functions for maneuvers/ground tracks, and TS OD kernels that mirror the C++ algorithms for stations, observations, and the solvers. `sgp4Init` always allocates a TS handle and records the mapping in `wasm_to_ts_handle`, so per-satellite WASM failures degrade transparently.

## 4. Orbit Determination Subsystem

The OD pipeline is a six-phase port of the Helio (helio_ob) Python toolkit, tagged upstream as `v1.0-reference-oracle` (git rev `bdc9ba7`). The design goal is numerical parity with the reference, not algorithmic novelty.

### Pipeline dataflow

```
Observations (CSV/JSON import, seeded simulator, or "Simulate From Truth")
    |
    v
Gauss angles-only IOD (iod_gauss.hpp)
    three RA/Dec pairs -> slant ranges (Herrick-Gibbs) -> initial state6
    |
    v
Initial guess (or TLE-derived state, or user entry)
    |
    +--> Batch least squares (od_batch.hpp)
    |      Gauss-Newton iteration, optional a-priori constraint,
    |      3-sigma editing rounds with warm restarts -> state + covariance
    |
    +--> Sequential EKF (od_ekf.hpp)
           per-observation update, NIS gating, 9D maneuver augmentation,
           scheduled burns, divergence recovery -> filtered path + sigmas
    |
    v
Results (flat-array decoded to TS objects in odBatch.ts / odEkf.ts)
    +--> useODStore -> OdTrajectoryOverlay, CovarianceEllipsoid,
    |                  ResidualPlot, CovariancePlot, NisPlot
    +--> StatusBar solve chips (OBS/STA counts)
```

### Module map

| Stage | C++ module | TS wrapper | Notes |
|-------|-----------|------------|-------|
| Station geometry | `stations.hpp` | `stations.ts` | GMST-only ECI; Earth-rotation velocity term for range-rate |
| Measurement model | `observations.hpp`, `partials.hpp` | `observations.ts` | Prediction and analytic partials; no light-time iteration |
| IOD | `iod_gauss.hpp` | `iodGauss.ts` | Double-ratio Gauss method; conditioning diagnostics |
| Batch solver | `od_batch.hpp` | `odBatch.ts` | Scalar residual rows; formal covariance from normal equations |
| EKF | `od_ekf.hpp` | `odEkf.ts` | Joseph-form covariance update; NIS-gated accept/reject |
| STM / force Jacobians | `integrators.hpp`, `force_models.hpp` | `propagateStm.ts` | DOP853 with 42-dim augmented state; two-body or J2 tiers |
| Linear algebra | `matrix_ops.hpp` | (WASM-only) | Inverse, SPD validation, symmetric eigen for ellipsoids |

### Estimation conventions

- **Scalar residual rows**: a RA/Dec observation produces two scalar residual rows (RA and Dec), each carrying its companion component in the off slot. Range and range-rate produce one row each. Batch and EKF results report both `n_obs` (vector records) and `n_rows` (scalar rows).
- **Joseph-form EKF update**: covariance updates use `P = (I - K h^T) P (I - K h^T)^T + K sigma^2 K^T` to preserve symmetry and positive semidefiniteness under finite precision.
- **NIS gating**: each scalar row's normalized innovation squared is compared against a sigma threshold. A streak of consecutive exceedances triggers maneuver-mode augmentation (estimate an unmodeled velocity change in a 9D state); a sustained streak triggers divergence recovery (whole-matrix covariance inflation, chosen over diagonal inflation because diagonal inflation alone fails when P has collapsed and NIS scales only with the inflated entries).
- **Golden-master parity rule**: the C++ solvers must reproduce Helio outputs to full double precision (the exporter round-trips floats through 17 significant digits). Do not "improve" an algorithm (different convergence criterion, different editing threshold, a better integrator) without regenerating the fixtures from the updated reference; a parity break that is not an intentional, fixture-regenerating change is a bug.

### Fixture validation architecture

Golden-master fixtures live in `fixtures/od/` (27 JSON cases plus an `index.json` manifest that pins the Helio git rev and generation timestamp). They are produced by `scripts/export_od_fixtures.py`, which imports the Helio package from `../helio_ob` (treated as a read-only oracle) and emits one JSON file per case: inputs, expected outputs, and provenance.

```
helio_ob (Python, read-only)
    |  scripts/export_od_fixtures.py
    v
fixtures/od/*.json + index.json (committed)
    |                       |
    v                       v
wasm/tests/test_od_fixtures.cpp          src/orbit/__tests__/od_fixtures.test.ts
(native GTest, dispatch by case_id,      (vitest, validates TS mirror outputs
 full numerical comparison)               and schema compatibility)
```

Cases cover Kepler solving, J2 STM propagation, force Jacobians, measurement partials, station ECI geometry, GMST, observation prediction, Gauss IOD (LEO/MEO/GEO, 1-3 stations, noisy seed 42), Herrick-Gibbs, batch least-squares (noise-free, noisy, editing, a-priori, J2 truth, IOD refinement), and EKF (noise-free, noisy, gaps, outlier gating, scheduled maneuvers, maneuver detection, forced contraction, divergence recovery). To regenerate: check out the desired `helio_ob` revision and rerun the exporter; never hand-edit fixture JSON.

## 5. Visualization

### Scene components

`OrbitScene.tsx` mounts the R3F Canvas and composes: `Earth` (textured sphere), `SatelliteMarker` (category-colored cubesats with labels), `OrbitPath` (trails from `orbitTrail.ts`), `GroundTrackLine`, `TransferOrbitPath` (dashed Hohmann ellipse), `ConjunctionMarker`, `CameraController` (orbit camera with fly-to animation), and the OD overlays: `OdTrajectoryOverlay`, `CovarianceEllipsoid`, `GroundStationMarkers`, `ObservationLosRays`.

### TEME-to-scene coordinate mapping

Satellite and OD states are TEME coordinates in km. The scene renders at km/1000 scale (so 6781 km becomes scene radius 6.781) with this axis mapping, which is THE quirk of the codebase:

```
TEME x  -> scene x
TEME z  -> scene y  (up, polar axis)
TEME -y -> scene z
```

The same mapping applies to covariance ellipsoid orientations and trajectory overlays: `CovarianceEllipsoid` and `OdTrajectoryOverlay` rotate their geometries with the identical transform, so a covariance ellipse that looks tilted on screen is tilted correctly in TEME. Any new OD-derived 3D object must reuse this mapping, not an ad-hoc axis swap.

## 6. Data Flow

### TLE ingestion

TLE text enters through three paths: the `TLEInput` modal (paste with NORAD checksum validation), the `CatalogBrowser` (CelesTrak API client in `src/processing/celestrakApi.ts`, with 403 rate-limit handling that suggests manual TLE entry as fallback), and the built-in sample catalog (`sampleTles.ts`). Parsed TLEs feed `sgp4Init`, which allocates both a WASM and TS handle.

### Observation import

`src/orbit/observationImport.ts` parses CSV (header `epoch_jd,station,obs_type,value1,value2,sigma1,sigma2`) and JSON (observations array plus optional embedded station definitions). Unknown station names in a file are added to the station list automatically. The importing panel remaps station names to store ids before calling `setObservations`, keeping WASM handle ownership inside the store.

### Mission export/import

`src/utils/missionExport.ts` serializes the mission store (satellites, TLEs, time settings) to JSON for download and reimport, driven by the header Export button.

## 7. Testing Strategy

Three tiers cover different risk:

| Tier | Runner | Scope | Command |
|------|--------|-------|---------|
| Native kernel | GoogleTest (cmake + ctest) | Pure C++ math and solvers, golden-master fixture replay | `npm run test:native` |
| TS wrappers + panels | Vitest + jsdom + testing-library | Flat-array codecs, store logic, panel flows, WASM loader fallback | `npm run test` |
| Golden-master fixtures | Both suites | Numerical parity with Helio across 27 cases | included in both |

Component tests that depend on WASM mock `@/orbit/wasmLoader` (see AGENTS.md for the pattern); pure function tests need no mocks. The performance benchmark (`npm run bench:od`, `wasm/tests/bench_od.cpp`) builds in Release and prints timings for Gauss IOD, batch (300 obs), and EKF (225 steps) on native and WASM paths.

**Adding a fixture**: extend `scripts/export_od_fixtures.py` with a case (inputs + expected outputs from Helio), rerun the exporter, add a `case_id` dispatch entry in `wasm/tests/test_od_fixtures.cpp`, and extend the schema test in `src/orbit/__tests__/od_fixtures.test.ts` if the payload shape is new.

**Typecheck baseline**: `npm run typecheck` reports 44 pre-existing errors, all in test files. The production build gate (`npm run build`) uses `tsconfig.build.json`, which excludes tests and is clean. Do not treat the 44 as regressions; do not add new ones in source files.

## 8. Build and Deploy

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite dev server at localhost:5173 |
| `npm run build` | `tsc -p tsconfig.build.json --noEmit` + Vite production build (the clean gate) |
| `npm run preview` | Serve the production build locally |
| `npm run test` | Vitest suite (639 tests) |
| `npm run test:native` | Native GoogleTest via cmake/ctest (115 tests) |
| `npm run bench:od` | Release-build OD benchmark |
| `npm run typecheck` | Full-project tsc (44-error test baseline) |
| `npm run wasm:build` | Emscripten build, artifacts to `public/wasm/` |
| `npm run lint` | ESLint over ts/tsx |

GitHub Pages constraints shape several decisions: HashRouter instead of browser-history routing; no server, so all computation is client-side; no SharedArrayBuffer (no cross-origin isolation headers), so the WASM build is single-threaded; WASM artifacts are committed under `public/wasm/` because Pages only serves static files and cannot run the Emscripten toolchain.

## 9. Conventions and Invariants

- **No em dashes** anywhere in any file, including documentation.
- **Indentation**: 4-space with K&R braces for C++; 2-space for TS/TSX (the actual repo practice, which supersedes older notes claiming 4-space for TS). Naming: snake_case locals and functions in C++, camelCase in TS, PascalCase types.
- **Flat-array contract stability**: the obs-table, config10/config16, and result-header layouts documented in `exports.cpp` are a contract shared by C++ serializers, TS codecs, and fixture payloads. Changing a layout requires updating all three in lockstep plus the comment blocks.
- **Helio oracle discipline**: `../helio_ob` is read-only. Parity changes flow one way: change Helio (upstream), regenerate fixtures, then port to C++. The fixture manifest pins the exact reference git rev.
- **WASM artifacts are tracked**: any C++ change must be followed by `npm run wasm:build` and a commit of the regenerated `public/wasm/` files, or the deployed app will drift from source.
- **Single-satellite estimation**: the OD pipeline estimates one satellite against one or more stations; multi-satellite joint estimation is out of scope.

### Approved fast-follows (not started)

RTS smoother, drag/Cd 7-state estimation, CCSDS TDM import, QQ NIS diagnostics, Levenberg-Marquardt batch solver.
