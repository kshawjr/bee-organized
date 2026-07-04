// components/hive/EngagementPanel.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the engagement panel (doc §7), the board's card
// click-through, aligned to the LOCKED panel mockup. Fetches
// GET /api/engagements/:id on open (board rows stay lightweight).
//
// Desktop: CENTERED MODAL over the scrim (~740px, radius 16). Mobile:
// bottom sheet with drag handle + swipe-down dismiss. Stage moves on
// mobile happen HERE via 'Advance' — the board has no mobile drag.
//
// Rides in the beta dynamic chunk (imported by HiveShell only).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import useIsMobile from './shared/useIsMobile'
import { ENGAGEMENT_STAGES, STAGE_RANK, isTerminal, stageDisplayLabel, ACCENT_BLUE } from './shared/stageConfig'
import StatusChip from '@/components/ui/StatusChip'
import { IconInbox, IconFileText, IconHammer, IconFileInvoice, IconCheck, IconPhone, IconExternalLink, IconCalendar, IconSend } from '@/components/ui/icons'
import MetricCard from '@/components/ui/MetricCard'
import ClientStrip from './ClientStrip'
import NotesStream from './NotesStream'
import OverlayShell from './OverlayShell'
import MetaSelect from './MetaSelect'
import ReferrerField from './shared/ReferrerField'
import { fmtTime } from './shared/engagementStatus'

const fmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()
const fmtDate = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Quiet light surface used by the client strip + money cards (mockup).
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
// current blue w/ weight-500 dark label, future neutral.
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

// Micro section label ('RECORDS' / 'ACTIONS' style — 11px letterspaced).
function MicroLabel({ children }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '8px' }}>
      {children}
    </p>
  )
}

// One RECORDS timeline row (mockup anatomy): leading family-colored glyph,
// primary 13px, secondary 11px muted, trailing state — green ✓ for done,
// colored status word otherwise. Current-stage row = stronger hairline.
function RecordRow({ icon, iconColor, primary, secondary, state, current, sub }) {
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
      {/* Nested sub-block (mockup): indented past the icon, inside the card. */}
      {sub && <div style={{ marginTop: '8px', marginLeft: '28px' }}>{sub}</div>}
    </div>
  )
}

export default function EngagementPanel({ engagementId, seed = null, people = [], onClose, onOpenClient = () => {}, onChanged = () => {}, onLeadPatched = () => {}, onPartnerCreated = () => {}, onSendToJobber = null, setToast = () => {}, lookupOptions = { sources: [], projectTypes: [] } }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [descEditing, setDescEditing] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const [descExpanded, setDescExpanded] = useState(false)
  const [buzzOpen, setBuzzOpen] = useState(false)
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchMethod, setTouchMethod] = useState('call')
  const [touchNote, setTouchNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeAs, setCloseAs] = useState('Closed Lost')
  const [closeReason, setCloseReason] = useState('lost_no_response')
  const [closeNote, setCloseNote] = useState('')

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

  // Client-level buzz — posted from the shared bee drawer (it owns the
  // draft; we own the notes array + optimistic prepend).
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
  // from the shared NotesStream composer. Buzz is client-level and lives
  // in the strip's bee drawer + ClientProfile.
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

  // Description block (mockup): the engagement's own editable field,
  // rendered NESTED under the founding Request row — indented italic
  // quiet sub-block — or standalone at the top of RECORDS when the
  // engagement has no request row (quote/job/manual foundings).
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

  // One interleaved activity stream: engagement notes + engagement-scoped
  // touchpoints, newest first.
  const activity = [
    ...(children.notes || []).map(n => ({ t: 'note', ts: n.created_at, ...n })),
    ...(children.touchpoints || []).map(tp => ({ t: 'touch', ts: tp.occurred_at, ...tp })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts))

  // Deep link: latest job → quote → request (whatever Jobber has).
  const jobberHref = (() => {
    const jobs = children.jobs, quotes = children.quotes, srs = children.service_requests
    return jobs[jobs.length - 1]?.job_url || quotes[quotes.length - 1]?.quote_url || srs[srs.length - 1]?.request_url || null
  })()

  // Founded-but-not-sent (the decoupled-founding case, typically
  // founded_by='manual'): the engagement has NO work records at all —
  // no request/quote/job/invoice, so nothing Jobber-side. That exact
  // case gets a Send to Jobber action; the send carries engagementId so
  // the resulting request attaches HERE (never a second engagement, and
  // never a second leads row — the send targets the existing lead).
  // Deliberately narrow: any child row means Jobber (or an import)
  // already owns records for this cycle and the send offer disappears.
  const canSendToJobber = !!onSendToJobber && !!data && eng && !isTerminal(eng.stage) &&
    children.service_requests.length === 0 && children.quotes.length === 0 &&
    children.jobs.length === 0 && children.invoices.length === 0 &&
    (children.assessments || []).length === 0

  const currentType = eng
    ? (eng.stage === 'Request' ? 'request' : eng.stage === 'Estimate' ? 'quote' : eng.stage === 'Job in Progress' ? 'job' : 'invoice')
    : null

  // Trailing state per row (mockup): green ✓ when that record is done,
  // colored status word otherwise (blue in-motion, amber attention,
  // red money-owed).
  const DONE = { check: true, color: BAR_DONE }
  const quoteState = (q) =>
    q.status === 'approved' ? DONE
    : q.status === 'changes_requested' ? { label: 'changes requested', color: '#633806' }
    : q.status === 'archived' ? { label: 'archived', color: '#8a8a84' }
    : { label: 'sent', color: BAR_CURRENT }
  const jobState = (j) =>
    (j.completed_at || (j.status || '').includes('complet')) ? DONE
    : { label: (j.status && j.status !== 'unknown' ? j.status.replace('_', ' ') : 'upcoming'), color: BAR_CURRENT }
  const invoiceState = (i) =>
    i.status === 'paid' ? DONE
    : { label: `owing ${fmtMoney(i.balance_owing != null ? i.balance_owing : i.total)}`, color: '#791F1F' }

  const outlineBtn = {
    flex: 1, minWidth: '150px',
    padding: '9px 12px', borderRadius: '8px', border: '0.5px solid rgba(0,0,0,0.15)',
    background: '#fff', fontSize: '13px', fontWeight: 500, color: '#1a1a18',
    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', textAlign: 'center',
  }

  const body = (
    <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {loadErr && (
        <p style={{ fontSize: '12px', color: '#791F1F', background: '#FCEBEB', padding: '8px 12px', borderRadius: '8px' }}>
          Couldn’t load engagement: {loadErr}
        </p>
      )}

      {/* Header — title left, stage chip right on ONE line */}
      {eng && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditingTitle(false) }}
                style={{ flex: 1, minWidth: 0, fontSize: '17px', fontWeight: 500, color: '#1a1a18', border: 'none', borderBottom: '1px solid rgba(0,0,0,0.2)', outline: 'none', fontFamily: 'inherit', background: 'transparent', padding: '0 0 2px' }}
              />
            ) : (
              <h2
                onClick={() => { setTitleDraft(eng.title || ''); setEditingTitle(true) }}
                title="Click to rename"
                style={{ flex: 1, minWidth: 0, fontSize: '17px', fontWeight: 500, color: '#1a1a18', cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {eng.title || 'Engagement'} <span style={{ fontSize: '11px', color: '#c9c7c0' }}>✎</span>
              </h2>
            )}
            <span style={{ flexShrink: 0 }}>
              <StatusChip label={stageDisplayLabel(eng.stage)} styleKey={eng.stage} />
            </span>
          </div>
          <p style={{ fontSize: '12px', color: '#8a8a84', marginTop: '4px' }}>
            Engagement · opened {fmtDate(eng.created_at) || '—'} · founded by {eng.founded_by}
          </p>
          {/* Meta row — admin-driven vocabularies. Source rides the LEAD;
              Type rides THIS engagement (seeded at founding). */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
            <MetaSelect label="Source" value={client?.source || null} options={lookupOptions.sources} onPick={saveSource} />
            <MetaSelect label="Type" value={eng.project_type || null} options={lookupOptions.projectTypes} onPick={(v) => patchEngagement({ project_type: v })} />
          </div>
          {/* Referrer — LEAD-level like Source: the shared field PATCHes
              the lead's referred_by columns (client.id), never an
              engagement field. */}
          {client && (
            <div style={{ marginTop: '8px' }}>
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
        </div>
      )}

      {/* Client strip — the shared person-block (avatar + meta + buzz
          drawer + contact). 'Active client' is definitionally true here —
          the panel opens on OPEN engagements (§2: ≥1 open = Active). */}
      {client && (
        <ClientStrip
          name={client.name}
          chip={{ label: 'Active client', styleKey: 'Active' }}
          meta={`${client.prior_engagements} prior engagement${client.prior_engagements === 1 ? '' : 's'} · ${fmtMoney(client.lifetime_paid)} lifetime${client.other_open > 0 ? ` · ${client.other_open} other open` : ''}`}
          phone={client.phone}
          email={client.email}
          buzz={client.buzz || []}
          buzzOpen={buzzOpen}
          onToggleBuzz={() => setBuzzOpen(v => !v)}
          onPostBuzz={addBuzz}
          onAllBuzz={() => onOpenClient(client.id)}
          isMobile={isMobile}
          action={
            <button onClick={() => onOpenClient(client.id)} style={{ border: 'none', background: 'transparent', fontSize: '12px', fontWeight: 500, color: ACCENT_BLUE, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', padding: 0, flexShrink: 0 }}>
              View client →
            </button>
          }
        />
      )}

      {/* Stage progress */}
      {eng && <StageBar stage={eng.stage} />}

      {/* Records timeline */}
      <div>
        <MicroLabel>Records</MicroLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* No request row (quote/job/manual foundings): the description
              leads RECORDS standalone instead of nesting. */}
          {eng && children.service_requests.length === 0 && data && descBlock()}
          {children.service_requests.map((sr, i) => (
            <RecordRow key={sr.id} icon={<IconInbox size={15} />} iconColor="#085041" current={currentType === 'request'}
              primary={`Request · ${fmtDate(sr.requested_at || sr.created_at) || '—'}`}
              secondary={sr.source ? `source: ${sr.source}` : null}
              state={currentType === 'request' ? { label: 'active', color: BAR_CURRENT } : DONE}
              sub={i === 0 ? descBlock() : null}
            />
          ))}
          {(children.assessments || []).map(a => {
            const done = !!a.completed_at || a.status === 'completed'
            const future = new Date(a.scheduled_at || 0).getTime() > Date.now()
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

      {/* Notes — the shared stream (notes + touchpoints interleaved;
          outreach-scoping ruling stands). The composer posts a note;
          'Log touchpoint' below feeds the same stream. */}
      <NotesStream label="Notes · this engagement" items={activity} onPost={addEngagementNote} />

      {/* Money strip */}
      {eng && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: '8px' }}>
          <MetricCard label="Engagement value" value={fmtMoney(Number(eng.total_invoiced) > 0 ? eng.total_invoiced : Math.max(0, ...children.quotes.map(q => Number(q.total) || 0)))} />
          <MetricCard label="Invoiced" value={fmtMoney(eng.total_invoiced)} />
          <MetricCard label="Paid" value={fmtMoney(eng.total_paid)} tone={Number(eng.balance_owing) > 0 ? 'red' : 'teal'} />
        </div>
      )}

      {/* Actions — three equal outline buttons; Advance is the primary below */}
      <div>
        <MicroLabel>Actions</MicroLabel>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button style={outlineBtn} disabled={busy} onClick={() => setTouchOpen(v => !v)}><IconPhone size={14} style={{ marginRight: '5px' }} /> Log touchpoint</button>
          {canSendToJobber && client && (
            <button style={outlineBtn} disabled={busy} onClick={() => onSendToJobber(client.id, { engagementId })}>
              <IconSend size={14} style={{ marginRight: '5px' }} /> Send to Jobber
            </button>
          )}
          {jobberHref ? (
            <a href={jobberHref} target="_blank" rel="noreferrer" style={{ ...outlineBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><IconExternalLink size={14} style={{ marginRight: '5px' }} /> Open in Jobber</a>
          ) : (
            <span title="No Jobber record yet" style={{ ...outlineBtn, color: '#c9c7c0', cursor: 'default', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><IconExternalLink size={14} style={{ marginRight: '5px' }} /> Open in Jobber</span>
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
            <button style={{ ...outlineBtn, flex: '0 0 auto', minWidth: 0 }} disabled={busy} onClick={logTouchpoint}>Log</button>
          </div>
        )}
        {nextStage && (
          <button
            style={{ width: '100%', marginTop: '10px', padding: '10px 12px', borderRadius: '8px', border: 'none', background: '#1a1a18', color: '#fff', fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
            disabled={busy}
            onClick={() => patchEngagement({ stage: nextStage }, `Moved to ${stageDisplayLabel(nextStage)}`)}
          >
            Advance to {stageDisplayLabel(nextStage)} →
          </button>
        )}
        {/* Close-out (doc §4): quiet affordance — closing is legitimate,
            not alarming. Inline confirm, never a second modal. */}
        {eng && !isTerminal(eng.stage) && !closeOpen && (
          <button onClick={() => setCloseOpen(true)}
            style={{ display: 'block', margin: '10px auto 0', border: 'none', background: 'transparent', fontSize: '11px', color: '#b5b3ac', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
            Close engagement
          </button>
        )}
        {closeOpen && eng && (() => {
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
            <div style={{ marginTop: '12px', padding: '12px', background: '#f7f6f4', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
        })()}
      </div>
    </div>
  )

  return <OverlayShell isMobile={isMobile} onClose={onClose}>{body}</OverlayShell>
}
