// components/hive/EngagementPanel.jsx
// ─────────────────────────────────────────────────────────────
// The ONE-DEAL work card — the board's click-through. Tabbed layout
// (approved): compact header (stage-tinted avatar + inline-rename title
// + stage chip + subtitle + ··· menu) → tabs (Overview / Timeline /
// Files) → content. Fetches GET /api/engagements/:id on open (board
// rows stay lightweight; `seed` renders the shell synchronously).
//
// Overview: pinned buzz (INHERITED from the client — the same
// lead_notes kind='buzz' rows ClientProfile shows) → stage bar
// (current-state only) → key facts (client + View client →, tappable
// phone/email, Source MetaSelect [LEAD-level write], Type MetaSelect
// [ENGAGEMENT-level write], shared ReferrerField) → job description
// (engagements.description) → adaptive money tiles (Value/Paid until
// invoicing exists, then Value/Invoiced/Paid; Paid red when owing) →
// Jobber records checklist (status view — the chronological version
// lives in the Timeline tab) → engagement-scoped recent activity +
// composer → quiet actions (Call / Log / Jobber / Advance). Close
// lives in the ··· menu → the same inline Won/Lost confirm as before
// (Won gated on settled invoices).
//
// Desktop: centered modal. Mobile: bottom sheet; stage moves happen
// HERE via Advance — the board has no mobile drag. Beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import useIsMobile from './shared/useIsMobile'
import { ENGAGEMENT_STAGES, STAGE_RANK, isTerminal, stageDisplayLabel, ACCENT_BLUE, CHIP_STYLES } from './shared/stageConfig'
import StatusChip from '@/components/ui/StatusChip'
import { IconInbox, IconFileText, IconHammer, IconFileInvoice, IconCheck, IconPhone, IconMail, IconExternalLink, IconCalendar, IconSend, IconPaperclip } from '@/components/ui/icons'
import MetricCard from '@/components/ui/MetricCard'
import NotesStream from './NotesStream'
import OverlayShell from './OverlayShell'
import MetaSelect from './MetaSelect'
import ReferrerField from './shared/ReferrerField'
import Timeline from './shared/Timeline'
import CardTabs from './shared/CardTabs'
import PinnedBuzz from './shared/PinnedBuzz'
import InitialsAvatar from './shared/InitialsAvatar'
import { MicroLabel, quietBtn, CardMenu } from './shared/cardKit'
import { GREEN_TEXT } from '@/components/ui/tokens'
import { fmtTime } from './shared/engagementStatus'

const fmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()
const fmtDate = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Quiet light surface used by the description + money cards (mockup).
const QUIET = '#f7f6f4'
// Stage-bar palette (mockup-exact).
const BAR_DONE = '#1D9E75'
const BAR_CURRENT = '#378ADD'
const BAR_FUTURE = '#ECEAE4'

const BAR_SEGMENTS = [
  { key: 'Request', label: 'Request' },
  { key: 'Estimate', label: 'Estimate' },
  { key: 'Job in Progress', label: 'Job' },
  { key: 'Final Processing', label: 'Final' },
  { key: 'Closed Won', label: 'Won' },
]

// Five equal segments, labels below: completed green w/ muted labels,
// current blue w/ weight-500 dark label, future neutral. Current-state
// only — the history lives in the Timeline tab's stage_change entries.
function StageBar({ stage }) {
  const rank = STAGE_RANK[stage] ?? 0
  const lost = stage === 'Closed Lost'
  return (
    <div>
      <div style={{ display: 'flex', gap: '5px' }}>
        {BAR_SEGMENTS.map((seg) => {
          const segRank = STAGE_RANK[seg.key] ?? 0
          const color = lost ? BAR_FUTURE
            : segRank < rank ? BAR_DONE
            : segRank === rank ? BAR_CURRENT
            : BAR_FUTURE
          return <div key={seg.key} style={{ flex: 1, height: '5px', borderRadius: '2px', background: color }} />
        })}
      </div>
      <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
        {BAR_SEGMENTS.map((seg) => {
          const segRank = STAGE_RANK[seg.key] ?? 0
          const current = !lost && segRank === rank
          return (
            <span key={seg.key} style={{ flex: 1, fontSize: '11px', textAlign: 'center', color: current ? '#1a1a18' : '#b5b3ac', fontWeight: current ? 500 : 400 }}>
              {seg.label}
            </span>
          )
        })}
      </div>
      {lost && <p style={{ fontSize: '11px', color: '#791F1F', marginTop: '4px' }}>Closed lost</p>}
    </div>
  )
}

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
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [descEditing, setDescEditing] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const [descExpanded, setDescExpanded] = useState(false)
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchMethod, setTouchMethod] = useState('call')
  const [touchNote, setTouchNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeAs, setCloseAs] = useState('Closed Lost')
  const [closeReason, setCloseReason] = useState('lost_no_response')
  const [closeNote, setCloseNote] = useState('')
  const nowMs = Date.now()

  const isMobile = useIsMobile()

  useEffect(() => {
    let dead = false
    setData(null); setLoadErr(null)
    fetch(`/api/engagements/${engagementId}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(d => { if (!dead) setData(d) })
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

  async function saveTitle() {
    const t = titleDraft.trim()
    setEditingTitle(false)
    if (!t || t === (eng?.title || '')) return
    await patchEngagement({ title: t })
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

  const nextStage = (() => {
    if (!eng || isTerminal(eng.stage)) return null
    const order = ENGAGEMENT_STAGES.filter(s => s.key !== 'Closed Lost')
    const i = order.findIndex(s => s.key === eng.stage)
    return i >= 0 && i < order.length - 1 ? order[i + 1].key : null
  })()

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

  // Money tiles adapt to financial state: the Invoiced column appears
  // once invoicing exists (estimate-stage shows Value/Paid only).
  const hasInvoicing = children.invoices.length > 0 || Number(eng?.total_invoiced) > 0
  const engValue = eng ? (Number(eng.total_invoiced) > 0 ? eng.total_invoiced : Math.max(0, ...children.quotes.map(q => Number(q.total) || 0))) : 0

  // Close-out (doc §4): the trigger lives in the ··· menu; the inline
  // Won/Lost confirm (never a second modal) renders on Overview.
  const closeConfirm = closeOpen && eng && (() => {
    const invoices = children.invoices || []
    const settled = invoices.length === 0 || invoices.every(i => i.status === 'paid' || Number(i.balance_owing) === 0)
    const confirmClose = async () => {
      const bodyPatch = closeAs === 'Closed Won'
        ? { stage: 'Closed Won', closed_reason: 'won', closed_note: closeNote.trim() || undefined }
        : { stage: 'Closed Lost', closed_reason: closeReason, closed_note: closeNote.trim() || undefined }
      const ok = await patchEngagement(bodyPatch, `Closed as ${closeAs === 'Closed Won' ? 'won' : 'lost'}`)
      if (ok) setTimeout(onClose, 900)
    }
    const segBtn = (key, label, disabled, why) => (
      <button key={key} disabled={disabled} title={disabled ? why : undefined}
        onClick={() => { setCloseAs(key) }}
        style={{ flex: 1, padding: '7px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 500, fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer',
          border: `0.5px solid ${closeAs === key && !disabled ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.12)'}`,
          background: closeAs === key && !disabled ? '#fff' : 'transparent',
          color: disabled ? '#c9c7c0' : (closeAs === key ? '#1a1a18' : '#8a8a84') }}>
        {label}
      </button>
    )
    return (
      <div style={{ padding: '12px', background: '#f7f6f4', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase' }}>Close as</p>
        <div style={{ display: 'flex', gap: '8px' }}>
          {segBtn('Closed Lost', 'Lost', false)}
          {segBtn('Closed Won', 'Won', !settled, 'Invoices still owing — settle them in Jobber first (or close as lost / written off)')}
        </div>
        {closeAs === 'Closed Lost' && (
          <select value={closeReason} onChange={e => setCloseReason(e.target.value)}
            style={{ padding: '8px 10px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', background: '#fff' }}>
            <option value="lost_no_response">No response</option>
            <option value="lost_competitor">Went with someone else</option>
            <option value="lost_not_fit">Not a fit</option>
            <option value="written_off">Written off</option>
            <option value="lost_other">Other</option>
          </select>
        )}
        <input value={closeNote} onChange={e => setCloseNote(e.target.value)} placeholder="Note (optional)…"
          style={{ padding: '8px 10px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none', background: '#fff' }} />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={() => setCloseOpen(false)} disabled={busy}
            style={{ padding: '7px 12px', borderRadius: '8px', border: 'none', background: 'transparent', fontSize: '12px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
            Cancel
          </button>
          <button onClick={confirmClose} disabled={busy || (closeAs === 'Closed Won' && !settled)}
            style={{ padding: '7px 14px', borderRadius: '8px', border: 'none', background: '#1a1a18', color: '#fff', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
            Close as {closeAs === 'Closed Won' ? 'won' : 'lost'}
          </button>
        </div>
      </div>
    )
  })()

  const overview = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* Pinned buzz — inherited from the CLIENT (same note as the
          profile); every engagement of this client shows it. */}
      {client && <PinnedBuzz notes={client.buzz || []} onPost={addBuzz} emptyLabel="Add a note about this client" nowMs={nowMs} />}

      {/* Stage progress — current state only */}
      {eng && <StageBar stage={eng.stage} />}

      {closeConfirm}

      {/* Key facts — client identity + the shared editable meta */}
      {client && eng && (
        <div style={{ background: QUIET, borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <MicroLabel>Key facts</MicroLabel>
          <p style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a18', display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{client.name}</span>
            <button onClick={() => onOpenClient(client.id)} style={{ border: 'none', background: 'transparent', fontSize: '12px', fontWeight: 500, color: ACCENT_BLUE, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', padding: 0, flexShrink: 0 }}>
              View client →
            </button>
          </p>
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

      {/* Money — columns adapt to financial state */}
      {eng && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : (hasInvoicing ? '1fr 1fr 1fr' : '1fr 1fr'), gap: '8px' }}>
          <MetricCard label="Engagement value" value={fmtMoney(engValue)} />
          {hasInvoicing && <MetricCard label="Invoiced" value={fmtMoney(eng.total_invoiced)} />}
          <MetricCard label="Paid" value={fmtMoney(eng.total_paid)} tone={Number(eng.balance_owing) > 0 ? 'red' : 'teal'} />
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
          {children.invoices.map(inv => (
            <RecordRow key={inv.id} icon={<IconFileInvoice size={15} />} iconColor="#791F1F" current={currentType === 'invoice'}
              primary={`Invoice · ${fmtMoney(inv.total)}`}
              secondary={[inv.issued_at && `issued ${fmtDate(inv.issued_at)}`, inv.paid_at && `paid ${fmtDate(inv.paid_at)}`].filter(Boolean).join(' · ') || null}
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

      {/* Quiet actions — hairline row; Advance forward-only; Close lives
          in the ··· menu (inline confirm above). */}
      <div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {client?.phone && (
            <a href={`tel:${client.phone}`} style={quietBtn()}>
              <IconPhone size={14} /> Call
            </a>
          )}
          <button style={quietBtn()} disabled={busy} onClick={() => setTouchOpen(v => !v)}>
            Log touchpoint
          </button>
          {canSendToJobber && client && (
            <button style={quietBtn(GREEN_TEXT)} disabled={busy} onClick={() => onSendToJobber(client.id, { engagementId })}>
              <IconSend size={14} /> Send to Jobber
            </button>
          )}
          {jobberHref && (
            <a href={jobberHref} target="_blank" rel="noreferrer" style={quietBtn()}>
              <IconExternalLink size={14} /> Open in Jobber
            </a>
          )}
          {nextStage && (
            <button style={quietBtn()} disabled={busy}
              onClick={() => patchEngagement({ stage: nextStage }, `Moved to ${stageDisplayLabel(nextStage)}`)}>
              Advance to {stageDisplayLabel(nextStage)} →
            </button>
          )}
        </div>
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

      {/* Header — stage-tinted avatar + inline-rename title + chip +
          founding subtitle + ··· */}
      {eng && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <InitialsAvatar name={client?.name || eng.title || '?'} bg={stageFam.bg} text={stageFam.text} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {editingTitle ? (
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={e => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditingTitle(false) }}
                  style={{ flex: 1, minWidth: 0, fontSize: '16px', fontWeight: 500, color: '#1a1a18', border: 'none', borderBottom: '1px solid rgba(0,0,0,0.2)', outline: 'none', fontFamily: 'inherit', background: 'transparent', padding: '0 0 2px' }}
                />
              ) : (
                <h2
                  onClick={() => { setTitleDraft(eng.title || ''); setEditingTitle(true) }}
                  title="Click to rename"
                  style={{ flex: 1, minWidth: 0, fontSize: '16px', fontWeight: 500, color: '#1a1a18', cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {eng.title || 'Engagement'} <span style={{ fontSize: '11px', color: '#c9c7c0' }}>✎</span>
                </h2>
              )}
              <span style={{ flexShrink: 0 }}>
                <StatusChip label={stageDisplayLabel(eng.stage)} styleKey={eng.stage} />
              </span>
            </div>
            <p style={{ fontSize: '12px', color: '#8a8a84', marginTop: '2px' }}>
              Engagement · opened {fmtDate(eng.created_at) || '—'} · founded by {eng.founded_by}
            </p>
          </div>
          <CardMenu items={menuItems} />
        </div>
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
