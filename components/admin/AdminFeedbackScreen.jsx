// components/admin/AdminFeedbackScreen.jsx
// ─────────────────────────────────────────────────────────────
// The corporate Feedback triage surface — the queued list + the focused
// detail modal. Mounted by the two elevated admin tabs in BeeHub.jsx; the
// franchise owner nav mounts OwnerFeedbackScreen instead (issue 235). The
// component still ACCEPTS the franchise props (onReportFeedback, locationId)
// and renders a stripped-down owner-safe view when it gets them, because the
// mount tests exercise that shape and nothing about role gating lives here.
//
// ─── THE QUEUES REDESIGN (design C, "Queues") ─────────────────
// What Kevin could not do with the issue 233/306 screen: scan it, or work it
// on a phone. Three queue cards, five filters, a colour per status, a colour
// per type, and the analysis, the copy-prompt button and the draft-reply
// button all stacked INLINE under every row. What replaced it:
//
//   TWO QUEUES, GROUPED BY WHOSE TURN IT IS. "Needs an answer" (nobody from
//   the team has replied, or the owner spoke last) and "Waiting on them" (we
//   spoke last). Each header carries its count and the age of its oldest
//   item, and turns red past fourteen days. lib/feedback-triage-groups owns
//   the arithmetic; the three-card summary in lib/feedback-queues still
//   feeds the nav badge, the dashboard and the Slack nudge untouched.
//
//   A FIXED TYPE ORDER INSIDE EACH QUEUE — bugs, questions, ideas, hazards,
//   decisions — longest waiting first within each type. The type subheading
//   is the type's own colour and disappears when a type tab is active.
//
//   CLOSED ITEMS ARE NOT A QUEUE. A grey "Show N closed" line at the bottom
//   reveals them as a third group.
//
//   ONE FILTER THAT MATTERS: underlined type tabs (Everything / Bugs / Ideas
//   / Questions, plus the internal-only types once one exists), the same
//   tab anatomy the record cards use, underline in the type's colour.
//   Search and the location select survive as one quiet row — sixty rows
//   still need finding — and "Just mine" is gone.
//
//   NO PILLS. Status is plain text on the row and a dropdown in the modal.
//   Type is coloured text and a small coloured glyph — no background, no
//   border, no chip. The only other colour is a small red dot on the rows
//   that need a response from us.
//
//   THE DETAIL IS A FOCUSED MODAL: centred on desktop, full-screen on a
//   phone with its buttons pinned. Arrows walk the visible list, Escape
//   closes, the left/right arrow keys walk too. Inside: type and status
//   dropdowns, what they said, the conversation, the reply box, and a plain
//   line under the box saying what emails and what does not.
//
//   THE CORPORATE-ONLY BLOCK, inside the modal, headed so nobody mistakes it
//   for owner-facing: the per-item analysis (issue 307), the cluster note,
//   the draft reply (issue 309) and the Copy prompt button (issue 308) MOVED
//   here from under the row. Nothing about how they are built changed.
//
// WHAT DID NOT CHANGE: the routes, the PATCH body shapes, the send rules
// (a reply emails; a status change alone does not — except Fixed, which
// already did under issue 236), the thread builder, the verdict bar and its
// one-PATCH-per-item write, the internal composer, the type and status
// vocabularies.
//
// TOKENIZATION. This file carries NO colour literal of its own — every value
// resolves through T / the ui tokens, comments included, so issue numbers are
// written "issue 233" and never with a hash prefix the sweep in
// lib/beta-feedback-triage-ui.test.tsx would read as a hex.
//
// BROWSER-GLOBAL HYGIENE. Nothing in this file is named `top` — it is a
// window global and shadowing it in a module throws before the page runs.
'use client'

import React, { useState, useEffect, useContext, useMemo, useCallback, useRef } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_COUNT } from '@/components/ui/tokens'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import {
  IconBug, IconBulb, IconPlus, IconPaperclip, IconExternalLink,
  IconAlertTriangle, IconSelector, IconMessage, IconCheck,
} from '@/components/ui/icons'
// The type vocabulary (issue 247 step 2). Labels and the known-value
// predicate only — the write validators live in their routes.
import {
  INTERNAL_ONLY_TYPES, FEEDBACK_TYPE_TAB_LABEL, FEEDBACK_TYPE_CHIP_STYLE, isKnownFeedbackType,
} from '@/lib/feedback-types'
// The status vocabulary and the attachment list live in feedbackShared; the
// open-count arithmetic lives in lib/feedback-queues, shared with the nav
// badge and the admin dashboard so the numbers cannot drift apart.
import {
  feedbackTimeAgo, FeedbackAttachmentList,
  FEEDBACK_STATUS_PLAIN, FEEDBACK_STATUS_ORDER,
} from '@/components/feedback/feedbackShared'
import {
  summarizeFeedbackQueues, isClosedFeedback, feedbackAgeDays,
  hasFeedbackReply, isAwaitingConfirmation, isAnsweredButUnmoved,
} from '@/lib/feedback-queues'
// The two queues + the fixed type order (this redesign).
import {
  groupFeedbackForTriage, triageQueueOf, triageWaitingDays, TRIAGE_QUEUE_LABEL,
} from '@/lib/feedback-triage-groups'
// issue 308 — the paste-ready session prompt. The text and the two tiers live
// in the lib; this file owns the button, the gesture and the failure path.
import { buildCopyPrompt, promptTierFor } from '@/lib/feedback-prompt'
// The conversation thread (feedback_replies + the legacy single-reply merge),
// shared with the owner screen so both render one history from one builder.
import { buildFeedbackThread, awaitingTeamReply } from '@/lib/feedback-replies'

// ── ONE COLOUR PER TYPE, THE SAME MAP EVERY SCREEN USES ───────
// The families come from lib/feedback-types (FEEDBACK_TYPE_CHIP_STYLE) —
// bug red, idea blue, question teal, decision purple, hazard amber — the
// map System Health already ships with. Kevin chose one map over two. Each
// stop is a chip-family TEXT colour from the tokens, so it already clears
// AA on white and on the warm canvas; the family NAME is resolved here so
// this file still carries no colour literal of its own.
const TYPE_COLOR = Object.fromEntries(
  Object.entries(FEEDBACK_TYPE_CHIP_STYLE).map(([type, family]) => [type, (T.family[family] || T.family.gray).text]),
)
const TYPE_COLOR_FALLBACK = T.family.gray.text
const TYPE_ICON = {
  bug: IconBug, feature: IconBulb, question: IconMessage, decision: IconSelector, hazard: IconAlertTriangle,
}
// Singular words for the modal; the plural tab labels come from the lib.
const TYPE_WORD = { bug: 'Bug', feature: 'Idea', question: 'Question', decision: 'Decision', hazard: 'Hazard' }

function typeColor(type) { return TYPE_COLOR[String(type || '')] || TYPE_COLOR_FALLBACK }
function typeWord(type) {
  const key = String(type || '')
  return TYPE_WORD[key] || (key ? key.slice(0, 24) : 'unspecified')
}
function typePlural(type) {
  const key = String(type || '')
  return FEEDBACK_TYPE_TAB_LABEL[key] || 'Other'
}

// The glyph: the icon alone, in the type's colour. No box, no background.
function TypeGlyph({ type, size = 14, style = null }) {
  const Icon = TYPE_ICON[String(type || '')] || IconBulb
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: typeColor(type), ...(style || {}) }}>
      <Icon size={size} />
    </span>
  )
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}` }

// Days → the words an owner would use.
function dayPhrase(days) {
  if (days == null) return null
  if (days <= 0) return 'today'
  if (days === 1) return '1 day'
  return `${days} days`
}

// ── VERDICTS (issue 306) ──────────────────────────────────────
// Most items need a decision, not an investigation. These are the wordless
// ones: each maps onto an EXISTING status and is written through the EXISTING
// route (PATCH /api/admin/feedback/:id), the same call the detail modal
// makes. No second status path exists, here or anywhere.
//
// `emails` mirrors the route's rule 2/2a: moving INTO shipped announces itself
// (issue 236); declined and planned say nothing without a written sentence
// (rule 2b). Mirrored so the confirmation can say how much mail a click sends.
const VERDICTS = [
  { key: 'not_real', label: 'Not real',       status: 'declined', emails: false,
    done: 'Marked not planned' },
  { key: 'fixed',    label: 'Already fixed',  status: 'shipped',  emails: true,
    done: 'Marked fixed' },
  { key: 'keep',     label: 'Real — keep it', status: 'planned',  emails: false,
    done: 'Marked planned' },
]

// ── WHERE THE CONVERSATION STANDS, in plain words ─────────────
// Plain text on the row, no icon, no colour. The queue header already says
// whose turn it is; this adds the one fact the header cannot — whether the
// owner has even opened what we wrote (issue 306's missing state).
// Internal items never reach the seen/unseen states: nobody is on the other
// end to open them.
function replyNote(item, internal) {
  if (!internal && awaitingTeamReply(item)) return 'They replied'
  if (isAnsweredButUnmoved(item)) return 'Replied, still marked New'
  if (!hasFeedbackReply(item)) return null
  if (internal) return 'Replied'
  if (isAwaitingConfirmation(item)) return 'Replied · not seen yet'
  return 'Replied · seen'
}

// ── THE RECORD POINTER ────────────────────────────────────────
// feedback_items.context is an id-only pointer (issue 110a) filed by the
// "Report a problem with this client / engagement" menus. The name is resolved
// live by the GET route (context_client_name) rather than stored.
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
      <span style={{ display: 'block', fontSize: '14px', fontWeight: 500, color: T.ink.primary, overflowWrap: 'anywhere' }}>{label}</span>
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

// ── THE ANALYSIS BLOCK (issue 307) — moved into the modal ─────
// What is probably wrong, how much of the fleet it touches, and roughly how
// big the work is. EVERY PART IS CONDITIONAL, and that is the design:
//   · no probe fired  → the question, and nothing that resembles a diagnosis
//   · fleet null      → the line is absent entirely; never "0", never "unknown"
//   · files empty     → no file list
// CONFIDENCE IS ALWAYS SHOWN when there is an analysis to qualify — an
// unlabelled paragraph reads as certain. Quiet now: plain text, no tinted
// background, because it sits inside a box that is already labelled.
const ANALYSIS_LABEL = { confident: 'confident', likely: 'likely', none: 'not placed' }

function AnalysisBlock({ analysis }) {
  if (!analysis) return null
  const label = ANALYSIS_LABEL[analysis.confidence] || ANALYSIS_LABEL.none
  const hasAnalysis = analysis.confidence !== 'none' && !!analysis.what
  return (
    <div>
      <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: T.ink.muted, margin: '0 0 4px' }}>
        Analysis · {label}{analysis.size ? ` · ${analysis.size}` : ''}
      </p>
      {hasAnalysis && (
        <p style={{ fontSize: '13px', color: T.ink.primary, lineHeight: 1.5, margin: 0 }}>{analysis.what}</p>
      )}
      {/* THE FLEET COUNT — present only where a probe actually computed one. */}
      {analysis.fleet && (
        <p style={{ fontSize: '13px', fontWeight: 700, color: T.ink.primary, margin: '7px 0 0' }}>
          {analysis.fleet.count} {analysis.fleet.unit} affected
          <span style={{ fontWeight: 500, color: T.ink.muted }}> — {analysis.fleet.basis}</span>
        </p>
      )}
      {analysis.files.length > 0 && (
        <ul style={{ margin: '7px 0 0', padding: 0, listStyle: 'none' }}>
          {analysis.files.map(f => (
            <li key={f} style={{ fontSize: '12px', color: T.ink.secondary, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', lineHeight: 1.6, overflowWrap: 'anywhere' }}>
              {f}
            </li>
          ))}
        </ul>
      )}
      {/* No probe fired. A real answer: which reports need a question asked. */}
      {!hasAnalysis && analysis.question && (
        <p style={{ fontSize: '13px', color: T.ink.secondary, lineHeight: 1.5, margin: 0 }}>{analysis.question}</p>
      )}
    </div>
  )
}

// ── COPY PROMPT (issue 308) — moved into the modal, otherwise unchanged ──
// Puts a ready-to-paste session prompt on the clipboard. The text is built by
// lib/feedback-prompt; this owns only the gesture and the failure path.
// THE TIER IS SHOWN BEFORE THE CLICK. THE FAILURE PATH IS THE POINT: a copy
// that fails quietly is worse than a text box, so a failure REVEALS the text,
// pre-selected, and says to copy it manually.
function CopyPromptButton({ tier, buildText }) {
  const [state, setState] = useState('idle') // idle | copied | manual
  const [text, setText] = useState('')
  const areaRef = useRef(null)

  useEffect(() => {
    if (state !== 'manual' || !areaRef.current) return
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
    <span style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start', width: '100%' }}>
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '7px 10px' }}>
        <button
          type="button"
          onClick={copy}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            minHeight: '40px', padding: '0 14px', borderRadius: T.radius.control,
            border: T.border.control, background: T.surface.raised,
            fontFamily: 'inherit', fontWeight: 600,
            color: T.ink.secondary, cursor: 'pointer', flexShrink: 0,
          }}
        >
          {state === 'copied' ? 'Copied' : 'Copy prompt'}
        </button>
        <span style={{ fontSize: '12px', color: full ? T.ink.primary : T.ink.muted, fontWeight: full ? 600 : 500 }}>
          {full ? 'full — carries the diagnosis' : 'short — cause not established'}
        </span>
      </span>
      {state === 'manual' && (
        <span style={{ display: 'block', width: '100%' }}>
          <span style={{ display: 'block', fontSize: '12px', color: T.state.danger.strong, fontWeight: 600, marginBottom: '4px' }}>
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
              borderRadius: T.radius.control, fontSize: '16px',
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

// ── THE VERDICT BAR (issue 306) — unchanged in behaviour ──────
// Appears only when something is selected. Presentational: the parent holds
// the selection and does the PATCHing. TWO STEPS FOR ANYTHING THAT MAILS:
// picking a verdict arms it; a second click commits, after the armed line has
// said how many people it emails.
function VerdictBar({ count, armed, emailCount, applying, canAsk, onArm, onCommit, onCancel, onAsk, onClear }) {
  const btn = (extra = {}) => ({
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    minHeight: '40px', padding: '0 13px', borderRadius: T.radius.control,
    border: T.border.control, background: T.surface.raised,
    fontFamily: 'inherit', fontWeight: 600,
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
          <button
            type="button"
            onClick={onAsk}
            disabled={!canAsk}
            title={canAsk ? undefined : 'Select a single item to ask about it'}
            style={btn({ color: canAsk ? T.ink.secondary : T.ink.disabled, cursor: canAsk ? 'pointer' : 'default' })}
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

// ── FILE AN INTERNAL ITEM (issue 247 step 2) — unchanged ──────
// The composer for work WE found. Every row it writes is is_internal, which
// is a property of POST /api/admin/feedback, not a checkbox anyone here can
// get wrong. The location tag is how an internal item lines up with a report
// an owner files later; step 1 excludes internal rows from owner reads.
const TYPE_COMPOSE_LABEL = { bug: 'Bug', feature: 'Idea', decision: 'Decision', hazard: 'Hazard' }
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
    width: '100%', padding: '10px 12px', border: T.border.control,
    borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit',
    color: T.ink.primary, background: T.surface.raised,
  }
  const label = { display: 'block', fontSize: '12px', fontWeight: 700, color: T.ink.primary, marginBottom: '6px' }

  return (
    <div className="bee-fb-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: T.surface.scrim, fontFamily: '"DM Sans",system-ui,sans-serif' }}>
      <div className="bee-fb-dialog" role="dialog" aria-modal="true" aria-label="File an internal item" style={{ background: T.surface.raised, borderRadius: T.radius.card, width: '100%', maxWidth: '560px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: T.shadow.overlay, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px 12px', borderBottom: T.border.divider, flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <h2 style={{ fontSize: '16px', fontFamily: 'Georgia,serif', color: T.ink.primary, margin: 0, lineHeight: 1.35 }}>File an internal item</h2>
            <p style={{ fontSize: '12px', color: T.ink.muted, margin: '3px 0 0' }}>
              Only the team sees this. It never appears on an owner&rsquo;s screen.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: T.ink.muted, cursor: 'pointer', fontSize: '24px', lineHeight: 1, padding: 0, minWidth: '44px', minHeight: '44px', flexShrink: 0 }}>×</button>
        </div>

        <div style={{ padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <span style={label}>What is it?</span>
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
                      minHeight: '40px', padding: '0 13px', borderRadius: T.radius.control,
                      border: on ? `1px solid ${T.ink.primary}` : T.border.control,
                      background: on ? T.ink.primary : T.surface.raised,
                      color: on ? T.ink.inverse : T.ink.secondary,
                      fontFamily: 'inherit', fontWeight: on ? 600 : 500,
                      cursor: 'pointer',
                    }}
                  >
                    <TypeGlyph type={t} size={12} style={{ color: on ? T.ink.inverse : typeColor(t) }} />
                    {TYPE_COMPOSE_LABEL[t]}
                  </button>
                )
              })}
            </div>
            <p style={{ fontSize: '12px', color: T.ink.quiet, margin: '7px 0 0' }}>
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
            <p style={{ fontSize: '12px', color: T.ink.quiet, margin: '7px 0 0' }}>
              Tagging a location is how this lines up with a report an owner files later. They still never see it.
            </p>
          </div>

          {error && <p style={{ fontSize: '12.5px', color: T.state.danger.strong, margin: 0 }}>{error}</p>}
        </div>

        <div style={{ padding: '12px 20px 16px', borderTop: T.border.divider, flexShrink: 0, display: 'flex', justifyContent: 'flex-end', gap: '9px' }}>
          <button onClick={onClose} style={{ minHeight: '44px', padding: '0 16px', background: 'transparent', border: T.border.control, borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 600, color: T.ink.secondary, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={!canSave} style={{ minHeight: '44px', padding: '0 18px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 700, color: T.accent.onFill, cursor: canSave ? 'pointer' : 'default', opacity: canSave ? 1 : 0.6 }}>
            {saving ? 'Filing…' : 'File it'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── THE MODAL'S RESPONSIVE RULES ──────────────────────────────
// Inline styles cannot carry a media query, so the two overlay classes get
// theirs here: centred dialog on a desktop, edge-to-edge on a phone with the
// header and footer pinned and only the body scrolling. No colours — the
// token sweep reads this file as source.
const MODAL_CSS = `
  @media (max-width: 640px) {
    .bee-fb-overlay { padding: 0 !important; align-items: stretch !important; }
    .bee-fb-dialog { max-width: none !important; max-height: none !important; height: 100% !important; border-radius: 0 !important; }
  }
`

// ── DETAIL MODAL ──────────────────────────────────────────────
// `position`/`total` describe the walk — a SNAPSHOT of the visible list taken
// when the modal opened, held by the parent. Not the live list: saving re-files
// an item into the other queue, and a list that re-sorts under you mid-triage
// would jump you to a different item every save. The arrows stop at both ends.
//
// `isOwnItem` — the viewer filed this one. Route rule 4 skips the send in that
// case, so the copy must not promise an email.
//
// `draft` (issue 309) is a suggested reply. It is TEXT until Kevin presses
// Save, and Save is the existing PATCH — the only thing that sends an email.
function AdminFeedbackDetailModal({
  item, queueLabel, position, total, isOwnItem = false, canTriage = false,
  analysis = null, cluster = null, draft = null,
  onPrev, onNext, onClose, onSaved,
}) {
  const thread = buildFeedbackThread(item)
  const [status, setStatus]     = useState(item.status)
  const [itemType, setItemType] = useState(item.type)
  const [response, setResponse] = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)
  const [result, setResult]     = useState(null)
  const bodyRef = useRef(null)

  // Walking to another item re-points this same mounted modal, so every
  // per-item piece of state is re-seeded — otherwise the previous item's
  // draft reply follows you.
  useEffect(() => {
    setStatus(item.status)
    setItemType(item.type)
    setResponse('')
    setError(null)
    setResult(null)
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ESCAPE closes; LEFT/RIGHT walk. The arrows are ignored while a field has
  // focus — inside a textarea they move the caret, and hijacking that would
  // lose someone their place mid-sentence.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      const tag = String(e.target?.tagName || '').toLowerCase()
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable
      if (typing) return
      if (e.key === 'ArrowLeft' && position > 1) { e.preventDefault(); onPrev() }
      if (e.key === 'ArrowRight' && position < total) { e.preventDefault(); onNext() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext, position, total])

  const canChangeType = canTriage && ['bug', 'feature', 'question'].includes(item.type)
  const typeChanged = canChangeType && itemType !== item.type
  const dirty = status !== item.status || typeChanged || response.trim().length > 0

  // Does Save actually send? Mirrors the route: a new reply sends; moving INTO
  // Fixed sends (issue 236); neither does when it is your own item or there is
  // no address on file (rules 4 and no_submitter_email).
  const shipsNow = status === 'shipped' && item.status !== 'shipped'
  const canNotify = !isOwnItem && !!item.submitter_email
  const willSend = (response.trim().length > 0 || shipsNow) && canNotify

  async function save() {
    setSaving(true)
    setError(null)
    setResult(null)
    try {
      // admin_response is only SENT when something was typed — a status-only
      // save must never blank an existing reply, and must never re-send it.
      // type is sent only when actually changed.
      const body = { status }
      if (typeChanged) body.type = itemType
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
      // The modal STAYS OPEN — the arrows exist for an uninterrupted pass.
      setResponse('')
      setResult(updated.reply_email ?? { sent: false, skipped: 'no_reply_written' })
      onSaved(updated)
    } catch (e) {
      setError('Could not save — please try again.')
    } finally {
      setSaving(false)
    }
  }

  const fieldLabel = { display: 'block', fontSize: '12px', fontWeight: 700, color: T.ink.primary, marginBottom: '6px' }
  // 16px so iOS does not zoom the page when a field takes focus.
  const control = {
    width: '100%', minHeight: '44px', padding: '10px 12px', border: T.border.control,
    borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit',
    color: T.ink.primary, background: T.surface.raised, boxSizing: 'border-box',
  }
  const submitted = feedbackAgeDays(item.created_at)
  const who = item.submitter_email
  const name = item.submitter_name || 'the submitter'

  // THE LINE UNDER THE REPLY BOX. Always present, always true for THIS item
  // in THIS state. Each branch is a real outcome of the route's rules.
  const sendLine = (() => {
    if (isOwnItem) {
      if (shipsNow && !response.trim()) return 'This is your own report — saving marks it Fixed, and no email is sent.'
      if (response.trim()) return 'This is your own report — saving stores the reply, but no email is sent.'
      return 'This is your own report — a reply is stored but never emailed, and a status change emails nobody either.'
    }
    if (!who) {
      if (shipsNow && !response.trim()) return 'No email on file for this person — saving marks it Fixed but sends nothing.'
      if (response.trim()) return 'No email on file for this person — saving stores the reply but sends nothing.'
      return 'No email on file for this person — nothing saved here sends an email.'
    }
    if (shipsNow && response.trim()) return `Saving emails this to ${who}, and the same email says it is fixed.`
    if (shipsNow) return `Saving marks this Fixed and emails ${who} to tell them — no reply needed.`
    if (response.trim()) return `Saving emails this to ${who}. Changing the type or status alone would not.`
    return `Sending a reply emails ${who}. Changing the type or status alone sends nothing — except Fixed, which tells them by email.`
  })()

  // What the confirmation line says after a save — each branch a real outcome
  // from the route, named plainly.
  const resultLine = (() => {
    if (!result) return null
    if (result.sent) {
      return result.kind === 'shipped'
        ? { tone: 'ok', text: `Saved. We emailed ${result.to} to tell them it’s fixed.` }
        : { tone: 'ok', text: `Saved. We emailed your reply to ${result.to}.` }
    }
    if (result.error) return { tone: 'bad', text: `Saved — but the email did not go out (${result.error}). Your reply is stored.` }
    if (result.skipped === 'no_submitter_email') return { tone: 'bad', text: 'Saved. No email on file for this person, so nothing was sent.' }
    if (result.skipped === 'replied_to_own_item') return { tone: 'ok', text: 'Saved. This is your own report, so no email was sent.' }
    if (result.skipped === 'internal_item') return { tone: 'ok', text: 'Saved. Internal item — nobody is emailed.' }
    return { tone: 'ok', text: 'Saved.' }
  })()

  const arrow = (label, glyph, onClick, disabled) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: '44px', minHeight: '44px', borderRadius: T.radius.control, border: T.border.control,
        background: 'transparent', fontFamily: 'inherit', fontSize: '20px', lineHeight: 1,
        color: disabled ? T.ink.disabled : T.ink.secondary,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {glyph}
    </button>
  )

  const section = { display: 'flex', flexDirection: 'column', gap: '6px' }

  return (
    <div className="bee-fb-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: T.surface.scrim, fontFamily: '"DM Sans",system-ui,sans-serif' }}>
      <style>{MODAL_CSS}</style>
      <div className="bee-fb-dialog" role="dialog" aria-modal="true" aria-label={item.title} style={{ background: T.surface.raised, borderRadius: T.radius.card, width: '100%', maxWidth: '680px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: T.shadow.overlay, overflow: 'hidden' }}>

        {/* HEADER — pinned. Title wraps; nothing here pushes sideways. */}
        <div style={{ padding: '12px 16px 10px', borderBottom: T.border.divider, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
            <h2 style={{ fontSize: '17px', fontFamily: 'Georgia,serif', color: T.ink.primary, margin: 0, lineHeight: 1.35, display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
              <TypeGlyph type={item.type} size={15} style={{ marginTop: '3px' }} />
              <span style={{ minWidth: 0 }}>{item.title}</span>
            </h2>
            <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: T.ink.muted, cursor: 'pointer', fontSize: '26px', lineHeight: 1, padding: 0, minWidth: '44px', minHeight: '44px', flexShrink: 0, marginTop: '-6px', marginRight: '-8px' }}>×</button>
          </div>
          {/* POSITION + WALK. "3 of 17 · Needs an answer" — you always know
              how much of the list is left. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '6px' }}>
            <span style={{ fontSize: '12.5px', color: T.ink.muted, fontVariantNumeric: T.type.tabular }}>
              {position} of {total}{queueLabel ? ` · ${queueLabel}` : ''}
            </span>
            <span style={{ display: 'inline-flex', gap: '6px' }}>
              {arrow('Previous item', '‹', onPrev, position <= 1)}
              {arrow('Next item', '›', onNext, position >= total)}
            </span>
          </div>
        </div>

        {/* BODY — the only part that scrolls. */}
        <div ref={bodyRef} style={{ padding: '16px', overflowY: 'auto', WebkitOverflowScrolling: 'touch', flex: 1, display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* who + when */}
          <div style={{ fontSize: '13px', color: T.ink.secondary, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
            <div><strong>From:</strong> {item.submitter_name || 'Unknown'}{item.submitter_email ? ` · ${item.submitter_email}` : ''}</div>
            <div><strong>Location:</strong> {item.location_name || '—'}</div>
            <div>
              <strong>Submitted:</strong> {feedbackTimeAgo(item.created_at)}
              {submitted != null && submitted >= 1 ? ` (${dayPhrase(submitted)} ago)` : ''}
            </div>
            {item.is_internal && <div><strong>Internal</strong> — only the team sees this item.</div>}
          </div>

          <ContextCard item={item} />

          {/* WHAT THEY SAID */}
          <div style={section}>
            <p style={{ ...fieldLabel, marginBottom: 0 }}>What they said</p>
            <p style={{ fontSize: '14px', color: T.ink.primary, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{item.description}</p>
            {Array.isArray(item.attachments) && item.attachments.length > 0 && (
              <div style={{ marginTop: '6px' }}>
                <p style={{ fontSize: '12px', fontWeight: 700, color: T.ink.muted, marginBottom: '6px' }}>
                  Attachments ({item.attachments.length})
                </p>
                <FeedbackAttachmentList attachments={item.attachments} thumb={88} />
              </div>
            )}
          </div>

          {/* TYPE + STATUS — two dropdowns. Type is correctable on elevated
              mounts only, among the owner-visible three (the route refuses
              everyone and everything else); an internal decision or hazard
              shows its type as plain coloured text. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>
              <label style={fieldLabel} htmlFor="fb-type">Type</label>
              {canChangeType ? (
                <select id="fb-type" aria-label="Type" value={itemType} onChange={e => setItemType(e.target.value)} style={{ ...control, cursor: 'pointer', color: typeColor(itemType), fontWeight: 600 }}>
                  <option value="bug">Bug</option>
                  <option value="feature">Idea</option>
                  <option value="question">Question</option>
                </select>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minHeight: '44px', fontSize: '15px', fontWeight: 600, color: typeColor(item.type) }}>
                  <TypeGlyph type={item.type} size={14} /> {typeWord(item.type)}
                </span>
              )}
            </div>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>
              <label style={fieldLabel} htmlFor="fb-status">Status</label>
              <select id="fb-status" aria-label="Status" value={status} onChange={e => setStatus(e.target.value)} style={{ ...control, cursor: 'pointer' }}>
                {FEEDBACK_STATUS_ORDER.map(s => (
                  <option key={s} value={s}>{FEEDBACK_STATUS_PLAIN[s]}</option>
                ))}
              </select>
            </div>
          </div>
          {typeChanged && (
            <p style={{ fontSize: '12.5px', color: T.ink.muted, marginTop: '-8px', lineHeight: 1.5 }}>
              Saving refiles this as {itemType === 'feature' ? 'an idea' : `a ${itemType}`}. Nobody is emailed about a refiling.
            </p>
          )}

          {/* THE CONVERSATION — the whole exchange, oldest first, from the
              same builder the owner screen uses. Read-only prose. */}
          <div style={section}>
            <p style={{ ...fieldLabel, marginBottom: 0 }}>Conversation with {name}</p>
            {thread.length === 0 && (
              <p style={{ fontSize: '13px', color: T.ink.quiet, margin: 0 }}>Nobody has replied yet.</p>
            )}
            {thread.map(e => {
              const team = e.authorRole === 'team'
              return (
                <div key={e.id} style={{ padding: '12px 14px', borderRadius: T.radius.control, background: team ? T.accent.faint : T.surface.sunken, border: T.border.thin }}>
                  <p style={{ fontSize: '11px', fontWeight: 700, color: T.ink.muted, marginBottom: '5px' }}>
                    {team ? 'The team' : (item.submitter_name || 'They')} replied{e.createdAt ? ` ${feedbackTimeAgo(e.createdAt)}` : ''}
                  </p>
                  <p style={{ fontSize: '14px', color: T.ink.primary, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
                    {e.body}
                  </p>
                </div>
              )
            })}
          </div>

          {/* THE REPLY BOX, and the line that says what Save does. */}
          <div style={section}>
            <label style={{ ...fieldLabel, marginBottom: 0 }} htmlFor="fb-reply">Reply</label>
            <textarea
              id="fb-reply"
              value={response}
              onChange={e => setResponse(e.target.value)}
              rows={4}
              placeholder="Write back in plain words — they will read this in an email."
              style={{ ...control, outline: 'none', resize: 'vertical', lineHeight: 1.5 }}
            />
            <p style={{ fontSize: '12.5px', color: T.ink.muted, margin: 0, lineHeight: 1.5 }}>{sendLine}</p>
          </div>

          {error && <p style={{ fontSize: '13px', color: T.state.danger.strong, margin: 0 }}>{error}</p>}
          {resultLine && (
            <p style={{ fontSize: '13px', lineHeight: 1.5, margin: 0, color: resultLine.tone === 'bad' ? T.state.danger.strong : T.accent.deep }}>
              {resultLine.text}
            </p>
          )}

          {/* ── THE CORPORATE-ONLY BLOCK ────────────────────────────
              Elevated mounts only. The analysis names files and fleet-wide
              counts, the prompt is a session brief, the draft is a guess at a
              reply — none of it is owner-facing. The UI gate is canTriage;
              the real gate is the analysis route, which is 403 for owner and
              manager, and the franchise mount never asks for it. */}
          {canTriage && (
            <div data-testid="corporate-block" style={{ border: T.border.strong, borderRadius: T.radius.control, padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: T.ink.primary, margin: 0 }}>
                  Only the team sees this
                </p>
                <p style={{ fontSize: '12px', color: T.ink.muted, margin: '2px 0 0' }}>
                  The owner never sees anything in this box.
                </p>
              </div>

              <AnalysisBlock analysis={analysis} />

              {cluster && (
                <p style={{ fontSize: '13px', color: T.ink.secondary, margin: 0, lineHeight: 1.5 }}>
                  One of {cluster.itemIds.length} reports sharing one root cause
                  {cluster.fleet ? ` · ${cluster.fleet.count} ${cluster.fleet.unit} affected` : ''}.
                </p>
              )}

              {/* DRAFT REPLY (issue 309) — present only when this deployment
                  appears to have answered this report. Opening it fills the
                  reply box above; sending is still Save, i.e. the route. */}
              {draft && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px' }}>
                  <button
                    type="button"
                    onClick={() => setResponse(draft.text || '')}
                    style={{
                      display: 'inline-flex', alignItems: 'center', minHeight: '40px', padding: '0 14px',
                      borderRadius: T.radius.control, border: T.border.control, background: T.surface.raised,
                      fontFamily: 'inherit', fontWeight: 600, color: T.ink.secondary, cursor: 'pointer',
                    }}
                  >
                    Draft reply — {draft.shape === 'confident' ? 'this is fixed' : 'may be fixed, asks them'}
                  </button>
                  <span style={{ fontSize: '12px', color: T.ink.muted }}>{draft.because}</span>
                </div>
              )}

              {/* COPY PROMPT (issue 308). The tier label is only truthful once
                  the analysis has landed; until then the button waits. */}
              {analysis !== undefined && (
                <CopyPromptButton
                  tier={promptTierFor(analysis)}
                  buildText={() => buildCopyPrompt({ item, analysis: analysis || null, cluster: cluster || null }).text}
                />
              )}
            </div>
          )}
        </div>

        {/* FOOTER — pinned. */}
        <div style={{ padding: '12px 16px', borderTop: T.border.divider, display: 'flex', justifyContent: 'flex-end', gap: '10px', flexShrink: 0, background: T.surface.raised }}>
          <button onClick={onClose} style={{ minHeight: '44px', padding: '0 16px', background: 'transparent', border: T.border.control, borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 600, color: T.ink.secondary, cursor: 'pointer' }}>Close</button>
          <button onClick={save} disabled={saving || !dirty} style={{ minHeight: '44px', padding: '0 18px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 700, color: T.accent.onFill, cursor: (saving || !dirty) ? 'default' : 'pointer', opacity: (saving || !dirty) ? 0.6 : 1 }}>
            {saving ? 'Saving…' : (willSend ? 'Save and send' : 'Save')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── TYPE TABS ─────────────────────────────────────────────────
// The record cards' tab anatomy (CardTabs): 44px targets, inset underline,
// no layout shift — except the underline takes the TYPE's colour when a type
// is selected, which CardTabs' one-accent rule cannot do. aria-label stays
// `${label} tab`, the same convention every tab-driving test keys on.
function TypeTabs({ tabs, active, onChange }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: '2px', borderBottom: T.border.divider, overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
      {tabs.map(t => {
        const on = active === t.key
        const ink = t.color || T.ink.primary
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            aria-label={`${t.label} tab`}
            onClick={() => onChange(t.key)}
            style={{
              minHeight: '44px', padding: '0 12px', flexShrink: 0,
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'inherit', fontWeight: on ? 600 : 500,
              color: on ? ink : T.ink.muted,
              boxShadow: on ? `inset 0 -2px 0 ${ink}` : 'none',
            }}
          >
            {t.label}
            {t.count != null && (
              <span style={{ marginLeft: '5px', fontWeight: 400, color: on ? ink : T.ink.quiet, fontVariantNumeric: T.type.tabular }}>{t.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export default function AdminFeedbackScreen({
  // Reports the ONE open count (lib/feedback-queues) up to the nav badge.
  onOpenCountChange = () => {},
  // VIEW-AS DATA SCOPING IS PER-SURFACE: "view as" swaps displayed role and
  // name only — API calls still ride the REAL session, so an elevated
  // impersonator's fetch takes the route's elevated branch. The franchise
  // mount passes the impersonated locationId and /api/admin/feedback honours
  // ?location_id= for elevated callers; real owner sessions are hard-scoped
  // server-side and unaffected.
  locationId = null,
  // Composer affordance (opens the existing FeedbackModal). Passed by the
  // franchise mount only; its presence is this file's "owner-safe view" signal.
  onReportFeedback = null,
}) {
  const [items, setItems]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [typeFilter, setTypeFilter] = useState('all')
  // Closed items are HIDDEN by default — decided items were the bulk of the
  // list and none of them needed anything.
  const [showClosed, setShowClosed] = useState(false)
  const [locFilter, setLocFilter]   = useState('all')
  const [userQuery, setUserQuery]   = useState('')
  // The open modal: a snapshot of the visible list's ids plus the index.
  const [walk, setWalk] = useState(null)
  // The internal composer (issue 247 step 2). Elevated mounts only.
  const [composing, setComposing] = useState(false)
  // VERDICT SELECTION (issue 306). Not persisted, like every filter here.
  const [selected, setSelected]       = useState(() => new Set())
  const [armed, setArmed]             = useState(null)
  const [applying, setApplying]       = useState(null)
  const [verdictNote, setVerdictNote] = useState(null)

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
  // Fetched ON OPEN, once. ELEVATED MOUNTS ONLY — the route is 403 for
  // everyone else anyway. A FAILURE HERE IS SILENT BY DESIGN: the screen was
  // fully usable before it existed and stays usable if it does not arrive.
  const [analyses, setAnalyses] = useState(null)
  const [clusters, setClusters] = useState([])
  // issue 309 — reply drafts for whatever the current deployment answered.
  const [drafts, setDrafts] = useState(() => new Map())
  useEffect(() => {
    if (onReportFeedback) return
    let cancelled = false
    fetch('/api/admin/feedback/analysis')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (cancelled || !d) return
        setAnalyses(new Map((d.analyses || []).map(a => [a.itemId, a])))
        setClusters(Array.isArray(d.clusters) ? d.clusters : [])
        setDrafts(new Map((d.drafts || []).map(x => [x.itemId, x])))
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReportFeedback, items.length])

  // ONE open count, shared with the header, the badge and the dashboard.
  const summary = useMemo(() => summarizeFeedbackQueues(items), [items])
  useEffect(() => { onOpenCountChange(summary.open) }, [summary.open, onOpenCountChange])

  const franchiseMount = !!onReportFeedback
  const canTriage = !franchiseMount

  const locOptions = useMemo(() => {
    const seen = new Map()
    items.forEach(i => { if (i.location_id) seen.set(i.location_id, i.location_name || i.location_id) })
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [items])

  // ── FILTERS. Type is the tab; search + location are the quiet row. ──
  const matchType = (i, t) =>
    t === 'all' ? true
    : t === 'other' ? !isKnownFeedbackType(i.type)
    : i.type === t
  const matchLoc = (i) => locFilter === 'all' || i.location_id === locFilter
  const matchQuery = (i) => {
    const q = userQuery.trim().toLowerCase()
    if (!q) return true
    return `${i.title || ''} ${i.description || ''} ${i.submitter_name || ''} ${i.submitter_email || ''}`
      .toLowerCase().includes(q)
  }

  // Everything that survives search + location, before the type tab.
  const scoped = useMemo(
    () => items.filter(i => matchLoc(i) && matchQuery(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, locFilter, userQuery],
  )

  // Tab counts are FACETED against what the list would show: closed rows
  // count only while they are revealed, so a tab never promises rows the
  // current view hides.
  const countType = t => scoped.filter(i => matchType(i, t) && (showClosed || !isClosedFeedback(i.status))).length

  // Which tabs exist. Bugs, Ideas and Questions are always offered (the
  // owner-fileable three); the internal-only types appear once one exists;
  // "Other" catches anything outside the vocabulary so the tabs always
  // reconcile with Everything.
  const presentTypes = useMemo(() => new Set(items.map(i => String(i.type || ''))), [items])
  const hasUnknownType = useMemo(() => items.some(i => !isKnownFeedbackType(i.type)), [items])
  const tabs = [
    { key: 'all',      label: 'Everything', count: countType('all') },
    { key: 'bug',      label: 'Bugs',       count: countType('bug'),      color: TYPE_COLOR.bug },
    { key: 'feature',  label: 'Ideas',      count: countType('feature'),  color: TYPE_COLOR.feature },
    { key: 'question', label: 'Questions',  count: countType('question'), color: TYPE_COLOR.question },
    ...INTERNAL_ONLY_TYPES
      .filter(t => presentTypes.has(t))
      .map(t => ({ key: t, label: FEEDBACK_TYPE_TAB_LABEL[t], count: countType(t), color: TYPE_COLOR[t] })),
    ...(hasUnknownType ? [{ key: 'other', label: 'Other', count: countType('other'), color: TYPE_COLOR_FALLBACK }] : []),
  ]

  // ── THE QUEUES ──────────────────────────────────────────────────
  const grouping = useMemo(
    () => groupFeedbackForTriage(scoped.filter(i => matchType(i, typeFilter))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoped, typeFilter],
  )
  const openShown = grouping.needs.count + grouping.waiting.count
  // The visible list, in render order — what the modal walks.
  const visible = useMemo(
    () => [...grouping.needs.items, ...grouping.waiting.items, ...(showClosed ? grouping.closed.items : [])],
    [grouping, showClosed],
  )

  const selectedItem = walk ? items.find(i => i.id === walk.ids[walk.index]) : null

  // ── VERDICTS (issue 306) ────────────────────────────────────────
  const selectedItems = useMemo(() => visible.filter(i => selected.has(i.id)), [visible, selected])
  // How many of the selected rows a "fixed" pass would actually mail —
  // the route's guards in the route's order.
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

  // ONE PATCH PER ITEM through the same route the modal uses. Sequential:
  // each save may send an email inline. A failure on one row does not abort
  // the rest; the tally says how many did not take.
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

  const openRow = (id) => setWalk({ ids: visible.map(i => i.id), index: visible.findIndex(i => i.id === id) })
  const stepWalk = useCallback((delta) => setWalk(w => {
    if (!w) return w
    const next = w.index + delta
    return next < 0 || next >= w.ids.length ? w : { ...w, index: next }
  }), [])
  const closeWalk = useCallback(() => setWalk(null), [])
  const goPrev = useCallback(() => stepWalk(-1), [stepWalk])
  const goNext = useCallback(() => stepWalk(1), [stepWalk])

  // 16px so a phone does not zoom on focus; 44px tall so a thumb can hit it.
  const quietInput = { minHeight: '44px', padding: '8px 12px', border: T.border.control, borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised, cursor: 'pointer' }
  const linkBtn = { padding: 0, background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }

  // ── ONE ROW ─────────────────────────────────────────────────────
  // A flat wrapping flex row: the checkbox is a SIBLING of the row button,
  // never nested in it. The button's text starts with the title. Nothing in
  // it has a background or a border; the type is a coloured glyph, the
  // status is a word, and the red dot marks a row that needs a response.
  const renderRow = (it) => {
    const closed = isClosedFeedback(it.status)
    const internal = !!it.is_internal
    const picked = selected.has(it.id)
    const queue = triageQueueOf(it)
    const needsResponse = queue === 'needs' && !internal
    const days = triageWaitingDays(it)
    const note = replyNote(it, internal)
    const when = closed
      ? feedbackTimeAgo(it.updated_at || it.created_at)
      : (days == null ? null : days <= 0 ? 'waiting since today' : `waiting ${dayPhrase(days)}`)
    return (
      <div key={it.id} style={{ borderTop: T.border.divider, opacity: closed ? 0.72 : 1, background: picked ? T.accent.faint : 'transparent', display: 'flex', alignItems: 'flex-start' }}>
        {canTriage && (
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '44px', minHeight: '44px', paddingTop: '2px', cursor: 'pointer', flexShrink: 0 }}>
            <input
              type="checkbox"
              checked={picked}
              onChange={() => toggleRow(it.id)}
              aria-label={`Select ${it.title}`}
              style={{ cursor: 'pointer', margin: 0, width: '16px', height: '16px' }}
            />
          </label>
        )}
        <button
          onClick={() => openRow(it.id)}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: '10px',
            minHeight: '44px', padding: canTriage ? '12px 14px 12px 0' : '12px 14px', border: 'none',
            background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
          }}
        >
          {/* The red dot — the one colour on the screen that is not a type. */}
          <span aria-hidden="true" style={{ width: '8px', flexShrink: 0, display: 'flex', justifyContent: 'center', paddingTop: '7px' }}>
            {needsResponse && <span data-testid="needs-dot" style={{ width: '7px', height: '7px', borderRadius: T.radius.round, background: T.state.danger.strong, display: 'block' }} />}
          </span>
          <TypeGlyph type={it.type} size={15} style={{ marginTop: '2px' }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: '14px', fontWeight: 500, color: T.ink.primary, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
              {it.title}
            </span>
            {/* Two lines of the description — titles alone made two
                unrelated reports read as duplicates. */}
            {it.description && (
              <span style={{
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', fontSize: '12.5px', color: T.ink.secondary,
                lineHeight: 1.45, marginTop: '3px', overflowWrap: 'anywhere',
              }}>
                {it.description}
              </span>
            )}
            <span style={{ display: 'block', fontSize: '12px', color: T.ink.muted, marginTop: '4px', lineHeight: 1.5, overflowWrap: 'anywhere' }}>
              {it.submitter_name || 'Unknown'}
              {!franchiseMount && it.location_name ? ` · ${it.location_name}` : ''}
              {` · ${FEEDBACK_STATUS_PLAIN[it.status] || it.status}`}
              {when ? ` · ${when}` : ''}
              {internal ? ' · Internal' : ''}
              {note ? ` · ${note}` : ''}
              {Array.isArray(it.attachments) && it.attachments.length > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', marginLeft: '8px' }}>
                  <IconPaperclip size={11} />{it.attachments.length}
                </span>
              )}
            </span>
          </span>
        </button>
      </div>
    )
  }

  // ── ONE QUEUE ───────────────────────────────────────────────────
  // Header (count + oldest, red past fourteen days), then the type sections.
  // The type subheading goes away when a type tab is active — every row is
  // that type, so the label would only repeat the tab.
  const renderQueue = (q) => {
    const red = q.overdue
    const ink = red ? T.state.danger.strong : T.ink.primary
    return (
      <section key={q.key} aria-label={q.label} style={{ paddingBottom: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', padding: '16px 14px 8px', flexWrap: 'wrap' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: ink, margin: 0, display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            {q.label}
            <span style={{ fontSize: '13px', fontWeight: 500, color: red ? T.state.danger.strong : T.ink.muted, fontVariantNumeric: T.type.tabular }}>{q.count}</span>
          </h3>
          {q.key !== 'closed' && (
            <span style={{ fontSize: '12px', color: red ? T.state.danger.strong : T.ink.muted, fontWeight: red ? 600 : 500 }}>
              {q.oldestDays != null ? `oldest ${dayPhrase(q.oldestDays)}` : 'nothing waiting'}
            </span>
          )}
        </div>
        {q.count === 0 && (
          <p style={{ fontSize: '13px', color: T.ink.quiet, margin: 0, padding: '0 14px 10px' }}>Nothing here.</p>
        )}
        {q.sections.map(s => (
          <div key={s.type}>
            {typeFilter === 'all' && (
              <p data-testid="type-subheading" style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: typeColor(s.type === 'other' ? null : s.type), margin: 0, padding: '6px 14px 4px' }}>
                {s.type === 'other' ? 'Other' : typePlural(s.type)}
              </p>
            )}
            {s.items.map(renderRow)}
          </div>
        ))}
      </section>
    )
  }

  const closedCount = grouping.closed.count
  const nothingToShow = openShown === 0 && !(showClosed && closedCount > 0)

  return (
    <div style={{ padding: '14px 1rem 1rem', fontFamily: 'DM Sans,system-ui,sans-serif' }}>
      {/* HEADER — one open count, the same number the badge uses. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '10px', flexWrap: 'wrap' }}>
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
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minHeight: '44px', padding: '0 14px', borderRadius: T.radius.control, border: T.border.control, background: T.surface.raised, color: T.ink.primary, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            <IconPlus size={13} /> Report a bug or share an idea
          </button>
        )}
        {/* THE INTERNAL COMPOSER — elevated mounts only. The rendering gate is
            the mount; the security gate is POST /api/admin/feedback. */}
        {!onReportFeedback && (
          <button
            onClick={() => setComposing(true)}
            aria-label="File an internal item"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minHeight: '44px', padding: '0 14px', borderRadius: T.radius.control, border: T.border.control, background: T.surface.raised, color: T.ink.primary, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            <IconPlus size={13} /> File an internal item
          </button>
        )}
      </div>

      {/* TYPE TABS */}
      <TypeTabs tabs={tabs} active={typeFilter} onChange={setTypeFilter} />

      {/* Search + location — the one quiet row. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', margin: '10px 0 12px' }}>
        <input value={userQuery} onChange={e => setUserQuery(e.target.value)} placeholder="Search name, title or description" aria-label="Search feedback" style={{ ...quietInput, cursor: 'text', flex: '1 1 200px', maxWidth: '360px' }} />
        {!franchiseMount && (
          <select value={locFilter} onChange={e => setLocFilter(e.target.value)} aria-label="Location" style={quietInput}>
            <option value="all">All locations</option>
            {locOptions.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>

      {/* CLUSTERS (issue 307) — one quiet line each. "Show them" selects the
          members so a verdict can land on all of them at once. */}
      {canTriage && !loading && !error && clusters.length > 0 && (
        <div style={{ marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {clusters.map(c => (
            <p key={c.probe} style={{ fontSize: '12.5px', color: T.ink.secondary, margin: 0, lineHeight: 1.5 }}>
              <strong style={{ color: T.ink.primary }}>{c.itemIds.length} reports share one root cause</strong>
              {c.fleet ? ` · ${c.fleet.count} ${c.fleet.unit} affected` : ''}
              {c.what ? ` — ${c.what}` : ''}{' '}
              <button type="button" onClick={() => { setSelected(new Set(c.itemIds)); setArmed(null) }} className="bee-small-action" style={linkBtn}>
                Show them
              </button>
            </p>
          ))}
        </div>
      )}

      {/* THE VERDICT BAR (issue 306) — only once something is selected. */}
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
          onAsk={() => { const only = selectedItems[0]; if (only) openRow(only.id) }}
          onClear={clearSelection}
        />
      )}
      {verdictNote && (
        <p style={{ fontSize: '12.5px', color: T.ink.secondary, marginBottom: '10px' }}>
          {verdictNote}{' '}
          <button type="button" onClick={() => setVerdictNote(null)} className="bee-small-action" style={linkBtn}>Dismiss</button>
        </p>
      )}

      {loading ? (
        <BeeLoader size="screen" label="Gathering the records…" />
      ) : error ? (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ fontSize: '13px', color: T.state.danger.strong, marginBottom: '10px' }}>{error}</p>
          <button onClick={load} style={{ minHeight: '44px', padding: '0 16px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 600, color: T.accent.onFill, cursor: 'pointer' }}>Retry</button>
        </div>
      ) : items.length === 0 ? (
        <p style={{ fontSize: '13px', color: T.ink.muted, textAlign: 'center', padding: '30px 0' }}>No feedback submitted yet.</p>
      ) : (
        <>
          {nothingToShow ? (
            <p style={{ fontSize: '13px', color: T.ink.muted, textAlign: 'center', padding: '30px 0 16px' }}>
              {summary.open === 0 && typeFilter === 'all' && !userQuery.trim() && locFilter === 'all'
                ? 'Nothing open — everything has been answered or decided.'
                : 'No feedback matches these filters.'}
            </p>
          ) : (
            /* One rounded container; the queues and their hairline rows inside. */
            <div style={{ background: T.surface.raised, border: T.border.thin, borderRadius: '12px', overflow: 'hidden' }}>
              {openShown > 0 && renderQueue(grouping.needs)}
              {openShown > 0 && renderQueue(grouping.waiting)}
              {showClosed && closedCount > 0 && renderQueue(grouping.closed)}
            </div>
          )}

          {/* THE CLOSED LINE — quiet, grey, at the bottom. Not a queue. */}
          {closedCount > 0 && (
            <div style={{ textAlign: 'center', marginTop: '12px' }}>
              <button
                type="button"
                onClick={() => setShowClosed(v => !v)}
                aria-expanded={showClosed}
                className="bee-chip-action"
                style={{ minHeight: '44px', padding: '0 16px', background: 'none', border: 'none', color: T.ink.quiet, fontFamily: 'inherit', fontWeight: 500, cursor: 'pointer' }}
              >
                {showClosed ? `Hide ${closedCount} closed` : `Show ${closedCount} closed`}
              </button>
            </div>
          )}
        </>
      )}

      {selectedItem && walk && (
        <AdminFeedbackDetailModal
          item={selectedItem}
          queueLabel={TRIAGE_QUEUE_LABEL[triageQueueOf(selectedItem)]}
          position={walk.index + 1}
          total={walk.ids.length}
          isOwnItem={!!myId && selectedItem.user_id === myId}
          canTriage={canTriage}
          // undefined until the analysis fetch lands (the copy button waits);
          // null once it has landed with nothing for this item.
          analysis={analyses ? (analyses.get(selectedItem.id) || null) : undefined}
          cluster={clusters.find(c => c.itemIds.includes(selectedItem.id)) || null}
          draft={drafts.get(selectedItem.id) || null}
          onPrev={goPrev}
          onNext={goNext}
          onClose={closeWalk}
          onSaved={(updated) => {
            // reply_email is the route's report on the send, not a column.
            const { reply_email: _ignored, ...row } = updated
            setItems(prev => prev.map(i => (i.id === row.id ? { ...i, ...row } : i)))
          }}
        />
      )}

      {composing && (
        <InternalComposeModal
          onClose={() => setComposing(false)}
          onFiled={() => { setComposing(false); load() }}
        />
      )}
    </div>
  )
}
