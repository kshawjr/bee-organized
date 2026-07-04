// components/hive/ReferrerPicker.jsx
// ─────────────────────────────────────────────────────────────
// Beta referrer picker — the referral-source lookup for NewClientSheet,
// mirroring Classic's PersonPanel picker (commit 50eb0d6) rebuilt as a
// beta-chunk module (§8.5: no imports from BeeHub, no PartnersContext —
// partners come from a direct /api/partners fetch).
//
// Three searched sections over TWO storage kinds:
//   CLIENTS  — the already-loaded people prop (location-scoped upstream,
//              junk excluded here). MATCH-ONLY: creating a lead just to
//              name a referrer would mint an engagement-less person —
//              Classic disallows it too. Selecting writes
//              referred_by_kind='lead'.
//   PARTNERS — /api/partners rows where type !== 'contact'.
//   CONTACTS — /api/partners rows where type === 'contact'. Partners and
//              contacts share the partners table (split on `type`) and
//              BOTH store as referred_by_kind='partner' — the kind enum
//              has exactly two values ('lead','partner'), never a third.
//
// MATCH-OR-CREATE for partner/contact only: once the user has typed,
// inline create rows POST /api/partners with the typed name + type and
// auto-select the created row (kind='partner') — Classic's AddPartner
// quick-add, beta-native (the row's details fill in later via the
// classic Contacts tab).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useState } from 'react'

const ACCENT = '#0F6E56'

const sectionLbl = {
  fontSize: '10px', fontWeight: 600, color: '#b5b3ac', letterSpacing: '0.6px',
  textTransform: 'uppercase', padding: '8px 10px 3px',
}
const rowBtn = (selected) => ({
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1px',
  width: '100%', padding: '7px 10px', border: 'none', borderRadius: '6px',
  background: selected ? 'rgba(15,110,86,0.08)' : 'transparent',
  cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
})

export default function ReferrerPicker({
  people = [],
  locationUuid = null,
  selectedId = null,
  onSelect = () => {},
  // Partner-create seam (§8.5): this picker can't call PartnersContext,
  // so after a CONFIRMED POST /api/partners it hands the returned row up
  // this callback chain (surface → HiveShell → BeeHub merges into the
  // partners state Classic's PartnersScreen reads). Mirrors onPersonCreated.
  onPartnerCreated = () => {},
  setToast = () => {},
}) {
  const [search, setSearch] = useState('')
  const [partnerRows, setPartnerRows] = useState(null) // null = loading
  const [loadErr, setLoadErr] = useState(null)
  const [creating, setCreating] = useState(null) // 'partner' | 'contact' while a create POST runs
  const [createErr, setCreateErr] = useState(null)

  // Partners + contacts fetch — once per mount. A failed fetch degrades
  // to a clients-only picker (with an inline note) rather than blocking.
  useEffect(() => {
    let dead = false
    if (!locationUuid) { setPartnerRows([]); setLoadErr('No location context'); return }
    fetch(`/api/partners?location_id=${encodeURIComponent(locationUuid)}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(rows => { if (!dead) setPartnerRows(Array.isArray(rows) ? rows : []) })
      .catch(e => { if (!dead) { setPartnerRows([]); setLoadErr(String(e?.message || e)) } })
    return () => { dead = true }
  }, [locationUuid])

  const q = search.trim().toLowerCase()
  const nameMatch = (v) => !q || (v || '').toLowerCase().includes(q)

  const sections = useMemo(() => {
    const rows = partnerRows || []
    return [
      // kind drives referred_by_kind on select — 'partner' for both
      // partners-table sections, 'lead' for clients (Classic's split).
      {
        key: 'partners', label: 'Partners', kind: 'partner',
        items: rows.filter(p => !p.isDeleted && p.type !== 'contact' && (nameMatch(p.name) || nameMatch(p.company)))
          .map(p => ({ id: p.id, name: p.name, sub: [p.title, p.company].filter(Boolean).join(' · ') })),
      },
      {
        key: 'contacts', label: 'Contacts', kind: 'partner',
        items: rows.filter(p => !p.isDeleted && p.type === 'contact' && (nameMatch(p.name) || nameMatch(p.company)))
          .map(p => ({ id: p.id, name: p.name, sub: [p.title, p.company].filter(Boolean).join(' · ') })),
      },
      {
        key: 'clients', label: 'Clients', kind: 'lead',
        items: (people || []).filter(p => p?.isJunk !== true && (nameMatch(p.name) || nameMatch(p.email)))
          .map(p => ({ id: p.id, name: p.name, sub: p.email || '' })),
      },
    ]
  }, [partnerRows, people, q]) // eslint-disable-line react-hooks/exhaustive-deps

  const hasAnyMatch = sections.some(s => s.items.length > 0)

  // Inline match-or-create — partner/contact ONLY (clients are match-only).
  async function createReferrer(type) {
    const name = search.trim()
    if (!name || creating) return
    setCreating(type)
    setCreateErr(null)
    try {
      const res = await fetch('/api/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, location_id: locationUuid }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.id) throw new Error(json?.error || `HTTP ${res.status}`)
      // Confirmed row (real id/type/location, never a stub) → the Classic
      // seam, so the new partner/contact shows in PartnersScreen too.
      onPartnerCreated(json)
      // Both types store as kind='partner' — the split lives in partners.type.
      onSelect({ id: json.id, kind: 'partner', name: json.name })
    } catch (e) {
      const msg = String(e?.message || e)
      setCreateErr(msg)
      // Also toast — the inline line alone was easy to miss, making a
      // failed create look like it silently did nothing.
      setToast({ kind: 'error', msg: `Couldn't create ${type}: ${msg}` })
    } finally {
      setCreating(null)
    }
  }

  return (
    <div style={{
      marginTop: '6px', border: '0.5px solid rgba(0,0,0,0.25)', borderRadius: '8px',
      background: '#fff', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ padding: '8px 8px 4px', flexShrink: 0 }}>
        <input
          autoFocus
          value={search}
          onChange={e => { setSearch(e.target.value); setCreateErr(null) }}
          placeholder="Search partners, contacts, clients…"
          aria-label="Search referrers"
          style={{
            width: '100%', padding: '7px 10px', border: '0.5px solid rgba(0,0,0,0.2)',
            borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit', color: '#1a1a18',
            outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>
      <div style={{ maxHeight: '240px', overflowY: 'auto', padding: '0 8px 8px' }}>
        {partnerRows === null && <p style={{ fontSize: '12px', color: '#b5b3ac', padding: '8px 10px' }}>Loading partners…</p>}
        {loadErr && <p style={{ fontSize: '11px', color: '#8a8a84', padding: '4px 10px' }}>Partners unavailable ({loadErr}) — clients still searchable.</p>}
        {sections.map(s => s.items.length > 0 && (
          <React.Fragment key={s.key}>
            <p style={sectionLbl}>{s.label}</p>
            {s.items.map(it => (
              <button key={it.id} type="button" onClick={() => onSelect({ id: it.id, kind: s.kind, name: it.name })} style={rowBtn(selectedId === it.id)}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a18' }}>{it.name}</span>
                {it.sub && <span style={{ fontSize: '11px', color: '#8a8a84' }}>{it.sub}</span>}
              </button>
            ))}
          </React.Fragment>
        ))}
        {!hasAnyMatch && !q && partnerRows !== null && (
          <p style={{ fontSize: '12px', color: '#8a8a84', textAlign: 'center', padding: '8px' }}>No matches</p>
        )}
        {/* Create rows — shown once the user has typed. Partner/contact
            only; the Clients section is deliberately match-only. */}
        {q && (
          <>
            {['partner', 'contact'].map(t => (
              <button key={t} type="button" disabled={!!creating} onClick={() => createReferrer(t)}
                style={{ ...rowBtn(false), background: 'rgba(15,110,86,0.05)', marginTop: '4px', opacity: creating ? 0.6 : 1 }}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: ACCENT }}>
                  {creating === t ? 'Creating…' : `＋ Create “${search.trim()}” as ${t}`}
                </span>
              </button>
            ))}
          </>
        )}
        {createErr && (
          <p style={{ fontSize: '12px', color: '#791F1F', background: '#FCEBEB', padding: '8px 12px', borderRadius: '8px', margin: '6px 2px 2px' }}>
            Create failed: {createErr}
          </p>
        )}
      </div>
    </div>
  )
}
