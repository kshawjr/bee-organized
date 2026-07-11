// components/ui/StatusChip.jsx — colored status chip, dark-on-light ramp.
// LOCKED anatomy (design-system pass 7/11): 11px text, weight 500,
// padding 2px 8px, radius 8px RECTANGLE (T.radius.chip — status chips
// read data-dense; tags stay pills, they're categorical), no border.
// styleKey resolves through CHIP_STYLES (components/hive/shared/
// stageConfig — the ONE color-semantics source); unknown keys fall
// back to gray.
'use client'

import React from 'react'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'
import { T } from '@/components/hive/shared/tokens'

export default function StatusChip({ label, styleKey = 'gray', icon = null }) {
  // Silent fallthrough to gray hid a class of mapping bugs — warn loudly
  // in dev when a styleKey misses the single source.
  if (process.env.NODE_ENV !== 'production' && styleKey && !CHIP_STYLES[styleKey]) {
    console.warn('[StatusChip] unknown styleKey — falling back to gray:', styleKey, '(label:', label, ')')
  }
  const s = CHIP_STYLES[styleKey] || CHIP_STYLES.gray
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: '2px 8px',
      borderRadius: T.radius.chip,
      background: s.bg, color: s.text,
      fontSize: '11px', fontWeight: 500,
      lineHeight: 1.5, whiteSpace: 'nowrap',
    }}>
      {icon && <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 1 }}>{icon}</span>}
      {label}
    </span>
  )
}
