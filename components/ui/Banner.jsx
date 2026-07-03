// components/ui/Banner.jsx — icon + text strip with an optional action,
// tinted by tone (CHIP_STYLES family). The directory nurture-pool banner
// (§5/§7) is the canonical consumer.
'use client'

import React from 'react'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'

export default function Banner({ icon, text, action = null, tone = 'amber' }) {
  const s = CHIP_STYLES[tone] || CHIP_STYLES.amber
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '10px 12px',
      background: s.bg,
      border: `1px solid ${s.bg.replace(/[\d.]+\)$/, '0.35)')}`,
      borderRadius: '10px',
    }}>
      <span style={{ fontSize: '16px', flexShrink: 0, lineHeight: 1 }}>{icon}</span>
      <p style={{ flex: 1, minWidth: 0, fontSize: '12px', color: '#1a2e2b', lineHeight: 1.4 }}>{text}</p>
      {action && (
        <button
          onClick={action.onClick}
          style={{
            flexShrink: 0,
            padding: '5px 12px',
            borderRadius: '8px',
            border: 'none',
            background: s.text, color: 'white',
            fontSize: '12px', fontWeight: 600,
            fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
