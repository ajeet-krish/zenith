import { useState, useMemo } from 'react'
import { useCatalogStore } from '@/store/useCatalogStore'
import { useMissionStore, CATEGORY_COLORS } from '@/store/useMissionStore'
import {
  CATEGORY_LABELS,
  type CelestrakCategory,
  type CelestrakTLE,
} from '@/processing/celestrakApi'
import type { Satellite } from '@/store/useMissionStore'

const CATEGORIES: CelestrakCategory[] = [
  'stations',
  'active',
  'debris',
  'starlink',
  'gps',
  'glonass',
  'galileo',
  'beidou',
]

const CATEGORY_COLORS_MAP: Record<CelestrakCategory, Satellite['category']> = {
  stations: 'LEO',
  active: 'LEO',
  debris: 'DEBRIS',
  starlink: 'LEO',
  gps: 'MEO',
  glonass: 'MEO',
  galileo: 'MEO',
  beidou: 'MEO',
  visual: 'LEO',
  weather: 'GEO',
}

interface CatalogBrowserProps {
  onClose: () => void
}

export function CatalogBrowser({ onClose }: CatalogBrowserProps) {
  const activeCategory = useCatalogStore((s) => s.activeCategory)
  const setActiveCategory = useCatalogStore((s) => s.setActiveCategory)
  const searchQuery = useCatalogStore((s) => s.searchQuery)
  const setSearchQuery = useCatalogStore((s) => s.setSearchQuery)
  const isLoading = useCatalogStore((s) => s.isLoading)
  const error = useCatalogStore((s) => s.error)
  const cachedCategories = useCatalogStore((s) => s.cachedCategories)

  const addSatellite = useMissionStore((s) => s.addSatellite)
  const satellites = useMissionStore((s) => s.satellites)
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set())

  // Get current category entries
  const entries = useMemo(() => {
    if (!activeCategory) return []
    const cached = cachedCategories.get(activeCategory) ?? []
    if (!searchQuery) return cached
    const q = searchQuery.toLowerCase()
    return cached.filter((e) => e.name.toLowerCase().includes(q))
  }, [activeCategory, cachedCategories, searchQuery])

  // Check which entries are already added
  const addedNoradIds = useMemo(() => {
    return new Set(satellites.map((s) => s.noradId))
  }, [satellites])

  const handleAdd = (entry: CelestrakTLE) => {
    if (addedNoradIds.has(entry.noradId)) return

    const category = CATEGORY_COLORS_MAP[activeCategory!] ?? 'LEO'
    addSatellite({
      name: entry.name,
      noradId: entry.noradId,
      line1: entry.line1,
      line2: entry.line2,
      category,
      color: CATEGORY_COLORS[category],
      visible: true,
    })
    setAddedIds((prev) => new Set(prev).add(entry.noradId))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[#0d0d12] border border-dust w-[600px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-dust flex items-center justify-between shrink-0">
          <span className="text-xs font-mono text-comment uppercase tracking-wider">
            CelesTrak Catalog
          </span>
          <button
            onClick={onClose}
            className="text-comment hover:text-white transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Category tabs */}
        <div className="flex border-b border-dust overflow-x-auto shrink-0">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-2 text-[10px] font-mono whitespace-nowrap transition-colors ${
                activeCategory === cat
                  ? 'text-neon-purple bg-neon-purple/10 border-b-2 border-neon-purple'
                  : 'text-comment hover:text-space-50 hover:bg-white/5'
              }`}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-dust shrink-0">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search satellites..."
            className="input-field w-full text-[11px]"
          />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {error && (
            <div className="px-4 py-3 text-[11px] font-mono text-neon-orange bg-neon-orange/5">
              {error}
            </div>
          )}

          {isLoading && (
            <div className="px-4 py-8 text-center">
              <div className="w-4 h-4 rounded-full border-2 border-neon-purple/40 border-t-neon-purple animate-spin mx-auto mb-2" />
              <span className="text-[11px] font-mono text-comment">
                Fetching catalog...
              </span>
            </div>
          )}

          {!isLoading && !error && entries.length === 0 && activeCategory && (
            <div className="px-4 py-8 text-center text-[11px] font-mono text-comment">
              {searchQuery ? 'No matches found' : 'No satellites in this category'}
            </div>
          )}

          {!isLoading && entries.length > 0 && (
            <div className="divide-y divide-dust/50">
              {entries.map((entry) => {
                const isAdded = addedNoradIds.has(entry.noradId) || addedIds.has(entry.noradId)
                return (
                  <div
                    key={entry.noradId}
                    className="px-4 py-2 flex items-center gap-3 hover:bg-white/5 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-mono text-white truncate">
                        {entry.name}
                      </div>
                      <div className="text-[9px] font-mono text-comment">
                        NORAD {entry.noradId}
                      </div>
                    </div>
                    <button
                      onClick={() => handleAdd(entry)}
                      disabled={isAdded}
                      className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors ${
                        isAdded
                          ? 'text-comment/40 bg-white/5 cursor-default'
                          : 'text-neon-green bg-neon-green/10 hover:bg-neon-green/20'
                      }`}
                    >
                      {isAdded ? 'Added' : '+ Add'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-dust flex items-center justify-between text-[10px] font-mono text-comment shrink-0">
          <span>{entries.length} satellite{entries.length !== 1 ? 's' : ''}</span>
          <span>Data from CelesTrak</span>
        </div>
      </div>
    </div>
  )
}
