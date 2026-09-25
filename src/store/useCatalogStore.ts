import { create } from 'zustand'
import {
  fetchCelestrakCategory,
  type CelestrakCategory,
  type CelestrakTLE,
} from '@/processing/celestrakApi'

interface CatalogState {
  activeCategory: CelestrakCategory | null
  cachedCategories: Map<CelestrakCategory, CelestrakTLE[]>
  isLoading: boolean
  error: string | null
  searchQuery: string

  setActiveCategory: (cat: CelestrakCategory) => void
  setSearchQuery: (q: string) => void
  fetchCategory: (cat: CelestrakCategory) => Promise<void>
  clearError: () => void
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  activeCategory: null,
  cachedCategories: new Map(),
  isLoading: false,
  error: null,
  searchQuery: '',

  setActiveCategory: (cat) => {
    set({ activeCategory: cat, searchQuery: '' })
    // Auto-fetch if not cached
    if (!get().cachedCategories.has(cat)) {
      get().fetchCategory(cat)
    }
  },

  setSearchQuery: (q) => set({ searchQuery: q }),

  fetchCategory: async (cat) => {
    // Don't refetch if cached
    if (get().cachedCategories.has(cat)) return

    set({ isLoading: true, error: null })
    try {
      const entries = await fetchCelestrakCategory(cat)
      const newCache = new Map(get().cachedCategories)
      newCache.set(cat, entries)
      set({ cachedCategories: newCache, isLoading: false })
    } catch (e) {
      set({
        isLoading: false,
        error: e instanceof Error ? e.message : 'Failed to fetch catalog',
      })
    }
  },

  clearError: () => set({ error: null }),
}))
