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
import { ENGAGEMENT_STAGES, STAGE_RANK, isTerminal, CLOSED_WON, CLOSED_LOST } from './shared/stageConfig'
import { SECTION_LABEL, SECTION_COUNT, TEXT_SUCCESS, TEXT_DANGER } from '@/components/ui/tokens'
import FilterChips from '@/components/ui/FilterChips'
// THE shared status derivation — board cards and list rows consume the
// same module so the two lenses can never disagree.
import { deriveStatusChip, displayTitle, engagementValue, fmtMoney } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import Card from '@/components/ui/Card'
import SectionHeader from '@/components/ui/SectionHeader'
import { statusIconFor, IconChevronRight } from '@/components/ui/icons'
import EngagementFilters from './EngagementFilters'
import { ENGAGEMENT_FILTER_DEFAULTS, passesEngagementFilters, engagementFilterCount, lastActivityTs, engagementValue as engValueOf } from './shared/engagementStatus'
import { FilteredEmpty } from './shared/FilterPopover'
import { useStoredState } from './shared/useStoredControls'
import useIsMobile from './shared/useIsMobile'

const BOARD_SORTS = [
  { key: 'newest', label: 'Newest activity' },
  { key: 'oldest', label: 'Oldest activity' },
  { key: 'value_desc', label: 'Highest value' },
  { key: 'value_asc', label: 'Lowest value' },
  { key: 'client', label: 'Client A–Z' },
]

const BOARD_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal)

// Closed rail (5th column, desktop): the board only ever loads a RECENT
// WINDOW of closed engagements — there are ~1,375 terminal rows and the
// board is a working surface, not the archive (that's the List). The
// window rides GET /api/engagements?closed=1&limit=40 (explicit .range()
// server-side — never a bare .select(), the 1000-row silent-truncation
// gotcha). The All/Won/Lost toggle filters THIS window in memory only.
const CLOSED_WINDOW = 40

// Card typography (LOCKED): name 13px/500 near-black, subtitle 11px muted,
// value 12px/500. 100% sans — no serif inside the board.
function EngagementCard({ e, onOpen, draggable, onDragStart, accent = null }) {
  const chip = deriveStatusChip(e)
  const rawValue = engagementValue(e)
  const value = rawValue != null ? fmtMoney(rawValue) : null
  return (
    <div draggable={draggable || undefined} onDragStart={onDragStart}>
      <Card onClick={onOpen} accent={accent}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '3px' }}>
          <p style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {e.client_name}
          </p>
          {value && <span style={{ fontSize: '12px', fontWeight: 500, color: '#1a1a18', flexShrink: 0 }}>{value}</span>}
        </div>
        <p style={{ fontSize: '11px', color: '#8a8a84', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '8px' }}>
          {displayTitle(e)}
        </p>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {chip && <StatusChip label={chip.label} styleKey={chip.styleKey} icon={statusIconFor(chip.styleKey)} />}
          {e.repeat_count > 1 && (
            <StatusChip label={`repeat · ${e.repeat_count - 1} prior`} styleKey="repeat" />
          )}
        </div>
      </Card>
    </div>
  )
}

export default function EngagementBoard({ engagements = [], closedCount = 0, locFilter = 'all', workFilters = ENGAGEMENT_FILTER_DEFAULTS, setWorkFilters = () => {}, clearWorkFilters = () => {}, onOpenClient = () => {}, onOpenEngagement = null, onViewClosedInList = () => {}, setToast = () => {} }) {
  // Local rows for optimistic drag moves; resync when the server prop changes.
  const [rows, setRows] = useState(engagements)
  useEffect(() => { setRows(engagements) }, [engagements])

  const isMobile = useIsMobile()

  const [mobileCol, setMobileCol] = useState(0)
  const [dragOverCol, setDragOverCol] = useState(null)
  const dragId = useRef(null)
  const touchX = useRef(null)

  // Closed rail state — collapsed by default every mount (it's an
  // archive peek, not a pinned lens). Data is fetched ONCE on first
  // expand; the All/Won/Lost toggle never refetches.
  const [closedOpen, setClosedOpen] = useState(false)
  const [closedSeg, setClosedSeg] = useState('all')     // 'all' | 'won' | 'lost'
  const [closedData, setClosedData] = useState(null)    // { rows, total } — recent window only
  const [closedLoading, setClosedLoading] = useState(false)

  async function fetchClosedWindow() {
    setClosedLoading(true)
    try {
      const params = new URLSearchParams({ closed: '1', offset: '0', limit: String(CLOSED_WINDOW) })
      if (locFilter !== 'all') params.set('location_uuid', locFilter)
      const res = await fetch(`/api/engagements?${params}`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setClosedData({ rows: j.rows || [], total: j.total ?? null })
    } catch (err) {
      setToast({ kind: 'error', msg: `Closed engagements failed to load: ${err.message}` })
    } finally {
      setClosedLoading(false)
    }
  }

  // Window is per location scope — drop it when the switcher moves.
  useEffect(() => { setClosedData(null); setClosedSeg('all') }, [locFilter])

  function expandClosed() {
    setClosedOpen(true)
    if (!closedData && !closedLoading) fetchClosedWindow()
  }

  // Within-column ordering (persisted separately from the list's sort).
  const [boardSortRaw, setBoardSort] = useStoredState('bee_hive_board_sort', { key: 'newest' })
  const boardSort = BOARD_SORTS.some(o => o.key === boardSortRaw.key) ? boardSortRaw.key : 'newest'
  const nowMs = Date.now()
  const filterCount = engagementFilterCount(workFilters)
  const visibleRows = rows.filter(e => !isTerminal(e.stage) && passesEngagementFilters(e, workFilters, nowMs))

  const orderColumn = (arr) => {
    const sorted = arr.slice()
    if (boardSort === 'oldest') sorted.sort((a, b) => lastActivityTs(a) - lastActivityTs(b))
    else if (boardSort === 'value_desc') sorted.sort((a, b) => (engValueOf(b) ?? 0) - (engValueOf(a) ?? 0))
    else if (boardSort === 'value_asc') sorted.sort((a, b) => (engValueOf(a) ?? 0) - (engValueOf(b) ?? 0))
    else if (boardSort === 'client') sorted.sort((a, b) => (a.client_name || '').localeCompare(b.client_name || ''))
    else sorted.sort((a, b) => lastActivityTs(b) - lastActivityTs(a)) // newest
    return sorted
  }
  const byStage = (key) => orderColumn(visibleRows.filter(e => e.stage === key))

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
    // EngagementPanel is the click-through (HiveShell passes
    // onOpenEngagement); PersonPanel remains the fallback for any
    // legacy mount without the panel wiring.
    if (onOpenEngagement) onOpenEngagement(e)
    else onOpenClient(e.client_id)
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
          background: dragOverCol === stage.key ? 'rgba(225,245,238,0.5)' : 'transparent',
          outline: dragOverCol === stage.key ? '1.5px dashed rgba(8,80,65,0.35)' : 'none',
          padding: '2px',
        }}
      >
        {!isMobile && <SectionHeader label={stage.displayLabel} count={cards.length} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
            <div style={{ padding: '14px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '10px' }}>
              Empty
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Closed rail (desktop 5th column) ─────────────────────────
  // Collapsed: thin vertical rail, quieter than the pipeline columns.
  // Expanded: header + All/Won/Lost toggle over the loaded window, cards
  // with a won/lost left-edge cue, and the List hand-off for the archive.
  const scopedClosedTotal = closedData?.total ?? (locFilter === 'all' ? closedCount : null)
  const renderClosedRail = () => {
    if (!closedOpen) {
      return (
        <button
          key="closed-rail"
          onClick={expandClosed}
          aria-label="Expand closed engagements"
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
            width: '34px', minHeight: '200px', padding: '12px 0', flexShrink: 0,
            border: '0.5px solid rgba(0,0,0,0.08)', borderRadius: '10px',
            background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <IconChevronRight size={12} style={{ transform: 'rotate(180deg)', color: '#b5b3ac' }} />
          <span style={{ writingMode: 'vertical-rl', ...SECTION_LABEL, color: '#8a8a84' }}>
            Closed<span style={SECTION_COUNT}> · {scopedClosedTotal ?? '…'}</span>
          </span>
        </button>
      )
    }
    const windowRows = closedData?.rows || []
    const segRows = closedSeg === 'won' ? windowRows.filter(e => e.stage === CLOSED_WON)
      : closedSeg === 'lost' ? windowRows.filter(e => e.stage === CLOSED_LOST)
      : windowRows
    return (
      <div key="closed-rail" style={{ width: '220px', flexShrink: 0, padding: '2px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline' }}>
            <span style={SECTION_LABEL}>Closed</span>
            <span style={{ ...SECTION_COUNT, marginLeft: '5px' }}>· {scopedClosedTotal ?? '…'}</span>
          </div>
          <button
            onClick={() => setClosedOpen(false)}
            aria-label="Collapse to pipeline"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', border: 'none', background: 'transparent', padding: 0, ...SECTION_COUNT, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
          >
            <IconChevronRight size={10} />
            Pipeline
          </button>
        </div>
        <div style={{ marginBottom: '8px' }}>
          <FilterChips
            items={[
              { key: 'all', label: 'All' },
              { key: 'won', label: 'Won', color: `var(--text-success, ${TEXT_SUCCESS})` },
              { key: 'lost', label: 'Lost', color: `var(--text-danger, ${TEXT_DANGER})` },
            ]}
            active={closedSeg}
            onChange={setClosedSeg}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {segRows.map(e => (
            <EngagementCard
              key={e.id}
              e={e}
              onOpen={() => openCard(e)}
              accent={e.stage === CLOSED_WON ? `var(--text-success, ${TEXT_SUCCESS})` : `var(--text-danger, ${TEXT_DANGER})`}
            />
          ))}
          {closedLoading && (
            <div style={{ padding: '14px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>Loading…</div>
          )}
          {!closedLoading && segRows.length === 0 && (
            <div style={{ padding: '14px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '10px' }}>
              Empty
            </div>
          )}
          {!closedLoading && closedData && closedData.total != null && closedData.rows.length < closedData.total && (
            <div style={{ fontSize: '11px', color: '#b5b3ac', padding: '2px 2px 8px' }}>
              Showing {closedData.rows.length} most recent ·{' '}
              <button
                onClick={onViewClosedInList}
                style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px' }}
              >
                view all in List
              </button>
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
      <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginBottom: '10px' }}>
        <EngagementFilters engagements={rows.filter(e => !isTerminal(e.stage))} filters={workFilters} setFilters={setWorkFilters} onClear={clearWorkFilters} nowMs={nowMs}
          sortValue={boardSort} sortOptions={BOARD_SORTS} onSortChange={(v) => setBoardSort({ key: v })} />
      </div>
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
            style={{ border: 'none', background: 'transparent', fontSize: '18px', color: mobileCol === 0 ? '#c9c7c0' : '#6b6b66', cursor: 'pointer', padding: '4px 8px' }}><IconChevronRight size={16} style={{ transform: 'rotate(180deg)' }} /></button>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <span style={{ fontSize: '12px', fontWeight: 500, color: '#6b6b66' }}>{stage.displayLabel}</span>
            <span style={{ fontSize: '12px', fontWeight: 400, color: '#b5b3ac', marginLeft: '5px' }}>· {count}</span>
          </div>
          <button onClick={() => setMobileCol(c => Math.min(BOARD_STAGES.length - 1, c + 1))} disabled={mobileCol === BOARD_STAGES.length - 1}
            style={{ border: 'none', background: 'transparent', fontSize: '18px', color: mobileCol === BOARD_STAGES.length - 1 ? '#c9c7c0' : '#6b6b66', cursor: 'pointer', padding: '4px 8px' }}><IconChevronRight size={16} /></button>
        </div>
        {renderColumn(stage, { droppable: false })}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '12px' }}>
          {BOARD_STAGES.map((s, i) => (
            <button key={s.key} onClick={() => setMobileCol(i)} aria-label={s.label}
              style={{ width: '7px', height: '7px', borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', background: i === mobileCol ? '#1a1a18' : 'rgba(0,0,0,0.15)' }} />
          ))}
        </div>
      </div>
      </div>
    )
  }

  const controls = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginBottom: '12px' }}>
      <EngagementFilters engagements={rows.filter(e => !isTerminal(e.stage))} filters={workFilters} setFilters={setWorkFilters} onClear={clearWorkFilters} nowMs={nowMs}
        sortValue={boardSort} sortOptions={BOARD_SORTS} onSortChange={(v) => setBoardSort({ key: v })} />
    </div>
  )

  return (
    <div>
      {controls}
      {visibleRows.length === 0 && filterCount > 0 ? (
        <FilteredEmpty count={filterCount} onClear={clearWorkFilters} noun="engagements" />
      ) : (
        <div style={{ overflowX: 'auto', paddingBottom: '1rem', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ display: 'flex', gap: '16px', minWidth: 'max-content', alignItems: 'flex-start' }}>
            {BOARD_STAGES.map(stage => renderColumn(stage, { droppable: true }))}
            {renderClosedRail()}
          </div>
        </div>
      )}
    </div>
  )
}
