# The ten screens, refined

*A second pass over `../ui/`, 13 October 2026. Open [`index.html`](index.html).*

Same ten screens, same markup, **one stylesheet swapped**. Every class name is
identical to `../ui/ablespeak-ui.css`, so the only difference between a screen
here and its sibling is which file its `<link>` points at. The design lives
entirely in [`ablespeak-refined.css`](ablespeak-refined.css).

That is deliberate: it makes the change reviewable. Put the two side by side and
everything you see is the system, not the content.

```
ablespeak-refined.css   the refined system — the whole of the change
shell.js                the frame; demo identity signed in as admin
index.html              contact sheet
01-home.html … 10-settings.html
```

**To just look at them: open [`all-screens.html`](all-screens.html).** Every screen
is inlined in that one file — stylesheet, markup and frame — so it needs no
server and has nothing to miss. The menu switches screens. It is built from the
separate files by the script in this README's history; edit the separate files,
then rebuild it.

The separate files need a static server, because a browser will not run
`shell.js` from `file://`:

```
python -m http.server 4180 --directory docs/design
# then /ui/index.html and /ui-refined/index.html, side by side
```

---

## The constraint that shaped it

The usual moves that make an interface read as expensive — lighter weights,
low-contrast greys, hairline strokes, smaller text, whisper-quiet states — are
all **wrong for this product**. It is used by people with motor and visual
impairments, often on a laptop in a bright classroom. "Classy" cannot be bought
here with contrast or target size.

So none of this lowers a ratio, shrinks a target, or softens a state. The
refinement comes from four other places.

### 1. A coherent light model

`../ui/` had `WELL` (`#18202d`) **lighter** than `CARD` (`#141c28`) — so a
recessed area was drawn raised. The light was coming from nowhere in particular.

Here light falls from above and the ramp means something:

| token | value | |
|---|---|---|
| `--as-sunken` | `#0a1220` | wells, fields, code — **below** the page, with an inner shadow |
| `--as-page` | `#0d1627` | unchanged: the owner's choice, 2026-09-22 |
| `--as-card` | `#151f2e` | raised — catches a highlight on its top edge, casts a soft shadow |
| `--as-raised` | `#1d2736` | hover, the row you are on |

A card now reads as a panel lying on the page; a well reads as a recess cut into
it. That single correction does most of the visual work.

### 2. A type scale, using the axes Roboto Flex actually has

The font was being used generically. It is a variable font with an optical-size
axis and a **grade** axis, and grade is the one that matters on dark
backgrounds: `GRAD` thickens strokes *without widening letters*, which is
exactly what stops light-on-dark text looking thin and washed.

Every step sets its own `opsz` and `GRAD`. Body text carries `GRAD 25`, small
quiet text `GRAD 35`, 11px overlines `GRAD 50`. More legible **and** more
refined — those are not in tension here, which is the whole point.

Weights are 560/580/620/640 rather than 500/600/700. A variable font holds those
happily, and the finer steps are what make a hierarchy feel set rather than
bolded.

### 3. Space as hierarchy

Uniform 16px gaps everywhere are what made the old screens read as a grid of
equal grey rectangles. Now: 32px between sections, 24px inside a card, 4–16px
within a component, and a 1180px measure so nothing runs the width of a 4K
display.

### 4. The accent, spent three times

Amber appeared in eight places — logo tile, avatars, question labels, stat
accents, active nav, primary buttons, focus, chips — so it signalled nothing.

Here it marks exactly three things: **the one action a page is for**, **the page
you are on**, and **focus**. The logo and avatars became ink on a recessed tile.
Headings are ink. When amber appears now, it means something.

---

## What it is not allowed to cost

Measured in the browser across all ten screens at 1280px and 1024px:

| | Result |
|---|---|
| Text failing WCAG AA | **0** |
| Muted text (`--as-ink-faint`) | **7.03–8.16:1** — clears AAA on card, sidebar and raised row |
| Primary button ink on amber | **7.36–10.25:1** across the whole gradient, including its active stop |
| Horizontal overflow | **0** at both widths |
| Interactive targets under 36px | none, except inline text links inside a sentence (WCAG 2.5.8 exempts those) and the skip link, which is 46px once focused |
| Focus ring | 3px amber, unchanged, never removed |
| Status by colour alone | none — every status is a dot **and** a word |

`--as-ink-faint` started at `#97a2b4`. Measurement put that at **6.43:1** on a
card: passing AA, short of the 7:1 AAA bar DESIGN.md sets for muted text. It was
lifted to `#a6b2c6`, which clears 7:1 on every surface it lands on. Nothing in a
product like this gets to be *almost* readable.

A note on method: a first pass of the audit reported 14 contrast failures, all
at a suspicious ratio of 1.02. They were the audit's own fault — it read
`backgroundColor`, which is transparent on an element painted with a gradient,
so it compared the button's ink against the card behind it. The gradient pairs
were then checked directly. Worth recording, because an automated accessibility
pass that silently cannot see gradients will keep producing that number.

---

## The signed-in identity

`shell.js` carries the owner's account as demo data, so every tier renders
unlocked and the screens can be reviewed as an admin sees them:

```js
adminRole: 'admin',
byAccount: true,                                  // an admin account — no PIN prompt, no Lock
account: { signedIn: true, email: 'lderrickn254@gmail.com' },
```

This is **demo content in a design file**. No sign-in happens and none can: the
app authenticates through Supabase in the EU and mails a six-digit code. In the
real app admin is opened from the tray icon (**Set admin PIN…**, or **Admin
pages without a PIN…** on an admin Windows account) — deliberately not reachable
by software or by voice, so a student cannot grant it to themselves.

The email carries `data-private`, so `.as-hide-private` on `<body>` blurs it
before a screenshot is committed.

---

## If this is adopted

Nothing in the app needs rewriting: `lib/ui.js` takes the new values and every
page inherits them, because the pages are written against the constants rather
than raw hex.

In rough order of payoff:

1. **The surface ramp** (`CARD` / `WELL` swap, plus the sheen and lift). One
   edit to `lib/ui.js`, visible on every page.
2. **`GRAD` on the type.** Needs the `GRAD` axis requested; the app already
   bundles the full Roboto Flex axis set via `@fontsource-variable`.
3. **Pulling amber back** to the three places. Touches `App.jsx` (logo, avatar)
   and a few page headings.
4. **The spacing scale.** The largest diff, the most mechanical.

Still open from `../ui/README.md` and unchanged here: the exam screen keeps the
sidebar during a sitting, and Sign in's six code boxes are a proposal, not the
app's current single field.
