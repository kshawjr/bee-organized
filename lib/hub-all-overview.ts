// lib/hub-all-overview.ts
//
// Fix 2 / Phase 4 — the corporate overview that replaces the people graph on
// 'All Locations'.
//
// THE PROBLEM. 'all' was the last slow path: 7,028 leads + 19,361 child rows +
// 6,065 engagements = 28.57 MB, and the closest thing on the page to Vercel's
// 25s ceiling. It loaded every record so the BROWSER could reduce them to five
// headline numbers.
//
// THE SHAPE OF THE FIX. Every one of those numbers has a working set that is
// bounded by RECENCY or by STATE, not by tenant size (measured 2026-07-23):
//
//     new-uncontacted candidates (created <30d)      206
//     Estimate-stage engagements                      53
//     assessments in the today+1 window                4
//     unpaid invoices issued >30d ago                  8
//     open engagements (the whole board)             292
//
// So the server reduces, and ships numbers. 206 lead rows alone are 391 KB —
// larger than the entire budget for this page — which is exactly why the
// reduction has to happen here and not in the browser.
//
// ── THE RULE THAT KEEPS THIS HONEST ─────────────────────────────────────────
// Every count is computed with the SAME pure functions the scoped Home uses:
// deriveClientStatus for the funnel status, and the shared thresholds module
// for every window. Home-on-'all' and Home-on-a-location therefore agree BY
// CONSTRUCTION rather than by two implementations happening to match. If the
// derivation changes, both move together.
//
// Nothing here is estimated, extrapolated, or sampled. A number that cannot be
// computed exactly is not rendered — see the Home redesign's standing rule.

// clientStatus.js is an untyped pure JS module, so TS infers its
// `wonClientIds = null` default as `null | undefined`. Typed here at the
// boundary rather than cast at the call site, so the arguments stay checked.
import { deriveClientStatus as deriveClientStatusUntyped } from '@/components/hive/shared/clientStatus'
const deriveClientStatus = deriveClientStatusUntyped as (
  person: any, openClientIds: Set<string> | null, nowMs?: number, wonClientIds?: Set<string> | null
) => string
import {
  ESTIMATE_FOLLOWUP_DAYS,
  INVOICE_AGING_DAYS,
  ASSESSMENT_HORIZON_DAYS,
} from '@/components/hive/shared/attentionThresholds'

const DAY_MS = 86400000
const daysSince = (iso: string | null | undefined, now: number): number => {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  if (isNaN(t)) return 0
  return Math.floor((now - t) / DAY_MS)
}

// Candidate ceilings. These are guards against a pathological tenant, not data
// policy — at present the largest is 206 against a 2,000 ceiling. Hitting one
// is logged loudly rather than silently truncating a headline number, which is
// the failure mode this whole effort exists to retire.
const CANDIDATE_MAX = 2000
const ASSESSMENT_LIST_MAX = 50

export type AllOverview = {
  newUncontacted: { count: number; oldestDays: number }
  estimateFollowUps: { count: number; oldestDays: number }
  upcomingAssessments: Array<{ id: string; scheduled_at: string; client: string }>
  agingInvoices: { count: number; total: number; oldestDays: number }
  openEngagementsCount: number
  activeClientsCount: number
  newThisWeekCount: number
  outstandingTotal: number
  leadCount: number
  // True when a candidate ceiling was hit — the client renders a truncation
  // notice rather than presenting a short number as complete.
  truncated: boolean
}

// Page a filtered select without the caller worrying about PostgREST's 1000-row
// response cap. `cap` bounds total rows read.
async function pageAll(
  db: any,
  table: string,
  build: (q: any) => any,
  cap: number,
): Promise<{ rows: any[]; truncated: boolean }> {
  const PAGE = 1000
  const rows: any[] = []
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await build(db.from(table).select('*'))
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error(`[all-overview] ${table} read failed: ${error.message}`)
      return { rows, truncated: true }
    }
    rows.push(...(data || []))
    if ((data || []).length < PAGE) return { rows, truncated: false }
  }
  console.warn(`[all-overview] ${table} hit the ${cap}-row candidate ceiling — overview numbers are UNDER-counted`)
  return { rows, truncated: true }
}

// Build the corporate overview.
//
// `openEngagements` is the board set the caller has already loaded (292 rows) —
// passed in rather than re-queried so the overview and the board can never
// disagree about what is open.
export async function buildAllOverview(
  db: any,
  openEngagements: any[],
  nowMs: number = Date.now(),
): Promise<AllOverview> {
  const since30 = new Date(nowMs - 30 * DAY_MS).toISOString()
  const since7 = new Date(nowMs - 7 * DAY_MS).toISOString()
  const agingBefore = new Date(nowMs - INVOICE_AGING_DAYS * DAY_MS).toISOString()

  const startToday = (() => { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return d })()
  const endHorizon = (() => {
    const d = new Date(nowMs); d.setHours(23, 59, 59, 999)
    d.setDate(d.getDate() + ASSESSMENT_HORIZON_DAYS); return d
  })()

  const openIds = new Set(openEngagements.map((e: any) => e.client_id).filter(Boolean))

  // ── RED · new leads not contacted ────────────────────────────────────────
  // deriveClientStatus returns 'New' only for a lead created <30d ago, so the
  // candidate set is bounded by recency. Everything the derivation reads is
  // fetched for those candidates ONLY: the lead row (email/phone/paid_amount/
  // created_at), their reach-out touchpoints, and whether they have ever won.
  const { rows: recentLeads, truncated: leadsTrunc } = await pageAll(
    db, 'leads',
    (q: any) => q.not('is_junk', 'is', true).gte('created_at', since30),
    CANDIDATE_MAX,
  )
  // loc_other rows are the transfer card, not this one — same exclusion the
  // scoped Home applies.
  const candidates = recentLeads.filter((l: any) => l.location_id !== 'loc_other')
  const candidateIds = candidates.map((l: any) => l.id)

  let touchByLead: Record<string, any[]> = {}
  let wonIds = new Set<string>()
  // A FAILED read here does not make the count zero — it makes it WRONG in a
  // specific direction. With no touchpoints every Attempting lead derives as
  // New, and with no won-lookup every won client does too, so the headline
  // number silently inflates. Both mark the overview truncated so the page
  // says so rather than presenting an inflated count as fact.
  let derivationInputsComplete = true
  if (candidateIds.length > 0) {
    const [touchRes, wonRes] = await Promise.all([
      (async () => {
        const acc: any[] = []
        for (let i = 0; i < candidateIds.length; i += 200) {
          // ⚠️ `kind`, NOT `type`. The COLUMN is touchpoints.kind; the mapper
          // renames it to `type` on the Person-shaped timeline entry, and
          // deriveClientStatus reads that renamed field. Selecting `type` here
          // errors ("column touchpoints.type does not exist"), the accumulator
          // stays empty, and every Attempting lead counts as New — a wrong
          // headline number, not a missing one. Caught by
          // lib/beta-hub-scope-phase4.test.ts.
          const { data, error } = await db.from('touchpoints')
            .select('lead_id, kind, occurred_at')
            .in('lead_id', candidateIds.slice(i, i + 200))
          if (error) {
            console.error(`[all-overview] touchpoints read failed: ${error.message} — new-lead count would OVER-count; marking truncated`)
            derivationInputsComplete = false
            break
          }
          acc.push(...(data || []))
        }
        return acc
      })(),
      (async () => {
        const acc: any[] = []
        for (let i = 0; i < candidateIds.length; i += 200) {
          const { data, error } = await db.from('engagements')
            .select('client_id')
            .eq('stage', 'Closed Won')
            .in('client_id', candidateIds.slice(i, i + 200))
          if (error) {
            console.error(`[all-overview] won lookup failed: ${error.message} — new-lead count would OVER-count; marking truncated`)
            derivationInputsComplete = false
            break
          }
          acc.push(...(data || []))
        }
        return acc
      })(),
    ])
    for (const t of touchRes) (touchByLead[t.lead_id] ||= []).push(t)
    wonIds = new Set(wonRes.map((e: any) => e.client_id))
  }

  const { mapLeadToPerson } = await import('@/lib/people-mapper')
  let newCount = 0
  let newOldest = 0
  for (const row of candidates) {
    // Through the REAL mapper and the REAL derivation — not a re-implementation
    // of "what New means". touchpoints are the only child rows the 'New' branch
    // reads (outreachTimeline), so they are the only ones fetched.
    const person = mapLeadToPerson(row, { touchpoints: touchByLead[row.id] || [] })
    if (person.isJunk) continue
    if (person.snoozeUntil && new Date(person.snoozeUntil).getTime() > nowMs) continue
    if (person.inboxDismissedAt) continue
    if (deriveClientStatus(person, openIds, nowMs, wonIds) !== 'New') continue
    newCount++
    const age = daysSince(row.created_at, nowMs)
    if (age > newOldest) newOldest = age
  }

  // ── RED · estimates awaiting follow-up ───────────────────────────────────
  // Open Estimate-stage engagements whose latest quote was SENT more than
  // ESTIMATE_FOLLOWUP_DAYS ago. Reads the board set the caller already has.
  const estimateEngs = openEngagements.filter((e: any) => e.stage === 'Estimate')
  let estCount = 0
  let estOldest = 0
  for (const e of estimateEngs) {
    const sent = (e.quotes || []).map((q: any) => q.sent_at).filter(Boolean).sort().pop()
    if (!sent) continue
    const age = daysSince(sent, nowMs)
    if (age <= ESTIMATE_FOLLOWUP_DAYS) continue
    estCount++
    if (age > estOldest) estOldest = age
  }

  // ── AMBER · assessments today & tomorrow ─────────────────────────────────
  const upcoming: Array<{ id: string; scheduled_at: string; client: string; when: number }> = []
  for (const e of openEngagements) {
    for (const a of (e.assessments || [])) {
      if (!a.scheduled_at) continue
      const t = new Date(a.scheduled_at).getTime()
      if (isNaN(t) || t < startToday.getTime() || t > endHorizon.getTime()) continue
      upcoming.push({ id: a.id, scheduled_at: a.scheduled_at, client: e.client_name || 'Client', when: t })
    }
  }
  upcoming.sort((a, b) => a.when - b.when)

  // ── AMBER · invoices unpaid & aging ──────────────────────────────────────
  // A SUM is required and PostgREST aggregates are disabled project-wide, so
  // the rows are fetched and reduced here. Bounded by the same filter the card
  // renders: unpaid AND issued more than INVOICE_AGING_DAYS ago (8 rows today).
  const { rows: agingRows, truncated: agingTrunc } = await pageAll(
    db, 'invoices',
    (q: any) => q.gt('balance_owing', 0).lt('issued_at', agingBefore),
    CANDIDATE_MAX,
  )
  let agingTotal = 0
  let agingOldest = 0
  for (const inv of agingRows) {
    const bal = Number(inv.balance_owing)
    if (!(bal > 0)) continue
    agingTotal += bal
    const age = daysSince(inv.issued_at, nowMs)
    if (age > agingOldest) agingOldest = age
  }

  // ── calm metrics ─────────────────────────────────────────────────────────
  // Outstanding is EVERY unpaid balance, not just the aging ones — a different
  // number from agingTotal on purpose, exactly as the scoped Home computes it.
  const { rows: unpaidRows, truncated: unpaidTrunc } = await pageAll(
    db, 'invoices', (q: any) => q.gt('balance_owing', 0), CANDIDATE_MAX,
  )
  const outstandingTotal = unpaidRows.reduce(
    (s: number, i: any) => s + (Number(i.balance_owing) > 0 ? Number(i.balance_owing) : 0), 0)

  const counts = await Promise.all([
    db.from('leads').select('id', { count: 'exact', head: true })
      .not('is_junk', 'is', true).gte('created_at', since7),
    db.from('leads').select('id', { count: 'exact', head: true })
      .not('is_junk', 'is', true),
  ])
  const newThisWeekCount = counts[0]?.count ?? 0
  const leadCount = counts[1]?.count ?? 0

  return {
    newUncontacted: { count: newCount, oldestDays: newOldest },
    estimateFollowUps: { count: estCount, oldestDays: estOldest },
    upcomingAssessments: upcoming.slice(0, ASSESSMENT_LIST_MAX)
      .map(({ id, scheduled_at, client }) => ({ id, scheduled_at, client })),
    agingInvoices: { count: agingRows.length, total: agingTotal, oldestDays: agingOldest },
    openEngagementsCount: openEngagements.length,
    // Distinct clients with an open engagement — a PEOPLE count derived from
    // the engagement set, so it needs no people graph. Matches the scoped
    // Home's definition (one repeat client with two open deals = one active
    // client, two open engagements).
    activeClientsCount: openIds.size,
    newThisWeekCount,
    outstandingTotal,
    leadCount,
    truncated: leadsTrunc || agingTrunc || unpaidTrunc || !derivationInputsComplete,
  }
}
