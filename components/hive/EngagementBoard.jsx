// components/hive/EngagementBoard.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the engagement board (doc §7), first read flip.
// One card per OPEN engagement; columns from ENGAGEMENT_STAGES with
// terminals filtered. Reads the initialEngagements rows shipped by
// app/_hub-page.tsx (client_name, repeat_count, minimal quotes/jobs/
// invoices for chips).
//
// Stage moves: desktop drag between columns → PATCH /api/engagements/:id
// { stage }, forward-only (client pre-checks STAGE_RANK; server re-checks
// and 409s). leads.stage is never touched from here. Mobile is one column
// at a time (swipe/arrows + pager dots); stage moves happen from the
// engagement sheet per the locked mobile rules — the sheet is the future
// EngagementPanel, so mobile has no drag.
//
// Card click opens the CLIENT (PersonPanel) via onOpenClient — the
// EngagementPanel replaces that seam next screen (see TODO below).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useRef } from 'react'
import { ENGAGEMENT_STAGES, STAGE_RANK, isTerminal } from './shared/stageConfig'
import StatusChip from '@/components/ui/StatusChip'
import Card from '@/components/ui/Card'
import SectionHeader from '@/components/ui/SectionHeader'

const BOARD_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal)

const fmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()
const fmtShort = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
const daysSince = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000))

// Within-stage chip derivation (step-4 report contract):
//   Request          → request age (teal; amber past 21d as pre-nurture cue)
//   Estimate         → latest quote state; 'sent' is the neutral default
//                      (bulk-imported quotes rarely carry quoteStatus)
//   Job in Progress  → active job state / next scheduled date
//   Final Processing → owing $X (red) | never invoiced (amber) | paid (teal)
// A live nurture clock (nurture_started_at, step 5) overrides everything
// with the doc's "nurturing · dNN" chip.
function deriveChip(e) {
  if (e.nurture_started_at) {
    return { label: `nurturing · d${daysSince(e.nurture_started_at)}`, styleKey: 'nurturing' }
  }
  const quotes = e.quotes || []
  const jobs = e.jobs || []
  const invoices = e.invoices || []

  switch (e.stage) {
    case 'Request': {
      const age = daysSince(e.created_at)
      if (age > 21) return { label: `requested · d${age}`, styleKey: 'amber' }
      return { label: age === 0 ? 'requested today' : `requested · d${age}`, styleKey: 'Request' }
    }
    case 'Estimate': {
      if (quotes.some(q => q.status === 'approved')) return { label: 'approved', styleKey: 'approved' }
      if (quotes.some(q => q.status === 'changes_requested')) return { label: 'changes requested', styleKey: 'changes_requested' }
      const latest = quotes.reduce((a, q) => Math.max(a, new Date(q.sent_at || 0).getTime()), 0)
      const when = latest ? fmtShort(latest) : null
      return { label: when ? `sent ${when}` : 'sent', styleKey: 'sent' }
    }
    case 'Job in Progress': {
      const active = jobs.filter(j => !j.completed_at && !(j.status || '').includes('complet'))
      const inProg = active.find(j => j.status === 'in_progress' || j.status === 'active')
      if (inProg) return { label: 'in progress', styleKey: 'in_progress' }
      const nextStart = active
        .map(j => j.scheduled_start).filter(Boolean)
        .map(d => new Date(d).getTime()).filter(t => !isNaN(t))
        .sort((a, b) => a - b)[0]
      if (nextStart) return { label: `scheduled ${fmtShort(nextStart)}`, styleKey: 'scheduled' }
      return { label: 'upcoming', styleKey: 'upcoming' }
    }
    case 'Final Processing': {
      const owing = Number(e.balance_owing) || 0
      if (owing > 0) return { label: `owing ${fmtMoney(owing)}`, styleKey: 'owing' }
      if (invoices.length === 0) return { label: 'never invoiced', styleKey: 'never_invoiced' }
      return { label: 'paid', styleKey: 'paid' }
    }
    default:
      return null
  }
}

// Card value: real money once invoiced, quoted value before that.
function cardValue(e) {
  const invoiced = Number(e.total_invoiced) || 0
  if (invoiced > 0) return fmtMoney(invoiced)
  const quoted = Math.max(0, ...(e.quotes || []).map(q => Number(q.total) || 0))
  return quoted > 0 ? fmtMoney(quoted) : null
}

function EngagementCard({ e, onOpen, draggable, onDragStart }) {
  const chip = deriveChip(e)
  const value = cardValue(e)
  return (
    <div draggable={draggable || undefined} onDragStart={onDragStart}>
      <Card onClick={onOpen}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' }}>
          <p style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 600, color: '#1a2e2b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {e.client_name}
          </p>
          {value && <span style={{ fontSize: '12px', fontWeight: 700, color: '#1a2e2b', flexShrink: 0 }}>{value}</span>}
        </div>
        <p style={{ fontSize: '11px', color: '#8a9e9a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '7px' }}>
          {e.title || 'Engagement'}
        </p>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {chip && <StatusChip label={chip.label} styleKey={chip.styleKey} size="sm" />}
          {e.repeat_count > 1 && (
            <StatusChip label={`repeat · ${e.repeat_count - 1} prior`} styleKey="repeat" size="sm" />
          )}
        </div>
      </Card>
    </div>
  )
}

export default function EngagementBoard({ engagements = [], onOpenClient = () => {}, setToast = () => {} }) {
  // Local rows for optimistic drag moves; resync when the server prop changes.
  const [rows, setRows] = useState(engagements)
  useEffect(() => { setRows(engagements) }, [engagements])

  // SSR-safe mobile detection (same pattern as BeeHub.jsx:5042 — width 0 on
  // SSR and first client render, so both sides agree and hydration is clean).
  const [windowWidth, setWindowWidth] = useState(0)
  useEffect(() => {
    const check = () => setWindowWidth(window.innerWidth)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const isMobile = windowWidth > 0 && windowWidth < 768

  const [mobileCol, setMobileCol] = useState(0)
  const [dragOverCol, setDragOverCol] = useState(null)
  const dragId = useRef(null)
  const touchX = useRef(null)

  const byStage = (key) => rows.filter(e => e.stage === key && !isTerminal(e.stage))

  async function moveStage(id, targetStage) {
    const row = rows.find(r => r.id === id)
    if (!row || row.stage === targetStage) return
    if ((STAGE_RANK[targetStage] ?? 0) <= (STAGE_RANK[row.stage] ?? 0)) {
      setToast({ kind: 'error', msg: 'Engagements only move forward — reopen from the engagement panel instead' })
      return
    }
    const prevStage = row.stage
    setRows(rs => rs.map(r => r.id === id ? { ...r, stage: targetStage } : r))
    try {
      const res = await fetch(`/api/engagements/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: targetStage }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
    } catch (err) {
      setRows(rs => rs.map(r => r.id === id ? { ...r, stage: prevStage } : r))
      setToast({ kind: 'error', msg: `Move failed: ${err.message}` })
    }
  }

  function openCard(e) {
    // TODO(EngagementPanel): mount the engagement panel here instead of the
    // client PersonPanel once it exists — pass e.id, keep client fallback.
    onOpenClient(e.client_id)
  }

  const renderColumn = (stage, { droppable }) => {
    const cards = byStage(stage.key)
    return (
      <div
        key={stage.key}
        onDragOver={droppable ? (ev) => { ev.preventDefault(); setDragOverCol(stage.key) } : undefined}
        onDragLeave={droppable ? () => setDragOverCol(null) : undefined}
        onDrop={droppable ? (ev) => {
          ev.preventDefault()
          setDragOverCol(null)
          if (dragId.current) moveStage(dragId.current, stage.key)
          dragId.current = null
        } : undefined}
        style={{
          width: isMobile ? '100%' : '220px', flexShrink: 0,
          borderRadius: '10px',
          background: dragOverCol === stage.key ? 'rgba(13,148,136,0.06)' : 'transparent',
          outline: dragOverCol === stage.key ? '1.5px dashed rgba(13,148,136,0.45)' : 'none',
          padding: '2px',
        }}
      >
        {!isMobile && <SectionHeader label={stage.label} count={cards.length} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {cards.map(e => (
            <EngagementCard
              key={e.id}
              e={e}
              onOpen={() => openCard(e)}
              draggable={!isMobile}
              onDragStart={!isMobile ? () => { dragId.current = e.id } : undefined}
            />
          ))}
          {cards.length === 0 && (
            <div style={{ padding: '14px', textAlign: 'center', color: '#c8d8d4', fontSize: '12px', border: '1px dashed rgba(0,0,0,0.08)', borderRadius: '10px' }}>
              Empty
            </div>
          )}
        </div>
      </div>
    )
  }

  if (isMobile) {
    const stage = BOARD_STAGES[mobileCol]
    const count = byStage(stage.key).length
    return (
      <div
        onTouchStart={(ev) => { touchX.current = ev.touches[0].clientX }}
        onTouchEnd={(ev) => {
          if (touchX.current == null) return
          const dx = ev.changedTouches[0].clientX - touchX.current
          touchX.current = null
          if (Math.abs(dx) < 48) return
          setMobileCol(c => Math.max(0, Math.min(BOARD_STAGES.length - 1, c + (dx < 0 ? 1 : -1))))
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <button onClick={() => setMobileCol(c => Math.max(0, c - 1))} disabled={mobileCol === 0}
            style={{ border: 'none', background: 'transparent', fontSize: '18px', color: mobileCol === 0 ? '#c8d8d4' : '#4a5e5a', cursor: 'pointer', padding: '4px 8px' }}>‹</button>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a2e2b', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{stage.label}</span>
            <span style={{ fontSize: '12px', color: '#b0c0bc', marginLeft: '6px' }}>{count}</span>
          </div>
          <button onClick={() => setMobileCol(c => Math.min(BOARD_STAGES.length - 1, c + 1))} disabled={mobileCol === BOARD_STAGES.length - 1}
            style={{ border: 'none', background: 'transparent', fontSize: '18px', color: mobileCol === BOARD_STAGES.length - 1 ? '#c8d8d4' : '#4a5e5a', cursor: 'pointer', padding: '4px 8px' }}>›</button>
        </div>
        {renderColumn(stage, { droppable: false })}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '12px' }}>
          {BOARD_STAGES.map((s, i) => (
            <button key={s.key} onClick={() => setMobileCol(i)} aria-label={s.label}
              style={{ width: '7px', height: '7px', borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', background: i === mobileCol ? '#1a2e2b' : 'rgba(0,0,0,0.15)' }} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto', paddingBottom: '1rem', WebkitOverflowScrolling: 'touch' }}>
      <div style={{ display: 'flex', gap: '12px', minWidth: 'max-content', alignItems: 'flex-start' }}>
        {BOARD_STAGES.map(stage => renderColumn(stage, { droppable: true }))}
      </div>
    </div>
  )
}
