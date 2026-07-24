// components/hive/shared/MiniAvatar.jsx
// ─────────────────────────────────────────────────────────────
// The small initials-circle used wherever a person is shown inline —
// the engagement/lead assignee pills (name beside it) and the Inbox
// row's assignee stack (overlapping, name on hover). Extracted from
// EngagementAssignees so the lead card, the engagement card, and the
// Inbox row all draw an assignee identically.
//
// Colour is a STABLE per-id pick from the token chip families (no
// random, no literals — token-pure for the hex sweep). `ring` draws the
// raised-surface border a stack needs so overlapping circles read as
// separate discs.
// ─────────────────────────────────────────────────────────────
import React from 'react'
import { T } from './tokens'

export const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

const AVATAR_FAMILIES = ['teal', 'blue', 'purple', 'amber', 'green', 'gray']
export const familyFor = (id) => {
  const s = String(id || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return T.family[AVATAR_FAMILIES[h % AVATAR_FAMILIES.length]]
}

export default function MiniAvatar({ id, name, size = T.avatar.inline, font = T.avatar.inlineFont, ring = false, title }) {
  const fam = familyFor(id)
  return (
    <span aria-hidden title={title} style={{
      width: size, height: size, borderRadius: T.radius.round, background: fam.bg, color: fam.text,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: font, fontWeight: 600, flexShrink: 0,
      ...(ring ? { border: `2px solid ${T.surface.raised}` } : null),
    }}>
      {initialsOf(name)}
    </span>
  )
}
