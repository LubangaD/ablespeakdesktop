import forms from '@tailwindcss/forms';

/**
 * The screens (docs/design/ui/) are written in Tailwind, so the dashboard uses
 * it too. The single source of truth for the look is src/lib/ui.js, which
 * writes colours as arbitrary values (bg-[#141c28]); the names below are the
 * same values, for the few places that want a name.
 * Fonts are bundled (main.jsx) so the app looks right with no internet.
 *
 * These held the earlier navy palette (#0A1628 / #102038 / #EDF0F5) until
 * 13 Oct 2026. Every page had already moved to the grey-blue values in
 * lib/ui.js, so the names here disagreed with the whole app — `text-ink`
 * alone put #EDF0F5 behind every page's #dae3f4.
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        night: '#0d1627',   // page (one blue behind every section)
        panel: '#141c28',   // sidebar, top bar, side panels
        card: '#141c28',    // cards
        raised: '#222a37',  // selected rows, hover
        well: '#18202d',    // quiet areas, chips
        field: '#0f1724',   // anything you type into
        ink: '#dae3f4',     // text
        muted: '#c9b8a5',   // secondary text (the warm quiet grey)
        faint: '#8b95a7',   // placeholders, menu group headings
        brand: { DEFAULT: '#f5a623', hover: '#ffb955' },
        teal: { DEFAULT: '#24a28e' },
        ok: '#68d9c3',
        warn: '#ffc880',
        bad: '#ffb4ab',
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
