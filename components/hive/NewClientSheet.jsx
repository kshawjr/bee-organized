// components/hive/NewClientSheet.jsx
// ─────────────────────────────────────────────────────────────
// The beta manual add-client flow — a re-skin of the classic
// NewLeadModal flow (BeeHub.jsx), rebuilt as a beta-chunk module (§8.5:
// no imports from BeeHub). Renders through OverlayShell so it inherits
// the dvh sheet geometry, scroll reset, body lock, and header X.
//
// DOCTRINE (updated 2026-09-26 — every job goes to Jobber): "New"
// creates a PERSON for a genuinely new inquiry (frame C), and the lookup
// is a HARD gate — frame A always comes before any create (the
// anti-dupe). For a RETURNING client (frames B/D) the one action is
// "Start new job in Jobber": it opens Send to Jobber for the EXISTING
// lead, which creates the request on their Jobber client, and the
// REQUEST_CREATE webhook founds the new engagement (rule 1 — a second
// request is a second engagement, beside any open one).
//
// There is no local-only founding here any more. Until 2026-09-26 frame B
// founded an empty engagement first (POST /api/engagements, founded_by=
// 'manual') and frame F offered Send or "Keep local for now". Kevin's
// ruling: no work skips Jobber, so "Keep local" only ever made a card
// that could never become real work — the same empty card the removed
// "+ New engagement" button made (47 of them by 2026-09-16, and 5 more
// through this sheet after the button went). Founding now happens only
// when Jobber has the request, so an empty card cannot be made here.
//
// The older returning-client path — minting a duplicate leads row via
// POST /api/leads — stays RETIRED: it stranded duplicates in the Inbox
// and 400'd at send on leads_jobber_client_id_location_idx.
//
// Frames (routed by the lookup, all downstream of the search field):
//   A — search input. Matches as you type against the loaded people
//       prop (see shared/clientMatch.js for the phone-storage story).
//   L — possible matches: a list, NOBODY pre-selected. Any name match,
//       any partial-phone match, and more than one email/phone match,
//       lands here — the owner picks who it is, or takes "None of
//       these — create a new client".
//   B — returning client, matched-on line, open-engagement
//       count + last contact, new-job-in-Jobber / open-profile actions.
//       Opens by itself ONLY for exactly one email or EXACT phone match;
//       otherwise only after a pick from L.
//   C — no match (or "create a new client" chosen): create the PERSON
//       with founding-viable fields only.
//       The authoritative DB match query re-runs right before the insert.
//       Source='Referral' opens ReferrerPicker (match-or-create) and the
//       link rides the POST as referred_by_kind/referred_by_id.
//   D — matched client has 1+ OPEN engagement: concurrent-work confirm
//       before the send — the new request founds a SECOND engagement
//       (rule 1), both stay active.
//
// WHY NAMES NEVER AUTO-SELECT (2026-09-27, Whitney / Portland): name
// matching is a substring match from 2 characters, so "Shelby" matched
// both Portland Shelbys and the sheet silently took the first — and with
// any match on screen there was no way to reach frame C, so a THIRD
// Shelby could not be created at all. An email or phone match is strong
// evidence it is the same person; a name match is not — and neither is a
// PARTIAL phone (2026-09-28: "609 978-4046 x1216" contains another
// client's whole number, so typing that number opened the wrong one) (71% of clients
// share a first name with someone at their own location). Every frame
// with a match on it offers the "create a new client" exit.
//
// The merge seams: frame C hands the REAL returned lead row up through
// onCreated (never an optimistic stub — phantom Inbox rows); frames B/D
// hand the person to onSendToJobber and close — the caller's send flow
// owns the rest, including surfacing the founded card. This module never
// reaches into BeeHub (§8.5).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useMemo, useState } from 'react'
import OverlayShell from './OverlayShell'
import ReferrerPicker from './ReferrerPicker'
import AddressAutofill from './shared/AddressAutofill'
import useIsMobile from './shared/useIsMobile'
import { isTerminal } from './shared/stageConfig'
import { lastActivityTs } from './shared/engagementStatus'
import { matchPeople, normalizeEmail, normalizePhone, queryLeadMatches, maskEmail, maskPhone } from './shared/clientMatch'
import { createClient } from '@/lib/supabase'
import { composeLeadAddress } from '@/lib/lead-address'
import { IconSearch, IconUserCheck, IconSparkles, IconAlertTriangle, IconCheck, IconSend, IconMapPin } from '@/components/ui/icons'
import { inp, lbl } from './shared/formKit'
import { T } from './shared/tokens'

const ACCENT = T.accent.fg // THE action accent
const AMBER = T.family.amber // warning tint (design language)
const GREEN = T.family.green // success tint

const fmtDate = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

const primaryBtn = {
  width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  padding: '10px 14px', borderRadius: T.radius.control, border: 'none',
  background: ACCENT, color: T.accent.onFill, fontSize: '13px', fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}
const secondaryBtn = {
  width: '100%', padding: '10px 14px', borderRadius: T.radius.control,
  border: T.border.strong, background: 'transparent',
  fontSize: '13px', fontWeight: 500, color: T.ink.primary,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}

const linkBtn = {
  alignSelf: 'flex-start', padding: 0, border: 'none', background: 'transparent',
  fontSize: '12px', fontWeight: 500, color: T.accent.deep,
  cursor: 'pointer', fontFamily: 'inherit',
}

// Frame L shows this many rows; the rest wait for a narrower query
// (Philadelphia Suburbs has 332 Jennifers).
const MAX_LISTED = 8

const matchedOnLabel = (m) => (m.matchedOn === 'phone' && m.exact === false ? 'part of phone' : m.matchedOn)

function Badge({ tint, icon, label }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '3px 10px', borderRadius: T.radius.chip,
      background: tint.bg, color: tint.text,
      fontSize: '12px', fontWeight: 500, lineHeight: 1.5, whiteSpace: 'nowrap',
    }}>
      {icon}
      {label}
    </span>
  )
}

// The create-time warning when nurture emails didn't start. Exported for the
// test; the reason text comes from the server (lib/drip-enrol-outcome.ts).
export function dripNotStartedToast(drip) {
  const why = (drip && drip.message) || 'no reason was given'
  return `Client saved — nurture emails didn’t start: ${why}.`
}

// On-create notification actions — ONE unified multi-select folding the old
// standalone "Add to drip sequence" toggle in as the Drip pill. Three
// INDEPENDENT options, ALL default OFF: each rides the POST /api/leads create
// as its own boolean (notifyEmail / notifySlack / startDrip) and fires its own
// server-side path. Nothing selected = silent (the prior manual behavior).
const NOTIFY_OPTIONS = [
  { key: 'notifyEmail', label: 'Email', aria: 'Send notification email' },
  { key: 'notifySlack', label: 'Slack', aria: 'Post to Slack' },
  { key: 'startDrip',   label: 'Drip',  aria: 'Start drip emails' },
]

// Compact sharp pills (§8.6 language): 0.5px border, chip radius, flat fill,
// no shadow; selected = accent soft fill + accent border + whole-pixel check.
function NotifyPills({ value, onToggle }) {
  return (
    <div>
      <label style={lbl}>Send on create</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {NOTIFY_OPTIONS.map(opt => {
          const on = !!value[opt.key]
          return (
            <button
              key={opt.key}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={opt.aria}
              title={opt.aria}
              onClick={() => onToggle(opt.key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px',
                padding: '5px 11px', borderRadius: T.radius.chip,
                border: on ? `0.5px solid ${T.accent.fg}` : T.border.control,
                background: on ? T.accent.soft : T.surface.raised,
                color: on ? T.accent.deep : T.ink.muted,
                fontSize: '12px', fontWeight: 500, fontFamily: 'inherit',
                lineHeight: 1.4, cursor: 'pointer',
              }}
            >
              {on && <IconCheck size={12} />}
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
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
  onPartnerCreated = () => {},
  onOpenClient = () => {},
  onOpenEngagement = () => {},
  onSendToJobber = null,
  setToast = () => {},
  readOnly = false,
}) {
  const isMobile = useIsMobile()
  const [query, setQuery] = useState('')
  // null = derive from the query; a string = the user took the field over.
  // notifyEmail / notifySlack / startDrip: the on-create multi-select, all
  // default OFF (a manual lead with nothing selected is silent). startDrip
  // replaces the old `drip` toggle default-ON.
  const [form, setForm] = useState({ name: null, email: null, phone: null, source: '', projectType: 'Client', requestDetails: '', notifyEmail: false, notifySlack: false, startDrip: false, street: '', apt: '', city: '', state: '', zip: '' })
  // Address is OPTIONAL and collapsed by default — the sheet's stated
  // intent is founding-viable fields only, so the block stays hidden until
  // the user asks for it (mirrors Classic's default-off "📍 Add address").
  const [showAddr, setShowAddr] = useState(false)
  // Referral-source referrer link (frame C) — { id, kind, name } | null.
  // kind is 'lead', 'partner' (contacts store as 'partner' too), or
  // 'company'; maps straight onto leads.referred_by_kind /
  // referred_by_id at POST.
  const [referrer, setReferrer] = useState(null)
  const [pickReferrer, setPickReferrer] = useState(false)
  const [pickedId, setPickedId] = useState(null) // the person picked from frame L
  const [forceNew, setForceNew] = useState(false) // "None of these — create a new client"
  const [confirming, setConfirming] = useState(false) // frame D
  const [dbMatch, setDbMatch] = useState(null) // pre-insert gate hit not in the loaded set
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Match universe = the location-scoped slice of the loaded people prop.
  const scopedPeople = useMemo(() => (
    locFilter === 'all' ? people : people.filter(p => p.locationId === locFilter)
  ), [people, locFilter])

  const matches = useMemo(() => matchPeople(scopedPeople, query), [scopedPeople, query])
  // Only ONE email/phone match opens frame B by itself. A name match —
  // even a single one — never does, and neither does a strong key shared
  // by several people (a household phone): those go to the frame L list.
  // A PARTIAL phone (digits-contains, not every digit) is no stronger
  // than a name: it lists too.
  const strongHit = (m) => m.matchedOn === 'email' || (m.matchedOn === 'phone' && m.exact)
  const autoMatch = matches.length === 1 && strongHit(matches[0]) ? matches[0] : null
  const match = forceNew ? null : ((pickedId && matches.find(m => m.person.id === pickedId)) || autoMatch)

  // A query is "committed" once it could plausibly identify someone —
  // that is when a no-match result may open the create form (frame C).
  const q = query.trim()
  const qDigits = q.replace(/\D/g, '')
  const searched = q.includes('@') ? q.length >= 3 : (qDigits.length >= 7 || q.length >= 2)

  const frame = confirming ? 'D'
    : match ? 'B'
    : (matches.length > 0 && !forceNew && !dbMatch) ? 'L'
    : (searched && !dbMatch) ? 'C'
    : 'A'

  // The missing exit: from a list, a returning client, or a pre-insert
  // bounce, straight to frame C. The query stays, so the name prefills.
  const createNewInstead = () => { setForceNew(true); setPickedId(null); setDbMatch(null); setErrorMsg(null) }
  const backToMatches = () => { setForceNew(false); setPickedId(null); setErrorMsg(null) }

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

  // Optional address → the POST shape the rest of the app already reads:
  // the FULL composed `address` string + the part columns (people-mapper /
  // client card), PLUS a discrete-`street` addresses[] entry (the
  // Send-to-Jobber route reads addresses[].street for the Jobber property,
  // preferring it over the flat string). Mirrors the import/Classic
  // convention via composeLeadAddress. No street → NO address keys at all,
  // so a create without an address is byte-identical to today.
  function buildAddressFields() {
    const street = (form.street || '').trim()
    if (!street) return {}
    // The discrete Apt/Suite value rides the street line into storage
    // (issue 133, the NetworkAddSheet convention) — including the
    // addresses[].street the Send-to-Jobber property step reads, so the
    // unit reaches the Jobber property too. A unit without a street is
    // junk and is dropped with the rest of the block.
    const apt = (form.apt || '').trim()
    const streetLine = [street, apt].filter(Boolean).join(' ')
    const city = (form.city || '').trim()
    const state = (form.state || '').trim()
    const zip = (form.zip || '').trim()
    const full = composeLeadAddress({ street: streetLine, city, state, zip })
    return {
      address: full || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      addresses: [{ type: 'Service', value: full, street: streetLine, city, state, zip }],
    }
  }

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
    return json
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
            setForceNew(false)
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
      const { lead, drip } = await postLead({
        name,
        first_name: parts[0] || null,
        last_name: parts.slice(1).join(' ') || null,
        email: (effEmail || '').trim() || null,
        phone: (effPhone || '').trim() || null,
        source: form.source || null,
        project_type: form.projectType || null,
        // Free-text request/description → leads.request_details (the same
        // column the intake path fills from `message`). Empty stays null so
        // the notification builders omit it, same as a details-less webform.
        request_details: (form.requestDetails || '').trim() || null,
        // Referrer link rides only on a Referral source WITH a picked
        // referrer — source='Referral' with none saves nulls (the picker
        // is skippable, matching Classic; never block founding on it).
        referred_by_kind: form.source === 'Referral' && referrer ? referrer.kind : null,
        referred_by_id: form.source === 'Referral' && referrer ? referrer.id : null,
        // On-create multi-select — each independent, all default OFF.
        notifyEmail: form.notifyEmail,
        notifySlack: form.notifySlack,
        startDrip:   form.startDrip,
        // Optional address (empty when the block was never opened).
        ...buildAddressFields(),
      })
      // Frame C stays person-world by design: a genuinely NEW inquiry
      // lands in the Inbox as a person (doctrine above), and Send to Jobber
      // from there creates the first request.
      onCreated(lead)
      // Nurture emails didn't start — say so, and why (2026-09-27). Before
      // this a hand-entered client with Drip left off, or a Drip that failed
      // to enrol, looked exactly like one that started. Only when the route
      // reports it: a client saved at a stage with no drip gets nothing.
      if (drip && drip.enrolled === false) {
        setToast({ kind: 'error', msg: dripNotStartedToast(drip) })
      }
    } catch (e) {
      setErrorMsg(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  // Frame B/D "Start new job in Jobber" — hands the EXISTING person to the
  // send flow and closes. Nothing is written here: the send creates the
  // request on their Jobber client and the webhook founds the engagement.
  // No onSendToJobber means no way to make real work, so the action is not
  // offered at all (never a local-only fallback).
  function startJobInJobber(m) {
    if (!onSendToJobber || readOnly) return
    onSendToJobber(m.person)
    onClose()
  }

  const startNewJob = (m) => {
    if (openEngs.length > 0) setConfirming(true)
    else startJobInJobber(m)
  }

  const activeMatch = dbMatch || match

  const body = (
    <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Title + the lookup gate — frame A, always first */}
      <div>
        <h2 style={{ fontSize: '16px', fontWeight: 500, color: T.ink.primary }}>New client</h2>
        <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '4px' }}>Search first so you don't create a duplicate.</p>
      </div>

      {frame !== 'D' && frame !== 'F' && (
        <div>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', color: T.ink.muted, display: 'inline-flex' }}>
              <IconSearch size={16} />
            </span>
            <input
              autoFocus
              style={{ ...inp, paddingLeft: '34px' }}
              placeholder="Name, email, or phone"
              value={query}
              onChange={e => { setQuery(e.target.value); setPickedId(null); setForceNew(false); setDbMatch(null); setErrorMsg(null) }}
              aria-label="Search clients"
            />
          </div>
          <p style={{ fontSize: '11px', color: T.ink.muted, marginTop: '6px' }}>
            Matches on email or phone (digits only). Type to search — results appear as you go.
          </p>
        </div>
      )}

      {/* Frame L — possible matches, nobody pre-selected */}
      {frame === 'L' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div><Badge tint={AMBER} icon={<IconUserCheck size={13} />} label={matches.length === 1 ? 'Possible match' : `${matches.length} possible matches`} /></div>
          <p style={{ fontSize: '12px', color: T.ink.muted }}>
            {matches.length === 1 ? 'Is this who you mean?' : 'Which one do you mean?'}
          </p>
          <div role="list" aria-label="Possible matches" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {matches.slice(0, MAX_LISTED).map(m => {
              const contact = [maskEmail(m.person.email), maskPhone(m.person.phone)].filter(Boolean).join(' · ')
              return (
                <button key={m.person.id} role="listitem" onClick={() => setPickedId(m.person.id)}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px', padding: '8px 12px', borderRadius: T.radius.control, border: T.border.thin, background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary }}>{m.person.name}</span>
                  <span style={{ fontSize: '11px', color: T.ink.muted }}>
                    matched on {matchedOnLabel(m)}{contact ? ` · ${contact}` : ''}
                  </span>
                </button>
              )
            })}
          </div>
          {matches.length > MAX_LISTED && (
            <p style={{ fontSize: '11px', color: T.ink.muted }}>
              {matches.length - MAX_LISTED} more — keep typing to narrow it down.
            </p>
          )}
          <button style={secondaryBtn} onClick={createNewInstead}>
            None of these — create a new client
          </button>
        </div>
      )}

      {/* Frame B — returning client */}
      {(frame === 'B' || dbMatch) && activeMatch && !confirming && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div><Badge tint={AMBER} icon={<IconUserCheck size={13} />} label="Returning client" /></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{
              width: '40px', height: '40px', borderRadius: T.radius.round, flexShrink: 0,
              background: T.family.gray.bg, color: T.family.gray.text, display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 500,
            }}>{initialsOf(activeMatch.person.name)}</span>
            <div style={{ minWidth: 0 }}>
              <p title={activeMatch.person.name} style={{ fontSize: '15px', fontWeight: 500, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeMatch.person.name}
              </p>
              <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '2px' }}>
                matched on {matchedOnLabel(activeMatch)}{activeMatch.matchedOn !== 'name' ? <> · {activeMatch.matchedValue}</> : null}
              </p>
            </div>
          </div>

          {pickedId && !autoMatch && !dbMatch && (
            <button type="button" onClick={backToMatches} style={linkBtn}>
              ← Back to {matches.length === 1 ? 'the match' : `all ${matches.length} matches`}
            </button>
          )}

          <div style={{ background: T.surface.sunken, borderRadius: T.radius.inset, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: T.ink.muted }}>Open engagements</span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: openEngs.length > 0 ? AMBER.text : T.ink.primary }}>
                {openEngs.length} open
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: T.ink.muted }}>Last contact</span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: T.ink.primary }}>{lastContact || '—'}</span>
            </div>
          </div>

          {errorMsg && <p style={{ fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 12px', borderRadius: T.radius.control }}>{errorMsg}</p>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {onSendToJobber && (
              <button style={{ ...primaryBtn, opacity: readOnly ? 0.6 : 1 }} disabled={readOnly} onClick={() => startNewJob(activeMatch)}>
                <IconSend size={14} /> Start new job in Jobber
              </button>
            )}
            <button style={onSendToJobber ? secondaryBtn : primaryBtn} onClick={() => onOpenClient(activeMatch.person.id)}>
              Open client profile
            </button>
            <button style={secondaryBtn} onClick={createNewInstead}>
              None of these — create a new client
            </button>
          </div>
        </div>
      )}

      {/* Frame C — no match, create the person (founding-viable fields only) */}
      {frame === 'C' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div><Badge tint={GREEN} icon={<IconSparkles size={13} />} label={forceNew ? 'New person' : 'No match — new person'} /></div>
          {forceNew && matches.length > 0 && (
            <button type="button" onClick={backToMatches} style={linkBtn}>
              ← Back to {matches.length === 1 ? 'the match' : `the ${matches.length} matches`}
            </button>
          )}
          <p style={{ fontSize: '12px', color: T.ink.muted }}>
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
                {/* Starts blank and stays optional (30 Sept 2026). It used to
                    default to "Manual", which told an owner nothing — 151
                    leads in 90 days carried it. No choice saves no source,
                    and no source sends nothing to Jobber. */}
                <option value="">Not set</option>
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
              + partners/contacts (kind='partner', inline-creatable)
              + companies (kind='company', match-only). A picked referrer
              shows as a clearable chip; skipping is fine — the create
              saves nulls and founding is never blocked. */}
          {form.source === 'Referral' && (
            <div>
              <label style={lbl}>Referred by · optional</label>
              {referrer ? (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '7px',
                  padding: '5px 11px', borderRadius: T.radius.chip,
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
                  onPartnerCreated={onPartnerCreated}
                  setToast={setToast}
                  readOnly={readOnly}
                />
              )}
            </div>
          )}

          {/* Request details — the free-text "what they want" field. Same
              leads.request_details column the intake path fills from the
              webform `message`; flows to the notification email + Slack post
              (both render it only when present). Ordinary optional field —
              NOT gated by the notify pills. */}
          <div>
            <label style={lbl}>Request details · optional</label>
            <textarea
              style={{ ...inp, minHeight: '72px', resize: 'vertical', lineHeight: 1.4 }}
              value={form.requestDetails}
              onChange={e => set('requestDetails', e.target.value)}
              placeholder="What does the client want? (shows in the new-lead email + Slack)"
              aria-label="Request details"
            />
          </div>

          {/* Address — OPTIONAL, collapsed by default (founding stays
              short). Reuses AddressAutofill — the SAME shared Google Places
              typeahead the client card's AddressField mounts — so there's
              one autofill implementation, not a parallel one. Values ride
              the create POST via buildAddressFields; nothing is required. */}
          <div>
            <button
              type="button"
              aria-label="Add address"
              aria-expanded={showAddr}
              aria-controls="new-client-address"
              onClick={() => setShowAddr(v => !v)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '2px 0', border: 'none', background: 'transparent',
                color: T.ink.muted, fontSize: '12px', fontWeight: 500,
                fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              <IconMapPin size={14} />
              <span>Add address</span>
              <span aria-hidden="true" style={{ color: T.ink.faint }}>{showAddr ? '–' : '+'}</span>
            </button>
            {showAddr && (
              <div id="new-client-address" style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
                <AddressAutofill
                  value={form.street || ''}
                  onChange={v => set('street', v)}
                  onParsed={p => setForm(f => ({
                    ...f,
                    // Merge-safe unit handling (issue 133, same as
                    // AddressField): Google's real subpremise wins; a
                    // typed Apt/Suite survives when the prediction has
                    // none (the common case), and the fallback parse
                    // carries no apt key so it never clobbers one.
                    street: p.street || p.full || '',
                    apt: p.apt || f.apt || '',
                    city: p.city || '',
                    state: p.state || '',
                    zip: p.zip || '',
                  }))}
                  placeholder="Start typing a street address…"
                  style={inp}
                />
                <input style={inp} value={form.apt || ''} onChange={e => set('apt', e.target.value)} placeholder="Apt / Suite (optional)" aria-label="Apt" />
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px' }}>
                  <input style={inp} value={form.city || ''} onChange={e => set('city', e.target.value)} placeholder="City" aria-label="City" />
                  <input style={inp} value={form.state || ''} onChange={e => set('state', e.target.value)} placeholder="ST" maxLength={2} aria-label="State" />
                  <input style={inp} value={form.zip || ''} onChange={e => set('zip', e.target.value)} placeholder="ZIP" aria-label="ZIP" />
                </div>
              </div>
            )}
          </div>

          <NotifyPills value={form} onToggle={(k) => set(k, !form[k])} />

          {errorMsg && <p style={{ fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 12px', borderRadius: T.radius.control }}>{errorMsg}</p>}

          <button style={{ ...primaryBtn, opacity: (readOnly || busy) ? 0.6 : 1 }} disabled={readOnly || busy} onClick={createPerson}>
            Create — opens card
          </button>
        </div>
      )}

      {/* Frame D — concurrent-engagement confirm (only when 1+ open) */}
      {frame === 'D' && activeMatch && (
        <div style={{ border: `1px solid ${AMBER.text}40`, background: `${AMBER.bg}66`, borderRadius: T.radius.inset, padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: AMBER.text }}>
            <IconAlertTriangle size={18} />
            <h3 style={{ fontSize: '14px', fontWeight: 500, color: T.ink.primary }}>This client has an open engagement</h3>
          </div>
          <p style={{ fontSize: '13px', color: T.ink.strong, lineHeight: 1.5 }}>
            {activeMatch.person.name} has an engagement started {fmtDate(openEngs[0]?.created_at) || '—'} that's still open.
            A new job goes to Jobber as a new request and becomes a second engagement — both stay active.
          </p>
          {errorMsg && <p style={{ fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 12px', borderRadius: T.radius.control }}>{errorMsg}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {onSendToJobber && (
              <button style={{ ...primaryBtn, opacity: readOnly ? 0.6 : 1 }} disabled={readOnly} onClick={() => startJobInJobber(activeMatch)}>
                <IconSend size={14} /> Start another job in Jobber
              </button>
            )}
            <button style={secondaryBtn} onClick={() => (openEngs[0] ? onOpenEngagement(openEngs[0]) : setConfirming(false))}>
              Open existing instead
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
