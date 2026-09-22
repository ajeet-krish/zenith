import { useMissionStore } from '@/store/useMissionStore';
import type { Satellite } from '@/store/useMissionStore';

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
    const data = JSON.parse(json) as MissionData;

    if (data.version !== 1) {
      return { success: false, error: 'Unsupported mission file version' };
    }

    // Clear existing satellites by re-querying state after each removal
    let current = useMissionStore.getState();
    while (current.satellites.length > 0) {
      const firstSat = current.satellites[0];
      if (!firstSat) break;
      useMissionStore.getState().removeSatellite(firstSat.id);
      current = useMissionStore.getState();
    }

    // Add imported satellites
    for (const sat of data.satellites) {
      useMissionStore.getState().addSatellite({
        name: sat.name,
        noradId: sat.noradId,
        line1: sat.line1,
        line2: sat.line2,
        category: sat.category as Satellite['category'],
        color: sat.color,
        visible: sat.visible,
      });
    }

    // Restore settings
    useMissionStore.getState().setTimeSpeed(data.timeSpeed);
    useMissionStore
      .getState()
      .setPropagationMethod(
        data.propagationMethod as 'sgp4' | 'kepler' | 'rk45'
      );

    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse mission file: ${String(e)}`,
    };
  }
}
