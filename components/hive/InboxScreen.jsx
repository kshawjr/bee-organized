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
// Bulk selection (feedback #5): the entry is the select-all checkbox at
// the TOP-LEFT of the control row above the list (the column-header
// convention, aligned to the rows' checkbox column) — one gesture enters
// selection mode AND selects all visible selectable rows; in mode it's
// the usual tri-state all↔none toggle. Row long-press stays the
// secondary door in. Then checkboxes + Remove (N), which is mark-junk
// batched over the selection with one batch Undo.
// The Jobber-owns-deletion rule (Kevin 7/10) applies
// throughout: leads are removable ONLY pre-Jobber — any row with a
// jobberRef is excluded from selection (grayed checkbox, 'Managed in
// Jobber') and gets no junk row in its ··· menu; the API 409s
// (jobber_linked_junk_rejected) as the real enforcement.
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
//
// Row anatomy (compact layout B + ghost icon actions, direction C):
// name, then ONE secondary line — status chip · tel: link. The tel:
// link DIALS (digits-only href off phone_normalized, formatted phone as
// the label); the ghost phone ICON logs a touchpoint — two different
// actions, kept distinct by tooltip + link styling. The age slot is the
// adaptive 'date · relative' (formatInboxAgeParts) — desktop puts it on
// the icons' center line in the right cluster; mobile keeps it far
// right on the secondary line.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { deriveClientStatus } from './shared/clientStatus'
import { CHIP_STYLES, CLOSED_WON, isTerminal } from './shared/stageConfig'
import { formatInboxAgeParts } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import { TEXT_MUTED, TEXT_PRIMARY, TEXT_SECONDARY } from '@/components/ui/tokens'
import { T } from './shared/tokens'
import { IconSparkles, IconPhoneOutgoing, IconPhone, IconSend, IconCheck, IconClock, IconDots } from '@/components/ui/icons'
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

// Ghost icon actions (direction C): borderless, no pill background —
// a muted 17px glyph in a 32px tap target that darkens on hover (the
// .bee-ghost-btn rule). Icon-only, so every trigger carries aria-label
// + title; the ··· overflow CONTENTS are unchanged from the soft-actions
// commit — this restyles only the visible triggers.
const ghostBtn = {
  width: '32px', height: '32px', padding: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', borderRadius: T.radius.control,
  color: `var(--text-muted, ${TEXT_MUTED})`,
  cursor: 'pointer', fontFamily: 'inherit',
}

function GhostIconButton({ label, icon: Icon, disabled, onClick, ...rest }) {
  return (
    <button className="bee-ghost-btn" aria-label={label} title={label}
      disabled={disabled} style={ghostBtn} onClick={onClick} {...rest}>
      <Icon size={17} />
    </button>
  )
}

// The row's age slot — adaptive 'date · relative' (formatInboxAgeParts:
// relative-only under 24h, 'Jun 5 · 29d ago' inside a month, date-only
// past it, year added for prior years). Anchor in --text-secondary,
// the '· hint' in --text-muted; ONE nowrap line that truncates
// tail-first, so the hint drops before the date ever does.
function AgeInline({ created, nowMs, style = {} }) {
  const { anchor, hint } = formatInboxAgeParts(created, nowMs)
  return (
    <span className="bee-inbox-age" style={{
      fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      color: `var(--text-secondary, ${TEXT_SECONDARY})`, ...style,
    }}>
      {anchor}
      {hint && <span style={{ color: `var(--text-muted, ${TEXT_MUTED})` }}> · {hint}</span>}
    </span>
  )
}

// One row of the ··· overflow menu. stopPropagation keeps the click off
// the row (PersonCard) and off the document outside-click closer.
function MenuRow({ label, danger, disabled, onPick }) {
  return (
    <button disabled={disabled}
      onClick={(ev) => { ev.stopPropagation(); onPick() }}
      onMouseEnter={(ev) => { ev.currentTarget.style.background = T.surface.hover }}
      onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent' }}
      style={{
        display: 'flex', alignItems: 'center', gap: '7px', width: '100%',
        padding: '8px 10px', border: 'none', background: 'transparent',
        borderRadius: T.radius.control, fontSize: '13px', fontWeight: 500,
        fontFamily: 'inherit', color: danger ? T.state.danger.strong : T.ink.primary,
        cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap',
      }}>
      {label}
    </button>
  )
}

// The open ··· menu rides a portal to <body>: cardStyle keeps
// overflow:hidden (it's what clips rows to the card radius), so an
// in-card absolute popover gets amputated at the card edge — and the
// last row's menu would be lost entirely. Fixed-position coords derive
// from the trigger's rect and re-derive on scroll/resize (capture-phase
// scroll catches scrolling ancestors too), so the menu stays glued to
// its ···; it flips ABOVE the trigger when the viewport bottom would
// clip it. Horizontal anchoring keeps the pre-portal semantics: mobile
// triggers sit left-of-center so the menu grows rightward from the
// trigger's left edge (viewport-clamped); desktop hugs the trigger's
// right edge. First paint is hidden — useLayoutEffect measures the real
// menu box and positions it before the browser shows anything.
//
// The trigger is found by data attribute on EVERY placement, never held
// as an element: Row is redefined per InboxScreen render, so React
// remounts the row DOM on every render — an element captured at click
// time is already detached (rect all zeros) by the time the open
// re-render lands.
function RowMenu({ anchorId, isMobile, onClose, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    const place = () => {
      const anchor = document.querySelector(`[data-bee-menu-trigger="${anchorId}"]`)
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const w = ref.current?.offsetWidth || 0
      const h = ref.current?.offsetHeight || 0
      const below = r.bottom + 4
      const top = h && below + h > window.innerHeight - 8 && r.top - h - 4 > 8
        ? r.top - h - 4
        : below
      const left = isMobile
        ? Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
        : Math.max(8, r.right - w)
      setPos({ top, left })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorId, isMobile])

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div ref={ref} data-bee-row-menu onClick={(ev) => ev.stopPropagation()}
      style={{
        position: 'fixed', top: 0, left: 0, ...(pos || {}),
        visibility: pos ? 'visible' : 'hidden',
        minWidth: '210px', zIndex: 80, background: T.surface.raised,
        border: T.border.thin,
        borderRadius: T.radius.inset, boxShadow: T.shadow.pop,
        padding: '4px',
      }}>
      {children}
    </div>,
    document.body
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
  // Bulk selection (feedback #5) — the Inbox is the ONLY surface where
  // leads are removable (pre-Jobber; Kevin 7/10). Remove = the same
  // mark-junk write path as the ··· row action, batched. Selection is
  // session-only state; Jobber-linked rows are never selectable.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [confirmRemove, setConfirmRemove] = useState(false) // N>5 confirm step
  const [sortRaw, setSort] = useStoredState('bee_hive_inbox_sort', { key: 'newest' })
  const inboxSort = INBOX_SORTS.some(o => o.key === sortRaw.key) ? sortRaw.key : 'newest'
  const [filters, setFilters, clearFilters] = useStoredState('bee_hive_inbox_filters', INBOX_FILTER_DEFAULTS)
  const [fltOpen, setFltOpen] = useState(false)
  const nowMs = Date.now()

  const isMobile = useIsMobile()

  // Any click that bubbles to the document closes the open ··· menu.
  // The trigger + menu items stopPropagation; the target check covers
  // the portal explicitly (its DOM lives under <body>, so don't lean on
  // delegation order alone) — only genuinely-outside clicks close.
  useEffect(() => {
    if (!menuFor) return
    const close = (ev) => {
      if (ev.target instanceof Element && ev.target.closest('[data-bee-row-menu]')) return
      setMenuFor(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuFor])

  const scoped = useMemo(() => (
    locFilter === 'all' ? people : people.filter(p => p.locationId === locFilter)
  ), [people, locFilter])

  // Server ships open engagements only, but session closes arrive as
  // terminal rowPatches — filter them so a just-closed row doesn't keep
  // reading Active, and collect session Closed Won for the 'Client'
  // derivation (won clients are customers; they never belong in this
  // front-of-funnel worklist).
  const openClientIds = useMemo(() => new Set(
    engagements.filter(e => !isTerminal(e.stage)).map(e => e.client_id)
  ), [engagements])
  const wonClientIds = useMemo(() => new Set(
    engagements.filter(e => e.stage === CLOSED_WON).map(e => e.client_id)
  ), [engagements])

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
      const status = deriveClientStatus(p, openClientIds, nowMs, wonClientIds)
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
  }, [scoped, openClientIds, wonClientIds, loggedIds, junkedIds, snoozedIds, dismissedIds, filters, inboxSort]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selection universe ─────────────────────────────────────
  // The VISIBLE rows (filters + section derivation already applied),
  // minus Jobber-linked ones: a linked lead's lifecycle belongs to
  // Jobber (its *_DESTROY webhooks are the only deletion path), so it
  // is never selectable. jobberRef covers real links AND this session's
  // optimistic 'REQ-…'/'JOB-…' sends. Selection SURVIVES filter changes
  // but only currently-visible selectable rows count toward Remove —
  // select-all-then-narrow can never junk a hidden row.
  const visibleRows = useMemo(() => [...fresh, ...working], [fresh, working])
  const selectableIds = useMemo(() => new Set(visibleRows.filter(p => !p.jobberRef).map(p => p.id)), [visibleRows])
  const effectiveSelected = useMemo(() => [...selectedIds].filter(id => selectableIds.has(id)), [selectedIds, selectableIds])
  const selCount = effectiveSelected.length

  const exitSelect = () => { setSelectMode(false); setSelectedIds(new Set()); setConfirmRemove(false) }
  const toggleSelect = (p) => {
    if (p.jobberRef) return // managed in Jobber — never selectable
    setConfirmRemove(false)
    setSelectedIds(prev => {
      const n = new Set(prev)
      if (n.has(p.id)) n.delete(p.id); else n.add(p.id)
      return n
    })
  }
  const toggleSelectAll = () => {
    setConfirmRemove(false)
    setSelectedIds(selCount === selectableIds.size ? new Set() : new Set(selectableIds))
  }
  // The top-left header checkbox (THE entry affordance): out of selection
  // mode, one gesture enters it AND selects everything visible+selectable;
  // in mode it's the standard all↔none toggle the bulk bar button mirrors.
  const headerSelectAll = () => {
    if (!selectMode) {
      setSelectMode(true)
      setConfirmRemove(false)
      setSelectedIds(new Set(selectableIds))
    } else toggleSelectAll()
  }

  // Long-press on a row (mobile path into selection mode). Cancelled by
  // release/leave; touch scrolling fires pointercancel, which also
  // cancels. A fired long-press swallows the click that follows it.
  const lpTimer = useRef(null)
  const lpFired = useRef(false)
  const pressStart = (p) => {
    lpFired.current = false
    clearTimeout(lpTimer.current)
    lpTimer.current = setTimeout(() => {
      lpFired.current = true
      if (!selectMode) { setSelectMode(true); toggleSelect(p) }
    }, 500)
  }
  const pressEnd = () => clearTimeout(lpTimer.current)
  useEffect(() => () => clearTimeout(lpTimer.current), [])

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
          style={{ background: 'none', border: 'none', padding: 0, color: T.ink.inverse, font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
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

  // Bulk Remove — mark-junk semantics, batched: leaves the Inbox
  // immediately, drips stop / welcome cancels server-side (the same
  // is_junk branch the single action trips), recoverable via the Bin
  // and the batch Undo below. Hard delete stays super_admin Bin
  // territory. Partial failures keep the failed rows in place and say
  // so; Undo restores exactly the rows that were removed.
  function requestRemove() {
    if (selCount === 0) return
    if (selCount > 5 && !confirmRemove) { setConfirmRemove(true); return }
    bulkRemoveSelected()
  }

  async function bulkRemoveSelected() {
    const rows = visibleRows.filter(p => selectedIds.has(p.id) && !p.jobberRef)
    if (rows.length === 0) return
    setBusyId('bulk')
    try {
      const results = await Promise.allSettled(rows.map(p => patchLead(p.id, { is_junk: true })))
      const done = rows.filter((_, i) => results[i].status === 'fulfilled')
      const failed = rows.length - done.length
      exitSelect()
      if (done.length === 0) {
        setToast({ kind: 'error', msg: 'Remove failed — please try again' })
        return
      }
      setJunkedIds(prev => { const n = new Set(prev); done.forEach(p => n.add(p.id)); return n })
      const text = failed > 0
        ? `Removed ${done.length} of ${rows.length} (${failed} failed)`
        : `Removed ${done.length} ${done.length === 1 ? 'lead' : 'leads'}`
      setToast(undoToast(text, async () => {
        const undos = await Promise.allSettled(done.map(p => patchLead(p.id, { is_junk: false })))
        const restored = done.filter((_, i) => undos[i].status === 'fulfilled')
        setJunkedIds(prev => { const n = new Set(prev); restored.forEach(p => n.delete(p.id)); return n })
        if (restored.length === done.length) setToast({ kind: 'success', msg: `${restored.length} restored` })
        else setToast({ kind: 'error', msg: `Undo failed for ${done.length - restored.length} of ${done.length}` })
      }))
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

  function Row({ p, family, pill }) {
    const sent = freshlySent(p)
    const canSend = !p.jobberRef
    // Jobber-owns-deletion rule: ANY jobberRef (imported/linked client,
    // or this session's optimistic send) means the record's lifecycle
    // belongs to Jobber — excluded from selection, no junk affordance.
    const linked = !!p.jobberRef
    const checked = !linked && selectedIds.has(p.id)
    // tel: dials on the digits-only key — phone_normalized when the row
    // carries it, else a client-side strip of the formatted value. The
    // formatted `phone` stays the visible label.
    const phoneLabel = (p.phone || '').trim()
    const phoneDigits = p.phoneNormalized || phoneLabel.replace(/\D/g, '')
    const actions = sent ? (
      <span style={{ fontSize: '12px', color: T.accent.fg, fontWeight: 500, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
        <IconCheck size={13} /> Sent — engagement will appear on the board
      </span>
    ) : (
      <>
        {/* Ghost cluster — Log call RECORDS a touchpoint (the tel: link
            in the secondary line is the one that dials). */}
        {pill === 'New' && (
          <GhostIconButton label="Log call" icon={IconPhone} disabled={busyId === p.id}
            onClick={(ev) => { ev.stopPropagation(); logCall(p) }} />
        )}
        {canSend && (
          <GhostIconButton label="Send to Jobber" icon={IconSend} disabled={busyId === p.id}
            onClick={(ev) => { ev.stopPropagation(); onSendToJobber(p) }} />
        )}
        {/* Soft actions stay behind ··· — same overflow menu, rendered
            through the RowMenu portal (the card's overflow:hidden would
            amputate an in-card popover). The data attribute is how the
            portal finds its trigger to position to. */}
        <GhostIconButton label="More" icon={IconDots} disabled={busyId === p.id}
          data-bee-menu-trigger={p.id}
          onClick={(ev) => { ev.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id) }} />
        {menuFor === p.id && (
          <RowMenu anchorId={p.id} isMobile={isMobile} onClose={() => setMenuFor(null)}>
            <MenuRow disabled={busyId === p.id} onPick={() => { setMenuFor(null); snoozeLead(p, 1) }}
              label={<><IconClock size={13} />Snooze until tomorrow</>} />
            <MenuRow disabled={busyId === p.id} onPick={() => { setMenuFor(null); snoozeLead(p, 7) }}
              label={<><IconClock size={13} />Snooze until next week</>} />
            <MenuRow disabled={busyId === p.id} onPick={() => { setMenuFor(null); dismissLead(p) }}
              label={<><IconCheck size={13} />Dismiss</>} />
            {/* Jobber-owns-deletion rule: no junk door on linked rows
                (the API 409s it anyway — this keeps the UI honest). */}
            {!linked && (
              <MenuRow danger disabled={busyId === p.id} onPick={() => { setMenuFor(null); markJunk(p) }}
                label="Mark as junk" />
            )}
          </RowMenu>
        )}
      </>
    )
    return (
      <div className="bee-inbox-row"
        onClick={() => {
          // A fired long-press already entered selection — swallow the
          // click that follows the pointer release.
          if (lpFired.current) { lpFired.current = false; return }
          if (selectMode) toggleSelect(p)
          else onOpenPerson(p)
        }}
        onPointerDown={() => pressStart(p)}
        onPointerUp={pressEnd} onPointerLeave={pressEnd} onPointerCancel={pressEnd}
        style={{ padding: isMobile ? '12px 14px' : '13px 16px', borderBottom: T.border.divider, cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {selectMode && (
            <input type="checkbox" checked={checked} disabled={linked}
              title={linked ? 'Managed in Jobber' : `Select ${p.name}`}
              aria-label={linked ? 'Managed in Jobber' : `Select ${p.name}`}
              onClick={(ev) => ev.stopPropagation()}
              onChange={() => toggleSelect(p)}
              style={{
                width: '16px', height: '16px', flexShrink: 0, margin: 0,
                accentColor: T.accent.fg,
                opacity: linked ? 0.35 : 1,
                cursor: linked ? 'not-allowed' : 'pointer',
              }} />
          )}
          <InitialsAvatar name={p.name} bg={family.bg} text={family.text} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '14px', fontWeight: 600, color: `var(--text-primary, ${TEXT_PRIMARY})`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name}
            </p>
            {/* Compact secondary line (layout B) — ONE line: chip, then
                the tappable number. The phone truncates before anything
                wraps. Desktop age lives in the right-side cluster (one
                center line with the icons); mobile keeps it far right
                here, where the hint tail truncates before the date. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px', minWidth: 0 }}>
              <StatusChip label={pill} styleKey={pill === 'New' ? 'New' : 'Attempting'} />
              {phoneLabel && phoneDigits && (
                <a className="bee-inbox-tel" href={`tel:${phoneDigits}`}
                  onClick={(ev) => ev.stopPropagation()}
                  style={{
                    color: T.accent.fg, textDecoration: 'none', fontSize: '11px',
                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                    minWidth: 0, overflow: 'hidden',
                    // Expanded hit area (comfortable mobile tap) without
                    // growing the one-line layout.
                    padding: '7px 4px', margin: '-7px -4px',
                  }}>
                  <span style={{ color: `var(--text-muted, ${TEXT_MUTED})`, display: 'inline-flex', flexShrink: 0 }}><IconPhone size={11} /></span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{phoneLabel}</span>
                </a>
              )}
              {isMobile && <AgeInline created={p.created} nowMs={nowMs} style={{ marginLeft: 'auto', minWidth: 0 }} />}
            </div>
          </div>
          {!isMobile && (
            /* Alignment fix (direction C): date/relative + icons share
               ONE align-items:center row, whatever icons the row has —
               3 on New, ··· alone on linked Attempting. Only the icon
               sub-cluster swallows clicks; the age text still bubbles
               to the row like any other text. */
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
              <AgeInline created={p.created} nowMs={nowMs} />
              {/* Selection mode swaps the action cluster for checkboxes —
                  no per-row writes while a batch is being composed. */}
              {!selectMode && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }} onClick={ev => ev.stopPropagation()}>
                  {actions}
                </div>
              )}
            </div>
          )}
        </div>
        {isMobile && !selectMode && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginTop: '6px', paddingLeft: '37px' }} onClick={ev => ev.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
    )
  }

  const cardStyle = { background: T.surface.raised, border: T.border.card, boxShadow: T.shadow.card, borderRadius: T.radius.card, overflow: 'hidden' }

  return (
    <div>
      <style>{`
        .bee-inbox-row:hover { background:${T.surface.hover} }
        .bee-inbox-row:last-child { border-bottom:none !important }
        .bee-ghost-btn:hover:not(:disabled) { color: var(--text-primary, ${TEXT_PRIMARY}) !important }
        .bee-ghost-btn:disabled { opacity:.45; cursor:default }
        .bee-inbox-tel:hover { text-decoration:underline !important; text-underline-offset:2px }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
        {/* Selection entry — the column-header convention Kevin expects:
            a select-all checkbox at the TOP-LEFT above the rows' checkbox
            column (left inset matches the row padding so they line up).
            One gesture enters selection mode and select-alls; in mode
            it's tri-state (indeterminate on a partial selection). The
            other door in is a row long-press. */}
        {visibleRows.length > 0 && (
          <input type="checkbox" aria-label="Select all" title="Select all"
            disabled={selectableIds.size === 0}
            checked={selectMode && selCount > 0 && selCount === selectableIds.size}
            ref={(el) => { if (el) el.indeterminate = selectMode && selCount > 0 && selCount < selectableIds.size }}
            onChange={headerSelectAll}
            style={{
              width: '16px', height: '16px', flexShrink: 0,
              margin: 0, marginLeft: isMobile ? '14px' : '16px',
              accentColor: T.accent.fg,
              opacity: selectableIds.size === 0 ? 0.35 : 1,
              cursor: selectableIds.size === 0 ? 'not-allowed' : 'pointer',
            }} />
        )}
        <span style={{ flex: 1 }} />
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

      {/* Bulk action bar — select-all-visible (respects active filters),
          count chip, Remove (N) + Cancel; N>5 swaps in a confirm step. */}
      {selectMode && (
        <div role="toolbar" aria-label="Bulk actions"
          style={{
            display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px',
            padding: '8px 12px', background: T.surface.raised,
            border: T.border.card, boxShadow: T.shadow.card, borderRadius: T.radius.card,
          }}>
          <button onClick={toggleSelectAll} disabled={selectableIds.size === 0}
            style={{ padding: '5px 10px', borderRadius: T.radius.control, border: 'none', background: 'transparent', fontSize: '12px', fontWeight: 500, color: selectableIds.size === 0 ? T.ink.quiet : T.accent.fg, cursor: selectableIds.size === 0 ? 'default' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            {selCount === selectableIds.size && selCount > 0 ? 'Clear selection' : `Select all (${selectableIds.size})`}
          </button>
          <span style={{ fontSize: '11px', fontWeight: 500, color: T.ink.secondary, background: T.surface.sunken, borderRadius: T.radius.pill, padding: '3px 10px', whiteSpace: 'nowrap' }}>
            {selCount} selected
          </span>
          <span style={{ flex: 1 }} />
          {confirmRemove && selCount > 5 ? (
            <>
              <span style={{ fontSize: '12px', color: T.ink.secondary }}>
                Remove {selCount} leads? They move to the Bin and drips stop.
              </span>
              <button onClick={bulkRemoveSelected} disabled={busyId === 'bulk'}
                style={{ padding: '6px 14px', borderRadius: T.radius.control, border: 'none', background: T.state.danger.strong, fontSize: '12px', fontWeight: 600, color: T.ink.inverse, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: busyId === 'bulk' ? 0.6 : 1 }}>
                Remove {selCount}
              </button>
              <button onClick={() => setConfirmRemove(false)}
                style={{ padding: '6px 12px', borderRadius: T.radius.control, border: T.border.control, background: 'transparent', fontSize: '12px', color: T.ink.secondary, cursor: 'pointer', fontFamily: 'inherit' }}>
                Keep
              </button>
            </>
          ) : (
            <>
              {selCount > 0 && (
                <button onClick={requestRemove} disabled={busyId === 'bulk'}
                  style={{ padding: '6px 14px', borderRadius: T.radius.control, border: 'none', background: T.state.danger.strong, fontSize: '12px', fontWeight: 600, color: T.ink.inverse, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: busyId === 'bulk' ? 0.6 : 1 }}>
                  Remove ({selCount})
                </button>
              )}
              <button onClick={exitSelect}
                style={{ padding: '6px 12px', borderRadius: T.radius.control, border: T.border.control, background: 'transparent', fontSize: '12px', color: T.ink.secondary, cursor: 'pointer', fontFamily: 'inherit' }}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {fresh.length === 0 && working.length === 0 ? (
        inboxFilterCount(filters) > 0 ? (
          <FilteredEmpty count={inboxFilterCount(filters)} onClear={clearFilters} noun="inbox leads" />
        ) : (
        <div style={{ padding: '36px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px', border: T.border.dashedSoft, borderRadius: T.radius.inset }}>
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
              <div style={{ padding: '20px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px', border: T.border.dashedSoft, borderRadius: T.radius.inset }}>
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
              <div style={{ padding: '20px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px', border: T.border.dashedSoft, borderRadius: T.radius.inset }}>
                Leads you’ve reached out to appear here — log a call or email from any client
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
