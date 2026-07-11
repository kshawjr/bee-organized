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

export default function MetricBand({ cells = [], bleed = 24 }) {
  return (
    <div aria-label="Metrics" style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cells.length || 4}, minmax(0, 1fr))`,
      margin: `0 -${bleed}px`,
      borderTop: '0.5px solid rgba(0,0,0,0.08)',
      borderBottom: '0.5px solid rgba(0,0,0,0.08)',
    }}>
      {cells.map((c, i) => (
        <div key={c.label} style={{
          minWidth: 0, padding: '10px 14px',
          paddingLeft: i === 0 ? `${bleed}px` : '14px',
          borderLeft: i === 0 ? 'none' : '0.5px solid rgba(0,0,0,0.08)',
        }}>
          <p style={{ fontSize: '10px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.5px', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.label}
          </p>
          <p style={{ fontSize: '15px', fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: (c.value != null && c.color) || '#1a1a18', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.value ?? EM_DASH}
          </p>
        </div>
      ))}
    </div>
  )
}
