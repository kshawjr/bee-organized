// lib/feedback-nudge.ts
//
// What Slack carries about feedback now: NEWS, not work. Issue 309 step 5.
//
// ─── WHY THE FULL BRIEF IS RETIRED FROM SLACK ─────────────────────────
// Issue 248 step 2 posted the whole open list with per-item analysis. The
// verdict on the sample was "feels busy", then "I don't want it in Slack, that
// will just be a massive message". That is the right call: twenty-four items
// with analysis is a wall you scroll past, and a message you scroll past for a
// fortnight is one you have stopped reading — which is worse than no message,
// because now nobody is watching AND everyone believes someone is.
//
// The triage screen (issues 306–308) is where the work happens. Slack's job
// shrinks to telling Kevin when to go and look.
//
// NOTHING WAS DELETED TO DO THIS. buildFeedbackBrief, the placement matcher and
// the queue arithmetic are all still here and still exported — issue 307 builds
// on the matcher and the queues, and the brief's own tests still pass. What
// changed is only what gets POSTED.
//
// ─── FOUR LINES, AND NOTHING PER-ITEM ─────────────────────────────────
// Counts, the oldest untouched item, a link. The oldest item is named by AGE
// only — never by title — because the moment one title appears the message is
// back on the road to being a list.
//
// ─── SUPPRESS WHEN QUIET ──────────────────────────────────────────────
// Same posture as the webhook digest, for the same reason: a message that says
// "no change" every morning trains the reader to ignore it, and then it fails
// on the one day it mattered.
//
// ─── THE TRANSPORT CONTRACT ───────────────────────────────────────────
// These go to the OPS webhook (lib/slack.ts → SLACK_WEBHOOK_URL), which is a
// different rail from the per-location lead card (lib/slack-bot.ts, OAuth bot
// token → chat.postMessage). That file's header says the two share zero env
// vars, zero columns and zero call paths, and must not be merged. Nothing here
// touches it, so its log_call interactivity contract is protected by distance
// rather than by care.
//
// NO INTERACTIVE ELEMENTS, deliberately. Every affordance here is a LINK to the
// triage screen. A Slack button would need a matching action handler in
// app/api/slack/interactivity, and adding one is a separate decision from
// posting a nudge.

import type { FeedbackQueueSummary } from './feedback-queues'

/** One-line top-level text + a coloured attachment carrying the body. */
export interface SlackPost {
  text: string
  attachments: Array<{ color: string; fallback: string; text: string }>
}

// Slack's semantic palette. Named here rather than inline so the sweep in the
// admin screen never sees a hex and neither does anyone reading a component;
// these are Slack attachment colours, not app tokens.
const TONE = {
  quiet: '#6b7280',
  attention: '#d97706',
  bad: '#b91c1c',
}

export interface NudgeInput {
  summary: FeedbackQueueSummary
  /** Age in days of the oldest item nobody has looked at. */
  oldestNewDays: number | null
  triageUrl: string
}

export interface NudgeResult {
  suppressed: boolean
  post: SlackPost | null
  /** Why it was suppressed, for the cron's log line. */
  reason?: string
}

const dayPhrase = (d: number | null): string => {
  if (d == null) return 'unknown age'
  if (d <= 0) return 'today'
  if (d === 1) return '1 day'
  return `${d} days`
}

/**
 * The weekday-morning nudge. FOUR LINES, counts only.
 *
 * Suppressed when there is nothing open at all — not merely when nothing
 * changed. An empty queue is the one state where silence is unambiguous, and
 * a daily "0 open" is exactly the message that teaches someone to stop
 * looking.
 */
export function buildNudge({ summary, oldestNewDays, triageUrl }: NudgeInput): NudgeResult {
  if (!summary || summary.open === 0) {
    return { suppressed: true, post: null, reason: 'nothing open' }
  }

  const c = summary.counts
  const lines = [
    `${summary.open} open · ${c.new} not looked at · ${c.stale} gone quiet · ${c.working} in progress`,
    oldestNewDays != null
      ? `Oldest untouched: ${dayPhrase(oldestNewDays)}.`
      : 'Nothing is sitting untouched.',
    `<${triageUrl}|Open triage>`,
  ]

  // Four lines total: the headline plus these three. The count is asserted by
  // test — this is the constraint the whole redesign turns on.
  const text = 'Feedback — where the queue stands'
  const tone = c.stale > 0 ? TONE.attention : TONE.quiet

  return {
    suppressed: false,
    post: {
      text,
      attachments: [{ color: tone, fallback: `${summary.open} open feedback items`, text: lines.join('\n') }],
    },
  }
}

// ─── The three triggered alerts ───────────────────────────────────────
//
// Each fires ONLY when its thing happens. None is a digest, none repeats a
// standing state, and none carries per-item analysis — they carry the fact and
// a link, and the screen carries the detail.

export type AlertKind = 'cluster-formed' | 'shipped-with-waiters' | 'unopened-reply'

export interface ClusterFormedEvent {
  kind: 'cluster-formed'
  probe: string
  /** Total reports now sharing this cause. The alert fires when this hits 3. */
  size: number
  what: string
  fleetCount?: number | null
  fleetUnit?: string | null
}

export interface ShippedWithWaitersEvent {
  kind: 'shipped-with-waiters'
  /** How many open reports the shipped change appears to answer. */
  waiting: number
  /** Plain-language summary of what shipped. No hashes, no filenames. */
  what: string
  /** True when the link between the change and the reports is uncertain. */
  uncertain: boolean
}

export interface UnopenedReplyEvent {
  kind: 'unopened-reply'
  count: number
  /** Days since the oldest unopened reply was written. */
  oldestDays: number
}

export type FeedbackAlertEvent =
  | ClusterFormedEvent
  | ShippedWithWaitersEvent
  | UnopenedReplyEvent

/** The threshold at which a shared cause becomes news. Two is a coincidence. */
export const CLUSTER_ALERT_AT = 3
/** An answered item nobody has opened for this long is a delivery failure. */
export const UNOPENED_REPLY_DAYS = 21

export function buildAlert(event: FeedbackAlertEvent, triageUrl: string): SlackPost | null {
  if (event.kind === 'cluster-formed') {
    // Fires on the THIRD report, not the second: two reports sharing a cause is
    // a coincidence often enough that alerting on it would cry wolf.
    if (event.size < CLUSTER_ALERT_AT) return null
    const body = [
      `${event.size} reports now share one root cause.`,
      event.what,
      event.fleetCount != null ? `${event.fleetCount} ${event.fleetUnit || 'records'} affected.` : null,
      `<${triageUrl}|Open triage>`,
    ].filter(Boolean) as string[]
    return {
      text: `Feedback — a third report landed on the same cause`,
      attachments: [{ color: TONE.attention, fallback: `${event.size} reports share one cause`, text: body.join('\n') }],
    }
  }

  if (event.kind === 'shipped-with-waiters') {
    if (event.waiting < 1) return null
    const body = [
      event.uncertain
        ? `A change shipped that MAY address ${event.waiting} open ${event.waiting === 1 ? 'report' : 'reports'}.`
        : `A change shipped that addresses ${event.waiting} open ${event.waiting === 1 ? 'report' : 'reports'}.`,
      event.what,
      event.uncertain
        ? 'The link is not certain — the drafts hedge, and nothing sends until you send it.'
        : 'Drafts are ready to review. Nothing sends until you send it.',
      `<${triageUrl}|Open triage>`,
    ]
    return {
      text: 'Feedback — someone is waiting on something that just shipped',
      attachments: [{ color: TONE.attention, fallback: `${event.waiting} reports may be answered`, text: body.join('\n') }],
    }
  }

  // The seven-week failure, turned into an alert. An answered item the owner
  // has never opened is not "done" — it is a message that did not arrive.
  if (event.kind === 'unopened-reply') {
    if (event.count < 1 || event.oldestDays < UNOPENED_REPLY_DAYS) return null
    const body = [
      `${event.count} answered ${event.count === 1 ? 'report has' : 'reports have'} never been opened by the person who filed ${event.count === 1 ? 'it' : 'them'}.`,
      `The oldest was answered ${event.oldestDays} days ago.`,
      `<${triageUrl}|Open triage>`,
    ]
    return {
      text: 'Feedback — answers nobody has read',
      attachments: [{ color: TONE.bad, fallback: `${event.count} unopened replies`, text: body.join('\n') }],
    }
  }

  return null
}

/** Every alert worth posting this run. Empty is the ordinary case. */
export function buildAlerts(events: FeedbackAlertEvent[], triageUrl: string): SlackPost[] {
  return (events || [])
    .map(e => buildAlert(e, triageUrl))
    .filter((p): p is SlackPost => !!p)
}
