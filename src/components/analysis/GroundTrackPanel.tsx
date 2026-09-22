import { useAnalysisStore } from '@/store/useAnalysisStore';
import { useMissionStore } from '@/store/useMissionStore';

export function GroundTrackPanel() {
  const showGroundTrack = useAnalysisStore((s) => s.showGroundTrack);
  const groundTrackDays = useAnalysisStore((s) => s.groundTrackDays);
  const groundTrackPoints = useAnalysisStore((s) => s.groundTrackPoints);
  const toggleGroundTrack = useAnalysisStore((s) => s.toggleGroundTrack);
  const setGroundTrackDays = useAnalysisStore((s) => s.setGroundTrackDays);
  const computeGroundTrack = useAnalysisStore((s) => s.computeGroundTrack);
  const selectedSatelliteId = useMissionStore((s) => s.selectedSatelliteId);
  const satellites = useMissionStore((s) => s.satellites);
  const currentEpoch = useMissionStore((s) => s.currentEpoch);

  const selectedSat = satellites.find((s) => s.id === selectedSatelliteId);

  const handleCompute = () => {
    if (selectedSat?.handle != null) {
      computeGroundTrack(selectedSat.handle, currentEpoch);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-comment uppercase tracking-wider">
          Ground Track
        </span>
        <button
          onClick={toggleGroundTrack}
          className={`px-2 py-0.5 text-[10px] font-mono ${
            showGroundTrack
              ? 'bg-neon-green/20 text-neon-green'
              : 'bg-white/5 text-comment'
          }`}
        >
          {showGroundTrack ? 'ON' : 'OFF'}
        </button>
      </div>

      <div>
        <label className="text-[10px] font-mono text-comment block mb-1">
          Duration (days)
        </label>
        <input
          type="number"
          min={0.1}
          max={30}
          step={0.5}
          value={groundTrackDays}
          onChange={(e) => setGroundTrackDays(parseFloat(e.target.value) || 1)}
          className="input-field w-full"
        />
      </div>

      <button
        onClick={handleCompute}
        disabled={!selectedSat}
        className="btn-primary w-full text-[11px] font-mono disabled:opacity-40"
      >
        Compute Ground Track
      </button>

      {groundTrackPoints.length > 0 && (
        <div className="text-[10px] font-mono text-comment">
          {groundTrackPoints.length} points computed
        </div>
      )}

      {!selectedSat && (
        <div className="text-[10px] font-mono text-neon-orange">
          Select a satellite first
        </div>
      )}
    </div>
  );
}
