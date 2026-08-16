// lib/feedback-brief.ts
//
// The daily bug brief: what is open, how old, and where it probably lives.
// Issue 248 step 2.
//
// ─── WHAT THIS IS FOR ─────────────────────────────────────────────────
// Triage starts with ten minutes of "where does this even live". The map built
// in step 1 already knows; this puts the answer next to the report so the ten
// minutes are already spent by the time Kevin reads it.
//
// ─── GROUPED BY TYPE, SORTED OLDEST FIRST ─────────────────────────────
// Bugs lead, then features, then decisions, then hazards — because a bug is
// something behaving wrongly right now and a feature request is not.
//
// Within each group, OLDEST FIRST. Age is the thing that goes wrong quietly: a
// bug nobody has answered in three weeks is the one worth seeing, and
// newest-first buries it forever under a steady trickle of new arrivals. Age
// prints as "19 days", never as a date — a date makes the reader do arithmetic
// every single morning.
//
// ─── WHY NOT THE FOUR QUEUES ──────────────────────────────────────────
// summarizeFeedbackQueues (issue 233) partitions open items into new / stale /
// working / inHand, and this module still depends on it — for the open
// definition, for the header counts, and above all for the staleness signal
// that drives suppression. What it does NOT do is structure the brief, because
// those four buckets answer "how is triage going" and a reader of this brief is
// asking "what is wrong". There is still exactly one definition of open and one
// of stale, and it is still that module's.
//
// ─── ANALYSIS APPLIES TO BUGS, MOSTLY ─────────────────────────────────
// "Where does this live" has a real answer for a bug and often none at all for
// a feature request: "Thumbtack integration" points nowhere because it does not
// exist yet. So bugs always get the analysis; features get it only when the
// request names an existing surface to change; decisions and hazards get none,
// because they are not located in code at all.
//
// ─── SUPPRESSION ──────────────────────────────────────────────────────
// Nothing new and nothing newly stale → post nothing. A daily message that says
// "no change" every day trains the reader to ignore it, and then it stops
// working on the day it matters. Same posture as the webhook digest.

import {
  summarizeFeedbackQueues,
  isStaleFeedback,
  isClosedFeedback,
  feedbackAgeDays,
  FEEDBACK_STALE_DAYS,
  type FeedbackQueueSummary,
} from './feedback-queues'
import { isInternalItem } from './feedback-internal'
import { placeFeedbackItem, type PlacementIndex, type Placement } from './feedback-placement'

export interface BriefItem {
  id?: string | null
  type?: string | null
  title?: string | null
  description?: string | null
  status?: string | null
  created_at?: string | null
  updated_at?: string | null
  admin_response?: string | null
  is_internal?: boolean | null
  submitter?: string | null
  location?: string | null
}

// Ordered. This is the order the brief prints, and the reason for it.
const GROUPS = [
  { type: 'bug', heading: 'BUGS', blurb: 'something is behaving wrongly' },
  { type: 'feature', heading: 'FEATURES', blurb: 'someone wants something that does not exist' },
  { type: 'decision', heading: 'DECISIONS', blurb: 'waiting on a person, not on code' },
  { type: 'hazard', heading: 'HAZARDS', blurb: 'latent, will bite later' },
] as const

// Types that get the screen-map analysis at all.
const ANALYSED_TYPES = new Set(['bug', 'feature'])

const DAY_MS = 86400000

// ─── Mis-typed items ──────────────────────────────────────────────────
// Owners choose the type themselves and get it wrong: several rows filed as
// bugs are plainly feature requests ("any way to bulk update and send them to
// client"). The stored value is NEVER changed — silently re-typing would make
// the open-bug count disagree with the tracker, which is the one number the
// tracker exists to get right. Instead the line carries a short flag so Kevin
// can correct it in triage, where the decision belongs.
//
// Deliberately conservative: it fires only on an explicit request-shaped
// phrase, and only when no defect-shaped phrase is also present. "Snooze not
// available in Client section" reads as both and is therefore left alone.
const WANT_CUES = [
  'would like', 'would love', 'would be great', 'would be lovely', 'it would be',
  'can we add', 'could we', 'any way to', 'is there a way to', 'need to be able',
  'i wish', 'please add', 'we want', 'really want', 'nice to have',
]
const DEFECT_CUES = [
  'not working', 'doesnt work', 'does not work', 'is broken', 'error',
  'showed up', 'showing up in', 'shows up in', 'did not show', 'didnt show',
  'is cut off', 'not seeing', 'isnt showing', 'is not showing', 'never created',
  'wrong', 'incorrect', 'stuck', 'failed',
]

const flatten = (text: string) => String(text || '').toLowerCase().replace(/['’]/g, '')

export function mistypeFlag(item: BriefItem): string | null {
  const text = flatten(`${item.title || ''} ${item.description || ''}`)
  if (!text.trim()) return null
  const wants = WANT_CUES.some(c => text.includes(c))
  const defects = DEFECT_CUES.some(c => text.includes(c))
  if (item.type === 'bug' && wants && !defects) return 'reads as a feature request'
  if (item.type === 'feature' && defects && !wants) return 'reads as a bug'
  return null
}

export interface BriefLine {
  item: BriefItem
  ageDays: number | null
  placement: Placement | null
  mistype: string | null
  internal: boolean
  newlyStale: boolean
}

export interface FeedbackBrief {
  suppressed: boolean
  text: string
  summary: FeedbackQueueSummary
  openCount: number
  newCount: number
  newlyStaleCount: number
  internalCount: number
  /** How many open items the analysis could name one surface for / shortlist / neither. */
  placed: { confident: number; possible: number; none: number }
  groups: { type: string; lines: BriefLine[] }[]
}

function ageLabel(days: number | null): string {
  if (days == null) return 'age unknown'
  if (days === 0) return 'today'
  if (days === 1) return '1 day'
  return `${days} days`
}

function fileRef(c: { file: string; lines?: number[] }): string {
  return c.lines && c.lines.length === 2 ? `${c.file}:${c.lines[0]}` : c.file
}

// The analysis line(s) for one item. Returns [] when nothing should be printed
// — for a decision, for a hazard, and for a feature request that points
// nowhere. Saying nothing is the correct output there; reaching for a file
// would be the failure.
function analysisLines(line: BriefLine): string[] {
  const type = String(line.item.type || '')
  if (!ANALYSED_TYPES.has(type)) return []
  const p = line.placement
  if (!p) return []

  if (p.confidence === 'confident') {
    const c = p.candidates[0]
    return [`      ↳ likely: ${c.surface}`, `        ${fileRef(c)}  (matched: ${c.matched.join(', ')})`]
  }

  if (p.confidence === 'possible' && p.candidates.length) {
    const out = [`      ↳ possible (${p.candidates.length === 1 ? 'weak match' : 'not certain which'}):`]
    for (const c of p.candidates) {
      out.push(`        · ${c.surface}`)
      out.push(`          ${fileRef(c)}  (matched: ${c.matched.join(', ')})`)
    }
    return out
  }

  // Nothing to say. For a bug that is itself information — it tells Kevin this
  // one needs a question asked, not a file opened. For a feature request that
  // names no existing surface, silence is right and a line would be padding.
  if (type === 'bug') {
    return ['      ↳ not enough to place — needs a follow-up question to the owner']
  }
  return []
}

export interface BuildBriefInput {
  items: BriefItem[]
  index: PlacementIndex
  now?: number
  appUrl?: string
}

export function buildFeedbackBrief({
  items,
  index,
  now = Date.now(),
  appUrl = '',
}: BuildBriefInput): FeedbackBrief {
  const all = items || []
  // ONE definition of open, and it is issue 233's. Not re-derived here.
  const summary = summarizeFeedbackQueues(all, now)
  const open = all.filter(i => !isClosedFeedback(i.status))

  const lines: BriefLine[] = open.map(item => {
    const type = String(item.type || '')
    // Only ask the matcher about things that can be located in code at all.
    const placement = ANALYSED_TYPES.has(type) ? placeFeedbackItem(item, index) : null
    return {
      item,
      ageDays: feedbackAgeDays(item.created_at, now),
      placement,
      mistype: mistypeFlag(item),
      internal: isInternalItem(item),
      // Crossed the quiet threshold within the last day. Computed from the
      // SAME predicate the queues use, evaluated at two points in time —
      // rather than a second notion of staleness that could drift from it.
      newlyStale: isStaleFeedback(item, now) && !isStaleFeedback(item, now - DAY_MS),
    }
  })

  const newCount = lines.filter(l => l.ageDays != null && l.ageDays < 1).length
  const newlyStaleCount = lines.filter(l => l.newlyStale).length
  const internalCount = lines.filter(l => l.internal).length

  const placed = { confident: 0, possible: 0, none: 0 }
  for (const l of lines) {
    if (!l.placement) continue
    placed[l.placement.confidence]++
  }

  const groups = GROUPS.map(g => ({
    type: g.type,
    lines: lines
      .filter(l => String(l.item.type || '') === g.type)
      // Oldest first. A null age sorts last — it cannot be aged, so it cannot
      // claim to be the oldest thing here.
      .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1)),
  }))

  // Anything whose type is not one of the four still has to appear. A row that
  // falls out of the brief because its type was unexpected is a silent hole,
  // and this brief's whole claim is that it shows what is open.
  const known = new Set<string>(GROUPS.map(g => g.type))
  const other = lines.filter(l => !known.has(String(l.item.type || '')))

  const suppressed = newCount === 0 && newlyStaleCount === 0

  const text = suppressed
    ? ''
    : renderBrief({ summary, groups, other, newCount, newlyStaleCount, internalCount, placed, appUrl })

  return {
    suppressed,
    text,
    summary,
    openCount: summary.open,
    newCount,
    newlyStaleCount,
    internalCount,
    placed,
    groups,
  }
}

function renderItemLine(line: BriefLine): string[] {
  const it = line.item
  const bits: string[] = []

  // Internal items ride in the same brief — Kevin and corporate need one list,
  // not two — but an internal hazard and an owner's bug report must never read
  // identically, so the origin is the first thing on the line.
  const origin = line.internal
    ? '[internal]'
    : `${it.submitter || 'unknown'}${it.location ? ` · ${it.location}` : ''}`

  const flags = [
    line.newlyStale ? 'JUST WENT QUIET' : null,
    line.mistype ? `?${line.mistype}` : null,
  ].filter(Boolean)

  bits.push(
    `   • ${ageLabel(line.ageDays)} — ${it.title || '(untitled)'}${flags.length ? `  [${flags.join('; ')}]` : ''}`,
  )
  bits.push(`      ${origin} · ${it.status || 'unknown'}`)

  const desc = String(it.description || '').replace(/\s+/g, ' ').trim()
  if (desc) bits.push(`      "${desc.length > 240 ? `${desc.slice(0, 237)}...` : desc}"`)

  bits.push(...analysisLines(line))
  return bits
}

function renderBrief(o: {
  summary: FeedbackQueueSummary
  groups: { type: string; lines: BriefLine[] }[]
  other: BriefLine[]
  newCount: number
  newlyStaleCount: number
  internalCount: number
  placed: { confident: number; possible: number; none: number }
  appUrl: string
}): string {
  const out: string[] = []
  const s = o.summary

  out.push('*Feedback brief*')
  const headline = [
    `${s.open} open`,
    `${o.newCount} new today`,
    `${o.newlyStaleCount} just went quiet`,
  ]
  if (o.internalCount) headline.push(`${o.internalCount} internal`)
  out.push(headline.join(' · '))
  out.push(
    `queues — new ${s.counts.new} · stale ${s.counts.stale} · working ${s.counts.working} · in hand ${s.counts.inHand}` +
      ` (stale = untouched ${FEEDBACK_STALE_DAYS}d+)`,
  )
  // ONCE, in the header — not on every row. There is no per-item deep link to
  // give: triage is one screen, so the same URL on all 28 lines would be 28
  // identical lines of padding, and padding is what stops the brief being read.
  if (o.appUrl) out.push(`triage: ${o.appUrl}/?feedback=1`)

  for (const g of GROUPS) {
    const group = o.groups.find(x => x.type === g.type)
    if (!group || group.lines.length === 0) continue
    out.push('')
    out.push(`*${g.heading}* (${group.lines.length}) — ${g.blurb}`)
    for (const line of group.lines) out.push(...renderItemLine(line))
  }

  if (o.other.length) {
    out.push('')
    out.push(`*OTHER* (${o.other.length}) — unrecognised type, shown so nothing is hidden`)
    for (const line of o.other) out.push(...renderItemLine(line))
  }

  out.push('')
  out.push(
    `_where-it-lives: ${o.placed.confident} placed · ${o.placed.possible} shortlisted · ` +
      `${o.placed.none} need a question first. Starting points, not conclusions._`,
  )

  return out.join('\n')
}
