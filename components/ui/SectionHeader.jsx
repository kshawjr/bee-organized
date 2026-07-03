// components/ui/SectionHeader.jsx — muted section label with optional count.
// LOCKED (mockup spec): 12px, weight 500, sentence case, #6b6b66; count
// follows a '·' separator in lighter gray ("Request · 10").
'use client'

import React from 'react'

export default function SectionHeader({ label, count = null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '8px' }}>
      <span style={{ fontSize: '12px', fontWeight: 500, color: '#6b6b66' }}>
        {label}
      </span>
      {count != null && (
        <span style={{ fontSize: '12px', fontWeight: 400, color: '#b5b3ac', marginLeft: '5px' }}>· {count}</span>
      )}
    </div>
  )
}
