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

export const TEXT_PRIMARY = '#1a1a18' // near-black — active/primary text
export const TEXT_SUCCESS = '#1D9E75' // won/done green (stage-bar BAR_DONE hue)
export const TEXT_DANGER = '#791F1F'  // lost/owing red (CHIP_STYLES red text)
export const TEXT_MUTED = '#8a8a84'   // secondary/detail text — displayTitle lines, ages
export const TEXT_QUIET = '#b5b3ac'   // quiet meta — '· soon' placeholders, empty states

export const TEXT_TOKENS = {
  '--text-primary': TEXT_PRIMARY,
  '--text-success': TEXT_SUCCESS,
  '--text-danger': TEXT_DANGER,
  '--text-muted': TEXT_MUTED,
  '--text-quiet': TEXT_QUIET,
}

// THE hairline for interactive chrome — buttons AND text inputs share one
// alpha so they can't drift apart again. Container/card hairlines stay at
// rgba(0,0,0,0.08) (Card.jsx) — a different, quieter role, not this token.
export const HAIRLINE_BORDER = 'rgba(0,0,0,0.15)'

export const BORDER_TOKENS = {
  '--hairline-border': HAIRLINE_BORDER,
}

// Brand-green 3-stop scale — three DELIBERATE stops, not drift:
//   GREEN_FILL   — solid fills (the Send to Jobber button)
//   GREEN_TEXT   — dark text on light teal (the CHIP_STYLES teal pair, badges)
//   TEXT_SUCCESS — the bright accent stop (sort ✓, won cues) — defined above.
export const GREEN_FILL = '#0F6E56'
export const GREEN_TEXT = '#085041'

// "Request · 10": 12px/500 #6b6b66 label, then '· count' in 12px/400 #b5b3ac.
export const SECTION_LABEL = { fontSize: '12px', fontWeight: 500, color: '#6b6b66' }
export const SECTION_COUNT = { fontSize: '12px', fontWeight: 400, color: '#b5b3ac' }
