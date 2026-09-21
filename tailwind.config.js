/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Zenith dark base
        'zenith-dark': '#050510',
        'zenith-surface': '#0d0d1a',
        'zenith-card': '#141428',
        'zenith-border': '#1e1e3a',

        // Zenith accent palette
        'zenith-purple': '#a855f7',
        'zenith-blue': '#3b82f6',
        'zenith-cyan': '#06b6d4',
        'zenith-green': '#22c55e',
        'zenith-orange': '#f97316',
        'zenith-red': '#ef4444',

        // Muted text colors
        'zenith-muted': '#6b7280',
        'zenith-subtle': '#9ca3af',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
