// components/hive/RetiredTagsPanel.jsx
// ─────────────────────────────────────────────────────────────
// Configure › Tags › Retired (corporate, 2026-10-16) — every switched-off
// corporate tag. Restore switches it back on. Delete is PERMANENT and only
// for a tag nobody carries, no undo log names, and that was never part of
// the merge — the merged ones are what tells an owner "corporate retired
// this" and files their request, so they always say why they're kept.
// The button is never hidden: greyed with the reason instead.
// §8.5: owns its fetches.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T } from './shared/tokens'
import { tagText } from './shared/tagText'

const btn = (danger = false, off = false) => ({
  padding: '5px 10px', borderRadius: T.radius.control, border: T.border.thin,
  background: danger ? T.state.danger.soft : T.surface.raised, color: danger ? T.state.danger.fg : T.ink.secondary,
  fontSize: 12, fontWeight: 500, cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.45 : 1, fontFamily: 'inherit',
})

export default function RetiredTagsPanel({ onChanged = () => {} }) {
  const [tags, setTags] = useState(null)
  const [error, setError] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [busy, setBusy] = useState(null)
  const [key, setKey] = useState(0)

  useEffect(() => {
    let dead = false
    fetch('/api/tags/retired')
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`); return j })
      .then(j => { if (!dead) setTags(j.tags || []) })
      .catch(e => { if (!dead) { setError(String(e?.message || e)); setTags([]) } })
    return () => { dead = true }
  }, [key])

  async function restore(t) {
    setBusy(t.id); setError(null)
    const r = await fetch(`/api/lookups/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: true }) })
    setBusy(null)
    if (!r.ok) { setError(`Couldn't restore “${t.label}”`); return }
    setKey(k => k + 1); onChanged()
  }
  async function hardDelete(t) {
    setBusy(t.id); setError(null)
    const r = await fetch('/api/tags/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id }) })
    const j = await r.json().catch(() => ({}))
    setBusy(null)
    if (!r.ok) { setError(`Couldn't delete “${t.label}”: ${j.reason || j.error || r.status}`); setKey(k => k + 1); return }
    setDeleting(null); setKey(k => k + 1)
  }

  if (!tags || (tags.length === 0 && !error)) return null
  return (
    <div data-testid="retired-tags-panel" style={{ marginBottom: 20 }}>
      <p style={{ fontSize: 10, fontWeight: 700, color: T.ink.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 4 }}>Retired tags</p>
      <p style={{ fontSize: 12, color: T.ink.quiet, margin: '0 0 8px' }}>Switched off. Restore brings one back; Delete removes it for good.</p>
      {error && <p role="alert" style={{ fontSize: 12, color: T.state.danger.fg }}>{error}</p>}
      {deleting && (
        <div role="dialog" aria-label={`Delete ${deleting.label}`} style={{ padding: 12, margin: '0 0 8px', borderRadius: T.radius.inset, border: `1px solid ${T.state.danger.fg}`, background: T.state.danger.soft }}>
          <p style={{ fontSize: 13, color: T.ink.primary, margin: '0 0 8px' }}>Delete “{deleting.label}” permanently? Nobody carries it. <strong>This can’t be undone.</strong></p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btn(true)} disabled={busy === deleting.id} onClick={() => hardDelete(deleting)}>Delete permanently</button>
            <button style={btn()} onClick={() => setDeleting(null)}>Keep it</button>
          </div>
        </div>
      )}
      <div style={{ background: T.surface.raised, borderRadius: T.radius.card, border: T.border.card, overflow: 'hidden' }}>
        {tags.map(t => (
          <div key={t.id} data-retired-tag={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderBottom: T.border.thin }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 500, color: T.ink.primary, margin: 0 }}>{tagText(t)}</p>
              {t.reason && <p style={{ fontSize: 11, color: T.ink.muted, margin: '2px 0 0' }}>Can’t delete: {t.reason}</p>}
            </div>
            <button style={btn()} disabled={busy === t.id} onClick={() => restore(t)}>Restore</button>
            <button style={btn(true, !!t.reason)} disabled={!!busy || !!t.reason} title={t.reason || undefined} onClick={() => setDeleting(t)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  )
}
