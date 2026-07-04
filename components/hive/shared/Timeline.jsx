// components/hive/shared/Timeline.jsx
// ─────────────────────────────────────────────────────────────
// The unified activity timeline — ONE shared component embedded on all
// three lead-detail surfaces (PersonCard, ClientProfile, EngagementPanel),
// merging PAST history and FUTURE scheduled actions in a single stream.
//
// Layout: one vertical rail, time strictly descending down the page —
// UPCOMING at the top (furthest-future first, soonest just above the
// divider) on a DASHED connector (projected, not yet real), a
// 'Now · <date>' divider, then PAST on a SOLID connector, most-recent
// first. No future events → the Upcoming section AND the divider collapse
// entirely (history only, no lonely now-marker).
//
// Data: two fetches merged client-side —
//   GET /api/leads/:id/timeline           (DB-backed: touchpoints, notes,
//       Jobber records, engagement closes, pending stage emails, snooze,
//       welcome schedule, assessments)
//   GET /api/leads/:id/outreach-timeline  (REUSED as-is for the future
//       drip projection + subject previews)
// PAST-DRIP DEDUP: real kind='drip' touchpoint rows carry true
// occurred_at, so they win; the endpoint's back-estimated 'sent' entries
// are kept ONLY when no touchpoint matches (per-step drip sends write no
// touchpoint today — dropping them would erase that history).
//
// Inline actions (only where a real write path exists):
//   scheduled stage email → Cancel  (PATCH /api/scheduled-stage-emails/:id)
//   snooze                → Un-snooze (PATCH /api/leads/:id snoozed_until)
// Future drips and assessments are DISPLAY-ONLY: drips have no per-send
// record to cancel (only whole-drip pause), assessments are Jobber-owned
// with no app write path.
//
// §8.5: self-contained — data via props/fetch, changes reported up via
// callbacks (onLeadPatched), NO BeeHub/PartnersContext imports.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { formatInboxAge, formatInboxFuture, fmtShort, fmtShortTime, fmtMoney } from './engagementStatus'
import {
  IconMail, IconPhone, IconCalendar, IconClock, IconFileText, IconHammer,
  IconFileInvoice, IconInbox, IconCheck, IconChevronRight,
} from '@/components/ui/icons'

const METHOD_LABEL = { call: 'Call', sms: 'Text', email: 'Email', in_person: 'In person', call_prompt: 'Call prompt', system: 'System' }

// Color encodes CATEGORY; the icon encodes TYPE.
const CAT_COLOR = {
  email: { fg: '#378ADD', bg: 'rgba(55,138,221,0.10)' },   // accent
  jobber: { fg: '#378ADD', bg: 'rgba(55,138,221,0.10)' },  // accent
  call: { fg: '#1D9E75', bg: 'rgba(29,158,117,0.10)' },    // success
  created: { fg: '#1D9E75', bg: 'rgba(29,158,117,0.10)' }, // success
  note: { fg: '#1D9E75', bg: 'rgba(29,158,117,0.10)' },    // success
  scheduled: { fg: '#B7791F', bg: 'rgba(183,121,31,0.12)' }, // warning
  stage: { fg: '#8a8a84', bg: 'rgba(0,0,0,0.06)' },        // neutral
}
const TYPE_ICON = {
  email: IconMail, drip: IconMail, welcome: IconMail, stage_email: IconMail,
  call: IconPhone, system: IconCheck, note: IconFileText,
  stage_change: IconChevronRight, close: IconChevronRight,
  snooze: IconClock, assessment: IconCalendar,
  request: IconInbox, quote: IconFileText, job: IconHammer, invoice: IconFileInvoice,
}

const toTs = (v) => {
  if (!v) return null
  const t = typeof v === 'number' ? v : new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}
const normLabel = (s) => String(s || '').trim().toLowerCase()

// ── The merge — PURE and exported for tests ──────────────────────────
// agg = /api/leads/:id/timeline payload; drips = /api/leads/:id/
// outreach-timeline payload. Returns { future, past }, both sorted DESC
// by timestamp so the rendered rail reads as one strictly descending
// time axis (furthest future → now → oldest history). engagementId
// scopes engagement-TAGGED rows to that engagement; lead-level rows
// (no engagement_id) always pass.
export function buildTimelineItems(agg, drips, { engagementId = null, nowMs = Date.now() } = {}) {
  const items = []
  if (!agg) return { future: [], past: [] }
  const inEng = (row) => !engagementId || !row.engagement_id || row.engagement_id === engagementId

  // ── PAST: touchpoints — the backbone; real occurred_at ──
  const dripTouchLabels = new Set()
  for (const t of agg.touchpoints || []) {
    if (!inEng(t)) continue
    const ts = toTs(t.occurred_at)
    if (ts == null) continue
    if (t.kind === 'drip') {
      dripTouchLabels.add(normLabel(t.label))
      items.push({
        id: `tp-${t.id}`, ts, type: 'email', category: 'email',
        summary: t.label || 'Email sent',
        detail: { status: t.status || null, method: t.method || null, notes: t.notes || null },
      })
    } else if (t.kind === 'stage_change') {
      items.push({
        id: `tp-${t.id}`, ts, type: 'stage_change', category: 'stage',
        summary: t.label || 'Stage changed', detail: { notes: t.notes || null },
      })
    } else if (t.kind === 'system') {
      items.push({
        id: `tp-${t.id}`, ts, type: 'system', category: 'created',
        summary: t.label || 'System', detail: { notes: t.notes || null },
      })
    } else {
      // reach_out / note kinds — human touches
      const isEmail = t.method === 'email'
      items.push({
        id: `tp-${t.id}`, ts, type: isEmail ? 'email' : 'call', category: isEmail ? 'email' : 'call',
        summary: METHOD_LABEL[t.method] || t.label || 'Reach-out',
        detail: { method: t.method || null, status: t.status || null, notes: t.notes || null },
      })
    }
  }

  // ── PAST: notes (all kinds: job, buzz, close, system) ──
  for (const n of agg.notes || []) {
    if (!inEng(n)) continue
    const ts = toTs(n.created_at)
    if (ts == null) continue
    items.push({
      id: `note-${n.id}`, ts, type: 'note', category: 'note',
      summary: (n.text || '').split('\n')[0] || 'Note',
      detail: { body: n.text || null, author: n.user_label || null, kind: n.kind || null },
    })
  }

  // ── PAST: Jobber records, each on its own timestamp ──
  for (const sr of agg.service_requests || []) {
    if (!inEng(sr)) continue
    const ts = toTs(sr.requested_at) ?? toTs(sr.created_at)
    if (ts == null) continue
    items.push({
      id: `sr-${sr.id}`, ts, type: 'request', category: 'jobber',
      summary: 'Request received', detail: { source: sr.source || null },
    })
  }
  for (const q of agg.quotes || []) {
    if (!inEng(q)) continue
    const ts = toTs(q.sent_at) ?? toTs(q.created_at)
    if (ts == null) continue
    items.push({
      id: `q-${q.id}`, ts, type: 'quote', category: 'jobber',
      summary: `Quote · ${fmtMoney(q.total)}`,
      detail: {
        status: q.status || null,
        lines: [q.sent_at && `sent ${fmtShort(q.sent_at)}`, q.approved_at && `approved ${fmtShort(q.approved_at)}`].filter(Boolean),
      },
    })
  }
  for (const j of agg.jobs || []) {
    if (!inEng(j)) continue
    const ts = toTs(j.completed_at) ?? toTs(j.scheduled_start) ?? toTs(j.created_at)
    if (ts == null) continue
    items.push({
      id: `job-${j.id}`, ts, type: 'job', category: 'jobber',
      summary: `Job · ${j.title || 'Untitled'}${j.total != null ? ` · ${fmtMoney(j.total)}` : ''}`,
      detail: {
        status: j.status || null,
        lines: [j.scheduled_start && `scheduled ${fmtShort(j.scheduled_start)}`, j.completed_at && `completed ${fmtShort(j.completed_at)}`].filter(Boolean),
      },
    })
  }
  for (const inv of agg.invoices || []) {
    if (!inEng(inv)) continue
    const ts = toTs(inv.issued_at) ?? toTs(inv.paid_at)
    if (ts == null) continue
    items.push({
      id: `inv-${inv.id}`, ts, type: 'invoice', category: 'jobber',
      summary: `Invoice · ${fmtMoney(inv.total)}`,
      detail: {
        status: inv.status || null,
        lines: [inv.issued_at && `issued ${fmtShort(inv.issued_at)}`, inv.paid_at && `paid ${fmtShort(inv.paid_at)}`].filter(Boolean),
      },
    })
  }

  // ── PAST: engagement closes ──
  for (const e of agg.engagements || []) {
    if (engagementId && e.id !== engagementId) continue
    const ts = toTs(e.closed_at)
    if (ts == null) continue
    const won = e.stage === 'Closed Won'
    items.push({
      id: `close-${e.id}`, ts, type: 'close', category: 'stage',
      summary: `Engagement closed — ${won ? 'won' : 'lost'}${e.title ? ` · ${e.title}` : ''}`,
      // closed_reason values are asymmetric across writers — display raw,
      // never branch on them.
      detail: { reason: e.closed_reason || null, notes: e.closed_note || null },
    })
  }

  // ── FUTURE: drip projection — REUSED endpoint, future entries only ──
  // (Past 'sent' entries are back-estimates; see dedup below.)
  const futureDrips = []
  for (const it of (drips && drips.items) || []) {
    if (it.status === 'sent') continue
    const ts = toTs(it.scheduled_at)
    if (ts == null) continue
    const paused = !!it.paused
    futureDrips.push({
      id: it.id, ts, type: 'drip', category: 'scheduled',
      summary: `${it.template_name || `Drip step ${it.step_order}`}${paused ? ' · paused' : ''}`,
      detail: { subject: it.subject || null, channel: it.channel || 'email', paused },
    })
  }
  // Next-in-sequence: each future drip knows what follows it.
  futureDrips.sort((a, b) => a.ts - b.ts)
  for (let i = 0; i < futureDrips.length - 1; i++) {
    const nxt = futureDrips[i + 1]
    futureDrips[i].detail.next = `${nxt.summary} · ${fmtShort(new Date(nxt.ts))}`
  }
  items.push(...futureDrips)

  // ── PAST drips from the endpoint — back-estimated dates. Prefer the
  // real kind='drip' touchpoint (true occurred_at) when one matches by
  // template name; keep the estimate only when nothing real exists. ──
  for (const it of (drips && drips.items) || []) {
    if (it.status !== 'sent') continue
    const ts = toTs(it.fired_at)
    if (ts == null) continue
    if (dripTouchLabels.has(normLabel(it.template_name))) continue // real touchpoint wins
    items.push({
      id: it.id, ts, type: 'drip', category: 'email',
      summary: it.template_name || `Drip step ${it.step_order}`,
      detail: { subject: it.subject || null, channel: it.channel || 'email', estimated: true },
    })
  }

  // ── FUTURE: pending scheduled stage emails — the one future type with
  // a per-row cancel path (cancelled_at). ──
  for (const se of agg.scheduled_stage_emails || []) {
    const ts = toTs(se.send_at)
    if (ts == null) continue
    items.push({
      id: `se-${se.id}`, ts, type: 'stage_email', category: 'scheduled',
      summary: se.template_name || 'Scheduled email',
      detail: { subject: se.subject || null, key: se.stage_email_key || null },
      action: 'cancel_stage_email', refId: se.id,
    })
  }

  // ── FUTURE: snooze (lead-level) — un-snooze reuses the snooze-clear
  // PATCH. ──
  const snoozeTs = toTs(agg.lead && agg.lead.snoozed_until)
  if (snoozeTs != null && snoozeTs > nowMs) {
    items.push({
      id: 'snooze', ts: snoozeTs, type: 'snooze', category: 'scheduled',
      summary: `Snoozed until ${fmtShort(new Date(snoozeTs))}`,
      detail: { notes: (agg.lead && agg.lead.snoozed_note) || null },
      action: 'unsnooze',
    })
  }

  // ── FUTURE: welcome email (display-only — the cron owns it) ──
  const welcomeTs = toTs(agg.lead && agg.lead.welcome_email_scheduled_at)
  if (welcomeTs != null && welcomeTs > nowMs && !(agg.lead && agg.lead.welcome_email_sent_at)) {
    items.push({
      id: 'welcome', ts: welcomeTs, type: 'welcome', category: 'scheduled',
      summary: 'Welcome email scheduled', detail: {},
    })
  }

  // ── FUTURE: assessments (display-only — Jobber-import-owned, no app
  // write path; edits would be clobbered by the next sync) ──
  for (const a of agg.assessments || []) {
    if (!inEng(a)) continue
    const ts = toTs(a.scheduled_at)
    if (ts == null || ts <= nowMs) continue
    items.push({
      id: `as-${a.id}`, ts, type: 'assessment', category: 'scheduled',
      summary: `Assessment · ${fmtShortTime(a.scheduled_at)}`, detail: { status: a.status || null },
    })
  }

  // One strictly descending time axis: future desc above the divider
  // (soonest lands just above Now), past desc below (most recent first).
  const future = items.filter(i => i.ts > nowMs).sort((a, b) => b.ts - a.ts)
  const past = items.filter(i => i.ts <= nowMs).sort((a, b) => b.ts - a.ts)
  return { future, past }
}

// ── Presentation ─────────────────────────────────────────────────────

function Dot({ type, category }) {
  const Icon = TYPE_ICON[type] || IconCheck
  const col = CAT_COLOR[category] || CAT_COLOR.stage
  return (
    <span style={{
      width: '22px', height: '22px', borderRadius: '50%', background: col.bg, color: col.fg,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <Icon size={12} />
    </span>
  )
}

function DetailLine({ children }) {
  return <p style={{ fontSize: '11px', color: '#6b6b66', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{children}</p>
}

function Row({ it, last, dashed, nowMs, expanded, onToggle, actionSlot }) {
  const d = it.detail || {}
  return (
    <div style={{ display: 'flex', gap: '10px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '22px', flexShrink: 0 }}>
        <Dot type={it.type} category={it.category} />
        {!last && <span aria-hidden style={{ flex: 1, width: 0, minHeight: '10px', borderLeft: `1px ${dashed ? 'dashed' : 'solid'} rgba(0,0,0,0.15)` }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : '12px' }}>
        <button
          onClick={onToggle}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} timeline item: ${it.summary}`}
          style={{
            display: 'flex', alignItems: 'baseline', gap: '8px', width: '100%',
            border: 'none', background: 'transparent', padding: '2px 0', margin: 0,
            font: 'inherit', textAlign: 'left', cursor: 'pointer',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, fontSize: '12px', color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {it.summary}
          </span>
          <span style={{ flexShrink: 0, fontSize: '11px', color: '#8a8a84', whiteSpace: 'nowrap' }}>
            {it.ts > nowMs ? formatInboxFuture(it.ts, nowMs) : formatInboxAge(it.ts, nowMs)}
          </span>
        </button>
        {expanded && (
          <div style={{ marginTop: '4px', padding: '8px 10px', background: '#f7f6f4', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {d.subject && <DetailLine>Subject: {d.subject}</DetailLine>}
            {d.body && <DetailLine>{d.body}</DetailLine>}
            {d.author && <DetailLine>— {d.author}</DetailLine>}
            {d.method && <DetailLine>Method: {METHOD_LABEL[d.method] || d.method}</DetailLine>}
            {d.status && <DetailLine>Status: {String(d.status).replace(/_/g, ' ')}</DetailLine>}
            {(d.lines || []).map((l, i) => <DetailLine key={i}>{l}</DetailLine>)}
            {d.reason && <DetailLine>Reason: {String(d.reason).replace(/_/g, ' ')}</DetailLine>}
            {d.notes && <DetailLine>{d.notes}</DetailLine>}
            {d.next && <DetailLine>Next in sequence: {d.next}</DetailLine>}
            {d.estimated && <DetailLine>Date estimated from drip cadence</DetailLine>}
            {d.paused && <DetailLine>Drip paused — will not send until resumed</DetailLine>}
            {actionSlot}
          </div>
        )}
      </div>
    </div>
  )
}

export default function Timeline({ leadId, engagementId = null, locationUuid = null, setToast = () => {}, onLeadPatched = () => {}, nowMs: nowMsProp = null }) {
  const [agg, setAgg] = useState(null)
  const [drips, setDrips] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [removedIds, setRemovedIds] = useState(() => new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let dead = false
    setAgg(null); setDrips(null); setLoadErr(null); setRemovedIds(new Set())
    fetch(`/api/leads/${leadId}/timeline`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(d => { if (!dead) setAgg(d) })
      .catch(e => { if (!dead) setLoadErr(String(e.message || e)) })
    // Drip projection degrades soft — a failure here should not blank the
    // whole timeline.
    fetch(`/api/leads/${leadId}/outreach-timeline`)
      .then(r => (r.ok ? r.json() : { items: [] }))
      .then(d => { if (!dead) setDrips(d) })
      .catch(() => { if (!dead) setDrips({ items: [] }) })
    return () => { dead = true }
  }, [leadId])

  const nowMs = nowMsProp ?? Date.now()
  const { future, past } = useMemo(
    () => buildTimelineItems(agg, drips, { engagementId, nowMs }),
    [agg, drips, engagementId, nowMs],
  )
  const upcoming = future.filter(i => !removedIds.has(i.id))

  const remove = (id) => setRemovedIds(prev => new Set(prev).add(id))
  const unremove = (id) => setRemovedIds(prev => { const n = new Set(prev); n.delete(id); return n })

  // Same undo idiom as the Inbox actions — the host toast renders {msg}
  // verbatim, so the Undo button rides inside; window = ~3s auto-dismiss.
  const undoToast = (text, onUndo) => ({
    kind: 'success',
    msg: (
      <span>
        {text} ·{' '}
        <button onClick={onUndo}
          style={{ background: 'none', border: 'none', padding: 0, color: '#fff', font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
          Undo
        </button>
      </span>
    ),
  })

  async function cancelStageEmail(it) {
    setBusy(true)
    remove(it.id) // optimistic
    try {
      const res = await fetch(`/api/scheduled-stage-emails/${it.refId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelled: true }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setToast(undoToast('Email cancelled', async () => {
        try {
          const r2 = await fetch(`/api/scheduled-stage-emails/${it.refId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cancelled: false }),
          })
          if (!r2.ok) throw new Error((await r2.json().catch(() => ({})))?.error || `HTTP ${r2.status}`)
          unremove(it.id)
          setToast({ kind: 'success', msg: 'Email restored' })
        } catch (e) {
          setToast({ kind: 'error', msg: `Undo failed: ${e.message}` })
        }
      }))
    } catch (e) {
      unremove(it.id) // revert
      setToast({ kind: 'error', msg: `Cancel failed: ${e.message}` })
    } finally { setBusy(false) }
  }

  async function unsnooze(it) {
    const prev = agg?.lead?.snoozed_until ?? null
    setBusy(true)
    remove(it.id) // optimistic
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snoozed_until: null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      onLeadPatched(leadId, { snoozed_until: null })
      setToast(undoToast('Snooze cleared', async () => {
        try {
          const r2 = await fetch(`/api/leads/${leadId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ snoozed_until: prev }),
          })
          if (!r2.ok) throw new Error((await r2.json().catch(() => ({})))?.error || `HTTP ${r2.status}`)
          unremove(it.id)
          onLeadPatched(leadId, { snoozed_until: prev })
          setToast({ kind: 'success', msg: 'Snooze restored' })
        } catch (e) {
          setToast({ kind: 'error', msg: `Undo failed: ${e.message}` })
        }
      }))
    } catch (e) {
      unremove(it.id) // revert
      setToast({ kind: 'error', msg: `Un-snooze failed: ${e.message}` })
    } finally { setBusy(false) }
  }

  // ≥44px tap target (mobile-tappable inside the narrow card).
  const actionBtn = {
    marginTop: '6px', minHeight: '44px', padding: '10px 14px', borderRadius: '8px',
    border: '0.5px solid rgba(0,0,0,0.15)', background: '#fff', fontSize: '12px',
    fontWeight: 500, color: '#1a1a18', cursor: 'pointer', fontFamily: 'inherit',
    alignSelf: 'flex-start',
  }
  const actionSlotFor = (it) => {
    if (it.action === 'cancel_stage_email') {
      return (
        <button aria-label="Cancel scheduled email" disabled={busy} style={actionBtn}
          onClick={(e) => { e.stopPropagation(); cancelStageEmail(it) }}>
          Cancel this email
        </button>
      )
    }
    if (it.action === 'unsnooze') {
      return (
        <button aria-label="Un-snooze" disabled={busy} style={actionBtn}
          onClick={(e) => { e.stopPropagation(); unsnooze(it) }}>
          Un-snooze
        </button>
      )
    }
    return null
  }

  if (loadErr) {
    return <p style={{ fontSize: '11px', color: '#b5b3ac' }}>Couldn’t load timeline: {loadErr}</p>
  }
  if (!agg || !drips) {
    return <p style={{ fontSize: '11px', color: '#b5b3ac' }}>Loading timeline…</p>
  }
  if (upcoming.length === 0 && past.length === 0) {
    return <p style={{ fontSize: '11px', color: '#b5b3ac' }}>No activity yet</p>
  }

  const renderRow = (it, i, arr, dashed) => (
    <Row key={it.id} it={it} last={i === arr.length - 1} dashed={dashed} nowMs={nowMs}
      expanded={expandedId === it.id}
      onToggle={() => setExpandedId(cur => (cur === it.id ? null : it.id))}
      actionSlot={actionSlotFor(it)}
    />
  )

  return (
    <div>
      {/* EMPTY-FUTURE: no upcoming → this whole block (rows + divider)
          collapses and history starts at the top. */}
      {upcoming.length > 0 && (
        <>
          <div>{upcoming.map((it, i, arr) => renderRow(it, i, arr, true))}</div>
          <div aria-label="Now" style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '10px 0' }}>
            <span style={{ width: '22px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#378ADD' }} />
            </span>
            <span style={{ flexShrink: 0, fontSize: '11px', fontWeight: 500, color: '#378ADD', letterSpacing: '0.4px' }}>
              Now · {fmtShort(new Date(nowMs))}
            </span>
            <span style={{ flex: 1, height: '1px', background: 'rgba(0,0,0,0.08)' }} />
          </div>
        </>
      )}
      <div>{past.map((it, i, arr) => renderRow(it, i, arr, false))}</div>
    </div>
  )
}
