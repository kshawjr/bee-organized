// components/admin/AdminFeedbackScreen.jsx
// ─────────────────────────────────────────────────────────────
// The Feedback triage surface — org-wide list + detail modal.
//
// THREE mount sites, all in BeeHub.jsx, all rendering THIS component:
//   1. SuperAdminLayout  → Feedback tab   (elevated, org-wide)
//   2. legacy AdminScreen → Feedback tab  (elevated, org-wide)
//   3. franchise owner/manager nav        (server-scoped to their location)
// The franchise mount is distinguished by the onReportFeedback prop — it also
// drops the location filter and the row meta's location segment, because on
// that mount every row IS the caller's own location.
//
// ─── THE issue 233 REBUILD ────────────────────────────────────
// What was wrong, and what replaced it:
//
//   ONE FLAT LIST OF EVERYTHING, sorted by arrival. Sixty-three rows, the
//   seventeen that needed action interleaved with the thirty-four already
//   shipped, so every visit began by clicking a status chip. → Closed items are
//   HIDDEN behind a "Show N closed" toggle, and the status chips are gone,
//   replaced by three QUEUE CARDS that name the three states that need
//   different things from you.
//
//   TWO CONTRADICTING OPEN COUNTS. The dashboard card said 17 (submitted only);
//   this header said 28 (not shipped/declined). → ONE number, from
//   lib/feedback-queues, read by the header, the cards, the nav badge and the
//   dashboard alike. See that module for why the wider definition won.
//
//   THE BACKLOG NOBODY COUNTED. Items parked in under_review/planned were
//   "handled" to one number and undifferentiated to the other; three had been
//   quiet for 58 days. → the "Going stale" card, which is only that.
//
//   TITLE-ONLY ROWS. Two items both called "Problem with Engagement" read as
//   duplicates and were not. → rows carry the first two lines of the
//   description.
//
//   THE CONTEXT POINTER, stored and indexed and never rendered. → "Open the
//   record" on the row, and a named card in the modal.
//
//   SEVENTEEN OPEN-READ-CLOSE CYCLES. → next/previous inside the modal, walking
//   the queue you came from, with a position counter.
//
//   A REPLY THAT WENT NOWHERE. → the modal renders an existing reply AS a
//   reply, and saving a new one emails the submitter (the route does the
//   sending; this screen reports the outcome).
//
// TOKENIZATION. This file carries NO color literal of its own — every value
// resolves through T / the ui tokens, and that includes comments, so issue
// numbers are written "issue 233" and never with a hash prefix the sweep in
// lib/beta-feedback-triage-ui.test.tsx would read as a hex.
'use client'

import React, { useState, useEffect, useContext, useMemo, useCallback } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_COUNT } from '@/components/ui/tokens'
import FilterChips from '@/components/ui/FilterChips'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import {
  IconBug, IconBulb, IconPlus, IconPaperclip, IconExternalLink,
  IconChevronRight, IconCheck, IconAlertTriangle,
} from '@/components/ui/icons'
// The feedback chip anatomy + status vocabulary live in feedbackShared (one
// home for this surface's My-Items cards, the modal, and this screen); the
// queue arithmetic lives in lib/feedback-queues, shared with the nav badge and
// the admin dashboard so the numbers cannot drift apart again.
import {
  feedbackTimeAgo, FeedbackAttachmentList, FeedbackStatusBadge,
  FEEDBACK_STATUS_PLAIN, FEEDBACK_STATUS_ORDER,
} from '@/components/feedback/feedbackShared'
import {
  summarizeFeedbackQueues, feedbackQueueOf, isClosedFeedback,
  isAnsweredButUnmoved, feedbackAgeDays, feedbackLastTouchDays,
  FEEDBACK_STALE_DAYS,
} from '@/lib/feedback-queues'

// ── the three queues, in the order they should be worked ──────
// Each card is a filter. `tone` picks the semantic family: the untouched queue
// is informational, the stale queue is the warning (it is the one that has gone
// wrong quietly), work-in-progress wears the action accent.
const QUEUES = [
  { key: 'new',     label: 'Not looked at yet', tone: 'info' },
  { key: 'stale',   label: 'Going stale',       tone: 'warning' },
  { key: 'working', label: 'Being worked on',   tone: 'accent' },
]

const TONES = {
  info:    { bg: T.state.info.bg,    ink: T.state.info.deep,    edge: T.state.info.mid },
  warning: { bg: T.state.warning.bg, ink: T.state.warning.deep, edge: T.state.warning.fg },
  accent:  { bg: T.accent.soft,      ink: T.accent.deep,        edge: T.accent.fg },
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}` }

// Days → the words an owner would use. Used for card hints and row ages.
function dayPhrase(days) {
  if (days == null) return null
  if (days <= 0) return 'today'
  if (days === 1) return '1 day'
  return `${days} days`
}

// ── QUEUE CARD ────────────────────────────────────────────────
// Caps at 210px and does NOT stretch: three cards on a wide admin screen must
// not become three enormous banners, and a queue that empties must not make its
// neighbours grow. flex-grow stays 0 for exactly that reason.
function QueueCard({ label, count, hint, tone, active, onClick }) {
  const c = TONES[tone] || TONES.info
  const empty = count === 0
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: '0 1 210px', maxWidth: '210px', minWidth: '150px',
        textAlign: 'left', padding: '12px 14px', cursor: 'pointer',
        borderRadius: T.radius.control, fontFamily: 'inherit',
        background: empty ? T.surface.sunken : c.bg,
        border: active ? `1.5px solid ${c.edge}` : T.border.thin,
        opacity: empty ? 0.75 : 1,
      }}
    >
      <span style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: empty ? T.ink.muted : c.ink }}>
        {label}
      </span>
      <span style={{ display: 'block', fontSize: '24px', fontWeight: 500, lineHeight: 1.25, color: empty ? T.ink.quiet : c.ink, fontVariantNumeric: T.type.tabular }}>
        {count}
      </span>
      <span style={{ display: 'block', fontSize: '11px', color: empty ? T.ink.quiet : c.ink, opacity: empty ? 1 : 0.85, minHeight: '15px' }}>
        {hint || ''}
      </span>
    </button>
  )
}

// ── THE RECORD POINTER ────────────────────────────────────────
// feedback_items.context is an id-only pointer (issue 110a) filed by the
// "Report a problem with this client / engagement" menus. The name is resolved
// live by the GET route (context_client_name) rather than stored, so a renamed
// client reads correctly. This is the one field that takes you to the thing
// that is broken; before issue 233 it was written, indexed, and shown nowhere.
function contextHref(item) {
  const path = item?.context?.path
  return typeof path === 'string' && path.startsWith('/') ? path : null
}
function contextLabel(item) {
  const ctx = item?.context
  if (!ctx) return null
  const name = item.context_client_name
  const kind = ctx.kind === 'engagement' ? 'engagement' : 'client'
  if (name) return `${name}${ctx.stage ? ` · ${ctx.stage}` : ''}`
  // No name resolved (deleted record, or the lookup failed) — still say what it
  // points at rather than showing a bare link.
  return ctx.stage ? `This ${kind} · ${ctx.stage}` : `This ${kind}`
}

function ContextCard({ item }) {
  const href = contextHref(item)
  const label = contextLabel(item)
  if (!label) return null
  const inner = (
    <>
      <span style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: T.ink.muted, marginBottom: '3px' }}>
        Filed from this record
      </span>
      <span style={{ display: 'block', fontSize: '14px', fontWeight: 500, color: T.ink.primary }}>{label}</span>
      {href && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', marginTop: '7px', fontSize: '13px', fontWeight: 600, color: T.accent.fg }}>
          Open the record <IconExternalLink size={13} />
        </span>
      )}
    </>
  )
  const boxStyle = {
    display: 'block', padding: '12px 14px', borderRadius: T.radius.control,
    background: T.surface.sunken, border: T.border.thin, textDecoration: 'none',
  }
  if (!href) return <div style={boxStyle}>{inner}</div>
  return <a href={href} style={boxStyle}>{inner}</a>
}

// ── DETAIL MODAL ──────────────────────────────────────────────
// `walk` is a SNAPSHOT of the queue taken when the modal opened — an array of
// ids plus the current index. It is deliberately not the live filtered list:
// changing an item's status re-files it into another queue, and a list that
// re-sorts under you mid-triage would jump you to a different item every time
// you saved. Next/previous therefore walk a stable order and stop at both ends.
// `isOwnItem` — the viewer filed this one themselves. Route rule 4 skips the
// send in that case, so the composer must not promise an email (issue 235
// defect B). This stayed wrong on the admin mount too, not just the franchise
// one: a super_admin who files feedback and later answers it is the same case,
// just rarer than the owner screen where it was every single item.
function AdminFeedbackDetailModal({ item, walkLabel, position, total, isOwnItem = false, onPrev, onNext, onClose, onSaved }) {
  const [status, setStatus]     = useState(item.status)
  const [response, setResponse] = useState('')
  const [composing, setComposing] = useState(!item.admin_response)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)
  const [result, setResult]     = useState(null)

  // Moving to another item through next/previous re-points this same mounted
  // modal, so every per-item piece of state has to be re-seeded from the new
  // item — otherwise the previous item's draft reply follows you.
  useEffect(() => {
    setStatus(item.status)
    setResponse('')
    setComposing(!item.admin_response)
    setError(null)
    setResult(null)
  }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = status !== item.status || response.trim().length > 0
  // Does Save actually send? The button used to read "Save and send" whenever
  // anything was typed, including the two cases the route refuses to mail —
  // your own item (rule 4) and a submitter with no address on file.
  const willSend = response.trim().length > 0 && !isOwnItem && !!item.submitter_email

  async function save() {
    setSaving(true)
    setError(null)
    setResult(null)
    try {
      // admin_response is only SENT when something was typed. Omitting the key
      // leaves the stored reply untouched — a status-only save must never blank
      // an existing reply, and must never re-send it either.
      const body = { status }
      if (response.trim()) body.admin_response = response.trim()
      const res = await fetch(`/api/admin/feedback/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const updated = await res.json()
      // The modal STAYS OPEN. The whole point of next/previous is an
      // uninterrupted pass through a queue; closing on every save would put
      // back the open-read-close cycle this replaced.
      setResponse('')
      setComposing(false)
      setResult(updated.reply_email ?? { sent: false, skipped: 'no_reply_written' })
      onSaved(updated)
    } catch (e) {
      setError('Could not save — please try again.')
    } finally {
      setSaving(false)
    }
  }

  const fieldLabel = { display: 'block', fontSize: '12px', fontWeight: 700, color: T.ink.primary, marginBottom: '6px' }
  const bug = item.type === 'bug'
  const submitted = feedbackAgeDays(item.created_at)

  // What the confirmation line says. Each branch is a real outcome from the
  // route, named plainly — "saved" alone would hide a reply that never sent.
  const resultLine = (() => {
    if (!result) return null
    if (result.sent) return { tone: 'ok', text: `Saved. We emailed your reply to ${result.to}.` }
    if (result.error) return { tone: 'bad', text: `Saved — but the email did not go out (${result.error}). Your reply is stored.` }
    if (result.skipped === 'no_submitter_email') return { tone: 'bad', text: 'Saved. No email on file for this person, so nothing was sent.' }
    if (result.skipped === 'replied_to_own_item') return { tone: 'ok', text: 'Saved. This is your own report, so no email was sent.' }
    return { tone: 'ok', text: 'Saved.' }
  })()

  const navBtn = (label, onClick, disabled) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '5px 10px', borderRadius: T.radius.control, border: T.border.control,
        background: 'transparent', fontFamily: 'inherit', fontSize: '12px', fontWeight: 600,
        color: disabled ? T.ink.disabled : T.ink.secondary,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  )

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: T.surface.scrim, fontFamily: '"DM Sans",system-ui,sans-serif' }}>
      <div style={{ background: T.surface.raised, borderRadius: T.radius.card, width: '100%', maxWidth: '640px', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: T.shadow.overlay, overflow: 'hidden' }}>

        {/* header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: T.border.divider, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
            <h2 style={{ fontSize: '16px', fontFamily: 'Georgia,serif', color: T.ink.primary, margin: 0, lineHeight: 1.35, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ width: '24px', height: '24px', borderRadius: T.radius.chip, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: bug ? T.state.danger.soft : T.state.info.soft, color: bug ? T.state.danger.fg : T.state.info.mid }}>
                {bug ? <IconBug size={13} /> : <IconBulb size={13} />}
              </span>
              {item.title}
            </h2>
            <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: T.ink.muted, cursor: 'pointer', fontSize: '24px', lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
          </div>
          {/* POSITION + WALK. "2 of 17 not looked at" — you always know how much
              of the queue is left, which is what makes a pass through it finite. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '10px' }}>
            <span style={{ fontSize: '12px', color: T.ink.muted }}>
              {position} of {total}{walkLabel ? ` ${walkLabel}` : ''}
            </span>
            <span style={{ display: 'inline-flex', gap: '6px' }}>
              {navBtn('‹ Previous', onPrev, position <= 1)}
              {navBtn('Next ›', onNext, position >= total)}
            </span>
          </div>
        </div>

        <div style={{ padding: '18px 20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* who + when */}
          <div style={{ fontSize: '12px', color: T.ink.secondary, lineHeight: 1.6 }}>
            <div><strong>From:</strong> {item.submitter_name || 'Unknown'}{item.submitter_email ? ` · ${item.submitter_email}` : ''}</div>
            <div><strong>Location:</strong> {item.location_name || '—'}</div>
            <div>
              <strong>Submitted:</strong> {feedbackTimeAgo(item.created_at)}
              {submitted != null && submitted >= 1 ? ` (${dayPhrase(submitted)} ago)` : ''}
            </div>
          </div>

          {/* the record it was filed from */}
          <ContextCard item={item} />

          <div>
            <p style={{ fontSize: '12px', fontWeight: 700, color: T.ink.primary, marginBottom: '6px' }}>Description</p>
            <p style={{ fontSize: '13px', color: T.ink.secondary, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.description}</p>
          </div>

          {Array.isArray(item.attachments) && item.attachments.length > 0 && (
            <div>
              <p style={{ fontSize: '12px', fontWeight: 700, color: T.ink.primary, marginBottom: '6px' }}>
                Attachments ({item.attachments.length})
              </p>
              <FeedbackAttachmentList attachments={item.attachments} thumb={88} />
            </div>
          )}

          {/* ── STATUS as buttons, not a dropdown ──────────────────
              Six options is a row you can read at a glance; a select hides five
              of them behind a click and gives no sense of where this item sits
              in the sequence. */}
          <div>
            <label style={fieldLabel}>Status</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {FEEDBACK_STATUS_ORDER.map(s => {
                const on = status === s
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    aria-pressed={on}
                    style={{
                      padding: '7px 12px', borderRadius: T.radius.control, fontFamily: 'inherit',
                      fontSize: '12px', fontWeight: on ? 700 : 500, cursor: 'pointer',
                      border: on ? 'none' : T.border.control,
                      background: on ? T.accent.fg : 'transparent',
                      color: on ? T.accent.onFill : T.ink.secondary,
                    }}
                  >
                    {FEEDBACK_STATUS_PLAIN[s]}
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── THE REPLY ──────────────────────────────────────────
              An existing reply renders AS A REPLY — read-only, attributed,
              dated. It used to be prefilled into the textarea, so the owner who
              opened their own item saw the team's answer as a form field they
              could overwrite by accident. Writing a new one is a deliberate
              act behind its own button. */}
          <div>
            <label style={fieldLabel}>Reply to {item.submitter_name || 'the submitter'}</label>
            {item.admin_response && (
              <div style={{ padding: '12px 14px', borderRadius: T.radius.control, background: T.accent.faint, border: T.border.thin, marginBottom: composing ? '10px' : 0 }}>
                <p style={{ fontSize: '11px', fontWeight: 700, color: T.ink.muted, marginBottom: '5px' }}>
                  Replied{item.admin_response_at ? ` ${feedbackTimeAgo(item.admin_response_at)}` : ''}
                </p>
                <p style={{ fontSize: '13px', color: T.ink.primary, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {item.admin_response}
                </p>
              </div>
            )}
            {item.admin_response && !composing && (
              <button
                type="button"
                onClick={() => setComposing(true)}
                className="bee-small-action"
                style={{ marginTop: '8px', padding: 0, background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}
              >
                Write a new reply
              </button>
            )}
            {composing && (
              <>
                <textarea
                  value={response}
                  onChange={e => setResponse(e.target.value)}
                  rows={4}
                  placeholder={item.admin_response ? 'Your new reply replaces the one above.' : 'Write back in plain words — they will read this in an email.'}
                  style={{ width: '100%', padding: '10px 12px', border: T.border.control, borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised, boxSizing: 'border-box', outline: 'none', resize: 'vertical', lineHeight: 1.5 }}
                />
                {/* Says exactly what Save will do. The old copy claimed the box
                    was "shown to the submitter" while nothing was sent. */}
                <p style={{ fontSize: '11px', color: T.ink.muted, marginTop: '6px', lineHeight: 1.5 }}>
                  {response.trim()
                    ? (isOwnItem
                        ? 'This is your own report — saving stores the reply, but no email is sent.'
                        : item.submitter_email
                          ? `Saving emails this to ${item.submitter_email}.`
                          : 'No email on file for this person — saving stores the reply but sends nothing.')
                    : 'Saving with the box empty changes the status only. No email is sent.'}
                </p>
              </>
            )}
          </div>

          {error && <p style={{ fontSize: '12px', color: T.state.danger.strong }}>{error}</p>}
          {resultLine && (
            <p style={{ fontSize: '12px', lineHeight: 1.5, color: resultLine.tone === 'bad' ? T.state.danger.strong : T.accent.deep }}>
              {resultLine.text}
            </p>
          )}
        </div>

        <div style={{ padding: '14px 20px', borderTop: T.border.divider, display: 'flex', justifyContent: 'flex-end', gap: '10px', flexShrink: 0 }}>
          <button onClick={onClose} style={{ padding: '10px 16px', background: 'transparent', border: T.border.control, borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit', fontWeight: 600, color: T.ink.secondary, cursor: 'pointer' }}>Close</button>
          <button onClick={save} disabled={saving || !dirty} style={{ padding: '10px 18px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit', fontWeight: 700, color: T.accent.onFill, cursor: (saving || !dirty) ? 'default' : 'pointer', opacity: (saving || !dirty) ? 0.6 : 1 }}>
            {saving ? 'Saving…' : (willSend ? 'Save and send' : 'Save')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AdminFeedbackScreen({
  // Reports the ONE open count (lib/feedback-queues) up to the nav badge. Named
  // for what it now carries: it used to report the 'submitted' count only,
  // which is half of why the badge and this header disagreed.
  onOpenCountChange = () => {},
  // VIEW-AS DATA SCOPING IS PER-SURFACE: "view as" swaps displayed
  // role/name only — API calls still ride the REAL session, so when a
  // super_admin impersonates an owner this screen's fetch takes the
  // route's elevated branch and returns ORG-WIDE feedback (over-exposes
  // to the impersonator; real owner sessions are hard-scoped server-side
  // and unaffected). The franchise mount passes the impersonated
  // locationId and /api/admin/feedback already honors ?location_id= for
  // elevated callers.
  locationId = null,
  // Composer affordance (opens the existing FeedbackModal). Passed by the
  // franchise feedback mount; the elevated admin mounts omit it.
  onReportFeedback = null,
}) {
  const [items, setItems]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [typeFilter, setTypeFilter] = useState('all')
  // Which queue card is selected, or 'all'. Replaces the status chips.
  const [queueFilter, setQueueFilter] = useState('all')
  // Closed items are HIDDEN by default — thirty-four decided items were the
  // bulk of the list and none of them needed anything.
  const [showClosed, setShowClosed]   = useState(false)
  const [mineOnly, setMineOnly]       = useState(false)
  const [locFilter, setLocFilter]     = useState('all')
  const [userQuery, setUserQuery]     = useState('')
  // The open modal, as an id plus the snapshot of the queue it was opened from.
  const [walk, setWalk] = useState(null)

  // "Just mine" matches the viewer's own submissions by user_id. Deliberately
  // NOT persisted — every filter here resets on navigation (issue 126). A
  // stored filter would strand someone behind a view they set weeks ago and
  // don't remember (the issue 123 trap).
  const currentUserCtx = useContext(CurrentUserContext)
  const myId = currentUserCtx?.id || null

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = locationId
        ? `/api/admin/feedback?location_id=${encodeURIComponent(locationId)}`
        : '/api/admin/feedback'
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(Array.isArray(data.items) ? data.items : [])
    } catch (e) {
      setError("Couldn't load feedback. Please try again.")
    } finally {
      setLoading(false)
    }
  }, [locationId])

  useEffect(() => { load() }, [load])

  // ONE count, computed once, shared by the header, the cards and the badge.
  const summary = useMemo(() => summarizeFeedbackQueues(items), [items])

  useEffect(() => { onOpenCountChange(summary.open) }, [summary.open, onOpenCountChange])

  const locOptions = useMemo(() => {
    const seen = new Map()
    items.forEach(i => { if (i.location_id) seen.set(i.location_id, i.location_name || i.location_id) })
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [items])

  // Per-axis match predicates, kept separate so the type counts below can stay
  // FACETED — each chip's number is exactly what that choice would show given
  // the other active filters, so the count never lies and no one clicks into an
  // empty list (the issue 119 lesson).
  const matchType   = (i, t) => t === 'all' || i.type === t
  const matchMine   = (i, m) => !m || (!!myId && i.user_id === myId)
  const matchLoc    = (i)    => locFilter === 'all' || i.location_id === locFilter
  // Search now covers what the item SAYS, not just who sent it. Searching for
  // "nurturing" or "Jobber" used to return nothing however many items said it.
  const matchQuery  = (i) => {
    const q = userQuery.trim().toLowerCase()
    if (!q) return true
    return `${i.title || ''} ${i.description || ''} ${i.submitter_name || ''} ${i.submitter_email || ''}`
      .toLowerCase().includes(q)
  }
  // Closed rows appear ONLY behind the toggle; the queue cards only ever select
  // open items, so picking a queue implies open regardless of the toggle.
  const matchClosed = (i) => showClosed || !isClosedFeedback(i.status)
  const matchQueue  = (i) => queueFilter === 'all' || feedbackQueueOf(i) === queueFilter

  const baseMatch = useCallback((i) =>
    matchType(i, typeFilter) && matchMine(i, mineOnly) && matchLoc(i) && matchQuery(i),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typeFilter, mineOnly, locFilter, userQuery, myId])

  const filtered = useMemo(() => {
    const rows = items.filter(i => baseMatch(i) && matchQueue(i) && matchClosed(i))
    // ORDER. The backlog queues sort LONGEST-WAITING FIRST — that is the entire
    // point of looking at them, and newest-first buried the three items that
    // had been quiet for fifty-eight days at the bottom of the list. Every
    // other view keeps the arrival order the list has always had.
    if (queueFilter === 'new') {
      return [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    }
    if (queueFilter === 'stale') {
      return [...rows].sort((a, b) =>
        new Date(a.updated_at || a.created_at) - new Date(b.updated_at || b.created_at))
    }
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, baseMatch, queueFilter, showClosed])

  const franchiseMount = !!onReportFeedback

  // Faceted type counts, computed against the SAME visible set as the list
  // (queue + closed-toggle included) so a chip never promises rows the current
  // view would not show.
  const visibleForType = useMemo(
    () => items.filter(i => matchQueue(i) && matchClosed(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, queueFilter, showClosed],
  )
  const countType = t => visibleForType.filter(i =>
    matchType(i, t) && matchMine(i, mineOnly) && matchLoc(i) && matchQuery(i)).length
  const countMine = m => visibleForType.filter(i =>
    matchType(i, typeFilter) && matchMine(i, m) && matchLoc(i) && matchQuery(i)).length

  const typeItems = [
    { key: 'all',     label: 'Everything', count: countType('all') },
    { key: 'bug',     label: 'Bugs',       count: countType('bug') },
    { key: 'feature', label: 'Ideas',      count: countType('feature') },
  ]
  const mineItems = [
    { key: 'everyone', label: 'Everyone',  count: countMine(false) },
    { key: 'mine',     label: 'Just mine', count: countMine(true) },
  ]

  const queueHint = (key) => {
    if (key === 'new') {
      return summary.oldestNewDays != null
        ? `oldest waiting ${dayPhrase(summary.oldestNewDays)}`
        : 'nothing waiting'
    }
    if (key === 'stale') {
      return summary.counts.stale
        ? `quiet ${FEEDBACK_STALE_DAYS}+ days${summary.oldestStaleDays != null ? `, worst ${dayPhrase(summary.oldestStaleDays)}` : ''}`
        : `nothing quiet ${FEEDBACK_STALE_DAYS}+ days`
    }
    return summary.counts.working ? 'in progress now' : 'nothing in progress'
  }

  // The words after "2 of 17" in the modal.
  const walkLabel = queueFilter === 'all'
    ? (showClosed ? '' : 'open')
    : (QUEUES.find(q => q.key === queueFilter)?.label || '').toLowerCase()

  const selectedItem = walk ? items.find(i => i.id === walk.ids[walk.index]) : null

  const openRow = (id) => setWalk({ ids: filtered.map(i => i.id), index: filtered.findIndex(i => i.id === id) })
  const step = (delta) => setWalk(w => {
    if (!w) return w
    const next = w.index + delta
    return next < 0 || next >= w.ids.length ? w : { ...w, index: next }
  })

  const quietInput = { padding: '7px 10px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised, cursor: 'pointer' }

  return (
    <div style={{ padding: '14px 1.25rem 1rem', fontFamily: 'DM Sans,system-ui,sans-serif' }}>
      {/* HEADER — one open count, the same number the cards and the badge use. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
        <div>
          <h2 style={{ fontSize: '19px', fontWeight: 500, color: T.ink.primary, margin: 0, lineHeight: 1.3 }}>Feedback</h2>
          <p style={{ ...SECTION_COUNT, color: T.ink.muted, marginTop: '2px' }}>
            {loading || error ? '—' : `${plural(summary.open, 'open item', 'open items')} · ${summary.total} in total`}
          </p>
        </div>
        {onReportFeedback && (
          <button
            onClick={onReportFeedback}
            aria-label="Report a bug or share an idea"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: '36px', padding: '0 14px', borderRadius: T.radius.control, border: 'none', background: T.state.info.soft, color: T.state.info.mid, fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            <IconPlus size={13} /> Report a bug or share an idea
          </button>
        )}
      </div>

      {/* THE THREE QUEUES. Clicking a card filters to it; clicking the selected
          card again clears back to everything open. */}
      {!loading && !error && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '8px' }}>
            {QUEUES.map(q => (
              <QueueCard
                key={q.key}
                label={q.label}
                count={summary.counts[q.key]}
                hint={queueHint(q.key)}
                tone={q.tone}
                active={queueFilter === q.key}
                onClick={() => setQueueFilter(cur => (cur === q.key ? 'all' : q.key))}
              />
            ))}
          </div>
          {/* THE REMAINDER, so the cards and the header always reconcile: open
              items that are picked up and were touched recently belong to no
              card, and hiding them would put back two numbers that disagree. */}
          {summary.counts.inHand > 0 && (
            <p style={{ fontSize: '12px', color: T.ink.muted, marginBottom: '10px' }}>
              {summary.counts.inHand === 1
                ? '1 more open item is in hand — picked up and updated recently.'
                : `${summary.counts.inHand} more open items are in hand — picked up and updated recently.`}
              {' '}
              <button
                type="button"
                onClick={() => setQueueFilter(cur => (cur === 'inHand' ? 'all' : 'inHand'))}
                className="bee-small-action"
                style={{ padding: 0, background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}
              >
                {queueFilter === 'inHand' ? 'Show everything open' : 'Show them'}
              </button>
            </p>
          )}
        </>
      )}

      {/* TYPE — single-choice segmented control (underline-active, not a fill). */}
      <div style={{ marginBottom: '9px' }}>
        <FilterChips items={typeItems} active={typeFilter} onChange={setTypeFilter} wrap />
      </div>
      {/* "Just mine" + location (elevated only) + search + the closed toggle. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px', marginBottom: '14px' }}>
        {myId && (
          <FilterChips
            items={mineItems}
            active={mineOnly ? 'mine' : 'everyone'}
            onChange={k => setMineOnly(k === 'mine')}
          />
        )}
        {!franchiseMount && (
          <select value={locFilter} onChange={e => setLocFilter(e.target.value)} style={quietInput}>
            <option value="all">All locations</option>
            {locOptions.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        <input value={userQuery} onChange={e => setUserQuery(e.target.value)} placeholder="Search name, title or description" style={{ ...quietInput, cursor: 'text', flex: '1 1 200px', maxWidth: '320px' }} />
        {summary.closed > 0 && (
          <button
            type="button"
            onClick={() => setShowClosed(v => !v)}
            aria-pressed={showClosed}
            style={{ ...quietInput, fontWeight: 600, color: showClosed ? T.ink.primary : T.ink.secondary, background: showClosed ? T.surface.sunken : T.surface.raised }}
          >
            {showClosed ? `Hide ${summary.closed} closed` : `Show ${summary.closed} closed`}
          </button>
        )}
      </div>

      {loading ? (
        <BeeLoader size="screen" label="Gathering the records…" />
      ) : error ? (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ fontSize: '13px', color: T.state.danger.strong, marginBottom: '10px' }}>{error}</p>
          <button onClick={load} style={{ padding: '8px 16px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', fontWeight: 600, color: T.accent.onFill, cursor: 'pointer' }}>Retry</button>
        </div>
      ) : filtered.length === 0 ? (
        <p style={{ fontSize: '13px', color: T.ink.muted, textAlign: 'center', padding: '30px 0' }}>
          {items.length === 0
            ? 'No feedback submitted yet.'
            : summary.open === 0 && queueFilter === 'all' && !showClosed
              ? 'Nothing open — everything has been answered or decided.'
              : 'No feedback matches these filters.'}
        </p>
      ) : (
        /* One rounded container, hairline-divided rows — not per-row boxes. */
        <div style={{ background: T.surface.raised, border: T.border.thin, borderRadius: '12px', overflow: 'hidden' }}>
          {filtered.map((it, idx) => {
            const closed = isClosedFeedback(it.status)
            const bug = it.type === 'bug'
            const stranded = isAnsweredButUnmoved(it)
            const answered = !!(it.admin_response && String(it.admin_response).trim())
            const href = contextHref(it)
            const quiet = feedbackLastTouchDays(it)
            return (
              <div key={it.id} style={{ borderTop: idx === 0 ? 'none' : T.border.divider, opacity: closed ? 0.72 : 1 }}>
                <button
                  onClick={() => openRow(it.id)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'flex-start', gap: '12px',
                    padding: '12px 14px 8px', border: 'none',
                    background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                  }}
                >
                  <span style={{ width: '28px', height: '28px', borderRadius: T.radius.chip, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '1px', background: bug ? T.state.danger.soft : T.state.info.soft, color: bug ? T.state.danger.fg : T.state.info.mid }}>
                    {bug ? <IconBug size={15} /> : <IconBulb size={15} />}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
                      <span style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
                      {Array.isArray(it.attachments) && it.attachments.length > 0 && (
                        <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '11px', color: T.ink.muted }}>
                          <IconPaperclip size={11} />{it.attachments.length}
                        </span>
                      )}
                    </span>
                    {/* THE DESCRIPTION — two lines, clamped. Titles alone made
                        two unrelated reports read as duplicates. */}
                    {it.description && (
                      <span style={{
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        overflow: 'hidden', fontSize: '12px', color: T.ink.secondary,
                        lineHeight: 1.45, marginTop: '3px', wordBreak: 'break-word',
                      }}>
                        {it.description}
                      </span>
                    )}
                    <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', fontSize: '11px', color: T.ink.muted, marginTop: '4px' }}>
                      <span>
                        {it.submitter_name || 'Unknown'}
                        {!franchiseMount && it.location_name ? ` · ${it.location_name}` : ''}
                        {` · ${feedbackTimeAgo(it.created_at)}`}
                      </span>
                      {/* ANSWERED-BUT-UNMOVED. A reply was written and the
                          status never moved, so it still reads as untouched and
                          keeps ringing the "nobody has looked" queue. */}
                      {stranded ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: T.state.warning.deep, fontWeight: 600 }}>
                          <IconAlertTriangle size={11} /> Replied, still marked New
                        </span>
                      ) : answered ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: T.accent.deep }}>
                          <IconCheck size={11} /> Replied
                        </span>
                      ) : (
                        <span style={{ color: T.ink.quiet }}>No reply yet</span>
                      )}
                      {/* How long this one has been quiet, on the queue where
                          that is the reason you are looking at it. */}
                      {queueFilter === 'stale' && quiet != null && (
                        <span style={{ color: T.state.warning.deep }}>· quiet {dayPhrase(quiet)}</span>
                      )}
                    </span>
                  </span>
                  <span style={{ flexShrink: 0 }}><FeedbackStatusBadge status={it.status} /></span>
                </button>
                {/* The record pointer is its own target, a sibling of the row
                    button rather than nested inside it — one row, two real
                    destinations, and valid markup. */}
                {href && (
                  <div style={{ padding: '0 14px 10px 54px' }}>
                    <a
                      href={href}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 600, color: T.accent.fg, textDecoration: 'none' }}
                    >
                      Open the record <IconChevronRight size={11} />
                    </a>
                    {contextLabel(it) && (
                      <span style={{ fontSize: '11px', color: T.ink.quiet, marginLeft: '8px' }}>{contextLabel(it)}</span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {selectedItem && walk && (
        <AdminFeedbackDetailModal
          item={selectedItem}
          walkLabel={walkLabel}
          position={walk.index + 1}
          total={walk.ids.length}
          isOwnItem={!!myId && selectedItem.user_id === myId}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onClose={() => setWalk(null)}
          onSaved={(updated) => {
            // reply_email is the route's report on the notification attempt, not
            // a column — the modal renders it, the list must not absorb it.
            const { reply_email: _ignored, ...row } = updated
            setItems(prev => prev.map(i => (i.id === row.id ? { ...i, ...row } : i)))
          }}
        />
      )}
    </div>
  )
}
