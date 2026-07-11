// components/hive/shared/TagsRow.jsx
// ─────────────────────────────────────────────────────────────
// Tag pills + the '+ Tag' popover — ClientProfile left column
// (card-restore build 3; the Build-2 button was a disabled ghost).
//
// Classic TagPopup semantics (BeeHub ~1012): a CHECKLIST of the
// admin-managed tag definitions, toggle on/off — but writes are
// IMMEDIATE per toggle (the quiet-system MetaSelect idiom), not
// batch-on-save: the routes are idempotent junction writes, so there's
// nothing a Save button would protect.
//   add    → POST   /api/lead-tags { lead_id, tag_lookup_id }
//   remove → DELETE /api/lead-tags?lead_id=…&tag_lookup_id=…
// Definitions come from lookups category='client_tags' (admin-managed;
// this component never creates definitions). Each pill also wears a
// quiet × for direct removal outside the popover.
//
// Optimistic per toggle with revert-on-failure. Host owns the tags
// array ([{ id, label }]) — onChange(next) after each confirmed write.
// §8.5: props only, no context.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { MicroLabel } from './cardKit'

export default function TagsRow({ leadId, tags = [], options = [], onChange = () => {}, setToast = () => {} }) {
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const has = (id) => tags.some(t => t.id === id)

  async function toggle(opt) {
    if (busyId) return
    const adding = !has(opt.id)
    setBusyId(opt.id)
    try {
      const res = adding
        ? await fetch('/api/lead-tags', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lead_id: leadId, tag_lookup_id: opt.id }),
          })
        : await fetch(`/api/lead-tags?lead_id=${encodeURIComponent(leadId)}&tag_lookup_id=${encodeURIComponent(opt.id)}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      onChange(adding ? [...tags, { id: opt.id, label: opt.label }] : tags.filter(t => t.id !== opt.id))
      setToast({ kind: 'success', msg: adding ? `Tagged ${opt.label}` : `Removed ${opt.label}` })
    } catch (e) {
      setToast({ kind: 'error', msg: `Tag ${adding ? 'add' : 'remove'} failed: ${e.message}` })
    } finally { setBusyId(null) }
  }

  return (
    <div>
      <MicroLabel>Tags</MicroLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', position: 'relative' }}>
        {tags.map(t => (
          <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 8px 3px 10px', borderRadius: '20px', border: '0.5px solid rgba(0,0,0,0.12)', background: '#fff', fontSize: '11px', color: '#1a1a18', whiteSpace: 'nowrap' }}>
            {t.label}
            <button aria-label={`Remove tag ${t.label}`} disabled={busyId === t.id}
              onClick={() => toggle(t)}
              style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '11px', lineHeight: 1, color: '#b5b3ac', cursor: 'pointer', fontFamily: 'inherit' }}>
              ✗
            </button>
          </span>
        ))}
        {tags.length === 0 && <span style={{ fontSize: '11px', color: '#b5b3ac' }}>No tags</span>}
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <button onClick={() => setOpen(v => !v)} aria-label="Add tag"
            style={{ padding: '3px 10px', borderRadius: '20px', border: '0.5px dashed rgba(0,0,0,0.18)', background: 'transparent', fontSize: '11px', color: '#8a8a84', fontFamily: 'inherit', cursor: 'pointer' }}>
            + Tag
          </button>
          {open && (
            <>
              <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10009 }} />
              <div onClick={e => e.stopPropagation()}
                style={{ position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 10010, width: '210px', maxHeight: '46vh', overflowY: 'auto', background: '#fff', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '10px', boxShadow: '0 8px 30px rgba(26,26,24,0.12)', padding: '8px 12px' }}>
                {options.map(o => (
                  <button key={o.id} disabled={busyId === o.id}
                    onClick={() => toggle(o)}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: '8px', border: 'none', background: 'transparent', fontSize: '12px', color: has(o.id) ? '#1a1a18' : '#6b6b66', fontWeight: has(o.id) ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                    <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: '#1D9E75', flexShrink: 0 }}>{has(o.id) ? '✓' : ''}</span>
                    {o.label}
                  </button>
                ))}
                {options.length === 0 && (
                  <p style={{ fontSize: '11px', color: '#b5b3ac', padding: '4px 0' }}>No tags configured — manage in Admin</p>
                )}
              </div>
            </>
          )}
        </span>
      </div>
    </div>
  )
}
