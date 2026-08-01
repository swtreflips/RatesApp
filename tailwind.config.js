/** @type {import('tailwindcss').Config} */

/*
  This file no longer holds the design — it holds the SHAPE of the design.

  Every value below points at a CSS variable defined by the active skin in `public/skins/`.
  The palette, type, depth, motion and texture live there, so re-skinning the entire app is a
  <link href> swap and touches no component and no config. See public/skins/maritime.css.

  WHY CHANNELS, NOT HEX. A colour is composed as `rgb(var(--c-x) / <alpha-value>)`, so the skin
  stores `242 246 251` rather than `#f2f6fb`. Tailwind substitutes the alpha at build time,
  which is what keeps opacity modifiers alive — `bg-harbor-800/50`, `bg-fog-50/70` and
  `ring-signal-500/30` are all in use, and a variable holding a finished colour breaks every
  one of them silently: the utility simply stops applying.
*/

// 50…950 for every family, so a skin can never define a shade the config forgot to expose.
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const ramp = (name) =>
  Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`]))

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        /* Deep maritime navy — primary surfaces, text, the dark sidebar */
        harbor: ramp('harbor'),
        /* Signal amber — primary actions, active states, key accents */
        signal: ramp('signal'),
        /* Seafoam teal — secondary status, positive signals */
        sea: ramp('sea'),
        /* Warm-cool neutral fog — backgrounds, hairlines, muted text */
        fog: ramp('fog'),
        /* Back-compat alias so any lingering brand-* class keeps working */
        brand: ramp('brand'),
      },
      fontFamily: {
        display: 'var(--font-display)',
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      letterSpacing: {
        tightest: 'var(--tracking-display)',
      },
      borderRadius: {
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        rail: 'var(--shadow-rail)',
        signal: 'var(--shadow-signal)',
      },
      backgroundImage: {
        'harbor-mesh': 'var(--bg-harbor-mesh)',
        'chart-grid': 'var(--bg-chart-grid)',
      },
      transitionDuration: {
        DEFAULT: 'var(--motion-fast)',
        fast: 'var(--motion-fast)',
        base: 'var(--motion-base)',
        slow: 'var(--motion-slow)',
      },
      transitionTimingFunction: {
        expo: 'var(--ease-out-expo)',
      },
      keyframes: {
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        sweep: {
          '0%': { transform: 'translateX(-110%)' },
          '100%': { transform: 'translateX(420%)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
      animation: {
        // Duration and easing come from the skin, so pace is something a variant can change.
        'rise-in': 'rise-in var(--motion-slow) var(--ease-out-expo) both',
        sweep: 'sweep 1.3s ease-in-out infinite',
        'pulse-soft': 'pulse-soft 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
