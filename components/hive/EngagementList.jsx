// components/hive/EngagementList.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the flat list lens on engagements (doc §7,
// locked list-view mockup). Same rows the board shows (locFilter applied
// upstream in HiveShell), same shared status derivation, same panel on
// row click. 'Closed' is lazy: only a server count ships up-front; the
// rows page in on demand via GET /api/engagements?closed=1.
//
// Rides in the beta dynamic chunk (imported by HiveShell only).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { ENGAGEMENT_STAGES, STAGE_RANK } from './shared/stageConfig'
import { deriveStatusChip, displayTitle, engagementValue, fmtMoney, lastActivityTs, relAge } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import FilterChips from '@/components/ui/FilterChips'

const OPEN_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal)
const CHIP_LABELS = { 'Request': 'Request', 'Estimate': 'Estimate', 'Job in Progress': 'Job', 'Final Processing': 'Final' }
const PAGE = 200

// Desktop grid: CLIENT | ENGAGEMENT | STAGE | STATUS | VALUE | ACTIVITY
const GRID = 'minmax(150px,1.2fr) minmax(140px,1.4fr) 130px minmax(140px,1.2fr) 90px 70px'

function ClientCell({ e, nowMs }) {
  const isNew = e.repeat_count === 1 && (nowMs - new Date(e.created_at).getTime()) < 30 * 86400000
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
      <span style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.client_name}</span>
      {e.repeat_count > 1 && <StatusChip label="repeat" styleKey="repeat" />}
      {isNew && <StatusChip label="new" styleKey="teal" />}
    </div>
  )
}

export default function EngagementList({ engagements = [], closedCount = 0, locFilter = 'all', onOpenEngagement = () => {}, setToast = () => {} }) {
  const [filter, setFilter] = useState('open')
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
    { key: 'closed', label: 'Closed', count: scopedClosedCount ?? '…' },
  ]

  const showingClosed = filter === 'closed'
  const rows = showingClosed
    ? (closedRows || [])
    : (filter === 'open' ? engagements : engagements.filter(e => e.stage === filter))
        .slice()
        .sort((a, b) =>
          (STAGE_RANK[a.stage] ?? 0) - (STAGE_RANK[b.stage] ?? 0) ||
          lastActivityTs(b) - lastActivityTs(a))

  function pickFilter(key) {
    setFilter(key)
    if (key === 'closed' && closedRows === null && !loadingClosed) fetchClosed(0)
  }

  const headerCell = { fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase' }

  return (
    <div>
      <style>{`.bee-englist-row:hover { background:#f7f6f4 }`}</style>
      <div style={{ marginBottom: '12px' }}>
        <FilterChips items={chips} active={filter} onChange={pickFilter} />
      </div>

      {/* Desktop header row */}
      {!isMobile && rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '12px', padding: '0 12px 8px', alignItems: 'baseline' }}>
          <span style={headerCell}>Client</span>
          <span style={headerCell}>Engagement</span>
          <span style={headerCell}>Stage</span>
          <span style={headerCell}>Status</span>
          <span style={{ ...headerCell, textAlign: 'right' }}>Value</span>
          <span style={{ ...headerCell, textAlign: 'right' }}>Activity</span>
        </div>
      )}

      <div>
        {rows.map(e => {
          const chip = deriveStatusChip(e, { longForm: true, nowMs })
          const rawValue = engagementValue(e)
          const value = rawValue != null ? fmtMoney(rawValue) : '—'
          const activity = relAge(lastActivityTs(e), nowMs)
          const muted = showingClosed
          if (isMobile) {
            // Locked two-line compression: name + value / title · status + stage chip.
            return (
              <div key={e.id} className="bee-englist-row" onClick={() => onOpenEngagement(e)}
                style={{ padding: '10px 4px', borderBottom: '0.5px solid rgba(0,0,0,0.08)', cursor: 'pointer', opacity: muted ? 0.65 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '3px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}><ClientCell e={e} nowMs={nowMs} /></div>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a18', flexShrink: 0 }}>{value}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: '11px', color: '#8a8a84', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayTitle(e)}{chip ? ` · ${chip.label}` : ''}
                  </span>
                  <StatusChip label={e.stage} styleKey={e.stage} />
                </div>
              </div>
            )
          }
          return (
            <div key={e.id} className="bee-englist-row" onClick={() => onOpenEngagement(e)}
              style={{ display: 'grid', gridTemplateColumns: GRID, gap: '12px', alignItems: 'center', padding: '11px 12px', borderBottom: '0.5px solid rgba(0,0,0,0.08)', cursor: 'pointer', borderRadius: '6px', opacity: muted ? 0.65 : 1 }}>
              <ClientCell e={e} nowMs={nowMs} />
              <span style={{ fontSize: '12px', color: '#8a8a84', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle(e)}</span>
              <span><StatusChip label={e.stage} styleKey={e.stage} /></span>
              <span>{chip && <StatusChip label={chip.label} styleKey={chip.styleKey} />}</span>
              <span style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a18', textAlign: 'right' }}>{value}</span>
              <span style={{ fontSize: '12px', color: '#b5b3ac', textAlign: 'right' }}>{activity}</span>
            </div>
          )
        })}

        {rows.length === 0 && !loadingClosed && (
          <div style={{ padding: '28px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '10px' }}>
            {showingClosed ? 'No closed engagements in this view' : 'Nothing here — engagements land as requests come in'}
          </div>
        )}
        {loadingClosed && (
          <div style={{ padding: '20px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>Loading closed engagements…</div>
        )}
        {showingClosed && closedRows && closedTotal != null && closedRows.length < closedTotal && !loadingClosed && (
          <button onClick={() => fetchClosed(closedRows.length)}
            style={{ width: '100%', marginTop: '10px', padding: '9px', background: 'transparent', border: '0.5px dashed rgba(0,0,0,0.15)', borderRadius: '10px', fontSize: '12px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
            Load {Math.min(PAGE, closedTotal - closedRows.length)} more of {closedTotal - closedRows.length}
          </button>
        )}
      </div>
    </div>
  )
}
