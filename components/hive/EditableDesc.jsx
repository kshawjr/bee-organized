// components/hive/EditableDesc.jsx
// ─────────────────────────────────────────────────────────────
// The description quote-block idiom (dfa1669): indented italic text on
// the quiet surface, 2-line clamp with in-place 'Show more', tap-to-edit
// textarea + readable ✎. Bound to leads.request_details on PersonCard /
// ClientProfile AND engagements.description on EngagementPanel (its
// private copy of this idiom was consolidated here 7/10). Beta chunk.
//
// Affordances follow the shared inline-edit standard
// (shared/inlineEdit.jsx, Kevin 7/10): EditPencil in view mode; the
// edit textarea gains the green-✓ / muted-✗ pair below-right (⌘-Enter
// still saves, Esc still cancels); in-flight disables the pair.
//
// onSave(text) may be async and may resolve `false` to signal a failed
// write — the textarea stays OPEN with a quiet inline error and the
// draft intact (hosts that revert-and-toast internally return false on
// failure; any other resolution counts as success and closes the edit).
//
// showEmpty=false renders NOTHING when there's no text (list contexts
// stay scannable); showEmpty=true offers the dashed add-slot.
// All interactions stopPropagation — hosts are clickable rows/cards.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useRef } from 'react'
import { EditPencil, InlineEditControls } from './shared/inlineEdit'
import { T } from './shared/tokens'

const QUIET = T.surface.sunken

export default function EditableDesc({ text, onSave, placeholder = 'Describe the request…', showEmpty = false, style = {}, readOnly = false }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // Ref, not state: disabling the textarea mid-save fires its blur while
  // the save is still in flight — the re-entry guard must be synchronous.
  const saving = useRef(false)
  const t = (text || '').trim()

  const cancel = () => { setErr(null); setEditing(false) }

  const save = async () => {
    if (saving.current) return
    const v = draft.trim().slice(0, 2000)
    if (v === t) { cancel(); return }
    saving.current = true
    setBusy(true)
    const ok = await Promise.resolve(onSave(v)).catch(() => false)
    saving.current = false
    setBusy(false)
    if (ok === false) { setErr("Couldn't save — try again"); return } // stay editing, draft intact
    setErr(null)
    setEditing(false)
  }

  if (editing) {
    return (
      <div onClick={e => e.stopPropagation()} style={style}>
        <textarea
          autoFocus
          value={draft}
          disabled={busy}
          onChange={e => { setDraft(e.target.value); if (err) setErr(null) }}
          onBlur={save}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
            if (e.key === 'Escape') cancel()
          }}
          rows={3}
          maxLength={2000}
          placeholder={placeholder}
          style={{ width: '100%', padding: '8px 10px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', lineHeight: 1.45, color: T.ink.primary, fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
          {err && <p style={{ flex: 1, fontSize: '11px', color: T.state.danger.fg }}>{err}</p>}
          <InlineEditControls busy={busy} onSave={save} onCancel={cancel} saveHint="⌘-Enter" />
        </div>
      </div>
    )
  }

  if (!t) {
    if (!showEmpty || readOnly) return null
    return (
      <button onClick={e => { e.stopPropagation(); setDraft(''); setEditing(true) }}
        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: T.border.dashed, borderRadius: T.radius.control, background: 'transparent', fontSize: '12px', color: T.ink.quiet, cursor: 'text', fontFamily: 'inherit', ...style }}>
        Add a description…
      </button>
    )
  }

  const clampLikely = t.length > 120 || t.includes('\n')
  return (
    <div onClick={readOnly ? undefined : (e => { e.stopPropagation(); setDraft(t); setEditing(true) })}
      title={readOnly ? undefined : 'Click to edit'}
      style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', cursor: readOnly ? 'default' : 'text', background: QUIET, borderRadius: T.radius.control, padding: '8px 10px', ...style }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize: '12px', fontStyle: 'italic', color: T.ink.secondary, lineHeight: 1.45, whiteSpace: 'pre-wrap',
          ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
        }}>
          {t}
        </p>
        {clampLikely && !expanded && (
          <button onClick={e => { e.stopPropagation(); setExpanded(true) }}
            style={{ border: 'none', background: 'transparent', padding: 0, marginTop: '2px', fontSize: '11px', color: T.ink.muted, cursor: 'pointer', fontFamily: 'inherit' }}>
            Show more
          </button>
        )}
      </div>
      <EditPencil readOnly={readOnly} />
    </div>
  )
}
