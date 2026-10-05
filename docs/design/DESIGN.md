---
name: AbleSpeak Assistive Voice AI
colors:
  surface: '#0b1420'
  surface-dim: '#0b1420'
  surface-bright: '#313a47'
  surface-container-lowest: '#060e1b'
  surface-container-low: '#141c28'
  surface-container: '#18202d'
  surface-container-high: '#222a37'
  surface-container-highest: '#2d3543'
  on-surface: '#dae3f4'
  on-surface-variant: '#d7c3ae'
  inverse-surface: '#dae3f4'
  inverse-on-surface: '#28313e'
  outline: '#9f8e7a'
  outline-variant: '#524534'
  surface-tint: '#ffb955'
  primary: '#ffc880'
  on-primary: '#452b00'
  primary-container: '#f5a623'
  on-primary-container: '#644000'
  inverse-primary: '#835500'
  secondary: '#68d9c3'
  on-secondary: '#00382f'
  secondary-container: '#24a28e'
  on-secondary-container: '#003029'
  tertiary: '#54ebaf'
  on-tertiary: '#003825'
  tertiary-container: '#2cce94'
  on-tertiary-container: '#005238'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffddb4'
  primary-fixed-dim: '#ffb955'
  on-primary-fixed: '#291800'
  on-primary-fixed-variant: '#633f00'
  secondary-fixed: '#86f6df'
  secondary-fixed-dim: '#68d9c3'
  on-secondary-fixed: '#00201b'
  on-secondary-fixed-variant: '#005045'
  tertiary-fixed: '#68fcbf'
  tertiary-fixed-dim: '#45dfa4'
  on-tertiary-fixed: '#002114'
  on-tertiary-fixed-variant: '#005137'
  background: '#0b1420'
  on-background: '#dae3f4'
  surface-variant: '#2d3543'
typography:
  headline-xl:
    fontFamily: Space Grotesk
    fontSize: 44px
    fontWeight: '700'
    lineHeight: 52px
    letterSpacing: -0.02em
  headline-xl-mobile:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Space Grotesk
    fontSize: 26px
    fontWeight: '600'
    lineHeight: 34px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-sm:
    fontFamily: Space Grotesk
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 22px
    letterSpacing: 0.01em
  label-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 18px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.04em
  status-badge:
    fontFamily: Space Grotesk
    fontSize: 13px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.06em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-mobile: 1rem
  margin: 2rem
  margin-mobile: 1rem
  space-xs: 0.375rem
  space-sm: 0.75rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

This design system establishes a high-performance, dignified assistive speech and voice interface tailored for individuals with speech, motor, and neurodivergent accessibility needs. The visual posture combines the technical precision of clinical software with the warmth, respect, and agency of personal expression tools.

The design movement blends **Tactile Glassmorphism** with **High-Contrast Utilitarian Ergonomics**. Dark night-navy foundations prevent optical fatigue during prolonged gaze or screen reader use, while tactile glass layering builds depth without sacrificing edge definition. High-visibility chromatic focal points guide users through high-stakes communicative states.

Key behavioral and visual tenets:
- **Zero Ambiguity & Multimodal Clarity**: Crucial states (Listening, Processing, Speaking, Idle) are never communicated by color alone. Every interactive state couples color with explicit iconography, physical micro-elevation, and typographic state markers.
- **Motor-First Target Ergonomics**: All actionable surfaces enforce a strict minimum interaction footprint of 48×48px with generous internal and peripheral hit-box cushioning.
- **Dignity & Calm**: Tactile surfaces feel structured, responsive, and steady. Vibrations, transitions, and state pulses are smooth, predictable, and devoid of rapid flashing to prevent sensory distress.

## Colors

The palette is engineered specifically for WCAG AAA and AA compliance in dark environments, ensuring that every communicative layer provides high luminance contrast.

### Palette Architecture
- **Canvas Base (`#050D19`)**: Deep nocturnal navy canvas. It absorbs glare and minimizes haloing around large text.
- **Surface Elevation Layers**:
  - `surface-container-low`: `#0A1628` (glass substrate base)
  - `surface-container-mid`: `#102038` (elevated interaction tiles, phrase cards)
  - `surface-container-high`: `#172C4C` (floating panels, quick-action dialogs)
  - `surface-border`: `rgba(255, 255, 255, 0.08)` (subtle structural divider)
  - `surface-border-active`: `rgba(255, 255, 255, 0.22)` (focus/hover structural delimiter)
- **Primary Warm Amber (`#F5A623`)**: The principal brand action and speech-active beacon. When primary amber acts as a fill, contained typography and glyphs strictly use `#050D19`, achieving an 8.2:1 contrast ratio that exceeds WCAG AAA standards.
- **Secondary Teal (`#1D9E8A`)**: Secondary controls, active audio-channel waveforms, and system routing confirmations.
- **State & Feedback Signals**:
  - **Success Emerald (`#34D399`)**: Successful audio synthesis, command execution, and phrase persistence.
  - **Error Coral (`#FB7185`)**: Recognition errors, microphone disconnections, hardware interrupts.
  - **Warning Gold (`#FBBF24`)**: Ambient noise warnings, battery constraints, confidence thresholds below limit.

### High-Contrast Assistive Rules
- Text on `#050D19` canvas surfaces uses `#FFFFFF` (21:1 ratio) for titles and `#E2E8F0` (14.8:1 ratio) for body copy.
- Muted helper text must never fall below `#94A3B8` (7.2:1 ratio against `#050D19`).
- Status indicators must pair colored badges with localized text labels or distinct SVG iconography to ensure total independence from color perception.

## Typography

Typography prioritizes rapid glanceability, cognitive ease, and structural legibility.

### Font Pairing Rationale
- **Space Grotesk (Headlines & Voice Telemetry)**: Distinct geometric aperture structures and technical terminals allow quick comprehension of spoken transcripts, live synthesis status, and voice mode markers.
- **Inter (Body, Controls, Form Elements)**: High x-height, wide open counters, and robust letterforms reduce ambiguity across dense symbol layouts and varied viewing distances.

### Assistive Typographic Directives
- **Zero All-Caps Paragraphs**: Sentence case is strictly enforced for conversational logs and phrase tiles. Uppercase usage is restricted to `status-badge` tokens containing no more than two words.
- **Numerics**: Space Grotesk tabular figures (`tnum`) must be invoked for confidence percentages, latency metrics, and real-time audio sample monitors to prevent layout jitter.
- **Dynamic Scale**: Body text never drops below 14px on any device. For users who scale system text up to 200%, containers use relative units (`rem`) with flexible wrapping layouts to eliminate clipped text.

## Layout & Spacing

The layout is built around a predictable, stable viewport structure optimized for dwell-click systems, eye-tracking peripherals, switch access devices, and direct gross-motor finger presses.

### Responsive Grid System
- **Desktop & Landscape Mounts (1024px and up)**: 12-column fluid grid. Outer margin is `margin` (2rem / 32px) with `gutter` (1.5rem / 24px). Critical action bars (e.g., "Speak Now", "Cancel", "Clear Buffer") are fixed to accessible edge zones.
- **Tablet / Mounted Displays (640px to 1023px)**: 8-column fluid grid with 1.5rem margins and 1rem gutters.
- **Mobile Handheld (320px to 639px)**: 4-column layout with `margin-mobile` (1rem / 16px) and `gutter-mobile` (1rem / 16px).

### Motor-Safe Target Zoning
- Every interactive element maintains a minimum touch target bounding box of `48px x 48px`. Where available physical space permits, primary verbal trigger targets expand to `64px` in height.
- Adjacent touch points require at least `space-sm` (12px) separation to reduce unintended triggering by users with tremors or spastic motor profiles.
- Avoid sticky banners that overlay or reflow interactive targets mid-session.

## Elevation & Depth

This design system expresses hierarchy using **Tactile Glassmorphism** layered with **Physical Outlines** rather than diffused drop shadows, preventing blur and maintaining sharp spatial contrast on dark backgrounds.

### Elevation Hierarchy
1. **Level 0 (Canvas Base)**: Deepest background `#050D19`. Unbordered, purely absorptive surface.
2. **Level 1 (Substrate Glass)**: `#0A1628` combined with `backdrop-filter: blur(16px)` and a crisp perimeter border: `1px solid rgba(255, 255, 255, 0.08)`. Used for sidebars, voice history containers, and stationary docks.
3. **Level 2 (Interactive Phrase Cards & Panels)**: `#102038` backed by `backdrop-filter: blur(24px)`. Border increases to `1px solid rgba(255, 255, 255, 0.12)`. When focused or hovered, the border shifts to `rgba(255, 255, 255, 0.35)` with an inner keyline glow.
4. **Level 3 (Modal Overlays & Critical Voice Dialogs)**: `#172C4C` with `backdrop-filter: blur(32px)`, bordered by `1.5px solid rgba(255, 255, 255, 0.25)` and framed by an ambient edge shadow: `0 12px 32px -4px rgba(0, 0, 0, 0.6)`.

### High-Contrast Focus Rings
Assistive switch navigation and keyboard focus bypass subtle elevation shifts. Focused elements display an unobstructed `3px solid #F5A623` outline with a `2px` transparent offset, ensuring instant target localization.

## Shapes

The design system employs a roundedness index of `2` (`0.5rem` / 8px for standard controls, `1rem` / 16px for cards, and `1.5rem` / 24px for larger modal glass sheets).

### Semantic Shape Rules
- **Tactile Boundaries**: Moderately rounded corners keep cards distinct from one another without creating the boundary ambiguity seen with full pill shapes in tight grid matrices.
- **Voice Status Pills**: Pill shapes (`rounded-full`) are reserved exclusively for continuous real-time state chips (e.g., "LISTENING", "SYNTHESIZING", "OFFLINE") and quick-toggle verbal phrase capsules.
- **Direct Selection Controls**: Standard interactive cards, keyboard matrix keys, and preset phrase boxes adhere strictly to `rounded-lg` (16px) to maximize the clickable surface area up to the extreme corner bounds.

## Components

### 1. Buttons
- **Primary Action (Speak / Broadcast)**: Minimum height 56px. Filled with Primary Warm Amber (`#F5A623`), text/icons in `#050D19` (`label-lg`, Space Grotesk Bold). Border is clean with an elevated tactile state. On hover/active, the background brightens to `#FFB84D`.
- **Secondary (Add Phrase / Pause)**: Minimum height 48px. Glass surface `#102038`, text `#FFFFFF`, bordered with `1px solid rgba(255,255,255,0.16)`. On interaction, border shifts to Secondary Teal (`#1D9E8A`).
- **Critical / Stop**: Minimum height 48px. Surface `#0A1628` bordered with Error Coral (`#FB7185`), text `#FB7185`. Includes both an octagonal stop icon and the uppercase label "STOP".

### 2. Voice State Bar & Real-Time Telemetry
- A persistent component displaying current AI model readiness.
- **Listening State**: Border glows with Secondary Teal (`#1D9E8A`), displays a multi-bar animated waveform icon, accompanied by the bold label "LISTENING".
- **Processing State**: Warning Gold (`#FBBF24`) pulsing ring icon paired with "TRANSCRIBING...".
- **Speaking State**: Primary Amber (`#F5A623`) solid indicator with speaker-wave glyph and active output volume decibel meter.
- **Muted/Idle**: Neutral slate glyph, strike-through microphone icon, label "MIC OFF".

### 3. Quick-Select Phrase Cards
- Modular grid cards containing pre-recorded or dynamically predicted phrases.
- Surface: `#0A1628` background with `1px solid rgba(255, 255, 255, 0.08)`. Minimum dimensions: 120px wide by 64px tall to ensure easy target selection.
- Left-aligned high-contrast primary icon, followed by primary text in `#FFFFFF` (`body-md` / Inter SemiBold).
- Active state adds a 2px inner border of Primary Amber and an instantaneous audio trigger confirmation tone.

### 4. Chips & Filters
- Minimum height 48px, minimum width 64px.
- Unselected: Surface `#0A1628`, text `#94A3B8`, border `1px solid rgba(255, 255, 255, 0.08)`.
- Selected: Surface `#1D9E8A`, text `#FFFFFF`, paired with a checkmark glyph (`check-circle`) to verify selection without relying on teal alone.

### 5. Input Fields (Custom Phrase Builder)
- Height: 56px minimum.
- Base: `#0A1628` filled with `1.5px solid rgba(255, 255, 255, 0.16)`. Text is `#FFFFFF` (`body-lg`).
- Focus: Border switches to 2px solid `#F5A623` with no input clipping.
- Includes a direct "Clear Buffer" touch button (48×48px) within the input tail, preventing users from needing repeated backspace actuations.

### 6. Checkboxes & Radio Switches
- Minimum interactive footprint: 48×48px with a 24×24px visual target centered within.
- Checkbox visual: Unchecked has a 2px border of `#94A3B8` on `#0A1628`. Checked fills with Secondary Teal (`#1D9E8A`), displaying a high-contrast white checkmark icon.
- Radio visual: Checked features a solid Primary Amber (`#F5A623`) center dot surrounded by an outer ring with a 2px gap, ensuring distinct differentiation from checkboxes for low-vision users.

### 7. Dwell / Eye-Gaze Selection Indicators
- For assistive devices relying on hover-dwell selection: an expanding or filling radial border in `#F5A623` sweeps along the perimeter of the targeted card over a configurable time window (e.g., 400ms–1200ms) before activation locks in, accompanied by a subtle audio cue.

## How the Tier 2 desktop app applies this

Decisions made when building `dashboard/` from the Stitch screens (2026-09-21). Where this section and the text above disagree, this section wins. Where it disagrees with **Adapted for students** below, that section wins.

### Adapted for students (2026-09-24)
The first rule is now: **a student sees as little as possible.** It outranks "keep every element of the Stitch screens". A review of the app from a voice-only student's point of view found that the student only ever needs the overlay, yet could reach API keys and developer tools by voice ("go to settings") or by the overlay's dashboard button. The owner chose simplicity over matching every Stitch element. Colours and icons of what remains still follow the screens.
- **Three audiences.** Student: the overlay only. Teacher: the dashboard's Home, Students, Speech Profile and Test Console. Admin (teacher or developer with the PIN): Developer Hub and Settings.
- **Admin PIN.** Developer Hub and Settings are no longer in either sidebar; a small **Admin** link with a lock sits at the foot of the sidebar. They open only after the admin PIN (4–8 digits) is entered, and the server checks it on the routes behind them (`server/src/admin-pin.js`): API keys and provider, `/api/ai/switch`, tools, library, config and raw logs. The unlock lasts 15 minutes, lives only in memory, and five wrong PINs pause unlocking for five minutes. The **first** PIN can only be set within 10 minutes of a teacher choosing **Set admin PIN…** on the tray icon; otherwise a student could open Admin by voice and dictate a PIN of their own. Home's own routes (`/api/logs/health`, `/api/screen`, `/api/context`) stay open to teachers.
- **Voice can't open admin pages.** "Open developer hub" is answered "That page is for your teacher." Everyday words that used to open them ("settings", "tools", "logs") now go to the AI, which usually means the app the student is using. Switching the AI provider by voice now also needs the PIN.
- **Nothing technical in the teacher's frame.** The gateway round-trip in milliseconds, the gateway version and the port are gone from both sidebars. Settings still shows the version.
- **The overlay** (see below) is simpler: bigger text, no keyboard hint, one button, and every resting state says what to say next.

### The screens are the spec
Each dashboard section is its Stitch HTML file in `docs/design/stitch/`, ported class for class: `home.html`, `students.html`, `speech-profile.html`, `test-console.html`, `developer-hub.html` and `settings.html`. Where those files and this document disagree, the files win. The six files were generated separately, so they differ from each other in places; the app keeps each file's own look inside its page.
- **Colours per screen.** Each page uses the hex values its own file uses, written as Tailwind arbitrary values (`bg-[#102038]`). Every page sits on the same blue background, `#0D1627` (chosen by the user on 2026-09-22 in place of the screens' `#050D19` and Home's `#060e1b`). Five screens use the navy palette under Colors for everything else (sidebar `#0A1628`, cards `#102038`). Home uses the grey Material-style palette in its own file, the colour list at the top of this document, for its frame and cards: cards `#141c28`, wells `#18202d`, raised `#222a37`, amber `#f5a623` / `#ffc880`, teal `#68d9c3`, green `#54ebaf`, coral `#ffb4ab`. A navy Home was tried on 2026-09-22 and the user preferred the grey one.
- **Type and icons as each file has them.** Space Grotesk, Inter and JetBrains Mono, at the sizes and weights each file uses. Icons are the file's own inline SVGs, or Material Symbols where the file uses that font.
- **Settings card borders are light grey (`#e5e7eb`).** The Stitch file asks for `border-white/12`, which its Tailwind build can't draw, so the screen shows Tailwind's default light border; the app draws what the screen shows.

### One shell for all six sections
The six files draw the sidebar and top bar slightly differently. Home keeps its own charcoal frame from `home.html` (sidebar with the TIER 2 ASSISTIVE AI badge and a facilitator row; top bar with the student chip, their listening setting and an Overlay shown/hidden switch). The other five pages use the Students screen's version:
- A 260px sidebar: the logo tile, the four teacher sections, and at the bottom the connection and the small **Admin** link (see Adapted for students).
- A 56px top bar: the student in session, the time their session started and their microphone setting, then the date and time and this computer's name. A voice notice (privacy mode, asleep, dictating, overlay hidden) appears beside the student when one applies. Below 1280px wide the microphone setting and the computer's name are hidden.

### Real data in every element
Every element of each screen is kept (except where Adapted for students removes it), and every value comes from the app. Sample content in the screens is replaced with the real value, formatted the same way:
- The facilitator's name becomes this computer's name, because the app has no signed-in staff member. "Station 03 · Dell XPS Lab" and the room also become the computer's name.
- Student photos become the student's initials in the same tile.
- Where the app has no source for a value (the microphone's device name and gain, token rate, acoustic confidence), the card shows the nearest real value with a truthful label, for example the microphone card shows the student's sensitivity setting.
- The overlay preview on Home draws the controls AbleSpeak reads from the front window, with the real voice bar state on top. It is not a screenshot.
- Controls the app can't back are pointed at the nearest real action with a truthful label. "Push Voice Prompt" becomes "Send a Command" (Test console), "Restart Daemon" becomes "Open Server Log", "Flush Context Cache" becomes "Clear Chat History", and on Developer hub "Test execute" becomes "Try in Test console". Nothing in the dashboard runs a tool directly.
- Wording stays plain where a screen claims something the app doesn't do. For example, "privacy mode" is labelled "Screen privacy", not "Mute mic", because the microphone stays on.

### The student overlay
The overlay (`server/overlay.html`) keeps the look it had before the redesigns (the dark pill, the mic button, what was heard and the ✓ Done / ✗ Didn't work results), adapted for students on 2026-09-24:
- **Text in rem, at least 16px; the status line is 18px** with 1.5 line spacing. The window is 420 × 300 so the larger text fits. All text colours are at least 9:1 against the pill, and the listening pulse never fades below 85% opacity.
- **Only the mic button.** The continuous-listening and dashboard buttons are hidden: continuous listening is set by voice or on Speech Profile, and teachers open the dashboard from the tray icon.
- **No keyboard hint.** "Dictate Ctrl + Shift + A" is gone; the student has no keyboard.
- **Each resting state says what to say next:** "Say a command", "Working on it — say "stop" to cancel", "Dictating — say "stop dictation" when done", "Asleep — say "wake up"", "Reconnecting — please wait". Multi-step tasks no longer show step counts or plan numbers.
- **Words carry the meaning, not emoji.** 💤, ✏️ and ⚠️ were removed; ✓ and ✗ remain only beside words.

Home's overlay preview shows its state.

### Where each rule lives
- Colours, sizes and spacing: Tailwind classes in each page, as the Stitch files write them. `dashboard/tailwind.config.js` names a few colours and the fonts; `dashboard/src/index.css` holds only what applies everywhere (focus ring, select chevron, scrollbars, the Material Symbols settings).
- Fonts and icons are bundled with the app (`@fontsource-variable/*`, `material-symbols`), so everything works with no internet connection.
- Focus: every control gets a 3px amber outline.
- Scrolling: the window never scrolls, only `<main>` inside the fixed sidebar and top bar. `<main>` is `relative` and `html, body` are `overflow: hidden`, so absolutely placed elements deep in a page (such as `sr-only` labels) can't stretch the window and push the frame out of view.
- Private values (computer name, key ending, `.env` path) carry `data-private`, so screenshots can hide them before they are committed.
- Screenshots: `docs/design/screenshots/` show the six sections with demo data, private values hidden.

### Not applied
- **Phone and tablet layouts.** The app runs in a desktop window. The pages are checked down to 1024px wide.
- **Phrase cards, confirmation tones, dwell/eye-gaze rings and the 72px idle orb.** Tier 2 has none of these features yet.
- **Live mic activity in the dashboard.** The dashboard never opens the microphone; it shows the voice state the server reports, and the Test console uses its own mic only when you press Speak.
