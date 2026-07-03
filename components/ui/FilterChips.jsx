// components/ui/FilterChips.jsx — horizontal filter chip strip.
// Scrolls horizontally on narrow viewports (§7 mobile rule) instead of
// wrapping; counts render muted after the label.
'use client'

import React from 'react'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'

export default function FilterChips({ items = [], active, onChange }) {
  return (
    <div style={{
      display: 'flex', gap: '6px', overflowX: 'auto',
      WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none',
      paddingBottom: '2px',
    }}>
      {items.map(({ key, label, count, styleKey }) => {
        const isActive = key === active
        const accent = styleKey ? (CHIP_STYLES[styleKey] || CHIP_STYLES.gray) : null
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            style={{
              flexShrink: 0,
              padding: '5px 11px',
              borderRadius: '20px',
              border: `1px solid ${isActive ? '#1a2e2b' : 'rgba(0,0,0,0.1)'}`,
              background: isActive ? '#1a2e2b' : (accent ? accent.bg : 'white'),
              color: isActive ? 'white' : (accent ? accent.text : '#4a5e5a'),
              fontSize: '12px', fontWeight: isActive ? 600 : 500,
              fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {label}
            {count != null && (
              <span style={{ marginLeft: '5px', opacity: 0.65, fontWeight: 400 }}>{count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
