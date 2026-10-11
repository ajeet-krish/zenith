"""Export golden-master OD fixtures from helio_ob for the zenith C++ core.

Reads the helio_ob Python package (read-only reference) and writes one JSON
file per fixture case to fixtures/od/ plus an index.json manifest. The
fixtures are consumed by wasm/tests/test_od_fixtures.cpp and validated
schema-side by src/orbit/__tests__/od_fixtures.test.ts.

Usage:
    uv run --with numpy scripts/export_od_fixtures.py
    # or with helio's venv:
    /Users/ajeet/Projects/helio_ob/.venv/bin/python scripts/export_od_fixtures.py

    Options:
        --helio-path PATH   Path to the helio src directory
                            (default: ../helio_ob/src relative to repo root)
        --out PATH          Output directory (default: fixtures/od)
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

SCHEMA_VERSION = 1

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_HELIO_PATH = REPO_ROOT.parent / "helio_ob" / "src"
DEFAULT_OUT_DIR = REPO_ROOT / "fixtures" / "od"

DEG = math.pi / 180.0


def r17(x: float) -> float:
    """Round-trip a float through 17 significant digits (full double precision)."""
    return float(format(float(x), ".17g"))


def r17_array(arr: np.ndarray) -> list[float]:
    return [r17(v) for v in np.asarray(arr, dtype=np.float64).ravel()]


def helio_git_rev(helio_root: Path) -> str:
    """Return the helio_ob git revision, or 'unknown' outside a git repo."""
    try:
        return subprocess.check_output(
            ["git", "-C", str(helio_root), "rev-parse", "HEAD"],
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, OSError):
        return "unknown"


def make_case(
    case_id: str,
    module: str,
    function: str,
    inputs: dict,
    config: dict,
    expected: dict,
    tolerances: dict,
    meta: dict,
) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "case_id": case_id,
        "module": module,
        "function": function,
        "inputs": inputs,
        "config": config,
        "expected": expected,
        "tolerances": tolerances,
        "meta": meta,
    }


def build_cases() -> list[dict]:
    """Build all Phase 1 and Phase 2 fixture cases from helio_ob."""
    from helio.constants import DEG2RAD
    from helio.forces import j2_accel_and_jacobian
    from helio.frames import elements_to_state
    from helio.iod_gauss import gauss_iod, herrick_gibbs
    from helio.kepler import solve_kepler
    from helio.observations import ObsConfig, ObsType, Observation, predict_observation
    from helio.partials import measurement_partials
    from helio.propagation import propagate_j2_with_stm, propagate_kepler_analytic
    from helio.stations import CANONICAL_STATIONS
    from helio.time_system import jd_to_gmst, utc_to_jd

    j2000 = utc_to_jd(2000, 1, 1, 12, 0, 0)
    half_day = j2000 + 0.5

    # LEO truth state from helio's conftest leo_state fixture:
    # a = 6778.137 km, e = 0, i = 51.6 deg, nu = 30 deg (others zero).
    leo_elements = np.array(
        [6778.137, 0.0, 51.6 * DEG2RAD, 0.0, 0.0, 30.0 * DEG2RAD],
        dtype=np.float64,
    )
    leo_state = elements_to_state(leo_elements)
    leo_r = leo_state[0:3]
    leo_v = leo_state[3:6]

    goldstone = CANONICAL_STATIONS["goldstone"]
    config = ObsConfig()

    cases: list[dict] = []

    # ------------------------------------------------------------------
    # 1. kepler_solver
    # ------------------------------------------------------------------
    M = 2.3456
    ecc = 0.65
    E = solve_kepler(M, ecc)
    cases.append(
        make_case(
            case_id="kepler_solver",
            module="kepler",
            function="solve_kepler",
            inputs={"M": r17(M), "e": r17(ecc)},
            config={"tol": 1e-12},
            expected={"E": r17(E)},
            tolerances={"E": 1e-12},
            meta={"source": "helio_ob", "reference": "helio.kepler.solve_kepler"},
        )
    )

    # ------------------------------------------------------------------
    # 2. j2_stm_propagation
    # ------------------------------------------------------------------
    dt = 3600.0
    stm_rtol = 1e-10
    stm_atol = 1e-12
    r_f, v_f, stm_f = propagate_j2_with_stm(
        leo_state, dt, rtol=stm_rtol, atol=stm_atol
    )
    cases.append(
        make_case(
            case_id="j2_stm_propagation",
            module="integrators",
            function="propagate_with_stm",
            inputs={
                "state6": r17_array(leo_state),
                "t0": 0.0,
                "t1": r17(dt),
            },
            config={
                "force_tier": 1,
                "rtol": stm_rtol,
                "atol": stm_atol,
            },
            expected={
                "r": r17_array(r_f),
                "v": r17_array(v_f),
                "stm": r17_array(stm_f),
            },
            tolerances={"r": 1e-7, "v": 1e-9, "stm": 1e-9},
            meta={
                "source": "helio_ob",
                "reference": "helio.propagation.propagate_j2_with_stm",
                "note": "stm tolerance is relative; r and v are absolute km / km/s",
            },
        )
    )

    # ------------------------------------------------------------------
    # 3. force_jacobians
    # ------------------------------------------------------------------
    accel, jac = j2_accel_and_jacobian(leo_r)
    cases.append(
        make_case(
            case_id="force_jacobians",
            module="force_models",
            function="j2_accel_and_jacobian",
            inputs={"r": r17_array(leo_r)},
            config={},
            expected={
                "accel": r17_array(accel),
                "jac": r17_array(jac),
            },
            tolerances={"accel": 1e-9, "jac": 1e-9},
            meta={
                "source": "helio_ob",
                "reference": "helio.forces.j2_accel_and_jacobian",
                "note": "tolerances are relative",
            },
        )
    )

    # ------------------------------------------------------------------
    # 4. measurement_partials
    # ------------------------------------------------------------------
    pred = predict_observation(leo_r, leo_v, goldstone, half_day)
    range_obs = Observation(
        time_jd=half_day,
        station=goldstone,
        obs_type=ObsType.RANGE,
        values=np.array([pred["range_km"]]),
        sigmas=np.array([config.sigma_range_km]),
    )
    rr_obs = Observation(
        time_jd=half_day,
        station=goldstone,
        obs_type=ObsType.RANGE_RATE,
        values=np.array([pred["range_rate_kms"]]),
        sigmas=np.array([config.sigma_range_rate_kms]),
    )
    radec_obs = Observation(
        time_jd=half_day,
        station=goldstone,
        obs_type=ObsType.RA_DEC,
        values=np.array([pred["ra_rad"], pred["dec_rad"]]),
        sigmas=np.array(config.sigma_angles_rad, dtype=np.float64),
    )
    range_h = measurement_partials(range_obs, leo_r, leo_v)
    rr_h = measurement_partials(rr_obs, leo_r, leo_v)
    radec_h = measurement_partials(radec_obs, leo_r, leo_v)
    cases.append(
        make_case(
            case_id="measurement_partials",
            module="partials",
            function="measurement_partials",
            inputs={
                "r": r17_array(leo_r),
                "v": r17_array(leo_v),
                "station": "goldstone",
                "jd": r17(half_day),
            },
            config={},
            expected={
                "range_km": r17(pred["range_km"]),
                "range_rate_kms": r17(pred["range_rate_kms"]),
                "ra_rad": r17(pred["ra_rad"]),
                "dec_rad": r17(pred["dec_rad"]),
                "range_h": r17_array(range_h),
                "range_rate_h": r17_array(rr_h),
                "ra_h": r17_array(radec_h[0]),
                "dec_h": r17_array(radec_h[1]),
            },
            tolerances={
                "range_km": 1e-10,
                "range_rate_kms": 1e-10,
                "ra_rad": 1e-10,
                "dec_rad": 1e-10,
                "range_h": 1e-10,
                "range_rate_h": 1e-10,
                "ra_h": 1e-10,
                "dec_h": 1e-10,
            },
            meta={
                "source": "helio_ob",
                "reference": "helio.partials.measurement_partials",
            },
        )
    )

    # ------------------------------------------------------------------
    # 5. station_ecef
    # ------------------------------------------------------------------
    station_ecef_inputs = {}
    station_ecef_expected = {}
    station_ecef_tols = {}
    for name, station in CANONICAL_STATIONS.items():
        ecef = station.position_ecef
        station_ecef_inputs[name] = {
            "lat_rad": r17(station.lat_rad),
            "lon_rad": r17(station.lon_rad),
            "alt_km": r17(station.alt_km),
        }
        station_ecef_expected[f"{name}_ecef"] = r17_array(ecef)
        station_ecef_tols[f"{name}_ecef"] = 1e-9
    cases.append(
        make_case(
            case_id="station_ecef",
            module="frames",
            function="lla_to_ecef",
            inputs={"stations": station_ecef_inputs},
            config={},
            expected=station_ecef_expected,
            tolerances=station_ecef_tols,
            meta={
                "source": "helio_ob",
                "reference": "helio.stations.GroundStation.position_ecef",
            },
        )
    )

    # ------------------------------------------------------------------
    # 6. gmst
    # ------------------------------------------------------------------
    gmst_j2000 = jd_to_gmst(j2000)
    gmst_half = jd_to_gmst(half_day)
    cases.append(
        make_case(
            case_id="gmst",
            module="time_system",
            function="jd_to_gmst",
            inputs={"jds": [r17(j2000), r17(half_day)]},
            config={},
            expected={
                "gmst_j2000": r17(gmst_j2000),
                "gmst_j2000_half": r17(gmst_half),
            },
            tolerances={"gmst_j2000": 1e-12, "gmst_j2000_half": 1e-12},
            meta={"source": "helio_ob", "reference": "helio.time_system.jd_to_gmst"},
        )
    )

    # ------------------------------------------------------------------
    # 7. observation_prediction
    # ------------------------------------------------------------------
    full_pred = predict_observation(leo_r, leo_v, goldstone, half_day)
    cases.append(
        make_case(
            case_id="observation_prediction",
            module="observations",
            function="predict_observation",
            inputs={
                "r": r17_array(leo_r),
                "v": r17_array(leo_v),
                "station": "goldstone",
                "jd": r17(half_day),
            },
            config={},
            expected={
                "range_km": r17(full_pred["range_km"]),
                "range_rate_kms": r17(full_pred["range_rate_kms"]),
                "ra_rad": r17(full_pred["ra_rad"]),
                "dec_rad": r17(full_pred["dec_rad"]),
                "az_rad": r17(full_pred["az_rad"]),
                "el_rad": r17(full_pred["el_rad"]),
            },
            tolerances={
                "range_km": 1e-10,
                "range_rate_kms": 1e-10,
                "ra_rad": 1e-10,
                "dec_rad": 1e-10,
                "az_rad": 1e-10,
                "el_rad": 1e-10,
            },
            meta={
                "source": "helio_ob",
                "reference": "helio.observations.predict_observation",
            },
        )
    )

    # ------------------------------------------------------------------
    # Phase 2: Gauss IOD + Herrick-Gibbs golden-master cases
    # (research spec F1-F5 + HG1; error cases F6-F8 are unit-tested
    # natively in wasm/tests/test_iod_gauss.cpp instead of fixtures)
    # ------------------------------------------------------------------
    jd_iod = utc_to_jd(2024, 1, 1, 0, 0, 0)  # 2460310.5

    def make_radec_baked(
        elements: list[float],
        dts: tuple[float, ...],
        station_names: tuple[str, ...],
        noise_seed: int | None = None,
        noise_sigma: float = 1e-6,
    ) -> tuple[list[Observation], list[np.ndarray], np.ndarray, np.ndarray]:
        """Noise-free (or seeded-noisy) RA/Dec observations, baked values.

        Replicates helio test _make_ra_dec_obs: two-body truth at each
        dt, predict_observation for the noise-free angles, and for the
        noisy variant rng(seed).normal(0, sigma) draws per epoch in
        order (values baked into the fixture; numpy RNG is not
        reproduced in C++).
        """
        state0 = elements_to_state(np.array(elements, dtype=np.float64))
        rng = np.random.default_rng(noise_seed) if noise_seed is not None else None
        obs_list: list[Observation] = []
        truth_states: list[np.ndarray] = []
        for dt, name in zip(dts, station_names):
            state = propagate_kepler_analytic(state0, dt)
            truth_states.append(state)
            jd = jd_iod + dt / 86400.0
            pred = predict_observation(
                state[:3], state[3:], CANONICAL_STATIONS[name], jd
            )
            ra = float(pred["ra_rad"])
            dec = float(pred["dec_rad"])
            if rng is not None:
                noise = rng.normal(0.0, (noise_sigma, noise_sigma))
                ra += float(noise[0])
                dec += float(noise[1])
            obs_list.append(
                Observation(
                    time_jd=jd,
                    station=CANONICAL_STATIONS[name],
                    obs_type=ObsType.RA_DEC,
                    values=np.array([ra, dec]),
                    sigmas=np.array([noise_sigma, noise_sigma]),
                )
            )
        return obs_list, truth_states, truth_states[1][:3], truth_states[1][3:]

    def gauss_case(
        case_id: str,
        elements: list[float],
        dts: tuple[float, ...],
        station_names: tuple[str, ...],
        note: str,
        noise_seed: int | None = None,
        tols: dict | None = None,
    ) -> dict:
        """One gauss_iod fixture: baked RA/Dec in, helio (r, v) out."""
        obs_list, _, truth_r2, truth_v2 = make_radec_baked(
            elements, dts, station_names, noise_seed=noise_seed
        )
        r2, v2 = gauss_iod(obs_list)
        return make_case(
            case_id=case_id,
            module="iod_gauss",
            function="gauss_iod",
            inputs={
                "elements": [r17(v) for v in elements],
                "jd0": r17(jd_iod),
                "dts_s": [r17(d) for d in dts],
                "stations": list(station_names),
                "jd": [r17(o.time_jd) for o in obs_list],
                "ra_rad": [r17(float(o.values[0])) for o in obs_list],
                "dec_rad": [r17(float(o.values[1])) for o in obs_list],
                "noise_seed": noise_seed if noise_seed is not None else -1,
            },
            config={
                "mu": r17(398600.4418),
                "residual_tol_rad": 1e-6,
                "max_dc_iter": 25,
            },
            expected={
                "r": r17_array(r2),
                "v": r17_array(v2),
                "status": 0,
                "truth_r": r17_array(truth_r2),
                "truth_v": r17_array(truth_v2),
            },
            # Tech-lead design tolerances (tighter than the 1e-3 km /
            # 1e-6 km/s research floor); per-case override allowed for
            # geometries whose flat manifolds limit golden parity.
            tolerances=tols or {"r": 1e-4, "v": 1e-7},
            meta={
                "source": "helio_ob",
                "reference": "helio.iod_gauss.gauss_iod",
                "note": note,
            },
        )

    # F1: LEO 3-station 10-minute clean (helio test_gauss_noise_free_leo).
    leo_els = [6778.137, 0.0, 70.0 * DEG2RAD, 0.0, 0.0, 30.0 * DEG2RAD]
    cases.append(
        gauss_case(
            "gauss_iod_leo_3sta_clean",
            leo_els,
            (0.0, 600.0, 1200.0),
            ("goldstone", "arecibo", "tromsoe"),
            "noise-free 3-station LEO recovery, 10-minute spacing",
        )
    )

    # F2: LEO single-station clean (helio test_gauss_noise_free_single_station).
    cases.append(
        gauss_case(
            "gauss_iod_leo_1sta_clean",
            leo_els,
            (0.0, 600.0, 1200.0),
            ("goldstone", "goldstone", "goldstone"),
            "noise-free single-station LEO recovery",
        )
    )

    # F3: MEO e=0.3 clean (helio test_gauss_noise_free_eccentric).
    meo_els = [
        24000.0,
        0.3,
        63.0 * DEG2RAD,
        40.0 * DEG2RAD,
        90.0 * DEG2RAD,
        0.0,
    ]
    cases.append(
        gauss_case(
            "gauss_iod_meo_ecc_clean",
            meo_els,
            (0.0, 600.0, 1200.0),
            ("goldstone", "arecibo", "tromsoe"),
            "noise-free eccentric MEO recovery (e = 0.3)",
        )
    )

    # F4: GEO single-station 20-minute clean (helio test_gauss_geo_from_goldstone).
    # Tolerance override: single-station GEO has a near-flat range
    # manifold (helio's own solution sits 2.65e-3 km from its noise-free
    # truth), so cross-implementation golden parity is limited to ~1e-3
    # km; 1e-2 km / 1e-6 km/s still validates parity at 200x tighter
    # than the method's documented few-metre GEO accuracy.
    geo_els = [42164.137, 0.0, 0.0, 0.0, 0.0, 45.0 * DEG2RAD]
    cases.append(
        gauss_case(
            "gauss_iod_geo_1sta_clean",
            geo_els,
            (0.0, 1200.0, 2400.0),
            ("goldstone", "goldstone", "goldstone"),
            "noise-free GEO recovery from one station, 20-minute spacing; "
            "loosened r/v tolerance for the flat range manifold",
            tols={"r": 1e-2, "v": 1e-6},
        )
    )

    # F5: LEO noisy seed 42, baked 1-arcsec noise (helio
    # test_gauss_noisy_leo_close_to_truth: rng(42), sigma 1e-6 rad).
    cases.append(
        gauss_case(
            "gauss_iod_leo_noisy_seed42",
            leo_els,
            (0.0, 600.0, 1200.0),
            ("goldstone", "arecibo", "tromsoe"),
            "1-arcsec noise (seed 42) baked into ra/dec; rng numpy not "
            "reproduced in C++",
            noise_seed=42,
        )
    )

    # HG1: Herrick-Gibbs vs two-body truth at +-30 s (helio conftest
    # leo_state, test_herrick_gibbs_two_body bound: 1e-6 relative).
    hg_elements = [6778.137, 0.0, 51.6 * DEG2RAD, 0.0, 0.0, 30.0 * DEG2RAD]
    hg_state0 = elements_to_state(np.array(hg_elements, dtype=np.float64))
    hg_r1 = propagate_kepler_analytic(hg_state0, -30.0)[:3]
    hg_r2 = hg_state0[:3]
    hg_r3 = propagate_kepler_analytic(hg_state0, 30.0)[:3]
    hg_v2 = herrick_gibbs(hg_r1, hg_r2, hg_r3, -30.0, 0.0, 30.0)
    cases.append(
        make_case(
            case_id="herrick_gibbs",
            module="iod_gauss",
            function="herrick_gibbs",
            inputs={
                "r1": r17_array(hg_r1),
                "r2": r17_array(hg_r2),
                "r3": r17_array(hg_r3),
                "t1": -30.0,
                "t2": 0.0,
                "t3": 30.0,
                "mu": r17(398600.4418),
            },
            config={},
            expected={
                "v2": r17_array(hg_v2),
                "v_truth": r17_array(hg_state0[3:]),
                "status": 0,
            },
            tolerances={"v2": 1e-9},
            meta={
                "source": "helio_ob",
                "reference": "helio.iod_gauss.herrick_gibbs",
                "note": "tolerance is absolute km/s (tech-lead design)",
            },
        )
    )

    return cases


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--helio-path",
        type=Path,
        default=DEFAULT_HELIO_PATH,
        help="Path to the helio_ob src directory (default: %(default)s)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help="Output directory for fixtures (default: %(default)s)",
    )
    args = parser.parse_args()

    helio_path: Path = args.helio_path.resolve()
    if not helio_path.is_dir():
        print(f"error: helio path not found: {helio_path}", file=sys.stderr)
        return 1
    sys.path.insert(0, str(helio_path))

    try:
        cases = build_cases()
    except ImportError as exc:
        print(f"error: failed to import helio from {helio_path}: {exc}", file=sys.stderr)
        return 1

    out_dir: Path = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    rev = helio_git_rev(helio_path.parent)
    generated_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    manifest_cases = []
    for case in cases:
        case_path = out_dir / f"{case['case_id']}.json"
        with case_path.open("w") as fh:
            json.dump(case, fh, indent=2)
            fh.write("\n")
        manifest_cases.append(
            {
                "case_id": case["case_id"],
                "file": case_path.name,
                "module": case["module"],
                "function": case["function"],
            }
        )
        print(f"wrote {case_path}")

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "helio_git_rev": rev,
        "generated_utc": generated_utc,
        "cases": manifest_cases,
    }
    manifest_path = out_dir / "index.json"
    with manifest_path.open("w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(f"wrote {manifest_path} ({len(cases)} cases, helio rev {rev[:12]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
