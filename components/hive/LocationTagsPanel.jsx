// components/hive/LocationTagsPanel.jsx
// ─────────────────────────────────────────────────────────────
// Configure › Location tags (corporate, 2026-10-16) — every tag a location
// made for itself, across all locations, grouped by the near-match key so
// the same idea made in several places reads as one row ("Organizer · 6
// locations · 41 people"). Most widespread first: those are the tags worth
// making corporate. Read-only — "Make corporate" is a later step with its
// own dry run. §8.5: owns its fetch.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T } from './shared/tokens'
import { tagText } from './shared/tagText'

const fmtDate = (iso) => {
  const d = new Date(iso || '')
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
}

export default function LocationTagsPanel() {
  const [groups, setGroups] = useState(null)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState({})

  useEffect(() => {
    let dead = false
    fetch('/api/tags/locations')
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`); return j })
      .then(j => { if (!dead) setGroups(j.groups || []) })
      .catch(e => { if (!dead) { setError(String(e?.message || e)); setGroups([]) } })
    return () => { dead = true }
  }, [])

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
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
