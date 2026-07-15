// components/hive/shared/formKit.js
// ─────────────────────────────────────────────────────────────
// THE hive form-field styles. Extracted from NewClientSheet (which was
// the de-facto standard by being the only place they existed) so a
// second sheet doesn't fork a fourth copy of the same object literal.
// PURE module — style objects only, every value through tokens.js.
//
// fontSize 16px on `inp` is LOAD-BEARING, not a taste call: iOS Safari
// auto-zooms the viewport on focus for any field under 16px, and the
// zoom never unwinds — the sheet ends up scrolled off-screen. Never
// shrink it to match a 13px label; scale the padding instead.
// ─────────────────────────────────────────────────────────────

import { T } from './tokens'

// Text inputs, selects, textareas.
export const inp = {
  width: '100%', padding: '9px 11px', border: T.border.strong,
  borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary,
  background: T.surface.raised, outline: 'none', boxSizing: 'border-box',
}

// The uppercase micro-label above a field.
export const lbl = {
  fontSize: '11px', fontWeight: 500, color: T.ink.muted, letterSpacing: '0.6px',
  textTransform: 'uppercase', marginBottom: '4px', display: 'block',
}
