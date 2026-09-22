import { create } from 'zustand';
import type {
  AnalysisTool,
  ConjunctionEvent,
  MonteCarloResult,
  WalkerDeltaConfig,
  CoverageResult,
} from '@/orbit/types';
import type { HohmannResult, GroundTrackPoint } from '@/orbit/analysisLoader';
import { sgp4Propagate } from '@/orbit/wasmLoader';

// =============================================================================
// Analysis State
// =============================================================================

interface AnalysisState {
  // Active tool
  activeTool: AnalysisTool | null;
  setActiveTool: (tool: AnalysisTool | null) => void;

  // Maneuver
  maneuverAlt1Km: number;
  maneuverAlt2Km: number;
  maneuverResult: HohmannResult | null;
  setManeuverAlt1: (alt: number) => void;
  setManeuverAlt2: (alt: number) => void;
  computeManeuver: () => void;

  // Ground Track
  showGroundTrack: boolean;
  groundTrackDays: number;
  groundTrackPoints: GroundTrackPoint[];
  toggleGroundTrack: () => void;
  setGroundTrackDays: (days: number) => void;
  computeGroundTrack: (handle: number, epochJd: number) => void;

  // Conjunction
  conjunctionEvents: ConjunctionEvent[];
  conjunctionDistanceKm: number;
  setConjunctionDistance: (km: number) => void;

  // Monte Carlo
  mcResult: MonteCarloResult | null;
  showMcCloud: boolean;
  showMcEllipsoid: boolean;
  toggleMcCloud: () => void;
  toggleMcEllipsoid: () => void;

  // Coverage
  walkerConfig: WalkerDeltaConfig;
  coverageResult: CoverageResult | null;
  setWalkerConfig: (config: Partial<WalkerDeltaConfig>) => void;
}

// =============================================================================
// Store
// =============================================================================

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  // Active tool
  activeTool: null,
  setActiveTool: (tool) => set({ activeTool: tool }),

  // Maneuver
  maneuverAlt1Km: 400,
  maneuverAlt2Km: 35786,
  maneuverResult: null,
  setManeuverAlt1: (alt) => set({ maneuverAlt1Km: alt }),
  setManeuverAlt2: (alt) => set({ maneuverAlt2Km: alt }),
  computeManeuver: () => {
    const { maneuverAlt1Km, maneuverAlt2Km } = get();
    // Dynamic import to avoid circular deps
    import('@/orbit/analysisLoader').then(({ hohmannFromAltitudes }) => {
      const result = hohmannFromAltitudes(maneuverAlt1Km, maneuverAlt2Km);
      set({ maneuverResult: result });
    });
  },

  // Ground Track
  showGroundTrack: false,
  groundTrackDays: 1,
  groundTrackPoints: [],
  toggleGroundTrack: () => set((s) => ({ showGroundTrack: !s.showGroundTrack })),
  setGroundTrackDays: (days) => set({ groundTrackDays: days }),
  computeGroundTrack: (handle, epochJd) => {
    const { groundTrackDays } = get();
    const timeStepS = 60;
    const totalSeconds = groundTrackDays * 86400;
    const nSteps = Math.ceil(totalSeconds / timeStepS);

    // Build trajectory as flat array for WASM
    const flatTrajectory: number[] = [];
    for (let i = 0; i <= nSteps; i++) {
      const tSec = i * timeStepS;
      const jd = epochJd + tSec / 86400;
      const sv = sgp4Propagate(handle, jd);
      if (sv) {
        flatTrajectory.push(sv.x, sv.y, sv.z, sv.vx, sv.vy, sv.vz, jd);
      }
    }

    if (flatTrajectory.length === 0) {
      set({ groundTrackPoints: [] });
      return;
    }

    import('@/orbit/analysisLoader').then(({ computeGroundTrack }) => {
      const points = computeGroundTrack(flatTrajectory);
      set({ groundTrackPoints: points ?? [] });
    });
  },

  // Conjunction
  conjunctionEvents: [],
  conjunctionDistanceKm: 10,
  setConjunctionDistance: (km) => set({ conjunctionDistanceKm: km }),

  // Monte Carlo
  mcResult: null,
  showMcCloud: false,
  showMcEllipsoid: false,
  toggleMcCloud: () => set((s) => ({ showMcCloud: !s.showMcCloud })),
  toggleMcEllipsoid: () => set((s) => ({ showMcEllipsoid: !s.showMcEllipsoid })),

  // Coverage
  walkerConfig: {
    inclinationRad: (51.6 * Math.PI) / 180,
    totalSats: 24,
    numPlanes: 6,
    phasingFactor: 1,
    altitudeKm: 20200,
  },
  coverageResult: null,
  setWalkerConfig: (config) =>
    set((s) => ({
      walkerConfig: { ...s.walkerConfig, ...config },
    })),
}));
