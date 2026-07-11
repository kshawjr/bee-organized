// components/hive/ClientProfile.jsx
// ─────────────────────────────────────────────────────────────
// The CLIENT-level card — v4 layout (card-restore build 2, Kevin's
// 7/10 mockup session; 840px desktop modal), top to bottom:
//   header   — avatar, name + derived-status chip, subtitle
//              '{location} · client since {Mon YYYY} · Jobber ↗';
//              prev/next chevrons (ONLY when the opener passed a
//              sibling ordering — the directory does; a panel swap
//              doesn't) + ··· on the right
//   METRIC BAND — full-bleed hairline row, tabular numerals:
//              Collected / Invoiced / Owing / Last touch. Owing spans
//              ALL engagements INCLUDING closed (the closed-debt drift
//              fix — the route aggregates own the math)
//   tabs     — Overview · Timeline (count) · Files (count)
//   Overview — TWO columns (stacks under ~700px):
//              LEFT  contact stack (phone/email/address/source — the
//                    Build-1 inline-edit components) + secondary
//                    contacts (display + tel:/mailto:) + tags (display
//                    pills; editing is Build 3) + assigned-to (display)
//                    + Preferences (marketing/snooze display; the
//                    nurture-drip row HIDES when the client has live
//                    business — v4 rule)
//              RIGHT pinned buzz → request details (pre-Jobber only) →
//                    engagements (repeat/new chips; closed rows keep
//                    Build-1 reason + note) → recent activity + composer
//   action bar — PINNED (sticky bottom): Call · Log touchpoint ·
//              Open in Jobber (or Send to Jobber pre-link) · + New
//              engagement
// Fetches GET /api/clients/:id/profile on open.
//
// Overlay model: HiveShell holds ONE overlay slot — ClientProfile and
// EngagementPanel REPLACE each other (no stacking); two taps loop,
// zero modal piles.
//
// Source is EDITABLE here (Kevin's person-vs-deal split: source is
// first-touch, PERSON-scoped — this is its ONE edit home). Project
// type is deal-scoped and lives on the EngagementPanel masthead only —
// never duplicated here. Beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { CHIP_STYLES, stageDisplayLabel } from './shared/stageConfig'
import { T } from './shared/tokens'
import { deriveClientStatus, CLIENT_STATUS_META } from './shared/clientStatus'
import { deriveStatusChip, engagementValue, displayTitle, fmtMoney, daysSince, closedReasonLabel } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import { vitalsAge } from './shared/VitalsStrip'
import MetricBand from './shared/MetricBand'
import {
  IconPhone, IconExternalLink, IconSend, IconChevronRight,
  IconInbox, IconFileText, IconHammer, IconFileInvoice, IconCheck, IconX, IconPlus, IconPaperclip,
} from '@/components/ui/icons'
import EditableDesc from './EditableDesc'
import OverlayShell from './OverlayShell'
import ContactField from './shared/ContactField'
import AddressField from './shared/AddressField'
import SourceField from './shared/SourceField'
import ReferrerField from './shared/ReferrerField'
import ContactsBlock from './shared/ContactsBlock'
import TagsRow from './shared/TagsRow'
import PreferencesBlock from './shared/PreferencesBlock'
import { jobberClientUrl } from './shared/jobberLinks'
import Timeline from './shared/Timeline'
import CardTabs from './shared/CardTabs'
import PinnedBuzz from './shared/PinnedBuzz'
import InitialsAvatar from './shared/InitialsAvatar'
import NotesStream from './NotesStream'
import { MicroLabel, quietBtn, CardMenu, undoToast, ActionRow, actionBtn } from './shared/cardKit'
import useIsMobile from './shared/useIsMobile'

const QUIET = T.surface.sunken
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const monthYear = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d) ? null : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

const STAGE_ICON = {
  'Request': IconInbox, 'Estimate': IconFileText,
  'Job in Progress': IconHammer, 'Final Processing': IconFileInvoice,
}

// siblings/onNavigate: the opener's natural ordering (e.g. the client
// directory's visible rows). When absent the prev/next chevrons hide —
// a panel→profile swap or a fresh create has no "next client".
export default function ClientProfile({ clientId, people = [], onClose, onOpenEngagement = () => {}, onSendToJobber = null, setToast = () => {}, onLeadPatched = () => {}, onPartnerCreated = () => {}, lookupOptions = { sources: [], projectTypes: [], clientTags: [] }, locationUsers = [], siblings = null, onNavigate = () => {}, readOnly = false }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [tab, setTab] = useState('overview')
  const [showClosed, setShowClosed] = useState(false)
  const [showAllReferred, setShowAllReferred] = useState(false)
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchMethod, setTouchMethod] = useState('call')
  const [touchNote, setTouchNote] = useState('')
  const [busy, setBusy] = useState(false)
  const nowMs = Date.now()

  const isMobile = useIsMobile()

  useEffect(() => {
    let dead = false
    setData(null); setLoadErr(null)
    fetch(`/api/clients/${clientId}/profile`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(d => { if (!dead) setData(d) })
      .catch(e => { if (!dead) setLoadErr(String(e.message || e)) })
    return () => { dead = true }
  }, [clientId])

  const c = data?.client
  const agg = data?.aggregates
  const engagements = data?.engagements ?? []
  const open = engagements.filter(e => e.stage !== 'Closed Won' && e.stage !== 'Closed Lost')
  const closed = engagements.filter(e => e.stage === 'Closed Won' || e.stage === 'Closed Lost')
  const buzz = data?.buzz_notes ?? []
  const touches = data?.touchpoints ?? []
  const jobNotes = data?.job_notes ?? []
  const engTitleById = Object.fromEntries(engagements.map(e => [e.id, displayTitle(e)]))

  // Won roll-up from the profile's own (complete, current) engagement set —
  // same shape the hub-page sweep ships as person.wonEngagements.
  const won = engagements.filter(e => e.stage === 'Closed Won')
  const wonSummary = won.length > 0 ? {
    count: won.length,
    value: won.reduce((s, e) => s + (Number(e.total_paid) || Number(e.total_invoiced) || 0), 0),
    lastClosedAt: won.map(e => e.closed_at).filter(Boolean).sort().pop() || null,
  } : null
  const status = c ? deriveClientStatus(
    {
      // || not ??: the aggregate is always numeric once loaded, so ?? never
      // falls back — a $0 engagement sum must not mask the leads.paid_amount
      // denorm for the Past existence test (paidAmount > 0).
      id: c.id, email: c.email, phone: c.phone, paidAmount: agg?.lifetime_paid || c.paid_amount,
      created: c.created_at,
      outreachTimeline: touches.map(t => ({ type: t.kind, occurred_at: t.occurred_at })),
      wonEngagements: wonSummary,
    },
    new Set(open.length > 0 ? [c.id] : []),
    nowMs,
  ) : null
  const statusMeta = status ? CLIENT_STATUS_META[status] : null
  const fam = statusMeta ? (CHIP_STYLES[statusMeta.styleKey] || CHIP_STYLES.gray) : CHIP_STYLES.gray

  const jobberLinked = !!c?.jobber_client_id
  // CLIENT-level deep link — /clients/{jobber_client_id} (classic's
  // pattern). Never derived from a child record's URL: the profile
  // route doesn't ship child *_url columns, and even if it did, a
  // client link that lands on one arbitrary job would be wrong.
  const jobberHref = jobberClientUrl(c?.jobber_client_id)

  const tags = data?.tags ?? []
  const lastTouchTs = touches.reduce((m, t) => Math.max(m, new Date(t.occurred_at).getTime() || 0), 0) || null
  // Earliest engagement anchors the repeat/new chips: everything after
  // the first is repeat business; the first chips New while it's fresh.
  const earliestEngId = engagements.length
    ? [...engagements].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0].id
    : null
  const engChip = (e) => {
    if (!earliestEngId) return null
    if (e.id !== earliestEngId) return { label: 'Repeat', styleKey: 'teal' }
    if (daysSince(e.created_at, nowMs) < 30) return { label: 'New', styleKey: 'gray' }
    return null
  }

  // Prev/next within the opener's ordering (chevrons hide without one).
  const sibIdx = siblings ? siblings.indexOf(clientId) : -1
  const prevId = sibIdx > 0 ? siblings[sibIdx - 1] : null
  const nextId = sibIdx >= 0 && sibIdx < (siblings?.length ?? 0) - 1 ? siblings[sibIdx + 1] : null

  async function patchLead(patch) {
    const res = await fetch(`/api/leads/${c.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
  }

  // Posted from the pinned buzz band (append-only; it owns the draft,
  // we own the notes array + optimistic prepend).
  async function addBuzzNote(text) {
    if (!text || !c) return
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: c.id, kind: 'buzz', text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, buzz_notes: [j.note, ...d.buzz_notes] } : d)
    } catch (e) { setToast({ kind: 'error', msg: `Note failed: ${e.message}` }) }
  }

  // Client-level note (kind='job', no engagement_id) — the same write
  // PersonCard's composer uses; both cards read the same rows now.
  async function addNote(text) {
    if (!text || !c) return
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: c.id, kind: 'job', text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, job_notes: [j.note, ...(d.job_notes || [])] } : d)
    } catch (e) { setToast({ kind: 'error', msg: `Note failed: ${e.message}` }) }
  }

  // Boolean return feeds EditableDesc's inline-edit standard: false
  // keeps the textarea open with the draft after the optimistic revert.
  async function saveReqDetails(text) {
    if (!c) return false
    const prev = c.request_details
    setData(d => d ? { ...d, client: { ...d.client, request_details: text || null } } : d)
    try {
      await patchLead({ request_details: text || null })
      setToast({ kind: 'success', msg: 'Description saved' })
      return true
    } catch (e) {
      setData(d => d ? { ...d, client: { ...d.client, request_details: prev } } : d)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
      return false
    }
  }

  async function logTouchpoint() {
    if (!c) return
    setBusy(true)
    try {
      const res = await fetch('/api/touchpoints', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: c.id, kind: 'reach_out', label: 'Reach-out', method: touchMethod, notes: touchNote.trim() || null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setTouchNote(''); setTouchOpen(false)
      setData(d => d ? { ...d, touchpoints: [{ id: `tmp-${Date.now()}`, kind: 'reach_out', method: touchMethod, label: 'Reach-out', occurred_at: new Date().toISOString() }, ...d.touchpoints] } : d)
      setToast({ kind: 'success', msg: 'Touchpoint logged' })
    } catch (e) { setToast({ kind: 'error', msg: `Touchpoint failed: ${e.message}` }) }
    finally { setBusy(false) }
  }

  // Manual founding — POST /api/engagements (founded_by='manual'), then
  // swap straight to the new engagement's panel (same overlay slot).
  async function newEngagement() {
    if (!c) return
    setBusy(true)
    try {
      const res = await fetch('/api/engagements', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: c.id }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setToast({ kind: 'success', msg: 'Engagement created' })
      if (j.engagement) onOpenEngagement(j.engagement)
    } catch (e) { setToast({ kind: 'error', msg: `Create failed: ${e.message}` }) }
    finally { setBusy(false) }
  }

  // Reopen (resurrect) a Closed LOST engagement — the server route
  // re-derives the correct open stage from the records (Closed Won stays
  // out of scope; no button is rendered for it). Updates the row in place
  // so it moves back to the open list without a full reload.
  async function reopenEngagement(engId, ev) {
    ev?.stopPropagation?.()
    setBusy(true)
    try {
      const res = await fetch(`/api/engagements/${engId}/reopen`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, engagements: (d.engagements || []).map(e => e.id === engId ? { ...e, stage: j.stage, closed_at: null, closed_reason: null, closed_note: null, nurture_started_at: null } : e) } : d)
      setToast({ kind: 'success', msg: `Reopened · ${j.stage}` })
    } catch (e) { setToast({ kind: 'error', msg: `Reopen failed: ${e.message}` }) }
    finally { setBusy(false) }
  }

  async function markJunk() {
    if (!c) return
    try {
      await patchLead({ is_junk: true })
      onLeadPatched(c.id, { is_junk: true })
      setToast(undoToast('Marked as junk', async () => {
        try {
          await patchLead({ is_junk: false })
          onLeadPatched(c.id, { is_junk: false })
          setToast({ kind: 'success', msg: `${c.name} restored` })
        } catch (e) { setToast({ kind: 'error', msg: `Undo failed: ${e.message}` }) }
      }))
    } catch (e) { setToast({ kind: 'error', msg: `Junk failed: ${e.message}` }) }
  }

  // Contact save landed: merge into the profile's own state, prepend the
  // route's audit touchpoint(s) so Recent activity shows the change
  // instantly, and hand the lead columns UP (onLeadPatched →
  // leadColsToPersonFields → people state) so inbox/directory/reopened
  // cards reflect it without a reload.
  const contactSaved = (cols, resp) => {
    const activity = (resp?.contact_activity || []).map(t => ({ ...t, user_label: 'You' }))
    setData(d => d ? {
      ...d,
      client: { ...d.client, ...cols },
      touchpoints: activity.length ? [...activity, ...d.touchpoints] : d.touchpoints,
    } : d)
    onLeadPatched(c.id, cols)
  }

  const closedVisible = showClosed ? closed : closed.slice(0, 2)

  // Client-WIDE recent slice — job notes (client-level + engagement-
  // scoped, the latter tagged) + touchpoints (tagged when scoped).
  const stream = [
    ...jobNotes.map(n => ({ t: 'note', ts: n.created_at, tag: n.engagement_id ? engTitleById[n.engagement_id] : null, ...n })),
    ...touches.map(tp => ({ t: 'touch', ts: tp.occurred_at, tag: tp.engagement_id ? engTitleById[tp.engagement_id] : null, ...tp })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 8)

  // LEFT column — the person: contact stack, secondary contacts, tags,
  // assigned-to, preferences. All display/inline-edit; no new writes.
  const leftCol = c && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0 }}>
      <div style={{ background: QUIET, border: T.border.divider, borderRadius: T.radius.inset, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
        <MicroLabel>Contact</MicroLabel>
        {/* Phone/email/address: click-to-edit (shared ContactField +
            AddressField); values stay live tel:/mailto: links. Source
            is the person-scoped first-touch — its ONE edit home. */}
        <ContactField kind="phone" leadId={c.id} value={c.phone} onSaved={contactSaved} setToast={setToast} readOnly={readOnly} />
        <ContactField kind="email" leadId={c.id} value={c.email} onSaved={contactSaved} setToast={setToast} readOnly={readOnly} />
        <AddressField leadId={c.id} value={{ address: c.address, city: c.city, state: c.state, zip: c.zip }} onSaved={contactSaved} setToast={setToast} readOnly={readOnly} />
        <SourceField
          leadId={c.id}
          value={c.source}
          options={lookupOptions.sources}
          onSaved={cols => { setData(d => d ? { ...d, client: { ...d.client, ...cols } } : d); onLeadPatched(c.id, cols) }}
          setToast={setToast}
          readOnly={readOnly}
        />
        <ReferrerField
          lead={c}
          locationUuid={c.location_uuid}
          people={people}
          onApply={fields => setData(d => d ? { ...d, client: { ...d.client, ...fields } } : d)}
          onSaved={cols => onLeadPatched(c.id, cols)}
          onPartnerCreated={onPartnerCreated}
          setToast={setToast}
          readOnly={readOnly}
        />
        {/* Reverse direction — leads this client referred. The count is
            the FULL server total (referred_us_total); the rows are the
            capped page. A prolific referrer collapses to the first few
            with a "show all" toggle, and if the total exceeds what the
            route returned we say so honestly. */}
        {(() => {
          const rows = data.referred_us || []
          if (rows.length === 0) return null
          const total = data.referred_us_total ?? rows.length
          const REVERSE_INITIAL = 6
          const shown = showAllReferred ? rows : rows.slice(0, REVERSE_INITIAL)
          const hiddenLocal = rows.length - shown.length
          const beyondCeiling = total - rows.length // referrals past the fetch cap
          return (
            <div style={{ marginTop: '2px' }}>
              <p style={{ fontSize: '11px', fontWeight: 500, color: T.ink.muted, letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '3px' }}>
                Referred us · {total}
              </p>
              {shown.map(r => (
                <p key={r.id} style={{ fontSize: '12px', color: T.ink.primary }}>{r.name}</p>
              ))}
              {hiddenLocal > 0 && (
                <button type="button" onClick={() => setShowAllReferred(true)}
                  style={{ border: 'none', background: 'transparent', padding: '2px 0 0', font: 'inherit', fontSize: '12px', cursor: 'pointer', color: T.ink.muted, borderBottom: T.border.underline }}>
                  Show {hiddenLocal} more
                </button>
              )}
              {showAllReferred && beyondCeiling > 0 && (
                <p style={{ fontSize: '11px', color: T.ink.quiet, marginTop: '3px' }}>
                  Showing first {rows.length} of {total}
                </p>
              )}
            </div>
          )
        })()}
      </div>

      {/* Secondary contacts — full CRUD (build 3) via the existing
          lead-contacts routes; inline-edit standard. */}
      <ContactsBlock
        leadId={c.id}
        contacts={data.contacts || []}
        onChange={next => setData(d => d ? { ...d, contacts: next } : d)}
        setToast={setToast}
        readOnly={readOnly}
      />

      {/* Tags — live popover (build 3): lead_tags junction writes over
          admin-managed client_tags lookups; × removes. */}
      <TagsRow
        leadId={c.id}
        tags={tags}
        options={lookupOptions.clientTags || []}
        onChange={next => setData(d => d ? { ...d, tags: next } : d)}
        setToast={setToast}
        readOnly={readOnly}
      />

      {/* Assigned-to moved to the ENGAGEMENT (engagement-assigned-to-multi
          build): assignment is a deal concept now, plural + Jobber-mapped,
          and lives on the EngagementPanel masthead. leads.assigned_to is
          legacy-unused. The lead-level row here was removed. */}

      {/* Preferences — LIVE toggles (build 3): marketing opt-out
          (confirmed), snooze set/unset, drip pause/activate; the
          nurture-drip row hides with live business (v4 rule). */}
      <PreferencesBlock
        client={c}
        openCount={open.length}
        nowMs={nowMs}
        onPatched={cols => {
          setData(d => d ? { ...d, client: { ...d.client, ...cols } } : d)
          onLeadPatched(c.id, cols)
        }}
        setToast={setToast}
        readOnly={readOnly}
      />
    </div>
  )

  // RIGHT column — the business: buzz, request details (pre-Jobber),
  // engagements, activity.
  const rightCol = c && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0 }}>
      {/* Pinned buzz — the client's standing note; the panel's masthead
          links here (View profile) rather than duplicating it. */}
      <PinnedBuzz notes={buzz} onPost={addBuzzNote} emptyLabel="Add a note about this client" nowMs={nowMs} readOnly={readOnly} />

      {/* Request details — pre-Jobber people whose request hasn't founded
          an engagement yet (the SAME field the Inbox edits and
          foundEngagement seeds from). */}
      {!jobberLinked && (
        <div>
          <MicroLabel>Request details</MicroLabel>
          <EditableDesc text={c.request_details} showEmpty onSave={saveReqDetails} readOnly={readOnly} />
        </div>
      )}

      {/* Engagements */}
      <div>
        <MicroLabel>Engagements · {agg?.total_count ?? engagements.length} · {agg?.open_count ?? open.length} open</MicroLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {open.map(e => {
            const chip = deriveStatusChip(e, { nowMs })
            const StageIcon = STAGE_ICON[e.stage] || IconInbox
            const value = engagementValue(e)
            const statusColor = chip ? (CHIP_STYLES[chip.styleKey] || CHIP_STYLES.gray).text : T.ink.muted
            return (
              <div key={e.id} onClick={() => onOpenEngagement(e)}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: T.surface.raised, border: T.border.divider, borderRadius: T.radius.control, cursor: 'pointer' }}>
                <span style={{ color: (CHIP_STYLES[e.stage] || CHIP_STYLES.gray).text, display: 'inline-flex', flexShrink: 0 }}><StageIcon size={15} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary, fontVariantNumeric: T.type.tabular, letterSpacing: T.type.trackTitle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayTitle(e)}{value != null ? ` · ${fmtMoney(value)}` : ''}
                  </p>
                  {(e.description || '').trim() && (
                    <p style={{ fontSize: '11px', color: T.ink.muted, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.description.trim().split('\n')[0]}
                    </p>
                  )}
                  {chip && <p style={{ fontSize: '11px', fontWeight: 500, color: statusColor, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chip.label}</p>}
                </div>
                <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  {/* repeat/new — first-ever engagement chips New while
                      fresh; everything after chips Repeat (v4). */}
                  {engChip(e) && <StatusChip label={engChip(e).label} styleKey={engChip(e).styleKey} />}
                  <StatusChip label={stageDisplayLabel(e.stage)} styleKey={e.stage} />
                </span>
              </div>
            )
          })}
          {open.length === 0 && (
            <div style={{ padding: '14px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px', border: T.border.dashedSoft, borderRadius: T.radius.control }}>
              No open engagements
            </div>
          )}
          {closedVisible.map(e => {
            const won = e.stage === 'Closed Won'
            const money = Number(e.total_paid) > 0 ? e.total_paid : e.total_invoiced
            // Closed reason rides the row (card-restore build 1 — fetched
            // all along, never rendered); 'won' as a reason is redundant
            // beside the won/lost word, so it stays suppressed.
            const reason = e.closed_reason === 'won' ? null : closedReasonLabel(e.closed_reason)
            const note = (e.closed_note || '').trim()
            return (
              <div key={e.id} onClick={() => onOpenEngagement(e)}
                style={{ display: 'flex', flexDirection: 'column', gap: '1px', padding: '5px 12px', cursor: 'pointer', opacity: 0.65 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <span style={{ color: won ? T.state.success.fg : T.ink.quiet, display: 'inline-flex', flexShrink: 0 }}>
                    {won ? <IconCheck size={12} /> : <IconX size={12} />}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: '11px', color: T.ink.secondary, fontVariantNumeric: T.type.tabular, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayTitle(e)}{Number(money) > 0 ? ` · ${fmtMoney(money)}` : ''} · {won ? 'won' : 'lost'} {monthYear(e.closed_at) || ''}{reason ? ` · ${reason}` : ''}
                  </span>
                  {/* Reopen (resurrect) — Closed LOST only; re-derives the
                      open stage server-side. Closed Won is out of scope. */}
                  {!won && !readOnly && (
                    <button onClick={(ev) => reopenEngagement(e.id, ev)} disabled={busy} aria-label="Reopen engagement"
                      style={{ flexShrink: 0, border: T.border.control, background: T.surface.raised, borderRadius: T.radius.control, padding: '2px 8px', fontSize: '11px', fontWeight: 500, color: T.ink.secondary, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                      Reopen
                    </button>
                  )}
                </span>
                {note && (
                  <span style={{ fontSize: '11px', fontStyle: 'italic', color: T.ink.muted, paddingLeft: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    “{note}”
                  </span>
                )}
              </div>
            )
          })}
          {closed.length > 2 && !showClosed && (
            <button onClick={() => setShowClosed(true)} style={{ border: 'none', background: 'transparent', padding: '2px 12px', textAlign: 'left', fontSize: '11px', color: T.ink.muted, cursor: 'pointer', fontFamily: 'inherit' }}>
              Show {closed.length - 2} more closed
            </button>
          )}
        </div>
      </div>

      {/* Recent activity — client-wide quick-glance slice + composer;
          the exhaustive merged stream is the Timeline tab. */}
      <NotesStream label="Recent activity" items={stream} onPost={addNote} nowMs={nowMs} readOnly={readOnly} />
    </div>
  )

  // Overview = the two-column grid (stacks under ~700px — the media
  // query rides the body's <style> tag; inline styles can't).
  const overview = c && (
    <div className="bee-card-cols">
      {leftCol}
      {rightCol}
    </div>
  )

  // Action bar — PINNED (sticky) to the card bottom, visible from every
  // tab: Call (primary) · Log touchpoint · Open in Jobber (Send to
  // Jobber pre-link) · + New engagement.
  const actionBar = c && (
    <div style={{
      position: 'sticky', bottom: 0, zIndex: 5, background: T.surface.raised,
      borderTop: T.border.divider,
      margin: isMobile ? '0 -16px' : '0 -24px',
      padding: isMobile ? '10px 16px calc(10px + env(safe-area-inset-bottom, 0px))' : '12px 24px',
    }}>
      <ActionRow>
        {c.phone && (
          <a href={`tel:${c.phone}`} style={actionBtn('accent')}>
            <IconPhone size={14} /> Call
          </a>
        )}
        {!readOnly && (
          <button style={actionBtn('gray')} disabled={busy} onClick={() => setTouchOpen(v => !v)}>
            Log touchpoint
          </button>
        )}
        {jobberLinked ? (
          jobberHref ? (
            <a href={jobberHref} target="_blank" rel="noreferrer" style={actionBtn('gray')}>
              <IconExternalLink size={14} /> Open in Jobber
            </a>
          ) : (
            <span title="No Jobber record link available" style={{ ...actionBtn('gray'), color: T.ink.faint, cursor: 'default' }}>
              <IconExternalLink size={14} /> Open in Jobber
            </span>
          )
        ) : (
          !readOnly && onSendToJobber && (
            <button style={actionBtn('accent')} disabled={busy} onClick={() => onSendToJobber(c.id)}>
              <IconSend size={14} /> Send to Jobber
            </button>
          )
        )}
        {!readOnly && (
          <button style={actionBtn('gray')} disabled={busy} onClick={newEngagement}>
            <IconPlus size={14} /> New engagement
          </button>
        )}
      </ActionRow>
      {touchOpen && !readOnly && (
        <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <select value={touchMethod} onChange={e => setTouchMethod(e.target.value)}
            style={{ padding: '8px 10px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', background: T.surface.raised }}>
            <option value="call">Call</option>
            <option value="sms">Text</option>
            <option value="email">Email</option>
            <option value="in_person">In person</option>
          </select>
          <input value={touchNote} onChange={e => setTouchNote(e.target.value)} placeholder="Notes (optional)…"
            onKeyDown={e => { if (e.key === 'Enter') logTouchpoint() }}
            style={{ flex: 1, minWidth: '140px', padding: '8px 12px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
          <button style={{ ...quietBtn(), minHeight: 0 }} disabled={busy} onClick={logTouchpoint}>Log</button>
        </div>
      )}
    </div>
  )

  const filesTab = (
    <div style={{ padding: '18px 12px', border: T.border.dashed, borderRadius: T.radius.control, textAlign: 'center' }}>
      <p style={{ fontSize: '12px', color: T.ink.quiet, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
        <IconPaperclip size={14} /> No files yet — quotes, photos, and attachments will land here
      </p>
    </div>
  )

  // Quick-glance timeline volume from data already in hand (touches +
  // job notes) — the Timeline tab's own fetch stays lazy.
  const timelineCount = touches.length + jobNotes.length

  const body = c && (
    <div style={{ padding: isMobile ? '0 16px 0' : '0 24px 0', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <style>{`
        .bee-contact-link:hover { text-decoration: underline !important; text-underline-offset: 2px }
        .bee-card-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 22px; align-items: start; }
        @media (max-width: 700px) { .bee-card-cols { grid-template-columns: 1fr; } }
      `}</style>

      {/* Header — avatar + name + status chip; v4 subtitle: location ·
          client since Mon YYYY · Jobber ↗ (the Build-1 client link).
          Prev/next chevrons only when the opener passed an ordering. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <InitialsAvatar name={c.name} bg={fam.bg} text={fam.text} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '19px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle, display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            {statusMeta && <StatusChip label={statusMeta.label} styleKey={statusMeta.styleKey} />}
          </p>
          <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.location_name ? `${c.location_name} · ` : ''}client since {monthYear(c.created_at) || '—'}
            {jobberHref && (
              <>
                {' · '}
                <a className="bee-contact-link" href={jobberHref} target="_blank" rel="noreferrer"
                  style={{ color: T.accent.fg, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                  Jobber <IconExternalLink size={11} />
                </a>
              </>
            )}
          </p>
        </div>
        {siblings && siblings.length > 1 && (
          <span style={{ display: 'inline-flex', gap: '2px', flexShrink: 0 }}>
            <button aria-label="Previous client" disabled={!prevId} onClick={() => prevId && onNavigate(prevId)}
              style={{ width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: prevId ? T.ink.secondary : T.ink.disabled, cursor: prevId ? 'pointer' : 'default', padding: 0 }}>
              <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><IconChevronRight size={16} /></span>
            </button>
            <button aria-label="Next client" disabled={!nextId} onClick={() => nextId && onNavigate(nextId)}
              style={{ width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: nextId ? T.ink.secondary : T.ink.disabled, cursor: nextId ? 'pointer' : 'default', padding: 0 }}>
              <IconChevronRight size={16} />
            </button>
          </span>
        )}
        {/* Jobber-owns-deletion rule (Kevin 7/10): linked records are
            never junkable here — Jobber's *_DESTROY webhooks are their
            only deletion path. CardMenu renders nothing on empty items. */}
        <CardMenu items={(jobberLinked || readOnly) ? [] : [{ key: 'junk', label: 'Mark as junk', danger: true, onPick: markJunk }]} />
      </div>

      {/* Metric band — full-bleed money row (v4): Collected / Invoiced /
          Owing / Last touch. Owing spans ALL engagements incl. closed
          (route aggregate — the closed-debt drift fix); accent when owed. */}
      <MetricBand bleed={isMobile ? 16 : 24} cells={[
        { label: 'Collected', value: (agg?.lifetime_paid || 0) > 0 ? fmtMoney(agg.lifetime_paid) : null },
        { label: 'Invoiced', value: (agg?.invoiced || 0) > 0 ? fmtMoney(agg.invoiced) : null },
        { label: 'Owing', value: (agg?.owing || 0) > 0 ? fmtMoney(agg.owing) : null, color: T.accent.fg },
        { label: 'Last touch', value: lastTouchTs ? vitalsAge(lastTouchTs, nowMs) : null },
      ]} />

      <CardTabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'timeline', label: 'Timeline', count: timelineCount },
          { key: 'files', label: 'Files', count: 0 },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ paddingBottom: '10px' }}>
        {tab === 'overview' && overview}
        {tab === 'timeline' && (
          <Timeline
            leadId={c.id}
            locationUuid={c.location_uuid}
            setToast={setToast}
            onLeadPatched={onLeadPatched}
            readOnly={readOnly}
          />
        )}
        {tab === 'files' && filesTab}
      </div>

      {actionBar}
    </div>
  )

  const loading = !data && !loadErr && (
    <div style={{ padding: '40px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px' }}>Loading…</div>
  )
  const errBlock = loadErr && (
    <p style={{ margin: '0 24px 24px', fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 12px', borderRadius: T.radius.control }}>
      Couldn’t load client: {loadErr}
    </p>
  )

  return <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={840}>{loading}{errBlock}{body}</OverlayShell>
}
