// components/admin/AdminFeedbackScreen.jsx
// ─────────────────────────────────────────────────────────────
// The corporate Feedback triage surface — the queued list + the focused
// detail modal. Mounted by the two elevated admin tabs in BeeHub.jsx; the
// franchise owner nav mounts OwnerFeedbackScreen instead (issue 235). The
// component still ACCEPTS the franchise props (onReportFeedback, locationId)
// and renders a stripped-down owner-safe view when it gets them, because the
// mount tests exercise that shape and nothing about role gating lives here.
//
// ─── THE TILES REDESIGN ───────────────────────────────────────
// The sidebar badge said 40 and Leslie read it as forty things on fire; four
// were bugs nobody had answered. What replaced the queues and the type tabs:
//
//   THE BADGE counts people waiting on a real answer — open bugs and open
//   questions with no reply (lib/feedback-admin-tiles adminBadgeCount,
//   reported up through onBadgeCountChange). Ideas never set it off.
//
//   TWO GROUPS, SIX COUNTS, FIVE TILES (the plain-English pass). "Waiting
//   to hear from us": Bugs, Questions, Ideas — raised, each tinted its own
//   hue (red, blue, amber) with a stronger border and a soft shadow. "Heard
//   from us, still waiting": We said yes, We said maybe — recessed, darker
//   than the page, flat, colourless. Each tile: count, name, one full
//   sentence, "Oldest: N days". A tile is a filter. Stuck (replied but still
//   at submitted — a defect, never settable by hand) is counted but is not a
//   tile: a red strip with "Show them" appears only when it is not zero. The
//   six counts are mutually exclusive and sum to the open total
//   (lib/feedback-admin-tiles owns the sorting; this file only presents it).
//
//   SECTIONS MATCH THE TILES — the same name and colour, and the count. No
//   description under the heading: the tile already said it. Status chips
//   appear only in the replied group and the closed list.
//
//   AGE: plain under 30 days, amber 30 to 59, red at 60 or more, on every row
//   and tile. The old red "needs an answer" dot is gone and the type glyph
//   on a row is neutral ink.
//
//   WHO HAS IT — a claim circle on every row (initials, or a dashed plus),
//   a "who has it" filter beside the location filter, and the same in the
//   modal. assigned_to, self-or-nobody, through the PATCH route.
//
//   LOOKS ALREADY BUILT — a tick in the modal (looks_shipped), a flag on the
//   row. A human judgement, never computed.
//
//   CLOSED ITEMS ARE REACHED THROUGH THE FILTERS (Open / Closed / Everything),
//   not a grey link at the bottom.
//
//   THE MODAL reads top-down in the order you work: who has it, what they
//   said, type and status, the conversation, the team-only analysis, THEN the
//   reply box — and the footer lists what Save will do (refile, move the
//   status, store the reply, EMAIL someone) before the button is pressed.
//
// WHAT DID NOT CHANGE: the send rules (a reply emails; a status change alone
// does not — except Fixed, which already did under issue 236), the reply-sets-
// status rule (ee2cc9e), the release-note seeding, the thread builder, the
// verdict bar and its one-PATCH-per-item write, the cluster bars, the
// internal composer, the type and status vocabularies. The PATCH body gained
// two optional team-only fields (assigned_to, looks_shipped) and one refusal
// (stuck_is_not_settable); nothing it already accepted changed.
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
import { FEEDBACK_TYPE_CHIP_STYLE, FEEDBACK_TYPE_WORD } from '@/lib/feedback-types'
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
// issue 308 — the paste-ready session prompt. The text and the two tiers live
// in the lib; this file owns the button, the gesture and the failure path.
import { buildCopyPrompt, promptTierFor } from '@/lib/feedback-prompt'
// The conversation thread (feedback_replies + the legacy single-reply merge),
// shared with the owner screen so both render one history from one builder.
import { buildFeedbackThread, awaitingTeamReply } from '@/lib/feedback-replies'
// The cluster modal's "waiting N days" — unchanged by the redesign.
import { triageWaitingDays } from '@/lib/feedback-triage-groups'
// The admin redesign's arithmetic: six tiles in two groups, the badge, the age
// colour, the Stuck guard. Shared with the nav badge in BeeHub and the PATCH
// route, so the three cannot disagree.
import {
  ADMIN_TILES, ADMIN_GROUPS, adminTileOf, adminGroupOf, summarizeAdminTiles, adminBadgeCount,
  ageTone, wouldHandSetStuck, initialsOf,
} from '@/lib/feedback-admin-tiles'

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
// Singular and plural type words both come from the lib — one vocabulary.
const TYPE_WORD = FEEDBACK_TYPE_WORD

function typeColor(type) { return TYPE_COLOR[String(type || '')] || TYPE_COLOR_FALLBACK }
function typeWord(type) {
  const key = String(type || '')
  return TYPE_WORD[key] || (key ? key.slice(0, 24) : 'unspecified')
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
// (issue 236); declined, planned and answered say nothing without a written
// sentence (rule 2b; answered is a middle-free status move like the others —
// only Fixed announces itself). Mirrored so the confirmation can say how much
// mail a click sends.
const VERDICTS = [
  { key: 'not_real', label: 'Not real',       status: 'declined', emails: false,
    done: 'Marked not planned' },
  { key: 'fixed',    label: 'Already fixed',  status: 'shipped',  emails: true,
    done: 'Marked fixed' },
  { key: 'keep',     label: 'Real — keep it', status: 'planned',  emails: false,
    done: 'Marked planned' },
  { key: 'answered', label: 'Answered',       status: 'answered', emails: false,
    done: 'Marked answered' },
]

// ── WHERE THE CONVERSATION STANDS, in plain words ─────────────
// Plain text on the row, no icon, no colour. The queue header already says
// whose turn it is; this adds the one fact the header cannot — whether the
// owner has even opened what we wrote (issue 306's missing state).
// Internal items never reach the seen/unseen states: nobody is on the other
// end to open them.
function replyNote(item, internal) {
  if (!internal && awaitingTeamReply(item)) return 'They replied'
  if (isAnsweredButUnmoved(item)) return `Replied, still marked ${FEEDBACK_STATUS_PLAIN.submitted}`
  if (!hasFeedbackReply(item)) return null
  if (internal) return 'Replied'
  if (isAwaitingConfirmation(item)) return 'Replied · not seen yet'
  return 'Replied · seen'
}

// ── TILE COLOURS ──────────────────────────────────────────────
// THE TWO ROWS LOOK DIFFERENT (the plain-English pass). "Waiting to hear from
// us" is the row that needs you: each tile tinted its own hue — red Bugs,
// blue Questions, amber Ideas — with a real border in a stronger version of
// that hue, and a soft shadow. "Heard from us, still waiting" is parked: a
// fill darker than the page, flat, no shadow, no colour of its own. The
// section heading in the list wears the same ink as its tile; the replied
// group's status chips stay neutral, like their row.
const TILE_FAMILY = {
  fix: 'red', answer: 'blue', decide: 'amber',
  build: 'gray', deciding: 'gray', stuck: 'red',
}
// The stronger edge for each raised tile — the same hue, driven darker.
const TILE_EDGE = {
  fix: T.state.danger.strong, answer: T.state.info.fg, decide: T.state.warning.fg,
}
// The recessed row's fill: a step darker than the page, still warm.
const RECESSED_FILL = T.family.gray.bg
const CLOSED_FAMILY = { shipped: 'green', answered: 'teal', declined: 'gray' }
const CLOSED_ORDER = ['shipped', 'answered', 'declined']
function tileInk(key) { return (T.family[TILE_FAMILY[key]] || T.family.gray).text }

// ── AGE ───────────────────────────────────────────────────────
// Plain under 30 days, amber 30 to 59, red at 60 or more
// (lib/feedback-admin-tiles ageTone). On every row and every tile. At the old
// 10/21 steps every age on the live screen was red, so red said nothing.
function ageInk(tone) {
  return tone === 'red' ? T.state.danger.strong : tone === 'amber' ? T.state.warning.deep : T.ink.muted
}
// `oldest` is the tile's form: "Oldest: 23 days". A row says "23 days old".
function AgeText({ days, oldest = false }) {
  if (days == null) return null
  const tone = ageTone(days)
  const words = oldest
    ? `Oldest: ${days <= 0 ? 'today' : dayPhrase(days)}`
    : (days <= 0 ? 'today' : `${dayPhrase(days)} old`)
  return (
    <span data-age-tone={tone} style={{ color: ageInk(tone), fontWeight: tone === 'plain' ? 400 : 700, whiteSpace: 'nowrap' }}>
      {words}
    </span>
  )
}

// ── STATUS, WITH SHAPE ────────────────────────────────────────
// A chip, not grey text in a run of dots — and only where the status tells
// you something the section does not: the replied group, where Build, Still
// deciding and Stuck are genuinely different, and the closed list.
function StatusChip({ item }) {
  const tile = adminTileOf(item)
  const fam = T.family[tile ? TILE_FAMILY[tile] : (CLOSED_FAMILY[item.status] || 'gray')] || T.family.gray
  return (
    <span data-status-chip={item.status} style={{ display: 'inline-block', padding: '1px 8px', borderRadius: T.radius.pill, fontSize: '11.5px', fontWeight: 600, lineHeight: 1.6, background: fam.bg, color: fam.text, whiteSpace: 'nowrap' }}>
      {FEEDBACK_STATUS_PLAIN[item.status] || item.status}
    </span>
  )
}

// ── WHO HAS IT ────────────────────────────────────────────────
// A circle: initials when someone has claimed it, a dashed circle with a plus
// when nobody has. Unclaimed → claims it for you. Claimed → releases it (yours
// or someone else's — the circle is a shared note, not a lock). 44px target
// around a 28px circle.
function ClaimCircle({ item, myId, busy = false, onToggle }) {
  const claimed = !!item.assigned_to
  const mine = claimed && item.assigned_to === myId
  const name = item.assigned_to_name || (mine ? 'You' : 'Someone')
  const label = claimed
    ? (mine ? `You have “${item.title}” — release it` : `${name} has “${item.title}” — release it`)
    : `Claim “${item.title}”`
  return (
    <button
      type="button"
      data-claim={item.id}
      data-claimed={claimed ? 'yes' : 'no'}
      aria-label={label}
      title={claimed ? `${name} has this` : 'Nobody has this — claim it'}
      disabled={busy || (!claimed && !myId)}
      onClick={(e) => { e.stopPropagation(); onToggle(claimed ? null : myId) }}
      style={{ minWidth: '44px', minHeight: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', padding: 0, cursor: busy ? 'default' : 'pointer', flexShrink: 0, opacity: busy ? 0.5 : 1 }}
    >
      <span aria-hidden="true" style={{
        width: '28px', height: '28px', borderRadius: T.radius.round, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '11px', fontWeight: 700, letterSpacing: '0.02em',
        ...(claimed
          ? { background: mine ? T.accent.fg : T.ink.strong, color: T.ink.inverse, border: 'none' }
          : { background: 'transparent', color: T.ink.muted, border: `1.5px dashed ${T.ink.quiet}` }),
      }}>
        {claimed ? initialsOf(item.assigned_to_name || (mine ? 'Me' : '?')) : <IconPlus size={12} />}
      </span>
    </button>
  )
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
const TYPE_COMPOSE_LABEL = FEEDBACK_TYPE_WORD
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
    <div className="bee-fb-overlay" style={{ position: 'fixed', inset: 0, zIndex: 10130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: T.surface.scrim, fontFamily: '"DM Sans",system-ui,sans-serif' }}>
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
  item, queueLabel, position, total, isOwnItem = false, canTriage = false, myId = null,
  analysis = null, cluster = null, draft = null,
  onPrev, onNext, onClose, onSaved,
}) {
  const thread = buildFeedbackThread(item)
  const [status, setStatus]     = useState(item.status)
  const [itemType, setItemType] = useState(item.type)
  const [response, setResponse] = useState('')
  // THE REPLY MOVES THE STATUS. Writing back to an item still "With the team"
  // answers it — but four items once sat at that status with a reply on them,
  // because Save wrote the dropdown's untouched starting value straight back.
  // So while the admin has not touched the dropdown, typing a reply moves it
  // to Answered (and emptying the reply moves it back). Once they pick a
  // status by hand, `statusTouched` is set and the reply never moves it again.
  const [statusTouched, setStatusTouched] = useState(false)
  const [autoMoved, setAutoMoved]         = useState(false)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)
  const [result, setResult]     = useState(null)
  // The claim and the tick save ON THEIR OWN, immediately — neither is news,
  // neither emails anyone, and neither should wait behind (or ride along with)
  // a Save that might.
  const [sideBusy, setSideBusy]   = useState(null)  // 'claim' | 'looks' | null
  const [sideError, setSideError] = useState(null)
  const bodyRef = useRef(null)

  async function sideWrite(kind, body) {
    setSideBusy(kind)
    setSideError(null)
    try {
      const res = await fetch(`/api/admin/feedback/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onSaved(await res.json())
    } catch {
      setSideError(kind === 'claim' ? 'Could not change who has this — please try again.' : 'Could not save the tick — please try again.')
    } finally {
      setSideBusy(null)
    }
  }

  // Walking to another item re-points this same mounted modal, so every
  // per-item piece of state is re-seeded — otherwise the previous item's
  // draft reply follows you.
  useEffect(() => {
    setStatus(item.status)
    setStatusTouched(false)
    setAutoMoved(false)
    setItemType(item.type)
    setResponse('')
    setError(null)
    setResult(null)
    setSideError(null)
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

  // Every way text reaches the reply box (typing, "Use this draft") goes
  // through here, so the status rule cannot be bypassed by one of them.
  function writeReply(text) {
    setResponse(text)
    // Same scope as the route's reply floor: a team reply to someone else.
    // A note on your own item, or an owner's note on their location's item,
    // answers nothing.
    if (!canTriage || isOwnItem || statusTouched || item.status !== 'submitted') return
    const hasText = String(text || '').trim().length > 0
    setStatus(hasText ? 'answered' : item.status)
    setAutoMoved(hasText)
  }
  function pickStatus(next) {
    setStatus(next)
    setStatusTouched(true)
    setAutoMoved(false)
  }

  const canChangeType = canTriage && ['bug', 'feature', 'question'].includes(item.type)
  const typeChanged = canChangeType && itemType !== item.type
  const dirty = status !== item.status || typeChanged || response.trim().length > 0

  // Does Save actually send? Mirrors the route: a new reply sends; moving INTO
  // Fixed sends (issue 236); neither does when it is your own item or there is
  // no address on file (rules 4 and no_submitter_email).
  const shipsNow = status === 'shipped' && item.status !== 'shipped'
  const canNotify = !isOwnItem && !!item.submitter_email && !item.is_internal
  const willSend = (response.trim().length > 0 || shipsNow) && canNotify
  // STUCK IS NEVER PICKED BY HAND. The option that would move a replied item
  // back into 'submitted' is disabled, and the route refuses it anyway.
  const replyAfter = response.trim() || item.admin_response
  const stuckOption = (s) => wouldHandSetStuck({ fromStatus: item.status, toStatus: s, replyAfter })

  async function save() {
    setSaving(true)
    setError(null)
    setResult(null)
    try {
      // admin_response is only SENT when something was typed — a status-only
      // save must never blank an existing reply, and must never re-send it.
      // type is sent only when actually changed. status is sent only when it
      // moved or was picked by hand: echoing back the value the modal opened
      // with is how a reply once left items at "With the team", and it would
      // also undo a status someone else set while this modal sat open.
      const body = {}
      if (status !== item.status || statusTouched) body.status = status
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
      // The dropdown follows what the server stored (its reply floor may
      // have moved the status even when nobody here did).
      setResponse('')
      if (updated.status) setStatus(updated.status)
      setStatusTouched(false)
      setAutoMoved(false)
      setResult(updated.reply_email ?? { sent: false, skipped: 'no_reply_written' })
      onSaved(updated)
    } catch (e) {
      // A REPORT THAT IS NO LONGER THERE. An owner may now delete their own
      // entry (DELETE /api/feedback/[id]), and the row really goes — so a save
      // on one that has been withdrawn mid-triage answers 404, not a hiccup.
      // "Please try again" would be a lie: trying again cannot work, and the
      // words typed in the reply box are about something that no longer exists.
      // Say so, and say the reply was not sent, because that is the question the
      // person at this screen is about to ask.
      if (String(e?.message) === 'not_found') {
        setError('This report is gone — the person who filed it deleted it. Nothing was saved and no reply was sent.')
      } else {
        setError('Could not save — please try again.')
      }
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
    if (item.is_internal) return 'Internal item — nothing saved here emails anyone.'
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

  // WHAT SAVE WILL DO — listed above the button, before the click. One Save can
  // refile the type, move the status, store a reply and send an email; the old
  // screen said so in a sentence under the textarea, which is exactly where
  // nobody looks at the moment they press the button. Each line is a real
  // effect of THIS save; the email line is the loud one.
  const firstName = String(item.submitter_name || '').trim().split(/\s+/)[0] || 'them'
  const consequences = []
  if (typeChanged) consequences.push({ key: 'type', text: `Refile it as ${itemType === 'feature' ? 'an' : 'a'} ${String(FEEDBACK_TYPE_WORD[itemType] || itemType).toLowerCase()}` })
  if (status !== item.status) consequences.push({ key: 'status', text: `Move it from ${FEEDBACK_STATUS_PLAIN[item.status] || item.status} to ${FEEDBACK_STATUS_PLAIN[status] || status}` })
  if (response.trim()) consequences.push({ key: 'reply', text: 'Add your reply to the conversation' })
  if (willSend) consequences.push({ key: 'email', text: `Email ${item.submitter_email}`, loud: true })

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
    <div className="bee-fb-overlay" style={{ position: 'fixed', inset: 0, zIndex: 10130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: T.surface.scrim, fontFamily: '"DM Sans",system-ui,sans-serif' }}>
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

          {/* WHO HAS IT, AND DOES IT LOOK ALREADY BUILT — team only. So two
              people never answer the same item without knowing. Both save on
              the spot. */}
          {canTriage && (
            <div data-modal-team-facts style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px', borderRadius: T.radius.control, background: T.surface.sunken, border: T.border.thin }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <ClaimCircle item={item} myId={myId} busy={sideBusy === 'claim'} onToggle={(next) => sideWrite('claim', { assigned_to: next })} />
                <span data-modal-assignee style={{ fontSize: '13.5px', color: T.ink.primary }}>
                  {item.assigned_to
                    ? <><strong>{item.assigned_to === myId ? 'You have this' : `${item.assigned_to_name || 'Someone'} has this`}</strong></>
                    : <span style={{ color: T.ink.muted }}>Nobody has this yet</span>}
                </span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: '44px', cursor: 'pointer', fontSize: '13.5px', color: T.ink.primary }}>
                <input
                  type="checkbox"
                  data-looks-shipped-box
                  checked={!!item.looks_shipped}
                  disabled={sideBusy === 'looks'}
                  onChange={e => sideWrite('looks', { looks_shipped: e.target.checked })}
                  style={{ width: '18px', height: '18px', margin: 0, cursor: 'pointer' }}
                />
                <span>Looks already built — the owner may not know</span>
              </label>
              {sideError && <p style={{ fontSize: '12.5px', color: T.state.danger.strong, margin: 0 }}>{sideError}</p>}
            </div>
          )}

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
                  {['bug', 'feature', 'question'].map(t => (
                    <option key={t} value={t}>{FEEDBACK_TYPE_WORD[t]}</option>
                  ))}
                </select>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minHeight: '44px', fontSize: '15px', fontWeight: 600, color: typeColor(item.type) }}>
                  <TypeGlyph type={item.type} size={14} /> {typeWord(item.type)}
                </span>
              )}
            </div>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>
              <label style={fieldLabel} htmlFor="fb-status">Status</label>
              <select id="fb-status" aria-label="Status" value={status} onChange={e => pickStatus(e.target.value)} style={{ ...control, cursor: 'pointer' }}>
                {FEEDBACK_STATUS_ORDER.map(s => (
                  <option key={s} value={s} disabled={stuckOption(s)}>{FEEDBACK_STATUS_PLAIN[s]}</option>
                ))}
              </select>
            </div>
          </div>
          {autoMoved && (
            <p data-status-moved style={{ fontSize: '12.5px', color: T.ink.muted, marginTop: '-8px', lineHeight: 1.5 }}>
              Status moved to {FEEDBACK_STATUS_PLAIN.answered} because you wrote a reply. Change it above if that is wrong.
            </p>
          )}
          {canTriage && !isOwnItem && statusTouched && status === 'submitted' && item.status === 'submitted' && response.trim() && (
            <p data-status-floor style={{ fontSize: '12.5px', color: T.ink.muted, marginTop: '-8px', lineHeight: 1.5 }}>
              A replied item cannot stay at {FEEDBACK_STATUS_PLAIN.submitted} — saving stores it as {FEEDBACK_STATUS_PLAIN.answered}.
            </p>
          )}
          {typeChanged && (
            <p style={{ fontSize: '12.5px', color: T.ink.muted, marginTop: '-8px', lineHeight: 1.5 }}>
              Saving refiles this as {itemType === 'feature' ? 'an' : 'a'} {FEEDBACK_TYPE_WORD[itemType].toLowerCase()}. Nobody is emailed about a refiling.
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

          {/* ── THE CORPORATE-ONLY BLOCK — ABOVE THE REPLY BOX ──────
              It used to sit below it, so you scrolled past where you write
              the answer to read the thing that tells you the answer.
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
                  reply box below; sending is still Save, i.e. the route. */}
              {draft && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px' }}>
                  <button
                    type="button"
                    onClick={() => writeReply(draft.text || '')}
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

          {/* THE REPLY BOX. What Save does is said in the footer, next to
              the button, not under here. */}
          <div style={section}>
            <label style={{ ...fieldLabel, marginBottom: 0 }} htmlFor="fb-reply">Reply</label>
            <textarea
              id="fb-reply"
              value={response}
              onChange={e => writeReply(e.target.value)}
              rows={4}
              placeholder="Write back in plain words — they will read this in an email."
              style={{ ...control, outline: 'none', resize: 'vertical', lineHeight: 1.5 }}
            />
          </div>

          {error && <p style={{ fontSize: '13px', color: T.state.danger.strong, margin: 0 }}>{error}</p>}
          {resultLine && (
            <p style={{ fontSize: '13px', lineHeight: 1.5, margin: 0, color: resultLine.tone === 'bad' ? T.state.danger.strong : T.accent.deep }}>
              {resultLine.text}
            </p>
          )}

        </div>

        {/* FOOTER — pinned. */}
        <div style={{ padding: '12px 16px', borderTop: T.border.divider, display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0, background: T.surface.raised }}>
          {/* WHAT SAVE WILL DO — the consequence before the click. */}
          {dirty ? (
            <div data-save-consequences style={{ padding: '10px 12px', borderRadius: T.radius.control, background: willSend ? T.state.info.bg : T.surface.sunken, border: T.border.thin }}>
              <p style={{ fontSize: '12px', fontWeight: 700, color: T.ink.primary, margin: '0 0 4px' }}>Saving will:</p>
              <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {consequences.map(c => (
                  <li key={c.key} data-consequence={c.key} style={{ fontSize: c.loud ? '14px' : '13px', fontWeight: c.loud ? 700 : 500, color: c.loud ? T.state.info.deep : T.ink.primary, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
                    {c.text}
                  </li>
                ))}
              </ul>
              <p data-send-line style={{ fontSize: '12.5px', color: T.ink.secondary, margin: '6px 0 0', lineHeight: 1.5 }}>{sendLine}</p>
            </div>
          ) : (
            <p data-send-line style={{ fontSize: '12.5px', color: T.ink.muted, margin: 0, lineHeight: 1.5 }}>{sendLine}</p>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button onClick={onClose} style={{ minHeight: '44px', padding: '0 16px', background: 'transparent', border: T.border.control, borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 600, color: T.ink.secondary, cursor: 'pointer' }}>Close</button>
          <button onClick={save} disabled={saving || !dirty} style={{ minHeight: '44px', padding: '0 18px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 700, color: T.accent.onFill, cursor: (saving || !dirty) ? 'default' : 'pointer', opacity: (saving || !dirty) ? 0.6 : 1 }}>
            {saving ? 'Saving…' : (willSend ? `Save and email ${firstName}` : 'Save')}
          </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── THE CLUSTER BAR ───────────────────────────────────────────
// One line per cluster: a count, ONE plain sentence, "Open". Full width, dark,
// a 44px target. On a phone the trailing word hides (BAR_CSS) so the sentence
// keeps the width and wraps to two lines rather than three; the sentence is
// never clamped or cut — the probe's summary is written short for exactly
// this bar, and a bar with no summary shows the count alone rather than a
// slice of the paragraph.
const BAR_CSS = `
  @media (max-width: 480px) {
    .bee-fb-bar-open { display: none !important; }
  }
`

function clusterHeadline(cluster) {
  return `${cluster.itemIds.length} reports, one cause`
}

function ClusterBar({ cluster, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="cluster-bar"
      aria-label={`${clusterHeadline(cluster)} — open`}
      style={{
        width: '100%', minHeight: '44px', padding: '10px 14px',
        display: 'flex', alignItems: 'flex-start', gap: '10px',
        background: T.ink.primary, color: T.ink.inverse,
        border: 'none', borderRadius: T.radius.control, cursor: 'pointer',
        textAlign: 'left', fontFamily: 'inherit',
      }}
    >
      <span aria-hidden="true" style={{ color: T.brand.gold, fontSize: '14px', lineHeight: '20px', flexShrink: 0 }}>◈</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: '13px', lineHeight: '20px', overflowWrap: 'anywhere' }}>
        <strong style={{ fontWeight: 700 }}>{clusterHeadline(cluster)}</strong>
        {cluster.summary ? <span style={{ opacity: 0.92 }}> — {cluster.summary}</span> : null}
      </span>
      <span className="bee-fb-bar-open" aria-hidden="true" style={{ flexShrink: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 600, opacity: 0.9 }}>Open →</span>
    </button>
  )
}

// ── THE CLUSTER MODAL ─────────────────────────────────────────
// Everything the bar does not say. Corporate-only by construction: the bars
// only exist on the elevated mount, and their data only comes from the
// analysis route, which is 403 below admin.
//
// THE PLAIN / TECHNICAL SPLIT. "What is happening" is the probe's summary —
// the one sentence written without identifiers. The technical detail is the
// probe's `what` paragraph and its file list, VERBATIM, behind a disclosure
// that is closed by default and rendered only when opened (absent from the
// DOM, not display:none — so find-in-page, screen readers and the test all
// agree it is not there). The paragraph is not split: it cannot be cleanly,
// so it moves whole.
//
// NO VERDICT LINE. The analysis carries nothing that says what a cluster
// needs (a decision, a fix, a confirmation); three of the four probes bury a
// hint inside `what` and one has none. Rather than hand-write one per
// cluster, the section is left out until the library can supply it.
function ClusterModal({ cluster, items, analyses, onClose, onSelect }) {
  const [showTech, setShowTech] = useState(false)
  useEffect(() => { setShowTech(false) }, [cluster?.probe])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!cluster) return null

  const members = cluster.itemIds.map(id => items.find(i => i.id === id)).filter(Boolean)
  const missing = cluster.itemIds.length - members.length
  // The mechanism and the files come from a member's own analysis (every
  // member fired the same probe, so the first with files is representative).
  const withFiles = analyses ? cluster.itemIds.map(id => analyses.get(id)).find(a => a && a.files && a.files.length) : null
  const files = withFiles ? withFiles.files : []
  const headline = clusterHeadline(cluster)
  const label = { fontSize: '12px', fontWeight: 700, color: T.ink.primary, margin: '0 0 6px' }

  return (
    <div className="bee-fb-overlay" style={{ position: 'fixed', inset: 0, zIndex: 10130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: T.surface.scrim, fontFamily: '"DM Sans",system-ui,sans-serif' }}>
      <style>{MODAL_CSS}</style>
      <div className="bee-fb-dialog" role="dialog" aria-modal="true" aria-label={headline} data-testid="cluster-modal" style={{ background: T.surface.raised, borderRadius: T.radius.card, width: '100%', maxWidth: '640px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: T.shadow.overlay, overflow: 'hidden' }}>

        <div style={{ padding: '12px 16px 10px', borderBottom: T.border.divider, flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '17px', fontFamily: 'Georgia,serif', color: T.ink.primary, margin: 0, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
              {headline}
              {cluster.fleet && (
                <span style={{ fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, color: T.ink.muted }}> · {cluster.fleet.count} {cluster.fleet.unit} affected</span>
              )}
            </h2>
            <p style={{ fontSize: '12px', color: T.ink.muted, margin: '3px 0 0' }}>Only the team sees this. The owner never does.</p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: T.ink.muted, cursor: 'pointer', fontSize: '26px', lineHeight: 1, padding: 0, minWidth: '44px', minHeight: '44px', flexShrink: 0, marginTop: '-6px', marginRight: '-8px' }}>×</button>
        </div>

        <div style={{ padding: '16px', overflowY: 'auto', WebkitOverflowScrolling: 'touch', flex: 1, display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <p style={label}>What is happening</p>
            <p style={{ fontSize: '14px', color: T.ink.primary, lineHeight: 1.6, margin: 0 }}>
              {cluster.summary || 'No plain summary has been written for this cause yet — see the technical detail below.'}
            </p>
          </div>

          <div>
            <p style={label}>The {cluster.itemIds.length} reports</p>
            <div style={{ border: T.border.thin, borderRadius: T.radius.control, overflow: 'hidden' }}>
              {members.map((m, i) => {
                const days = triageWaitingDays(m)
                return (
                  <div key={m.id} style={{ padding: '10px 12px', borderTop: i === 0 ? 'none' : T.border.divider }}>
                    <span style={{ display: 'block', fontSize: '13.5px', fontWeight: 500, color: T.ink.primary, overflowWrap: 'anywhere' }}>{m.title}</span>
                    <span style={{ display: 'block', fontSize: '12px', color: T.ink.muted, marginTop: '2px' }}>
                      {m.submitter_name || 'Unknown'}{m.location_name ? ` · ${m.location_name}` : ''}
                      {days == null ? '' : days <= 0 ? ' · waiting since today' : ` · waiting ${dayPhrase(days)}`}
                    </span>
                  </div>
                )
              })}
              {missing > 0 && (
                <p style={{ fontSize: '12px', color: T.ink.quiet, margin: 0, padding: '10px 12px', borderTop: members.length ? T.border.divider : 'none' }}>
                  {plural(missing, 'report is', 'reports are')} not in the loaded list.
                </p>
              )}
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowTech(v => !v)}
              aria-expanded={showTech}
              className="bee-chip-action"
              style={{ padding: 0, minHeight: '44px', background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}
            >
              {showTech ? 'Hide the technical detail' : 'Show the technical detail'}
            </button>
            {showTech && (
              <div data-testid="cluster-technical" style={{ marginTop: '6px', padding: '12px 14px', borderRadius: T.radius.control, background: T.surface.sunken, border: T.border.thin }}>
                <p style={{ fontSize: '13px', color: T.ink.primary, lineHeight: 1.55, margin: 0, overflowWrap: 'anywhere' }}>{cluster.what}</p>
                {files.length > 0 && (
                  <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
                    {files.map(f => (
                      <li key={f} style={{ fontSize: '12px', color: T.ink.secondary, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', lineHeight: 1.6, overflowWrap: 'anywhere' }}>{f}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '12px 16px', borderTop: T.border.divider, display: 'flex', justifyContent: 'flex-end', gap: '10px', flexShrink: 0, background: T.surface.raised }}>
          <button onClick={onClose} style={{ minHeight: '44px', padding: '0 16px', background: 'transparent', border: T.border.control, borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 600, color: T.ink.secondary, cursor: 'pointer' }}>Close</button>
          <button onClick={onSelect} style={{ minHeight: '44px', padding: '0 18px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 700, color: T.accent.onFill, cursor: 'pointer' }}>
            Select these {cluster.itemIds.length} reports
          </button>
        </div>
      </div>
    </div>
  )
}

// ── THE TILES ─────────────────────────────────────────────────
// Two groups, each headed in sentence case with its count. Every tile says the
// same four things in the same order: the count, its name, one sentence about
// what is in it, and how old the oldest one is. A tile is a filter toggle
// (aria-pressed): pressing the lit one clears it.
//
// STUCK IS NOT A TILE. A tile reading 0 spent a third of a row saying
// nothing. It is still counted (lib/feedback-admin-tiles); when it is zero
// nothing renders at all, and when it is not, one red strip sits above both
// groups with a button that filters the list to them. So the bottom row is
// two tiles, never three with a dead one.
function StuckStrip({ count, onShow }) {
  if (!count) return null
  return (
    <div data-stuck-strip role="status" style={{
      display: 'flex', alignItems: 'center', gap: '10px 14px', flexWrap: 'wrap',
      padding: '10px 14px', borderRadius: T.radius.control,
      background: T.family.red.bg, border: `1px solid ${T.state.danger.strong}`,
    }}>
      <p style={{ margin: 0, flex: '1 1 260px', fontSize: '13.5px', lineHeight: 1.5, color: T.family.red.text }}>
        <strong>{count} {count === 1 ? 'has a reply but still says' : 'have a reply but still say'} nobody has answered.</strong>{' '}
        {ADMIN_TILES.find(t => t.key === 'stuck').what}
      </p>
      <button type="button" data-stuck-show onClick={onShow} style={{
        minHeight: '44px', padding: '0 14px', borderRadius: T.radius.control, cursor: 'pointer',
        background: T.state.danger.strong, color: T.ink.inverse, border: 'none',
        fontFamily: 'inherit', fontWeight: 700, whiteSpace: 'nowrap',
      }}>
        Show them
      </button>
    </div>
  )
}

function AdminTiles({ summary, active, onPick }) {
  return (
    <div data-admin-tiles style={{ display: 'flex', flexDirection: 'column', gap: '16px', margin: '4px 0 14px' }}>
      <StuckStrip count={summary.tiles.stuck.count} onShow={() => onPick('stuck')} />
      {ADMIN_GROUPS.map(g => {
        const raised = g.key === 'unreplied'
        return (
          <section key={g.key} data-tile-group={g.key} aria-label={g.label}>
            <h3 style={{ margin: '0 0 8px', display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', fontSize: '15px', fontWeight: 600, color: T.ink.primary }}>
              <span data-group-label>{g.label}</span>
              <span data-group-count={g.key} style={{ fontSize: '15px', fontWeight: 700, color: T.ink.primary, fontVariantNumeric: T.type.tabular }}>{summary.groups[g.key].count}</span>
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}>
              {ADMIN_TILES.filter(t => t.group === g.key && t.key !== 'stuck').map(t => {
                const on = active === t.key
                const tile = summary.tiles[t.key]
                const fam = T.family[TILE_FAMILY[t.key]] || T.family.gray
                const ink = raised ? fam.text : T.ink.primary
                const surface = raised
                  ? {
                      background: fam.bg,
                      border: `${on ? 2.5 : 1.5}px solid ${TILE_EDGE[t.key]}`,
                      boxShadow: T.shadow.card,
                    }
                  : {
                      background: RECESSED_FILL,
                      border: on ? `2px solid ${T.ink.primary}` : '1px solid transparent',
                      boxShadow: 'none',
                    }
                return (
                  <button
                    key={t.key}
                    type="button"
                    data-tile={t.key}
                    data-tile-row={raised ? 'raised' : 'recessed'}
                    aria-pressed={on}
                    onClick={() => onPick(on ? null : t.key)}
                    style={{
                      textAlign: 'left', minHeight: '44px', padding: '12px 14px', cursor: 'pointer', fontFamily: 'inherit',
                      borderRadius: T.radius.control, display: 'flex', flexDirection: 'column', gap: '3px',
                      ...surface,
                    }}
                  >
                    <span data-tile-count style={{ fontSize: '24px', fontWeight: 700, color: ink, lineHeight: 1.1, fontVariantNumeric: T.type.tabular }}>{tile.count}</span>
                    <span data-tile-name style={{ fontSize: '15px', fontWeight: 700, color: ink }}>{t.name}</span>
                    <span data-tile-what style={{ fontSize: '13px', color: T.ink.secondary, lineHeight: 1.45 }}>{t.what}</span>
                    <span data-tile-oldest style={{ fontSize: '12.5px', marginTop: '2px' }}>
                      {tile.oldestDays == null
                        ? <span style={{ color: T.ink.muted }}>Nothing here.</span>
                        : <AgeText days={tile.oldestDays} oldest />}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

export default function AdminFeedbackScreen({
  // Reports the BADGE count (lib/feedback-admin-tiles adminBadgeCount) up to
  // the nav: unanswered bugs + unanswered questions. Not the open count.
  onBadgeCountChange = () => {},
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
  // THE FILTERS. A tile (or none), open/closed/everything, location, who has
  // it, search. Closed items are reached HERE — there is no link at the
  // bottom any more; 71 of 113 items used to hide behind one.
  const [tileFilter, setTileFilter] = useState(null)
  const [scope, setScope]           = useState('open') // 'open' | 'closed' | 'all'
  const [locFilter, setLocFilter]   = useState('all')
  const [whoFilter, setWhoFilter]   = useState('anyone') // 'anyone' | 'mine' | 'nobody' | <user id>
  const [userQuery, setUserQuery]   = useState('')
  // The open modal: a snapshot of the visible list's ids plus the index.
  const [walk, setWalk] = useState(null)
  // The open CLUSTER modal, by probe key (one bar per probe).
  const [openCluster, setOpenCluster] = useState(null)
  // The internal composer (issue 247 step 2). Elevated mounts only.
  const [composing, setComposing] = useState(false)
  // VERDICT SELECTION (issue 306). Not persisted, like every filter here.
  const [selected, setSelected]       = useState(() => new Set())
  const [armed, setArmed]             = useState(null)
  const [applying, setApplying]       = useState(null)
  const [verdictNote, setVerdictNote] = useState(null)
  const [claimBusy, setClaimBusy]     = useState(null)
  const [claimError, setClaimError]   = useState(null)

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

  // The header's open count (the dashboard's number too) and the BADGE, which
  // is not the open count — see lib/feedback-admin-tiles.
  const summary = useMemo(() => summarizeFeedbackQueues(items), [items])
  const badge = useMemo(() => adminBadgeCount(items), [items])
  useEffect(() => { onBadgeCountChange(badge) }, [badge, onBadgeCountChange])

  const franchiseMount = !!onReportFeedback
  const canTriage = !franchiseMount

  const locOptions = useMemo(() => {
    const seen = new Map()
    items.forEach(i => { if (i.location_id) seen.set(i.location_id, i.location_name || i.location_id) })
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [items])
  // Everyone who has something claimed, for the "who has it" filter.
  const whoOptions = useMemo(() => {
    const seen = new Map()
    items.forEach(i => { if (i.assigned_to && i.assigned_to !== myId) seen.set(i.assigned_to, i.assigned_to_name || 'Someone') })
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [items, myId])

  const matchLoc = (i) => locFilter === 'all' || i.location_id === locFilter
  const matchWho = (i) =>
    whoFilter === 'anyone' ? true
    : whoFilter === 'mine' ? (!!myId && i.assigned_to === myId)
    : whoFilter === 'nobody' ? !i.assigned_to
    : i.assigned_to === whoFilter
  const matchQuery = (i) => {
    const q = userQuery.trim().toLowerCase()
    if (!q) return true
    return `${i.title || ''} ${i.description || ''} ${i.submitter_name || ''} ${i.submitter_email || ''}`
      .toLowerCase().includes(q)
  }

  // Everything that survives search + location + who — what the tiles count.
  const scoped = useMemo(
    () => items.filter(i => matchLoc(i) && matchWho(i) && matchQuery(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, locFilter, whoFilter, userQuery, myId],
  )
  const tiles = useMemo(() => summarizeAdminTiles(scoped), [scoped])

  // ── THE SECTIONS ─────────────────────────────────────────────────
  // Open: one section per tile, in tile order, oldest first inside each — the
  // same word and colour as the tile, and the tile's own line, never a second
  // explanation. Closed: one section per closed status, most recently
  // decided first.
  const byAgeOldest = (a, b) => new Date(a.created_at) - new Date(b.created_at)
  const byRecent = (a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at)
  const sections = useMemo(() => {
    const out = []
    const showOpen = scope !== 'closed'
    const showClosed = scope !== 'open' && !tileFilter
    if (showOpen) {
      for (const t of ADMIN_TILES) {
        if (tileFilter && tileFilter !== t.key) continue
        const rows = scoped.filter(i => adminTileOf(i) === t.key).sort(byAgeOldest)
        out.push({ key: t.key, kind: 'tile', title: t.name, ink: t.group === 'unreplied' ? tileInk(t.key) : T.ink.primary, group: t.group, items: rows })
      }
    }
    if (showClosed) {
      for (const st of CLOSED_ORDER) {
        const rows = scoped.filter(i => i.status === st).sort(byRecent)
        out.push({ key: `closed-${st}`, kind: 'closed', title: FEEDBACK_STATUS_PLAIN[st], ink: (T.family[CLOSED_FAMILY[st]] || T.family.gray).text, items: rows })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, scope, tileFilter])
  // The visible list, in render order — what the modal walks.
  const visible = useMemo(() => sections.flatMap(s => s.items), [sections])
  const closedTotal = summary.closed

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

  // Merge a saved row back in. reply_email is the route's report on the send,
  // not a column.
  const mergeRow = useCallback((updated) => {
    const { reply_email: _ignored, ...row } = updated || {}
    if (!row.id) return
    setItems(prev => prev.map(i => (i.id === row.id ? { ...i, ...row } : i)))
  }, [])

  // CLAIM / RELEASE from the row — the same PATCH the modal makes.
  const toggleClaim = useCallback(async (item, next) => {
    setClaimBusy(item.id)
    setClaimError(null)
    try {
      const res = await fetch(`/api/admin/feedback/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_to: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      mergeRow(await res.json())
    } catch {
      setClaimError(`Could not change who has “${item.title}”. Please try again.`)
    } finally {
      setClaimBusy(null)
    }
  }, [mergeRow])

  // 16px so a phone does not zoom on focus; 44px tall so a thumb can hit it.
  const quietInput = { minHeight: '44px', padding: '8px 12px', border: T.border.control, borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised, cursor: 'pointer' }
  const linkBtn = { padding: 0, background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }

  // ── ONE ROW ─────────────────────────────────────────────────────
  // checkbox · claim circle · the row button. The type glyph is drawn in a
  // neutral ink — the section already says what type it is, and red on this
  // screen is reserved for age. The status is a chip, and only in the replied
  // group and the closed list. Age is coloured on the row itself.
  const renderRow = (it) => {
    const closed = isClosedFeedback(it.status)
    const internal = !!it.is_internal
    const picked = selected.has(it.id)
    const tile = adminTileOf(it)
    const showChip = closed || (tile && adminGroupOf(tile) === 'replied')
    const note = replyNote(it, internal)
    return (
      <div key={it.id} data-row={it.id} style={{ borderTop: T.border.divider, opacity: closed ? 0.72 : 1, background: picked ? T.accent.faint : 'transparent', display: 'flex', alignItems: 'flex-start' }}>
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
        {canTriage && (
          <ClaimCircle item={it} myId={myId} busy={claimBusy === it.id} onToggle={(next) => toggleClaim(it, next)} />
        )}
        <button
          onClick={() => openRow(it.id)}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: '10px',
            minHeight: '44px', padding: canTriage ? '12px 14px 12px 4px' : '12px 14px', border: 'none',
            background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
          }}
        >
          <TypeGlyph type={it.type} size={15} style={{ marginTop: '2px', color: T.ink.muted }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '14px', fontWeight: 500, color: T.ink.primary, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
                {it.title}
              </span>
              {showChip && <StatusChip item={it} />}
              {it.looks_shipped && (
                <span data-looks-shipped-flag style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '1px 8px', borderRadius: T.radius.pill, fontSize: '11.5px', fontWeight: 600, lineHeight: 1.6, border: `1px solid ${T.family.green.text}`, color: T.family.green.text, whiteSpace: 'nowrap' }}>
                  <IconCheck size={11} /> Looks built
                </span>
              )}
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
              {closed
                ? <span>{feedbackTimeAgo(it.updated_at || it.created_at)}</span>
                : <AgeText days={feedbackAgeDays(it.created_at)} />}
              {' · '}{it.submitter_name || 'Unknown'}
              {!franchiseMount && it.location_name ? ` · ${it.location_name}` : ''}
              {internal ? ' · Internal' : ''}
              {note ? <> · <strong style={{ color: T.ink.secondary }}>{note}</strong></> : ''}
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

  // ── ONE SECTION ─────────────────────────────────────────────────
  // The tile's name in the tile's colour, and the count. NOTHING ELSE: the
  // tile just above already said what is in it, and saying it twice was the
  // old screen's problem.
  const renderSection = (sec) => (
    <section key={sec.key} data-section={sec.key} aria-label={sec.title} style={{ paddingBottom: '6px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 700, color: sec.ink, margin: 0, padding: '16px 14px 8px', display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span data-section-title>{sec.title}</span>
        <span data-section-count style={{ fontSize: '13px', fontWeight: 500, color: T.ink.muted, fontVariantNumeric: T.type.tabular }}>{sec.items.length}</span>
      </h3>
      {sec.items.length === 0
        ? <p style={{ fontSize: '13px', color: T.ink.quiet, margin: 0, padding: '0 14px 10px' }}>Nothing here.</p>
        : sec.items.map(renderRow)}
    </section>
  )

  const anyFilter = !!tileFilter || scope !== 'open' || locFilter !== 'all' || whoFilter !== 'anyone' || !!userQuery.trim()

  return (
    <div style={{ padding: '14px 1rem 1rem', fontFamily: 'DM Sans,system-ui,sans-serif' }}>
      {/* HEADER — the open count (the dashboard's number). The badge is a
          different, smaller number and says so in its own place. */}
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

      {/* THE TILES — two groups, six tiles, each a filter. */}
      {!loading && !error && items.length > 0 && (
        <AdminTiles summary={tiles} active={tileFilter} onPick={(k) => { setTileFilter(k); if (k && scope === 'closed') setScope('open') }} />
      )}

      {/* THE FILTER ROW — one row that wraps cleanly. Search takes whatever
          room is left; the three pickers keep their natural width; "Clear
          filters" is a member of the row, not a link floating after it. */}
      <div data-filter-row style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', margin: '10px 0 12px' }}>
        <input value={userQuery} onChange={e => setUserQuery(e.target.value)} placeholder="Search name, title or description" aria-label="Search feedback" style={{ ...quietInput, cursor: 'text', flex: '1 1 240px', minWidth: 0 }} />
        <select value={scope} onChange={e => { setScope(e.target.value); if (e.target.value === 'closed') setTileFilter(null) }} aria-label="Open or closed" style={{ ...quietInput, flex: '0 0 auto' }}>
          <option value="open">Open ({summary.open})</option>
          <option value="closed">Closed ({closedTotal})</option>
          <option value="all">Everything ({summary.total})</option>
        </select>
        {!franchiseMount && (
          <select value={locFilter} onChange={e => setLocFilter(e.target.value)} aria-label="Location" style={{ ...quietInput, flex: '0 0 auto' }}>
            <option value="all">All locations</option>
            {locOptions.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        {canTriage && (
          <select value={whoFilter} onChange={e => setWhoFilter(e.target.value)} aria-label="Who has it" style={{ ...quietInput, flex: '0 0 auto' }}>
            <option value="anyone">Anyone has it</option>
            <option value="mine">Mine</option>
            <option value="nobody">Nobody yet</option>
            {whoOptions.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {anyFilter && (
          <button type="button" data-clear-filters onClick={() => { setTileFilter(null); setScope('open'); setLocFilter('all'); setWhoFilter('anyone'); setUserQuery('') }} style={{ ...quietInput, flex: '0 0 auto', background: 'transparent', color: T.accent.fg, fontWeight: 600 }}>
            Clear filters
          </button>
        )}
      </div>
      {claimError && <p style={{ fontSize: '12.5px', color: T.state.danger.strong, margin: '0 0 10px' }}>{claimError}</p>}

      {/* CLUSTERS (issue 307) — ONE DARK BAR EACH, above the queues. A count,
          one plain sentence, a way in. Everything else — the impact number,
          the members, the mechanism with its identifiers — is in the cluster
          modal the bar opens. The mechanism used to print here in full, code
          names and all, before a single report was visible. */}
      {canTriage && !loading && !error && clusters.length > 0 && (
        <div style={{ marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <style>{BAR_CSS}</style>
          {clusters.map(c => (
            <ClusterBar key={c.probe} cluster={c} onOpen={() => setOpenCluster(c.probe)} />
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
      ) : visible.length === 0 ? (
        <p style={{ fontSize: '13px', color: T.ink.muted, textAlign: 'center', padding: '30px 0 16px' }}>
          {summary.open === 0 && !anyFilter
            ? 'Nothing open — everything has been answered or decided.'
            : 'No feedback matches these filters.'}
        </p>
      ) : (
        /* One rounded container; the sections and their hairline rows inside. */
        <div style={{ background: T.surface.raised, border: T.border.thin, borderRadius: '12px', overflow: 'hidden' }}>
          {sections.filter(sec => sec.items.length > 0 || (tileFilter && sec.kind === 'tile')).map(renderSection)}
        </div>
      )}

      {selectedItem && walk && (
        <AdminFeedbackDetailModal
          item={selectedItem}
          queueLabel={(() => { const t = adminTileOf(selectedItem); return t ? ADMIN_TILES.find(x => x.key === t).name : (FEEDBACK_STATUS_PLAIN[selectedItem.status] || null) })()}
          position={walk.index + 1}
          total={walk.ids.length}
          isOwnItem={!!myId && selectedItem.user_id === myId}
          canTriage={canTriage}
          myId={myId}
          // undefined until the analysis fetch lands (the copy button waits);
          // null once it has landed with nothing for this item.
          analysis={analyses ? (analyses.get(selectedItem.id) || null) : undefined}
          cluster={clusters.find(c => c.itemIds.includes(selectedItem.id)) || null}
          draft={drafts.get(selectedItem.id) || null}
          onPrev={goPrev}
          onNext={goNext}
          onClose={closeWalk}
          onSaved={mergeRow}
        />
      )}

      {canTriage && openCluster && clusters.some(c => c.probe === openCluster) && (
        <ClusterModal
          cluster={clusters.find(c => c.probe === openCluster)}
          items={items}
          analyses={analyses}
          onClose={() => setOpenCluster(null)}
          // The footer button does exactly what "Show them" did: select the
          // members so a verdict can land on all of them at once.
          onSelect={() => { const c = clusters.find(x => x.probe === openCluster); if (c) { setSelected(new Set(c.itemIds)); setArmed(null) } setOpenCluster(null) }}
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
