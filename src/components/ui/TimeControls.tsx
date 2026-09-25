import { useCallback, useEffect, useRef } from 'react';
import { useMissionStore } from '@/store/useMissionStore';
import { sgp4GetElements } from '@/orbit/wasmLoader';
import { MU_EARTH } from '@/orbit/constants';

const SPEED_OPTIONS = [0.1, 0.5, 1, 2, 5, 10];

/**
 * Convert Julian Date to a formatted UTC date string.
 */
function jdToDate(jd: number): Date {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  const a = z < 2299161 ? z : z + 1 + Math.floor((z - 1867216.25) / 36524.25) - Math.floor(
    Math.floor((z - 1867216.25) / 36524.25) / 4
  );
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);

  const dayFrac = b - d - Math.floor(30.6001 * e) + f;
  const day = Math.floor(dayFrac);
  const dayF = dayFrac - day;
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;

  const hours = dayF * 24;
  const h = Math.floor(hours);
  const mins = (hours - h) * 60;
  const m = Math.floor(mins);
  const secs = (mins - m) * 60;
  const s = Math.floor(secs);

  return new Date(Date.UTC(year, month - 1, day, h, m, s));
}

/**
 * Format a Julian Date for display.
 */
function formatJd(jd: number): string {
  const date = jdToDate(jd);
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/**
 * Get the orbital period for the selected satellite (if available).
 */
function getOrbitalPeriod(satId: string | null): number {
  if (!satId) return 5400;
  const state = useMissionStore.getState();
  const sat = state.satellites.find((s) => s.id === satId);
  if (!sat || sat.handle === null) return 5400;

  try {
    const elements = sgp4GetElements(sat.handle, state.currentEpoch);
    if (elements && elements.a > 0) {
      return 2 * Math.PI * Math.sqrt(Math.pow(elements.a, 3) / MU_EARTH);
    }
  } catch {
    // fallback
  }
  return 5400;
}

/**
 * TimeControls - compact horizontal playback bar pinned to the top of the scene.
 *
 * YouTube-style layout: [date] [step-back play/pause step-forward reset] [speed]
 */
export function TimeControls() {
  const currentEpoch = useMissionStore((s) => s.currentEpoch);
  const isPlaying = useMissionStore((s) => s.isPlaying);
  const timeSpeed = useMissionStore((s) => s.timeSpeed);
  const selectedSatelliteId = useMissionStore((s) => s.selectedSatelliteId);
  const setCurrentEpoch = useMissionStore((s) => s.setCurrentEpoch);
  const setIsPlaying = useMissionStore((s) => s.setIsPlaying);
  const setTimeSpeed = useMissionStore((s) => s.setTimeSpeed);
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  // Animation loop
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(animFrameRef.current);
      return;
    }

    const tick = (timestamp: number) => {
      if (lastTimeRef.current === 0) {
        lastTimeRef.current = timestamp;
      }
      const dtMs = timestamp - lastTimeRef.current;
      lastTimeRef.current = timestamp;

      // Convert ms to days, multiply by speed
      const dtDays = (dtMs / 1000) * timeSpeed / 86400;
      const current = useMissionStore.getState().currentEpoch;
      setCurrentEpoch(current + dtDays);

      animFrameRef.current = requestAnimationFrame(tick);
    };

    lastTimeRef.current = 0;
    animFrameRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, timeSpeed, setCurrentEpoch]);

  const handleStep = useCallback((direction: number) => {
    const period = getOrbitalPeriod(selectedSatelliteId);
    const dtDays = (period * direction) / 86400;
    setCurrentEpoch(currentEpoch + dtDays);
  }, [currentEpoch, selectedSatelliteId, setCurrentEpoch]);

  const handleReset = useCallback(() => {
    setCurrentEpoch(Date.now() / 86400000 + 2440587.5);
  }, [setCurrentEpoch]);

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-black/60 backdrop-blur-sm border-b border-white/5 font-mono text-[11px]">
      {/* Date/time display */}
      <span className="text-white tabular-nums shrink-0">
        {formatJd(currentEpoch)}
      </span>

      {/* Divider */}
      <div className="w-px h-4 bg-white/10" />

      {/* Playback controls */}
      <div className="flex items-center gap-0.5">
        {/* Step backward */}
        <button
          onClick={() => handleStep(-1)}
          className="p-1 rounded text-comment hover:text-white hover:bg-white/10 transition-colors"
          title="Step backward 1 period"
          aria-label="Step backward"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="19 20 9 12 19 4" />
            <line x1="5" y1="19" x2="5" y2="5" />
          </svg>
        </button>

        {/* Play/Pause */}
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          className={`p-1 rounded transition-colors ${
            isPlaying
              ? 'text-neon-purple bg-neon-purple/20'
              : 'text-white hover:bg-white/10'
          }`}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21" />
            </svg>
          )}
        </button>

        {/* Step forward */}
        <button
          onClick={() => handleStep(1)}
          className="p-1 rounded text-comment hover:text-white hover:bg-white/10 transition-colors"
          title="Step forward 1 period"
          aria-label="Step forward"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="5 4 15 12 5 20" />
            <line x1="19" y1="5" x2="19" y2="19" />
          </svg>
        </button>

        {/* Reset */}
        <button
          onClick={handleReset}
          className="p-1 rounded text-comment hover:text-white hover:bg-white/10 transition-colors"
          title="Reset to current time"
          aria-label="Reset to current time"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-white/10" />

      {/* Speed selector */}
      <div className="flex items-center gap-0.5">
        {SPEED_OPTIONS.map((speed) => (
          <button
            key={speed}
            onClick={() => setTimeSpeed(speed)}
            className={`px-1 py-0.5 rounded transition-colors ${
              timeSpeed === speed
                ? 'bg-neon-purple/30 text-neon-purple'
                : 'text-comment hover:text-white hover:bg-white/5'
            }`}
            aria-label={`Set speed to ${speed}x`}
          >
            {speed}x
          </button>
        ))}
      </div>
    </div>
  );
}
