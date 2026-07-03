// components/ui/StatusChip.jsx — colored status pill, dark-on-light ramp.
// styleKey resolves through CHIP_STYLES (components/hive/shared/stageConfig
// — the ONE color-semantics source); unknown keys fall back to gray.
'use client'

import React from 'react'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'

export default function StatusChip({ label, styleKey = 'gray', icon = null, size = 'md' }) {
  const s = CHIP_STYLES[styleKey] || CHIP_STYLES.gray
  const sm = size === 'sm'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: sm ? '1px 6px' : '2px 8px',
      borderRadius: '20px',
      background: s.bg, color: s.text,
      fontSize: sm ? '10px' : '11px', fontWeight: 600,
      lineHeight: 1.6, whiteSpace: 'nowrap',
    }}>
      {icon && <span style={{ fontSize: sm ? '9px' : '10px', lineHeight: 1 }}>{icon}</span>}
      {label}
    </span>
  )
}
