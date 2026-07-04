// components/hive/InboxScreen.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the front-of-funnel worklist (doc §7, locked
// Inbox mockup): New (no contact yet) + Attempting (being worked), the
// people NOT yet in work-world. Send to Jobber is the one door across
// (§7) — it REUSES the app's existing SendToJobberPopup confirm flow
// (mounted by the beta branch in BeeHub scope; this screen only asks
// for it via onSendToJobber). 'Log call' posts the existing
// /api/touchpoints reach_out.
//
// Soft row actions (the ··· overflow): Snooze / Dismiss / Mark as junk.
// All three are Inbox-scoped removals riding EXISTING write paths
// (PATCH /api/leads/:id) plus session-local Sets for optimistic
// removal — the Sets also defend against the Supabase Realtime
// refetch re-inserting the person ~1s after the PATCH. Deliberate
// asymmetry: junk stops active drips (drip-lifecycle's is_junk
// branch); dismiss does NOT — dismiss = "handled in my inbox", not
// "stop nurturing", and the drip lifecycle never learns the
// inbox_dismissed_at column. deriveClientStatus is blind to all
// three, so the directory keeps reading the truth.
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
import { CHIP_STYLES } from './shared/stageConfig'
import { relAge } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import { GREEN_FILL, HAIRLINE_BORDER } from '@/components/ui/tokens'
import { IconSparkles, IconPhoneOutgoing, IconPhone, IconSend, IconCheck, IconClock } from '@/components/ui/icons'
import ContactLine from './ContactLine'
import InitialsAvatar from './shared/InitialsAvatar'
import { FilterButton, FilterPopover, FilterSection, CheckRow, TogglePills, SortRows, FilteredEmpty } from './shared/FilterPopover'
import { useStoredState } from './shared/useStoredControls'
import useIsMobile from './shared/useIsMobile'

const INBOX_SORTS = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'last_touch', label: 'Last touch' },
  { key: 'name', label: 'Name A–Z' },
]
const INBOX_FILTER_DEFAULTS = { sources: [], hasPhone: false, hasEmail: false, touchBand: null, age: null }
const inboxFilterCount = (f) =>
  (f.sources.length ? 1 : 0) + (f.hasPhone ? 1 : 0) + (f.hasEmail ? 1 : 0) + (f.touchBand ? 1 : 0) + (f.age ? 1 : 0)

// Section color families ride the CHIP_STYLES pairs (teal = New, blue =
// Attempting) — the same one pair the chips and unread badge resolve to.
const TEAL = CHIP_STYLES.teal, BLUE = CHIP_STYLES.blue

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
  padding: '6px 12px', borderRadius: '8px', border: `0.5px solid var(--hairline-border, ${HAIRLINE_BORDER})`,
  background: '#fff', fontSize: '13px', fontWeight: 500, color: '#1a1a18',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}
const sendBtn = {
  padding: '6px 14px', borderRadius: '8px', border: 'none',
  background: GREEN_FILL, color: '#fff', fontSize: '13px', fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}

// One row of the ··· overflow menu. stopPropagation keeps the click off
// the row (PersonCard) and off the document outside-click closer.
function MenuRow({ label, danger, disabled, onPick }) {
  return (
    <button disabled={disabled}
      onClick={(ev) => { ev.stopPropagation(); onPick() }}
      onMouseEnter={(ev) => { ev.currentTarget.style.background = '#f7f6f4' }}
      onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent' }}
      style={{
        display: 'flex', alignItems: 'center', gap: '7px', width: '100%',
        padding: '8px 10px', border: 'none', background: 'transparent',
        borderRadius: '7px', fontSize: '13px', fontWeight: 500,
        fontFamily: 'inherit', color: danger ? '#b42318' : '#1a1a18',
        cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap',
      }}>
      {label}
    </button>
  )
}

export default function InboxScreen({ people = [], engagements = [], locFilter = 'all', onOpenPerson = () => {}, onSendToJobber = () => {}, setToast = () => {} }) {
  const [busyId, setBusyId] = useState(null)
  // Local session overrides: a logged call moves the row to Attempting
  // immediately (the real touchpoint is written; derivation catches up
  // on next load).
  const [loggedIds, setLoggedIds] = useState(() => new Set())
  // Soft-removal Sets, one per action (all mirror loggedIds): the row
  // leaves the worklist instantly, and a Realtime re-insert of the same
  // person can't bring it back this session even if the refetched row
  // races ahead of the PATCH landing.
  const [junkedIds, setJunkedIds] = useState(() => new Set())
  const [snoozedIds, setSnoozedIds] = useState(() => new Set())
  const [dismissedIds, setDismissedIds] = useState(() => new Set())
  const [menuFor, setMenuFor] = useState(null) // row id whose ··· menu is open
  const [sortRaw, setSort] = useStoredState('bee_hive_inbox_sort', { key: 'newest' })
  const inboxSort = INBOX_SORTS.some(o => o.key === sortRaw.key) ? sortRaw.key : 'newest'
  const [filters, setFilters, clearFilters] = useStoredState('bee_hive_inbox_filters', INBOX_FILTER_DEFAULTS)
  const [fltOpen, setFltOpen] = useState(false)
  const nowMs = Date.now()

  const isMobile = useIsMobile()

  // Any click that bubbles to the document closes the open ··· menu.
  // The trigger + menu items stopPropagation, so only outside clicks land.
  useEffect(() => {
    if (!menuFor) return
    const close = () => setMenuFor(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuFor])

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
      // Soft removals — session Set OR the DB-backed field (rows arriving
      // already junked/snoozed/dismissed, incl. Realtime refetches). These
      // are Inbox-scoped ONLY: deriveClientStatus stays blind to them, so
      // the same person still reads New/Attempting in the directory.
      if (p.isJunk || junkedIds.has(p.id)) continue
      if (snoozedIds.has(p.id) || (p.snoozeUntil && new Date(p.snoozeUntil).getTime() > nowMs)) continue
      if (p.inboxDismissedAt || dismissedIds.has(p.id)) continue
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
  }, [scoped, openClientIds, loggedIds, junkedIds, snoozedIds, dismissedIds, filters, inboxSort]) // eslint-disable-line react-hooks/exhaustive-deps

  async function patchLead(id, patch) {
    const res = await fetch(`/api/leads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
  }

  const addTo = (setter, id) => setter(prev => new Set(prev).add(id))
  const dropFrom = (setter, id) => setter(prev => { const n = new Set(prev); n.delete(id); return n })

  // InlineToast (BeeHub scope) renders {msg} verbatim, so a React node
  // rides through untouched — the Undo button lives inside the toast.
  // The undo window is the host's toast auto-dismiss (~3s).
  const undoToast = (text, onUndo) => ({
    kind: 'success',
    msg: (
      <span>
        {text} ·{' '}
        <button onClick={onUndo}
          style={{ background: 'none', border: 'none', padding: 0, color: '#fff', font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
          Undo
        </button>
      </span>
    ),
  })

  async function markJunk(p) {
    setBusyId(p.id)
    try {
      // Existing soft-delete write path; server-side this trips the drip
      // lifecycle's is_junk branch (stop active drips + cancel stage
      // emails) — desired for junk, and exactly what dismiss must NOT do.
      await patchLead(p.id, { is_junk: true })
      addTo(setJunkedIds, p.id)
      setToast(undoToast('Marked as junk', async () => {
        try {
          await patchLead(p.id, { is_junk: false })
          dropFrom(setJunkedIds, p.id)
          setToast({ kind: 'success', msg: `${p.name} restored` })
        } catch (e) {
          setToast({ kind: 'error', msg: `Undo failed: ${e.message}` })
        }
      }))
    } catch (e) {
      setToast({ kind: 'error', msg: `Junk failed: ${e.message}` })
    } finally {
      setBusyId(null)
    }
  }

  async function snoozeLead(p, days) {
    // Date-only string — Classic compares snoozeUntil in the YYYY-MM-DD
    // vocabulary (snoozedToday, wake-up banner). Deliberately NO stage
    // write: Classic's snooze→Nurturing coupling lives in ITS SnoozePopup
    // call site, not in the column, so writing only snoozed_until can't
    // trip it.
    const until = new Date(nowMs + days * 86400000)
    const iso = until.toISOString().slice(0, 10)
    const human = until.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    setBusyId(p.id)
    try {
      await patchLead(p.id, { snoozed_until: iso })
      addTo(setSnoozedIds, p.id)
      setToast(undoToast(`Snoozed until ${human}`, async () => {
        try {
          await patchLead(p.id, { snoozed_until: null })
          dropFrom(setSnoozedIds, p.id)
          setToast({ kind: 'success', msg: `${p.name} restored` })
        } catch (e) {
          setToast({ kind: 'error', msg: `Undo failed: ${e.message}` })
        }
      }))
    } catch (e) {
      setToast({ kind: 'error', msg: `Snooze failed: ${e.message}` })
    } finally {
      setBusyId(null)
    }
  }

  async function dismissLead(p) {
    setBusyId(p.id)
    try {
      await patchLead(p.id, { inbox_dismissed_at: new Date().toISOString() })
      addTo(setDismissedIds, p.id)
      // Audit trail survives the row leaving the worklist — mirror the
      // resurrection log (system touchpoint, no human author). Fire-and-
      // forget like that path: the dismissal itself already landed.
      fetch('/api/touchpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: p.id, kind: 'system', method: 'system', label: 'Dismissed from Inbox — nurturing continues' }),
      }).then(r => { if (!r.ok) console.warn('Failed to log dismiss touchpoint') })
        .catch(() => console.warn('Failed to log dismiss touchpoint'))
      setToast(undoToast('Dismissed', async () => {
        try {
          await patchLead(p.id, { inbox_dismissed_at: null })
          dropFrom(setDismissedIds, p.id)
          setToast({ kind: 'success', msg: `${p.name} restored` })
        } catch (e) {
          setToast({ kind: 'error', msg: `Undo failed: ${e.message}` })
        }
      }))
    } catch (e) {
      setToast({ kind: 'error', msg: `Dismiss failed: ${e.message}` })
    } finally {
      setBusyId(null)
    }
  }

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

  // Scan-clean rows: the webform snippet is DISPLAY-ONLY here (muted, in
  // the detail line) — authoring lives on the PersonCard a click opens.
  const detailNew = (p) => {
    const bits = [(p.source || 'inquiry').toLowerCase(), `${relAge(new Date(p.created || 0).getTime(), nowMs)} ago`]
    const snippet = (p.jobDetail || '').trim()
    if (snippet) bits.push(`“${snippet.length > 60 ? snippet.slice(0, 57) + '…' : snippet}”`)
    return bits.join(' · ')
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
      <span style={{ fontSize: '12px', color: GREEN_FILL, fontWeight: 500, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
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
        {/* Soft actions live behind ··· — Send stays the one inline
            primary; four inline buttons per row would drown it. */}
        <div style={{ position: 'relative', ...(isMobile ? { width: '100%' } : {}) }}>
          <button aria-label="More actions" title="More actions"
            style={{ ...hairlineBtn, padding: '6px 10px', fontWeight: 700, letterSpacing: '1px', ...(isMobile ? { width: '100%' } : {}) }}
            disabled={busyId === p.id}
            onClick={(ev) => { ev.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id) }}>
            ···
          </button>
          {menuFor === p.id && (
            <div onClick={(ev) => ev.stopPropagation()}
              style={{
                position: 'absolute', top: 'calc(100% + 4px)', right: 0,
                ...(isMobile ? { left: 0 } : { minWidth: '210px' }),
                zIndex: 80, background: '#fff',
                border: `0.5px solid var(--hairline-border, ${HAIRLINE_BORDER})`,
                borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
                padding: '4px',
              }}>
              <MenuRow disabled={busyId === p.id} onPick={() => { setMenuFor(null); snoozeLead(p, 1) }}
                label={<><IconClock size={13} />Snooze until tomorrow</>} />
              <MenuRow disabled={busyId === p.id} onPick={() => { setMenuFor(null); snoozeLead(p, 7) }}
                label={<><IconClock size={13} />Snooze until next week</>} />
              <MenuRow disabled={busyId === p.id} onPick={() => { setMenuFor(null); dismissLead(p) }}
                label={<><IconCheck size={13} />Dismiss</>} />
              <MenuRow danger disabled={busyId === p.id} onPick={() => { setMenuFor(null); markJunk(p) }}
                label="Mark as junk" />
            </div>
          )}
        </div>
      </>
    )
    return (
      <div className="bee-inbox-row" onClick={() => onOpenPerson(p)}
        style={{ padding: isMobile ? '12px 14px' : '13px 16px', borderBottom: '0.5px solid rgba(0,0,0,0.08)', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <InitialsAvatar name={p.name} bg={family.bg} text={family.text} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '14px', fontWeight: 600, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <StatusChip label={pill} styleKey={pill === 'New' ? 'New' : 'Attempting'} />
            </p>
            <p style={{ fontSize: '11px', color: '#8a8a84', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' }}>
              {pill === 'New' ? detailNew(p) : detailWorking(p)}
            </p>
            {/* Identity cluster: name → detail → contact (one card-like
                block; the action button stays cleanly right). Clicking
                the row opens the PersonCard — the panel-shaped record. */}
            {!isMobile && <ContactLine phone={p.phone} email={p.email} style={{ marginTop: '3px' }} />}
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
            <SectionLabel glyph={<IconSparkles size={13} />} color={TEAL.text} label="New" count={fresh.length} hint="No Contact Yet" />
            {fresh.length > 0 ? (
              <div style={cardStyle}>
                {fresh.map(p => <Row key={p.id} p={p} family={TEAL} pill="New" />)}
              </div>
            ) : (
              <div style={{ padding: '20px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '12px' }}>
                New inquiries land here
              </div>
            )}
          </div>

          <div>
            <SectionLabel glyph={<IconPhoneOutgoing size={13} />} color={BLUE.text} label="Attempting" count={working.length} hint="Working the Lead" />
            {working.length > 0 ? (
              <div style={cardStyle}>
                {working.map(p => <Row key={p.id} p={p} family={BLUE} pill="Attempting" />)}
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
