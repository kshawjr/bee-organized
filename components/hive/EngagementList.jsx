// components/hive/EngagementList.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the flat list lens on engagements (doc §7,
// LOCKED list mockup). Same rows the board shows (locFilter applied
// upstream in HiveShell), same shared status derivation, same panel on
// row click. 'Closed' is lazy: only a server count ships up-front; the
// rows page in on demand via GET /api/engagements?closed=1.
//
// Mockup anatomy: quiet filter chips, white hairline card containing the
// table edge-to-edge, breathing rows (15px), STATUS as colored TEXT in
// the state's family color (not a chip). Rides in the beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { ENGAGEMENT_STAGES, STAGE_RANK, CHIP_STYLES, stageDisplayLabel } from './shared/stageConfig'
import { deriveStatusChip, displayTitle, engagementValue, fmtMoney, lastActivityTs, relAge } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import FilterChips from '@/components/ui/FilterChips'
import { statusIconFor, IconChevronRight } from '@/components/ui/icons'

const OPEN_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal)
const CHIP_LABELS = { 'Request': 'Request', 'Estimate': 'Estimate', 'Job in Progress': 'Job', 'Final Processing': 'Final' }
const PAGE = 200

// Desktop grid: CLIENT | ENGAGEMENT | STAGE | STATUS | VALUE | ACTIVITY
const GRID = 'minmax(150px,1.2fr) minmax(140px,1.4fr) 130px minmax(150px,1.2fr) 90px 70px'

// STATUS renders as colored text (mockup), not a chip: family text color
// + the shared leading icon (send/check/clock/calendar/cash/file-invoice
// via statusIconFor — same map the board chips use). Money amounts
// reorder to '$620 owing'; passive grays render iconless.
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

export default function EngagementList({ engagements = [], closedCount = 0, locFilter = 'all', onOpenEngagement = () => {}, setToast = () => {} }) {
  const [filter, setFilter] = useState('open')
  // Column sort: default = stage rank then activity desc. Clicking
  // CLIENT/VALUE/ACTIVITY toggles that column asc/desc.
  const [sortCol, setSortCol] = useState('default')
  const [sortDir, setSortDir] = useState('desc')
  // Power filters (beta tool, client-side over the loaded set).
  const [fltOpen, setFltOpen] = useState(false)
  const [fltMinValue, setFltMinValue] = useState('')
  const [fltAge, setFltAge] = useState(null)      // null | 7 | 30
  const [fltOwing, setFltOwing] = useState(false)
  const [fltRepeat, setFltRepeat] = useState(false)
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
  useEffect(() => { setClosedRows(null); setClosedTotal(null); if (filter === 'closed') setFilter('open') }, [locFilter]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const counts = { open: engagements.length }
  for (const s of OPEN_STAGES) counts[s.key] = engagements.filter(e => e.stage === s.key).length
  const scopedClosedCount = closedTotal ?? (locFilter === 'all' ? closedCount : null)

  const chips = [
    { key: 'open', label: 'Open', count: counts.open },
    ...OPEN_STAGES.map(s => ({ key: s.key, label: CHIP_LABELS[s.key], count: counts[s.key] })),
    { key: 'closed', label: 'Closed', count: scopedClosedCount ?? '…', muted: true },
  ]

  const showingClosed = filter === 'closed'
  const activeFilterCount = (fltMinValue ? 1 : 0) + (fltAge ? 1 : 0) + (fltOwing ? 1 : 0) + (fltRepeat ? 1 : 0)
  const clearFilters = () => { setFltMinValue(''); setFltAge(null); setFltOwing(false); setFltRepeat(false) }

  const passesFilters = (e) => {
    if (fltMinValue && (engagementValue(e) ?? 0) < Number(fltMinValue)) return false
    if (fltAge && (nowMs - lastActivityTs(e)) < fltAge * 86400000) return false
    if (fltOwing && !(Number(e.balance_owing) > 0)) return false
    if (fltRepeat && !(e.repeat_count > 1)) return false
    return true
  }

  const sortRows = (arr) => {
    const sorted = arr.slice()
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortCol === 'client') sorted.sort((a, b) => dir * (a.client_name || '').localeCompare(b.client_name || ''))
    else if (sortCol === 'value') sorted.sort((a, b) => dir * ((engagementValue(a) ?? 0) - (engagementValue(b) ?? 0)))
    else if (sortCol === 'activity') sorted.sort((a, b) => dir * (lastActivityTs(a) - lastActivityTs(b)))
    else sorted.sort((a, b) =>
      (STAGE_RANK[a.stage] ?? 0) - (STAGE_RANK[b.stage] ?? 0) ||
      lastActivityTs(b) - lastActivityTs(a))
    return sorted
  }

  const rows = showingClosed
    ? sortRows(closedRows || [])
    : sortRows((filter === 'open' ? engagements : engagements.filter(e => e.stage === filter)).filter(passesFilters))

  const clickSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortCol(col); setSortDir(col === 'client' ? 'asc' : 'desc') }
  }
  const SortChevron = ({ col }) => sortCol !== col ? null : (
    <IconChevronRight size={10} style={{ transform: sortDir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)', marginLeft: '3px' }} />
  )

  function pickFilter(key) {
    setFilter(key)
    if (key === 'closed' && closedRows === null && !loadingClosed) fetchClosed(0)
  }

  const headerCell = { fontSize: '11px', fontWeight: 500, color: '#9a988f', letterSpacing: '0.6px', textTransform: 'uppercase' }

  return (
    <div>
      <style>{`.bee-englist-row:hover { background:#f7f6f4 } .bee-englist-row:last-child { border-bottom:none !important }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <FilterChips items={chips} active={filter} onChange={pickFilter} />
        </div>
        {!showingClosed && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => setFltOpen(v => !v)}
              style={{ padding: '5px 12px', borderRadius: '20px', border: '0.5px solid rgba(0,0,0,0.15)', background: fltOpen || activeFilterCount > 0 ? '#fff' : 'transparent', fontSize: '12px', fontWeight: activeFilterCount > 0 ? 500 : 400, color: activeFilterCount > 0 ? '#1a1a18' : '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
              Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
            </button>
            {fltOpen && (
              <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50, width: '230px', background: '#fff', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '10px', boxShadow: '0 8px 30px rgba(26,26,24,0.12)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <label style={{ fontSize: '11px', color: '#8a8a84', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  Min value $
                  <input type="number" min="0" value={fltMinValue} onChange={e => setFltMinValue(e.target.value)}
                    style={{ flex: 1, minWidth: 0, padding: '5px 8px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#8a8a84' }}>
                  Quiet
                  {[7, 30].map(d => (
                    <button key={d} onClick={() => setFltAge(a => (a === d ? null : d))}
                      style={{ padding: '3px 10px', borderRadius: '20px', border: `0.5px solid ${fltAge === d ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.12)'}`, background: fltAge === d ? '#fff' : 'transparent', fontSize: '11px', fontWeight: fltAge === d ? 500 : 400, color: fltAge === d ? '#1a1a18' : '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
                      &gt;{d}d
                    </button>
                  ))}
                </div>
                {[['Has owing', fltOwing, setFltOwing], ['Repeat clients only', fltRepeat, setFltRepeat]].map(([label, val, set]) => (
                  <button key={label} onClick={() => set(v => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', border: 'none', background: 'transparent', padding: 0, fontSize: '12px', color: val ? '#1a1a18' : '#8a8a84', fontWeight: val ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                    <span style={{ width: '14px', height: '14px', borderRadius: '4px', border: `0.5px solid ${val ? '#1a1a18' : 'rgba(0,0,0,0.25)'}`, background: val ? '#1a1a18' : '#fff', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', flexShrink: 0 }}>{val ? '✓' : ''}</span>
                    {label}
                  </button>
                ))}
                {activeFilterCount > 0 && (
                  <button onClick={clearFilters}
                    style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
                    Clear all
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* White hairline card; table edge-to-edge inside */}
      <div style={{ background: '#fff', border: '0.5px solid rgba(0,0,0,0.08)', borderRadius: '12px', overflow: 'hidden' }}>
        {!isMobile && rows.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '12px', padding: '12px 16px', alignItems: 'baseline', borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}>
            <button onClick={() => clickSort('client')} style={{ ...headerCell, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', display: 'inline-flex', alignItems: 'center' }}>Client<SortChevron col="client" /></button>
            <span style={headerCell}>Engagement</span>
            <span style={headerCell}>Stage</span>
            <span style={headerCell}>Status</span>
            <button onClick={() => clickSort('value')} style={{ ...headerCell, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit', justifyContent: 'flex-end', display: 'inline-flex', alignItems: 'center' }}>Value<SortChevron col="value" /></button>
            <button onClick={() => clickSort('activity')} style={{ ...headerCell, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit', justifyContent: 'flex-end', display: 'inline-flex', alignItems: 'center' }}>Activity<SortChevron col="activity" /></button>
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
            {showingClosed ? 'No closed engagements in this view' : 'Nothing here — engagements land as requests come in'}
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
