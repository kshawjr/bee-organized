// components/ui/Card.jsx — pure white card, hairline border, no shadow.
// LOCKED (mockup spec): #fff, 0.5px solid rgba(0,0,0,0.08), radius 10px,
// padding 10px 12px, no shadows, no gradients.
'use client'

import React from 'react'

export default function Card({ children, onClick = null, highlighted = false }) {
  return (
    <div
      onClick={onClick || undefined}
      style={{
        background: '#fff',
        border: `0.5px solid ${highlighted ? 'rgba(8,80,65,0.35)' : 'rgba(0,0,0,0.08)'}`,
        borderRadius: '10px',
        padding: '10px 12px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
      }}
    >
      {children}
    </div>
  )
}
