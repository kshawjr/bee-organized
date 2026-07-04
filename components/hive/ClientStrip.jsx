// components/hive/ClientStrip.jsx
// ─────────────────────────────────────────────────────────────
// The person-block strip (quiet card, no border): avatar + name (+chip)
// + meta line + the shared BuzzDrawer line-toggle + ContactLine, with an
// optional right-side action. Extracted from EngagementPanel so the
// pre-engagement PersonCard renders the IDENTICAL strip. Beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import StatusChip from '@/components/ui/StatusChip'
import ContactLine from './ContactLine'
import BuzzDrawer from './BuzzDrawer'

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

export default function ClientStrip({
  name, chip = null, meta,
  phone, email,
  buzz = [], buzzOpen, onToggleBuzz, onPostBuzz, onAllBuzz = null,
  action = null, isMobile = false,
}) {
  return (
    <div style={{ padding: '10px 12px', background: '#f7f6f4', borderRadius: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: '#EEEDFE', color: '#3C3489', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>
          {initialsOf(name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            {chip && <StatusChip label={chip.label} styleKey={chip.styleKey} />}
          </p>
          <p style={{ fontSize: '11px', color: '#8a8a84', marginTop: '1px' }}>{meta}</p>
          {/* Buzz rides with the PERSON — the shared bee drawer (read +
              add in place). Client-level, identical everywhere. */}
          <div style={{ marginTop: '3px' }}>
            <BuzzDrawer notes={buzz} open={buzzOpen} onToggle={onToggleBuzz} onPost={onPostBuzz} onAllBuzz={onAllBuzz} />
          </div>
          <ContactLine phone={phone} email={email} layout={isMobile ? 'stack' : 'inline'} style={{ marginTop: '3px' }} />
        </div>
        {action}
      </div>
    </div>
  )
}
