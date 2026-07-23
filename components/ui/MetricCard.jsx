// components/ui/MetricCard.jsx — small stat card on the light quiet
// surface (LOCKED panel mockup): #f7f6f4, radius 8, no border, label
// 11px muted, value 20px/500. tone tints the value through CHIP_STYLES
// text colors; default near-black ink.
'use client'

import React from 'react'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'
import { TEXT_MUTED } from '@/components/ui/tokens'

export default function MetricCard({ label, value, tone = null }) {
  const color = tone ? (CHIP_STYLES[tone] || CHIP_STYLES.gray).text : '#1a1a18'
  return (
    <div style={{
      background: '#f7f6f4',
      borderRadius: '8px',
      padding: '12px 14px',
      minWidth: 0,
    }}>
      <p style={{
        fontSize: '11px', fontWeight: 500, color: TEXT_MUTED, marginBottom: '3px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {label}
      </p>
      <p style={{ fontSize: '20px', fontWeight: 500, color, lineHeight: 1.2 }}>{value}</p>
    </div>
  )
}
