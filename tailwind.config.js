/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        /* Deep maritime navy — primary surfaces, text, the dark sidebar */
        harbor: {
          50:  '#f2f6fb',
          100: '#e3ebf4',
          200: '#c3d4e6',
          300: '#98b3d1',
          400: '#668bb4',
          500: '#456c98',
          600: '#33547b',
          700: '#284363',
          800: '#1d3149',
          900: '#132236',
          950: '#0b1726',
        },
        /* Signal amber — primary actions, active states, key accents */
        signal: {
          50:  '#fff8ea',
          100: '#ffedc6',
          200: '#ffd989',
          300: '#ffc04d',
          400: '#ffab24',
          500: '#f5a524',
          600: '#d97e0a',
          700: '#b45a0c',
          800: '#924711',
          900: '#783b12',
          950: '#451d05',
        },
        /* Seafoam teal — secondary status, positive signals */
        sea: {
          50:  '#eefbf7',
          100: '#d4f5ec',
          200: '#ade9da',
          300: '#78d6c2',
          400: '#43bba6',
          500: '#239f8c',
          600: '#178072',
          700: '#16665c',
          800: '#16514a',
          900: '#16433e',
          950: '#062724',
        },
        /* Warm-cool neutral fog — backgrounds, hairlines, muted text */
        fog: {
          50:  '#f7f8fa',
          100: '#eef1f4',
          200: '#dfe4ea',
          300: '#c7cfd8',
          400: '#9aa6b4',
          500: '#6f7d8d',
          600: '#566270',
          700: '#444e5a',
          800: '#2e353e',
          900: '#1b2027',
        },
        /* Back-compat alias so any lingering brand-* class keeps working */
        brand: {
          50:  '#fff8ea',
          100: '#ffedc6',
          200: '#ffd989',
          300: '#ffc04d',
          400: '#ffab24',
          500: '#f5a524',
          600: '#d97e0a',
          700: '#b45a0c',
          800: '#924711',
          900: '#783b12',
          950: '#451d05',
        },
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'ui-serif', 'Georgia', 'serif'],
        sans:    ['"Hanken Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      letterSpacing: {
        tightest: '-0.04em',
      },
      boxShadow: {
        /* Soft layered depth for cards on light surfaces */
        card:    '0 1px 2px rgba(11, 23, 38, 0.04), 0 8px 24px -12px rgba(11, 23, 38, 0.18)',
        'card-hover': '0 2px 4px rgba(11, 23, 38, 0.06), 0 16px 40px -16px rgba(11, 23, 38, 0.28)',
        /* Inset glow for the dark sidebar rail */
        rail:    'inset -1px 0 0 rgba(255,255,255,0.04)',
        signal:  '0 6px 20px -8px rgba(217, 126, 10, 0.6)',
      },
      backgroundImage: {
        /* Atmospheric navy gradient for dark surfaces */
        'harbor-mesh':
          'radial-gradient(110% 120% at 0% 0%, #1d3149 0%, #132236 45%, #0b1726 100%)',
        /* Faint navigational grid — applied at low opacity over surfaces */
        'chart-grid':
          'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
      },
      keyframes: {
        'rise-in': {
          '0%':   { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'sweep': {
          '0%':   { transform: 'translateX(-110%)' },
          '100%': { transform: 'translateX(420%)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.45' },
        },
      },
      animation: {
        'rise-in': 'rise-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
        'sweep': 'sweep 1.3s ease-in-out infinite',
        'pulse-soft': 'pulse-soft 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
