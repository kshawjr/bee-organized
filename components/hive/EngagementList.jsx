// components/hive/EngagementList.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the flat list lens on engagements (doc §7,
// LOCKED list mockup). Same rows the board shows (locFilter applied
// upstream in HiveShell), same shared status derivation, same panel on
// row click. 'Closed' is lazy: only a server count ships up-front; the
// rows page in on demand via GET /api/engagements?closed=1.
//
// Controls: sortable CLIENT/VALUE/ACTIVITY headers + a full-dimension
// Filters popover (stage multi, status multi derived from the loaded
// set, value min/max, quiet age, owing/repeat/new toggles, founded_by).
// Sort + filters PERSIST via localStorage (SSR-safe hydration, same
// pattern as the shell lens). Stage chips = quick single-stage; the
// popover's stage checkboxes are the multi — one state, kept in sync.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { ENGAGEMENT_STAGES, STAGE_RANK, CHIP_STYLES, stageDisplayLabel } from './shared/stageConfig'
import { deriveStatusChip, displayTitle, engagementValue, fmtMoney, lastActivityTs, relAge } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import FilterChips from '@/components/ui/FilterChips'
import { statusIconFor } from '@/components/ui/icons'
import EngagementFilters from './EngagementFilters'
import { ENGAGEMENT_FILTER_DEFAULTS, engagementFilterCount, passesEngagementFilters } from './shared/engagementStatus'
import { SortChevrons, SortHeaderStyle, FilteredEmpty } from './shared/FilterPopover'
import { useStoredState } from './shared/useStoredControls'

const OPEN_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal)
const CHIP_LABELS = { 'Request': 'Request', 'Estimate': 'Estimate', 'Job in Progress': 'Job', 'Final Processing': 'Final' }
const PAGE = 200
const SORT_LS_KEY = 'bee_hive_list_sort'
const SORT_COLS = ['default', 'client', 'engagement', 'stage', 'status', 'value', 'activity']

// Desktop grid: CLIENT | ENGAGEMENT | STAGE | STATUS | VALUE | ACTIVITY
const GRID = 'minmax(150px,1.2fr) minmax(140px,1.4fr) 130px minmax(150px,1.2fr) 90px 70px'

function statusFragment(chip) {
  if (!chip) return null
  const color = (CHIP_STYLES[chip.styleKey] || CHIP_STYLES.gray).text
  let label = chip.label
  if (chip.styleKey === 'owing') {
    const m = label.match(/^owing\s+(\$[\d,]+)$/)
    if (m) label = `${m[1]} owing`
  }
  return { color, label, icon: chip.styleKey === 'gray' ? null : statusIconFor(chip.styleKey) }
}

function StatusText({ chip, size = 12 }) {
  const f = statusFragment(chip)
  if (!f) return null
  return (
    <span style={{ fontSize: `${size}px`, fontWeight: 500, color: f.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      {f.icon}
      {f.label}
    </span>
  )
}

function ClientCell({ e, nowMs }) {
  const isNew = e.repeat_count === 1 && (nowMs - new Date(e.created_at).getTime()) < 30 * 86400000
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
      <span style={{ fontSize: '14px', fontWeight: 600, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.client_name}</span>
      {e.repeat_count > 1 && <StatusChip label="repeat" styleKey="repeat" />}
      {isNew && <StatusChip label="new" styleKey="teal" />}
    </div>
  )
}

export default function EngagementList({ engagements = [], closedCount = 0, locFilter = 'all', workFilters = ENGAGEMENT_FILTER_DEFAULTS, setWorkFilters = () => {}, clearWorkFilters = () => {}, onOpenEngagement = () => {}, setToast = () => {} }) {
  const [view, setView] = useState('open')             // 'open' | 'closed'
  const [sortRaw, setSort, ] = useStoredState(SORT_LS_KEY, { col: 'default', dir: 'desc' })
  const sort = SORT_COLS.includes(sortRaw.col) && ['asc', 'desc'].includes(sortRaw.dir) ? sortRaw : { col: 'default', dir: 'desc' }
  const filters = workFilters
  const [closedRows, setClosedRows] = useState(null)   // per active scope
  const [closedTotal, setClosedTotal] = useState(null) // scoped total once known
  const [loadingClosed, setLoadingClosed] = useState(false)
  const nowMs = Date.now()

  // SSR-safe mobile detection (BeeHub pattern).
  const [windowWidth, setWindowWidth] = useState(0)
  useEffect(() => {
    const check = () => setWindowWidth(window.innerWidth)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const isMobile = windowWidth > 0 && windowWidth < 768

  // Closed cache is per location scope — reset when the switcher moves.
  useEffect(() => { setClosedRows(null); setClosedTotal(null); if (view === 'closed') setView('open') }, [locFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchClosed(offset = 0) {
    setLoadingClosed(true)
    try {
      const params = new URLSearchParams({ closed: '1', offset: String(offset), limit: String(PAGE) })
      if (locFilter !== 'all') params.set('location_uuid', locFilter)
      const res = await fetch(`/api/engagements?${params}`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setClosedRows(prev => offset === 0 ? j.rows : [...(prev || []), ...j.rows])
      setClosedTotal(j.total ?? null)
    } catch (e) {
      setToast({ kind: 'error', msg: `Closed engagements failed to load: ${e.message}` })
    } finally {
      setLoadingClosed(false)
    }
  }

  // Chip counts reconcile with visible rows: base = rows passing every
  // filter EXCEPT the stage dimension, so a chip click predicts its count.
  const chipBase = engagements.filter(e => passesEngagementFilters(e, filters, nowMs, { ignoreStages: true }))
  const counts = { open: chipBase.length }
  for (const s of OPEN_STAGES) counts[s.key] = chipBase.filter(e => e.stage === s.key).length
  const scopedClosedCount = closedTotal ?? (locFilter === 'all' ? closedCount : null)

  const chips = [
    { key: 'open', label: 'Open', count: counts.open },
    ...OPEN_STAGES.map(s => ({ key: s.key, label: CHIP_LABELS[s.key], count: counts[s.key] })),
    { key: 'closed', label: 'Closed', count: scopedClosedCount ?? '…', muted: true },
  ]
  // Chips reflect the popover's stage state: exactly one stage selected →
  // that chip; none → 'Open'; several → no chip highlights (multi shows
  // on the Filters count instead).
  const activeChip = view === 'closed' ? 'closed'
    : filters.stages.length === 1 ? filters.stages[0]
    : filters.stages.length === 0 ? 'open'
    : '__multi__'

  function pickChip(key) {
    if (key === 'closed') {
      setView('closed')
      if (closedRows === null && !loadingClosed) fetchClosed(0)
      return
    }
    setView('open')
    setWorkFilters(f => ({ ...f, stages: key === 'open' ? [] : [key] }))
  }

  const showingClosed = view === 'closed'
  const activeFilterCount = engagementFilterCount(filters)
  const clearFilters = clearWorkFilters

  const sortRows = (arr) => {
    const sorted = arr.slice()
    const dir = sort.dir === 'asc' ? 1 : -1
    if (sort.col === 'client') sorted.sort((a, b) => dir * (a.client_name || '').localeCompare(b.client_name || ''))
    else if (sort.col === 'engagement') sorted.sort((a, b) => dir * displayTitle(a).localeCompare(displayTitle(b)))
    else if (sort.col === 'stage') sorted.sort((a, b) => dir * ((STAGE_RANK[a.stage] ?? 0) - (STAGE_RANK[b.stage] ?? 0)))
    else if (sort.col === 'status') sorted.sort((a, b) => dir * String(deriveStatusChip(a, { nowMs })?.styleKey || '').localeCompare(String(deriveStatusChip(b, { nowMs })?.styleKey || '')))
    else if (sort.col === 'value') sorted.sort((a, b) => dir * ((engagementValue(a) ?? 0) - (engagementValue(b) ?? 0)))
    else if (sort.col === 'activity') sorted.sort((a, b) => dir * (lastActivityTs(a) - lastActivityTs(b)))
    else sorted.sort((a, b) =>
      (STAGE_RANK[a.stage] ?? 0) - (STAGE_RANK[b.stage] ?? 0) ||
      lastActivityTs(b) - lastActivityTs(a))
    return sorted
  }

  const rows = showingClosed
    ? sortRows(closedRows || [])
    : sortRows(engagements.filter(e => passesEngagementFilters(e, filters, nowMs)))

  const clickSort = (col) => {
    setSort(s => s.col === col
      ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: ['client', 'engagement'].includes(col) ? 'asc' : 'desc' })
  }

  const headerCell = { fontSize: '11px', fontWeight: 500, color: '#9a988f', letterSpacing: '0.6px', textTransform: 'uppercase' }

  return (
    <div>
      <style>{`.bee-englist-row:hover { background:#f7f6f4 } .bee-englist-row:last-child { border-bottom:none !important }`}</style>
      <SortHeaderStyle />
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <FilterChips items={chips} active={activeChip} onChange={pickChip} />
        </div>
        {!showingClosed && (
          <EngagementFilters engagements={engagements} filters={filters} setFilters={setWorkFilters} onClear={clearFilters} nowMs={nowMs} />
        )}
      </div>

      {/* White hairline card; table edge-to-edge inside */}
      <div style={{ background: '#fff', border: '0.5px solid rgba(0,0,0,0.08)', borderRadius: '12px', overflow: 'hidden' }}>
        {!isMobile && rows.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '12px', padding: '12px 16px', alignItems: 'baseline', borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}>
            {[['client', 'Client', 'left'], ['engagement', 'Engagement', 'left'], ['stage', 'Stage', 'left'], ['status', 'Status', 'left'], ['value', 'Value', 'right'], ['activity', 'Activity', 'right']].map(([col, label, align]) => (
              <button key={col} className="bee-sort-header" onClick={() => clickSort(col)}
                style={{ ...headerCell, border: 'none', background: 'transparent', padding: '2px 4px', margin: '-2px -4px', borderRadius: '6px', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
                {label}<SortChevrons active={sort.col === col} dir={sort.dir} />
              </button>
            ))}
          </div>
        )}

        {rows.map(e => {
          const chip = deriveStatusChip(e, { longForm: true, nowMs })
          const rawValue = engagementValue(e)
          const value = rawValue != null ? fmtMoney(rawValue) : null
          const activity = relAge(lastActivityTs(e), nowMs)
          const muted = showingClosed
          if (isMobile) {
            // Locked two-line compression, same tokens: name+value / title · status + stage chip.
            return (
              <div key={e.id} className="bee-englist-row" onClick={() => onOpenEngagement(e)}
                style={{ padding: '13px 14px', borderBottom: '0.5px solid rgba(0,0,0,0.08)', cursor: 'pointer', opacity: muted ? 0.6 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}><ClientCell e={e} nowMs={nowMs} /></div>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: value ? '#1a1a18' : '#b5b3ac', flexShrink: 0 }}>{value || '—'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                    <span style={{ fontSize: '12px', color: '#8a8a84', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle(e)}</span>
                    <StatusText chip={chip} size={12} />
                  </span>
                  <StatusChip label={stageDisplayLabel(e.stage)} styleKey={e.stage} />
                </div>
              </div>
            )
          }
          return (
            <div key={e.id} className="bee-englist-row" onClick={() => onOpenEngagement(e)}
              style={{ display: 'grid', gridTemplateColumns: GRID, gap: '12px', alignItems: 'center', padding: '15px 16px', borderBottom: '0.5px solid rgba(0,0,0,0.08)', cursor: 'pointer', opacity: muted ? 0.6 : 1 }}>
              <ClientCell e={e} nowMs={nowMs} />
              <span style={{ fontSize: '13px', color: '#6b6b66', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle(e)}</span>
              <span><StatusChip label={stageDisplayLabel(e.stage)} styleKey={e.stage} /></span>
              <StatusText chip={chip} size={12} />
              <span style={{ fontSize: '14px', fontWeight: 600, color: value ? '#1a1a18' : '#b5b3ac', textAlign: 'right' }}>{value || '—'}</span>
              <span style={{ fontSize: '13px', color: '#8a8a84', textAlign: 'right' }}>{activity}</span>
            </div>
          )
        })}

        {rows.length === 0 && !loadingClosed && (
          <div style={{ padding: '32px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>
            {showingClosed
              ? 'No closed engagements in this view'
              : activeFilterCount > 0
                ? <FilteredEmpty count={activeFilterCount} onClear={clearFilters} noun="engagements" />
                : 'Nothing here — engagements land as requests come in'}
          </div>
        )}
        {loadingClosed && (
          <div style={{ padding: '24px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>Loading closed engagements…</div>
        )}
      </div>

      {showingClosed && closedRows && closedTotal != null && closedRows.length < closedTotal && !loadingClosed && (
        <button onClick={() => fetchClosed(closedRows.length)}
          style={{ width: '100%', marginTop: '10px', padding: '9px', background: 'transparent', border: '0.5px dashed rgba(0,0,0,0.15)', borderRadius: '10px', fontSize: '12px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
          Load {Math.min(PAGE, closedTotal - closedRows.length)} more of {closedTotal - closedRows.length}
        </button>
      )}
    </div>
  )
}
