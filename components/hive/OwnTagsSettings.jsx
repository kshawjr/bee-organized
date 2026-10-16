// components/hive/OwnTagsSettings.jsx
// ─────────────────────────────────────────────────────────────
// Settings › Tags (2026-10-16) — a location's OWN tags, for its owner and
// manager. Corporate's list is managed on the Configure tab; this is only
// what the location created itself.
//   · each tag with how many people carry it (clients + Network)
//   · Rename — everywhere at once (people are linked to the tag, not its
//     name); the near-match guard applies, so a rename can't land on a name
//     that already exists ("Use Realtor" instead)
//   · Remove — a switch-off, not a delete: it leaves the pickers, filters
//     and people's records, but every link is kept, so Restore brings it all
//     back exactly. The confirm says how many people carry it first.
//   · Icon — from the curated grid only (TagIconGrid), or none
//   · Delete — PERMANENT, only when nothing carries it and no undo log names
//     it. Never hidden: when it can't, the button is greyed and says why
//     (migrations/tag_delete.sql decides). The confirm says it can't be undone.
// New tags are created where tags are picked (the Tags row's "+ Tag").
// §8.5: props only; owns its own fetches.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T } from './shared/tokens'
import { tagText } from './shared/tagText'
import TagIconGrid from './shared/TagIconGrid'

const btn = (tone = 'quiet') => ({
  padding: '5px 10px', borderRadius: T.radius.control, border: T.border.thin,
  background: tone === 'danger' ? T.state.danger.soft : T.surface.raised,
  color: tone === 'danger' ? T.state.danger.fg : T.ink.secondary,
  fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
})

const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`

export default function OwnTagsSettings({ locationId = null, locationName = '' }) {
  const [tags, setTags] = useState(null)   // null = loading
  const [error, setError] = useState(null)
  const [renaming, setRenaming] = useState(null)   // { id, value }
  const [confirming, setConfirming] = useState(null) // tag being removed
  const [deleting, setDeleting] = useState(null)     // tag being deleted for good
  const [iconFor, setIconFor] = useState(null)       // tag whose icon grid is open
  const [busy, setBusy] = useState(null)

  async function load() {
    if (!locationId) { setTags([]); return }
    try {
      const res = await fetch(`/api/tags/own?location_id=${encodeURIComponent(locationId)}`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setTags(j.tags || [])
    } catch (e) {
      setError(`Couldn't load your tags: ${e.message}`); setTags([])
    }
  }
  useEffect(() => { load() }, [locationId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function patch(tag, body, okMsg) {
    setBusy(tag.id); setError(null)
    try {
      const res = await fetch(`/api/lookups/${tag.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (res.status === 409 && j?.error === 'near_match') {
        setError(j.verdict === 'restore'
          ? `You already have “${j.tag.label}”, switched off — restore that instead.`
          : `“${j.tag.label}” is already a tag — use that instead of renaming.`)
        return false
      }
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setTags(prev => prev.map(t => (t.id === tag.id ? { ...t, ...j.lookup, people: t.people } : t)))
      if (okMsg) setError(null)
      return true
    } catch (e) {
      setError(`Couldn't save: ${e.message}`); return false
    } finally { setBusy(null) }
  }

  async function hardDelete(tag) {
    setBusy(tag.id); setError(null)
    try {
      const res = await fetch('/api/tags/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tag.id }) })
      const j = await res.json().catch(() => ({}))
      if (res.status === 409) {   // something changed since the list loaded
        setTags(prev => prev.map(t => (t.id === tag.id ? { ...t, deleteBlockers: j.blockers, deleteReason: j.reason } : t)))
        setError(`Couldn't delete “${tag.label}”: ${j.reason}`)
        return
      }
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setTags(prev => prev.filter(t => t.id !== tag.id))
      setDeleting(null)
    } catch (e) {
      setError(`Couldn't delete: ${e.message}`)
    } finally { setBusy(null) }
  }

  const active = (tags || []).filter(t => t.is_active !== false)
  const removed = (tags || []).filter(t => t.is_active === false)

  const row = (t, isRemoved) => (
    <div key={t.id} data-own-tag={t.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderBottom: T.border.thin, background: T.surface.raised, opacity: isRemoved ? 0.7 : 1 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {renaming?.id === t.id ? (
          <input autoFocus value={renaming.value} aria-label={`New name for ${t.label}`}
            onChange={e => setRenaming({ id: t.id, value: e.target.value })}
            onKeyDown={async e => {
              if (e.key === 'Escape') setRenaming(null)
              if (e.key === 'Enter' && renaming.value.trim() && renaming.value.trim() !== t.label) {
                if (await patch(t, { label: renaming.value.trim() })) setRenaming(null)
              }
            }}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: T.radius.control, border: T.border.control, fontSize: '13px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none' }} />
        ) : (
          <p style={{ fontSize: '13px', fontWeight: 600, color: T.ink.primary, margin: 0 }}>{tagText(t)}</p>
        )}
        <p style={{ fontSize: '11px', color: T.ink.quiet, margin: '2px 0 0' }}>
          {people(t.people)}{t.promoted ? ' · made corporate — it’s in the shared list now' : isRemoved ? ' · removed — hidden everywhere' : ''}
        </p>
        {/* Delete is never hidden: when it can't, say why. */}
        {t.deleteReason && (
          <p data-delete-blocked style={{ fontSize: '11px', color: T.ink.muted, margin: '2px 0 0' }}>Can’t delete: {t.deleteReason}</p>
        )}
        {iconFor === t.id && (
          <div style={{ marginTop: '6px' }}>
            <TagIconGrid label={`Icon for ${t.label}`} value={t.icon || ''}
              onChange={async (icon) => { if (await patch(t, { icon })) setIconFor(null) }} />
          </div>
        )}
      </div>
      {!t.promoted && renaming?.id !== t.id && (
        <button style={btn()} disabled={!!busy} onClick={() => setIconFor(iconFor === t.id ? null : t.id)}>Icon</button>
      )}
      {renaming?.id !== t.id && (
        <button style={{ ...btn('danger'), opacity: t.deleteReason ? 0.45 : 1, cursor: t.deleteReason ? 'not-allowed' : 'pointer' }}
          disabled={!!busy || !!t.deleteReason} aria-disabled={!!t.deleteReason}
          title={t.deleteReason || undefined} onClick={() => setDeleting(t)}>Delete</button>
      )}
      {t.promoted ? null : isRemoved ? (
        <button style={btn()} disabled={busy === t.id} onClick={() => patch(t, { is_active: true })}>Restore</button>
      ) : renaming?.id === t.id ? (
        <>
          <button style={btn()} disabled={busy === t.id || !renaming.value.trim() || renaming.value.trim() === t.label}
            onClick={async () => { if (await patch(t, { label: renaming.value.trim() })) setRenaming(null) }}>Save</button>
          <button style={btn()} onClick={() => setRenaming(null)}>Cancel</button>
        </>
      ) : (
        <>
          <button style={btn()} disabled={!!busy} onClick={() => { setError(null); setRenaming({ id: t.id, value: t.label }) }}>Rename</button>
          <button style={btn('danger')} disabled={!!busy} onClick={() => setConfirming(t)}>Remove</button>
        </>
      )}
    </div>
  )

  return (
    <div data-testid="own-tags-settings" style={{ padding: '16px' }}>
      <p style={{ fontSize: '12px', fontWeight: 700, color: T.ink.muted, textTransform: 'uppercase', letterSpacing: '0.6px', margin: '0 0 2px' }}>
        {locationName ? `${locationName}'s own tags` : 'Your own tags'}
      </p>
      <p style={{ fontSize: '12px', color: T.ink.quiet, margin: '0 0 12px' }}>
        Tags only your location sees. Add one from any “+ Tag” — if it’s close to a tag that already exists, you’ll be offered that one instead.
      </p>

      {error && (
        <p role="alert" style={{ fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 10px', borderRadius: T.radius.control, margin: '0 0 10px' }}>{error}</p>
      )}

      {confirming && (
        <div role="dialog" aria-label={`Remove ${confirming.label}`} style={{ padding: '12px', margin: '0 0 12px', borderRadius: T.radius.inset, border: T.border.thin, background: T.surface.sunken }}>
          <p style={{ fontSize: '13px', color: T.ink.primary, margin: '0 0 8px' }}>
            {confirming.people > 0
              ? `${people(confirming.people)} carry “${confirming.label}”. It'll disappear from their records, the tag pickers and the filters.`
              : `Nobody carries “${confirming.label}”. It'll disappear from the tag pickers.`}
            {' '}You can restore it here any time, exactly as it was.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={btn('danger')} disabled={busy === confirming.id}
              onClick={async () => { if (await patch(confirming, { is_active: false })) setConfirming(null) }}>Remove</button>
            <button style={btn()} onClick={() => setConfirming(null)}>Keep it</button>
          </div>
        </div>
      )}

      {deleting && (
        <div role="dialog" aria-label={`Delete ${deleting.label}`} style={{ padding: '12px', margin: '0 0 12px', borderRadius: T.radius.inset, border: `1px solid ${T.state.danger.fg}`, background: T.state.danger.soft }}>
          <p style={{ fontSize: '13px', color: T.ink.primary, margin: '0 0 8px' }}>
            Delete “{deleting.label}” permanently? Nobody carries it. <strong>This can’t be undone</strong> — to hide a tag you might want back, use Remove instead.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={btn('danger')} disabled={busy === deleting.id} onClick={() => hardDelete(deleting)}>Delete permanently</button>
            <button style={btn()} onClick={() => setDeleting(null)}>Keep it</button>
          </div>
        </div>
      )}

      {tags == null && <p style={{ fontSize: '12px', color: T.ink.quiet }}>Loading…</p>}
      {tags != null && active.length === 0 && removed.length === 0 && (
        <p style={{ fontSize: '12px', color: T.ink.quiet }}>Your location hasn’t made any tags of its own yet.</p>
      )}
      {active.length > 0 && (
        <div style={{ border: T.border.thin, borderRadius: T.radius.inset, overflow: 'hidden', marginBottom: '12px' }}>
          {active.map(t => row(t, false))}
        </div>
      )}
      {removed.length > 0 && (
        <>
          <p style={{ fontSize: '11px', fontWeight: 600, color: T.ink.muted, textTransform: 'uppercase', letterSpacing: '0.5px', margin: '8px 0 4px' }}>Removed</p>
          <div style={{ border: T.border.thin, borderRadius: T.radius.inset, overflow: 'hidden' }}>
            {removed.map(t => row(t, true))}
          </div>
        </>
      )}
    </div>
  )
}
