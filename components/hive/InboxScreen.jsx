// components/hive/InboxScreen.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the front-of-funnel worklist (doc §7, locked
// Inbox mockup): New (no contact yet) + Attempting (being worked), the
// people NOT yet in work-world. Send to Jobber is the one door across
// (§7) — it REUSES the app's existing SendToJobberPopup confirm flow
// (mounted by the beta branch in BeeHub scope; this screen only asks
// for it via onSendToJobber). No new write paths: 'Log call' posts the
// existing /api/touchpoints reach_out; snooze needs storage → 'soon'.
//
// Send gating mirrors the existing PersonPanel philosophy: hidden for
// clients already linked to Jobber (person.jobberRef — imported clients
// all carry their jobber_client_id; linked clients sync via webhooks).
// A fresh send this session flips jobberRef to 'REQ-…'/'JOB-…' (the
// popup's onDone patch) — that prefix drives the optimistic 'sent' row
// state. Rides in the beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { deriveClientStatus } from './shared/clientStatus'
import { relAge } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import { IconSparkles, IconPhoneOutgoing, IconPhone, IconSend, IconCheck, IconClock } from '@/components/ui/icons'
import ContactLine from './ContactLine'
import EditableDesc from './EditableDesc'
import { FilterButton, FilterPopover, FilterSection, CheckRow, TogglePills, SortRows, FilteredEmpty } from './shared/FilterPopover'
import { useStoredState } from './shared/useStoredControls'

const INBOX_SORTS = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'last_touch', label: 'Last touch' },
  { key: 'name', label: 'Name A–Z' },
]
const INBOX_FILTER_DEFAULTS = { sources: [], hasPhone: false, hasEmail: false, touchBand: null, age: null }
const inboxFilterCount = (f) =>
  (f.sources.length ? 1 : 0) + (f.hasPhone ? 1 : 0) + (f.hasEmail ? 1 : 0) + (f.touchBand ? 1 : 0) + (f.age ? 1 : 0)

const TEAL_DARK = '#085041', TEAL_BG = '#E1F5EE'
const BLUE_DARK = '#0C447C', BLUE_BG = '#E6F1FB'
const SEND_GREEN = '#0F6E56'

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

const freshlySent = (p) => /^(REQ|JOB)-/.test(p.jobberRef || '')

function SectionLabel({ glyph, color, label, count, hint }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, letterSpacing: '0.6px', textTransform: 'uppercase', color, marginBottom: '8px' }}>
      <span style={{ marginRight: '5px' }}>{glyph}</span>
      {label} · {count} · <span style={{ color, opacity: 0.55, textTransform: 'none', letterSpacing: '0.3px' }}>{hint}</span>
    </p>
  )
}

const hairlineBtn = {
  padding: '6px 12px', borderRadius: '8px', border: '0.5px solid rgba(0,0,0,0.15)',
  background: '#fff', fontSize: '13px', fontWeight: 500, color: '#1a1a18',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}
const sendBtn = {
  padding: '6px 14px', borderRadius: '8px', border: 'none',
  background: SEND_GREEN, color: '#fff', fontSize: '13px', fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}

export default function InboxScreen({ people = [], engagements = [], locFilter = 'all', onOpenClient = () => {}, onSendToJobber = () => {}, setToast = () => {} }) {
  const [busyId, setBusyId] = useState(null)
  // Local session overrides: a logged call moves the row to Attempting
  // immediately (the real touchpoint is written; derivation catches up
  // on next load).
  const [loggedIds, setLoggedIds] = useState(() => new Set())
  const [descEdits, setDescEdits] = useState({})
  const [sortRaw, setSort] = useStoredState('bee_hive_inbox_sort', { key: 'newest' })
  const inboxSort = INBOX_SORTS.some(o => o.key === sortRaw.key) ? sortRaw.key : 'newest'
  const [filters, setFilters, clearFilters] = useStoredState('bee_hive_inbox_filters', INBOX_FILTER_DEFAULTS)
  const [fltOpen, setFltOpen] = useState(false)
  const nowMs = Date.now()

  const [windowWidth, setWindowWidth] = useState(0)
  useEffect(() => {
    const check = () => setWindowWidth(window.innerWidth)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const isMobile = windowWidth > 0 && windowWidth < 768

  const scoped = useMemo(() => (
    locFilter === 'all' ? people : people.filter(p => p.locationId === locFilter)
  ), [people, locFilter])

  const openClientIds = useMemo(() => new Set(engagements.map(e => e.client_id)), [engagements])

  const reachCount = (p) => (p.outreachTimeline || []).filter(t => t.type === 'reach_out').length + (loggedIds.has(p.id) ? 1 : 0)
  const lastReach = (p) => Math.max(0, ...(p.outreachTimeline || []).filter(t => t.type === 'reach_out').map(t => new Date(t.occurred_at || 0).getTime() || 0), loggedIds.has(p.id) ? nowMs : 0)

  const passesInboxFilters = (p) => {
    if (filters.sources.length && !filters.sources.includes((p.source || '').toLowerCase() || 'unknown')) return false
    if (filters.hasPhone && !(p.phone || '').trim()) return false
    if (filters.hasEmail && !(p.email || '').trim()) return false
    if (filters.touchBand) {
      const n = reachCount(p)
      if (filters.touchBand === '0' && n !== 0) return false
      if (filters.touchBand === '1-2' && !(n >= 1 && n <= 2)) return false
      if (filters.touchBand === '3+' && n < 3) return false
    }
    if (filters.age && (nowMs - (new Date(p.created || 0).getTime() || 0)) < filters.age * 86400000) return false
    return true
  }

  const sourceOptions = useMemo(() => {
    const present = new Set()
    for (const p of scoped) present.add((p.source || '').toLowerCase() || 'unknown')
    return [...present].sort()
  }, [scoped])

  const { fresh, working } = useMemo(() => {
    const fresh = [], working = []
    for (const p of scoped) {
      if (!passesInboxFilters(p)) continue
      const status = deriveClientStatus(p, openClientIds, nowMs)
      if (status === 'New') (loggedIds.has(p.id) ? working : fresh).push(p)
      else if (status === 'Attempting') working.push(p)
    }
    const created = (p) => new Date(p.created || 0).getTime() || 0
    const cmp = inboxSort === 'oldest' ? (a, b) => created(a) - created(b)
      : inboxSort === 'name' ? (a, b) => (a.name || '').localeCompare(b.name || '')
      : inboxSort === 'last_touch' ? (a, b) => lastReach(b) - lastReach(a)
      : (a, b) => created(b) - created(a)
    fresh.sort(cmp)
    working.sort(cmp)
    return { fresh, working }
  }, [scoped, openClientIds, loggedIds, filters, inboxSort]) // eslint-disable-line react-hooks/exhaustive-deps

  async function logCall(p) {
    setBusyId(p.id)
    try {
      const res = await fetch('/api/touchpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: p.id, kind: 'reach_out', label: 'Reach-out', method: 'call' }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setLoggedIds(prev => new Set(prev).add(p.id))
      setToast({ kind: 'success', msg: `Call logged for ${p.name}` })
    } catch (e) {
      setToast({ kind: 'error', msg: `Log failed: ${e.message}` })
    } finally {
      setBusyId(null)
    }
  }

  const lastReachOut = (p) => Math.max(0, ...(p.outreachTimeline || [])
    .filter(t => t.type === 'reach_out')
    .map(t => new Date(t.occurred_at || 0).getTime() || 0))

  const detailNew = (p) =>
    [(p.source || 'inquiry').toLowerCase(), `${relAge(new Date(p.created || 0).getTime(), nowMs)} ago`].join(' · ')

  // Description (leads.request_details → people-mapper's jobDetail): the
  // quote block under the identity cluster, editable in place. descEdits
  // holds optimistic overrides — the people array is owned by the shell.
  const leadDesc = (p) => (descEdits[p.id] !== undefined ? descEdits[p.id] : (p.jobDetail || ''))
  async function saveDesc(p, text) {
    const prev = leadDesc(p)
    setDescEdits(m => ({ ...m, [p.id]: text }))
    try {
      const res = await fetch(`/api/leads/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_details: text || null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setToast({ kind: 'success', msg: 'Description saved' })
    } catch (e) {
      setDescEdits(m => ({ ...m, [p.id]: prev }))
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    }
  }
  const detailWorking = (p) => {
    const reaches = (p.outreachTimeline || []).filter(t => t.type === 'reach_out').length + (loggedIds.has(p.id) ? 1 : 0)
    const last = loggedIds.has(p.id) ? nowMs : lastReachOut(p)
    return `${reaches} touchpoint${reaches === 1 ? '' : 's'}${last ? ` · last touch ${relAge(last, nowMs)} ago` : ''}`
  }

  function Row({ p, family, pill }) {
    const sent = freshlySent(p)
    const canSend = !p.jobberRef
    const actions = sent ? (
      <span style={{ fontSize: '12px', color: SEND_GREEN, fontWeight: 500, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
        <IconCheck size={13} /> Sent — engagement will appear on the board
      </span>
    ) : (
      <>
        {pill === 'New' && (
          <button style={hairlineBtn} disabled={busyId === p.id}
            onClick={(ev) => { ev.stopPropagation(); logCall(p) }}>
            <IconPhone size={13} style={{ marginRight: '5px' }} />Log call
          </button>
        )}
        {canSend && (
          <button style={{ ...sendBtn, ...(isMobile ? { width: '100%' } : {}) }} disabled={busyId === p.id}
            onClick={(ev) => { ev.stopPropagation(); onSendToJobber(p) }}>
            <IconSend size={13} style={{ marginRight: '5px' }} />Send to Jobber
          </button>
        )}
        <span title="Coming soon" style={{ fontSize: '11px', color: '#c9c7c0', cursor: 'default', whiteSpace: 'nowrap' }}><IconClock size={11} style={{ marginRight: '3px' }} />Snooze · soon</span>
      </>
    )
    return (
      <div className="bee-inbox-row" onClick={() => onOpenClient(p.id)}
        style={{ padding: isMobile ? '12px 14px' : '13px 16px', borderBottom: '0.5px solid rgba(0,0,0,0.08)', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: family.bg, color: family.text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}>
            {initialsOf(p.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '14px', fontWeight: 600, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <StatusChip label={pill} styleKey={pill === 'New' ? 'New' : 'Attempting'} />
            </p>
            <p style={{ fontSize: '11px', color: '#8a8a84', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' }}>
              {pill === 'New' ? detailNew(p) : detailWorking(p)}
            </p>
            {/* Identity cluster: name → detail → contact → description
                (one card-like block; the action button stays cleanly
                right). No dashed add-slot here — rows stay scannable. */}
            {!isMobile && <ContactLine phone={p.phone} email={p.email} style={{ marginTop: '3px' }} />}
            {!isMobile && <EditableDesc text={leadDesc(p)} onSave={t => saveDesc(p, t)} style={{ marginTop: '6px' }} />}
          </div>
          {!isMobile && (
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px' }} onClick={ev => ev.stopPropagation()}>
              {actions}
            </div>
          )}
        </div>
        {isMobile && (
          <ContactLine phone={p.phone} email={p.email} style={{ marginTop: '8px', paddingLeft: '44px' }} />
        )}
        {isMobile && (
          <div style={{ marginTop: '6px', paddingLeft: '44px' }}>
            <EditableDesc text={leadDesc(p)} onSave={t => saveDesc(p, t)} />
          </div>
        )}
        {isMobile && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }} onClick={ev => ev.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
    )
  }

  const cardStyle = { background: '#fff', border: '0.5px solid rgba(0,0,0,0.08)', borderRadius: '12px', overflow: 'hidden' }

  return (
    <div>
      <style>{`.bee-inbox-row:hover { background:#f7f6f4 } .bee-inbox-row:last-child { border-bottom:none !important }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginBottom: '12px' }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <FilterButton count={inboxFilterCount(filters)} open={fltOpen} onToggle={() => setFltOpen(v => !v)} label="Filter & sort" />
          <FilterPopover open={fltOpen} count={inboxFilterCount(filters)} onClear={clearFilters}>
            <FilterSection label="Sort">
              <SortRows value={inboxSort} onChange={(v) => setSort({ key: v })} options={INBOX_SORTS} />
            </FilterSection>
            {sourceOptions.length > 0 && (
              <FilterSection label="Source">
                {sourceOptions.map(k => (
                  <CheckRow key={k} label={k} checked={filters.sources.includes(k)}
                    onToggle={() => setFilters(f => ({ ...f, sources: f.sources.includes(k) ? f.sources.filter(v => v !== k) : [...f.sources, k] }))} />
                ))}
              </FilterSection>
            )}
            <FilterSection label="Contact">
              <CheckRow label="Has phone" checked={filters.hasPhone} onToggle={() => setFilters(f => ({ ...f, hasPhone: !f.hasPhone }))} />
              <CheckRow label="Has email" checked={filters.hasEmail} onToggle={() => setFilters(f => ({ ...f, hasEmail: !f.hasEmail }))} />
            </FilterSection>
            <FilterSection label="Touchpoints">
              <TogglePills value={filters.touchBand}
                options={[{ key: '0', label: '0' }, { key: '1-2', label: '1–2' }, { key: '3+', label: '3+' }]}
                onChange={(v) => setFilters(f => ({ ...f, touchBand: v }))} />
            </FilterSection>
            <FilterSection label="Age">
              <TogglePills prefix="Older than" value={filters.age}
                options={[{ key: 7, label: '>7d' }, { key: 14, label: '>14d' }]}
                onChange={(v) => setFilters(f => ({ ...f, age: v }))} />
            </FilterSection>
          </FilterPopover>
        </div>
      </div>

      {fresh.length === 0 && working.length === 0 ? (
        inboxFilterCount(filters) > 0 ? (
          <FilteredEmpty count={inboxFilterCount(filters)} onClear={clearFilters} noun="inbox leads" />
        ) : (
        <div style={{ padding: '36px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '12px' }}>
          New inquiries land here
        </div>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <SectionLabel glyph={<IconSparkles size={13} />} color={TEAL_DARK} label="New" count={fresh.length} hint="No Contact Yet" />
            {fresh.length > 0 ? (
              <div style={cardStyle}>
                {fresh.map(p => <Row key={p.id} p={p} family={{ bg: TEAL_BG, text: TEAL_DARK }} pill="New" />)}
              </div>
            ) : (
              <div style={{ padding: '20px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '12px' }}>
                New inquiries land here
              </div>
            )}
          </div>

          <div>
            <SectionLabel glyph={<IconPhoneOutgoing size={13} />} color={BLUE_DARK} label="Attempting" count={working.length} hint="Working the Lead" />
            {working.length > 0 ? (
              <div style={cardStyle}>
                {working.map(p => <Row key={p.id} p={p} family={{ bg: BLUE_BG, text: BLUE_DARK }} pill="Attempting" />)}
              </div>
            ) : (
              <div style={{ padding: '20px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '12px' }}>
                Leads you’ve reached out to appear here — log a call or email from any client
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
