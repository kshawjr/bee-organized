// components/hive/NotesStream.jsx
// ─────────────────────────────────────────────────────────────
// The NOTES section idiom: micro label + buttonless composer (Enter
// posts + clears + keeps focus) over one interleaved stream of typed
// notes and touchpoints (method icon + 'Call · Kevin · 2 Hours ago').
// Extracted from EngagementPanel so the pre-engagement PersonCard's
// 'NOTES · this person' is the identical component. Beta chunk.
//
// items: [{ t:'note', id, ts, text, user_label }
//         | { t:'touch', id, ts, method, label, notes, user_label }]
// pre-merged by the host; rendered newest-first by ts here.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { relAge } from './shared/engagementStatus'
import { IconPhone, IconMail } from '@/components/ui/icons'

export const METHOD_LABEL = { call: 'Call', sms: 'Text', email: 'Email', in_person: 'In person', call_prompt: 'Call prompt', system: 'System' }

export default function NotesStream({ label, items = [], onPost, placeholder = 'Add a note…', nowMs = Date.now() }) {
  const [draft, setDraft] = useState('')
  const post = () => {
    const t = draft.trim()
    if (!t) return
    setDraft('')
    onPost(t)
  }
  const sorted = [...items].sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0))
  return (
    <div>
      <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '8px' }}>
        {label}
      </p>
      <div style={{ display: 'flex', marginBottom: sorted.length ? '10px' : 0 }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={placeholder}
          onKeyDown={e => { if (e.key === 'Enter') post() }}
          style={{ flex: 1, padding: '8px 12px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {sorted.map(a => a.t === 'note' ? (
          <p key={`n-${a.id}`} style={{ fontSize: '12px', color: '#1a1a18', lineHeight: 1.45 }}>
            {a.text}
            <span style={{ fontSize: '10px', color: '#b5b3ac', marginLeft: '6px', whiteSpace: 'nowrap' }}>
              {a.user_label || '—'} · {relAge(new Date(a.ts).getTime(), nowMs)} ago
            </span>
          </p>
        ) : (
          <p key={`t-${a.id}`} style={{ fontSize: '12px', color: '#1a1a18', lineHeight: 1.45, display: 'flex', alignItems: 'baseline', gap: '6px' }}>
            <span style={{ color: '#8a8a84', display: 'inline-flex', flexShrink: 0, alignSelf: 'center' }}>
              {a.method === 'email' ? <IconMail size={12} /> : <IconPhone size={12} />}
            </span>
            <span style={{ minWidth: 0 }}>
              {METHOD_LABEL[a.method] || a.label || 'Reach-out'}{a.notes ? ` — ${a.notes}` : ''}
              <span style={{ fontSize: '10px', color: '#b5b3ac', marginLeft: '6px', whiteSpace: 'nowrap' }}>
                {a.user_label || '—'} · {relAge(new Date(a.ts).getTime(), nowMs)} ago
              </span>
            </span>
          </p>
        ))}
      </div>
    </div>
  )
}
