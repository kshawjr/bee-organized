// components/ui/Row.jsx — two-line list row: left slot, primary/secondary
// text (ellipsized), right slot. The mobile row compression rule (§7) is
// inherent: slots flex, text truncates.
'use client'

import React from 'react'
import { TEXT_MUTED } from '@/components/ui/tokens'

export default function Row({ left = null, primary, secondary = null, right = null, onClick = null }) {
  return (
    <div
      onClick={onClick || undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 12px',
        background: '#fff',
        border: '0.5px solid rgba(0,0,0,0.08)',
        borderRadius: '10px',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {left && <div style={{ flexShrink: 0 }}>{left}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: '13px', fontWeight: 600, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {primary}
        </p>
        {secondary && (
          <p style={{ fontSize: '11px', color: TEXT_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {secondary}
          </p>
        )}
      </div>
      {right && <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>{right}</div>}
    </div>
  )
}
