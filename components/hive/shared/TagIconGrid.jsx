// components/hive/shared/TagIconGrid.jsx
// ─────────────────────────────────────────────────────────────
// The curated icons a location may give its own tags (lib/tags.ts
// TAG_ICON_CHOICES) plus "None" — a grid, never a free emoji field. Used by
// the picker's create card and Settings › Tags. The server enforces the
// same list. §8.5: props only.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T } from './tokens'
import { TAG_ICON_CHOICES } from '@/lib/tags'

const cell = (on) => ({
  width: '32px', height: '32px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: T.radius.control, border: on ? `1.5px solid ${T.accent.fg}` : T.border.thin,
  background: on ? T.accent.soft : T.surface.raised, cursor: 'pointer', fontFamily: 'inherit', fontSize: '16px', padding: 0,
})

export default function TagIconGrid({ value = '', onChange = () => {}, label = 'Icon' }) {
  return (
    <div role="radiogroup" aria-label={label} data-icon-grid style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
      <button type="button" role="radio" aria-checked={!value} aria-label="No icon" onClick={() => onChange('')}
        style={{ ...cell(!value), width: 'auto', padding: '0 8px', fontSize: '11px', color: T.ink.muted }}>None</button>
      {TAG_ICON_CHOICES.map(e => (
        <button key={e} type="button" role="radio" aria-checked={value === e} aria-label={`Icon ${e}`} onClick={() => onChange(e)} style={cell(value === e)}>{e}</button>
      ))}
    </div>
  )
}
