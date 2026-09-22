import { useMissionStore } from '@/store/useMissionStore';
import type { Satellite } from '@/store/useMissionStore';

// =============================================================================
// Validation Constants
// =============================================================================

const VALID_CATEGORIES = ['LEO', 'MEO', 'GEO', 'HEO', 'DEBRIS'] as const
const VALID_METHODS = ['sgp4', 'kepler', 'rk45'] as const

function isValidCategory(c: string): boolean {
  return (VALID_CATEGORIES as readonly string[]).includes(c)
}

function isValidMethod(m: string): boolean {
  return (VALID_METHODS as readonly string[]).includes(m)
}

interface MissionData {
  version: 1;
  satellites: Array<{
    name: string;
    noradId: number;
    line1: string;
    line2: string;
    category: string;
    color: string;
    visible: boolean;
  }>;
  timeSpeed: number;
  propagationMethod: string;
  exportDate: string;
}

/**
 * Export current mission configuration to JSON.
 */
export function exportMission(): string {
  const state = useMissionStore.getState();

  const data: MissionData = {
    version: 1,
    satellites: state.satellites.map((sat: Satellite) => ({
      name: sat.name,
      noradId: sat.noradId,
      line1: sat.line1,
      line2: sat.line2,
      category: sat.category,
      color: sat.color,
      visible: sat.visible,
    })),
    timeSpeed: state.timeSpeed,
    propagationMethod: state.propagationMethod,
    exportDate: new Date().toISOString(),
  };

  return JSON.stringify(data, null, 2);
}

/**
 * Download mission as JSON file.
 */
export function downloadMission(): void {
  const json = exportMission();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zenith-mission-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Import mission from JSON file.
 */
export function importMission(
  json: string
): { success: boolean; error?: string } {
  try {
    const data = JSON.parse(json) as Record<string, unknown>

    // Structural validation
    if (!data || typeof data !== 'object') {
      return { success: false, error: 'Invalid mission file format' }
    }
    if (data.version !== 1) {
      return { success: false, error: 'Unsupported mission file version' }
    }
    if (!Array.isArray(data.satellites)) {
      return { success: false, error: 'Missing or invalid satellites array' }
    }

    // Validate settings
    if (typeof data.timeSpeed !== 'number' || data.timeSpeed < 0.1 || data.timeSpeed > 100) {
      return { success: false, error: 'Invalid time speed value' }
    }
    if (typeof data.propagationMethod !== 'string' || !isValidMethod(data.propagationMethod)) {
      return { success: false, error: 'Invalid propagation method' }
    }

    const store = useMissionStore.getState()

    // Clear existing satellites
    while (store.satellites.length > 0) {
      const current = useMissionStore.getState()
      if (current.satellites.length === 0) break
      current.removeSatellite(current.satellites[0]!.id)
    }

    // Validate and add imported satellites
    for (const sat of data.satellites) {
      if (!sat || typeof sat !== 'object') continue
      const s = sat as Record<string, unknown>
      if (typeof s.name !== 'string' || typeof s.line1 !== 'string' || typeof s.line2 !== 'string') continue
      if (typeof s.noradId !== 'number') continue
      if (typeof s.category !== 'string' || !isValidCategory(s.category)) continue

      useMissionStore.getState().addSatellite({
        name: s.name as string,
        noradId: s.noradId as number,
        line1: s.line1 as string,
        line2: s.line2 as string,
        category: s.category as Satellite['category'],
        color: typeof s.color === 'string' ? (s.color as string) : '#8be9fd',
        visible: s.visible !== false,
      })
    }

    // Restore settings
    useMissionStore.getState().setTimeSpeed(data.timeSpeed as number)
    useMissionStore
      .getState()
      .setPropagationMethod(data.propagationMethod as 'sgp4' | 'kepler' | 'rk45')

    return { success: true }
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse mission file: ${String(e)}`,
    }
  }
}
