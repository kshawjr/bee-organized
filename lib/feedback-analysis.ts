// lib/feedback-analysis.ts
//
// Per-item analysis: what is probably wrong, how much of the fleet it touches,
// and roughly how big the work is. Issue 307 step 3.
//
// ─── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────
// Issue 248 step 2 matches an owner's WORDS against docs/screen-map.json and
// says WHERE a report probably lives. That matcher is not rebuilt or replaced
// here; it still runs, and its shortlist is still the fallback. This module
// runs BEFORE it and answers a different question — WHAT is broken — using
// production state rather than vocabulary.
//
// ─── WHY PROBES, AND NOT A GENERAL ANALYSER ───────────────────────────
// This design is the direct output of running the analysis BY HAND on five
// real open items before any of it was written. The finding was that the
// analysis beats the shortlist decisively — and that the thing which made it
// beat the shortlist was never a template. Each item needed a different lookup
// chosen by a reader: one needed four functions traced across three files, one
// needed a count of what was ABSENT from a send log, one needed two named
// clients resolved.
//
// A generic analyser over that shape produces confident prose with nothing
// underneath it, which is the exact failure this step must not ship. So the
// automatable part is factored out honestly:
//
//   A PROBE IS A DIAGNOSIS SOMEONE ALREADY MADE, WRITTEN DOWN ONCE.
//
// Each probe recognises ONE known shape in production state, names the files
// it lives in, and carries its own fleet query. It fires only on evidence, it
// never guesses, and an item no probe recognises gets silence plus the step-2
// shortlist — never a manufactured paragraph.
//
// That makes the system ACCUMULATIVE rather than clever: every bug diagnosed
// by hand becomes a probe, and the next report of the same shape is answered
// for free, with a fleet count attached. The two probes here were both
// diagnosed by hand this week and both cover live reports.
//
// ─── THE HONESTY RULE IS THE RETURN TYPE ──────────────────────────────
// A confident wrong analysis is worse than none: it sends the reader to the
// wrong file AND leaves them with a wrong mental model, which survives being
// corrected. So, exactly as the placement matcher does, "cannot analyse this"
// is a first-class result the caller cannot accidentally read a file path out
// of — and a fleet count exists ONLY where one was actually computed. There is
// no default, no estimate, and no zero standing in for "we did not look".

import type { PlacementIndex, Placement } from './feedback-placement'
import { placeFeedbackItem } from './feedback-placement'

// ─── The shapes ───────────────────────────────────────────────────────

export type AnalysisConfidence = 'confident' | 'likely' | 'none'

/** A production count, present ONLY when a probe actually computed one. */
export interface FleetImpact {
  count: number
  /** What is being counted — "engagements", "returning clients". */
  unit: string
  /** How the count was derived, so the reader can audit it in one line. */
  basis: string
}

export interface ItemAnalysis {
  itemId: string
  /**
   * THE ROOT-CAUSE KEY, and the thing clustering groups on. Two items share a
   * cluster when the same probe fired on both — i.e. when they were shown to
   * have the same mechanism, not when they used the same words. Null when no
   * probe fired, and a null NEVER clusters.
   */
  probe: string | null
  confidence: AnalysisConfidence
  /** What is probably wrong, in one or two sentences. Empty when confidence is none. */
  what: string
  /** Where it lives. Empty when nothing was established. */
  files: string[]
  /** Only when computed. Null is the normal case and must stay cheap to render. */
  fleet: FleetImpact | null
  /** Size, never hours — "small · one surface". Null when undiagnosed. */
  size: string | null
  /** What to ask the owner. Present exactly when confidence is 'none'. */
  question: string | null
  /** The step-2 shortlist, carried through untouched when it has something to add. */
  placement: Placement | null
}

// ─── Evidence ─────────────────────────────────────────────────────────
//
// Everything a probe is allowed to look at. Gathered server-side by the route
// (which owns the database) and passed in, so every probe stays pure and is
// testable against a literal. A probe that wants a new fact adds a field here
// and the route learns to fill it — it may never reach for a client itself.

export interface EngagementEvidence {
  id: string
  stage: string | null
  /** Counts by child kind, and the two flags the stuck-shape turns on. */
  jobCount: number
  archivedJobCount: number
  quoteCount: number
  invoiceCount: number
  paidInvoiceCount: number
}

export interface NamedLeadEvidence {
  /** The name as it appeared in the report. */
  query: string
  found: boolean
  id?: string
  name?: string
  /** Open engagements that are ALL at 'Request' — the returning-client shape. */
  openIsRequestOnly?: boolean
  /** Has at least one Closed Won/Lost engagement — i.e. this is a return visit. */
  hasPriorClosed?: boolean
}

export interface LocationSendEvidence {
  /** Every email_kind this location has ever sent, with counts. */
  kinds: Record<string, number>
  /** Of those, how many were client-facing rather than staff notifications. */
  clientFacingCount: number
}

export interface AnalysisEvidence {
  /** The engagement named by the item's issue-249 context, if it had one. */
  engagement?: EngagementEvidence | null
  /** Leads matching capitalised names found in the description. */
  namedLeads?: NamedLeadEvidence[]
  /** The submitting location's outbound-email history. */
  locationSends?: LocationSendEvidence | null
  /** Fleet counts, computed once for the whole run and shared by every probe. */
  fleet?: Partial<Record<string, FleetImpact>>
}

export interface AnalysisItem {
  id: string
  type?: string | null
  title?: string | null
  description?: string | null
  status?: string | null
  context?: { kind?: string; stage?: string; engagement_id?: string; lead_id?: string } | null
}

// ─── Probes ───────────────────────────────────────────────────────────
//
// Each returns a partial analysis or null. Order matters only in that the
// first firing probe wins; they are written to be mutually exclusive on real
// data, and the tie is broken by declaration order.

type ProbeResult = Omit<ItemAnalysis, 'itemId' | 'placement' | 'probe'> & { probe: string }
type Probe = {
  key: string
  run: (item: AnalysisItem, ev: AnalysisEvidence) => ProbeResult | null
}

const text = (item: AnalysisItem) =>
  `${item.title || ''} ${item.description || ''}`.toLowerCase()

// ── PROBE 1 — an engagement parked at Final Processing with no way out.
//
// Diagnosed by hand from "Mario is closed out and paid." (three days old, and
// twenty-eight characters of which twelve are a name — the word matcher
// returns nothing at all on it, correctly).
//
// THE MECHANISM, traced rather than guessed:
//   · the engagement has a job whose status is 'archived'
//   · jobUnbooked() tests membership of {unscheduled, action_required,
//     on_hold} — 'archived' is not in it, so the job counts as BOOKED
//   · engagementJobDone() wants completed_at, or a status containing
//     "complet" — 'archived' has neither, so the job counts as NOT DONE
//   · so a re-derivation returns 'Job in Progress' (rank 2), and the caller's
//     forward-only rank guard refuses to move it back from the stored 'Final
//     Processing' (rank 3). The stage is frozen.
//   · meanwhile the panel's Mark-won button is gated on canCloseWon =
//     Final Processing AND invoicesFullyPaid(), and invoicesFullyPaid()
//     requires at least one invoice. With none, it can never be true.
//
// Neither direction has an exit. That is why it is stuck rather than merely
// slow, and it is the reason this probe reports 'confident' on evidence alone.
const stuckFinalProcessing: Probe = {
  key: 'stuck-final-processing',
  run: (_item, ev) => {
    const e = ev.engagement
    if (!e) return null
    if (e.stage !== 'Final Processing') return null
    // The exit is invoicesFullyPaid: ≥1 invoice AND all of them paid.
    const canEverCloseWon = e.invoiceCount > 0 && e.paidInvoiceCount === e.invoiceCount
    if (canEverCloseWon) return null
    if (e.archivedJobCount === 0) return null
    return {
      probe: 'stuck-final-processing',
      confidence: 'confident',
      what:
        'The engagement is frozen at Final Processing with no exit in either direction. ' +
        'Its job is archived in Jobber, and an archived job is neither "unbooked" (jobUnbooked tests only ' +
        'unscheduled/action_required/on_hold) nor "done" (engagementJobDone wants completed_at or a status ' +
        'containing "complet"), so a re-derive yields Job in Progress — a LOWER rank, which the forward-only ' +
        'guard refuses. Mark won cannot render either: canCloseWon needs invoicesFullyPaid, which requires at ' +
        'least one invoice, and there are none.',
      files: [
        'lib/engagements.ts:105  (jobUnbooked — archived is not an unbooked status)',
        'lib/engagements.ts:94   (engagementJobDone — archived is not done)',
        'lib/engagements.ts:156  (the bookedJobs branch that lands on Final Processing)',
        'components/hive/EngagementPanel.jsx:462  (canCloseWon)',
        'components/hive/shared/engagementStatus.js:121  (invoicesFullyPaid — needs ≥1 invoice)',
      ],
      fleet: ev.fleet?.['stuck-final-processing'] || null,
      size: 'medium · the stage deriver plus the panel close gate',
      question: null,
    }
  },
}

// ── PROBE 2 — a returning client vanishes from the Inbox.
//
// Diagnosed by hand from four separate reports that share no distinctive
// vocabulary: "Returning client - request showing as Engagement not New",
// two auto-titled "Problem with Engagement", and "Nuturing 2" — which never
// says "returning" or "request" at all and would be clustered by word
// similarity onto the unrelated "Nuturing".
//
// THE MECHANISM: OPENING_STAGE.request and OPENING_STAGE.manual are BOTH
// 'Request', so a returning client's new enquiry founds an engagement at
// Request. deriveClientStatus returns 'Active' for anyone with ANY open
// engagement, before age or nurturing is considered — so the person leaves the
// Inbox the moment the engagement exists.
//
// This is an unmade product decision rather than a defect, and the analysis
// says so: nothing here is behaving other than as written.
const returningClientOutOfInbox: Probe = {
  key: 'returning-client-request-stage',
  run: (item, ev) => {
    const e = ev.engagement
    const named = (ev.namedLeads || []).find(n => n.found && n.openIsRequestOnly && n.hasPriorClosed)
    // Either the item points AT such an engagement, or it names such a client.
    const viaContext = !!e && e.stage === 'Request'
    if (!viaContext && !named) return null
    // A context-only hit needs the report to be about placement, not about the
    // deal itself — otherwise every Request-stage engagement report matches.
    const t = text(item)
    const saysPlacement = /\b(new|inbox|request|engagement|nurtur|nuturing|assessment|bucket|column|tab)\b/.test(t)
    if (!named && !saysPlacement) return null
    return {
      probe: 'returning-client-request-stage',
      confidence: named ? 'confident' : 'likely',
      what:
        'A returning client\'s new enquiry founds an engagement at stage Request (OPENING_STAGE.request and ' +
        '.manual are both \'Request\'), and deriveClientStatus returns \'Active\' for anyone with ANY open ' +
        'engagement — before age or nurturing is considered. So the person leaves the Inbox as soon as the ' +
        'engagement exists. Nothing is misbehaving: this is an unmade product decision about whether a repeat ' +
        'enquiry should re-enter the Inbox.' +
        (named ? ` Checked: ${named.name} has an open Request-stage engagement and at least one prior closed one.` : ''),
      files: [
        'lib/engagements.ts:49   (OPENING_STAGE — request and manual are both Request)',
        'components/hive/shared/clientStatus.js:64  (any open engagement wins → Active)',
      ],
      fleet: ev.fleet?.['returning-client-request-stage'] || null,
      size: 'medium · a product decision first, then the Inbox predicate',
      question: null,
    }
  },
}

// ── PROBE 3 — "an email went out that I never wrote".
//
// Diagnosed by hand from "Client was pushed an appreciation email that I never
// created". The word matcher placed this CONFIDENTLY WRONG on Settings →
// Location, pulled there by the word "business" in "their recent business".
//
// The evidence that settles it is an ABSENCE: the location's entire
// outbound-email history. Carmel has only ever sent staff-facing lead
// notifications — zero client-facing sends of any kind, ever — so the email
// the owner received cannot have come from here. Jobber sends its own client
// mail (job completion, invoice notices, review requests), which is what the
// description actually describes.
//
// Fires only when the log is genuinely empty of client-facing sends. If the
// location HAS sent client mail, this probe stays silent rather than
// speculating about which template it was.
const notSentByHub: Probe = {
  key: 'not-sent-by-hub',
  run: (item, ev) => {
    const sends = ev.locationSends
    if (!sends) return null
    const t = text(item)
    const isUnexpectedEmail =
      /\b(email|newsletter|campaign)\b/.test(t) &&
      /(never created|didn'?t create|did not create|never wrote|didn'?t send|did not send|never set up|i never)/.test(t)
    if (!isUnexpectedEmail) return null
    if (sends.clientFacingCount > 0) return null
    return {
      probe: 'not-sent-by-hub',
      confidence: 'confident',
      what:
        'Bee Hub did not send this. The location has no client-facing send on record — its entire outbound ' +
        'history is staff notifications (' +
        Object.entries(sends.kinds).map(([k, n]) => `${k || 'unlabelled'} ${n}`).join(', ') +
        '), and every client-facing rail writes to notification_log by construction. The mail almost certainly ' +
        'came from Jobber, which sends its own job-completion, invoice and review-request mail. Answer the ' +
        'owner; there is no file to open here.',
      files: [],
      fleet: null,
      size: 'none · answer the owner, no code change',
      question: null,
    }
  },
}

// ── PROBE 4 — the client they are asking about does not exist.
//
// Diagnosed by hand from "Missing clients" (Laura Laundermilk, filed eighteen
// days ago). Confirming an ABSENCE is worth real time: it converts "go and
// search for a while" into "she is not here, this is a migration question".
//
// NO FLEET COUNT, on purpose. What is missing cannot be counted from inside
// the system that is missing it — the other side of the migration is not here
// to compare against — and a number invented for the sake of having one is
// exactly what the honesty rule forbids.
const clientNotFound: Probe = {
  key: 'named-client-not-found',
  run: (item, ev) => {
    const named = ev.namedLeads || []
    if (named.length === 0) return null
    const missing = named.filter(n => !n.found)
    // Every name in the report has to be missing. One found and one missing is
    // an ambiguous report, not a migration gap.
    if (missing.length === 0 || missing.length !== named.length) return null
    const t = text(item)
    if (!/(missing|isn'?t showing|is not showing|not showing up|can'?t find|cannot find|didn'?t come over|did not come over|moved over)/.test(t)) return null
    return {
      probe: 'named-client-not-found',
      confidence: 'likely',
      what:
        `Checked: ${missing.map(m => m.query).join(', ')} — no lead of that name exists in the database at all. ` +
        'So this is not a display or filter problem; the record was never created here. The owner is really asking ' +
        'about migration scope — which old-CRM records came across — which is a question to answer rather than a ' +
        'bug to fix.',
      files: [],
      fleet: null,
      size: 'none · a migration-scope answer, not a code change',
      question: null,
    }
  },
}

const PROBES: Probe[] = [
  stuckFinalProcessing,
  returningClientOutOfInbox,
  notSentByHub,
  clientNotFound,
]

export const PROBE_KEYS = PROBES.map(p => p.key)

// ─── Analysing one item ───────────────────────────────────────────────

export interface AnalyseInput {
  item: AnalysisItem
  evidence: AnalysisEvidence
  /** The step-2 map. Optional: without it the shortlist is simply absent. */
  index?: PlacementIndex | null
}

export function analyseItem({ item, evidence, index = null }: AnalyseInput): ItemAnalysis {
  for (const probe of PROBES) {
    const hit = probe.run(item, evidence)
    if (hit) {
      return {
        itemId: item.id,
        ...hit,
        // The shortlist rides along even on a hit — it costs nothing and the
        // probe names files by mechanism, which is a different axis from the
        // surface an owner was looking at.
        placement: index ? placeFeedbackItem(item as any, index) : null,
      }
    }
  }

  // NOTHING FIRED. This is the ordinary case and it must stay honest: no
  // manufactured paragraph, no invented count, no file path. The step-2
  // shortlist is carried through because narrowing WHERE is still worth
  // something, and the question tells Kevin this one needs him to go and ask.
  return {
    itemId: item.id,
    probe: null,
    confidence: 'none',
    what: '',
    files: [],
    fleet: null,
    size: null,
    question: 'Not enough to place — needs a follow-up question to the owner.',
    placement: index ? placeFeedbackItem(item as any, index) : null,
  }
}

// ─── Clustering ───────────────────────────────────────────────────────
//
// ON ROOT CAUSE, NEVER ON WORDS. The hand run produced the decisive case:
// "Nuturing" and "Nuturing 2" share a distinctive rare word and are DIFFERENT
// problems (one wants a bulk status change that the derivation makes
// impossible; the other is a returning client leaving the Inbox). Meanwhile
// "Nuturing 2" belongs with three reports it shares no distinctive vocabulary
// with at all. Any lexical clustering gets both of those backwards.
//
// A null probe never clusters — "we could not analyse these" is not a shared
// root cause, and grouping the unanalysed together would manufacture exactly
// the false pattern this step exists to avoid. Singletons are not clusters
// either: a group of one adds a heading and no information.

export interface AnalysisCluster {
  probe: string
  itemIds: string[]
  /** Shared by construction — every member fired the same probe. */
  what: string
  fleet: FleetImpact | null
}

export function clusterAnalyses(analyses: ItemAnalysis[]): AnalysisCluster[] {
  const byProbe = new Map<string, ItemAnalysis[]>()
  for (const a of analyses) {
    if (!a.probe) continue
    const list = byProbe.get(a.probe)
    if (list) list.push(a)
    else byProbe.set(a.probe, [a])
  }
  const out: AnalysisCluster[] = []
  for (const [probe, list] of Array.from(byProbe.entries())) {
    if (list.length < 2) continue
    out.push({
      probe,
      itemIds: list.map(a => a.itemId),
      what: list[0].what,
      fleet: list.find(a => a.fleet)?.fleet || null,
    })
  }
  // Biggest first — a cluster of four is a bigger fact than a cluster of two.
  return out.sort((a, b) => b.itemIds.length - a.itemIds.length)
}

// ─── Named entities ───────────────────────────────────────────────────
//
// Capitalised word pairs in a description — "Laura Laundermilk", "Diane
// Stern". Deliberately crude, and safe because of what it is used FOR: a name
// matching nothing is simply not evidence, and a false positive costs one
// wasted lookup rather than a wrong analysis. Sentence-initial words are the
// main noise source, so a pair is taken only when both words are capitalised
// and neither is a common opener or a word from our own vocabulary.
//
// Lives here rather than in the route because it is pure and worth testing;
// a Next.js route file may only export handlers and framework config.
const NOT_A_NAME = new Set([
  'I', 'The', 'This', 'That', 'She', 'He', 'They', 'We', 'It', 'My', 'Our', 'Her', 'His',
  'When', 'Where', 'What', 'Why', 'How', 'Is', 'Are', 'Did', 'Do', 'Does', 'Can', 'Could',
  'Would', 'Should', 'Since', 'Client', 'Clients', 'Bee', 'Hub', 'Jobber', 'Zoho', 'CRM',
  'Awaiting', 'Response', 'New', 'Request', 'Engagement', 'Final', 'Processing', 'Closed',
])

export function extractNames(description: string | null | undefined): string[] {
  const out: string[] = []
  const re = /\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(String(description || '')))) {
    if (NOT_A_NAME.has(m[1]) || NOT_A_NAME.has(m[2])) continue
    const full = `${m[1]} ${m[2]}`
    if (!out.includes(full)) out.push(full)
  }
  // Capped: three lookups per item is plenty, and an unbounded list would let
  // one chatty report drive the whole run's query count.
  return out.slice(0, 3)
}

// ─── Cache signature ──────────────────────────────────────────────────
//
// WHAT INVALIDATES THE CACHE. The analysis is a pure function of the open item
// set and the production state the probes read. Item changes are the fast-
// moving half — one audit pass closed twenty items in an evening — so the
// signature is built from the ids and updated_at of the items analysed. Any
// status change, any reply, any new arrival moves an updated_at (the
// feedback_items_updated_at trigger guarantees it) and the signature changes,
// so the next open recomputes.
//
// Production state is the slow-moving half and is NOT in the signature: a
// fleet count drifting by one engagement overnight does not justify
// recomputing on every open. The TTL covers it.
export function analysisSignature(
  items: Array<{ id: string; updated_at?: string | null; status?: string | null }>,
): string {
  return (items || [])
    .map(i => `${i.id}:${i.updated_at || ''}:${i.status || ''}`)
    .sort()
    .join('|')
}
