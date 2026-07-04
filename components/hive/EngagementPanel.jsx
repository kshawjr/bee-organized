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

import React, { useState, useEffect, useRef } from 'react'
import { ENGAGEMENT_STAGES, STAGE_RANK, isTerminal, stageDisplayLabel, ACCENT_BLUE } from './shared/stageConfig'
import StatusChip from '@/components/ui/StatusChip'
import { IconInbox, IconFileText, IconHammer, IconFileInvoice, IconCheck, IconPhone, IconExternalLink, IconX } from '@/components/ui/icons'
import MetricCard from '@/components/ui/MetricCard'
import ContactLine from './ContactLine'

const fmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()
const fmtDate = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

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
function RecordRow({ icon, iconColor, primary, secondary, state, current }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '10px 12px', background: '#fff',
      border: `0.5px solid ${current ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.08)'}`,
      borderRadius: '8px',
    }}>
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
  )
}

export default function EngagementPanel({ engagementId, seed = null, onClose, onOpenClient = () => {}, onChanged = () => {}, setToast = () => {} }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchMethod, setTouchMethod] = useState('call')
  const [touchNote, setTouchNote] = useState('')
  const [busy, setBusy] = useState(false)
  const touchY = useRef(null)

  // SSR-safe mobile detection (BeeHub pattern).
  const [windowWidth, setWindowWidth] = useState(0)
  useEffect(() => {
    const check = () => setWindowWidth(window.innerWidth)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const isMobile = windowWidth > 0 && windowWidth < 768

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
  const children = data?.children ?? { service_requests: [], quotes: [], jobs: [], invoices: [] }
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
      setData(d => d ? { ...d, engagement: { ...d.engagement, ...(body.title ? { title: j.title } : {}), ...(body.stage ? { stage: j.stage } : {}) } } : d)
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

  const nextStage = (() => {
    if (!eng || isTerminal(eng.stage)) return null
    const order = ENGAGEMENT_STAGES.filter(s => s.key !== 'Closed Lost')
    const i = order.findIndex(s => s.key === eng.stage)
    return i >= 0 && i < order.length - 1 ? order[i + 1].key : null
  })()

  async function addBuzzNote() {
    const text = noteText.trim()
    if (!text || !client) return
    setBusy(true)
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: client.id, kind: 'buzz', text }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setNoteText(''); setNoteOpen(false)
      setToast({ kind: 'success', msg: 'Buzz note added' })
    } catch (e) {
      setToast({ kind: 'error', msg: `Note failed: ${e.message}` })
    } finally { setBusy(false) }
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
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setTouchNote(''); setTouchOpen(false)
      setToast({ kind: 'success', msg: 'Touchpoint logged' })
    } catch (e) {
      setToast({ kind: 'error', msg: `Touchpoint failed: ${e.message}` })
    } finally { setBusy(false) }
  }

  // Deep link: latest job → quote → request (whatever Jobber has).
  const jobberHref = (() => {
    const jobs = children.jobs, quotes = children.quotes, srs = children.service_requests
    return jobs[jobs.length - 1]?.job_url || quotes[quotes.length - 1]?.quote_url || srs[srs.length - 1]?.request_url || null
  })()

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
        </div>
      )}

      {/* Client strip — quiet card, no border */}
      {client && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: QUIET, borderRadius: '8px' }}>
          <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: '#EEEDFE', color: '#3C3489', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>
            {initialsOf(client.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{client.name}</span>
              {/* Client status: 'Active client' is definitionally true here —
                  the panel opens on OPEN engagements (§2: ≥1 open = Active).
                  Real stored/derived client_status is a later step-4 item. */}
              <StatusChip label="Active client" styleKey="Active" />
            </p>
            <p style={{ fontSize: '11px', color: '#8a8a84', marginTop: '1px' }}>
              {client.prior_engagements} prior engagement{client.prior_engagements === 1 ? '' : 's'} · {fmtMoney(client.lifetime_paid)} lifetime
              {client.other_open > 0 && ` · ${client.other_open} other open`}
            </p>
            <ContactLine phone={client.phone} email={client.email} layout={isMobile ? 'stack' : 'inline'} style={{ marginTop: '3px' }} />
          </div>
          <button onClick={() => onOpenClient(client.id)} style={{ border: 'none', background: 'transparent', fontSize: '12px', fontWeight: 500, color: ACCENT_BLUE, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', padding: 0, flexShrink: 0 }}>
            View client →
          </button>
        </div>
      )}

      {/* Stage progress */}
      {eng && <StageBar stage={eng.stage} />}

      {/* Records timeline */}
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
          <button style={outlineBtn} disabled={busy} onClick={() => { setNoteOpen(v => !v); setTouchOpen(false) }}>🐝 Add buzz note</button>
          <button style={outlineBtn} disabled={busy} onClick={() => { setTouchOpen(v => !v); setNoteOpen(false) }}><IconPhone size={14} style={{ marginRight: '5px' }} /> Log touchpoint</button>
          {jobberHref ? (
            <a href={jobberHref} target="_blank" rel="noreferrer" style={{ ...outlineBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><IconExternalLink size={14} style={{ marginRight: '5px' }} /> Open in Jobber</a>
          ) : (
            <span title="No Jobber record yet" style={{ ...outlineBtn, color: '#c9c7c0', cursor: 'default', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><IconExternalLink size={14} style={{ marginRight: '5px' }} /> Open in Jobber</span>
          )}
        </div>
        {noteOpen && (
          <div style={{ marginTop: '10px', display: 'flex', gap: '8px' }}>
            <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Buzz note…" autoFocus
              onKeyDown={e => { if (e.key === 'Enter') addBuzzNote() }}
              style={{ flex: 1, padding: '8px 12px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
            <button style={{ ...outlineBtn, flex: '0 0 auto', minWidth: 0 }} disabled={busy || !noteText.trim()} onClick={addBuzzNote}>Save</button>
          </div>
        )}
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
      </div>
    </div>
  )

  // ── containers: desktop centered modal / mobile bottom sheet ──────
  if (isMobile) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 10005, display: 'flex', alignItems: 'flex-end', background: 'rgba(26,26,24,0.35)' }} onClick={onClose}>
        <div
          onClick={e => e.stopPropagation()}
          style={{ background: '#fff', width: '100%', maxHeight: '88vh', overflowY: 'auto', borderRadius: '20px 20px 0 0', boxShadow: '0 -8px 40px rgba(26,26,24,0.2)' }}
        >
          <div
            onTouchStart={e => { touchY.current = e.touches[0].clientY }}
            onTouchEnd={e => {
              if (touchY.current == null) return
              const dy = e.changedTouches[0].clientY - touchY.current
              touchY.current = null
              if (dy > 60) onClose()
            }}
            style={{ padding: '10px 0 8px', cursor: 'grab' }}
          >
            <div style={{ width: '36px', height: '4px', background: 'rgba(0,0,0,0.15)', borderRadius: '2px', margin: '0 auto' }} />
          </div>
          {body}
        </div>
      </div>
    )
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10005, background: 'rgba(26,26,24,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '740px', maxHeight: '88vh', overflowY: 'auto', background: '#fff', borderRadius: '16px', boxShadow: '0 24px 80px rgba(26,26,24,0.25)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 16px 4px' }}>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: '18px', color: '#b5b3ac', cursor: 'pointer', lineHeight: 1, padding: '2px 4px' }}><IconX size={16} /></button>
        </div>
        {body}
      </div>
    </div>
  )
}
