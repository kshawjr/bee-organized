// components/hive/EditableDesc.jsx
// ─────────────────────────────────────────────────────────────
// The description quote-block idiom (dfa1669): indented italic text on
// the quiet surface, 2-line clamp with in-place 'Show more', tap-to-edit
// textarea + faint ✎. Bound to leads.request_details on Inbox rows and
// ClientProfile (the pre-engagement description); EngagementPanel keeps
// its own engagement-bound copy of the same idiom. Beta chunk only.
//
// showEmpty=false renders NOTHING when there's no text (list contexts
// stay scannable); showEmpty=true offers the dashed add-slot.
// All interactions stopPropagation — hosts are clickable rows/cards.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'

const QUIET = '#f7f6f4'

export default function EditableDesc({ text, onSave, placeholder = 'Describe the request…', showEmpty = false, style = {} }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(false)
  const t = (text || '').trim()

  const save = () => {
    setEditing(false)
    const v = draft.trim().slice(0, 2000)
    if (v !== t) onSave(v)
  }

  if (editing) {
    return (
      <textarea
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
          if (e.key === 'Escape') setEditing(false)
        }}
        rows={3}
        maxLength={2000}
        placeholder={placeholder}
        style={{ width: '100%', padding: '8px 10px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '6px', fontSize: '12px', lineHeight: 1.45, color: '#1a1a18', fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box', ...style }}
      />
    )
  }

  if (!t) {
    if (!showEmpty) return null
    return (
      <button onClick={e => { e.stopPropagation(); setDraft(''); setEditing(true) }}
        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: '0.5px dashed rgba(0,0,0,0.15)', borderRadius: '6px', background: 'transparent', fontSize: '12px', color: '#b5b3ac', cursor: 'text', fontFamily: 'inherit', ...style }}>
        Add a description…
      </button>
    )
  }

  const clampLikely = t.length > 120 || t.includes('\n')
  return (
    <div onClick={e => { e.stopPropagation(); setDraft(t); setEditing(true) }}
      title="Click to edit"
      style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', cursor: 'text', background: QUIET, borderRadius: '6px', padding: '8px 10px', ...style }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize: '12px', fontStyle: 'italic', color: '#6b6b66', lineHeight: 1.45, whiteSpace: 'pre-wrap',
          ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
        }}>
          {t}
        </p>
        {clampLikely && !expanded && (
          <button onClick={e => { e.stopPropagation(); setExpanded(true) }}
            style={{ border: 'none', background: 'transparent', padding: 0, marginTop: '2px', fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
            Show more
          </button>
        )}
      </div>
      <span style={{ fontSize: '11px', color: '#c9c7c0', flexShrink: 0 }}>✎</span>
    </div>
  )
}
