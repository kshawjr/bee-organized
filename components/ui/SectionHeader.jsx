// components/ui/SectionHeader.jsx — muted section label with optional count.
// LOCKED (mockup spec): 12px, weight 500, sentence case, #6b6b66; count
// follows a '·' separator in lighter gray ("Request · 10"). The type
// values live in ui/tokens (SECTION_LABEL / SECTION_COUNT) — shared with
// the filter segments and list column headers, one treatment everywhere.
'use client'

import React from 'react'
import { SECTION_LABEL, SECTION_COUNT } from './tokens'

// `style` merges onto the container — layout-only overrides for hosts
// with their own spacing (the board's mobile pager passes marginBottom 0);
// the TYPE values are not overridable, they come from the tokens.
export default function SectionHeader({ label, count = null, style = {} }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '8px', ...style }}>
      <span style={SECTION_LABEL}>
        {label}
      </span>
      {count != null && (
        <span style={{ ...SECTION_COUNT, marginLeft: '5px' }}>· {count}</span>
      )}
    </div>
  )
}
