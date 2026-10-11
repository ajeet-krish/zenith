// =============================================================================
// Zenith Web - OD Ground Station WASM Wrappers
// =============================================================================
// Handle-based wrappers around the od_station_* embind exports. Follows the
// wasmLoader.ts WASM-first pattern: every call degrades gracefully (returns
// null) when the WASM module is not loaded. A small TS-side registry mirrors
// the station geometry so the ECI/ECEF helpers keep working in pure-JS demo
// mode and in unit tests (the embind surface currently exports only
// create/destroy; position/velocity/elevation are computed here in TS).

import { getWasmModule } from './wasmLoader'
import { OMEGA_EARTH, DEG_TO_RAD } from './constants'

/** WGS-84 semi-major axis [km]. */
const WGS84_A = 6378.137
/** WGS-84 first eccentricity squared. */
const WGS84_E2 = 6.69437999014e-3

// =============================================================================
// TS-side station registry (handle -> geometry)
// =============================================================================

interface StationRecord {
    name: string
    latRad: number
    lonRad: number
    altKm: number
}

const station_registry: Map<number, StationRecord> = new Map()

/**
 * Get a station record, preferring the WASM-created handle's mirrored
 * geometry. Returns null for unknown handles.
 */
function get_record(handle: number): StationRecord | null {
    return station_registry.get(handle) ?? null
}

// =============================================================================
// TS geometry helpers (match C++ coordinate_frames.hpp / time_system.hpp)
// =============================================================================

/** Greenwich Mean Sidereal Time [rad] in [0, 2*PI) (IAU 1982 / Vallado). */
export function jd_to_gmst_ts(jd: number): number {
    const t_ut1 = (jd - 2451545.0) / 36525.0
    const gmst_sec =
        67310.54841 +
        (876600.0 * 3600.0 + 8640184.812866) * t_ut1 +
        0.093104 * t_ut1 * t_ut1 -
        6.2e-6 * t_ut1 * t_ut1 * t_ut1
    const gmst_rad = ((gmst_sec / 240.0) * DEG_TO_RAD) % (2 * Math.PI)
    return gmst_rad < 0 ? gmst_rad + 2 * Math.PI : gmst_rad
}

/** Rotate a 3-vector about +z by angle [rad]. */
function rotate_z(x: number, y: number, z: number, angle: number): [number, number, number] {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return [x * c - y * s, x * s + y * c, z]
}

/** Geodetic LLA [rad, rad, km] to ECEF [km] on the WGS-84 ellipsoid. */
export function lla_to_ecef_ts(latRad: number, lonRad: number, altKm: number): [number, number, number] {
    const sin_lat = Math.sin(latRad)
    const cos_lat = Math.cos(latRad)
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sin_lat * sin_lat)
    return [
        (n + altKm) * cos_lat * Math.cos(lonRad),
        (n + altKm) * cos_lat * Math.sin(lonRad),
        (n * (1 - WGS84_E2) + altKm) * sin_lat,
    ]
}

// =============================================================================
// Station lifecycle (WASM-first)
// =============================================================================

/**
 * Create a ground station in WASM and return its handle.
 * Returns null when WASM is not ready or creation failed.
 */
export function createStation(name: string, latRad: number, lonRad: number, altKm: number): number | null {
    const mod = getWasmModule()
    if (!mod) return null
    try {
        const handle = mod.od_station_create(name, latRad, lonRad, altKm) as number
        if (handle === 0) {
            console.warn('od_station_create returned 0 (error)')
            return null
        }
        // Mirror geometry for TS fallbacks and unit tests.
        station_registry.set(handle, { name, latRad, lonRad, altKm })
        return handle
    } catch (e) {
        console.warn('od_station_create failed:', e)
        return null
    }
}

/**
 * Destroy a ground station handle and free its WASM resources.
 */
export function destroyStation(handle: number): void {
    const mod = getWasmModule()
    if (mod) {
        try {
            mod.od_station_destroy(handle)
        } catch {
            /* ignore - handle may not exist in WASM */
        }
    }
    station_registry.delete(handle)
}

// =============================================================================
// Station geometry (WASM-first with TS fallback from the registry)
// =============================================================================

/** Station position in ECI/TEME [km] at Julian Date, or null if unknown. */
export function stationPositionEci(handle: number, jd: number): { x: number; y: number; z: number } | null {
    const mod = getWasmModule()
    if (mod && typeof mod.od_station_position_eci === 'function') {
        try {
            const p = mod.od_station_position_eci(handle, jd)
            if (p) return { x: p.x, y: p.y, z: p.z }
        } catch (e) {
            console.warn('od_station_position_eci failed, using TS fallback:', e)
        }
    }
    const rec = get_record(handle)
    if (!rec) return null
    const [ex, ey, ez] = lla_to_ecef_ts(rec.latRad, rec.lonRad, rec.altKm)
    const [x, y, z] = rotate_z(ex, ey, ez, jd_to_gmst_ts(jd))
    return { x, y, z }
}

/** Station velocity in ECI/TEME [km/s] at Julian Date (Earth rotation only). */
export function stationVelocityEci(handle: number, jd: number): { x: number; y: number; z: number } | null {
    const mod = getWasmModule()
    if (mod && typeof mod.od_station_velocity_eci === 'function') {
        try {
            const v = mod.od_station_velocity_eci(handle, jd)
            if (v) return { x: v.x, y: v.y, z: v.z }
        } catch (e) {
            console.warn('od_station_velocity_eci failed, using TS fallback:', e)
        }
    }
    const pos = stationPositionEci(handle, jd)
    if (!pos) return null
    // v_eci = omega x r_eci with omega = (0, 0, OMEGA_EARTH).
    return {
        x: -OMEGA_EARTH * pos.y,
        y: OMEGA_EARTH * pos.x,
        z: 0,
    }
}

/** Elevation angle of an ECI target above the local horizon [rad]. */
export function stationElevation(
    handle: number,
    r_eci: { x: number; y: number; z: number },
    jd: number
): number | null {
    const mod = getWasmModule()
    if (mod && typeof mod.od_station_elevation === 'function') {
        try {
            const el = mod.od_station_elevation(handle, r_eci.x, r_eci.y, r_eci.z, jd)
            if (typeof el === 'number') return el
        } catch (e) {
            console.warn('od_station_elevation failed, using TS fallback:', e)
        }
    }
    const rec = get_record(handle)
    if (!rec) return null
    const [sx, sy, sz] = lla_to_ecef_ts(rec.latRad, rec.lonRad, rec.altKm)
    const [tx, ty, tz] = rotate_z(r_eci.x, r_eci.y, r_eci.z, -jd_to_gmst_ts(jd))
    const dx = tx - sx
    const dy = ty - sy
    const dz = tz - sz
    // SEZ projection (South, East, Zenith).
    const sin_lat = Math.sin(rec.latRad)
    const cos_lat = Math.cos(rec.latRad)
    const sin_lon = Math.sin(rec.lonRad)
    const cos_lon = Math.cos(rec.lonRad)
    const south = -sin_lat * cos_lon * dx - sin_lat * sin_lon * dy + cos_lat * dz
    const east = -sin_lon * dx + cos_lon * dy
    const zenith = cos_lat * cos_lon * dx + cos_lat * sin_lon * dy + sin_lat * dz
    const range = Math.sqrt(south * south + east * east + zenith * zenith)
    if (range < 1e-12) return 0
    return Math.asin(Math.max(-1, Math.min(1, zenith / range)))
}
