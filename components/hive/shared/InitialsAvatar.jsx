// components/hive/shared/InitialsAvatar.jsx — the 32px initials circle
// shared by Inbox rows and the Clients directory rows. One anatomy
// (32px, 11px/600, full circle) so the two surfaces can't drift; the
// color pair comes in as props (a CHIP_STYLES family — bg + text).
'use client'

import React from 'react'
import { T } from './tokens'

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

export default function InitialsAvatar({ name, bg, text }) {
  return (
    <div style={{ width: T.avatar.identity, height: T.avatar.identity, borderRadius: T.radius.round, background: bg, color: text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: T.avatar.identityFont, fontWeight: 600, flexShrink: 0 }}>
      {initialsOf(name)}
    </div>
  )
}
