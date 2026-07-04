// components/hive/ContactLine.jsx — tap-to-act contact block shared by
// board cards, list rows, and the panel client strip. STACKED by default
// (phone line + email line, 2px gap — full-width lines so emails rarely
// truncate; ellipsis stays as the overflow fallback). layout="inline"
// keeps one line for wide hosts (the 540px+ panel strip).
//
// Link idiom (everywhere contact renders): ACCENT_BLUE value, no
// underline at rest, underline on hover; icons stay muted gray so the
// VALUE reads as the link. stopPropagation so taps never open the row's
// panel. Renders nothing when both fields are missing. Beta chunk.
'use client'

import React from 'react'
import { IconPhone, IconMail } from '@/components/ui/icons'
import { ACCENT_BLUE } from './shared/stageConfig'

const linkStyle = {
  color: ACCENT_BLUE, textDecoration: 'none',
  display: 'inline-flex', alignItems: 'center', gap: '4px',
  minWidth: 0, overflow: 'hidden',
}
const iconStyle = { color: '#8a8a84', display: 'inline-flex', flexShrink: 0 }
const valueStyle = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function Hover() {
  return <style>{`.bee-contact-link:hover { text-decoration: underline !important; text-underline-offset: 2px }`}</style>
}

export default function ContactLine({ phone = null, email = null, layout = 'stack', style = {} }) {
  if (!phone && !email) return null

  const phoneLink = phone && (
    <a className="bee-contact-link" href={`tel:${phone}`} onClick={e => e.stopPropagation()} style={{ ...linkStyle, flexShrink: 0 }}>
      <span style={iconStyle}><IconPhone size={11} /></span>
      <span style={valueStyle}>{phone}</span>
    </a>
  )
  const emailLink = email && (
    <a className="bee-contact-link" href={`mailto:${email}`} onClick={e => e.stopPropagation()} style={linkStyle}>
      <span style={iconStyle}><IconMail size={11} /></span>
      <span style={valueStyle}>{email}</span>
    </a>
  )

  if (layout === 'inline') {
    return (
      <p style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, ...style }}>
        <Hover />
        {phoneLink}
        {emailLink}
      </p>
    )
  }
  return (
    <div style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, ...style }}>
      <Hover />
      {phoneLink}
      {emailLink}
    </div>
  )
}
