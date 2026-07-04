// components/hive/ClientDirectory.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the people lens (doc §7, locked directory
// mockup). READ-ONLY tonight: status is DERIVED via shared/clientStatus
// (no stored column yet), the nurture-pool banner's 'Activate drips' is
// a disabled placeholder — drip activation (and any paused-flag writes)
// belongs to step 5.
//
// Row click opens the existing PersonPanel. Rides in the beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { CHIP_STYLES } from './shared/stageConfig'
import { deriveClientStatus, CLIENT_STATUS_ORDER, CLIENT_STATUS_META } from './shared/clientStatus'
import { fmtMoney, relAge, lastActivityTs } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import FilterChips from '@/components/ui/FilterChips'
import Banner from '@/components/ui/Banner'

const PAGE = 100
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

const monthYear = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d)) return null
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

// Contextual detail line — honest derivations from what's client-side.
// (lifetime figures use the leads.paid_amount single-slot denorm — an
// existence-grade number, see clientStatus.js caveat.)
function detailLine(person, status, openEngs, nowMs) {
  const paid = Number(person.paidAmount) || 0
  switch (status) {
    case 'Active': {
      const n = openEngs.length
      const base = `${n} open engagement${n === 1 ? '' : 's'}`
      return paid > 0 ? `${base} · ${fmtMoney(paid)} paid` : base
    }
    case 'Past': {
      const last = Math.max(0, ...openEngs.map(e => lastActivityTs(e)), person.created ? new Date(person.created).getTime() : 0)
      return `${fmtMoney(paid)} paid · last activity ${relAge(last, nowMs)} ago`
    }
    case 'Nurturing': {
      const when = monthYear(person.created)
      const bits = [when ? `inquired ${when}` : 'imported', 'never booked']
      if (person.paused) bits.push('drips paused')
      return bits.join(' · ')
    }
    case 'Attempting': {
      const lastReach = Math.max(0, ...(person.outreachTimeline || [])
        .filter(t => t.type === 'reach_out')
        .map(t => new Date(t.occurred_at || 0).getTime() || 0))
      return lastReach ? `last reach-out ${relAge(lastReach, nowMs)} ago` : 'being worked'
    }
    case 'New': {
      const when = monthYear(person.created)
      return when ? `inquired ${when} · not yet contacted` : 'new inquiry'
    }
    case 'no_contact':
      return 'no contact info'
    default:
      return null
  }
}

export default function ClientDirectory({ people = [], engagements = [], locFilter = 'all', onOpenClient = () => {} }) {
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [cap, setCap] = useState(PAGE)
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

  useEffect(() => { setCap(PAGE) }, [filter, search, locFilter])

  const scoped = useMemo(() => (
    locFilter === 'all' ? people : people.filter(p => p.locationId === locFilter)
  ), [people, locFilter])

  const openByClient = useMemo(() => {
    const m = new Map()
    for (const e of engagements) {
      if (!m.has(e.client_id)) m.set(e.client_id, [])
      m.get(e.client_id).push(e)
    }
    return m
  }, [engagements])
  const openClientIds = useMemo(() => new Set(openByClient.keys()), [openByClient])

  // Derive once per person over the FULL scoped set — counts and the
  // banner always reflect everything, not just rendered rows.
  const classified = useMemo(() => scoped.map(p => ({
    p,
    status: deriveClientStatus(p, openClientIds, nowMs),
  })), [scoped, openClientIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = { all: classified.length }
    for (const k of CLIENT_STATUS_ORDER) c[k] = 0
    for (const { status } of classified) c[status]++
    return c
  }, [classified])

  const pausedNurturing = useMemo(
    () => classified.filter(({ p, status }) => status === 'Nurturing' && p.paused).length,
    [classified])

  const q = search.trim().toLowerCase()
  const visible = classified.filter(({ p, status }) => {
    if (filter !== 'all' && status !== filter) return false
    if (!q) return true
    return (p.name || '').toLowerCase().includes(q)
      || (p.email || '').toLowerCase().includes(q)
      || (p.phone || '').toLowerCase().includes(q)
  })
  const rows = visible.slice(0, cap)

  const chips = [
    { key: 'all', label: 'All', count: counts.all },
    ...CLIENT_STATUS_ORDER.map(k => ({
      key: k,
      label: CLIENT_STATUS_META[k].label,
      count: counts[k],
      muted: k === 'no_contact',
    })),
  ]

  return (
    <div>
      <style>{`.bee-dir-row:hover { background:#f7f6f4 } .bee-dir-row:last-child { border-bottom:none !important }`}</style>

      <div style={{ marginBottom: '10px' }}>
        <FilterChips items={chips} active={filter} onChange={setFilter} />
      </div>

      {pausedNurturing > 0 && (
        <div style={{ marginBottom: '12px' }}>
          <Banner
            icon="⏸"
            tone="amber"
            text={
              <>
                {pausedNurturing} of your nurturing clients came from the import with marketing paused.{' '}
                <span title="Coming with drip activation (step 5)" style={{ fontSize: '11px', color: '#b5b3ac', cursor: 'default' }}>
                  Activate drips · soon
                </span>
              </>
            }
            action={{ label: 'Review nurture pool', onClick: () => setFilter('Nurturing') }}
          />
        </div>
      )}

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search name, email, phone…"
        style={{
          width: '100%', boxSizing: 'border-box', marginBottom: '12px',
          padding: '9px 14px', borderRadius: '8px',
          border: '0.5px solid rgba(0,0,0,0.12)', background: '#fff',
          fontSize: '13px', fontFamily: 'inherit', color: '#1a1a18', outline: 'none',
        }}
      />

      <div style={{ background: '#fff', border: '0.5px solid rgba(0,0,0,0.08)', borderRadius: '12px', overflow: 'hidden' }}>
        {rows.map(({ p, status }) => {
          const meta = CLIENT_STATUS_META[status]
          const fam = CHIP_STYLES[meta.styleKey] || CHIP_STYLES.gray
          const openEngs = openByClient.get(p.id) || []
          const detail = detailLine(p, status, openEngs, nowMs)
          return (
            <div key={p.id} className="bee-dir-row" onClick={() => onOpenClient(p.id)}
              style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: isMobile ? '12px 14px' : '13px 16px', borderBottom: '0.5px solid rgba(0,0,0,0.08)', cursor: 'pointer' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: fam.bg, color: fam.text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}>
                {initialsOf(p.name)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: '14px', fontWeight: 600, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</p>
                {detail && <p style={{ fontSize: '11px', color: '#8a8a84', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' }}>{detail}</p>}
              </div>
              <span style={{ flexShrink: 0 }}>
                <StatusChip label={meta.label} styleKey={meta.styleKey} />
              </span>
            </div>
          )
        })}

        {rows.length === 0 && (
          <div style={{ padding: '32px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>
            {q ? 'No clients match that search' : 'No clients in this view'}
          </div>
        )}
      </div>

      {visible.length > cap && (
        <button onClick={() => setCap(c => c + PAGE)}
          style={{ width: '100%', marginTop: '10px', padding: '9px', background: 'transparent', border: '0.5px dashed rgba(0,0,0,0.15)', borderRadius: '10px', fontSize: '12px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
          Load {Math.min(PAGE, visible.length - cap)} more of {visible.length - cap}
        </button>
      )}
    </div>
  )
}
