// components/hive/ReferrerPicker.jsx
// ─────────────────────────────────────────────────────────────
// Beta referrer picker — the referral-source lookup for NewClientSheet,
// mirroring Classic's PersonPanel picker (commit 50eb0d6) rebuilt as a
// beta-chunk module (§8.5: no imports from BeeHub, no PartnersContext —
// partners come from a direct /api/partners fetch).
//
// Three searched sections over THREE storage kinds (Network Phase 2 —
// the partner/contact type split is GONE from every UI):
//   NETWORK   — ALL /api/partners rows, one merged pool. Selecting
//               writes referred_by_kind='partner' regardless of the
//               row's legacy `type` value.
//   COMPANIES — /api/companies rows, same location scope. A company is
//               a first-class referral source (referred_by_kind=
//               'company' — the kind the validation, both read routes,
//               and /api/companies/[id]/referrals' DIRECT bucket were
//               already built for; this section is the first UI that
//               can produce the row). Kept as its own section rather
//               than mixed into Network: person rows carry title ·
//               company subs, and an org masquerading as a person row
//               would read as a duplicate of its own people.
//   CLIENTS   — the already-loaded people prop (location-scoped
//               upstream, junk excluded here). MATCH-ONLY: creating a
//               lead just to name a referrer would mint an
//               engagement-less person. Selecting writes
//               referred_by_kind='lead'.
//
// MATCH-OR-CREATE for network rows only: once the user has typed, ONE
// inline create row POSTs /api/partners (type='partner', stage='New
// Contact' so the row is born inside the pipeline — a NULL stage
// matches no stage filter and hides from every saved view) and
// auto-selects the created row (kind='partner') — details fill in later
// via the Network tab. Companies and clients are match-only doors.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { T } from './shared/tokens'

const ACCENT = T.accent.fg

const sectionLbl = {
  fontSize: '10px', fontWeight: 600, color: T.ink.quiet, letterSpacing: '0.6px',
  textTransform: 'uppercase', padding: '8px 10px 3px',
}
const rowBtn = (selected) => ({
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1px',
  width: '100%', padding: '7px 10px', border: 'none', borderRadius: T.radius.control,
  background: selected ? T.accent.soft : 'transparent',
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
  readOnly = false,
}) {
  const [search, setSearch] = useState('')
  const [partnerRows, setPartnerRows] = useState(null) // null = loading
  const [companyRows, setCompanyRows] = useState(null) // null = loading
  const [loadErr, setLoadErr] = useState(null)
  const [creating, setCreating] = useState(null) // 'partner' | 'contact' while a create POST runs
  const [createErr, setCreateErr] = useState(null)

  // Partners + companies fetch — once per mount, same location scope. A
  // failed fetch degrades to what did load (with an inline note for the
  // partner half) rather than blocking; a failed companies fetch just
  // drops that section.
  useEffect(() => {
    let dead = false
    if (!locationUuid) { setPartnerRows([]); setCompanyRows([]); setLoadErr('No location context'); return }
    fetch(`/api/partners?location_id=${encodeURIComponent(locationUuid)}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(rows => { if (!dead) setPartnerRows(Array.isArray(rows) ? rows : []) })
      .catch(e => { if (!dead) { setPartnerRows([]); setLoadErr(String(e?.message || e)) } })
    fetch(`/api/companies?location_id=${encodeURIComponent(locationUuid)}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(rows => { if (!dead) setCompanyRows(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (!dead) setCompanyRows([]) })
    return () => { dead = true }
  }, [locationUuid])

  const q = search.trim().toLowerCase()
  const nameMatch = (v) => !q || (v || '').toLowerCase().includes(q)

  const sections = useMemo(() => {
    const rows = partnerRows || []
    const companies = companyRows || []
    return [
      // kind drives referred_by_kind on select — 'partner' for the merged
      // network pool (partner + legacy contact rows alike), 'company' for
      // orgs, 'lead' for clients. The type split died with the Network
      // rename; companies are the third first-class referral source.
      {
        key: 'network', label: 'Network', kind: 'partner',
        items: rows.filter(p => !p.isDeleted && (nameMatch(p.name) || nameMatch(p.company)))
          .map(p => ({ id: p.id, name: p.name, sub: [p.title, p.company].filter(Boolean).join(' · ') })),
      },
      {
        key: 'companies', label: 'Companies', kind: 'company',
        items: companies.filter(c => !c.isDeleted && (nameMatch(c.name) || nameMatch(c.industry)))
          .map(c => ({ id: c.id, name: c.name, sub: c.industry || '' })),
      },
      {
        key: 'clients', label: 'Clients', kind: 'lead',
        items: (people || []).filter(p => p?.isJunk !== true && (nameMatch(p.name) || nameMatch(p.email)))
          .map(p => ({ id: p.id, name: p.name, sub: p.email || '' })),
      },
    ]
  }, [partnerRows, companyRows, people, q]) // eslint-disable-line react-hooks/exhaustive-deps

  const hasAnyMatch = sections.some(s => s.items.length > 0)

  // Inline match-or-create — partner/contact ONLY (clients are match-only).
  async function createReferrer(type) {
    const name = search.trim()
    if (!name || creating) return
    setCreating(type)
    setCreateErr(null)
    try {
      // stage seed: a picker-born partner must land INSIDE the pipeline.
      // Without it the row has a NULL stage — which matches no stage
      // filter (PARTNER_STAGE_KEYS has no blank option), so it hides
      // from every stage-filtered and saved Network view until someone
      // hand-edits it. Same seed AddPartnerModal/NetworkAddSheet use.
      const res = await fetch('/api/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, location_id: locationUuid, stage: 'New Contact' }),
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
      marginTop: '6px', border: T.border.strong, borderRadius: T.radius.control,
      background: T.surface.raised, display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ padding: '8px 8px 4px', flexShrink: 0 }}>
        <input
          autoFocus
          value={search}
          onChange={e => { setSearch(e.target.value); setCreateErr(null) }}
          placeholder="Search network, companies, clients…"
          aria-label="Search referrers"
          style={{
            width: '100%', padding: '7px 10px', border: T.border.strong,
            borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit', color: T.ink.primary,
            outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>
      <div style={{ maxHeight: '240px', overflowY: 'auto', padding: '0 8px 8px' }}>
        {partnerRows === null && <p style={{ fontSize: '12px', color: T.ink.quiet, padding: '8px 10px' }}>Loading partners…</p>}
        {loadErr && <p style={{ fontSize: '11px', color: T.ink.muted, padding: '4px 10px' }}>Partners unavailable ({loadErr}) — clients still searchable.</p>}
        {sections.map(s => s.items.length > 0 && (
          <React.Fragment key={s.key}>
            <p style={sectionLbl}>{s.label}</p>
            {s.items.map(it => (
              <button key={it.id} type="button" onClick={() => onSelect({ id: it.id, kind: s.kind, name: it.name })} style={rowBtn(selectedId === it.id)}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary }}>{it.name}</span>
                {it.sub && <span style={{ fontSize: '11px', color: T.ink.muted }}>{it.sub}</span>}
              </button>
            ))}
          </React.Fragment>
        ))}
        {!hasAnyMatch && !q && partnerRows !== null && (
          <p style={{ fontSize: '12px', color: T.ink.muted, textAlign: 'center', padding: '8px' }}>No matches</p>
        )}
        {/* Create row — shown once the user has typed. ONE door post-merge
            (network row, type='partner'); the Clients section is
            deliberately match-only. Hidden in read-only. */}
        {q && !readOnly && (
          <button type="button" disabled={!!creating} onClick={() => createReferrer('partner')}
            style={{ ...rowBtn(false), background: T.accent.faint, marginTop: '4px', opacity: creating ? 0.6 : 1 }}>
            <span style={{ fontSize: '13px', fontWeight: 500, color: ACCENT }}>
              {creating ? 'Creating…' : `＋ Add “${search.trim()}” to your network`}
            </span>
          </button>
        )}
        {createErr && (
          <p style={{ fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 12px', borderRadius: T.radius.control, margin: '6px 2px 2px' }}>
            Create failed: {createErr}
          </p>
        )}
      </div>
    </div>
  )
}
