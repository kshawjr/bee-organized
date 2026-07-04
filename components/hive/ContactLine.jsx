// components/hive/ContactLine.jsx — the quiet tap-to-act contact line
// shared by board cards, list rows, and the panel client strip: 11px
// muted, phone (tel:) then email (mailto:), email ellipsized, links
// stopPropagation so tapping them never opens the row's panel. Renders
// nothing when both fields are missing (no dashes). Beta chunk.
'use client'

import React from 'react'
import { IconPhone, IconMail } from '@/components/ui/icons'

const linkStyle = {
  color: '#8a8a84', textDecoration: 'none',
  display: 'inline-flex', alignItems: 'center', gap: '4px',
}

export default function ContactLine({ phone = null, email = null, style = {} }) {
  if (!phone && !email) return null
  return (
    <p style={{ fontSize: '11px', color: '#8a8a84', display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, ...style }}>
      {phone && (
        <a href={`tel:${phone}`} onClick={e => e.stopPropagation()} style={{ ...linkStyle, flexShrink: 0 }}>
          <IconPhone size={11} />{phone}
        </a>
      )}
      {email && (
        <a href={`mailto:${email}`} onClick={e => e.stopPropagation()} style={{ ...linkStyle, minWidth: 0, overflow: 'hidden' }}>
          <IconMail size={11} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>
        </a>
      )}
    </p>
  )
}
