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

export const TEXT_TOKENS = {
  '--text-primary': TEXT_PRIMARY,
  '--text-success': TEXT_SUCCESS,
  '--text-danger': TEXT_DANGER,
}

// "Request · 10": 12px/500 #6b6b66 label, then '· count' in 12px/400 #b5b3ac.
export const SECTION_LABEL = { fontSize: '12px', fontWeight: 500, color: '#6b6b66' }
export const SECTION_COUNT = { fontSize: '12px', fontWeight: 400, color: '#b5b3ac' }
