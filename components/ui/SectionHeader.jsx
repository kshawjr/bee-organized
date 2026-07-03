// components/ui/SectionHeader.jsx — muted uppercase section label with an
// optional count, matching the app's #8a9e9a section-label convention.
'use client'

import React from 'react'

export default function SectionHeader({ label, count = null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '8px' }}>
      <span style={{
        fontSize: '11px', fontWeight: 600, color: '#8a9e9a',
        textTransform: 'uppercase', letterSpacing: '0.4px',
      }}>
        {label}
      </span>
      {count != null && (
        <span style={{ fontSize: '11px', color: '#b0c0bc', fontWeight: 500 }}>{count}</span>
      )}
    </div>
  )
}
