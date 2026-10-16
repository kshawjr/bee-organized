// components/hive/LocationTagsPanel.jsx
// ─────────────────────────────────────────────────────────────
// Configure › Location tags (corporate, 2026-10-16) — every tag a location
// made for itself, across all locations, grouped by the near-match key so
// the same idea made in several places reads as one row ("Organizer · 6
// locations · 41 people"). Most widespread first: those are the tags worth
// making corporate. Read-only — "Make corporate" is a later step with its
// own dry run (2026-10-16): each group's "Make corporate…" previews
// first (POST /api/tags/make-corporate dryRun), runs only on the second
// press, and every promotion stays undoable from "Recent" below.
// §8.5: owns its fetches.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T } from './shared/tokens'
import { tagText } from './shared/tagText'

const fmtDate = (iso) => {
  const d = new Date(iso || '')
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
}

const inputStyle = { padding: '6px 10px', borderRadius: T.radius.control, border: T.border.control, fontSize: 12, fontFamily: 'inherit', color: T.ink.primary, outline: 'none', background: T.surface.raised }
const actBtn = (primary = false) => ({
  padding: '6px 12px', borderRadius: T.radius.control, border: primary ? 'none' : T.border.thin,
  background: primary ? T.accent.fg : T.surface.raised, color: primary ? T.accent.onFill : T.ink.secondary,
  fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
})
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`

// One group's "Make corporate": form → preview (dry run) → run → undo.
function MakeCorporate({ group, onDone }) {
  const [label, setLabel] = useState(group.tags[0].label.trim())
  const [icon, setIcon] = useState(group.tags.find(t => t.icon)?.icon || '')
  const [section, setSection] = useState('trade')
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [done, setDone] = useState(null)
  const call = async (dryRun) => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/tags/make-corporate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Only the copies still in use: a copy the location removed stays
        // removed — promoting it would resurface its hidden links.
        body: JSON.stringify({ tagIds: group.tags.filter(t => t.is_active).map(t => t.id), label, icon, section, dryRun }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.detail || j?.error || `HTTP ${r.status}`)
      if (dryRun) setPlan(j.plan); else { setDone(j); onDone() }
    } catch (e) { setErr(String(e?.message || e)) } finally { setBusy(false) }
  }
  if (done) {
    return <p data-promotion-done style={{ fontSize: 12, color: T.ink.secondary, margin: '6px 0' }}>Done — “{label}” is corporate. Undo it from Recent below if you need to.</p>
  }
  return (
    <div data-make-corporate style={{ marginTop: 8, padding: 10, borderRadius: T.radius.inset, background: T.surface.sunken, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input aria-label="Corporate tag name" value={label} onChange={e => { setLabel(e.target.value); setPlan(null) }} style={{ ...inputStyle, flex: 1, minWidth: 140 }} />
        <input aria-label="Icon" value={icon} onChange={e => { setIcon(e.target.value); setPlan(null) }} placeholder="🏷️" maxLength={4} style={{ ...inputStyle, width: 56, textAlign: 'center' }} />
        <select aria-label="Section" value={section} onChange={e => { setSection(e.target.value); setPlan(null) }} style={inputStyle}>
          <option value="relationship">Relationship</option>
          <option value="trade">Trade</option>
        </select>
      </div>
      {!plan && <div><button style={actBtn()} disabled={busy || !label.trim()} onClick={() => call(true)}>{busy ? 'Checking…' : 'Preview'}</button></div>}
      {plan && (
        <div data-plan style={{ fontSize: 12, color: T.ink.secondary, lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>
            {plan.target.kind === 'new'
              ? `Creates corporate “${plan.target.label}”${plan.target.icon ? ' ' + plan.target.icon : ''} in ${plan.target.section === 'relationship' ? 'Relationship' : 'Trade'}.`
              : `Uses the existing corporate “${plan.target.label}”${plan.target.wasActive ? '' : ' (switched back on)'} — the name and section you typed are not used.`}
          </p>
          <p style={{ margin: 0 }}>Adds it to {n(plan.clients.linksAdded, 'client', 'clients')} and {n(plan.network.linksAdded, 'Network person', 'Network people')}{plan.clients.alreadyOnTarget + plan.network.alreadyOnTarget ? ` (${plan.clients.alreadyOnTarget + plan.network.alreadyOnTarget} already have it)` : ''}.</p>
          <p style={{ margin: 0 }}>Switches off {plan.copies.map(c => `“${c.label}” at ${c.location || '?'}`).join(', ')} — their links are kept, so Undo puts everything back.</p>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button style={actBtn(true)} disabled={busy} onClick={() => call(false)}>{busy ? 'Working…' : 'Make corporate'}</button>
            <button style={actBtn()} disabled={busy} onClick={() => setPlan(null)}>Back</button>
          </div>
        </div>
      )}
      {err && <p role="alert" style={{ fontSize: 12, color: T.state.danger.fg, margin: 0 }}>{err}</p>}
    </div>
  )
}

function RecentPromotions({ refreshKey, onChanged }) {
  const [list, setList] = useState(null)
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    let dead = false
    fetch('/api/tags/make-corporate').then(r => r.json()).then(j => { if (!dead) setList(j.promotions || []) }).catch(() => { if (!dead) setList([]) })
    return () => { dead = true }
  }, [refreshKey])
  if (!list || list.length === 0) return null
  const undo = async (p) => {
    setMsg(null)
    const r = await fetch('/api/tags/make-corporate/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ promotionId: p.id }) })
    const j = await r.json().catch(() => ({}))
    setMsg(r.ok ? j.receipt : `Undo failed: ${j?.detail || j?.error || r.status}`)
    onChanged()
  }
  return (
    <div data-recent-promotions style={{ marginTop: 10 }}>
      <p style={{ fontSize: 10, fontWeight: 700, color: T.ink.muted, textTransform: 'uppercase', letterSpacing: '0.6px', margin: '0 0 4px' }}>Recently made corporate</p>
      {list.map(p => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.ink.secondary, padding: '4px 0' }}>
          <span style={{ flex: 1 }}>{p.tag ? tagText(p.tag) : 'Tag'} · {fmtDate(p.created_at)}{p.undone_at ? ` · undone ${fmtDate(p.undone_at)}` : ''}</span>
          {!p.undone_at && <button style={actBtn()} onClick={() => undo(p)}>Undo</button>}
        </div>
      ))}
      {msg && <p style={{ fontSize: 12, color: T.ink.muted, margin: '4px 0 0' }}>{msg}</p>}
    </div>
  )
}

export default function LocationTagsPanel() {
  const [groups, setGroups] = useState(null)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState({})
  const [making, setMaking] = useState(null)   // group key
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let dead = false
    fetch('/api/tags/locations')
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`); return j })
      .then(j => { if (!dead) setGroups(j.groups || []) })
      .catch(e => { if (!dead) { setError(String(e?.message || e)); setGroups([]) } })
    return () => { dead = true }
  }, [refreshKey])

  return (
    <div data-testid="location-tags-panel" style={{ marginBottom: 20 }}>
      <p style={{ fontSize: 10, fontWeight: 700, color: T.ink.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 4 }}>Location tags</p>
      <p style={{ fontSize: 12, color: T.ink.quiet, margin: '0 0 8px' }}>
        Tags locations made for themselves. The same name made in several places shows as one row — the most widespread are the ones worth making corporate.
      </p>
      {error && <p role="alert" style={{ fontSize: 12, color: T.state.danger.fg }}>Couldn’t load location tags: {error}</p>}
      {groups == null && <p style={{ fontSize: 12, color: T.ink.quiet }}>Loading…</p>}
      {groups != null && groups.length === 0 && !error && (
        <p style={{ fontSize: 12, color: T.ink.quiet }}>No location has made its own tag yet.</p>
      )}
      {groups != null && groups.length > 0 && (
        <div style={{ background: T.surface.raised, borderRadius: T.radius.card, border: T.border.card, overflow: 'hidden' }}>
          {groups.map(g => (
            <div key={g.key} data-tag-group={g.key} style={{ borderBottom: T.border.thin }}>
              <button onClick={() => setOpen(o => ({ ...o, [g.key]: !o[g.key] }))} aria-expanded={!!open[g.key]}
                style={{ width: '100%', padding: '11px 16px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: T.ink.primary }}>{tagText(g.tags[0])}</span>
                <span style={{ fontSize: 12, color: T.ink.muted, whiteSpace: 'nowrap' }}>
                  {g.locations} {g.locations === 1 ? 'location' : 'locations'} · {g.people} {g.people === 1 ? 'person' : 'people'}
                </span>
              </button>
              {open[g.key] && (
                <div style={{ padding: '0 16px 10px' }}>
                  {g.tags.map(t => (
                    <p key={t.id} style={{ fontSize: 12, color: T.ink.secondary, margin: '4px 0' }}>
                      “{t.label}” · {t.location_name || 'unknown location'} · {t.people} {t.people === 1 ? 'person' : 'people'}
                      {' · '}made {fmtDate(t.created_at)}{t.created_by ? ` by ${t.created_by}` : ''}
                      {t.is_active ? '' : ' · removed'}
                    </p>
                  ))}
                  {making === g.key
                    ? <MakeCorporate group={g} onDone={() => setRefreshKey(k => k + 1)} />
                    : g.tags.some(t => t.is_active) && (
                      <button style={{ ...actBtn(), marginTop: 6 }} onClick={() => setMaking(g.key)}>Make corporate…</button>
                    )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <RecentPromotions refreshKey={refreshKey} onChanged={() => setRefreshKey(k => k + 1)} />
    </div>
  )
}
