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
