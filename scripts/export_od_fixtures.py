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

# Phase 3 batch-arc geometry (mirrors helio tests/test_od_batch.py).
BATCH_EPOCH_OFFSET_S = 600.0
BATCH_N_EPOCHS = 11
BATCH_EPOCH_STEP_S = 120.0
BATCH_ALL_TYPES = ("RANGE", "RANGE_RATE", "RA_DEC")


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

    # ------------------------------------------------------------------
    # Phase 3: Batch least-squares OD golden-master cases (B1-B6 per the
    # standards.md research spec). Error/validation cases (empty obs,
    # AZ_EL, bad sigmas, singular N, a-priori SPD) are unit-tested
    # natively in wasm/tests/test_od_batch.cpp instead of fixtures.
    # Noisy observation VALUES are baked from the Helio numpy RNG (not
    # reproducible in C++); noise-free cases regenerate deterministically.
    # ------------------------------------------------------------------
    from helio.constants import J2
    from helio.od_batch import APrioriState, BatchConfig, batch_od
    from helio.observations import ObsType as HObsType
    from helio.propagation import propagate_j2_with_stm
    from helio.stations import CANONICAL_STATIONS as H_STATIONS
    from helio.time_system import utc_to_jd as h_utc_to_jd

    _HOBS = {
        "RANGE": HObsType.RANGE,
        "RANGE_RATE": HObsType.RANGE_RATE,
        "RA_DEC": HObsType.RA_DEC,
    }
    # C++ ObsType int codes (matches zenith ObsType enum).
    _HOBS_CODE = {"RANGE": 0, "RANGE_RATE": 1, "RA_DEC": 2, "AZ_EL": 3}
    _HST = {
        "goldstone": H_STATIONS["goldstone"],
        "arecibo": H_STATIONS["arecibo"],
        "tromsoe": H_STATIONS["tromsoe"],
    }

    batch_epoch_jd = h_utc_to_jd(2024, 1, 1) + BATCH_EPOCH_OFFSET_S / 86400.0

    def _batch_truth(j2: float | None) -> np.ndarray:
        """Truth state at the mid-arc estimation epoch (helio
        test_od_batch._truth_epoch_state)."""
        elements = np.array(
            [6778.137, 0.0, 51.6 * DEG, 0.0, 0.0, 30.0 * DEG],
            dtype=np.float64,
        )
        state0 = elements_to_state(elements)
        kwargs = {} if j2 is None else {"j2": j2}
        r, v, _ = propagate_j2_with_stm(
            state0, BATCH_EPOCH_OFFSET_S, **kwargs
        )
        return np.concatenate([r, v])

    def _batch_arc(
        truth: np.ndarray,
        j2: float | None,
        stations: tuple[str, ...],
        rng: np.random.Generator | None = None,
        obs_types: tuple[str, ...] = BATCH_ALL_TYPES,
        n_epochs: int = BATCH_N_EPOCHS,
        step_s: float = BATCH_EPOCH_STEP_S,
    ) -> list[Observation]:
        """Simulate observations around the estimation epoch (helio
        test_od_batch._make_arc); truth shares the solver's exact dt."""
        config = ObsConfig()
        j2_kwargs = {} if j2 is None else {"j2": j2}
        obs: list[Observation] = []
        for station_name in stations:
            station = _HST[station_name]
            for m in range(n_epochs):
                dt_nom = (m - (n_epochs - 1) / 2.0) * step_s
                jd = batch_epoch_jd + dt_nom / 86400.0
                dt = (jd - batch_epoch_jd) * 86400.0
                r, v, _ = propagate_j2_with_stm(truth, dt, **j2_kwargs)
                pred = predict_observation(r, v, station, jd)
                for type_name in obs_types:
                    obs_type = _HOBS[type_name]
                    if obs_type is HObsType.RANGE:
                        values = np.array([pred["range_km"]])
                        sigmas = np.array([config.sigma_range_km])
                    elif obs_type is HObsType.RANGE_RATE:
                        values = np.array([pred["range_rate_kms"]])
                        sigmas = np.array([config.sigma_range_rate_kms])
                    else:
                        values = np.array(
                            [pred["ra_rad"], pred["dec_rad"]],
                            dtype=np.float64,
                        )
                        sigmas = np.array(config.sigma_angles_rad)
                    if rng is not None:
                        values = values + rng.normal(0.0, sigmas)
                    obs.append(
                        Observation(
                            time_jd=jd,
                            station=station,
                            obs_type=obs_type,
                            values=values,
                            sigmas=sigmas,
                        )
                    )
        return obs

    def _offset_guess(truth: np.ndarray, seed: int = 7) -> np.ndarray:
        """Deterministic guess offset: 1 m-class position, 1 mm/s-class
        velocity (helio test_od_batch._offset_guess)."""
        rng = np.random.default_rng(seed)
        guess = truth.copy()
        guess[:3] += rng.normal(0.0, 1e-3, size=3)
        guess[3:] += rng.normal(0.0, 1e-3, size=3)
        return guess

    def _bake_obs_flat(obs_list: list[Observation]) -> list[float]:
        """Flat WASM record table: per obs
        [time_jd, sta_pos(3), sta_vel(3), obs_type, ndim, values(ndim),
        sigmas(ndim)] with station ECI pre-resolved at the obs epoch."""
        flat: list[float] = []
        for o in obs_list:
            sta_pos = o.station.position_eci(o.time_jd)
            sta_vel = o.station.velocity_eci(o.time_jd)
            flat += [
                r17(o.time_jd),
                r17(float(sta_pos[0])),
                r17(float(sta_pos[1])),
                r17(float(sta_pos[2])),
                r17(float(sta_vel[0])),
                r17(float(sta_vel[1])),
                r17(float(sta_vel[2])),
                float(_HOBS_CODE[o.obs_type.name]),
                float(o.obs_type.ndim),
            ]
            flat += [r17(float(v)) for v in o.values]
            flat += [r17(float(s)) for s in o.sigmas]
        return flat

    def _bake_batch_cfg(cfg: BatchConfig) -> dict:
        """Config dict matching the C++ BatchConfig / WASM config10."""
        force_tier = 0 if cfg.j2_for_stm == 0.0 else 1  # None -> J2 tier
        return {
            "mu": r17(398600.4418),
            "force_tier": force_tier,
            "max_iter": cfg.max_iter,
            "tol_pos_km": cfg.tol_pos_km,
            "tol_vel_kms": cfg.tol_vel_kms,
            "tol_wrms_rel": cfg.tol_wrms_rel,
            "sigma_edit": cfg.sigma_edit,
            "edit_max_fraction": cfg.edit_max_fraction,
            "edit_max_rounds": cfg.edit_max_rounds,
            "enable_editing": True,
        }

    def _bake_batch_result(res) -> dict:
        """Expected-result dict per the C++ BatchResult comparison."""
        rc = float(res.reduced_chi2)
        return {
            "state": r17_array(res.state),
            "covariance": r17_array(res.covariance),
            "formal_sigmas": r17_array(res.formal_sigmas),
            "iterations": int(res.iterations),
            "converged": bool(res.converged),
            "wrms": r17(float(res.wrms)),
            "reduced_chi2": None if math.isnan(rc) else r17(rc),
            "edited_mask": [bool(b) for b in res.residuals.edited_mask],
            "n_rows": int(np.size(res.residuals.edited_mask)),
            "edited_count": int(np.sum(res.residuals.edited_mask)),
        }

    def _batch_tols(iterations_tol: int = 0) -> dict:
        """Cross-implementation tolerances: state atol 1e-6 km / 1e-9
        km/s; covariance/sigmas/wrms relative; iterations exact unless
        overridden."""
        return {
            "state_pos": 1e-6,
            "state_vel": 1e-9,
            "covariance": 1e-4,
            "formal_sigmas": 1e-4,
            "wrms": 1e-2,
            "iterations": iterations_tol,
        }

    def _pos_vel_err(state: np.ndarray, truth: np.ndarray) -> tuple[float, float]:
        pos = float(np.linalg.norm(state[:3] - truth[:3]))
        vel = float(np.linalg.norm(state[3:] - truth[3:]))
        return pos, vel

    # B1: noise-free two-body 3-station arc (helio
    # test_batch_noise_free_converges).
    b1_truth = _batch_truth(j2=0.0)
    b1_obs = _batch_arc(b1_truth, 0.0, ("goldstone", "arecibo", "tromsoe"))
    b1_guess = _offset_guess(b1_truth, seed=7)
    b1_cfg = BatchConfig(j2_for_stm=0.0)
    b1_res = batch_od(b1_obs, b1_guess, batch_epoch_jd, b1_cfg)
    b1_pos_err, b1_vel_err = _pos_vel_err(b1_res.state, b1_truth)
    assert b1_res.converged and b1_pos_err < 1e-4 and b1_vel_err < 1e-7
    cases.append(
        make_case(
            case_id="batch_noise_free",
            module="od_batch",
            function="batch_od",
            inputs={
                "epoch_jd": r17(batch_epoch_jd),
                "observations": _bake_obs_flat(b1_obs),
                "state_guess": r17_array(b1_guess),
                "truth_state": r17_array(b1_truth),
            },
            config=_bake_batch_cfg(b1_cfg),
            expected=_bake_batch_result(b1_res),
            tolerances=_batch_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_batch.batch_od",
                "note": "noise-free two-body 3-station 132-row arc; "
                "physics bounds below",
                "pos_err_max_km": 1e-4,
                "vel_err_max_kms": 1e-7,
                "wrms_max": 1e-6,
                "iterations_max": 5,
            },
        )
    )

    # B2: noisy two-body seed 42 (helio test_batch_noisy_within_3sigma;
    # noisy_rng fixture = default_rng(42)).
    b2_truth = b1_truth
    b2_rng = np.random.default_rng(42)
    b2_obs = _batch_arc(
        b2_truth, 0.0, ("goldstone", "arecibo", "tromsoe"), rng=b2_rng
    )
    b2_guess = _offset_guess(b2_truth, seed=7)
    b2_cfg = BatchConfig(j2_for_stm=0.0)
    b2_res = batch_od(b2_obs, b2_guess, batch_epoch_jd, b2_cfg)
    b2_pos_err, b2_vel_err = _pos_vel_err(b2_res.state, b2_truth)
    assert b2_res.converged
    assert 0.7 <= b2_res.wrms <= 1.3
    assert np.all(np.abs(b2_res.state - b2_truth) <= 3.0 * b2_res.formal_sigmas)
    cases.append(
        make_case(
            case_id="batch_noisy_seed42",
            module="od_batch",
            function="batch_od",
            inputs={
                "epoch_jd": r17(batch_epoch_jd),
                "observations": _bake_obs_flat(b2_obs),
                "state_guess": r17_array(b2_guess),
                "truth_state": r17_array(b2_truth),
                "noise_seed": 42,
            },
            config=_bake_batch_cfg(b2_cfg),
            expected=_bake_batch_result(b2_res),
            tolerances=_batch_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_batch.batch_od",
                "note": "rng(42) noise baked into observation values; "
                "numpy RNG not reproduced in C++",
                "wrms_band": [0.7, 1.3],
                "three_sigma_containment": True,
                "covariance_spd": True,
            },
        )
    )

    # B3: outlier editing (helio test_batch_outlier_editing): first
    # Arecibo RANGE corrupted by +10 sigma; its scalar row index is the
    # sum of ndim of the preceding observations.
    b3_truth = b1_truth
    b3_rng = np.random.default_rng(42)
    b3_obs = _batch_arc(
        b3_truth, 0.0, ("goldstone", "arecibo", "tromsoe"), rng=b3_rng
    )
    b3_target = next(
        i
        for i, o in enumerate(b3_obs)
        if o.obs_type is HObsType.RANGE
        and o.station is _HST["arecibo"]
    )
    b3_bad = b3_obs[b3_target]
    b3_obs[b3_target] = Observation(
        time_jd=b3_bad.time_jd,
        station=b3_bad.station,
        obs_type=b3_bad.obs_type,
        values=b3_bad.values + 10.0 * b3_bad.sigmas,
        sigmas=b3_bad.sigmas,
    )
    b3_corrupted_row = sum(
        o.obs_type.ndim for o in b3_obs[:b3_target]
    )
    b3_guess = _offset_guess(b3_truth, seed=7)
    b3_cfg = BatchConfig(j2_for_stm=0.0)
    b3_res = batch_od(b3_obs, b3_guess, batch_epoch_jd, b3_cfg)
    b3_pos_err, b3_vel_err = _pos_vel_err(b3_res.state, b3_truth)
    assert b3_res.converged
    assert bool(b3_res.residuals.edited_mask[b3_corrupted_row])
    assert 0.7 <= b3_res.wrms <= 1.3
    assert np.all(
        np.abs(b3_res.state - b3_truth) <= 3.0 * b3_res.formal_sigmas
    )
    cases.append(
        make_case(
            case_id="batch_outlier_editing",
            module="od_batch",
            function="batch_od",
            inputs={
                "epoch_jd": r17(batch_epoch_jd),
                "observations": _bake_obs_flat(b3_obs),
                "state_guess": r17_array(b3_guess),
                "truth_state": r17_array(b3_truth),
                "corrupted_row": b3_corrupted_row,
                "noise_seed": 42,
            },
            config=_bake_batch_cfg(b3_cfg),
            expected=_bake_batch_result(b3_res),
            tolerances=_batch_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_batch.batch_od",
                "note": "first Arecibo RANGE += 10 sigma; edited_mask must "
                "flag the corrupted row; wrms restored to band",
                "wrms_band": [0.7, 1.3],
                "three_sigma_containment": True,
            },
        )
    )

    # B4: a-priori pull on a sparse noisy angle arc (helio
    # test_batch_a_priori_pull): 3 RA/Dec rows (6 scalar rows, exactly
    # determined without the prior), tight prior, bad 500 km-class guess.
    b4_truth = _batch_truth(j2=0.0)
    b4_rng = np.random.default_rng(42)
    b4_obs: list[Observation] = []
    b4_stations = ("goldstone", "arecibo", "tromsoe")
    b4_config_sigma = ObsConfig()
    for k, station_name in enumerate(b4_stations):
        dt_nom = -300.0 + 300.0 * k
        jd = batch_epoch_jd + dt_nom / 86400.0
        dt = (jd - batch_epoch_jd) * 86400.0
        r, v, _ = propagate_j2_with_stm(b4_truth, dt, j2=0.0)
        pred = predict_observation(r, v, _HST[station_name], jd)
        values = np.array(
            [pred["ra_rad"], pred["dec_rad"]], dtype=np.float64
        ) + b4_rng.normal(0.0, b4_config_sigma.sigma_angles_rad, size=2)
        b4_obs.append(
            Observation(
                time_jd=jd,
                station=_HST[station_name],
                obs_type=HObsType.RA_DEC,
                values=values,
                sigmas=np.array(b4_config_sigma.sigma_angles_rad),
            )
        )
    b4_x0 = b4_truth + np.array(
        [1e-4, -2e-4, 1e-4, 1e-5, -2e-5, 1e-5]
    )
    b4_p0_diag = np.diag([1e-8, 1e-8, 1e-8, 1e-10, 1e-10, 1e-10])
    b4_prior = APrioriState(x0=b4_x0, covariance=b4_p0_diag)
    b4_guess = _offset_guess(b4_truth, seed=11)
    b4_guess[:3] += 0.5
    b4_guess[3:] += 0.05
    b4_cfg = BatchConfig(j2_for_stm=0.0, max_iter=20)
    b4_with = batch_od(b4_obs, b4_guess, batch_epoch_jd, b4_cfg,
                       a_priori=b4_prior)
    b4_without = batch_od(b4_obs, b4_guess, batch_epoch_jd, b4_cfg)
    b4_dist_with = float(np.linalg.norm(b4_with.state - b4_x0))
    b4_dist_without = float(np.linalg.norm(b4_without.state - b4_x0))
    b4_err_with = float(np.linalg.norm(b4_with.state - b4_truth))
    b4_err_without = float(np.linalg.norm(b4_without.state - b4_truth))
    assert b4_dist_with < b4_dist_without
    assert b4_err_with < b4_err_without
    cases.append(
        make_case(
            case_id="batch_apriori",
            module="od_batch",
            function="batch_od",
            inputs={
                "epoch_jd": r17(batch_epoch_jd),
                "observations": _bake_obs_flat(b4_obs),
                "state_guess": r17_array(b4_guess),
                "truth_state": r17_array(b4_truth),
                "a_priori": {
                    "x0": r17_array(b4_x0),
                    "cov": r17_array(b4_p0_diag),
                },
                "noise_seed": 42,
            },
            config=_bake_batch_cfg(b4_cfg),
            expected={
                "with_prior": _bake_batch_result(b4_with),
                "without_prior": _bake_batch_result(b4_without),
            },
            tolerances=_batch_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_batch.batch_od",
                "note": "6 scalar rows; prior pulls the solution toward "
                "x0 and the truth; reduced_chi2 is NaN (m_active <= 6)",
                "dist_with_lt_without": True,
                "err_with_lt_without": True,
            },
        )
    )

    # B5: J2 truth noise-free (helio test_batch_j2_truth): default J2
    # constant in truth AND STM (j2_for_stm=None -> WGS-72 J2).
    b5_truth = _batch_truth(j2=None)
    b5_obs = _batch_arc(b5_truth, None, ("goldstone", "arecibo", "tromsoe"))
    b5_guess = _offset_guess(b5_truth, seed=7)
    b5_cfg = BatchConfig()  # j2_for_stm=None -> J2 tier.
    b5_res = batch_od(b5_obs, b5_guess, batch_epoch_jd, b5_cfg)
    b5_pos_err, b5_vel_err = _pos_vel_err(b5_res.state, b5_truth)
    assert b5_res.converged
    assert np.all(
        np.abs(b5_res.state - b5_truth) <= 3.0 * b5_res.formal_sigmas
    )
    assert b5_cfg.j2_for_stm is None and J2 == 1.08263e-3
    cases.append(
        make_case(
            case_id="batch_j2_truth",
            module="od_batch",
            function="batch_od",
            inputs={
                "epoch_jd": r17(batch_epoch_jd),
                "observations": _bake_obs_flat(b5_obs),
                "state_guess": r17_array(b5_guess),
                "truth_state": r17_array(b5_truth),
            },
            config=_bake_batch_cfg(b5_cfg),
            expected=_bake_batch_result(b5_res),
            tolerances=_batch_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_batch.batch_od",
                "note": "J2 truth and J2 STM with the WGS-72 constant "
                "(force_tier=1)",
                "three_sigma_containment": True,
            },
        )
    )

    # B6: IOD-seeded refinement (helio test_batch_refines_gauss_iod):
    # noisy 1-arcsec angles-only triple seeds gauss_iod; the batch arc is
    # the same noisy angles plus a noise-free Goldstone radiometric arc.
    b6_truth = _batch_truth(j2=0.0)
    b6_rng = np.random.default_rng(42)
    b6_sigma_angle = 4.8481368e-6
    b6_iod_obs: list[Observation] = []
    for k, station_name in enumerate(b4_stations):
        dt_nom = -900.0 + 900.0 * k
        jd = batch_epoch_jd + dt_nom / 86400.0
        dt = (jd - batch_epoch_jd) * 86400.0
        r, v, _ = propagate_j2_with_stm(b6_truth, dt, j2=0.0)
        pred = predict_observation(r, v, _HST[station_name], jd)
        values = np.array(
            [pred["ra_rad"], pred["dec_rad"]], dtype=np.float64
        ) + b6_rng.normal(0.0, b6_sigma_angle, size=2)
        b6_iod_obs.append(
            Observation(
                time_jd=jd,
                station=_HST[station_name],
                obs_type=HObsType.RA_DEC,
                values=values,
                sigmas=np.array([b6_sigma_angle, b6_sigma_angle]),
            )
        )
    b6_r_iod, b6_v_iod = gauss_iod(b6_iod_obs)
    b6_iod_state = np.concatenate([b6_r_iod, b6_v_iod])
    b6_iod_pos_err, b6_iod_vel_err = _pos_vel_err(b6_iod_state, b6_truth)
    assert b6_iod_pos_err > 1e-3  # angle noise leaves a metre-class error
    b6_batch_obs = list(b6_iod_obs) + _batch_arc(
        b6_truth,
        0.0,
        ("goldstone",),
        obs_types=("RANGE", "RANGE_RATE"),
    )
    b6_cfg = BatchConfig(j2_for_stm=0.0, max_iter=15)
    b6_res = batch_od(b6_batch_obs, b6_iod_state, batch_epoch_jd, b6_cfg)
    b6_pos_err, b6_vel_err = _pos_vel_err(b6_res.state, b6_truth)
    assert b6_res.converged
    assert b6_pos_err < b6_iod_pos_err
    assert b6_vel_err < 0.6 * b6_iod_vel_err
    cases.append(
        make_case(
            case_id="batch_refines_iod",
            module="od_batch",
            function="batch_od",
            inputs={
                "epoch_jd": r17(batch_epoch_jd),
                "observations": _bake_obs_flat(b6_batch_obs),
                "state_guess": r17_array(b6_iod_state),
                "truth_state": r17_array(b6_truth),
                "iod": {
                    "jd": [r17(o.time_jd) for o in b6_iod_obs],
                    "ra_rad": [r17(float(o.values[0])) for o in b6_iod_obs],
                    "dec_rad": [r17(float(o.values[1])) for o in b6_iod_obs],
                    "stations": [
                        o.station.name for o in b6_iod_obs
                    ],
                    "sigma_angle_rad": r17(b6_sigma_angle),
                },
                "noise_seed": 42,
            },
            config=_bake_batch_cfg(b6_cfg),
            expected={
                "iod_state": r17_array(b6_iod_state),
                "iod_pos_err": r17(b6_iod_pos_err),
                "iod_vel_err": r17(b6_iod_vel_err),
                "batch": _bake_batch_result(b6_res),
            },
            tolerances={
                **_batch_tols(),
                "iod_state_pos": 1e-4,
                "iod_state_vel": 1e-7,
            },
            meta={
                "source": "helio_ob",
                "reference": "helio.od_batch.batch_od + helio.iod_gauss",
                "note": "C++ re-runs gauss_iod on the baked angles, then "
                "refines with the batch arc; batch must beat the IOD seed",
                "batch_pos_err_lt_iod": True,
                "batch_vel_err_lt_0p6_iod": True,
            },
        )
    )

    # ------------------------------------------------------------------
    # Phase 4: Sequential EKF OD golden-master cases (E1-E7 per the
    # standards.md research spec). Validation-error paths are unit-
    # tested natively in wasm/tests/test_od_ekf.cpp instead of fixtures.
    # Only E2 bakes rng(42) noise; the other cases are noise-free and
    # regenerate deterministically. Case ids:
    #   ekf_noise_free (E1), ekf_noisy_seed42 (E2),
    #   ekf_observation_gap (E3), ekf_outlier_gate (E4),
    #   ekf_scheduled_maneuver (E5 + negative control),
    #   ekf_maneuver_detection (E6), ekf_maneuver_forced_contraction
    #   (E6b), ekf_divergence_recovery (E7 + negative control).
    # ------------------------------------------------------------------
    from helio.od_ekf import (
        EKFConfig as HEKFConfig,
        ManeuverConfig as HManeuverConfig,
        ProcessNoiseConfig as HProcessNoiseConfig,
        RecoveryConfig as HRecoveryConfig,
        ScheduledManeuver as HScheduledManeuver,
        ekf_solve as h_ekf_solve,
    )
    from helio.time_system import utc_to_jd as h_utc_to_jd_ekf

    EKF_OBS_PER_EPOCH = 6  # 2 stations x 3 types (helio OBS_PER_EPOCH).
    ekf_epoch_jd = h_utc_to_jd_ekf(2024, 1, 1)

    def _ekf_truth_state(
        truth_epoch: np.ndarray,
        dt: float,
        burn_dt: float | None = None,
        burn_dv: np.ndarray | None = None,
    ) -> np.ndarray:
        """Truth state at dt seconds after the epoch with an optional
        burn (helio test_ekf._truth_state)."""
        if burn_dt is None or dt <= burn_dt:
            r, v, _ = propagate_j2_with_stm(truth_epoch, dt)
            return np.concatenate([r, v])
        r_b, v_b, _ = propagate_j2_with_stm(truth_epoch, burn_dt)
        v_b = v_b + burn_dv
        r, v, _ = propagate_j2_with_stm(np.concatenate([r_b, v_b]), dt - burn_dt)
        return np.concatenate([r, v])

    def _ekf_offset_guess(truth: np.ndarray) -> np.ndarray:
        """Truth plus the deterministic Helio EKF guess offset."""
        guess = truth.copy()
        guess[:3] += np.array([0.0005, -0.0004, 0.0003])
        guess[3:] += np.array([2e-7, -1e-7, 1e-7])
        return guess

    def _ekf_make_arc(
        truth_epoch: np.ndarray,
        times_s: list[float],
        stations: tuple[str, ...],
        burn_dt: float | None = None,
        burn_dv: np.ndarray | None = None,
        rng: np.random.Generator | None = None,
    ) -> list[Observation]:
        """Simulate observations at the given times from every station
        (helio test_ekf._make_arc; time-major, station-major, type-
        minor order)."""
        ekf_cfg_sigma = ObsConfig()
        ekf_types = (HObsType.RANGE, HObsType.RANGE_RATE, HObsType.RA_DEC)
        obs: list[Observation] = []
        for dt in times_s:
            jd = ekf_epoch_jd + dt / 86400.0
            state = _ekf_truth_state(truth_epoch, dt, burn_dt, burn_dv)
            for station_name in stations:
                station = _HST[station_name]
                pred = predict_observation(
                    state[:3], state[3:], station, jd
                )
                values_list = [
                    np.array([pred["range_km"]]),
                    np.array([pred["range_rate_kms"]]),
                    np.array([pred["ra_rad"], pred["dec_rad"]]),
                ]
                sigma_list = [
                    np.array([ekf_cfg_sigma.sigma_range_km]),
                    np.array([ekf_cfg_sigma.sigma_range_rate_kms]),
                    np.array(ekf_cfg_sigma.sigma_angles_rad),
                ]
                for obs_type, values, sigmas in zip(
                    ekf_types, values_list, sigma_list, strict=True
                ):
                    if rng is not None:
                        values = values + rng.normal(0.0, sigmas)
                    obs.append(
                        Observation(
                            time_jd=jd,
                            station=station,
                            obs_type=obs_type,
                            values=values,
                            sigmas=sigmas,
                        )
                    )
        return obs

    def _bake_ekf_cfg(cfg: HEKFConfig) -> dict:
        """Config dict matching the C++ EKFConfig / WASM config16."""
        force_tier = 0 if cfg.j2 == 0.0 else 1  # None -> J2 tier.
        return {
            "q_a": r17(cfg.process.q_a),
            "q_a_maneuver": r17(cfg.process.q_a_maneuver),
            "estimate_maneuver": bool(cfg.maneuver.estimate_maneuver),
            "nis_sigma_threshold": r17(cfg.maneuver.nis_sigma_threshold),
            "consecutive_exceedances": int(cfg.maneuver.consecutive_exceedances),
            "reentry_window_obs": int(cfg.maneuver.reentry_window_obs),
            "scheduled_inflate_kms": r17(cfg.maneuver.scheduled_inflate_kms),
            "sustained_nis_count": int(cfg.recovery.sustained_nis_count),
            "inflate_factor": r17(cfg.recovery.inflate_factor),
            "p0_diag": r17_array(np.asarray(cfg.p0_diag, dtype=np.float64)),
            "force_tier": force_tier,
        }

    def _bake_ekf_expected(res) -> dict:
        """Expected-result dict per the C++ EKFResult comparison."""
        detected = np.flatnonzero(res.maneuver_detected)
        detected_epoch = int(detected[0]) // EKF_OBS_PER_EPOCH if detected.size else -1
        return {
            "final_state": r17_array(res.state_hist[-1, :6]),
            "final_cov_diag": r17_array(np.diag(res.final_covariance)),
            "final_cov": r17_array(res.final_covariance),
            "nis_mean": r17(float(np.mean(res.nis))),
            "nis_max": r17(float(np.max(res.nis))),
            "n_nis_exceed": int(np.sum(res.nis > 25.0)),
            "n_updated": int(np.sum(res.updated_mask)),
            "n_gated": int(np.size(res.updated_mask) - np.sum(res.updated_mask)),
            "n_rows": int(np.size(res.updated_mask)),
            "n_recoveries": int(res.n_recoveries),
            "divergence_flag": bool(res.divergence_flag),
            "augmented_active_final": bool(res.augmented_active_final),
            "detected_epoch": detected_epoch,
            "maneuver_records": [
                {"epoch_jd": r17(rec.epoch_jd), "dv": r17_array(rec.delta_v)}
                for rec in res.delta_v_estimates
            ],
        }

    def _ekf_tols() -> dict:
        """Cross-implementation tolerances: state atol 1e-8 km / 1e-11
        km/s (observed C++ vs Helio parity is ~1e-12 km / 1e-14 km/s;
        3-4 orders of headroom for compiler/library variation);
        covariance relative; counts exact; NIS stats relative bands;
        dv records within the documented detection-mode observability
        ceiling (5e-4 km/s, a physics bound not a parity bound)."""
        return {
            "state_pos": 1e-8,
            "state_vel": 1e-11,
            "final_cov": 1e-6,
            "final_cov_diag": 1e-6,
            "nis_mean": 1e-3,
            "nis_max": 1e-3,
            "dv": 5e-4,
            "epoch_jd": 1e-9,
        }

    def _ekf_pos_vel_err(state: np.ndarray, truth: np.ndarray) -> tuple[float, float]:
        pos = float(np.linalg.norm(state[:3] - truth[:3]))
        vel = float(np.linalg.norm(state[3:] - truth[3:]))
        return pos, vel

    EKF_ALL_STATIONS = ("goldstone", "tromsoe")

    def _ekf_short_arc_times() -> list[float]:
        return [(m - 5) * 120.0 for m in range(11)]

    def _ekf_long_arc_times() -> list[float]:
        return [(m - 10) * 120.0 for m in range(21)]

    def _ekf_leo_truth() -> np.ndarray:
        return leo_state  # elements_to_state of the shared LEO elements.

    def _ekf_burn_dv() -> tuple[float, np.ndarray]:
        """1 m/s prograde burn dv = 1e-3 * v_hat at the epoch (helio
        test_ekf.test_maneuver_detection)."""
        pre_burn = _ekf_leo_truth()
        unit_v = pre_burn[3:] / float(np.linalg.norm(pre_burn[3:]))
        return 60.0, 1e-3 * unit_v

    # E1: noise-free convergence (helio test_noise_free_convergence).
    e1_truth = _ekf_leo_truth()
    e1_times = _ekf_short_arc_times()
    e1_obs = _ekf_make_arc(e1_truth, e1_times, EKF_ALL_STATIONS)
    e1_guess = _ekf_offset_guess(e1_truth)
    e1_cfg = HEKFConfig(process=HProcessNoiseConfig(q_a=0.0))
    e1_res = h_ekf_solve(e1_obs, e1_guess, ekf_epoch_jd, e1_cfg)
    e1_truth_final = _ekf_truth_state(e1_truth, e1_times[-1])
    e1_pos_err, e1_vel_err = _ekf_pos_vel_err(e1_res.state_hist[-1, :6], e1_truth_final)
    assert e1_pos_err < 1e-3 and e1_vel_err < 1e-6
    assert np.all(e1_res.updated_mask)
    assert np.all(e1_res.nis < 25.0)
    assert e1_res.n_recoveries == 0
    cases.append(
        make_case(
            case_id="ekf_noise_free",
            module="od_ekf",
            function="ekf_solve",
            inputs={
                "epoch_jd": r17(ekf_epoch_jd),
                "observations": _bake_obs_flat(e1_obs),
                "state_guess": r17_array(e1_guess),
                "truth_state_final": r17_array(e1_truth_final),
            },
            config=_bake_ekf_cfg(e1_cfg),
            expected=_bake_ekf_expected(e1_res),
            tolerances=_ekf_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_ekf.ekf_solve",
                "note": "E1: noise-free 11-epoch 2-station 66-row arc, "
                "q_a=0; all rows updated, all NIS < 25",
                "pos_err_max_km": 1e-3,
                "vel_err_max_kms": 1e-6,
                "nis_max_gate": 25.0,
                "all_updated": True,
                "n_gated_max": 0,
                "n_recoveries_max": 0,
            },
        )
    )

    # E2: noisy 3-sigma (helio test_noisy_three_sigma; noisy_rng =
    # default_rng(42), noise baked into observation values).
    e2_truth = e1_truth
    e2_rng = np.random.default_rng(42)
    e2_obs = _ekf_make_arc(e2_truth, e1_times, EKF_ALL_STATIONS, rng=e2_rng)
    e2_guess = _ekf_offset_guess(e2_truth)
    e2_cfg = HEKFConfig()  # default q_a = 1e-10.
    e2_res = h_ekf_solve(e2_obs, e2_guess, ekf_epoch_jd, e2_cfg)
    e2_truth_final = _ekf_truth_state(e2_truth, e1_times[-1])
    e2_final = e2_res.state_hist[-1, :6]
    e2_sigmas = e2_res.sigmas[-1, :6]
    e2_err = e2_final - e2_truth_final
    e2_pos_err, e2_vel_err = _ekf_pos_vel_err(e2_final, e2_truth_final)
    assert np.all(np.abs(e2_err) <= 3.0 * e2_sigmas)
    assert e2_pos_err < 0.01
    cases.append(
        make_case(
            case_id="ekf_noisy_seed42",
            module="od_ekf",
            function="ekf_solve",
            inputs={
                "epoch_jd": r17(ekf_epoch_jd),
                "observations": _bake_obs_flat(e2_obs),
                "state_guess": r17_array(e2_guess),
                "truth_state_final": r17_array(e2_truth_final),
                "noise_seed": 42,
            },
            config=_bake_ekf_cfg(e2_cfg),
            expected=_bake_ekf_expected(e2_res),
            tolerances=_ekf_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_ekf.ekf_solve",
                "note": "E2: rng(42) noise baked into observation values; "
                "numpy RNG not reproduced in C++",
                "pos_err_max_km": 0.01,
                "three_sigma_containment": True,
            },
        )
    )

    # E3: observation gap coast (helio test_observation_gap).
    e3_truth = e1_truth
    e3_times = [(m - 4) * 120.0 for m in range(5)]
    e3_times += [720.0 + m * 120.0 for m in range(5)]
    e3_obs = _ekf_make_arc(e3_truth, e3_times, EKF_ALL_STATIONS)
    e3_guess = _ekf_offset_guess(e3_truth)
    e3_cfg = HEKFConfig(process=HProcessNoiseConfig(q_a=0.0))
    e3_res = h_ekf_solve(e3_obs, e3_guess, ekf_epoch_jd, e3_cfg)
    e3_truth_final = _ekf_truth_state(e3_truth, e3_times[-1])
    e3_pos_err, e3_vel_err = _ekf_pos_vel_err(e3_res.state_hist[-1, :6], e3_truth_final)
    e3_gap_s = float(np.max(np.diff(e3_res.obs_times_jd)) * 86400.0)
    assert e3_gap_s > 600.0
    assert e3_pos_err < 1e-3 and e3_vel_err < 1e-6
    assert bool(np.all(np.isfinite(e3_res.state_hist[:, :6])))
    cases.append(
        make_case(
            case_id="ekf_observation_gap",
            module="od_ekf",
            function="ekf_solve",
            inputs={
                "epoch_jd": r17(ekf_epoch_jd),
                "observations": _bake_obs_flat(e3_obs),
                "state_guess": r17_array(e3_guess),
                "truth_state_final": r17_array(e3_truth_final),
            },
            config=_bake_ekf_cfg(e3_cfg),
            expected=_bake_ekf_expected(e3_res),
            tolerances=_ekf_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_ekf.ekf_solve",
                "note": "E3: 600 s observation gap; filter coasts and "
                "recovers (q_a=0)",
                "pos_err_max_km": 1e-3,
                "vel_err_max_kms": 1e-6,
                "gap_min_s": 600.0,
            },
        )
    )

    # E4: 100-sigma outlier gate (helio test_outlier_gate): mid
    # observation (index 33) corrupted by +100 sigma.
    e4_truth = e1_truth
    e4_obs = _ekf_make_arc(e4_truth, e1_times, EKF_ALL_STATIONS)
    e4_mid = len(e4_obs) // 2
    e4_bad = e4_obs[e4_mid]
    e4_obs[e4_mid] = Observation(
        time_jd=e4_bad.time_jd,
        station=e4_bad.station,
        obs_type=e4_bad.obs_type,
        values=e4_bad.values + 100.0 * e4_bad.sigmas,
        sigmas=e4_bad.sigmas,
    )
    e4_row0 = sum(o.obs_type.ndim for o in e4_obs[:e4_mid])
    e4_ndim = e4_bad.obs_type.ndim
    e4_guess = _ekf_offset_guess(e4_truth)
    e4_cfg = HEKFConfig(process=HProcessNoiseConfig(q_a=0.0))
    e4_res = h_ekf_solve(e4_obs, e4_guess, ekf_epoch_jd, e4_cfg)
    e4_truth_final = _ekf_truth_state(e4_truth, e1_times[-1])
    e4_pos_err, e4_vel_err = _ekf_pos_vel_err(e4_res.state_hist[-1, :6], e4_truth_final)
    assert not bool(np.any(e4_res.updated_mask[e4_row0 : e4_row0 + e4_ndim]))
    assert bool(np.all(e4_res.nis[e4_row0 : e4_row0 + e4_ndim] > 25.0))
    assert e4_pos_err < 1e-3 and e4_vel_err < 1e-6
    e4_expected = _bake_ekf_expected(e4_res)
    e4_expected["corrupted_obs_index"] = e4_mid
    e4_expected["corrupted_row0"] = e4_row0
    e4_expected["corrupted_ndim"] = e4_ndim
    cases.append(
        make_case(
            case_id="ekf_outlier_gate",
            module="od_ekf",
            function="ekf_solve",
            inputs={
                "epoch_jd": r17(ekf_epoch_jd),
                "observations": _bake_obs_flat(e4_obs),
                "state_guess": r17_array(e4_guess),
                "truth_state_final": r17_array(e4_truth_final),
            },
            config=_bake_ekf_cfg(e4_cfg),
            expected=e4_expected,
            tolerances=_ekf_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_ekf.ekf_solve",
                "note": "E4: observation index 33 += 100 sigma; gated "
                "rows recorded but not applied; error matches E1",
                "pos_err_max_km": 1e-3,
                "vel_err_max_kms": 1e-6,
                "corrupted_rows_gated": True,
            },
        )
    )

    # E5: scheduled maneuver + negative control (helio
    # test_scheduled_maneuver).
    e5_truth = e1_truth
    e5_burn_dt = 60.0
    e5_burn_dv = np.array([1e-4, -2e-4, 3e-4])
    e5_obs = _ekf_make_arc(
        e5_truth, e1_times, EKF_ALL_STATIONS, burn_dt=e5_burn_dt,
        burn_dv=e5_burn_dv,
    )
    e5_guess = _ekf_offset_guess(e5_truth)
    e5_burn = HScheduledManeuver(
        epoch_jd=ekf_epoch_jd + e5_burn_dt / 86400.0, delta_v=e5_burn_dv
    )
    e5_cfg = HEKFConfig(
        process=HProcessNoiseConfig(q_a=0.0),
        maneuver=HManeuverConfig(scheduled_maneuvers=(e5_burn,)),
    )
    e5_res = h_ekf_solve(e5_obs, e5_guess, ekf_epoch_jd, e5_cfg)
    e5_truth_final = _ekf_truth_state(
        e5_truth, e1_times[-1], e5_burn_dt, e5_burn_dv
    )
    e5_pos_err, e5_vel_err = _ekf_pos_vel_err(e5_res.state_hist[-1, :6], e5_truth_final)
    assert e5_pos_err < 1e-3 and e5_vel_err < 1e-6
    # First post-burn epoch is flagged (index 6 of the 11-epoch arc).
    e5_first_post = 6 * EKF_OBS_PER_EPOCH
    assert bool(
        np.any(e5_res.maneuver_detected[e5_first_post : e5_first_post + EKF_OBS_PER_EPOCH])
    )
    # Negative control: no scheduled entry -> burn unmodeled.
    e5_ctrl_cfg = HEKFConfig(process=HProcessNoiseConfig(q_a=0.0))
    e5_ctrl_res = h_ekf_solve(e5_obs, e5_guess, ekf_epoch_jd, e5_ctrl_cfg)
    e5_ctrl_pos_err, _ = _ekf_pos_vel_err(e5_ctrl_res.state_hist[-1, :6], e5_truth_final)
    assert e5_ctrl_pos_err > 0.05
    e5_expected = _bake_ekf_expected(e5_res)
    e5_expected["control_final_state"] = r17_array(e5_ctrl_res.state_hist[-1, :6])
    cases.append(
        make_case(
            case_id="ekf_scheduled_maneuver",
            module="od_ekf",
            function="ekf_solve",
            inputs={
                "epoch_jd": r17(ekf_epoch_jd),
                "observations": _bake_obs_flat(e5_obs),
                "state_guess": r17_array(e5_guess),
                "truth_state_final": r17_array(e5_truth_final),
                "scheduled_burns": [
                    {"epoch_jd": r17(e5_burn.epoch_jd),
                     "dv": r17_array(e5_burn_dv)}
                ],
                "control_config": _bake_ekf_cfg(e5_ctrl_cfg),
            },
            config=_bake_ekf_cfg(e5_cfg),
            expected=e5_expected,
            tolerances=_ekf_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_ekf.ekf_solve",
                "note": "E5: known 0.37 m/s burn applied mid-predict at "
                "t=60 s; first post-burn epoch flagged; control without "
                "the scheduled entry fails",
                "pos_err_max_km": 1e-3,
                "vel_err_max_kms": 1e-6,
                "first_post_burn_epoch": 6,
                "control_pos_err_min_km": 0.05,
            },
        )
    )

    # E6: maneuver detection + dv estimate (helio
    # test_maneuver_detection).
    e6_truth = e1_truth
    e6_times = _ekf_long_arc_times()
    e6_burn_dt, e6_burn_dv = _ekf_burn_dv()
    e6_obs = _ekf_make_arc(
        e6_truth, e6_times, EKF_ALL_STATIONS, burn_dt=e6_burn_dt,
        burn_dv=e6_burn_dv,
    )
    e6_guess = _ekf_offset_guess(e6_truth)
    e6_cfg = HEKFConfig(
        process=HProcessNoiseConfig(q_a=0.0, q_a_maneuver=1e-9),
        maneuver=HManeuverConfig(
            estimate_maneuver=True,
            consecutive_exceedances=2,
            reentry_window_obs=6,
        ),
    )
    e6_res = h_ekf_solve(e6_obs, e6_guess, ekf_epoch_jd, e6_cfg)
    e6_truth_final = _ekf_truth_state(
        e6_truth, e6_times[-1], e6_burn_dt, e6_burn_dv
    )
    e6_pos_err, e6_vel_err = _ekf_pos_vel_err(e6_res.state_hist[-1, :6], e6_truth_final)
    e6_detected = np.flatnonzero(e6_res.maneuver_detected)
    e6_detected_epoch = int(e6_detected[0]) // EKF_OBS_PER_EPOCH
    e6_burn_epoch = int(np.searchsorted(np.array(e6_times), e6_burn_dt))
    assert e6_detected.size >= 1 and e6_detected_epoch - e6_burn_epoch <= 5
    assert len(e6_res.delta_v_estimates) == 1
    e6_dv_err = float(
        np.linalg.norm(e6_res.delta_v_estimates[0].delta_v - e6_burn_dv)
    )
    assert e6_dv_err < 5e-4
    assert e6_pos_err < 0.01
    assert not e6_res.augmented_active_final
    cases.append(
        make_case(
            case_id="ekf_maneuver_detection",
            module="od_ekf",
            function="ekf_solve",
            inputs={
                "epoch_jd": r17(ekf_epoch_jd),
                "observations": _bake_obs_flat(e6_obs),
                "state_guess": r17_array(e6_guess),
                "truth_state_final": r17_array(e6_truth_final),
                "burn_dt_s": r17(e6_burn_dt),
                "burn_dv": r17_array(e6_burn_dv),
            },
            config=_bake_ekf_cfg(e6_cfg),
            expected=_bake_ekf_expected(e6_res),
            tolerances=_ekf_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_ekf.ekf_solve",
                "note": "E6: 1 m/s prograde burn at t=60 s detected via "
                "NIS streak (consec=2, reentry=6); dv accuracy bound is "
                "the documented 20-50 percent observability ceiling",
                "pos_err_max_km": 0.01,
                "dv_err_max_kms": 5e-4,
                "detect_lag_max_epochs": 5,
                "burn_epoch_index": e6_burn_epoch,
            },
        )
    )

    # E6b: end-of-arc forced contraction (helio
    # test_maneuver_final_forced_contraction): reentry window never
    # elapses; augmented_active_final true; final covariance 6x6.
    e6b_cfg = HEKFConfig(
        process=HProcessNoiseConfig(q_a=0.0, q_a_maneuver=1e-9),
        maneuver=HManeuverConfig(
            estimate_maneuver=True,
            consecutive_exceedances=2,
            reentry_window_obs=10_000,
        ),
    )
    e6b_res = h_ekf_solve(e6_obs, e6_guess, ekf_epoch_jd, e6b_cfg)
    assert e6b_res.augmented_active_final
    assert len(e6b_res.delta_v_estimates) == 1
    e6b_dv_err = float(
        np.linalg.norm(e6b_res.delta_v_estimates[0].delta_v - e6_burn_dv)
    )
    assert e6b_dv_err < 5e-4
    assert e6b_res.final_covariance.shape == (6, 6)
    cases.append(
        make_case(
            case_id="ekf_maneuver_forced_contraction",
            module="od_ekf",
            function="ekf_solve",
            inputs={
                "epoch_jd": r17(ekf_epoch_jd),
                "observations": _bake_obs_flat(e6_obs),
                "state_guess": r17_array(e6_guess),
                "truth_state_final": r17_array(e6_truth_final),
                "burn_dt_s": r17(e6_burn_dt),
                "burn_dv": r17_array(e6_burn_dv),
            },
            config=_bake_ekf_cfg(e6b_cfg),
            expected=_bake_ekf_expected(e6b_res),
            tolerances=_ekf_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_ekf.ekf_solve",
                "note": "E6b: reentry_window_obs=10000 never elapses on "
                "this arc; final forced contraction stores the dv "
                "estimate and returns a 6x6 covariance",
                "dv_err_max_kms": 5e-4,
                "augmented_active_final": True,
            },
        )
    )

    # E7: divergence recovery + negative control (helio
    # test_divergence_recovery): unmodeled burn, no maneuver
    # estimation, sustained_nis_count=5.
    e7_truth = e1_truth
    e7_obs = _ekf_make_arc(
        e7_truth, e6_times, EKF_ALL_STATIONS, burn_dt=e6_burn_dt,
        burn_dv=e6_burn_dv,
    )
    e7_guess = _ekf_offset_guess(e7_truth)
    e7_cfg = HEKFConfig(
        process=HProcessNoiseConfig(q_a=0.0),
        recovery=HRecoveryConfig(sustained_nis_count=5),
    )
    e7_res = h_ekf_solve(e7_obs, e7_guess, ekf_epoch_jd, e7_cfg)
    e7_truth_final = _ekf_truth_state(
        e7_truth, e6_times[-1], e6_burn_dt, e6_burn_dv
    )
    e7_pos_err, e7_vel_err = _ekf_pos_vel_err(e7_res.state_hist[-1, :6], e7_truth_final)
    assert e7_res.divergence_flag and e7_res.n_recoveries >= 1
    assert e7_pos_err < 0.5
    # Negative control: unreachable sustained count never recovers.
    e7_ctrl_cfg = HEKFConfig(
        process=HProcessNoiseConfig(q_a=0.0),
        recovery=HRecoveryConfig(sustained_nis_count=10_000),
    )
    e7_ctrl_res = h_ekf_solve(e7_obs, e7_guess, ekf_epoch_jd, e7_ctrl_cfg)
    e7_ctrl_pos_err, _ = _ekf_pos_vel_err(
        e7_ctrl_res.state_hist[-1, :6], e7_truth_final
    )
    assert not e7_ctrl_res.divergence_flag
    assert e7_ctrl_pos_err > 1.0
    e7_expected = _bake_ekf_expected(e7_res)
    e7_expected["control_final_state"] = r17_array(e7_ctrl_res.state_hist[-1, :6])
    cases.append(
        make_case(
            case_id="ekf_divergence_recovery",
            module="od_ekf",
            function="ekf_solve",
            inputs={
                "epoch_jd": r17(ekf_epoch_jd),
                "observations": _bake_obs_flat(e7_obs),
                "state_guess": r17_array(e7_guess),
                "truth_state_final": r17_array(e7_truth_final),
                "control_config": _bake_ekf_cfg(e7_ctrl_cfg),
            },
            config=_bake_ekf_cfg(e7_cfg),
            expected=e7_expected,
            tolerances=_ekf_tols(),
            meta={
                "source": "helio_ob",
                "reference": "helio.od_ekf.ekf_solve",
                "note": "E7: unmodeled 1 m/s burn with no maneuver "
                "estimation; sustained NIS streak (count=5) triggers "
                "whole-matrix inflation + position/velocity floors; "
                "control with unreachable count never recovers",
                "pos_err_max_km": 0.5,
                "n_recoveries_min": 1,
                "control_pos_err_min_km": 1.0,
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
