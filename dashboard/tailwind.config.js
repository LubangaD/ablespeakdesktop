import forms from '@tailwindcss/forms';

/**
 * The Stitch screens (docs/design/stitch/) are written in Tailwind, so the
 * dashboard uses it too. Colours are written as the screens write them
 * (bg-[#102038]); the named ones below are the few used everywhere.
 * Fonts are bundled (main.jsx) so the app looks right with no internet.
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        night: '#0D1627',   // page (one blue behind every section)
        panel: '#0A1628',   // sidebar, top bar, side panels
        card: '#102038',    // cards
        raised: '#152A4A',  // selected rows, hover
        well: '#0F1F38',    // quiet buttons, chips
        ink: '#EDF0F5',     // text
        muted: '#94A3B8',   // secondary text
        brand: { DEFAULT: '#F5A623', hover: '#E6960E' },
        teal: { DEFAULT: '#1D9E8A' },
        ok: '#34D399',
        warn: '#FBBF24',
        bad: '#FB7185',
      },
      fontFamily: {
        sans: ['"Roboto Flex Variable"', 'Roboto', 'system-ui', 'sans-serif'],
        heading: ['"Roboto Flex Variable"', 'Roboto', 'system-ui', 'sans-serif'],
        mono: ['"Roboto Mono Variable"', '"Roboto Mono"', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        soundwave: { '0%, 100%': { height: '6px' }, '50%': { height: '20px' } },
      },
      animation: {
        'wave-1': 'soundwave 1.1s ease-in-out infinite',
        'wave-2': 'soundwave 0.8s ease-in-out infinite 0.15s',
        'wave-3': 'soundwave 1.3s ease-in-out infinite 0.3s',
        'wave-4': 'soundwave 0.9s ease-in-out infinite 0.1s',
        'wave-5': 'soundwave 1.2s ease-in-out infinite 0.4s',
      },
    },
  },
  // Only elements that ask for it (form-radio, form-checkbox) get the forms
  // plugin's styles, so other inputs look exactly as the screens draw them.
  plugins: [forms({ strategy: 'class' })],
};
