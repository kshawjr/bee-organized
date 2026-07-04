// components/hive/shared/PinnedBuzz.jsx
// ─────────────────────────────────────────────────────────────
// The pinned buzz note — treatment A: a soft warning-tinted band at the
// top of every card's Overview. Holds the client's standing note (gate
// codes, call preferences) so it's noticed BEFORE acting, without being
// loud: no hard border, design-language amber, one quiet pencil.
//
// Buzz is CLIENT-LEVEL (lead_notes kind='buzz') and APPEND-ONLY with
// authored history behind it — same controlled contract as BuzzDrawer
// (notes + onPost live with the data owner; "editing" appends a new
// note, never mutates one). The SAME notes array shows on ClientProfile
// and that client's EngagementPanel(s); on PersonCard it's the lead's
// buzz that carries forward at founding.
//
// Collapsed: pin + latest note, one line. Tap (band or pencil) →
// history + append input in place. No buzz yet → a quiet add
// affordance in the same slot, NOT an empty amber band.
// §8.5: props only, no context.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { IconPin, IconPencil } from '@/components/ui/icons'
import { WARNING_BG, WARNING_TEXT } from '@/components/ui/tokens'
import { relAge } from './engagementStatus'

export default function PinnedBuzz({ notes = [], onPost = () => {}, emptyLabel = 'Add a note about this client', nowMs = Date.now() }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const sorted = [...notes].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  const latest = sorted[0]

  const post = () => {
    const t = draft.trim()
    if (!t) return
    setDraft('')
    onPost(t)
  }

  // Empty state — quiet affordance, no band.
  if (!latest && !open) {
    return (
      <button
        aria-label="Add buzz"
        onClick={() => setOpen(true)}
        style={{
          display: 'flex', alignItems: 'center', gap: '7px', width: '100%',
          border: 'none', background: 'transparent', padding: '4px 0', margin: 0,
          fontFamily: 'inherit', fontSize: '12px', color: '#8a8a84',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <IconPin size={13} />
        <span style={{ borderBottom: '1px dashed rgba(0,0,0,0.2)' }}>{emptyLabel}</span>
      </button>
    )
  }

  return (
    <div style={{ background: `var(--bg-warning, ${WARNING_BG})`, borderRadius: '8px', padding: '8px 12px' }}>
      <div
        role="button"
        tabIndex={0}
        aria-label={open ? 'Collapse buzz' : 'Expand buzz'}
        onClick={() => setOpen(v => !v)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => !v) } }}
        style={{ display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer', minWidth: 0 }}
      >
        <span style={{ color: `var(--text-warning, ${WARNING_TEXT})`, display: 'inline-flex', flexShrink: 0 }}>
          <IconPin size={13} />
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: '12px', color: `var(--text-warning, ${WARNING_TEXT})`,
          ...(open ? { whiteSpace: 'normal', overflowWrap: 'anywhere' } : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
        }}>
          {latest ? latest.text : 'Buzz'}
        </span>
        <span aria-label="Edit buzz" title="Edit buzz" style={{ color: '#b5b3ac', display: 'inline-flex', flexShrink: 0 }}>
          <IconPencil size={13} />
        </span>
      </div>

      {open && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }} onClick={e => e.stopPropagation()}>
          {/* Append path — buzz is authored history; a new note goes on
              top, nothing is edited in place. */}
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') post(); if (e.key === 'Escape') setOpen(false) }}
            placeholder="Add buzz…"
            aria-label="Add buzz note"
            style={{
              padding: '7px 10px', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '8px',
              fontSize: '12px', fontFamily: 'inherit', outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box',
            }}
          />
          {sorted.length > 0 && (
            <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '5px' }}>
              {sorted.map(n => (
                <p key={n.id} style={{ fontSize: '12px', color: '#1a1a18', lineHeight: 1.4 }}>
                  {n.text}
                  <span style={{ fontSize: '10px', color: '#b5b3ac', marginLeft: '6px', whiteSpace: 'nowrap' }}>
                    {[n.user_label || '—', n.created_at ? `${relAge(new Date(n.created_at).getTime(), nowMs)} ago` : null].filter(Boolean).join(' · ')}
                  </span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
