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

import React, { useState, useEffect, useContext, useMemo, useCallback, useRef } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_COUNT } from '@/components/ui/tokens'
import FilterChips from '@/components/ui/FilterChips'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import {
  IconBug, IconBulb, IconPlus, IconPaperclip, IconExternalLink,
  IconChevronRight, IconCheck, IconAlertTriangle, IconSelector,
} from '@/components/ui/icons'
// The four-value type vocabulary (issue 247 step 2). Labels and the
// known-value predicate only — the write validators live in their routes and
// are deliberately not shared; see lib/feedback-types.
import {
  INTERNAL_ONLY_TYPES, FEEDBACK_TYPE_TAB_LABEL, isKnownFeedbackType,
} from '@/lib/feedback-types'
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
  // issue 306 — the derived "have they seen it?" state and the work order.
  hasFeedbackReply, isAwaitingConfirmation, sortForTriage,
} from '@/lib/feedback-queues'
// issue 308 — the paste-ready session prompt. The text and the two tiers live
// in the lib; this file owns the button, the gesture and the failure path.
import { buildCopyPrompt, promptTierFor } from '@/lib/feedback-prompt'
// The conversation thread (feedback_replies + the legacy single-reply merge),
// shared with the owner screen so both render the same history from the same
// builder. awaitingTeamReply is the list marker: an owner wrote back and the
// last word is theirs.
import { buildFeedbackThread, awaitingTeamReply } from '@/lib/feedback-replies'

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

// ── VERDICTS (issue 306) ──────────────────────────────────────
// Most items need a decision, not an investigation — one audit pass killed
// twenty of about seventy. These are the wordless ones: each maps onto an
// EXISTING status and is written through the EXISTING route
// (PATCH /api/admin/feedback/:id), the same call the detail modal makes. No
// second status path exists, here or anywhere; a direct database write would
// skip the send rules and is exactly what left five replies undelivered.
//
// THE FOURTH VERDICT — "needs a question" — is deliberately NOT here. A
// question is words, and words belong in the reply box that already exists and
// already mails them. It is offered as "Ask a question", which opens that
// composer on the selected item rather than writing anything.
//
// `emails` mirrors the route's rule 2/2a: moving INTO shipped announces itself
// (issue 236); declined and planned say nothing without a written sentence
// (rule 2b). Mirrored rather than guessed — the modal's own `willSend` line
// does the same — so the confirmation can say how much mail a click sends.
const VERDICTS = [
  { key: 'not_real', label: 'Not real',       status: 'declined', emails: false,
    done: 'Marked not planned' },
  { key: 'fixed',    label: 'Already fixed',  status: 'shipped',  emails: true,
    done: 'Marked fixed' },
  { key: 'keep',     label: 'Real — keep it', status: 'planned',  emails: false,
    done: 'Marked planned' },
]

// ── the type glyph ───────────────────────────────────────────
// ONE place decides the icon and its tone, for all four types and for anything
// unrecognised. Replaces the two `bug ? IconBug : IconBulb` pairs, which gave a
// hazard the lightbulb an idea wears (issue 247 step 2).
//
// bug and feature keep their EXACT existing token pair, so this change adds two
// tones and shifts nothing that was already on screen. decision takes the
// purple family — its own category, not an urgency — and hazard takes the
// warning family, which is what a known risk should read as. An unrecognised
// value gets the neutral family and the generic glyph: quiet, never another
// type's colour.
const TYPE_ICON = {
  bug: IconBug, feature: IconBulb, decision: IconSelector, hazard: IconAlertTriangle,
}
const TYPE_TONE = {
  bug:      { bg: T.state.danger.soft,  fg: T.state.danger.fg },
  feature:  { bg: T.state.info.soft,    fg: T.state.info.mid },
  decision: { bg: T.family.purple.bg,   fg: T.family.purple.text },
  hazard:   { bg: T.state.warning.soft, fg: T.state.warning.fg },
}
const TYPE_TONE_FALLBACK = { bg: T.family.gray.bg, fg: T.family.gray.text }

function TypeGlyph({ type, size = 13, box = 24, style = null }) {
  const key = String(type || '')
  const Icon = TYPE_ICON[key] || IconBulb
  const tone = TYPE_TONE[key] || TYPE_TONE_FALLBACK
  return (
    <span style={{
      width: `${box}px`, height: `${box}px`, borderRadius: T.radius.chip,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, background: tone.bg, color: tone.fg, ...(style || {}),
    }}>
      <Icon size={size} />
    </span>
  )
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}` }

// Days → the words an owner would use. Used for card hints and row ages.
function dayPhrase(days) {
  if (days == null) return null
  if (days <= 0) return 'today'
  if (days === 1) return '1 day'
  return `${days} days`
}

// ── INTERNAL MARKER (issue 306) ───────────────────────────────
// is_internal has been on the row object since issue 247 step 1 and was never
// rendered here. The type glyph distinguishes decision and hazard, but an
// internal BUG looked identical to an owner's bug — and the two need opposite
// handling: one has somebody waiting on an answer, the other does not. There
// are zero internal rows in production today, so this is built against
// fixtures; it is also the reason the marker is a word and not a colour.
function InternalPill() {
  return (
    <span style={{
      flexShrink: 0, display: 'inline-flex', alignItems: 'center',
      padding: '1px 7px', borderRadius: T.radius.pill,
      background: T.family.purple.bg, color: T.family.purple.text,
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.02em',
    }}>
      Internal
    </span>
  )
}

// ── WHO IS THIS WAITING ON? (issue 306) ───────────────────────
// The line that separates "waiting on me" from "waiting on them". Four states,
// in precedence order — the first two are problems, the third is patience, the
// fourth is done:
//
//   1. answered but still marked New  — our own filing error, loudest
//   2. answered, not seen             — THE MISSING STATE. We wrote back and
//      they have not opened it. Five owners sat in this state for seven weeks
//      while the screen said only "Replied", which reads as finished.
//   3. no reply                       — waiting on us; the queue cards above
//      already count it, so it stays quiet here
//   4. answered and seen              — landed; nobody is waiting
//
// Internal items never reach 2 or 4: nobody is on the other end to open them,
// so a seen/unseen distinction would be theatre. They collapse to "Replied".
function ReplyState({ item, internal }) {
  const wrap = (color, weight, children) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color, fontWeight: weight }}>
      {children}
    </span>
  )
  // 0. THEY wrote back and the last word is theirs — the loudest state,
  //    because nothing else about the row changes when an owner replies:
  //    status stays put, admin_response stays put, and without this line the
  //    conversation dies exactly where the old footer-link tab buried it.
  if (!internal && awaitingTeamReply(item)) {
    return wrap(T.state.warning.deep, 600, <><IconAlertTriangle size={11} /> They replied · needs an answer</>)
  }
  if (isAnsweredButUnmoved(item)) {
    return wrap(T.state.warning.deep, 600, <><IconAlertTriangle size={11} /> Replied, still marked New</>)
  }
  if (!hasFeedbackReply(item)) {
    return <span style={{ color: T.ink.quiet }}>No reply yet</span>
  }
  if (internal) return wrap(T.accent.deep, 500, <><IconCheck size={11} /> Replied</>)
  if (isAwaitingConfirmation(item)) {
    return wrap(T.state.info.mid, 600, <><IconCheck size={11} /> Replied · not seen yet</>)
  }
  return wrap(T.accent.deep, 500, <><IconCheck size={11} /> Replied · seen</>)
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
// seedResponse (issue 309): a draft reply, pre-filled into the composer. It is
// a DRAFT — Kevin edits it and presses Save, and Save is the existing PATCH to
// /api/admin/feedback/:id, which is the only thing that sends an email. There
// is no path from a draft to an owner that does not go through this button.
function AdminFeedbackDetailModal({ item, walkLabel, position, total, isOwnItem = false, seedResponse = '', onPrev, onNext, onClose, onSaved }) {
  // The conversation so far — thread rows plus the legacy single reply, merged
  // and ordered by lib/feedback-replies. The composer opens itself when the
  // item is owed words: nothing said yet, or the owner spoke last.
  const thread = buildFeedbackThread(item)
  const owesWords = (it) => {
    const t = buildFeedbackThread(it)
    return t.length === 0 || t[t.length - 1].authorRole === 'owner'
  }
  const [status, setStatus]     = useState(item.status)
  const [response, setResponse] = useState(seedResponse || '')
  const [composing, setComposing] = useState(() => owesWords(item))
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)
  const [result, setResult]     = useState(null)

  // Moving to another item through next/previous re-points this same mounted
  // modal, so every per-item piece of state has to be re-seeded from the new
  // item — otherwise the previous item's draft reply follows you.
  useEffect(() => {
    setStatus(item.status)
    setResponse(seedResponse || '')
    setComposing(owesWords(item))
    setError(null)
    setResult(null)
  }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = status !== item.status || response.trim().length > 0
  // Does Save actually send? The button used to read "Save and send" whenever
  // anything was typed, including the two cases the route refuses to mail —
  // your own item (rule 4) and a submitter with no address on file.
  //
  // Marking something Fixed now sends on its own (issue 236), so the button has
  // to know that too — otherwise this screen would have the inverse of the
  // defect issue 235 just fixed: mail leaving under a button that said "Save".
  // The transition test mirrors the route's exactly (INTO shipped, not AT it),
  // so the button and the send agree about re-saving an already-fixed item.
  const shipsNow = status === 'shipped' && item.status !== 'shipped'
  const canNotify = !isOwnItem && !!item.submitter_email
  const willSend = (response.trim().length > 0 || shipsNow) && canNotify

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
  const submitted = feedbackAgeDays(item.created_at)

  // What the confirmation line says. Each branch is a real outcome from the
  // route, named plainly — "saved" alone would hide a reply that never sent.
  const resultLine = (() => {
    if (!result) return null
    if (result.sent) {
      // The route says WHICH email went — it is the only party that knows,
      // since "is this reply new?" is decided against the stored text.
      return result.kind === 'shipped'
        ? { tone: 'ok', text: `Saved. We emailed ${result.to} to tell them it’s fixed.` }
        : { tone: 'ok', text: `Saved. We emailed your reply to ${result.to}.` }
    }
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
              <TypeGlyph type={item.type} size={13} box={24} />
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
            {/* Fixed sends by itself (issue 236), so it says so BEFORE the
                press — and here rather than under the textarea, because the
                textarea is not always open and this send does not need it.
                Suppressed once a reply is typed: that case is one email, not
                two, and the composer's own line already describes it. */}
            {shipsNow && !response.trim() && (
              <p style={{ fontSize: '11px', color: T.ink.muted, marginTop: '8px', lineHeight: 1.5 }}>
                {isOwnItem
                  ? 'This is your own report — saving marks it Fixed, and no email is sent.'
                  : item.submitter_email
                    ? `Saving marks this Fixed and emails ${item.submitter_email} to tell them — no reply needed.`
                    : 'No email on file for this person — saving marks it Fixed but sends nothing.'}
              </p>
            )}
          </div>

          {/* ── THE CONVERSATION ───────────────────────────────────
              The whole exchange, oldest first — team words and the owner's
              answers on one rail, from the same builder the owner screen uses.
              Read-only prose, never a prefilled form field (the issue 233
              lesson). Writing the next reply is a deliberate act behind its
              own button, and it APPENDS — it no longer replaces what was said. */}
          <div>
            <label style={fieldLabel}>Conversation with {item.submitter_name || 'the submitter'}</label>
            {thread.map(e => {
              const team = e.authorRole === 'team'
              return (
                <div key={e.id} style={{ padding: '12px 14px', borderRadius: T.radius.control, background: team ? T.accent.faint : T.surface.sunken, border: T.border.thin, marginBottom: '8px' }}>
                  <p style={{ fontSize: '11px', fontWeight: 700, color: T.ink.muted, marginBottom: '5px' }}>
                    {team ? 'The team' : (item.submitter_name || 'They')} replied{e.createdAt ? ` ${feedbackTimeAgo(e.createdAt)}` : ''}
                  </p>
                  <p style={{ fontSize: '13px', color: T.ink.primary, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {e.body}
                  </p>
                </div>
              )
            })}
            {thread.length > 0 && !composing && (
              <button
                type="button"
                onClick={() => setComposing(true)}
                className="bee-small-action"
                style={{ marginTop: '2px', padding: 0, background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}
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
                  placeholder="Write back in plain words — they will read this in an email."
                  style={{ width: '100%', padding: '10px 12px', border: T.border.control, borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised, boxSizing: 'border-box', outline: 'none', resize: 'vertical', lineHeight: 1.5 }}
                />
                {/* Says exactly what Save will do. The old copy claimed the box
                    was "shown to the submitter" while nothing was sent.
                    Silent in exactly one case (issue 236): an empty box with
                    Fixed chosen DOES send, the line under the status row is
                    already saying so, and repeating it here would read as two
                    emails rather than one. */}
                {!(shipsNow && !response.trim()) && (
                  <p style={{ fontSize: '11px', color: T.ink.muted, marginTop: '6px', lineHeight: 1.5 }}>
                    {response.trim()
                      ? (isOwnItem
                          ? 'This is your own report — saving stores the reply, but no email is sent.'
                          : item.submitter_email
                            ? `Saving emails this to ${item.submitter_email}.`
                            : 'No email on file for this person — saving stores the reply but sends nothing.')
                      : 'Saving with the box empty changes the status only. No email is sent.'}
                  </p>
                )}
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

// ── FILE AN INTERNAL ITEM ─────────────────────────────────────
// The composer for work WE found. Issue 247 step 2.
//
// Until this existed, filing an internal item meant hand-run SQL: steps 1 and 2
// part 1 built the is_internal column, the owner-side exclusion and the widened
// type domain, but nothing that could write one.
//
// WHY IT LIVES HERE and not in FeedbackModal: FeedbackModal is the OWNER's
// composer, reachable from the owner nav, and it must keep offering exactly two
// types. This one is a different form for a different person on a screen
// already gated to the corp tier — and every row it writes is is_internal,
// which is a property of POST /api/admin/feedback, not a checkbox anyone here
// can get wrong.
//
// THE LOCATION TAG is the reason one tracker beats two. Tagging "Palm Beach
// import is stuck" with Palm Beach is how it lines up with the report an owner
// files a week later. It is optional because plenty of internal work belongs to
// no single location, and it is SAFE because step 1 excludes internal rows from
// owner reads whatever their location — so here the tag means "this is about
// Palm Beach", never "Palm Beach sent this".
//
// LAYOUT: hive tokens throughout (this file carries no color literal of its
// own — see the sweep in lib/beta-feedback-triage-ui.test.tsx), and controls
// take their natural width. The type row and the footer buttons size to their
// content; only the text fields fill the column, because a half-width message
// box reads as broken rather than as restraint.
// Singular, sentence-shaped labels — the filter chips are plural ("Bugs"),
// which is the wrong voice on a form asking what this one thing is.
const TYPE_COMPOSE_LABEL = { bug: 'Bug', feature: 'Idea', decision: 'Decision', hazard: 'Hazard' }
// What each word MEANS. The two new ones need saying: the whole reason they
// exist is that filing them as bugs made the open-bug count wrong.
const TYPE_COMPOSE_HINT = {
  bug: 'Something is broken.',
  feature: 'Something that would make the work easier.',
  decision: 'A call waiting on a person — not broken, blocked.',
  hazard: 'A known risk that has not gone wrong yet.',
}

function InternalComposeModal({ onClose, onFiled }) {
  const [type, setType] = useState('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [locationId, setLocationId] = useState('')
  const [locations, setLocations] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Every real location, not just the ones that already have feedback. The
  // screen's own locOptions is derived from the loaded items, so it could not
  // offer a location that has never filed anything — and "Portland's import is
  // broken" is exactly the item you want to tag before Portland has ever
  // reported. This endpoint already exists, is corp-gated, and excludes the
  // loc_other holding pen.
  useEffect(() => {
    let cancelled = false
    fetch('/api/locations/transfer-targets')
      .then(r => (r.ok ? r.json() : { targets: [] }))
      .then(d => { if (!cancelled) setLocations(Array.isArray(d.targets) ? d.targets : []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const canSave = title.trim().length > 0 && description.trim().length > 0 && !saving

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          title: title.trim(),
          description: description.trim(),
          location_id: locationId || null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      onFiled()
    } catch (e) {
      setError(e.message === 'unknown_location' ? "That location wasn't recognised." : "Couldn't file it. Please try again.")
      setSaving(false)
    }
  }

  const field = {
    width: '100%', padding: '9px 11px', border: T.border.control,
    borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit',
    color: T.ink.primary, background: T.surface.raised,
  }
  const label = { display: 'block', fontSize: '12px', fontWeight: 700, color: T.ink.primary, marginBottom: '6px' }

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: T.surface.scrim, fontFamily: '"DM Sans",system-ui,sans-serif' }}>
      <div style={{ background: T.surface.raised, borderRadius: T.radius.card, width: '100%', maxWidth: '560px', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: T.shadow.overlay, overflow: 'hidden' }}>

        <div style={{ padding: '16px 20px 12px', borderBottom: T.border.divider, flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <h2 style={{ fontSize: '16px', fontFamily: 'Georgia,serif', color: T.ink.primary, margin: 0, lineHeight: 1.35 }}>File an internal item</h2>
            <p style={{ fontSize: '12px', color: T.ink.muted, margin: '3px 0 0' }}>
              Only the team sees this. It never appears on an owner&rsquo;s screen.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: T.ink.muted, cursor: 'pointer', fontSize: '24px', lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
        </div>

        <div style={{ padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <span style={label}>What is it?</span>
            {/* Natural-width buttons in a wrapping row — not a stretched segmented bar. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
              {['bug', 'feature', 'decision', 'hazard'].map(t => {
                const on = type === t
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    aria-pressed={on}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '7px',
                      padding: '7px 13px', borderRadius: T.radius.pill,
                      border: on ? `1px solid ${T.ink.primary}` : T.border.control,
                      background: on ? T.ink.primary : T.surface.raised,
                      color: on ? T.ink.inverse : T.ink.secondary,
                      fontSize: '13px', fontFamily: 'inherit', fontWeight: on ? 600 : 500,
                      cursor: 'pointer',
                    }}
                  >
                    <TypeGlyph type={t} size={11} box={18} />
                    {TYPE_COMPOSE_LABEL[t]}
                  </button>
                )
              })}
            </div>
            <p style={{ fontSize: '11.5px', color: T.ink.quiet, margin: '7px 0 0' }}>
              {TYPE_COMPOSE_HINT[type]}
            </p>
          </div>

          <div>
            <label style={label} htmlFor="internal-title">Title</label>
            <input id="internal-title" value={title} maxLength={100} onChange={e => setTitle(e.target.value)} style={field} placeholder="Jobber token rotation race" />
          </div>

          <div>
            <label style={label} htmlFor="internal-desc">What&rsquo;s going on</label>
            <textarea id="internal-desc" value={description} maxLength={2000} onChange={e => setDescription(e.target.value)} rows={5} style={{ ...field, resize: 'vertical', lineHeight: 1.5 }} placeholder="What you saw, where, and what it affects." />
          </div>

          <div>
            <label style={label} htmlFor="internal-loc">Location <span style={{ fontWeight: 500, color: T.ink.quiet }}>— optional</span></label>
            <select id="internal-loc" value={locationId} onChange={e => setLocationId(e.target.value)} style={{ ...field, cursor: 'pointer' }}>
              <option value="">No location — this is platform-wide</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <p style={{ fontSize: '11.5px', color: T.ink.quiet, margin: '7px 0 0' }}>
              Tagging a location is how this lines up with a report an owner files later. They still never see it.
            </p>
          </div>

          {error && <p style={{ fontSize: '12.5px', color: T.state.danger.strong, margin: 0 }}>{error}</p>}
        </div>

        <div style={{ padding: '12px 20px 16px', borderTop: T.border.divider, flexShrink: 0, display: 'flex', justifyContent: 'flex-end', gap: '9px' }}>
          <button onClick={onClose} style={{ padding: '10px 16px', background: 'transparent', border: T.border.control, borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit', fontWeight: 600, color: T.ink.secondary, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={!canSave} style={{ padding: '10px 18px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit', fontWeight: 700, color: T.accent.onFill, cursor: canSave ? 'pointer' : 'default', opacity: canSave ? 1 : 0.6 }}>
            {saving ? 'Filing…' : 'File it'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── THE ANALYSIS BLOCK (issue 307) ────────────────────────────
// What is probably wrong, how much of the fleet it touches, and roughly how
// big the work is. Rendered under the row it belongs to.
//
// EVERY PART IS CONDITIONAL, and that is the design rather than defensiveness.
// The analysis is allowed to know nothing, know only the mechanism, or know
// the mechanism and a production count — and each of those has to LOOK
// different, because a reader who cannot tell a computed count from a missing
// one will trust both equally. So:
//   · no probe fired  → the question, and nothing that resembles a diagnosis
//   · fleet null      → the line is absent entirely; never "0", never "unknown"
//   · files empty     → no file list; several real answers name no file at all
//     ("Bee Hub did not send this")
//
// CONFIDENCE IS ALWAYS SHOWN when there is an analysis to qualify. An
// unlabelled paragraph reads as certain, and a confident wrong analysis is
// worse than none — it sends the reader to the wrong file AND leaves them with
// a wrong model that survives being corrected.
const ANALYSIS_TONE = {
  confident: { bg: T.accent.soft, ink: T.accent.deep, label: 'confident' },
  likely:    { bg: T.state.info.bg, ink: T.state.info.deep, label: 'likely' },
  none:      { bg: T.surface.sunken, ink: T.ink.muted, label: 'not placed' },
}

function AnalysisBlock({ analysis }) {
  if (!analysis) return null
  const tone = ANALYSIS_TONE[analysis.confidence] || ANALYSIS_TONE.none
  const hasAnalysis = analysis.confidence !== 'none' && !!analysis.what

  return (
    <div style={{ width: '100%', padding: '0 14px 12px 74px' }}>
      <div style={{ padding: '10px 12px', borderRadius: T.radius.control, background: tone.bg, border: T.border.thin }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: hasAnalysis ? '6px' : 0 }}>
          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.03em', color: tone.ink, textTransform: 'uppercase' }}>
            {tone.label}
          </span>
          {analysis.size && (
            <span style={{ fontSize: '11px', color: T.ink.muted }}>· {analysis.size}</span>
          )}
        </span>

        {hasAnalysis && (
          <p style={{ fontSize: '12.5px', color: T.ink.primary, lineHeight: 1.5, margin: 0 }}>
            {analysis.what}
          </p>
        )}

        {/* THE FLEET COUNT — present only where a probe actually computed one.
            This is the line that turns "one client's problem" into the biggest
            item on the screen, so it must never appear speculatively. */}
        {analysis.fleet && (
          <p style={{ fontSize: '12.5px', fontWeight: 700, color: tone.ink, margin: '7px 0 0' }}>
            {analysis.fleet.count} {analysis.fleet.unit} affected
            <span style={{ fontWeight: 500, color: T.ink.muted }}> — {analysis.fleet.basis}</span>
          </p>
        )}

        {analysis.files.length > 0 && (
          <ul style={{ margin: '7px 0 0', padding: 0, listStyle: 'none' }}>
            {analysis.files.map(f => (
              <li key={f} style={{ fontSize: '11.5px', color: T.ink.secondary, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', lineHeight: 1.6 }}>
                {f}
              </li>
            ))}
          </ul>
        )}

        {/* No probe fired. This is a real answer, not a failure: it tells Kevin
            which reports need him to go and ask rather than open a file. */}
        {!hasAnalysis && analysis.question && (
          <p style={{ fontSize: '12.5px', color: T.ink.secondary, lineHeight: 1.5, margin: 0 }}>
            {analysis.question}
          </p>
        )}
      </div>
    </div>
  )
}

// ── COPY PROMPT (issue 308) ───────────────────────────────────
// Puts a ready-to-paste session prompt on the clipboard. The text is built by
// lib/feedback-prompt; this owns only the gesture and the failure path.
//
// THE TIER IS SHOWN BEFORE THE CLICK, not after. Whether a click yields a
// traced mechanism or a starting point is the difference between opening a
// session and going to ask the owner a question first — so the row says which
// one it is while Kevin is still deciding.
//
// THE FAILURE PATH IS THE POINT. navigator.clipboard needs a secure context
// and a user gesture; both hold here, but it can still be refused by
// permissions policy, by an insecure origin behind a proxy, or simply not
// exist. A copy button that fails quietly is worse than a text box, because
// the reader pastes stale clipboard contents into a session and does not find
// out for several minutes. So a failure REVEALS the text, pre-selected, and
// says to copy it manually.
function CopyPromptButton({ tier, buildText }) {
  const [state, setState] = useState('idle') // idle | copied | manual
  const [text, setText] = useState('')
  const areaRef = useRef(null)

  useEffect(() => {
    if (state !== 'manual' || !areaRef.current) return
    // Select it FOR them — the fallback is only useful if the next keystroke
    // is the copy they were already trying to make.
    areaRef.current.focus()
    areaRef.current.select()
  }, [state])

  const copy = async () => {
    const built = buildText()
    setText(built)
    try {
      if (!navigator?.clipboard?.writeText) throw new Error('no clipboard api')
      await navigator.clipboard.writeText(built)
      setState('copied')
      setTimeout(() => setState(s => (s === 'copied' ? 'idle' : s)), 2600)
    } catch {
      setState('manual')
    }
  }

  const full = tier === 'full'
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
        <button
          type="button"
          onClick={copy}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '5px 11px', borderRadius: T.radius.control,
            border: T.border.control, background: T.surface.raised,
            fontSize: '12px', fontFamily: 'inherit', fontWeight: 600,
            color: T.ink.secondary, cursor: 'pointer', flexShrink: 0,
          }}
        >
          {state === 'copied' ? 'Copied' : 'Copy prompt'}
        </button>
        {/* Which kind of prompt this will be, stated before the click. */}
        <span style={{ fontSize: '11px', color: full ? T.accent.deep : T.ink.muted, fontWeight: full ? 600 : 500 }}>
          {full ? 'full — carries the diagnosis' : 'short — cause not established'}
        </span>
      </span>

      {state === 'manual' && (
        <span style={{ display: 'block', width: '100%' }}>
          <span style={{ display: 'block', fontSize: '11px', color: T.state.warning.deep, fontWeight: 600, marginBottom: '4px' }}>
            Couldn&rsquo;t reach the clipboard — the text is below, selected. Copy it manually.
          </span>
          <textarea
            ref={areaRef}
            readOnly
            value={text}
            rows={8}
            aria-label="Prompt text — copy manually"
            style={{
              width: '100%', padding: '8px 10px', border: T.border.control,
              borderRadius: T.radius.control, fontSize: '11.5px',
              fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
              color: T.ink.primary, background: T.surface.raised,
              lineHeight: 1.5, resize: 'vertical',
            }}
          />
        </span>
      )}
    </span>
  )
}

// ── CLUSTERS (issue 307) ──────────────────────────────────────
// Items grouped by the probe that fired on them — i.e. by demonstrated root
// cause, never by word similarity. The hand run is the reason: "Nuturing" and
// "Nuturing 2" share a rare word and are different problems, while "Nuturing
// 2" belongs with three reports it shares no distinctive vocabulary with.
// Lexical clustering gets both of those backwards.
function ClusterBanner({ clusters, onShow }) {
  if (!clusters || clusters.length === 0) return null
  return (
    <div style={{ marginBottom: '12px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
      {clusters.map(c => (
        <div key={c.probe} style={{ padding: '9px 12px', borderRadius: T.radius.control, background: T.family.purple.bg, border: T.border.thin }}>
          <span style={{ fontSize: '12.5px', fontWeight: 700, color: T.family.purple.text }}>
            {c.itemIds.length} reports share one root cause
          </span>
          {c.fleet && (
            <span style={{ fontSize: '12px', color: T.family.purple.text, opacity: 0.9 }}>
              {' '}· {c.fleet.count} {c.fleet.unit} affected
            </span>
          )}
          <button
            type="button"
            onClick={() => onShow(c)}
            className="bee-small-action"
            style={{ marginLeft: '8px', padding: 0, background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}
          >
            Show them
          </button>
          <p style={{ fontSize: '11.5px', color: T.ink.secondary, lineHeight: 1.5, margin: '4px 0 0' }}>{c.what}</p>
        </div>
      ))}
    </div>
  )
}

// ── THE VERDICT BAR (issue 306) ───────────────────────────────
// Appears only when something is selected. Presentational: it owns no data and
// performs no write — the parent holds the selection and does the PATCHing, so
// there is exactly one place that talks to the route.
//
// TWO STEPS FOR ANYTHING THAT MAILS. Picking a verdict arms it; a second click
// commits. "Already fixed" across twelve rows sends twelve emails, and that is
// not something a single click on a bar should be able to do — the armed state
// says the number out loud first. The wordless verdicts that mail nothing arm
// the same way, because a bulk status change is still a bulk status change.
//
// Buttons are natural width in a wrapping row. Nothing stretches: a bar that
// grows its controls to fill an admin-width screen turns three small verdicts
// into three billboards.
function VerdictBar({ count, armed, emailCount, applying, canAsk, onArm, onCommit, onCancel, onAsk, onClear }) {
  const btn = (extra = {}) => ({
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '7px 13px', borderRadius: T.radius.control,
    border: T.border.control, background: T.surface.raised,
    fontSize: '13px', fontFamily: 'inherit', fontWeight: 600,
    color: T.ink.secondary, cursor: 'pointer', flexShrink: 0, ...extra,
  })

  return (
    <div
      role="group"
      aria-label="Verdict actions"
      style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '9px',
        padding: '10px 14px', marginBottom: '10px',
        borderRadius: T.radius.control, background: T.surface.sunken,
        border: T.border.thin,
      }}
    >
      <span style={{ fontSize: '13px', fontWeight: 700, color: T.ink.primary, flexShrink: 0 }}>
        {plural(count, 'item', 'items')} selected
      </span>

      {applying ? (
        <span style={{ fontSize: '12.5px', color: T.ink.muted }}>
          Saving {applying.done} of {applying.total}…
        </span>
      ) : armed ? (
        <>
          <span style={{ fontSize: '12.5px', color: T.ink.secondary }}>
            {armed.label} — {plural(count, 'item', 'items')}.
            {armed.emails
              ? ` This emails ${plural(emailCount, 'person', 'people')}.`
              : ' Nobody is emailed.'}
          </span>
          <button type="button" onClick={onCommit} style={btn({ background: T.accent.fg, border: 'none', color: T.accent.onFill, fontWeight: 700 })}>
            Confirm
          </button>
          <button type="button" onClick={onCancel} style={btn({ border: 'none', background: 'transparent', color: T.ink.muted })}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {VERDICTS.map(v => (
            <button key={v.key} type="button" onClick={() => onArm(v)} style={btn()}>
              {v.label}
            </button>
          ))}
          {/* The words path. Enabled on a single selection only — a question is
              written to one person about one thing, and the composer that sends
              it is the one the modal already owns. */}
          <button
            type="button"
            onClick={onAsk}
            disabled={!canAsk}
            title={canAsk ? undefined : 'Select a single item to ask about it'}
            style={btn({
              color: canAsk ? T.ink.secondary : T.ink.disabled,
              cursor: canAsk ? 'pointer' : 'default',
            })}
          >
            Ask a question
          </button>
          <button type="button" onClick={onClear} style={btn({ border: 'none', background: 'transparent', color: T.ink.muted, fontWeight: 500 })}>
            Clear
          </button>
        </>
      )}
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
  // The internal composer (issue 247 step 2). Elevated mounts only.
  const [composing, setComposing] = useState(false)
  // ── VERDICT SELECTION (issue 306). Elevated mounts only — see canTriage.
  // Not persisted, like every other control here (issue 126): a selection that
  // survived navigation would let a bulk verdict land on rows chosen days ago.
  const [selected, setSelected]     = useState(() => new Set())
  const [armed, setArmed]           = useState(null)   // the verdict awaiting confirmation
  const [applying, setApplying]     = useState(null)   // { done, total } while writing
  const [verdictNote, setVerdictNote] = useState(null) // what the last pass did

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

  // ── THE PER-ITEM ANALYSIS (issue 307) ───────────────────────────
  // Fetched ON OPEN, once, alongside the list — Kevin chose that over a
  // nightly job because this list moves fast enough that nightly would be
  // stale by morning. The route holds the cache and decides whether this call
  // costs anything; see its header for the signature and how it invalidates.
  //
  // ELEVATED MOUNTS ONLY, and the route is 403 for everyone else anyway. The
  // analysis names files and reports fleet-wide counts across every franchise,
  // none of which is owner-facing.
  //
  // A FAILURE HERE IS SILENT BY DESIGN. The analysis is an enrichment; the
  // screen was fully usable before it existed and must stay usable if it does
  // not arrive. No error banner, no retry — the rows simply render without it.
  const [analyses, setAnalyses] = useState(null)
  const [clusters, setClusters] = useState([])
  // issue 309 — reply drafts for whatever the current deployment answered.
  const [drafts, setDrafts] = useState(() => new Map())
  // The draft Kevin chose to open, so the modal can seed its composer with it.
  const [draftSeed, setDraftSeed] = useState(null)
  useEffect(() => {
    if (onReportFeedback) return
    let cancelled = false
    fetch('/api/admin/feedback/analysis')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (cancelled || !d) return
        const byId = new Map((d.analyses || []).map(a => [a.itemId, a]))
        setAnalyses(byId)
        setClusters(Array.isArray(d.clusters) ? d.clusters : [])
        setDrafts(new Map((d.drafts || []).map(x => [x.itemId, x])))
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // onReportFeedback (the franchise-mount signal) rather than the
    // franchiseMount const, which is declared further down — a dep array is
    // evaluated during render and would hit its temporal dead zone.
  }, [onReportFeedback, items.length])

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
  // 'other' is the catch-all: anything whose type is outside the four the
  // database allows. It exists so the chips can ALWAYS reconcile with
  // Everything — see typeItems (issue 247 step 2).
  const matchType   = (i, t) =>
    t === 'all' ? true
    : t === 'other' ? !isKnownFeedbackType(i.type)
    : i.type === t
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
    // ORDER (issue 306). This is a screen someone works DOWN, so the default
    // view leads with what matters — bugs before ideas, longest-waiting first
    // inside each band (lib/feedback-queues → sortForTriage, where the type
    // rank and its reasoning live). Arrival order was never a work order; it
    // was just the order the server happened to return, and it put the newest
    // idea above a bug somebody reported two months ago.
    //
    // THE STALE QUEUE IS DELIBERATELY EXEMPT, and this is not an oversight.
    // Issue 233 built that card to answer one question — what has been quiet
    // longest — and ranking by type first would put a fresher bug above the
    // item that has rotted for fifty-eight days, which is the single row the
    // card exists to surface. Type is not the axis there; silence is. Its test
    // calls longest-quiet-first "the whole point of looking at it", and it is
    // right, so the type rank stops at its edge.
    if (queueFilter === 'stale') {
      return [...rows].sort((a, b) =>
        new Date(a.updated_at || a.created_at) - new Date(b.updated_at || b.created_at))
    }
    return sortForTriage(rows, 'created')
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

  // WHICH TYPE CHIPS EXIST, and why it is not just a fixed list of four.
  //
  // Bugs and Ideas are always offered — the established vocabulary, and the two
  // an owner can file. The internal-only types appear once one actually exists,
  // so the screen does not carry two permanently-zero chips before Kevin has
  // filed anything. "Other" is the honesty valve: it catches any value outside
  // the four, so the chips and Everything RECONCILE no matter what is in the
  // column. Without it a fifth type added to the database would silently make
  // the chips sum to less than the total — the same class of quietly-disagreeing
  // numbers issue 233 existed to end, which is why inHand exists on the queue
  // cards above.
  //
  // Presence is computed from the UNFILTERED list, never from the faceted count,
  // so a chip cannot vanish mid-search and take its rows out of the sum with it.
  const presentTypes = useMemo(() => {
    const seen = new Set()
    for (const i of items) seen.add(String(i.type || ''))
    return seen
  }, [items])
  const hasUnknownType = useMemo(() => items.some(i => !isKnownFeedbackType(i.type)), [items])

  const typeItems = [
    { key: 'all',     label: 'Everything', count: countType('all') },
    { key: 'bug',     label: 'Bugs',       count: countType('bug') },
    { key: 'feature', label: 'Ideas',      count: countType('feature') },
    ...INTERNAL_ONLY_TYPES
      .filter(t => presentTypes.has(t))
      .map(t => ({ key: t, label: FEEDBACK_TYPE_TAB_LABEL[t], count: countType(t) })),
    ...(hasUnknownType ? [{ key: 'other', label: 'Other', count: countType('other') }] : []),
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

  // ── VERDICTS (issue 306) ────────────────────────────────────
  // Triage controls are ELEVATED-ONLY. onReportFeedback marks the franchise
  // mount (see the file header) and its absence is this file's existing signal
  // for an admin shell — the same one the internal composer uses. An owner may
  // legitimately patch their own location's items through the route, but "clear
  // the obvious in bulk" is a triage motion, not an owner one, and the owner
  // mount must not grow a selection gutter for it.
  const canTriage = !franchiseMount

  const selectedItems = useMemo(
    () => filtered.filter(i => selected.has(i.id)),
    [filtered, selected],
  )

  // How many of the selected rows a "fixed" pass would actually mail. Mirrors
  // the route's guards in the same order it applies them — INTO shipped (rule
  // 2a), not internal (rule 6), not your own item (rule 4), has an address —
  // so the armed line states a real number rather than the selection size. Same
  // mirroring the detail modal's `willSend` does; the route remains the only
  // party that decides, and this only has to predict it honestly.
  const emailCount = useMemo(() => selectedItems.filter(i =>
    i.status !== 'shipped' && !i.is_internal && (!myId || i.user_id !== myId) && !!i.submitter_email,
  ).length, [selectedItems, myId])

  const clearSelection = useCallback(() => { setSelected(new Set()); setArmed(null) }, [])

  const toggleRow = (id) => {
    setArmed(null)
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // Apply a verdict to every selected row, ONE PATCH PER ITEM through the same
  // route the detail modal uses. Sequential on purpose: each save may send an
  // email inline, and firing twenty of those concurrently is how a send rail
  // gets rate-limited. It also makes the progress count honest.
  //
  // A failure on one row does NOT abort the rest — the remaining items are
  // still decided, and the tally says how many did not take.
  const commitVerdict = async () => {
    const verdict = armed
    const rows = selectedItems
    if (!verdict || rows.length === 0) return
    setArmed(null)
    setVerdictNote(null)
    setApplying({ done: 0, total: rows.length })

    const saved = []
    let failed = 0
    let emailed = 0
    for (let n = 0; n < rows.length; n++) {
      try {
        const res = await fetch(`/api/admin/feedback/${rows[n].id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: verdict.status }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const updated = await res.json()
        // reply_email is the route's report on the send, not a column — read
        // it for the tally, then keep it out of the list row.
        const { reply_email, ...row } = updated
        if (reply_email && reply_email.sent) emailed++
        saved.push(row)
      } catch {
        failed++
      }
      setApplying({ done: n + 1, total: rows.length })
    }

    if (saved.length) {
      const byId = new Map(saved.map(r => [r.id, r]))
      setItems(prev => prev.map(i => (byId.has(i.id) ? { ...i, ...byId.get(i.id) } : i)))
    }
    setApplying(null)
    setSelected(new Set())
    setVerdictNote(
      `${verdict.done}: ${plural(saved.length, 'item', 'items')}.` +
      (emailed ? ` ${plural(emailed, 'person', 'people')} emailed.` : '') +
      (failed ? ` ${failed} could not be saved.` : ''),
    )
  }

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
        {/* THE INTERNAL COMPOSER — ELEVATED MOUNTS ONLY. onReportFeedback is
            passed by the franchise mount and only by it (see the file header),
            so its ABSENCE is this file's existing signal for "an admin shell".
            That is a rendering choice, not the security boundary: the real gate
            is POST /api/admin/feedback, which is 403 for owner and manager no
            matter what got rendered. */}
        {!onReportFeedback && (
          <button
            onClick={() => setComposing(true)}
            aria-label="File an internal item"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: '36px', padding: '0 14px', borderRadius: T.radius.control, border: 'none', background: T.accent.soft, color: T.accent.deep, fontSize: '13px', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            <IconPlus size={13} /> File an internal item
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

      {/* CLUSTERS (issue 307) — above the list, because "these four are one
          bug" changes what you do before you start reading rows. "Show them"
          filters to the cluster by selecting its members. */}
      {canTriage && !loading && !error && (
        <ClusterBanner
          clusters={clusters}
          onShow={(c) => { setSelected(new Set(c.itemIds)); setArmed(null) }}
        />
      )}

      {/* THE VERDICT BAR (issue 306) — only once something is selected, so the
          screen is unchanged until Kevin starts clearing things. */}
      {canTriage && selected.size > 0 && (
        <VerdictBar
          count={selected.size}
          armed={armed}
          emailCount={emailCount}
          applying={applying}
          canAsk={selected.size === 1}
          onArm={setArmed}
          onCommit={commitVerdict}
          onCancel={() => setArmed(null)}
          // The words path: open the item in the detail modal, whose reply box
          // already writes through the route and already mails the submitter.
          // This screen does not grow a second composer.
          onAsk={() => { const only = selectedItems[0]; if (only) openRow(only.id) }}
          onClear={clearSelection}
        />
      )}
      {verdictNote && (
        <p style={{ fontSize: '12.5px', color: T.ink.secondary, marginBottom: '10px' }}>
          {verdictNote}{' '}
          <button
            type="button"
            onClick={() => setVerdictNote(null)}
            className="bee-small-action"
            style={{ padding: 0, background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}
          >
            Dismiss
          </button>
        </p>
      )}

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
            const internal = !!it.is_internal
            const href = contextHref(it)
            const quiet = feedbackLastTouchDays(it)
            const picked = selected.has(it.id)
            // ONE flex row, wrapping. The checkbox and the record pointer are
            // both SIBLINGS of the row button, never nested inside it — one
            // row, three real targets, and valid markup. Kept FLAT rather than
            // wrapped in an inner div so the row button's parent is still the
            // element carrying the row's state (the dim on a closed row); the
            // pointer takes a full-width line below by wrapping, not nesting.
            return (
              <div key={it.id} style={{ borderTop: idx === 0 ? 'none' : T.border.divider, opacity: closed ? 0.72 : 1, background: picked ? T.accent.soft : 'transparent', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {canTriage && (
                  <label style={{ display: 'flex', alignItems: 'center', padding: '14px 0 8px 14px', cursor: 'pointer', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() => toggleRow(it.id)}
                      aria-label={`Select ${it.title}`}
                      style={{ cursor: 'pointer', margin: 0 }}
                    />
                  </label>
                )}
                <button
                  onClick={() => openRow(it.id)}
                  style={{
                    flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: '12px',
                    padding: '12px 14px 8px', border: 'none',
                    background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                  }}
                >
                  <TypeGlyph type={it.type} size={15} box={28} style={{ marginTop: '1px' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
                      <span style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
                      {internal && <InternalPill />}
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
                      {/* Who is this waiting on? See ReplyState — "Replied"
                          alone used to cover both a landed answer and one the
                          person has never opened. */}
                      <ReplyState item={it} internal={internal} />
                      {/* How long this one has been quiet, on the queue where
                          that is the reason you are looking at it. */}
                      {queueFilter === 'stale' && quiet != null && (
                        <span style={{ color: T.state.warning.deep }}>· quiet {dayPhrase(quiet)}</span>
                      )}
                    </span>
                  </span>
                  <span style={{ flexShrink: 0 }}><FeedbackStatusBadge status={it.status} /></span>
                </button>
                {/* THE ANALYSIS (issue 307). Its own full-width line under the
                    row, like the record pointer. Absent entirely until the
                    fetch lands, and on the franchise mount forever. */}
                {analyses && <AnalysisBlock analysis={analyses.get(it.id)} />}
                {/* COPY PROMPT (issue 308). Elevated mounts only, and only once
                    the analysis has landed — the tier label would otherwise say
                    "short" for every row while the fetch was still in flight,
                    which is a wrong statement rather than a missing one. */}
                {/* DRAFT REPLY (issue 309) — present only when this deployment
                    appears to have answered this report. The shape is shown
                    before the click: "hedged" means the link between the change
                    and the report is not certain, and the draft ASKS rather
                    than declares. Opening it seeds the existing composer;
                    sending is still that composer's Save, i.e. the route. */}
                {canTriage && drafts.get(it.id) && (
                  <div style={{ width: '100%', padding: '0 14px 8px 74px' }}>
                    <button
                      type="button"
                      onClick={() => { setDraftSeed(drafts.get(it.id)); openRow(it.id) }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                        padding: '5px 11px', borderRadius: T.radius.control,
                        border: T.border.control, background: T.state.info.bg,
                        fontSize: '12px', fontFamily: 'inherit', fontWeight: 600,
                        color: T.state.info.deep, cursor: 'pointer', flexShrink: 0,
                      }}
                    >
                      Draft reply — {drafts.get(it.id).shape === 'confident' ? 'this is fixed' : 'may be fixed, asks them'}
                    </button>
                    <span style={{ fontSize: '11px', color: T.ink.muted, marginLeft: '8px' }}>
                      {drafts.get(it.id).because}
                    </span>
                  </div>
                )}
                {canTriage && analyses && (
                  <div style={{ width: '100%', padding: '0 14px 12px 74px' }}>
                    <CopyPromptButton
                      tier={promptTierFor(analyses.get(it.id))}
                      buildText={() => buildCopyPrompt({
                        item: it,
                        analysis: analyses.get(it.id) || null,
                        cluster: clusters.find(c => c.itemIds.includes(it.id)) || null,
                      }).text}
                    />
                  </div>
                )}
                {/* width 100% is what puts this on its own line in the wrapping
                    row above. Its indent tracks the selection gutter so it
                    stays under the title on both mounts. */}
                {href && (
                  <div style={{ width: '100%', padding: `0 14px 10px ${canTriage ? 74 : 54}px` }}>
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
          seedResponse={draftSeed && draftSeed.itemId === selectedItem.id ? draftSeed.text : ''}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onClose={() => { setWalk(null); setDraftSeed(null) }}
          onSaved={(updated) => {
            // reply_email is the route's report on the notification attempt, not
            // a column — the modal renders it, the list must not absorb it.
            const { reply_email: _ignored, ...row } = updated
            setItems(prev => prev.map(i => (i.id === row.id ? { ...i, ...row } : i)))
          }}
        />
      )}

      {composing && (
        <InternalComposeModal
          onClose={() => setComposing(false)}
          // Refetch rather than splicing the new row in: the list is server-
          // ordered and server-scoped, and a filed item should appear exactly
          // where the next load would put it. It also keeps the open count and
          // the type chips honest without a second code path computing them.
          onFiled={() => { setComposing(false); load() }}
        />
      )}
    </div>
  )
}
