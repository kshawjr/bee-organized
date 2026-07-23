// components/ui/tokens.js — beta design tokens (PURE, zero-import; §8.5).
//
// TEXT_TOKENS are set as CSS custom properties on the HiveShell root so
// any beta surface can reference var(--text-success) etc.; every var()
// call site carries the matching hex fallback so surfaces render
// correctly when mounted standalone (tests, storybook-style mounts).
//
// SECTION_LABEL / SECTION_COUNT are THE secondary-header type treatment
// (LOCKED mockup: the board's "Request · 10" column header). The board
// header, the list/clients filter segments, and the list column headers
// all consume these two objects so the surfaces stay locked together.

// Brand pass 7/23: every stop below clears WCAG AA at normal size
// (4.5:1) against BOTH #fff and the warm canvas #F6F5F0. TEXT_MUTED,
// TEXT_QUIET and TEXT_SUCCESS previously did not (3.18 / 1.92 / 3.10 on
// canvas) while carrying real copy. See hive/shared/tokens.js for the
// full rationale and beta-palette-contrast.test.ts for the guard.
export const TEXT_PRIMARY = '#1a1a18' // near-black — active/primary text
export const TEXT_SECONDARY = '#54544F' // between primary and muted — anchor text in meta lines (same hex as SECTION_LABEL)
export const TEXT_SUCCESS = '#167959' // won/done green (stage-bar BAR_DONE hue)
export const TEXT_DANGER = '#791F1F'  // lost/owing red (CHIP_STYLES red text)
export const TEXT_MUTED = '#61615C'   // secondary/detail text — displayTitle lines, ages
export const TEXT_QUIET = '#6A6A65'   // quiet meta — '· soon' placeholders, empty states

export const TEXT_TOKENS = {
  '--text-primary': TEXT_PRIMARY,
  '--text-secondary': TEXT_SECONDARY,
  '--text-success': TEXT_SUCCESS,
  '--text-danger': TEXT_DANGER,
  '--text-muted': TEXT_MUTED,
  '--text-quiet': TEXT_QUIET,
}

// THE hairline for interactive chrome — buttons AND text inputs share one
// alpha so they can't drift apart again. Container/card hairlines stay at
// rgba(0,0,0,0.08) (Card.jsx) — a different, quieter role, not this token.
// The alpha moved 0.15 → 0.45: this line IS the visible boundary of a
// control, which puts it under WCAG 1.4.11 (3:1). At 0.15 it composited
// to ~1.4:1 on white — present in the DOM, invisible on the screen.
export const HAIRLINE_BORDER = 'rgba(0,0,0,0.45)'

export const BORDER_TOKENS = {
  '--hairline-border': HAIRLINE_BORDER,
}

// Warning tint — the design-language amber pair (CHIP_STYLES.amber hues):
// soft band fill + dark amber text. Used by the pinned-buzz band on the
// lead-detail cards; understated by design (no border, no saturation).
// Retuned off brand gold (#D4A049) rather than a generic orange, so the
// attention family and the brand marker share a hue.
export const WARNING_BG = '#F7EEDD'
export const WARNING_TEXT = '#6B4D19'

export const WARNING_TOKENS = {
  '--bg-warning': WARNING_BG,
  '--text-warning': WARNING_TEXT,
}

// Brand-green 3-stop scale — three DELIBERATE stops, not drift:
//   GREEN_FILL   — solid fills (the Send to Jobber button)
//   GREEN_TEXT   — dark text on light teal (the CHIP_STYLES teal pair, badges)
//   TEXT_SUCCESS — the bright accent stop (sort ✓, won cues) — defined above.
// Both stops are now the PUBLIC SITE's teal: beeorganized.com ships
// #054E4A as color-scheme-inverse's secondary background and its
// button-hover fill. Brand-derived rather than a near-miss of it.
export const GREEN_FILL = '#054E4A'
export const GREEN_TEXT = '#03403C'

// "Request · 10": 12px/500 label in TEXT_SECONDARY, then '· count' in
// 12px/400 TEXT_QUIET. Both reference the constants now instead of
// re-declaring the hex, so a palette pass can't leave them behind.
export const SECTION_LABEL = { fontSize: '12px', fontWeight: 500, color: TEXT_SECONDARY }
export const SECTION_COUNT = { fontSize: '12px', fontWeight: 400, color: TEXT_QUIET }
