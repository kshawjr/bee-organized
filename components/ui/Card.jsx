// components/ui/Card.jsx — white card on quiet surface, hairline border.
'use client'

import React from 'react'

export default function Card({ children, onClick = null, highlighted = false }) {
  return (
    <div
      onClick={onClick || undefined}
      style={{
        background: 'white',
        border: `1px solid ${highlighted ? 'rgba(13,148,136,0.35)' : 'rgba(0,0,0,0.07)'}`,
        borderRadius: '10px',
        padding: '12px',
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: highlighted ? '0 1px 6px rgba(13,148,136,0.12)' : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {children}
    </div>
  )
}
