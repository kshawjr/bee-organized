// components/ui/Banner.jsx — tinted notice strip (LOCKED directory
// mockup): tone fill (default amber #FAEEDA), radius 8, no border, icon
// + single-line 12px text both in the tone's dark text color; the action
// renders as a compact WHITE hairline button (13px), right-aligned. The
// nurture-pool banner (§5/§7) is the canonical consumer.
'use client'

import React from 'react'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'
import { HAIRLINE_BORDER } from './tokens'

export default function Banner({ icon, text, action = null, tone = 'amber' }) {
  const s = CHIP_STYLES[tone] || CHIP_STYLES.amber
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '10px 12px',
      background: s.bg,
      borderRadius: '8px',
    }}>
      <span style={{ fontSize: '14px', flexShrink: 0, lineHeight: 1, color: s.text }}>{icon}</span>
      <p style={{ flex: 1, minWidth: 0, fontSize: '12px', color: s.text, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</p>
      {action && (
        <button
          onClick={action.onClick}
          style={{
            flexShrink: 0,
            padding: '6px 12px',
            borderRadius: '8px',
            border: `0.5px solid var(--hairline-border, ${HAIRLINE_BORDER})`,
            background: '#fff', color: '#1a1a18',
            fontSize: '13px', fontWeight: 500,
            fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
