import { useState, useCallback, useEffect, useRef } from 'react';
import { useMissionStore, CATEGORY_COLORS } from '@/store/useMissionStore';
import { parse_tle, validate_tle_checksum } from '@/processing/tle_parser';
import type { Satellite } from '@/store/useMissionStore';

const CATEGORIES: Satellite['category'][] = ['LEO', 'MEO', 'GEO', 'HEO', 'DEBRIS'];

/**
 * TLEInput - modal panel for adding custom TLE data.
 *
 * Features: text area for TLE pairs, name input, category selector, validation.
 */
export function TLEInput({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [tleText, setTleText] = useState('');
  const [category, setCategory] = useState<Satellite['category']>('LEO');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const addSatellite = useMissionStore((s) => s.addSatellite);
  const loadSampleSatellites = useMissionStore((s) => s.loadSampleSatellites);

  const handleAdd = useCallback(() => {
    setError(null);
    setSuccess(false);

    const lines = tleText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Find line1 and line2
    const line1 = lines.find((l) => l.startsWith('1 '));
    const line2 = lines.find((l) => l.startsWith('2 '));

    if (!line1 || !line2) {
      setError('Invalid TLE format. Expected lines starting with "1 " and "2 ".');
      return;
    }

    // Validate checksums
    if (!validate_tle_checksum(line1)) {
      setError('Line 1 checksum failed. Please verify the TLE data.');
      return;
    }
    if (!validate_tle_checksum(line2)) {
      setError('Line 2 checksum failed. Please verify the TLE data.');
      return;
    }

    // Parse to validate
    try {
      parse_tle(line1, line2);
    } catch (e) {
      setError(`TLE parse error: ${e instanceof Error ? e.message : 'Unknown error'}`);
      return;
    }

    // Extract NORAD ID from line1
    const noradId = parseInt(line1.substring(2, 7).trim(), 10);

    const satName = name.trim() || `SAT-${noradId}`;

    addSatellite({
      name: satName,
      noradId,
      line1,
      line2,
      category,
      color: CATEGORY_COLORS[category],
      visible: true,
    });

    setSuccess(true);
    setName('');
    setTleText('');
    setTimeout(() => {
      setSuccess(false);
      onClose();
    }, 800);
  }, [name, tleText, category, addSatellite, onClose]);

  const handleLoadSamples = useCallback(() => {
    loadSampleSatellites();
    onClose();
  }, [loadSampleSatellites, onClose]);

  // Escape key handler
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Auto-focus modal on mount
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add TLE data"
        tabIndex={-1}
        className="relative w-full max-w-md bg-zenith-surface border border-zenith-border rounded-lg shadow-2xl animate-fade-in-up outline-none"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-zenith-border flex items-center justify-between">
          <span className="text-xs font-mono text-white font-semibold">ADD TLE</span>
          <button
            onClick={onClose}
            className="btn-icon"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Satellite name */}
          <div>
            <label className="block text-[10px] font-mono text-zenith-muted uppercase mb-1">
              Satellite Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional (auto-detect from TLE)"
              className="input-field w-full"
            />
          </div>

          {/* Category selector */}
          <div>
            <label className="block text-[10px] font-mono text-zenith-muted uppercase mb-1">
              Category
            </label>
            <div className="flex gap-1">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono transition-colors ${
                    category === cat
                      ? 'bg-white/10 text-white'
                      : 'text-zenith-muted hover:text-white hover:bg-white/5'
                  }`}
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: CATEGORY_COLORS[cat] }}
                  />
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* TLE text area */}
          <div>
            <label className="block text-[10px] font-mono text-zenith-muted uppercase mb-1">
              TLE Data (paste 2 lines)
            </label>
            <textarea
              value={tleText}
              onChange={(e) => setTleText(e.target.value)}
              placeholder={'1 25544U 98067A   24100.50000000  .00016717  00000-0  10270-3 0  9002\n2 25544  51.6400 200.0000 0005000  50.0000 310.0000 15.49000000 10000'}
              rows={5}
              className="input-field w-full font-mono text-[10px] leading-relaxed resize-none"
              spellCheck={false}
            />
          </div>

          {/* Error/success feedback */}
          {error && (
            <div className="text-[10px] font-mono text-zenith-red bg-zenith-red/10 px-3 py-2 rounded">
              {error}
            </div>
          )}
          {success && (
            <div className="text-[10px] font-mono text-zenith-green bg-zenith-green/10 px-3 py-2 rounded">
              Satellite added successfully.
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              disabled={!tleText.trim()}
              className="flex-1 btn-primary text-[11px] font-mono py-2 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Add Satellite
            </button>
            <button
              onClick={handleLoadSamples}
              className="btn-secondary text-[11px] font-mono py-2"
            >
              Load Samples
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
