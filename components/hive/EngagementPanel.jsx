// components/hive/EngagementPanel.jsx
// ─────────────────────────────────────────────────────────────
// The ONE-DEAL work card — the board's click-through. Tabbed layout
// (approved): compact header, Option B hierarchy — the CLIENT NAME is
// the headline (the primary fact; the ONE place the name renders) +
// stage chip + ··· menu, with a quiet subtitle underneath ('View
// profile' accent link → onOpenClient, then 'opened {full date} ·
// founded by {…}'). The auto-generated engagement title is NOT
// rendered (noise — the date lives in the subtitle). → VITALS STRIP
// (Stage / Value / Last touch / Next — the four-cell deal-health row,
// visible on every tab, compact dates) → tabs (Overview / Timeline /
// Files) → content. Fetches
// GET /api/engagements/:id on open (board rows stay lightweight;
// `seed` renders the shell synchronously).
//
// The strip REPLACED the Overview's standalone 5-segment stage bar and
// the money-tiles row (both redundant with it). Invoiced/paid detail
// moved onto the invoice record row ('$X of $Y paid'); owing keeps its
// red trailing state there — no financial info lost.
//
// Overview: pinned buzz (INHERITED from the client — the same
// lead_notes kind='buzz' rows ClientProfile shows) → key facts
// (tappable phone/email, Source MetaSelect [LEAD-level write], Type
// MetaSelect [ENGAGEMENT-level write], shared ReferrerField — the
// client NAME moved up to the header) → job description
// (engagements.description) → Jobber records checklist (status view —
// the chronological version lives in the Timeline tab) →
// engagement-scoped recent activity + composer → soft-tinted equal-grid
// actions (Call / Log / Send to Jobber / Open in Jobber — cardKit
// ActionRow). Close lives in the ··· menu → the same inline Won/Lost
// confirm as before (Won gated on settled invoices).
//
// NO manual stage mover (decision 2026-07-10, Kevin): all business
// flows through Jobber — a local engagement's stage assertion is
// always fiction, so pipeline stages move ONLY via the Jobber
// derivation (webhooks / import / drift recovery). The Advance button
// was removed 7/10; the only human stage write left is the terminal
// Close (won/lost) via the ··· menu.
//
// Desktop: centered modal. Mobile: bottom sheet. Beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import useIsMobile from './shared/useIsMobile'
import { isTerminal, stageDisplayLabel, ACCENT_BLUE, CHIP_STYLES } from './shared/stageConfig'
import StatusChip from '@/components/ui/StatusChip'
import { IconInbox, IconFileText, IconHammer, IconFileInvoice, IconCheck, IconPhone, IconMail, IconExternalLink, IconCalendar, IconSend, IconPaperclip } from '@/components/ui/icons'
import VitalsStrip, { vitalsAge, vitalsFuture, nextFromChildren } from './shared/VitalsStrip'
import NotesStream from './NotesStream'
import OverlayShell from './OverlayShell'
import MetaSelect from './MetaSelect'
import ReferrerField from './shared/ReferrerField'
import Timeline from './shared/Timeline'
import CardTabs from './shared/CardTabs'
import PinnedBuzz from './shared/PinnedBuzz'
import InitialsAvatar from './shared/InitialsAvatar'
import { MicroLabel, quietBtn, CardMenu, ActionRow, actionBtn } from './shared/cardKit'
import CloseEngagementConfirm from './shared/CloseEngagementConfirm'
import { fmtTime, engagementValue, formatFullDate } from './shared/engagementStatus'

const fmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()
const fmtDate = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Quiet light surface used by the description + key-facts cards (mockup).
const QUIET = '#f7f6f4'
// Record-state palette (mockup-exact): green done / blue in-motion.
const BAR_DONE = '#1D9E75'
const BAR_CURRENT = '#378ADD'

// One RECORDS checklist row (mockup anatomy): leading family-colored
// glyph, primary 13px, secondary 11px muted, trailing state — green ✓
// done / colored status word (scheduled-date in accent) otherwise.
function RecordRow({ icon, iconColor, primary, secondary, state, current }) {
  return (
    <div style={{
      padding: '10px 12px', background: '#fff',
      border: `0.5px solid ${current ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.08)'}`,
      borderRadius: '8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '13px', flexShrink: 0, width: '18px', textAlign: 'center', color: iconColor, lineHeight: 1 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{primary}</p>
          {secondary && <p style={{ fontSize: '11px', color: '#8a8a84', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{secondary}</p>}
        </div>
        {state && (
          <span style={{ flexShrink: 0, fontSize: state.check ? '14px' : '12px', fontWeight: 500, color: state.color, whiteSpace: 'nowrap' }}>
            {state.check ? <IconCheck size={14} /> : state.label}
          </span>
        )}
      </div>
    </div>
  )
}

export default function EngagementPanel({ engagementId, seed = null, people = [], onClose, onOpenClient = () => {}, onChanged = () => {}, onLeadPatched = () => {}, onPartnerCreated = () => {}, onSendToJobber = null, setToast = () => {}, lookupOptions = { sources: [], projectTypes: [] } }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [tab, setTab] = useState('overview')
  const [descEditing, setDescEditing] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const [descExpanded, setDescExpanded] = useState(false)
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchMethod, setTouchMethod] = useState('call')
  const [touchNote, setTouchNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const nowMs = Date.now()

  const isMobile = useIsMobile()

  useEffect(() => {
    let dead = false
    setData(null); setLoadErr(null)
    fetch(`/api/engagements/${engagementId}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(d => {
        if (dead) return
        setData(d)
        // The GET route drift-recovers linked engagements on open (a
        // swallowed webhook failure can leave stage stale) — when the
        // stage it returns differs from the board row we opened from,
        // push the correction back so the board doesn't stay stale.
        if (seed?.stage && d?.engagement?.stage && d.engagement.stage !== seed.stage) {
          onChanged(engagementId, { stage: d.engagement.stage })
        }
      })
      .catch(e => { if (!dead) setLoadErr(String(e.message || e)) })
    return () => { dead = true }
  }, [engagementId])

  const eng = data?.engagement ?? seed
  const children = data?.children ?? { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] }
  const client = data?.client ?? null

  async function patchEngagement(body, okMsg) {
    setBusy(true)
    try {
      const res = await fetch(`/api/engagements/${engagementId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, engagement: { ...d.engagement, ...(body.title ? { title: j.title } : {}), ...(body.stage ? { stage: j.stage } : {}), ...(body.description !== undefined ? { description: j.description ?? null } : {}), ...(body.project_type !== undefined ? { project_type: j.project_type ?? null } : {}) } } : d)
      onChanged(engagementId, { ...(body.title ? { title: j.title } : {}), ...(body.stage ? { stage: j.stage } : {}) })
      if (okMsg) setToast({ kind: 'success', msg: okMsg })
      return true
    } catch (e) {
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
      return false
    } finally {
      setBusy(false)
    }
  }

  // Source is LEAD-level (marketing attribution belongs to the person's
  // arrival) — saves through the lead PATCH, not the engagement's.
  // label may be null — None clears the field.
  async function saveSource(label) {
    if (!client) return
    const prev = client.source ?? null
    setData(d => d ? { ...d, client: { ...d.client, source: label } } : d)
    try {
      const res = await fetch(`/api/leads/${client.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: label }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      // Propagate to the shell's people state — the Inbox row / filters
      // read the lead's source from there.
      onLeadPatched(client.id, { source: label })
    } catch (e) {
      setData(d => d ? { ...d, client: { ...d.client, source: prev } } : d)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    }
  }

  async function saveDescription() {
    const t = descDraft.trim().slice(0, 2000)
    setDescEditing(false)
    if (t === (eng?.description || '').trim()) return
    await patchEngagement({ description: t })
  }

  // Client-level buzz — posted from the pinned band (append-only; the
  // band owns the draft, we own the notes array + optimistic prepend).
  // Same rows ClientProfile shows: buzz is the CLIENT's standing note.
  async function addBuzz(text) {
    if (!text || !client) return
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: client.id, kind: 'buzz', text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, client: { ...d.client, buzz: [j.note, ...(d.client.buzz || [])] } } : d)
    } catch (e) {
      setToast({ kind: 'error', msg: `Buzz failed: ${e.message}` })
    }
  }

  // Engagement note (kind='job', anchored to THIS engagement) — posted
  // from the shared NotesStream composer.
  async function addEngagementNote(text) {
    if (!text || !client) return
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: client.id, kind: 'job', text, engagement_id: engagementId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, children: { ...d.children, notes: [j.note, ...(d.children.notes || [])] } } : d)
    } catch (e) {
      setToast({ kind: 'error', msg: `Note failed: ${e.message}` })
    }
  }

  async function logTouchpoint() {
    if (!client) return
    setBusy(true)
    try {
      const res = await fetch('/api/touchpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: client.id,
          kind: 'reach_out',
          label: 'Reach-out',
          method: touchMethod,
          notes: touchNote.trim() || null,
          engagement_id: engagementId,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setTouchNote(''); setTouchOpen(false)
      if (j.touchpoint) {
        setData(d => d ? { ...d, children: { ...d.children, touchpoints: [{ ...j.touchpoint, user_label: 'You' }, ...(d.children.touchpoints || [])] } } : d)
      }
      setToast({ kind: 'success', msg: 'Touchpoint logged' })
    } catch (e) {
      setToast({ kind: 'error', msg: `Touchpoint failed: ${e.message}` })
    } finally { setBusy(false) }
  }

  // Job description — the engagement's own editable field.
  const descBlock = () => {
    if (!eng) return null
    if (descEditing) {
      return (
        <textarea
          autoFocus
          value={descDraft}
          onChange={e => setDescDraft(e.target.value)}
          onBlur={saveDescription}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveDescription()
            if (e.key === 'Escape') setDescEditing(false)
          }}
          rows={3}
          maxLength={2000}
          placeholder="Describe the work…"
          style={{ width: '100%', padding: '8px 10px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '6px', fontSize: '12px', lineHeight: 1.45, color: '#1a1a18', fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}
        />
      )
    }
    const text = (eng.description || '').trim()
    if (!text) {
      return (
        <button onClick={() => { setDescDraft(''); setDescEditing(true) }}
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: '0.5px dashed rgba(0,0,0,0.15)', borderRadius: '6px', background: 'transparent', fontSize: '12px', color: '#b5b3ac', cursor: 'text', fontFamily: 'inherit' }}>
          Add a description…
        </button>
      )
    }
    const clampLikely = text.length > 120 || text.includes('\n')
    return (
      <div onClick={() => { setDescDraft(eng.description || ''); setDescEditing(true) }}
        title="Click to edit description"
        style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', cursor: 'text', background: QUIET, borderRadius: '6px', padding: '8px 10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontSize: '12px', fontStyle: 'italic', color: '#6b6b66', lineHeight: 1.45, whiteSpace: 'pre-wrap',
            ...(descExpanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
          }}>
            {text}
          </p>
          {clampLikely && !descExpanded && (
            <button onClick={(e) => { e.stopPropagation(); setDescExpanded(true) }}
              style={{ border: 'none', background: 'transparent', padding: 0, marginTop: '2px', fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
              Show more
            </button>
          )}
        </div>
        <span style={{ fontSize: '11px', color: '#c9c7c0', flexShrink: 0 }}>✎</span>
      </div>
    )
  }

  // Engagement-SCOPED recent slice: this engagement's notes + touches.
  const activity = [
    ...(children.notes || []).map(n => ({ t: 'note', ts: n.created_at, ...n })),
    ...(children.touchpoints || []).map(tp => ({ t: 'touch', ts: tp.occurred_at, ...tp })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 8)

  // Deep link: latest job → quote → request (whatever Jobber has).
  const jobberHref = (() => {
    const jobs = children.jobs, quotes = children.quotes, srs = children.service_requests
    return jobs[jobs.length - 1]?.job_url || quotes[quotes.length - 1]?.quote_url || srs[srs.length - 1]?.request_url || null
  })()

  // Founded-but-not-sent (the decoupled-founding case): NO work records
  // at all → Send to Jobber, carrying engagementId so the request
  // attaches HERE (never a second engagement / second lead).
  const canSendToJobber = !!onSendToJobber && !!data && eng && !isTerminal(eng.stage) &&
    children.service_requests.length === 0 && children.quotes.length === 0 &&
    children.jobs.length === 0 && children.invoices.length === 0 &&
    (children.assessments || []).length === 0

  const currentType = eng
    ? (eng.stage === 'Request' ? 'request' : eng.stage === 'Estimate' ? 'quote' : eng.stage === 'Job in Progress' ? 'job' : 'invoice')
    : null

  // Trailing state per row: green ✓ done, scheduled-date/status word in
  // accent when in motion, red when money owed.
  const DONE = { check: true, color: BAR_DONE }
  const quoteState = (q) =>
    q.status === 'approved' ? DONE
    : q.status === 'changes_requested' ? { label: 'changes requested', color: '#633806' }
    : q.status === 'archived' ? { label: 'archived', color: '#8a8a84' }
    : { label: 'sent', color: BAR_CURRENT }
  const jobState = (j) =>
    (j.completed_at || (j.status || '').includes('complet')) ? DONE
    : j.scheduled_start ? { label: fmtDate(j.scheduled_start), color: BAR_CURRENT }
    : { label: (j.status && j.status !== 'unknown' ? j.status.replace('_', ' ') : 'upcoming'), color: BAR_CURRENT }
  const invoiceState = (i) =>
    i.status === 'paid' ? DONE
    : { label: `owing ${fmtMoney(i.balance_owing != null ? i.balance_owing : i.total)}`, color: '#791F1F' }

  // Vitals-strip inputs — everything already fetched, no new queries.
  // Value: total_invoiced once real, best quote before that, null → '—'.
  // Last touch: most recent touchpoint. Next: soonest future assessment
  // or job start among THIS engagement's children (lead-level drip
  // projections stay with the Timeline tab's own fetch).
  const stripValue = eng ? engagementValue({ ...eng, quotes: children.quotes }) : null
  const lastTouchTs = (children.touchpoints || [])
    .reduce((m, t) => Math.max(m, new Date(t.occurred_at).getTime() || 0), 0) || null
  const nextTs = nextFromChildren(children, nowMs)

  // Close-out (doc §4): the trigger lives in the ··· menu; the SHARED
  // human close flow (shared/CloseEngagementConfirm — same component +
  // write path as the board's drag-to-close) renders inline on
  // Overview, never a second modal.
  const closeConfirm = closeOpen && eng && (
    <CloseEngagementConfirm
      engagementId={engagementId}
      invoices={children.invoices || []}
      onCancel={() => setCloseOpen(false)}
      onClosed={(stage, j) => {
        setCloseOpen(false)
        setData(d => d ? { ...d, engagement: { ...d.engagement, stage: j.stage } } : d)
        onChanged(engagementId, { stage: j.stage })
        setTimeout(onClose, 900)
      }}
      setToast={setToast}
    />
  )

  const overview = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* Pinned buzz — inherited from the CLIENT (same note as the
          profile); every engagement of this client shows it. */}
      {client && <PinnedBuzz notes={client.buzz || []} onPost={addBuzz} emptyLabel="Add a note about this client" nowMs={nowMs} />}

      {closeConfirm}

      {/* Key facts — contact + the shared editable meta (the client
          NAME is the header headline; View profile lives up there). */}
      {client && eng && (
        <div style={{ background: QUIET, borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <MicroLabel>Key facts</MicroLabel>
          {client.phone && (
            <p style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
              <span style={{ color: '#8a8a84', display: 'inline-flex' }}><IconPhone size={13} /></span>
              <a href={`tel:${client.phone}`} style={{ color: ACCENT_BLUE, textDecoration: 'none' }}>{client.phone}</a>
            </p>
          )}
          {client.email && (
            <p style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
              <span style={{ color: '#8a8a84', display: 'inline-flex' }}><IconMail size={13} /></span>
              <a href={`mailto:${client.email}`} style={{ color: ACCENT_BLUE, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{client.email}</a>
            </p>
          )}
          {/* Source rides the LEAD; Type rides THIS engagement (seeded at
              founding). label may be null — None clears. */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <MetaSelect label="Source" value={client?.source || null} options={lookupOptions.sources} onPick={saveSource} />
            <MetaSelect label="Type" value={eng.project_type || null} options={lookupOptions.projectTypes} onPick={(v) => patchEngagement({ project_type: v })} />
          </div>
          {/* Referrer — LEAD-level like Source: PATCHes client.id, never
              an engagement field. */}
          <ReferrerField
            lead={client}
            locationUuid={eng.location_uuid}
            people={people}
            onApply={fields => setData(d => d ? { ...d, client: { ...d.client, ...fields } } : d)}
            onSaved={cols => onLeadPatched(client.id, cols)}
            onPartnerCreated={onPartnerCreated}
            setToast={setToast}
          />
        </div>
      )}

      {/* Job description — engagements.description (⌘-Enter/blur saves) */}
      {eng && data && (
        <div>
          <MicroLabel>Description</MicroLabel>
          {descBlock()}
        </div>
      )}

      {/* Records checklist — STATUS view (✓ / scheduled-date / dashed
          pending); the chronological version is the Timeline tab. */}
      <div>
        <MicroLabel>Records</MicroLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {children.service_requests.map(sr => (
            <RecordRow key={sr.id} icon={<IconInbox size={15} />} iconColor="#085041" current={currentType === 'request'}
              primary={`Request · ${fmtDate(sr.requested_at || sr.created_at) || '—'}`}
              secondary={sr.source ? `source: ${sr.source}` : null}
              state={currentType === 'request' ? { label: 'active', color: BAR_CURRENT } : DONE}
            />
          ))}
          {(children.assessments || []).map(a => {
            const done = !!a.completed_at || a.status === 'completed'
            const future = new Date(a.scheduled_at || 0).getTime() > nowMs
            return (
              <RecordRow key={a.id} icon={<IconCalendar size={15} />} iconColor="#0C447C" current={false}
                primary={`Assessment · ${[fmtDate(a.scheduled_at), fmtTime(a.scheduled_at)].filter(Boolean).join(', ') || '—'}`}
                secondary={done && a.completed_at ? `completed ${fmtDate(a.completed_at)}` : null}
                state={done ? DONE : { label: 'Scheduled', color: future ? BAR_CURRENT : '#8a8a84' }}
              />
            )
          })}
          {children.quotes.map(q => (
            <RecordRow key={q.id} icon={<IconFileText size={15} />} iconColor="#0C447C" current={currentType === 'quote'}
              primary={`Quote · ${fmtMoney(q.total)}`}
              secondary={[q.sent_at && `sent ${fmtDate(q.sent_at)}`, q.approved_at && `approved ${fmtDate(q.approved_at)}`].filter(Boolean).join(' · ') || null}
              state={quoteState(q)}
            />
          ))}
          {children.jobs.map(j => (
            <RecordRow key={j.id} icon={<IconHammer size={15} />} iconColor="#0C447C" current={currentType === 'job'}
              primary={`Job · ${j.title || 'Untitled'}${j.total != null ? ` · ${fmtMoney(j.total)}` : ''}`}
              secondary={[j.scheduled_start && `scheduled ${fmtDate(j.scheduled_start)}`, j.completed_at && `completed ${fmtDate(j.completed_at)}`].filter(Boolean).join(' · ') || null}
              state={jobState(j)}
            />
          ))}
          {/* '$X of $Y paid' rides the invoice row — the strip carries no
              paid column, so this is where the paid detail lives now. */}
          {children.invoices.map(inv => (
            <RecordRow key={inv.id} icon={<IconFileInvoice size={15} />} iconColor="#791F1F" current={currentType === 'invoice'}
              primary={`Invoice · ${fmtMoney(inv.total)}`}
              secondary={[
                `${fmtMoney(inv.paid_amount != null ? inv.paid_amount : Math.max(0, (Number(inv.total) || 0) - (Number(inv.balance_owing) || 0)))} of ${fmtMoney(inv.total)} paid`,
                inv.issued_at && `issued ${fmtDate(inv.issued_at)}`,
                inv.paid_at && `paid ${fmtDate(inv.paid_at)}`,
              ].filter(Boolean).join(' · ')}
              state={invoiceState(inv)}
            />
          ))}
          {children.jobs.length > 0 && children.invoices.length === 0 && (
            <div style={{ padding: '10px 12px', border: '0.5px dashed rgba(0,0,0,0.18)', borderRadius: '8px', fontSize: '11px', color: '#b5b3ac' }}>
              <IconFileInvoice size={13} style={{ marginRight: '6px', verticalAlign: '-2px' }} /> Invoice — created in Jobber when the job completes
            </div>
          )}
          {!data && !loadErr && (
            <div style={{ padding: '14px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>Loading…</div>
          )}
        </div>
      </div>

      {/* Recent activity — engagement-scoped quick-glance slice +
          composer; the merged past/future stream is the Timeline tab. */}
      <NotesStream label="Recent activity" items={activity} onPost={addEngagementNote} nowMs={nowMs} />

      {/* Actions — soft-tinted equal-width grid (cardKit ActionRow;
          the repeat(N,1fr) grid counts rendered children). NO manual
          stage mover here (7/10 decision, Kevin): stages move ONLY via
          Jobber derivation — Send to Jobber is the forward door for
          local engagements. Close lives in the ··· menu for BOTH
          (inline confirm above — there is no Jobber auto-Lost, so the
          manual close path must always exist). */}
      <div>
        <ActionRow>
          {client?.phone && (
            <a href={`tel:${client.phone}`} style={actionBtn('blue')}>
              <IconPhone size={14} /> Call
            </a>
          )}
          <button style={actionBtn('gray')} disabled={busy} onClick={() => setTouchOpen(v => !v)}>
            Log touchpoint
          </button>
          {canSendToJobber && client && (
            <button style={actionBtn('green')} disabled={busy} onClick={() => onSendToJobber(client.id, { engagementId })}>
              <IconSend size={14} /> Send to Jobber
            </button>
          )}
          {jobberHref && (
            <a href={jobberHref} target="_blank" rel="noreferrer" style={actionBtn('gray')}>
              <IconExternalLink size={14} /> Open in Jobber
            </a>
          )}
        </ActionRow>
        {touchOpen && (
          <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <select value={touchMethod} onChange={e => setTouchMethod(e.target.value)}
              style={{ padding: '8px 10px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', background: '#fff' }}>
              <option value="call">Call</option>
              <option value="sms">Text</option>
              <option value="email">Email</option>
              <option value="in_person">In person</option>
            </select>
            <input value={touchNote} onChange={e => setTouchNote(e.target.value)} placeholder="Notes (optional)…"
              onKeyDown={e => { if (e.key === 'Enter') logTouchpoint() }}
              style={{ flex: 1, minWidth: '140px', padding: '8px 12px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
            <button style={{ ...quietBtn(), minHeight: 0 }} disabled={busy} onClick={logTouchpoint}>Log</button>
          </div>
        )}
      </div>
    </div>
  )

  const filesTab = (
    <div style={{ padding: '18px 12px', border: '0.5px dashed rgba(0,0,0,0.15)', borderRadius: '8px', textAlign: 'center' }}>
      <p style={{ fontSize: '12px', color: '#b5b3ac', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
        <IconPaperclip size={14} /> No files yet — quotes, photos, and attachments will land here
      </p>
    </div>
  )

  const menuItems = eng && !isTerminal(eng.stage)
    ? [{ key: 'close', label: 'Close engagement…', danger: true, onPick: () => { setTab('overview'); setCloseOpen(true) } }]
    : []

  const stageFam = eng ? (CHIP_STYLES[eng.stage] || CHIP_STYLES.gray) : CHIP_STYLES.gray

  const body = (
    <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {loadErr && (
        <p style={{ fontSize: '12px', color: '#791F1F', background: '#FCEBEB', padding: '8px 12px', borderRadius: '8px' }}>
          Couldn’t load engagement: {loadErr}
        </p>
      )}

      {/* Header (Option B) — the CLIENT NAME is the headline (whose
          deal this is — the primary fact, the ONE place the name
          renders) + stage chip + ···; the auto-generated engagement
          title is NOT rendered. Quiet subtitle: 'View profile' accent
          link (same onOpenClient swap as the old View client →) +
          full-format opened date + founded-by. */}
      {eng && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <InitialsAvatar name={client?.name || eng.client_name || '?'} bg={stageFam.bg} text={stageFam.text} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2 style={{ flex: 1, minWidth: 0, fontSize: '19px', fontWeight: 600, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {client?.name || eng.client_name || 'Client'}
              </h2>
              <span style={{ flexShrink: 0 }}>
                <StatusChip label={stageDisplayLabel(eng.stage)} styleKey={eng.stage} />
              </span>
            </div>
            <p style={{ fontSize: '12px', color: '#8a8a84', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {client && (
                <>
                  <button onClick={() => onOpenClient(client.id)}
                    style={{ border: 'none', background: 'transparent', fontSize: '12px', fontWeight: 500, color: ACCENT_BLUE, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', padding: 0 }}>
                    View profile
                  </button>
                  {' · '}
                </>
              )}
              opened {formatFullDate(eng.created_at) || '—'} · founded by {eng.founded_by}
            </p>
          </div>
          <CardMenu items={menuItems} />
        </div>
      )}

      {/* Vitals strip — the deal-health row; Stage in its status color,
          Next in the accent. Replaces the old stage bar + money tiles. */}
      {eng && (
        <VitalsStrip cells={[
          { label: 'Stage', value: stageDisplayLabel(eng.stage), color: stageFam.text },
          { label: 'Value', value: stripValue != null ? fmtMoney(stripValue) : null },
          { label: 'Last touch', value: lastTouchTs ? vitalsAge(lastTouchTs, nowMs) : null },
          { label: 'Next', value: nextTs ? vitalsFuture(nextTs, nowMs) : null, color: ACCENT_BLUE },
        ]} />
      )}

      <CardTabs
        tabs={[{ key: 'overview', label: 'Overview' }, { key: 'timeline', label: 'Timeline' }, { key: 'files', label: 'Files' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && overview}
      {tab === 'timeline' && client && eng && (
        <Timeline
          leadId={client.id}
          engagementId={engagementId}
          locationUuid={eng.location_uuid}
          setToast={setToast}
          onLeadPatched={onLeadPatched}
        />
      )}
      {tab === 'files' && filesTab}
    </div>
  )

  return <OverlayShell isMobile={isMobile} onClose={onClose}>{body}</OverlayShell>
}
