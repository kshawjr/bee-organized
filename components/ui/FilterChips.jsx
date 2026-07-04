// components/ui/FilterChips.jsx — quiet horizontal filter strip (LOCKED
// list mockup): active chip is a white hairline-bordered pill with a
// weight-500 label ('Open · 7' — count inline after a middot); inactive
// chips are borderless muted text. items may set muted:true for an
// extra-quiet chip (e.g. 'Closed'). Scrolls horizontally on narrow
// viewports (§7 mobile rule) instead of wrapping.
'use client'

import React from 'react'

export default function FilterChips({ items = [], active, onChange }) {
  return (
    <div style={{
      display: 'flex', gap: '4px', overflowX: 'auto',
      WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none',
      paddingBottom: '2px',
    }}>
      {items.map(({ key, label, count, muted }) => {
        const isActive = key === active
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            style={{
              flexShrink: 0,
              padding: '5px 12px',
              borderRadius: '20px',
              border: `0.5px solid ${isActive ? 'rgba(0,0,0,0.15)' : 'transparent'}`,
              background: isActive ? '#fff' : 'transparent',
              color: isActive ? '#1a1a18' : (muted ? '#c9c7c0' : '#8a8a84'),
              fontSize: '12px', fontWeight: isActive ? 500 : 400,
              fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {label}
            {count != null && (
              <span style={{ marginLeft: '4px', color: isActive ? '#8a8a84' : (muted ? '#d5d3cc' : '#b5b3ac'), fontWeight: 400 }}>· {count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
