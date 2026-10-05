/**
 * The dashboard's look, shared by every page: one page title, small quiet
 * labels, numbers as the only large text, status as a coloured dot and a word
 * in sentence case (never a capital-letter badge), and one accent (amber) for
 * the main action on a page. Home was the first page in this style.
 */

// ── Type ──
export const TITLE = 'font-heading text-[26px] leading-8 font-semibold tracking-[-0.01em] text-[#dae3f4]';
export const SECTION = 'font-heading text-[16px] leading-6 font-semibold text-[#dae3f4]';
export const LABEL = 'text-[13px] leading-5 text-[#c9b8a5]';
export const MUTED = 'text-[13px] leading-5 text-[#c9b8a5]';
export const BODY = 'text-[14px] leading-5 text-[#dae3f4]';
export const NUMBER = 'font-heading text-[28px] leading-9 font-semibold tracking-[-0.01em] text-[#dae3f4] tabular-nums';

// ── Surfaces ──
export const PAGE = 'min-h-full w-full bg-[#0D1627] text-[#dae3f4] px-8 pt-7 pb-10';
export const CARD = 'bg-[#141c28] rounded-xl border border-white/[0.06]';
export const WELL = 'bg-[#18202d] rounded-lg border border-white/[0.06]';
export const DIVIDER = 'border-white/[0.06]';

// ── Controls ──
export const BUTTON = 'inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-lg text-[14px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export const PRIMARY = `${BUTTON} bg-[#f5a623] hover:bg-[#ffb955] text-[#3d2600] font-semibold`;
export const QUIET = `${BUTTON} bg-[#18202d] hover:bg-[#222a37] text-[#dae3f4] border border-white/[0.08]`;
export const DANGER = `${BUTTON} bg-[#ffb4ab]/10 hover:bg-[#ffb4ab]/15 text-[#ffb4ab] border border-[#ffb4ab]/30`;
export const SMALL_QUIET = 'inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg text-[13px] font-medium bg-[#18202d] hover:bg-[#222a37] text-[#dae3f4] border border-white/[0.08] transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
// A small text action at the end of a list row
export const ROW_ACTION = 'inline-flex items-center gap-1 min-h-[36px] px-2.5 rounded-md text-[13px] font-medium text-[#dae3f4] hover:bg-[#222a37] transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed';
export const FIELD = 'w-full min-h-[44px] rounded-lg bg-[#0f1724] border border-white/[0.10] px-3 text-[14px] text-[#dae3f4] placeholder-[#8b95a7] focus:outline-none focus:border-[#f5a623]';

// ── Status: a dot and a word ──
export const DOT = { ok: 'bg-[#68d9c3]', warn: 'bg-[#ffc880]', bad: 'bg-[#ffb4ab]', idle: 'bg-[#4a5466]' };
export const INK = { ok: 'text-[#68d9c3]', warn: 'text-[#ffc880]', bad: 'text-[#ffb4ab]', idle: 'text-[#c9b8a5]' };

// ── Tables ──
export const TH = 'font-medium px-3 py-2.5 text-[12px] leading-4 text-[#c9b8a5] text-left';
export const TD = 'px-3 py-3 text-[14px] leading-5 text-[#dae3f4] align-top';
