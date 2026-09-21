import { create } from 'zustand';
import { SAMPLE_TLES } from '@/orbit/sampleTles';
import { sgp4Init } from '@/orbit/wasmLoader';
import type { SampleTLE } from '@/orbit/types';

// =============================================================================
// Satellite & Mission Types
// =============================================================================

export interface Satellite {
  id: string;
  name: string;
  noradId: number;
  line1: string;
  line2: string;
  category: 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'DEBRIS';
  color: string;
  visible: boolean;
  handle: number | null;
}

interface MissionState {
  // Satellites
  satellites: Satellite[];
  selectedSatelliteId: string | null;

  // Time
  currentEpoch: number;
  isPlaying: boolean;
  timeSpeed: number;

  // Propagation
  propagationMethod: 'sgp4' | 'kepler' | 'rk45';
  forceModels: {
    j2: boolean;
    drag: boolean;
    srp: boolean;
    thirdBody: boolean;
  };

  // UI
  isLoading: boolean;
  wasmReady: boolean;

  // Actions
  addSatellite: (sat: Omit<Satellite, 'id' | 'handle'>) => void;
  removeSatellite: (id: string) => void;
  selectSatellite: (id: string | null) => void;
  toggleSatelliteVisibility: (id: string) => void;
  setCurrentEpoch: (jd: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setTimeSpeed: (speed: number) => void;
  setPropagationMethod: (method: 'sgp4' | 'kepler' | 'rk45') => void;
  toggleForceModel: (model: keyof MissionState['forceModels']) => void;
  setWasmReady: (ready: boolean) => void;
  loadSampleSatellites: () => void;
}

// =============================================================================
// Category Colors
// =============================================================================

export const CATEGORY_COLORS: Record<Satellite['category'], string> = {
  LEO: '#26b8d9',
  MEO: '#22c55e',
  GEO: '#f97316',
  HEO: '#a855f7',
  DEBRIS: '#ef4444',
};

// =============================================================================
// Helpers
// =============================================================================

let nextId = 0;

function makeId(): string {
  return `sat-${++nextId}`;
}

/**
 * Convert a JS Date to Julian Date (UTC).
 */
function dateToJd(date: Date): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate() + date.getUTCHours() / 24;
  const A = Math.floor((14 - m) / 12);
  const Y = y + 4800 - A;
  const M = m + 12 * A - 3;
  return (
    d +
    Math.floor((153 * M + 2) / 5) +
    365 * Y +
    Math.floor(Y / 4) -
    Math.floor(Y / 100) +
    Math.floor(Y / 400) -
    32045 -
    0.5
  );
}

// =============================================================================
// Store
// =============================================================================

export const useMissionStore = create<MissionState>((set, get) => ({
  // Initial state
  satellites: [],
  selectedSatelliteId: null,
  currentEpoch: dateToJd(new Date()),
  isPlaying: false,
  timeSpeed: 1,
  propagationMethod: 'sgp4',
  forceModels: {
    j2: true,
    drag: false,
    srp: false,
    thirdBody: false,
  },
  isLoading: false,
  wasmReady: false,

  // Actions
  addSatellite: (sat) => {
    const id = makeId();
    const handle = sat.line1 && sat.line2
      ? sgp4Init(sat.line1, sat.line2)
      : null;
    set((state) => ({
      satellites: [
        ...state.satellites,
        { ...sat, id, handle },
      ],
    }));
  },

  removeSatellite: (id) => {
    set((state) => ({
      satellites: state.satellites.filter((s) => s.id !== id),
      selectedSatelliteId:
        state.selectedSatelliteId === id ? null : state.selectedSatelliteId,
    }));
  },

  selectSatellite: (id) => {
    set({ selectedSatelliteId: id });
  },

  toggleSatelliteVisibility: (id) => {
    set((state) => ({
      satellites: state.satellites.map((s) =>
        s.id === id ? { ...s, visible: !s.visible } : s
      ),
    }));
  },

  setCurrentEpoch: (jd) => {
    set({ currentEpoch: jd });
  },

  setIsPlaying: (playing) => {
    set({ isPlaying: playing });
  },

  setTimeSpeed: (speed) => {
    set({ timeSpeed: Math.max(0.1, Math.min(100, speed)) });
  },

  setPropagationMethod: (method) => {
    set({ propagationMethod: method });
  },

  toggleForceModel: (model) => {
    set((state) => ({
      forceModels: {
        ...state.forceModels,
        [model]: !state.forceModels[model],
      },
    }));
  },

  setWasmReady: (ready) => {
    set({ wasmReady: ready });
  },

  loadSampleSatellites: () => {
    const { satellites: existing } = get();
    if (existing.length > 0) return;

    const sats: Satellite[] = SAMPLE_TLES.map((tle: SampleTLE) => {
      const handle = sgp4Init(tle.line1, tle.line2);
      return {
        id: makeId(),
        name: tle.name,
        noradId: tle.noradId,
        line1: tle.line1,
        line2: tle.line2,
        category: tle.category,
        color: CATEGORY_COLORS[tle.category],
        visible: true,
        handle,
      };
    });

    set({ satellites: sats });
  },
}));
