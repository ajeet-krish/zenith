import { useEffect } from 'react';
import { useMissionStore } from '@/store/useMissionStore';

/**
 * Global keyboard shortcuts for the mission planner.
 *
 * Shortcuts:
 *   Space: play/pause
 *   R: reset time to current epoch
 *   +/=: increase time speed
 *   -: decrease time speed
 *   Delete/Backspace: remove selected satellite
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire when typing in an input
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      const store = useMissionStore.getState();

      switch (e.key) {
        case ' ':
          e.preventDefault();
          store.setIsPlaying(!store.isPlaying);
          break;
        case 'r':
        case 'R':
          store.setCurrentEpoch(Date.now() / 86400000 + 2440587.5);
          break;
        case '+':
        case '=':
          store.setTimeSpeed(Math.min(100, store.timeSpeed * 2));
          break;
        case '-':
          store.setTimeSpeed(Math.max(0.1, store.timeSpeed / 2));
          break;
        case 'Delete':
        case 'Backspace':
          if (store.selectedSatelliteId) {
            store.removeSatellite(store.selectedSatelliteId);
          }
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
