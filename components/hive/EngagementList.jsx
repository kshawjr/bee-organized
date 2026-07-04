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

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { ENGAGEMENT_STAGES, STAGE_RANK, CHIP_STYLES, stageDisplayLabel } from './shared/stageConfig'
import { deriveStatusChip, displayTitle, engagementValue, fmtMoney, lastActivityTs, relAge } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import FilterChips from '@/components/ui/FilterChips'
import { statusIconFor, IconChevronRight } from '@/components/ui/icons'

const OPEN_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal)
const CHIP_LABELS = { 'Request': 'Request', 'Estimate': 'Estimate', 'Job in Progress': 'Job', 'Final Processing': 'Final' }
const PAGE = 200
const SORT_LS_KEY = 'bee_hive_list_sort'
const FILTERS_LS_KEY = 'bee_hive_list_filters'

const DEFAULT_FILTERS = {
  stages: [],        // [] = all open stages; chips sync to length-1 selections
  statuses: [],      // within-stage styleKeys
  min: '', max: '',  // value range ($)
  age: null,         // quiet: null | 7 | 30 | 90
  owing: false,
  repeat: false,
  fresh: false,      // new clients only: first engagement, <30d
  foundedBy: [],     // request | quote | job | manual
}

// Display labels for the status multi-select (keys = deriveStatusChip
// styleKeys actually present in the loaded rows — dead options never show).
const STATUS_LABELS = {
  'Request': 'requested', amber: 'requested (stale)',
  sent: 'sent', approved: 'approved', changes_requested: 'changes requested',
  scheduled: 'scheduled', in_progress: 'in progress', upcoming: 'upcoming',
  owing: 'owing', never_invoiced: 'never invoiced', paid: 'paid', nurturing: 'nurturing',
}

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

function MicroLabel({ children }) {
  return (
    <p style={{ fontSize: '10px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase' }}>
      {children}
    </p>
  )
}

function CheckRow({ label, checked, onToggle }) {
  return (
    <button onClick={onToggle}
      style={{ display: 'flex', alignItems: 'center', gap: '8px', border: 'none', background: 'transparent', padding: 0, fontSize: '12px', color: checked ? '#1a1a18' : '#8a8a84', fontWeight: checked ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
      <span style={{ width: '14px', height: '14px', borderRadius: '4px', border: `0.5px solid ${checked ? '#1a1a18' : 'rgba(0,0,0,0.25)'}`, background: checked ? '#1a1a18' : '#fff', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', flexShrink: 0 }}>{checked ? '✓' : ''}</span>
      {label}
    </button>
  )
}

export default function EngagementList({ engagements = [], closedCount = 0, locFilter = 'all', onOpenEngagement = () => {}, setToast = () => {} }) {
  const [view, setView] = useState('open')             // 'open' | 'closed'
  const [sort, setSort] = useState({ col: 'default', dir: 'desc' })
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [fltOpen, setFltOpen] = useState(false)
  const [closedRows, setClosedRows] = useState(null)   // per active scope
  const [closedTotal, setClosedTotal] = useState(null) // scoped total once known
  const [loadingClosed, setLoadingClosed] = useState(false)
  const hydrated = useRef(false)
  const nowMs = Date.now()

  // SSR-safe persistence hydration (bee_hive_beta_lens pattern), then
  // write-through on every change — but never before hydration finishes.
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(SORT_LS_KEY) || 'null')
      if (s && ['default', 'client', 'value', 'activity'].includes(s.col) && ['asc', 'desc'].includes(s.dir)) setSort(s)
      const f = JSON.parse(localStorage.getItem(FILTERS_LS_KEY) || 'null')
      if (f && typeof f === 'object') setFilters({ ...DEFAULT_FILTERS, ...f })
    } catch {}
    hydrated.current = true
  }, [])
  useEffect(() => {
    if (!hydrated.current) return
    try { localStorage.setItem(SORT_LS_KEY, JSON.stringify(sort)) } catch {}
  }, [sort])
  useEffect(() => {
    if (!hydrated.current) return
    try { localStorage.setItem(FILTERS_LS_KEY, JSON.stringify(filters)) } catch {}
  }, [filters])

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

  const counts = { open: engagements.length }
  for (const s of OPEN_STAGES) counts[s.key] = engagements.filter(e => e.stage === s.key).length
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
    setFilters(f => ({ ...f, stages: key === 'open' ? [] : [key] }))
  }

  const showingClosed = view === 'closed'

  // Status options: only what's actually present in the loaded set.
  const statusOptions = useMemo(() => {
    const present = new Set()
    for (const e of engagements) {
      const k = deriveStatusChip(e, { nowMs })?.styleKey
      if (k && STATUS_LABELS[k]) present.add(k)
    }
    return Object.keys(STATUS_LABELS).filter(k => present.has(k))
  }, [engagements]) // eslint-disable-line react-hooks/exhaustive-deps

  const activeFilterCount =
    (filters.stages.length ? 1 : 0) + (filters.statuses.length ? 1 : 0) +
    (filters.min ? 1 : 0) + (filters.max ? 1 : 0) + (filters.age ? 1 : 0) +
    (filters.owing ? 1 : 0) + (filters.repeat ? 1 : 0) + (filters.fresh ? 1 : 0) +
    (filters.foundedBy.length ? 1 : 0)
  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS)
    try { localStorage.removeItem(FILTERS_LS_KEY) } catch {}
  }
  const toggleIn = (key, value) => setFilters(f => ({
    ...f,
    [key]: f[key].includes(value) ? f[key].filter(v => v !== value) : [...f[key], value],
  }))

  const passesFilters = (e) => {
    if (filters.stages.length && !filters.stages.includes(e.stage)) return false
    if (filters.statuses.length) {
      const k = deriveStatusChip(e, { nowMs })?.styleKey
      if (!k || !filters.statuses.includes(k)) return false
    }
    const v = engagementValue(e) ?? 0
    if (filters.min && v < Number(filters.min)) return false
    if (filters.max && v > Number(filters.max)) return false
    if (filters.age && (nowMs - lastActivityTs(e)) < filters.age * 86400000) return false
    if (filters.owing && !(Number(e.balance_owing) > 0)) return false
    if (filters.repeat && !(e.repeat_count > 1)) return false
    if (filters.fresh && !(e.repeat_count === 1 && (nowMs - new Date(e.created_at).getTime()) < 30 * 86400000)) return false
    if (filters.foundedBy.length && !filters.foundedBy.includes(e.founded_by)) return false
    return true
  }

  const sortRows = (arr) => {
    const sorted = arr.slice()
    const dir = sort.dir === 'asc' ? 1 : -1
    if (sort.col === 'client') sorted.sort((a, b) => dir * (a.client_name || '').localeCompare(b.client_name || ''))
    else if (sort.col === 'value') sorted.sort((a, b) => dir * ((engagementValue(a) ?? 0) - (engagementValue(b) ?? 0)))
    else if (sort.col === 'activity') sorted.sort((a, b) => dir * (lastActivityTs(a) - lastActivityTs(b)))
    else sorted.sort((a, b) =>
      (STAGE_RANK[a.stage] ?? 0) - (STAGE_RANK[b.stage] ?? 0) ||
      lastActivityTs(b) - lastActivityTs(a))
    return sorted
  }

  const rows = showingClosed
    ? sortRows(closedRows || [])
    : sortRows(engagements.filter(passesFilters))

  const clickSort = (col) => {
    setSort(s => s.col === col
      ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: col === 'client' ? 'asc' : 'desc' })
  }
  const SortChevron = ({ col }) => sort.col !== col ? null : (
    <IconChevronRight size={10} style={{ transform: sort.dir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)', marginLeft: '3px' }} />
  )

  const headerCell = { fontSize: '11px', fontWeight: 500, color: '#9a988f', letterSpacing: '0.6px', textTransform: 'uppercase' }

  return (
    <div>
      <style>{`.bee-englist-row:hover { background:#f7f6f4 } .bee-englist-row:last-child { border-bottom:none !important }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <FilterChips items={chips} active={activeChip} onChange={pickChip} />
        </div>
        {!showingClosed && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => setFltOpen(v => !v)}
              style={{ padding: '5px 12px', borderRadius: '20px', border: '0.5px solid rgba(0,0,0,0.15)', background: fltOpen || activeFilterCount > 0 ? '#fff' : 'transparent', fontSize: '12px', fontWeight: activeFilterCount > 0 ? 500 : 400, color: activeFilterCount > 0 ? '#1a1a18' : '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
              Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
            </button>
            {fltOpen && (
              <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50, width: '260px', maxHeight: '62vh', overflowY: 'auto', background: '#fff', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '10px', boxShadow: '0 8px 30px rgba(26,26,24,0.12)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <MicroLabel>Stage</MicroLabel>
                  {OPEN_STAGES.map(s => (
                    <CheckRow key={s.key} label={s.displayLabel} checked={filters.stages.includes(s.key)} onToggle={() => toggleIn('stages', s.key)} />
                  ))}
                </div>
                {statusOptions.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <MicroLabel>Status</MicroLabel>
                    {statusOptions.map(k => (
                      <CheckRow key={k} label={STATUS_LABELS[k]} checked={filters.statuses.includes(k)} onToggle={() => toggleIn('statuses', k)} />
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <MicroLabel>Value</MicroLabel>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#8a8a84' }}>
                    $
                    <input type="number" min="0" placeholder="min" value={filters.min} onChange={e => setFilters(f => ({ ...f, min: e.target.value }))}
                      style={{ flex: 1, minWidth: 0, padding: '5px 8px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
                    –
                    <input type="number" min="0" placeholder="max" value={filters.max} onChange={e => setFilters(f => ({ ...f, max: e.target.value }))}
                      style={{ flex: 1, minWidth: 0, padding: '5px 8px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <MicroLabel>Activity</MicroLabel>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#8a8a84' }}>
                    Quiet
                    {[7, 30, 90].map(d => (
                      <button key={d} onClick={() => setFilters(f => ({ ...f, age: f.age === d ? null : d }))}
                        style={{ padding: '3px 10px', borderRadius: '20px', border: `0.5px solid ${filters.age === d ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.12)'}`, background: filters.age === d ? '#fff' : 'transparent', fontSize: '11px', fontWeight: filters.age === d ? 500 : 400, color: filters.age === d ? '#1a1a18' : '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
                        &gt;{d}d
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <MicroLabel>More</MicroLabel>
                  <CheckRow label="Has owing" checked={filters.owing} onToggle={() => setFilters(f => ({ ...f, owing: !f.owing }))} />
                  <CheckRow label="Repeat clients only" checked={filters.repeat} onToggle={() => setFilters(f => ({ ...f, repeat: !f.repeat }))} />
                  <CheckRow label="New clients only" checked={filters.fresh} onToggle={() => setFilters(f => ({ ...f, fresh: !f.fresh }))} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <MicroLabel>Founded by</MicroLabel>
                  {['request', 'quote', 'job', 'manual'].map(k => (
                    <CheckRow key={k} label={k} checked={filters.foundedBy.includes(k)} onToggle={() => toggleIn('foundedBy', k)} />
                  ))}
                </div>
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
            {showingClosed
              ? 'No closed engagements in this view'
              : activeFilterCount > 0
                ? (
                  <>
                    No engagements match the active filters (Filters · {activeFilterCount}).{' '}
                    <button onClick={clearFilters} style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '12px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
                      Clear all
                    </button>
                  </>
                )
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
