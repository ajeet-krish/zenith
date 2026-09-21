/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dracula background scale
        void: '#0a0a0f',
        'deep-space': '#0f0f15',
        nebula: '#282a36',
        'card-surface': '#21222c',
        dust: '#44475a',
        comment: '#6272a4',

        // Backward-compatible space scale (remapped to Dracula)
        space: {
          50: '#f8f8f2',
          100: '#f8f8f2',
          200: '#f8f8f2',
          300: '#e0e0e0',
          400: '#b0b0b0',
          500: '#6272a4',
          600: '#6272a4',
          700: '#44475a',
          800: '#44475a',
          900: '#282a36',
          950: '#0a0a0f',
        },

        // Neon palette (Dracula accents)
        neon: {
          purple: '#bd93f9',
          cyan: '#8be9fd',
          green: '#50fa7b',
          pink: '#ff79c6',
          orange: '#ffb86c',
          red: '#ff5555',
          yellow: '#f1fa8c',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
