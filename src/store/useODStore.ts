import { create } from 'zustand';
import { createStation, destroyStation } from '@/orbit/stations';
import { runGaussIod } from '@/orbit/iodGauss';
import { runBatchSolve } from '@/orbit/odBatch';
import type {
  BatchAPriori,
  BatchTsConfig,
  BatchTsResult,
  GaussIodConfig,
  GaussIodObservation,
  GaussIodTsResult,
  ObservationSimConfig,
  ODStation,
  ODObservation,
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
    });
  },
}));
