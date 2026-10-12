import { create } from 'zustand';
import { createStation, destroyStation } from '@/orbit/stations';
import { runGaussIod } from '@/orbit/iodGauss';
import { runBatchSolve } from '@/orbit/odBatch';
import { runEkfSolve } from '@/orbit/odEkf';
import type {
  BatchAPriori,
  BatchTsConfig,
  BatchTsResult,
  EkfTsConfig,
  EkfTsResult,
  GaussIodConfig,
  GaussIodObservation,
  GaussIodTsResult,
  ObservationSimConfig,
  ODStation,
  ODObservation,
  ScheduledManeuver,
} from '@/orbit/types';

// =============================================================================
// Orbit Determination Store
// =============================================================================
// Manages ground stations (owning their WASM handles), simulated
// observations, and the observation simulator config. Independent from
// useMissionStore.

const DEFAULT_SIM_CONFIG: ObservationSimConfig = {
  noiseScale: 1,
  cadenceSec: 60,
  arcHours: 1,
  stationNames: ['goldstone'],
};

interface ODState {
  // Stations
  stations: ODStation[];
  selectedStationId: string | null;

  // Observations
  observations: ODObservation[];
  simConfig: ObservationSimConfig;

  // Gauss IOD
  iodResult: GaussIodTsResult | null;

  // Batch LSQ OD (Phase 3)
  batchResult: BatchTsResult | null;
  batchIsRunning: boolean;

  // Sequential EKF OD (Phase 4)
  ekfResult: EkfTsResult | null;
  ekfIsRunning: boolean;
  /** Solve progress 0-100 (synchronous solve: 0 while running, 100 when done). */
  ekfProgress: number;
  /** Known impulsive burns passed to the next EKF solve (kept ascending by epoch). */
  scheduledManeuvers: ScheduledManeuver[];

  // Actions
  addStation: (name: string, latRad: number, lonRad: number, altKm: number) => void;
  removeStation: (id: string) => void;
  selectStation: (id: string | null) => void;
  setSimConfig: (partial: Partial<ObservationSimConfig>) => void;
  setObservations: (obs: ODObservation[]) => void;
  appendObservations: (obs: ODObservation[]) => void;
  clearObservations: () => void;
  runIod: (observations: GaussIodObservation[], config?: Partial<GaussIodConfig>) => void;
  clearIodResult: () => void;
  runBatch: (
    stateGuess: number[],
    epochJd: number,
    config?: Partial<BatchTsConfig>,
    apriori?: BatchAPriori | null
  ) => void;
  clearBatchResult: () => void;
  runEkf: (state0: number[], epochJd: number, config?: Partial<EkfTsConfig>) => void;
  clearEkfResult: () => void;
  addScheduledManeuver: (maneuver: ScheduledManeuver) => void;
  removeScheduledManeuver: (index: number) => void;
  clearScheduledManeuvers: () => void;
  clearAll: () => void;
}

// =============================================================================
// Helpers
// =============================================================================

let nextId = 0;

function makeId(): string {
  return `sta-${++nextId}`;
}

// =============================================================================
// Store
// =============================================================================

export const useODStore = create<ODState>((set, get) => ({
  // Initial state
  stations: [],
  selectedStationId: null,
  observations: [],
  simConfig: { ...DEFAULT_SIM_CONFIG },
  iodResult: null,
  batchResult: null,
  batchIsRunning: false,
  ekfResult: null,
  ekfIsRunning: false,
  ekfProgress: 0,
  scheduledManeuvers: [],

  // Actions
  addStation: (name, latRad, lonRad, altKm) => {
    const handle = createStation(name, latRad, lonRad, altKm);
    const station: ODStation = {
      id: makeId(),
      name,
      latRad,
      lonRad,
      altKm,
      handle,
    };
    set((state) => ({
      stations: [...state.stations, station],
    }));
  },

  removeStation: (id) => {
    const state = get();
    const station = state.stations.find((s) => s.id === id);
    if (station?.handle != null) {
      destroyStation(station.handle);
    }
    set((state) => ({
      stations: state.stations.filter((s) => s.id !== id),
      selectedStationId:
        state.selectedStationId === id ? null : state.selectedStationId,
    }));
  },

  selectStation: (id) => {
    set({ selectedStationId: id });
  },

  setSimConfig: (partial) => {
    set((state) => ({
      simConfig: { ...state.simConfig, ...partial },
    }));
  },

  setObservations: (obs) => {
    set({ observations: obs });
  },

  appendObservations: (obs) => {
    set((state) => ({
      observations: [...state.observations, ...obs],
    }));
  },

  clearObservations: () => {
    set({ observations: [] });
  },

  runIod: (observations, config) => {
    try {
      // Null result (no WASM, bad input) clears any previous solve.
      set({ iodResult: runGaussIod(observations, config) });
    } catch {
      set({ iodResult: null });
    }
  },

  clearIodResult: () => {
    set({ iodResult: null });
  },

  runBatch: (stateGuess, epochJd, config, apriori) => {
    set({ batchIsRunning: true });
    try {
      // Null result (no WASM, unresolvable station, bad input) clears any
      // previous solve; solver-level errors come back as a typed result.
      const result = runBatchSolve({
        observations: get().observations,
        stateGuess,
        epochJd,
        config,
        apriori,
      });
      set({ batchResult: result });
    } catch {
      set({ batchResult: null });
    } finally {
      set({ batchIsRunning: false });
    }
  },

  clearBatchResult: () => {
    set({ batchResult: null });
  },

  runEkf: (state0, epochJd, config) => {
    set({ ekfIsRunning: true, ekfProgress: 0 });
    try {
      // Null result (no WASM, unresolvable station, bad input) clears any
      // previous solve; solver-level errors come back as a typed result.
      const result = runEkfSolve({
        observations: get().observations,
        state0,
        epochJd,
        config,
        scheduledBurns: get().scheduledManeuvers,
      });
      set({ ekfResult: result });
    } catch {
      set({ ekfResult: null });
    } finally {
      set({ ekfIsRunning: false, ekfProgress: 100 });
    }
  },

  clearEkfResult: () => {
    set({ ekfResult: null, ekfProgress: 0 });
  },

  addScheduledManeuver: (maneuver) => {
    // The kernel requires burns in ascending epoch order; keep the list
    // sorted on insert so callers never have to.
    set((state) => {
      const next = [...state.scheduledManeuvers, maneuver];
      next.sort((a, b) => a.epochJd - b.epochJd);
      return { scheduledManeuvers: next };
    });
  },

  removeScheduledManeuver: (index) => {
    set((state) => ({
      scheduledManeuvers: state.scheduledManeuvers.filter((_, i) => i !== index),
    }));
  },

  clearScheduledManeuvers: () => {
    set({ scheduledManeuvers: [] });
  },

  clearAll: () => {
    const state = get();
    for (const station of state.stations) {
      if (station.handle != null) {
        destroyStation(station.handle);
      }
    }
    set({
      stations: [],
      selectedStationId: null,
      observations: [],
      simConfig: { ...DEFAULT_SIM_CONFIG },
      iodResult: null,
      batchResult: null,
      batchIsRunning: false,
      ekfResult: null,
      ekfIsRunning: false,
      ekfProgress: 0,
      scheduledManeuvers: [],
    });
  },
}));
