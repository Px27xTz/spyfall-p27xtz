import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        soft: '0 8px 30px rgba(0,0,0,0.08)'
      }
    },
  },
  plugins: [],
} satisfies Config
