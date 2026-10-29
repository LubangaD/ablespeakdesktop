/**
 * The dashboard's look, shared by every page: one page title, small quiet
 * labels, numbers as the only large text, status as a coloured dot and a word
 * in sentence case (never a capital-letter badge), and one accent (amber) for
 * the main action on a page.
 *
 * Values live in `src/index.css` as custom properties, so a colour or a shadow
 * is defined once; this file composes them into the class strings pages use.
 * Shadows need the `shadow-[shadow:...]` type hint: Tailwind reads an arbitrary
 * value starting with `var(` as a shadow *colour* and silently paints nothing.
 * The screens these come from are `docs/design/ui-refined/` — open its
 * index.html to see each constant in place.
 *
 * ── What the refined pass changed (13 Oct 2026) ───────────────────────────
 *
 * The product is used by people with motor and visual impairments, so none of
 * it was bought with contrast or target size: every ratio held or improved, and
 * no target shrank. The refinement is in four things instead.
 *
 *  1. A coherent light model. WELL used to be *lighter* than CARD, so a recess
 *     was drawn raised. Now light falls from above: CARD is raised off the page
 *     with a top sheen and a soft lift; WELL is sunk into it with an inner
 *     shadow; FIELD matches WELL, because anything you type into is a recess.
 *  2. Optical sizing and grade. Each type step sets its own `opsz` and `GRAD`
 *     (see index.css). Small text carries more grade, which keeps 11–13px
 *     readable on a dark panel.
 *  3. Space as hierarchy — 32px between sections, 24px inside a card. Uniform
 *     16px everywhere was what made pages read as a grid of equal grey boxes.
 *  4. The accent spent three times, not eight: the one action a page is for,
 *     the page you are on, and focus. The logo tile and avatars became ink on a
 *     recessed tile, and headings are ink.
 *
 * Every export kept its name and meaning, so no page needed rewriting.
 */

// ── Type ──
// Each step carries its own optical size and grade; see index.css for why.
export const TITLE = "font-heading text-[28px] leading-9 font-[620] tracking-[-0.021em] text-[var(--ink)] [font-variation-settings:'opsz'_32,'GRAD'_20]";
export const SECTION = "font-heading text-[15px] leading-[22px] font-[620] tracking-[-0.004em] text-[var(--ink)] [font-variation-settings:'opsz'_16,'GRAD'_25]";
export const LABEL = "text-[13px] leading-5 text-[var(--ink-quiet)] [font-variation-settings:'opsz'_13,'GRAD'_35]";
export const MUTED = LABEL;
export const BODY = "text-[14px] leading-[22px] text-[var(--ink-body)] [font-variation-settings:'opsz'_14,'GRAD'_25]";
// Numbers are the only large text, and always tabular: a changing value must
// never shift the layout under someone's eyes.
export const NUMBER = "font-heading text-[34px] leading-10 font-[580] tracking-[-0.028em] text-[var(--ink)] tabular-nums [font-variation-settings:'opsz'_36,'GRAD'_15]";
// The one place letterspaced uppercase is allowed: a menu tier or a column
// head. Never a status.
export const OVERLINE = "text-[11px] leading-4 font-[640] uppercase tracking-[0.09em] text-[var(--ink-faint)] [font-variation-settings:'opsz'_11,'GRAD'_50]";

// ── Surfaces ──
export const PAGE = 'min-h-full w-full bg-[var(--page)] text-[var(--ink-body)] px-8 pt-10 pb-16';
// Raised: catches light on its top edge and casts a soft shadow.
export const CARD = 'bg-[var(--card)] rounded-[14px] border border-[var(--line)] shadow-[shadow:var(--sheen),var(--lift)]';
// Recessed: sits below the card it is in.
export const WELL = 'bg-[var(--sunken)] rounded-[10px] border border-[var(--line-soft)] shadow-[shadow:var(--inset)]';
export const DIVIDER = 'border-[var(--line-soft)]';

// ── Controls ──
// Every button is at least 44px tall, for an unsteady hand.
export const BUTTON = "inline-flex items-center justify-center gap-2 min-h-[44px] px-5 rounded-[10px] text-[14px] font-[580] tracking-[-0.003em] border border-transparent transition-colors disabled:opacity-45 disabled:cursor-not-allowed disabled:shadow-none [font-variation-settings:'opsz'_14,'GRAD'_25]";
// One per page: the thing this page is for. This is where the accent is spent.
export const PRIMARY = `${BUTTON} bg-[image:var(--accent-grad)] hover:bg-[image:var(--accent-grad-hover)] text-[var(--on-accent)] font-[640] shadow-[inset_0_1px_0_rgba(255,255,255,0.34),0_1px_2px_rgba(0,0,0,0.3),0_6px_16px_-8px_rgba(245,166,35,0.5)]`;
export const QUIET = `${BUTTON} bg-white/[0.035] hover:bg-white/[0.07] text-[var(--ink)] border-[var(--line-strong)] hover:border-white/[0.17] shadow-[shadow:var(--sheen)]`;
// Never the only warning; the words say it too.
export const DANGER = `${BUTTON} bg-[#ffb3aa]/[0.07] hover:bg-[#ffb3aa]/[0.13] text-[var(--bad)] border-[#ffb3aa]/30 hover:border-[#ffb3aa]/45`;
export const SMALL_QUIET = "inline-flex items-center gap-2 min-h-[36px] px-3 rounded-lg text-[13px] font-[580] bg-white/[0.035] hover:bg-white/[0.07] text-[var(--ink)] border border-[var(--line-strong)] transition-colors disabled:opacity-45 disabled:cursor-not-allowed [font-variation-settings:'opsz'_13,'GRAD'_30]";
// A small action at the end of a list row: quiet until wanted.
export const ROW_ACTION = 'inline-flex items-center gap-1 min-h-[36px] px-3 rounded-lg text-[13px] font-[560] text-[var(--ink-quiet)] border border-transparent hover:bg-white/[0.06] hover:text-[var(--ink)] hover:border-[var(--line)] transition-colors shrink-0 disabled:opacity-45 disabled:cursor-not-allowed';
// Anything you type into is a recess, like every other sunken surface.
export const FIELD = "w-full min-h-[44px] rounded-[10px] bg-[var(--sunken)] border border-white/[0.09] px-3 py-[11px] text-[14px] text-[var(--ink)] placeholder-[var(--ink-faint)] shadow-[shadow:var(--inset)] transition-colors focus:outline-none focus:border-[var(--accent)] [font-variation-settings:'opsz'_14,'GRAD'_25]";
export const FIELD_LABEL = "block text-[12.5px] leading-[18px] font-[560] text-[var(--ink-quiet)] mb-2 [font-variation-settings:'opsz'_13,'GRAD'_35]";

// ── Status: a dot and a word ──
// Each dot carries a faint halo of its own colour, so it reads as lit rather
// than printed. The word beside it is what actually carries the meaning.
export const DOT = {
  ok: 'bg-[var(--ok)] shadow-[0_0_0_3px_rgba(111,220,198,0.14)]',
  warn: 'bg-[var(--warn)] shadow-[0_0_0_3px_rgba(255,200,122,0.14)]',
  bad: 'bg-[var(--bad)] shadow-[0_0_0_3px_rgba(255,179,170,0.14)]',
  idle: 'bg-[var(--idle)] shadow-[0_0_0_3px_rgba(255,255,255,0.05)]',
};
export const INK = {
  ok: 'text-[var(--ok)]',
  warn: 'text-[var(--warn)]',
  bad: 'text-[var(--bad)]',
  idle: 'text-[var(--ink-quiet)]',
};

// ── Tables ──
export const TH = "font-[580] px-3 pt-2 pb-3 text-[11px] leading-4 uppercase tracking-[0.07em] text-[var(--ink-faint)] text-left whitespace-nowrap [font-variation-settings:'opsz'_11,'GRAD'_50]";
export const TD = 'px-3 py-3 text-[14px] leading-[21px] text-[var(--ink-body)] align-top';
