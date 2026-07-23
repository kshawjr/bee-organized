// components/hive/EngagementGroupedList.jsx
// ─────────────────────────────────────────────────────────────
// HIVE — the List lens on engagements (nav restructure 2026-07-18), the
// grouped color-band presentation (approved mockup). One vertical list,
// grouped by STAGE in board order (Request → Estimate → Job in progress →
// Final processing), each group a tinted band whose colored header carries
// a status dot + stage name + count, with the engagement rows sitting on
// white cards inside the band.
//
// COLLAPSIBLE (2026-07-19): every band header toggles its rows. Groups start
// COLLAPSED, and each group remembers its own last choice — persisted per
// group id under one keyed store (bee_hive_eng_collapsed, SSR-safe via
// useStoredState, separate from Client List's memory). A COLLAPSED group
// renders only its header (no hidden rows) — the whole list stays light, and
// the Closed group's thousands never mount until it's opened.
//
// SAME data, SAME source as the board — NOT a divergent lens:
//   · band tint + dot come from CHIP_STYLES[stage] (shared/stageConfig —
//     the ONE per-stage color source the board's chips already read), so
//     board and list can never disagree on a stage's color.
//   · rows reuse the board card's data mapping (deriveStatusChip /
//     displayTitle / engagementValue / fmtMoney) — no new fetch, no new
//     mapper.
//   · a row click opens the SAME EngagementPanel the board opens
//     (onOpenEngagement), threaded up through HiveShell.
//   · the Closed group lazy-loads its rows from the SAME path the board's
//     closed rail uses (GET /api/engagements?closed=1&limit=…) — fetched on
//     first expand, so nothing closed renders until it's opened.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { ENGAGEMENT_STAGES, CHIP_STYLES, isTerminal, stageDisplayLabel, CLOSED_WON } from './shared/stageConfig'
import { T } from './shared/tokens'
import { TEXT_MUTED } from '@/components/ui/tokens'
import StatusChip from '@/components/ui/StatusChip'
import { statusIconFor, IconChevronRight } from '@/components/ui/icons'
import LoadMore from './shared/LoadMore'
import EngagementFilters from './EngagementFilters'
import {
  deriveStatusChip, displayTitle, engagementValue, fmtMoney, lastActivityTs,
  ENGAGEMENT_FILTER_DEFAULTS, passesEngagementFilters, engagementFilterCount,
} from './shared/engagementStatus'
import { FilteredEmpty } from './shared/FilterPopover'
import { useStoredState } from './shared/useStoredControls'
import useIsMobile from './shared/useIsMobile'
import BeeLoader from './shared/BeeLoader'

const OPEN_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal)
const CLOSED_WINDOW = 50
// The Closed group's stable id in the collapse store (the open bands key on
// their stage.key).
const CLOSED_GID = 'closed'

// A small filled dot in the stage's dark stop — the same colored marker
// the board reads for the stage, sourced from CHIP_STYLES (never a literal).
function StageDot({ color }) {
  return <span aria-hidden style={{ width: '9px', height: '9px', borderRadius: T.radius.round, background: color, display: 'inline-block', flexShrink: 0 }} />
}

// One engagement row — a white card floating on the band tint. Layout and
// data mirror the board card (name · value · title · status · repeat) so the
// two lenses read identically; `muted` dims closed rows.
function EngagementRow({ e, nowMs, muted = false, onOpen, isMobile }) {
  const chip = deriveStatusChip(e, { longForm: true, nowMs })
  const rawValue = engagementValue(e)
  const value = rawValue != null ? fmtMoney(rawValue) : null
  const isNew = e.repeat_count === 1 && (nowMs - new Date(e.created_at).getTime()) < 30 * 86400000
  const closed = isTerminal(e.stage)
  return (
    <div
      className="bee-grp-row"
      onClick={() => onOpen(e)}
      style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset,
        padding: isMobile ? '11px 12px' : '11px 14px', cursor: 'pointer',
        opacity: muted ? 0.72 : 1, transition: 'border-color 0.15s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 600, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.client_name}</span>
          {isMobile && value && (
            <span style={{ fontSize: '14px', fontWeight: 600, color: T.ink.primary, fontVariantNumeric: T.type.tabular, letterSpacing: T.type.trackNum, flexShrink: 0 }}>{value}</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px', minWidth: 0 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: `var(--text-muted, ${TEXT_MUTED})` }}>{displayTitle(e)}</span>
          {/* closed rows carry their terminal stage chip; open rows carry the
              within-stage status chip (Sent / Scheduled / Approved …) */}
          {closed
            ? <StatusChip label={stageDisplayLabel(e.stage)} styleKey={e.stage} />
            : (chip && <StatusChip label={chip.label} styleKey={chip.styleKey} icon={statusIconFor(chip.styleKey)} />)}
          {e.repeat_count > 1 && <StatusChip label={`repeat · ${e.repeat_count - 1} prior`} styleKey="repeat" />}
          {isNew && !closed && <StatusChip label="new" styleKey="teal" />}
        </div>
      </div>
      {!isMobile && (
        <span style={{ flexShrink: 0, fontSize: '14px', fontWeight: 600, color: value ? T.ink.primary : T.ink.quiet, fontVariantNumeric: T.type.tabular, letterSpacing: T.type.trackNum, textAlign: 'right' }}>{value || '—'}</span>
      )}
    </div>
  )
}

// A tinted color band with a colored, clickable header (dot + name + count +
// chevron) and its rows on white cards. The chevron points down when
// expanded, right when collapsed; its color matches the band (fam.text).
// Collapsed → children are not rendered at all.
function StageBand({ stageKey, gid, label, count, expanded, onToggle, children }) {
  const fam = CHIP_STYLES[stageKey] || CHIP_STYLES.gray
  return (
    <div id={gid ? `bee-eng-band-${gid}` : undefined} style={{ background: fam.bg, borderRadius: T.radius.card, padding: '10px 10px 12px', marginBottom: '12px', scrollMarginTop: '12px' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${label} group`}
        onClick={onToggle}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggle() } }}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 4px 8px', cursor: 'pointer' }}
      >
        <StageDot color={fam.text} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: fam.text, whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ fontSize: '12px', fontWeight: 500, color: fam.text, opacity: 0.7, fontVariantNumeric: T.type.tabular }}>· {count}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', color: fam.text }}>
          <IconChevronRight size={14} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
        </span>
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {children}
        </div>
      )}
    </div>
  )
}

export default function EngagementGroupedList({
  engagements = [], closedCount = 0, closedWonCount = 0, locFilter = 'all',
  workFilters = ENGAGEMENT_FILTER_DEFAULTS, setWorkFilters = () => {}, clearWorkFilters = () => {},
  onOpenEngagement = () => {}, setToast = () => {}, initialView = null, onInitialViewConsumed = () => {},
}) {
  const isMobile = useIsMobile()
  const nowMs = Date.now()

  // Per-group collapse memory — one keyed store, gid → true when EXPANDED.
  // Absent = collapsed, so the first visit (empty store) is all-collapsed.
  const [expandedMap, setExpandedMap] = useStoredState('bee_hive_eng_collapsed', {})
  const isExp = (gid) => expandedMap[gid] === true
  const toggle = (gid) => setExpandedMap(prev => ({ ...prev, [gid]: !prev[gid] }))
  const closedExpanded = isExp(CLOSED_GID)

  // Closed rows lazy-load on first expand; cached until the location moves.
  const [closedData, setClosedData] = useState(null) // { rows, total }
  const [closedLoading, setClosedLoading] = useState(false)

  async function fetchClosed(offset = 0) {
    setClosedLoading(true)
    try {
      const params = new URLSearchParams({ closed: '1', offset: String(offset), limit: String(CLOSED_WINDOW) })
      if (locFilter !== 'all') params.set('location_uuid', locFilter)
      const res = await fetch(`/api/engagements?${params}`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setClosedData(prev => ({
        rows: offset === 0 ? (j.rows || []) : [...(prev?.rows || []), ...(j.rows || [])],
        total: j.total ?? null,
      }))
    } catch (err) {
      setToast({ kind: 'error', msg: `Closed engagements failed to load: ${err.message}` })
    } finally {
      setClosedLoading(false)
    }
  }

  // Fetch whenever the Closed group is (or becomes) expanded with no window
  // loaded — covers both the toggle click AND a persisted expanded state
  // rehydrating on mount.
  useEffect(() => {
    if (closedExpanded && !closedData && !closedLoading) fetchClosed(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedExpanded])

  // Location scope moved → drop the cached window; the effect above refetches
  // for the new scope if the group is still expanded.
  useEffect(() => { setClosedData(null) }, [locFilter])

  // One-shot deep-link seed → force-expand a target band and scroll it into
  // view (runs after the store's own hydration effect, so it wins). Two
  // callers share this seam:
  //   · the board's closed rail ("view all in List") passes 'closed'
  //   · a Home "Needs attention" deep-link passes a STAGE KEY (e.g. 'Estimate',
  //     'Final Processing') to land pre-expanded on that group — the bands
  //     start collapsed, so without this a deep-link would land on a closed
  //     band showing nothing.
  // The gid an open band keys on IS its stage.key; the Closed band keys on
  // CLOSED_GID. scrollIntoView on the next frame, after the expand has laid
  // the band out.
  useEffect(() => {
    if (!initialView) return
    const gid = initialView === 'closed' ? CLOSED_GID : initialView
    setExpandedMap(prev => ({ ...prev, [gid]: true }))
    if (typeof window !== 'undefined' && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const el = document.getElementById(`bee-eng-band-${gid}`)
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
    onInitialViewConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Open rows: shared filters applied (so switching board↔list keeps the
  // subset), ordered newest-activity-first within each stage — the board's
  // default column order.
  const openRows = engagements.filter(e => !isTerminal(e.stage) && passesEngagementFilters(e, workFilters, nowMs))
  const byStage = (key) => openRows.filter(e => e.stage === key).sort((a, b) => lastActivityTs(b) - lastActivityTs(a))

  const filterCount = engagementFilterCount(workFilters)
  const notTerminal = engagements.filter(e => !isTerminal(e.stage))
  const scopedClosedTotal = closedData?.total ?? (locFilter === 'all' ? closedCount : null)

  return (
    <div>
      <style>{`.bee-grp-row:hover { border-color:${T.hairline.strong} }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginBottom: '12px' }}>
        <EngagementFilters engagements={notTerminal} filters={workFilters} setFilters={setWorkFilters} onClear={clearWorkFilters} nowMs={nowMs} />
      </div>

      {openRows.length === 0 && filterCount > 0 ? (
        <FilteredEmpty count={filterCount} onClear={clearWorkFilters} noun="engagements" />
      ) : (
        OPEN_STAGES.map(s => {
          const rows = byStage(s.key)
          const expanded = isExp(s.key)
          return (
            <StageBand key={s.key} stageKey={s.key} gid={s.key} label={s.displayLabel} count={rows.length}
              expanded={expanded} onToggle={() => toggle(s.key)}>
              {rows.length === 0
                ? <div style={{ padding: '8px 4px', fontSize: '12px', color: T.ink.quiet }}>None in this stage</div>
                : rows.map(e => <EngagementRow key={e.id} e={e} nowMs={nowMs} onOpen={onOpenEngagement} isMobile={isMobile} />)}
            </StageBand>
          )
        })
      )}

      {/* Closed group — always at the bottom, lazy-loaded on first expand */}
      <StageBand
        stageKey={CLOSED_WON} gid={CLOSED_GID} label="Closed" count={scopedClosedTotal ?? '…'}
        expanded={closedExpanded} onToggle={() => toggle(CLOSED_GID)}
      >
        {(closedData?.rows || []).map(e => (
          <EngagementRow key={e.id} e={e} nowMs={nowMs} muted onOpen={onOpenEngagement} isMobile={isMobile} />
        ))}
        {closedLoading && (!closedData || (closedData.rows || []).length === 0) && (
          <BeeLoader label="Gathering closed engagements…" />
        )}
        {!closedLoading && closedData && (closedData.rows || []).length === 0 && (
          <div style={{ padding: '8px 4px', fontSize: '12px', color: T.ink.quiet }}>No closed engagements in this view</div>
        )}
        {closedData && closedData.total != null && (closedData.rows || []).length < closedData.total && !closedLoading && (
          <LoadMore pageSize={CLOSED_WINDOW} remaining={closedData.total - closedData.rows.length}
            onClick={() => fetchClosed(closedData.rows.length)} />
        )}
      </StageBand>
    </div>
  )
}
