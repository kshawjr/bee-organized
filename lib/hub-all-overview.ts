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
import {
  deriveClientStatus as deriveClientStatusUntyped,
  enquiryDateOf as enquiryDateOfUntyped,
} from '@/components/hive/shared/clientStatus'
import { WEBFORM_RESUBMISSION_LABEL } from '@/lib/enquiry-exit'
const deriveClientStatus = deriveClientStatusUntyped as (
  person: any, openClientIds: Set<string> | null, nowMs?: number, wonClientIds?: Set<string> | null
) => string
const enquiryDateOf = enquiryDateOfUntyped as (person: any) => string | null
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
  // Inbox rule (2026-09-03): the candidates are ENQUIRIES — website / hand-
  // entered leads (import_source 'manual') plus any lead that filled in the
  // website form again — with NO age bound: an enquiry stays New until an
  // exit, however old. The resubmission touchpoints are read first (a few
  // dozen rows) so the Jobber-client resubmitters can be pulled by id.
  let leadsTrunc = false
  const { rows: resubTouches, truncated: resubTrunc } = await pageAll(
    db, 'touchpoints',
    (q: any) => q.eq('kind', 'system').eq('label', WEBFORM_RESUBMISSION_LABEL),
    CANDIDATE_MAX,
  )
  if (resubTrunc) leadsTrunc = true
  const { rows: manualLeads, truncated: manualTrunc } = await pageAll(
    db, 'leads',
    (q: any) => q.not('is_junk', 'is', true).is('archived_at', null).eq('import_source', 'manual'),
    CANDIDATE_MAX,
  )
  if (manualTrunc) leadsTrunc = true
  const manualIds = new Set(manualLeads.map((l: any) => l.id))
  const resubOnlyIds = Array.from(new Set(resubTouches.map((t: any) => t.lead_id).filter((id: string) => id && !manualIds.has(id))))
  const resubLeads: any[] = []
  for (let i = 0; i < resubOnlyIds.length; i += 200) {
    const { data, error } = await db.from('leads').select('*').not('is_junk', 'is', true).is('archived_at', null).in('id', resubOnlyIds.slice(i, i + 200))
    if (error) { console.error(`[all-overview] resubmitter leads read failed: ${error.message}`); leadsTrunc = true; break }
    resubLeads.push(...(data || []))
  }
  // loc_other rows are the transfer card, not this one — same exclusion the
  // scoped Home applies.
  const candidates = [...manualLeads, ...resubLeads].filter((l: any) => l.location_id !== 'loc_other')
  const candidateIds = candidates.map((l: any) => l.id)

  // Everything the derivation reads — the SAME inputs the hub page ships on a
  // Person, so this count agrees with every location's Inbox: touchpoints
  // (reach-outs + resubmissions), the three Jobber child tables (exit 1),
  // partners (exit 2), and every engagement's stage + closed_at (exit 3 and
  // the won read). A FAILED read does not make the count zero — it makes it
  // WRONG in a specific direction (a missing exit reads as an open enquiry,
  // so the headline inflates) — so each failure marks the overview truncated.
  const touchByLead: Record<string, any[]> = {}
  const srByLead: Record<string, any[]> = {}
  const quotesByLead: Record<string, any[]> = {}
  const jobsByLead: Record<string, any[]> = {}
  const engByLead: Record<string, any[]> = {}
  const networkMoved = new Set<string>()
  let derivationInputsComplete = true
  if (candidateIds.length > 0) {
    const read = async (table: string, col: string, select: string, extra?: (q: any) => any) => {
      const acc: any[] = []
      for (let i = 0; i < candidateIds.length; i += 200) {
        let q = db.from(table).select(select).in(col, candidateIds.slice(i, i + 200))
        if (extra) q = extra(q)
        const { data, error } = await q
        if (error) {
          console.error(`[all-overview] ${table} read failed: ${error.message} — new-lead count would OVER-count; marking truncated`)
          derivationInputsComplete = false
          break
        }
        acc.push(...(data || []))
      }
      return acc
    }
    const [touchRes, srRes, quoteRes, jobRes, partnerRes, engRes] = await Promise.all([
      read('touchpoints', 'lead_id', 'lead_id, kind, label, occurred_at'),
      read('service_requests', 'lead_id', 'lead_id, requested_at, created_at'),
      read('quotes', 'lead_id', 'lead_id, created_at'),
      read('jobs', 'lead_id', 'lead_id, created_at'),
      read('partners', 'customer_lead_id', 'customer_lead_id, is_customer', (q: any) => q.is('deleted_at', null)),
      read('engagements', 'client_id', 'client_id, stage, closed_at, total_paid, total_invoiced'),
    ])
    for (const t of touchRes) (touchByLead[t.lead_id] ||= []).push(t)
    for (const s of srRes) (srByLead[s.lead_id] ||= []).push(s)
    for (const q of quoteRes) (quotesByLead[q.lead_id] ||= []).push(q)
    for (const j of jobRes) (jobsByLead[j.lead_id] ||= []).push(j)
    for (const p of partnerRes) if (p.is_customer !== true && p.customer_lead_id) networkMoved.add(String(p.customer_lead_id))
    for (const e of engRes) (engByLead[e.client_id] ||= []).push(e)
  }

  const { mapLeadToPerson } = await import('@/lib/people-mapper')
  const { rollUpEngagements } = await import('@/lib/engagement-rollup')
  const wonIds = new Set<string>()
  let newCount = 0
  let newOldest = 0
  for (const row of candidates) {
    // Through the REAL mapper and the REAL derivation — not a re-implementation
    // of "what New means". Same joined shape the hub page builds.
    const rollup = rollUpEngagements(engByLead[row.id] || [])
    if (rollup.won_summary) wonIds.add(row.id)
    const person = mapLeadToPerson(row, {
      touchpoints: touchByLead[row.id] || [],
      service_requests: srByLead[row.id] || [],
      quotes: quotesByLead[row.id] || [],
      jobs: jobsByLead[row.id] || [],
      won_summary: rollup.won_summary,
      engagement_count: rollup.engagement_count,
      last_closed_at: rollup.last_closed_at,
      network_moved: networkMoved.has(row.id),
    })
    if (person.isJunk) continue
    if (person.snoozeUntil && new Date(person.snoozeUntil).getTime() > nowMs) continue
    if (person.inboxDismissedAt) continue
    if (deriveClientStatus(person, openIds, nowMs, wonIds) !== 'New') continue
    newCount++
    const age = daysSince(enquiryDateOf(person) || row.created_at, nowMs)
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
