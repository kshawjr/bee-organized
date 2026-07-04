// components/hive/BuzzDrawer.jsx
// ─────────────────────────────────────────────────────────────
// THE buzz idiom (3b142f5), extracted shared: collapsed 🐝 one-liner
// (latest buzz ellipsized / 'No buzz yet'), tap to expand the inline
// drawer — autofocused 'Add buzz…' composer (Enter posts + clears +
// keeps focus) over the client-level timeline (newest-first, author +
// age). Panel strip, Inbox rows, and ClientProfile all render THIS —
// any buzz UX change lands everywhere at once.
//
// Controlled: parent owns `open`/`onToggle` (Inbox keeps one row's
// drawer open at a time) and the notes array + onPost (optimistic
// prepend lives with the data owner). All clicks stopPropagation —
// hosts are clickable rows/cards.
//
// header=true (ClientProfile): a '🐝 BUZZ' MicroLabel-style toggle
// replaces the one-liner; collapsed still shows the quiet latest line.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { relAge } from './shared/engagementStatus'
import { ACCENT_BLUE } from './shared/stageConfig'

export default function BuzzDrawer({
  notes = [],           // [{id, text, user_label, created_at}]
  onPost,               // (text) => void — parent posts + prepends
  open, onToggle,       // controlled
  header = false,       // profile variant
  onAllBuzz = null,     // optional 'All buzz →' footer action
  showMoreCap = null,   // cap the visible list at N with 'Show more'
  nowMs = Date.now(),
}) {
  const [draft, setDraft] = useState('')
  const [showAll, setShowAll] = useState(false)
  const sorted = [...notes].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  const latest = sorted[0]
  const visible = showMoreCap && !showAll ? sorted.slice(0, showMoreCap) : sorted

  const post = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onPost(text)
  }

  const chevron = <span style={{ flexShrink: 0, fontSize: '9px', color: '#b5b3ac' }}>{open ? '▾' : '▸'}</span>
  const quietLine = (
    <p style={{ fontSize: '11px', color: latest ? '#6b6b66' : '#b5b3ac', display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
      {!header && <span style={{ flexShrink: 0 }}>🐝</span>}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{latest?.text || 'No buzz yet'}</span>
      {!header && chevron}
    </p>
  )

  return (
    <div>
      {header ? (
        <p onClick={e => { e.stopPropagation(); onToggle() }}
          style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '8px', cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ letterSpacing: 0 }}>🐝</span> Buzz {chevron}
        </p>
      ) : (
        <div onClick={e => { e.stopPropagation(); onToggle() }} style={{ cursor: 'pointer', userSelect: 'none' }}>
          {quietLine}
        </div>
      )}
      {header && !open && quietLine}
      {open && (
        <div onClick={e => e.stopPropagation()}
          style={{
            display: 'flex', flexDirection: 'column', gap: '8px',
            ...(header ? {} : { marginTop: '10px', paddingTop: '10px', borderTop: '0.5px solid rgba(0,0,0,0.07)' }),
          }}>
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Add buzz…" autoFocus
            onKeyDown={e => { if (e.key === 'Enter') post() }}
            style={{ padding: '7px 10px', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none', background: '#fff' }} />
          {visible.length > 0 && (
            <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {visible.map(n => (
                <p key={n.id} style={{ fontSize: '12px', color: '#1a1a18', lineHeight: 1.4 }}>
                  🐝 {n.text}
                  <span style={{ fontSize: '10px', color: '#b5b3ac', marginLeft: '6px', whiteSpace: 'nowrap' }}>
                    {[n.user_label || '—', n.created_at ? `${relAge(new Date(n.created_at).getTime(), nowMs)} ago` : null].filter(Boolean).join(' · ')}
                  </span>
                </p>
              ))}
            </div>
          )}
          {showMoreCap && sorted.length > showMoreCap && !showAll && (
            <button onClick={() => setShowAll(true)}
              style={{ border: 'none', background: 'transparent', padding: 0, textAlign: 'left', fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
              Show {sorted.length - showMoreCap} more
            </button>
          )}
          {onAllBuzz && (
            <button onClick={onAllBuzz}
              style={{ border: 'none', background: 'transparent', padding: 0, textAlign: 'left', fontSize: '11px', fontWeight: 500, color: ACCENT_BLUE, cursor: 'pointer', fontFamily: 'inherit' }}>
              All buzz →
            </button>
          )}
        </div>
      )}
    </div>
  )
}
