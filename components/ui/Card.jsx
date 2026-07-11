// components/ui/Card.jsx — the raised white card (design-system pass
// 7/11: card lift). LOCKED anatomy: raised surface, REAL warm border +
// two-layer soft shadow (hive tokens — the single visual source),
// radius from the token scale, padding 10px 12px, no gradients.
// highlighted swaps the border to the one action accent.
'use client'

import React from 'react'
import { T } from '@/components/hive/shared/tokens'

export default function Card({ children, onClick = null, highlighted = false, accent = null }) {
  return (
    <div
      onClick={onClick || undefined}
      style={{
        background: T.surface.raised,
        border: highlighted ? `1px solid ${T.accent.fg}` : T.border.card,
        // accent: semantic left-edge cue (closed won/lost cards) — the
        // one sanctioned deviation from the hairline-all-around rule.
        ...(accent ? { borderLeft: `3px solid ${accent}` } : {}),
        borderRadius: T.radius.card,
        boxShadow: T.shadow.card,
        padding: '10px 12px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
      }}
    >
      {children}
    </div>
  )
}
