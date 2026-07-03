// components/ui/MetricCard.jsx — small stat card: muted label, big value.
// tone tints the value through CHIP_STYLES text colors (teal/blue/amber/
// red/purple/gray); default ink.
'use client'

import React from 'react'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'

export default function MetricCard({ label, value, tone = null }) {
  const color = tone ? (CHIP_STYLES[tone] || CHIP_STYLES.gray).text : '#1a2e2b'
  return (
    <div style={{
      background: '#fff',
      border: '0.5px solid rgba(0,0,0,0.08)',
      borderRadius: '12px',
      padding: '14px 16px',
      minWidth: 0,
    }}>
      <p style={{
        fontSize: '11px', fontWeight: 600, color: '#8a9e9a',
        textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '4px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {label}
      </p>
      <p style={{ fontSize: '22px', fontWeight: 700, color, lineHeight: 1.2 }}>{value}</p>
    </div>
  )
}
