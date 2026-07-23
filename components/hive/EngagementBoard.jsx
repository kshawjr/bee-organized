// components/hive/EngagementBoard.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the engagement board (doc §7), first read flip.
// One card per OPEN engagement; columns from ENGAGEMENT_STAGES with
// terminals filtered. Reads the initialEngagements rows shipped by
// app/_hub-page.tsx (client_name, repeat_count, minimal quotes/jobs/
// invoices for chips).
//
// NO manual pipeline moves (decision 2026-07-10, Kevin): all business
// flows through Jobber — a local engagement's stage assertion is always
// fiction, so pipeline stages move ONLY via the Jobber derivation
// (webhooks / import / drift recovery). The old local-card pipeline
// drag (drop on a column → PATCH { stage }) was removed 7/10 alongside
// the panel's Advance button; pipeline columns are no longer drop
// targets for ANY card. Dragging exists solely to reach the close rail.
//
// CLOSE drags (both linked AND local): while a drag is live the closed
// rail becomes two drop zones (won / lost). Dropping there does NOT
// commit — the card visually lands in a pending closed column and the
// SHARED human close flow (shared/CloseEngagementConfirm — the same
// component + PATCH the panel's ··· menu Close uses) opens. Confirm
// commits the terminal stage; Cancel snaps the card back to its prior
// column with no write. Order is drop → popup → commit-or-revert; the
// stage is NEVER committed on drop. leads.stage is never touched from
// here. Mobile is one column at a time (swipe/arrows + pager dots) —
// no drag; closes happen from the engagement panel's ··· menu.
//
// Card click opens the CLIENT (PersonPanel) via onOpenClient — the
// EngagementPanel replaces that seam next screen (see TODO below).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useRef } from 'react'
import { ENGAGEMENT_STAGES, isTerminal, CLOSED_WON, CLOSED_LOST } from './shared/stageConfig'
import { T } from './shared/tokens'
import { SECTION_LABEL, SECTION_COUNT, TEXT_SUCCESS, TEXT_DANGER, TEXT_MUTED } from '@/components/ui/tokens'
import FilterChips from '@/components/ui/FilterChips'
// THE shared status derivation — board cards and list rows consume the
// same module so the two lenses can never disagree.
import { deriveStatusChip, displayTitle, engagementValue, fmtMoney } from './shared/engagementStatus'
import CloseEngagementConfirm from './shared/CloseEngagementConfirm'
import StatusChip from '@/components/ui/StatusChip'
import Card from '@/components/ui/Card'
import SectionHeader from '@/components/ui/SectionHeader'
import { statusIconFor, IconChevronRight } from '@/components/ui/icons'
import EngagementFilters from './EngagementFilters'
import { ENGAGEMENT_FILTER_DEFAULTS, passesEngagementFilters, engagementFilterCount, lastActivityTs, engagementValue as engValueOf } from './shared/engagementStatus'
import { FilteredEmpty } from './shared/FilterPopover'
import { useStoredState } from './shared/useStoredControls'
import useIsMobile from './shared/useIsMobile'
import BeeLoader from './shared/BeeLoader'

const BOARD_SORTS = [
  { key: 'newest', label: 'Newest activity' },
  { key: 'oldest', label: 'Oldest activity' },
  { key: 'value_desc', label: 'Highest value' },
  { key: 'value_asc', label: 'Lowest value' },
  { key: 'client', label: 'Client A–Z' },
]

const BOARD_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal)

// Closed rail (5th column, desktop): the board only ever loads RECENT
// WINDOWS of closed engagements — there are ~1,500 terminal rows and the
// board is a working surface, not the archive (that's the List). EACH
// All/Won/Lost segment fetches its OWN window, server-narrowed exactly
// like the List's filters (GET /api/engagements?closed=1[&stage=won|lost]
// &limit=40 — explicit .range() server-side, never a bare .select(), the
// 1000-row silent-truncation gotcha), cached per segment until the
// location scope changes or a close commits.
//
// Why per-segment (2026-07-10): the old design fetched ONE mixed window
// and narrowed it in memory — bulk imports stamp their stale_on_import
// losses with the import MOMENT, so a freshly-imported location's mixed
// window was 40/40 Lost and the Won segment rendered empty despite 88
// historical wins (NW Arkansas). The bound is a COUNT cap over
// most-recently-closed-first — never a date window, so historical closes
// always surface.
const CLOSED_WINDOW = 40

// Card typography (LOCKED): name 13px/500 near-black, subtitle 11px muted,
// value 12px/500. 100% sans — no serif inside the board.
function EngagementCard({ e, onOpen, draggable, onDragStart, onDragEnd, accent = null }) {
  const chip = deriveStatusChip(e)
  const rawValue = engagementValue(e)
  const value = rawValue != null ? fmtMoney(rawValue) : null
  return (
    // The card lift (raised surface + warm border + two-layer shadow)
    // lives in ui/Card itself — one primitive, no double chrome here.
    <div draggable={draggable || undefined} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <Card onClick={onOpen} accent={accent}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '3px' }}>
          <p style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {e.client_name}
          </p>
          {value && <span style={{ fontSize: '12px', fontWeight: 500, color: T.ink.primary, fontVariantNumeric: T.type.tabular, letterSpacing: T.type.trackNum, flexShrink: 0 }}>{value}</span>}
        </div>
        <p style={{ fontSize: '11px', color: `var(--text-muted, ${TEXT_MUTED})`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '8px' }}>
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

export default function EngagementBoard({ engagements = [], closedCount = 0, reopenedIds = [], locFilter = 'all', workFilters = ENGAGEMENT_FILTER_DEFAULTS, setWorkFilters = () => {}, clearWorkFilters = () => {}, onOpenClient = () => {}, onOpenEngagement = null, onViewClosedInList = () => {}, onChanged = () => {}, setToast = () => {}, lookupOptions = { sources: [], projectTypes: [], closeLostReasons: [] }, readOnly = false }) {
  // Local rows for optimistic drag moves; resync when the server prop changes.
  const [rows, setRows] = useState(engagements)
  useEffect(() => { setRows(engagements) }, [engagements])

  const isMobile = useIsMobile()

  const [mobileCol, setMobileCol] = useState(0)
  const [dragOverCol, setDragOverCol] = useState(null)
  const dragId = useRef(null)
  const touchX = useRef(null)

  // Live-drag state (state, not just the ref — the won/lost close drop
  // zones render only while a card is in the air) and the PENDING close:
  // the drop landed but NOTHING has committed — the confirm popup owns
  // what happens next (confirm → PATCH, cancel → snap back).
  const [dragging, setDragging] = useState(false)
  const [pendingClose, setPendingClose] = useState(null) // { eng, target, prevStage }

  // Closed rail state — collapsed by default every mount (it's an
  // archive peek, not a pinned lens). Each segment's window is fetched
  // on first visit and cached; revisiting a segment never refetches.
  const [closedOpen, setClosedOpen] = useState(false)
  const [closedSeg, setClosedSeg] = useState('all')     // 'all' | 'won' | 'lost'
  const [closedData, setClosedData] = useState({})      // per segment: { rows, total }
  const [closedLoading, setClosedLoading] = useState({}) // per segment: bool

  async function fetchClosedWindow(seg) {
    setClosedLoading(l => ({ ...l, [seg]: true }))
    try {
      const params = new URLSearchParams({ closed: '1', offset: '0', limit: String(CLOSED_WINDOW) })
      // Server-narrowed won/lost — the same stage param the List's
      // filters ride; 'all' omits it (route default = both stages).
      if (seg !== 'all') params.set('stage', seg)
      if (locFilter !== 'all') params.set('location_uuid', locFilter)
      const res = await fetch(`/api/engagements?${params}`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setClosedData(prev => ({ ...prev, [seg]: { rows: j.rows || [], total: j.total ?? null } }))
    } catch (err) {
      setToast({ kind: 'error', msg: `Closed engagements failed to load: ${err.message}` })
    } finally {
      setClosedLoading(l => ({ ...l, [seg]: false }))
    }
  }

  // Windows are per location scope — drop them when the switcher moves.
  useEffect(() => { setClosedData({}); setClosedSeg('all') }, [locFilter])

  function expandClosed() {
    setClosedOpen(true)
    if (!closedData[closedSeg] && !closedLoading[closedSeg]) fetchClosedWindow(closedSeg)
  }

  function pickClosedSeg(seg) {
    setClosedSeg(seg)
    if (!closedData[seg] && !closedLoading[seg]) fetchClosedWindow(seg)
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

  // ── drag-to-close (PENDING, not committed) ────────────────────
  // Drop → the card optimistically leaves its pipeline column and lands
  // in a pending closed column with the shared confirm open. The
  // terminal PATCH fires ONLY from the confirm button (inside
  // CloseEngagementConfirm — the same write path as the panel's ···
  // Close); cancel restores the prior column with zero writes. Both
  // linked and local cards close this way — there is no Jobber
  // auto-Lost, so closing is always a human act.
  function beginClose(id, target) {
    const row = rows.find(r => r.id === id)
    if (!row || isTerminal(row.stage)) return
    setPendingClose({ eng: row, target, prevStage: row.stage })
    setRows(rs => rs.map(r => r.id === id ? { ...r, stage: target } : r))
  }

  function cancelPendingClose() {
    if (!pendingClose) return
    const { eng, prevStage } = pendingClose
    setRows(rs => rs.map(r => r.id === eng.id ? { ...r, stage: prevStage } : r))
    setPendingClose(null)
  }

  function confirmedClose(stage) {
    if (!pendingClose) return
    const { eng } = pendingClose
    setRows(rs => rs.map(r => r.id === eng.id ? { ...r, stage } : r))
    setPendingClose(null)
    // Any loaded closed windows predate this close — drop them so the
    // next rail expand refetches with the new row included.
    setClosedData({})
    // Hand the terminal stage UP so HiveShell's merged set (open-count
    // header, List lens) drops the row too — the board's local `rows` alone
    // never reaches those lenses.
    onChanged(eng.id, { stage })
  }

  function openCard(e) {
    // EngagementPanel is the click-through (HiveShell passes
    // onOpenEngagement); PersonPanel remains the fallback for any
    // legacy mount without the panel wiring.
    if (onOpenEngagement) onOpenEngagement(e)
    else onOpenClient(e.client_id)
  }

  // Pipeline columns are NOT drop targets (7/10 decision — no manual
  // stage moves); cards stay draggable only to reach the close rail.
  const renderColumn = (stage) => {
    const cards = byStage(stage.key)
    return (
      <div
        key={stage.key}
        data-board-col={stage.key}
        style={{
          width: isMobile ? '100%' : '220px', flexShrink: 0,
          borderRadius: T.radius.inset,
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
              draggable={!isMobile && !readOnly}
              onDragStart={!isMobile && !readOnly ? () => { dragId.current = e.id; setDragging(true) } : undefined}
              onDragEnd={!isMobile && !readOnly ? () => { setDragging(false); setDragOverCol(null) } : undefined}
            />
          ))}
          {cards.length === 0 && (
            <div style={{ padding: '14px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px', border: T.border.dashedSoft, borderRadius: T.radius.inset }}>
              Empty
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Close drop zones (desktop, live-drag only) ────────────────
  // While a card is in the air the closed rail's slot becomes two drop
  // targets — won and lost. Dropping opens the pending close flow
  // (beginClose); it never PATCHes directly.
  const CLOSE_ZONES = [
    { target: CLOSED_WON, label: 'Closed won', aria: 'Close as won', color: `var(--text-success, ${TEXT_SUCCESS})`, tint: T.state.success.wash },
    { target: CLOSED_LOST, label: 'Closed lost', aria: 'Close as lost', color: `var(--text-danger, ${TEXT_DANGER})`, tint: T.state.danger.wash },
  ]
  const renderCloseZones = () => (
    <div key="closed-rail" style={{ width: '220px', flexShrink: 0, padding: '2px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader label="Close" count={null} />
      {CLOSE_ZONES.map(z => (
        <div
          key={z.target}
          aria-label={z.aria}
          onDragOver={(ev) => { ev.preventDefault(); setDragOverCol(z.target) }}
          onDragLeave={() => setDragOverCol(null)}
          onDrop={(ev) => {
            ev.preventDefault()
            setDragOverCol(null)
            if (dragId.current) beginClose(dragId.current, z.target)
            dragId.current = null
            setDragging(false)
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: '96px', borderRadius: T.radius.inset,
            border: `1.5px dashed ${z.color}`,
            background: dragOverCol === z.target ? z.tint : 'transparent',
            fontSize: '12px', fontWeight: 500, color: z.color,
          }}
        >
          {z.label}
        </div>
      ))}
    </div>
  )

  // ── Pending close column (drop landed, popup open) ────────────
  // The card sits in the closed column visually while NOTHING is
  // committed; the shared confirm decides. Cancel puts it back.
  const renderPendingClose = () => {
    const { eng: pendingEng, target, prevStage } = pendingClose
    const zone = CLOSE_ZONES.find(z => z.target === target)
    return (
      <div key="closed-rail" style={{ width: '220px', flexShrink: 0, padding: '2px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SectionHeader label={target === CLOSED_WON ? 'Closing — won' : 'Closing — lost'} count={null} />
        <EngagementCard e={{ ...pendingEng, stage: prevStage }} onOpen={() => {}} accent={zone.color} />
        <CloseEngagementConfirm
          engagementId={pendingEng.id}
          invoices={pendingEng.invoices || []}
          reasons={lookupOptions?.closeLostReasons || []}
          initialCloseAs={target}
          onCancel={cancelPendingClose}
          onClosed={(stage) => confirmedClose(stage)}
          setToast={setToast}
          readOnly={readOnly}
        />
      </div>
    )
  }

  // ── Closed rail (desktop 5th column) ─────────────────────────
  // Collapsed: thin vertical rail, quieter than the pipeline columns.
  // Expanded: header + All/Won/Lost toggle, each segment over its OWN
  // server-narrowed window, cards with a won/lost left-edge cue, and the
  // List hand-off for the archive.
  const scopedClosedTotal = closedData.all?.total ?? (locFilter === 'all' ? closedCount : null)
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
            // Display-only presence (Part 5): a filled NEUTRAL gray tint
            // (the closed/past chip family — never red/green; the rail
            // holds won+lost mixed) + a slightly stronger border than the
            // pipeline columns' hairline, so the collapsed rail reads as a
            // real "Closed" column against the warm canvas instead of
            // washing into it. Still secondary — muted, thin, collapsed.
            border: T.border.control, borderRadius: T.radius.inset,
            background: T.family.gray.bg, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <IconChevronRight size={12} style={{ transform: 'rotate(180deg)', color: T.ink.quiet }} />
          <span style={{ writingMode: 'vertical-rl', ...SECTION_LABEL, color: T.ink.muted }}>
            Closed<span style={SECTION_COUNT}> · {scopedClosedTotal ?? '…'}</span>
          </span>
        </button>
      )
    }
    // Each segment renders its own server-narrowed window — no in-memory
    // stage filtering (that design starved Won behind 40 recent losses).
    const segData = closedData[closedSeg]
    // Evict rows reopened this session — the fetched window predates the
    // reopen, so drop them here rather than force a rail refetch (HiveShell
    // owns reopenedIds; the row already shows in the open columns).
    const segRows = (segData?.rows || []).filter(r => !reopenedIds.includes(r.id))
    const segLoading = !!closedLoading[closedSeg]
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
            onChange={pickClosedSeg}
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
          {segLoading && (
            <BeeLoader label="Gathering closed deals…" />
          )}
          {!segLoading && segRows.length === 0 && (
            <div style={{ padding: '14px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px', border: T.border.dashedSoft, borderRadius: T.radius.inset }}>
              Empty
            </div>
          )}
          {!segLoading && segData && segData.total != null && segRows.length < segData.total && (
            <div style={{ fontSize: '11px', color: T.ink.quiet, padding: '2px 2px 8px' }}>
              Showing {segRows.length} most recent ·{' '}
              <button
                onClick={onViewClosedInList}
                style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '11px', color: T.ink.muted, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px' }}
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
            style={{ border: 'none', background: 'transparent', fontSize: '18px', color: mobileCol === 0 ? T.ink.faint : T.ink.secondary, cursor: 'pointer', padding: '4px 8px' }}><IconChevronRight size={16} style={{ transform: 'rotate(180deg)' }} /></button>
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
            <SectionHeader label={stage.displayLabel} count={count} style={{ marginBottom: 0 }} />
          </div>
          <button onClick={() => setMobileCol(c => Math.min(BOARD_STAGES.length - 1, c + 1))} disabled={mobileCol === BOARD_STAGES.length - 1}
            style={{ border: 'none', background: 'transparent', fontSize: '18px', color: mobileCol === BOARD_STAGES.length - 1 ? T.ink.faint : T.ink.secondary, cursor: 'pointer', padding: '4px 8px' }}><IconChevronRight size={16} /></button>
        </div>
        {renderColumn(stage)}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '12px' }}>
          {BOARD_STAGES.map((s, i) => (
            <button key={s.key} onClick={() => setMobileCol(i)} aria-label={s.label}
              style={{ width: '7px', height: '7px', borderRadius: T.radius.round, border: 'none', padding: 0, cursor: 'pointer', background: i === mobileCol ? T.ink.primary : T.hairline.control }} />
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
            {BOARD_STAGES.map(stage => renderColumn(stage))}
            {/* 5th-column slot: pending close (popup open) > live-drag
                drop zones > the closed rail. */}
            {!readOnly && pendingClose ? renderPendingClose() : !readOnly && dragging ? renderCloseZones() : renderClosedRail()}
          </div>
        </div>
      )}
    </div>
  )
}
