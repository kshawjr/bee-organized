// components/hive/NewClientSheet.jsx
// ─────────────────────────────────────────────────────────────
// The beta manual add-client flow — a re-skin of the classic
// NewLeadModal flow (BeeHub.jsx), rebuilt as a beta-chunk module (§8.5:
// no imports from BeeHub). Renders through OverlayShell so it inherits
// the dvh sheet geometry, scroll reset, body lock, and header X.
//
// DOCTRINE (updated 2026-07-04 — founding decoupled from Send): "New"
// creates a PERSON for a genuinely new inquiry (frame C), and the lookup
// is a HARD gate — frame A always comes before any create (the
// anti-dupe). For a RETURNING client (frames B/D) the primary action is
// a REAL local founding: POST /api/engagements founds a new engagement
// UNDER THE EXISTING LEAD (founded_by='manual', lib/engagements.ts).
// Send to Jobber is the optional NEXT step (frame F) — push now, or keep
// the engagement local (cash/off-Jobber work) and send later from the
// engagement. The old returning-client path — minting a duplicate leads
// row via POST /api/leads and letting the webhook found asynchronously —
// is RETIRED: it stranded duplicates in the Inbox and 400'd at send on
// leads_jobber_client_id_location_idx (which stays — it's the guardrail;
// founding from the existing lead routes around it).
//
// Frames (routed by the lookup, all downstream of the search field):
//   A — search input. Matches as you type against the loaded people
//       prop (see shared/clientMatch.js for the phone-storage story).
//   B — match found: returning client, matched-on line, open-engagement
//       count + last contact, start-new / open-profile actions.
//   C — no match: create the PERSON with founding-viable fields only.
//       The authoritative DB match query re-runs right before the insert.
//       Source='Referral' opens ReferrerPicker (match-or-create) and the
//       link rides the POST as referred_by_kind/referred_by_id.
//   D — matched client has 1+ OPEN engagement: concurrent-engagement
//       confirm — now gating a REAL second founding (rule 1: a distinct
//       concurrent row, both stay active), not a cosmetic duplicate.
//   F — founded: confirmed from the real returned engagement row; offers
//       Send to Jobber (push) or Keep local for now (send available
//       later). The person derives Active (open engagement) and the
//       engagement shows on the Board in Request — the founded-not-sent
//       signal; no new status exists for it.
//
// The merge seams: frame C hands the REAL returned lead row up through
// onCreated (never an optimistic stub — phantom Inbox rows); frames B/D
// hand the REAL returned engagement row up through onFounded so the
// board shows it without a reload. This module never reaches into
// BeeHub (§8.5).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useMemo, useState } from 'react'
import OverlayShell from './OverlayShell'
import ReferrerPicker from './ReferrerPicker'
import useIsMobile from './shared/useIsMobile'
import { isTerminal } from './shared/stageConfig'
import { lastActivityTs } from './shared/engagementStatus'
import { matchPeople, normalizeEmail, normalizePhone, queryLeadMatches, maskEmail, maskPhone } from './shared/clientMatch'
import { createClient } from '@/lib/supabase'
import { IconSearch, IconPlus, IconUserCheck, IconSparkles, IconAlertTriangle, IconCheck, IconSend } from '@/components/ui/icons'

const ACCENT = '#0F6E56' // the beta action green (SEND_GREEN family)
const AMBER = { bg: '#FAEEDA', text: '#633806' } // warning tint (design language)
const GREEN = { bg: '#EAF3DE', text: '#27500A' } // success tint

const fmtDate = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

const inp = {
  width: '100%', padding: '9px 11px', border: '0.5px solid rgba(0,0,0,0.25)',
  borderRadius: '8px', fontSize: '16px', fontFamily: 'inherit', color: '#1a1a18',
  background: '#fff', outline: 'none', boxSizing: 'border-box',
}
const lbl = {
  fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px',
  textTransform: 'uppercase', marginBottom: '4px', display: 'block',
}
const primaryBtn = {
  width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  padding: '10px 14px', borderRadius: '8px', border: 'none',
  background: ACCENT, color: '#fff', fontSize: '13px', fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}
const secondaryBtn = {
  width: '100%', padding: '10px 14px', borderRadius: '8px',
  border: '0.5px solid rgba(0,0,0,0.25)', background: 'transparent',
  fontSize: '13px', fontWeight: 500, color: '#1a1a18',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}

function Badge({ tint, icon, label }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '3px 10px', borderRadius: '10px',
      background: tint.bg, color: tint.text,
      fontSize: '12px', fontWeight: 500, lineHeight: 1.5, whiteSpace: 'nowrap',
    }}>
      {icon}
      {label}
    </span>
  )
}

function Toggle({ on, onFlip, label }) {
  return (
    <button
      role="switch" aria-checked={on} onClick={onFlip}
      style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}
    >
      <span style={{
        width: '34px', height: '20px', borderRadius: '10px', flexShrink: 0,
        background: on ? ACCENT : 'rgba(0,0,0,0.15)', position: 'relative',
        transition: 'background 0.15s',
      }}>
        <span style={{
          position: 'absolute', top: '2px', left: on ? '16px' : '2px',
          width: '16px', height: '16px', borderRadius: '50%', background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)', transition: 'left 0.15s',
        }} />
      </span>
      <span style={{ fontSize: '13px', color: '#1a1a18' }}>{label}</span>
    </button>
  )
}

export default function NewClientSheet({
  people = [],
  engagements = [],
  locFilter = 'all',
  currentLocationUuid = null,
  currentUserId = null,
  lookupOptions = { sources: [], projectTypes: [] },
  onClose = () => {},
  onCreated = () => {},
  onFounded = () => {},
  onOpenClient = () => {},
  onOpenEngagement = () => {},
  onSendToJobber = null,
  setToast = () => {},
}) {
  const isMobile = useIsMobile()
  const [query, setQuery] = useState('')
  // null = derive from the query; a string = the user took the field over.
  const [form, setForm] = useState({ name: null, email: null, phone: null, source: 'Manual', projectType: 'Client', drip: true })
  // Referral-source referrer link (frame C) — { id, kind, name } | null.
  // kind is 'lead' or 'partner' (contacts store as 'partner' too); maps
  // straight onto leads.referred_by_kind / referred_by_id at POST.
  const [referrer, setReferrer] = useState(null)
  const [pickReferrer, setPickReferrer] = useState(false)
  const [pickedId, setPickedId] = useState(null) // multi-match: which B row is active
  const [confirming, setConfirming] = useState(false) // frame D
  const [founded, setFounded] = useState(null) // frame F: { engagement, person }
  const [dbMatch, setDbMatch] = useState(null) // pre-insert gate hit not in the loaded set
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Match universe = the location-scoped slice of the loaded people prop.
  const scopedPeople = useMemo(() => (
    locFilter === 'all' ? people : people.filter(p => p.locationId === locFilter)
  ), [people, locFilter])

  const matches = useMemo(() => matchPeople(scopedPeople, query), [scopedPeople, query])
  const match = (pickedId && matches.find(m => m.person.id === pickedId)) || matches[0] || null

  // A query is "committed" once it could plausibly identify someone —
  // that is when a no-match result may open the create form (frame C).
  const q = query.trim()
  const qDigits = q.replace(/\D/g, '')
  const searched = q.includes('@') ? q.length >= 3 : (qDigits.length >= 7 || q.length >= 2)

  const frame = founded ? 'F' : confirming ? 'D' : match ? 'B' : (searched && !dbMatch) ? 'C' : 'A'

  // Frame B/D derived facts — session rowPatches already applied upstream.
  const openEngs = useMemo(() => {
    if (!match) return []
    return engagements
      .filter(e => e.client_id === match.person.id && !isTerminal(e.stage))
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  }, [engagements, match])

  const lastContact = useMemo(() => {
    if (!match) return null
    const p = match.person
    const t = Math.max(
      0,
      ...(p.outreachTimeline || []).map(x => new Date(x.occurred_at || 0).getTime() || 0),
      ...openEngs.map(e => lastActivityTs(e)),
      p.created ? new Date(p.created).getTime() || 0 : 0,
    )
    return t > 0 ? fmtDate(t) : null
  }, [match, openEngs])

  // Frame C prefill from the query (user edits win).
  const prefill = useMemo(() => {
    if (q.includes('@')) return { name: '', email: q.toLowerCase(), phone: '' }
    if (qDigits.length >= 7) return { name: '', email: '', phone: q }
    return { name: q, email: '', phone: '' }
  }, [q, qDigits])
  const effName = form.name ?? prefill.name
  const effEmail = form.email ?? prefill.email
  const effPhone = form.phone ?? prefill.phone

  const locationUuid = locFilter !== 'all' ? locFilter : currentLocationUuid
  const withDefault = (opts, v) => (v && !opts.includes(v) ? [v, ...opts] : opts)

  async function postLead(body) {
    const res = await fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_uuid: locationUuid,
        assigned_to: currentUserId || null,
        stage: 'New',
        ...body,
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json?.lead) throw new Error(json?.error || `HTTP ${res.status}`)
    return json.lead
  }

  // Frame C create — person only. The authoritative DB match query runs
  // here, right before the insert (the loaded-people pass can't see rows
  // created since page load). A failed re-check degrades to the
  // people-prop gate rather than blocking the create.
  async function createPerson() {
    if (busy) return
    setErrorMsg(null)
    const name = (effName || '').trim()
    if (!name) { setErrorMsg('Name is required.'); return }
    if (!locationUuid) { setErrorMsg('No location context — refresh and try again.'); return }
    setBusy(true)
    try {
      const keys = { email: normalizeEmail(effEmail), phone: normalizePhone(effPhone) }
      if (keys.email || keys.phone) {
        try {
          // Scoped to the location the create targets — the dupe gate is
          // per-location (one leads row per person per location).
          const rows = await queryLeadMatches(createClient(), { ...keys, locationUuid })
          if (rows.length > 0) {
            const row = rows[0]
            const known = scopedPeople.find(p => p.id === row.id)
            if (known) {
              setPickedId(known.id)
              setQuery(keys.email || keys.phone)
            } else {
              setDbMatch({
                person: { id: row.id, name: row.name, email: row.email, phone: row.phone, created: row.created_at, outreachTimeline: [] },
                matchedOn: keys.email && normalizeEmail(row.email) === keys.email ? 'email' : 'phone',
                matchedValue: keys.email && normalizeEmail(row.email) === keys.email ? maskEmail(row.email) : maskPhone(row.phone),
              })
            }
            setToast({ kind: 'error', msg: 'A matching client already exists — showing them instead' })
            return
          }
        } catch (e) {
          // DB gate unavailable (offline / RLS) — the people-prop gate
          // already passed; create proceeds on that.
          console.warn('[new-client] pre-insert match query failed:', e?.message || e)
        }
      }
      const parts = name.split(/\s+/).filter(Boolean)
      const lead = await postLead({
        name,
        first_name: parts[0] || null,
        last_name: parts.slice(1).join(' ') || null,
        email: (effEmail || '').trim() || null,
        phone: (effPhone || '').trim() || null,
        source: form.source || null,
        project_type: form.projectType || null,
        // Referrer link rides only on a Referral source WITH a picked
        // referrer — source='Referral' with none saves nulls (the picker
        // is skippable, matching Classic; never block founding on it).
        referred_by_kind: form.source === 'Referral' && referrer ? referrer.kind : null,
        referred_by_id: form.source === 'Referral' && referrer ? referrer.id : null,
        skip_drip: !form.drip,
      })
      // Frame C stays person-world by design: a genuinely NEW inquiry
      // lands in the Inbox as a person (doctrine above). Manual founding
      // (founded_by='manual', now real) belongs to the returning-client
      // frames B/D — see foundEngagementFor.
      onCreated(lead)
    } catch (e) {
      setErrorMsg(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  // Frame B/D "start engagement" — the REAL founding write, decoupled
  // from Send to Jobber: POST /api/engagements founds a NEW engagement
  // under the EXISTING lead's id (founded_by='manual'). Never POST
  // /api/leads here — the retired duplicate-row path minted a second
  // leads row that 400'd at send on leads_jobber_client_id_location_idx
  // and stranded the duplicate in the Inbox. Each call is a distinct
  // concurrent engagement (rule 1) — frame D's confirm gates creation,
  // it never reuses the open one.
  async function foundEngagementFor(m) {
    if (busy) return
    setErrorMsg(null)
    setBusy(true)
    try {
      const res = await fetch('/api/engagements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: m.person.id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.engagement) throw new Error(json?.error || `HTTP ${res.status}`)
      // Confirmed from the REAL returned row (never an optimistic stub) —
      // hand it up so the board shows it without a reload, then offer the
      // next step (frame F).
      onFounded(json.engagement, m.person)
      setConfirming(false)
      setFounded({ engagement: json.engagement, person: m.person })
      setToast({ kind: 'success', msg: `Engagement started for ${m.person.name || 'client'}` })
    } catch (e) {
      setErrorMsg(String(e?.message || e))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  const startEngagement = (m) => {
    if (openEngs.length > 0) setConfirming(true)
    else foundEngagementFor(m)
  }

  const activeMatch = dbMatch || match

  const body = (
    <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Title + the lookup gate — frame A, always first */}
      <div>
        <h2 style={{ fontSize: '16px', fontWeight: 500, color: '#1a1a18' }}>New client</h2>
        <p style={{ fontSize: '12px', color: '#8a8a84', marginTop: '4px' }}>Search first so you don't create a duplicate.</p>
      </div>

      {frame !== 'D' && frame !== 'F' && (
        <div>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', color: '#8a8a84', display: 'inline-flex' }}>
              <IconSearch size={16} />
            </span>
            <input
              autoFocus
              style={{ ...inp, paddingLeft: '34px' }}
              placeholder="Name, email, or phone"
              value={query}
              onChange={e => { setQuery(e.target.value); setPickedId(null); setDbMatch(null); setErrorMsg(null) }}
              aria-label="Search clients"
            />
          </div>
          <p style={{ fontSize: '11px', color: '#8a8a84', marginTop: '6px' }}>
            Matches on email or phone (digits only). Type to search — results appear as you go.
          </p>
        </div>
      )}

      {/* Frame B — returning client */}
      {(frame === 'B' || dbMatch) && activeMatch && !confirming && !founded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div><Badge tint={AMBER} icon={<IconUserCheck size={13} />} label="Returning client" /></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{
              width: '40px', height: '40px', borderRadius: '50%', flexShrink: 0,
              background: '#F1EFE8', color: '#444441', display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 500,
            }}>{initialsOf(activeMatch.person.name)}</span>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: '15px', fontWeight: 500, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeMatch.person.name}
              </p>
              <p style={{ fontSize: '12px', color: '#8a8a84', marginTop: '2px' }}>
                matched on {activeMatch.matchedOn}{activeMatch.matchedOn !== 'name' ? <> · {activeMatch.matchedValue}</> : null}
              </p>
            </div>
          </div>

          {matches.length > 1 && !dbMatch && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {matches.filter(m => m.person.id !== activeMatch.person.id).slice(0, 4).map(m => (
                <button key={m.person.id} onClick={() => setPickedId(m.person.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '8px', border: '0.5px solid rgba(0,0,0,0.1)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                  <span style={{ fontSize: '13px', color: '#1a1a18' }}>{m.person.name}</span>
                  <span style={{ fontSize: '11px', color: '#8a8a84' }}>also matched on {m.matchedOn}</span>
                </button>
              ))}
            </div>
          )}

          <div style={{ background: '#f7f6f4', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: '#8a8a84' }}>Open engagements</span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: openEngs.length > 0 ? AMBER.text : '#1a1a18' }}>
                {openEngs.length} open
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: '#8a8a84' }}>Last contact</span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: '#1a1a18' }}>{lastContact || '—'}</span>
            </div>
          </div>

          {errorMsg && <p style={{ fontSize: '12px', color: '#791F1F', background: '#FCEBEB', padding: '8px 12px', borderRadius: '8px' }}>{errorMsg}</p>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => startEngagement(activeMatch)}>
              <IconPlus size={14} /> Start new engagement
            </button>
            <button style={secondaryBtn} onClick={() => onOpenClient(activeMatch.person.id)}>
              Open client profile
            </button>
          </div>
        </div>
      )}

      {/* Frame C — no match, create the person (founding-viable fields only) */}
      {frame === 'C' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div><Badge tint={GREEN} icon={<IconSparkles size={13} />} label="No match — new person" /></div>
          <p style={{ fontSize: '12px', color: '#8a8a84' }}>
            Founding-viable fields only. The card opens on create — fill the rest there.
          </p>

          <div>
            <label style={lbl}>Name</label>
            <input style={inp} value={effName} onChange={e => set('name', e.target.value)} aria-label="Name" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label style={lbl}>Email · optional</label>
              <input style={inp} type="email" value={effEmail} onChange={e => set('email', e.target.value)} aria-label="Email" />
            </div>
            <div>
              <label style={lbl}>Phone · optional</label>
              <input style={inp} type="tel" value={effPhone} onChange={e => set('phone', e.target.value)} aria-label="Phone" />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label style={lbl}>Source</label>
              <select
                style={inp}
                value={form.source}
                onChange={e => {
                  const v = e.target.value
                  set('source', v)
                  // Referral is the trigger: open the referrer picker.
                  // Moving OFF Referral clears any picked referrer so a
                  // stale link never rides a non-referral source.
                  if (v === 'Referral') setPickReferrer(true)
                  else { setReferrer(null); setPickReferrer(false) }
                }}
                aria-label="Source"
              >
                {withDefault(lookupOptions.sources || [], form.source).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Type</label>
              <select style={inp} value={form.projectType} onChange={e => set('projectType', e.target.value)} aria-label="Type">
                {withDefault(lookupOptions.projectTypes || [], form.projectType).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          </div>

          {/* Referred by — only on the Referral source. Match-or-create
              picker (ReferrerPicker): clients (kind='lead', match-only)
              + partners/contacts (kind='partner', inline-creatable). A
              picked referrer shows as a clearable chip; skipping is fine
              — the create saves nulls and founding is never blocked. */}
          {form.source === 'Referral' && (
            <div>
              <label style={lbl}>Referred by · optional</label>
              {referrer ? (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '7px',
                  padding: '5px 11px', borderRadius: '10px',
                  background: GREEN.bg, color: GREEN.text, fontSize: '13px', fontWeight: 500,
                }}>
                  <button type="button" onClick={() => setPickReferrer(v => !v)} aria-label="Edit referrer"
                    style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}>
                    {referrer.name}
                  </button>
                  <button type="button" onClick={() => { setReferrer(null); setPickReferrer(true) }} aria-label="Clear referrer"
                    style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'inherit', fontSize: '13px', lineHeight: 1 }}>
                    ×
                  </button>
                </span>
              ) : !pickReferrer && (
                <button type="button" onClick={() => setPickReferrer(true)}
                  style={{ ...secondaryBtn, width: 'auto', padding: '6px 12px', fontSize: '12px' }}>
                  ＋ Add referrer
                </button>
              )}
              {pickReferrer && (
                <ReferrerPicker
                  people={scopedPeople}
                  locationUuid={locationUuid}
                  selectedId={referrer?.id || null}
                  onSelect={r => { setReferrer(r); setPickReferrer(false) }}
                />
              )}
            </div>
          )}

          <Toggle on={form.drip} onFlip={() => set('drip', !form.drip)} label="Add to drip sequence" />

          {errorMsg && <p style={{ fontSize: '12px', color: '#791F1F', background: '#FCEBEB', padding: '8px 12px', borderRadius: '8px' }}>{errorMsg}</p>}

          <button style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={createPerson}>
            Create — opens card
          </button>
        </div>
      )}

      {/* Frame D — concurrent-engagement confirm (only when 1+ open) */}
      {frame === 'D' && activeMatch && (
        <div style={{ border: `1px solid ${AMBER.text}40`, background: `${AMBER.bg}66`, borderRadius: '12px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: AMBER.text }}>
            <IconAlertTriangle size={18} />
            <h3 style={{ fontSize: '14px', fontWeight: 500, color: '#1a1a18' }}>This client has an open engagement</h3>
          </div>
          <p style={{ fontSize: '13px', color: '#444441', lineHeight: 1.5 }}>
            {activeMatch.person.name} has an engagement started {fmtDate(openEngs[0]?.created_at) || '—'} that's still open.
            Starting a new one creates a second, concurrent engagement — both stay active.
          </p>
          {errorMsg && <p style={{ fontSize: '12px', color: '#791F1F', background: '#FCEBEB', padding: '8px 12px', borderRadius: '8px' }}>{errorMsg}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => foundEngagementFor(activeMatch)}>
              Start another engagement
            </button>
            <button style={secondaryBtn} onClick={() => (openEngs[0] ? onOpenEngagement(openEngs[0]) : setConfirming(false))}>
              Open existing instead
            </button>
          </div>
        </div>
      )}

      {/* Frame F — founded; Send is the optional next step. The board
          already shows the engagement (onFounded fired on the confirmed
          write); the person derives Active. 'Keep local' is a real exit:
          cash/off-Jobber work stays a full engagement with no Jobber
          link, send available later from the engagement panel. */}
      {frame === 'F' && founded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div><Badge tint={GREEN} icon={<IconCheck size={13} />} label="Engagement started" /></div>
          <p style={{ fontSize: '13px', color: '#444441', lineHeight: 1.5 }}>
            {founded.person.name}&rsquo;s new engagement is on the board in Request.
            Send it to Jobber now, or keep it local — you can send any time from the engagement.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {onSendToJobber && (
              <button style={primaryBtn} onClick={() => { onSendToJobber(founded.person, { engagementId: founded.engagement.id }); onClose() }}>
                <IconSend size={14} /> Send to Jobber
              </button>
            )}
            <button style={onSendToJobber ? secondaryBtn : primaryBtn} onClick={onClose}>
              Keep local for now
            </button>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose}>
      {body}
    </OverlayShell>
  )
}
