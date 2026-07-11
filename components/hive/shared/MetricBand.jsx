// components/hive/shared/MetricBand.jsx
// ─────────────────────────────────────────────────────────────
// The client-v4 METRIC BAND (card-restore build 2, Kevin's 7/10
// mockups): a full-bleed money row under the profile header — hairline
// top/bottom rules, hairline cell dividers, TABULAR NUMERALS so the
// four figures column-align. Replaces the profile's tinted VitalsStrip
// (the strip idiom lives on for PersonCard).
//
// Full-bleed: the host card's body has horizontal padding, so the band
// takes `bleed` (that padding in px) and cancels it with negative
// margins — the rules run edge to edge.
//
// cells: exactly four { label, value, color? } — value is a RENDERED
// string ('—' for absent, never a fabricated zero; the host decides).
// §8.5: pure presentational, props only.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { EM_DASH } from './VitalsStrip'
import { T } from './tokens'

export default function MetricBand({ cells = [], bleed = 24 }) {
  return (
    <div aria-label="Metrics" style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cells.length || 4}, minmax(0, 1fr))`,
      margin: `0 -${bleed}px`,
      borderTop: T.border.divider,
      borderBottom: T.border.divider,
    }}>
      {cells.map((c, i) => (
        <div key={c.label} style={{
          minWidth: 0, padding: '10px 14px',
          paddingLeft: i === 0 ? `${bleed}px` : '14px',
          borderLeft: i === 0 ? 'none' : T.border.divider,
        }}>
          <p style={{ fontSize: '10px', fontWeight: 500, color: T.ink.muted, letterSpacing: '0.5px', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.label}
          </p>
          <p style={{ fontSize: '15px', fontWeight: 500, fontVariantNumeric: T.type.tabular, letterSpacing: T.type.trackNum, color: (c.value != null && c.color) || T.ink.primary, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.value ?? EM_DASH}
          </p>
        </div>
      ))}
    </div>
  )
}
