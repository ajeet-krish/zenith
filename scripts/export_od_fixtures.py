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
    """Build all Phase 1 fixture cases from helio_ob."""
    from helio.constants import DEG2RAD
    from helio.forces import j2_accel_and_jacobian
    from helio.frames import elements_to_state
    from helio.kepler import solve_kepler
    from helio.observations import ObsConfig, ObsType, Observation, predict_observation
    from helio.partials import measurement_partials
    from helio.propagation import propagate_j2_with_stm
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
