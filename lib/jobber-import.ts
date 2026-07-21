// lib/jobber-import.ts
// ─────────────────────────────────────────────────────────────
// Shared Jobber→Supabase upsert helpers used by:
//   - app/api/import/jobber-clients/route.ts  (bulk import)
//   - app/api/webhooks/jobber/route.ts        (real-time inbound)
//
// Originally lived inline in the import route. Extracted so webhook
// handlers can run a single record through the same code paths
// (record shape, ID extraction, stage classification, promotion
// guards) without duplicating the logic.
//
// Stage classification (see determineStage) — returns canonical Bee Hub
// stage values matching components/BeeHub.jsx STAGES array:
//   'Final Processing' (has invoice)
//   'Job in Progress'  (has job)
//   'Estimate Sent'    (has quote)
//   'Request'          (has assessment, no quote yet)
//   'Nurturing'        (no downstream activity AND createdAt > 30 days)
//   'New'              (default — fresh request, no other activity)
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { getPrimaryOwnerForLocation } from './owner-resolution'
import { writeSyncLog } from './sync-log'
import {
  queryLeadMatches,
  classifyLeadMatches,
} from '@/components/hive/shared/clientMatch'

// ── GraphQL: bulk pagination queries (used by the import route) ────

export const CLIENTS_QUERY = `
  query GetClients($after: String) {
    clients(first: 50, after: $after) {
      nodes {
        id firstName lastName companyName createdAt
        emails { address primary }
        phones  { number  primary }
        billingAddress { street city province postalCode }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

// Incremental variant — fetches only clients created/updated after a given timestamp.
// Used as a second pass to catch records Jobber may not surface in the sorted full-scan.
// filter.createdAt.greaterThan catches brand-new clients; updatedAt catches edits to existing.
export const INCREMENTAL_CLIENTS_QUERY = `
  query GetRecentClients($after: String, $since: ISO8601DateTime!) {
    clients(first: 50, after: $after, filter: { updatedAt: { greaterThan: $since } }) {
      nodes {
        id firstName lastName companyName createdAt
        emails { address primary }
        phones  { number  primary }
        billingAddress { street city province postalCode }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const REQUESTS_QUERY = `
  query GetRequests($after: String) {
    requests(first: 50, after: $after) {
      nodes {
        id createdAt jobberWebUri
        client { id }
        assessment { id startAt duration isComplete completedAt }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

// client{id} rides alongside request{id} so requestless quotes (created
// directly on a client, no service request) can be joined by client —
// without it they fetch, stage, and then silently drop in the import's
// request-keyed join (the requestless-import gap).
export const QUOTES_QUERY = `
  query GetQuotes($after: String) {
    quotes(first: 50, after: $after) {
      nodes {
        id createdAt jobberWebUri
        request { id }
        client { id }
        amounts { subtotal taxAmount discountAmount total }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

// Nested invoices carry their own pageInfo: a job can exceed the nested
// `first` (recurring/installment billing — prod has jobs at 10+), and a
// capped fetch silently drops invoice 11+ from the import. The import
// route drains hasNextPage jobs via JOB_INVOICES_QUERY before staging.
export const JOBS_QUERY = `
  query GetJobs($after: String) {
    jobs(first: 50, after: $after) {
      nodes {
        id createdAt jobberWebUri title jobStatus startAt completedAt total
        request { id }
        quote { id }
        client { id }
        invoices(first: 10) {
          nodes {
            id createdAt jobberWebUri invoiceStatus
            amounts { subtotal taxAmount discountAmount total }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

// Continuation pages for one job's invoices (see JOBS_QUERY comment).
export const JOB_INVOICES_QUERY = `
  query GetJobInvoices($id: EncodedId!, $after: String) {
    job(id: $id) {
      invoices(first: 50, after: $after) {
        nodes {
          id createdAt jobberWebUri invoiceStatus
          amounts { subtotal taxAmount discountAmount total }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

// ── GraphQL: single-record queries (used by webhook handlers) ──────
// Mirror the shapes of the bulk queries so the same upsert functions
// can consume the result without per-source mapping.

export const SINGLE_CLIENT_QUERY = `
  query GetClient($id: EncodedId!) {
    client(id: $id) {
      id firstName lastName companyName createdAt
      emails { address primary }
      phones  { number  primary }
      billingAddress { street city province postalCode }
    }
  }
`

export const SINGLE_REQUEST_QUERY = `
  query GetRequest($id: EncodedId!) {
    request(id: $id) {
      id createdAt jobberWebUri
      client { id firstName lastName companyName createdAt
               emails { address primary }
               phones  { number  primary }
               billingAddress { street city province postalCode } }
      assessment { id startAt duration isComplete completedAt }
      quotes(first: 5) { nodes { id } }
      jobs(first: 5)   { nodes { id invoices(first: 5) { nodes { id } } } }
    }
  }
`

export const SINGLE_QUOTE_QUERY = `
  query GetQuote($id: EncodedId!) {
    quote(id: $id) {
      id createdAt jobberWebUri quoteStatus
      request { id client { id } }
      client { id }
      amounts { subtotal taxAmount discountAmount total }
    }
  }
`

// Nested invoices here are shape-mirroring only — no webhook handler
// consumes them for upserts (invoice rows arrive one-at-a-time via the
// INVOICE_* topics / SINGLE_INVOICE_QUERY), so the `first: 10` cap does
// not drop data on this path. If a consumer is ever added, drain with
// JOB_INVOICES_QUERY like the bulk import does.
export const SINGLE_JOB_QUERY = `
  query GetJob($id: EncodedId!) {
    job(id: $id) {
      id createdAt jobberWebUri title jobStatus startAt completedAt total
      request { id client { id } }
      quote { id }
      client { id }
      invoices(first: 10) {
        nodes {
          id createdAt jobberWebUri invoiceStatus
          amounts { subtotal taxAmount discountAmount total }
        }
      }
    }
  }
`

// paymentRecords + paymentsTotal/tipsTotal/invoiceBalance are selected ONLY
// here (the webhook single-invoice path — the one a live payment travels).
// The bulk-import invoice queries above deliberately still omit them: adding
// them there is part of the not-yet-taken backfill decision, and upsertInvoice
// falls back to createdAt when they're absent, exactly as before.
export const SINGLE_INVOICE_QUERY = `
  query GetInvoice($id: EncodedId!) {
    invoice(id: $id) {
      id createdAt jobberWebUri invoiceStatus
      amounts { subtotal taxAmount discountAmount total paymentsTotal tipsTotal invoiceBalance }
      client { id }
      jobs(first: 5) { nodes { id request { id } } }
      paymentRecords(first: 50) { nodes { amount entryDate tipAmount adjustmentType } }
    }
  }
`

export const SINGLE_PROPERTY_QUERY = `
  query GetProperty($id: EncodedId!) {
    property(id: $id) {
      id
      address { street city province postalCode }
      client { id }
    }
  }
`

// Fetches the remaining invoice pages for a job whose nested connection
// reports hasNextPage, appending them to jobNode.invoices.nodes in place.
// runQuery abstracts the caller's executor (the import route passes a
// jobberQueryThrottled wrapper). Fail-loud on errors: a partial drain
// staged silently would be the exact data loss this exists to prevent.
export async function drainJobInvoices(
  runQuery: (query: string, variables: Record<string, any>) => Promise<{ data?: any; errors?: any[] }>,
  jobNode: any,
): Promise<void> {
  let pageInfo = jobNode?.invoices?.pageInfo
  while (pageInfo?.hasNextPage) {
    const res = await runQuery(JOB_INVOICES_QUERY, { id: jobNode.id, after: pageInfo.endCursor })
    if (res.errors?.length) {
      throw new Error(`job_invoices error (job ${jobNode.id}): ${JSON.stringify(res.errors)}`)
    }
    // Job deleted between the page fetch and the drain — nothing to keep.
    if (!res.data?.job) break
    const conn = res.data.job.invoices
    jobNode.invoices.nodes.push(...(conn?.nodes || []))
    pageInfo = conn?.pageInfo
    jobNode.invoices.pageInfo = pageInfo
  }
}

// ── constants ─────────────────────────────────────────────────────

// Jobber jobStatus → jobs.status. Anything unmapped lands as 'unknown'
// (and now writes an error sync_log row — see upsertJob). Keep in sync
// with the port in scripts/backfill-requestless.mjs.
//
// Exhaustive over JobStatusTypeEnum (introspected live 2026-07-10,
// X-JOBBER-GRAPHQL-VERSION 2025-04-16). Jobber's own descriptions:
//   active                   "jobs in progress (the job is not closed)"        → BOOKED
//   late                     "visit passed but was not marked complete"        → BOOKED
//   today                    "active jobs with a visit today"                  → BOOKED
//   upcoming                 "active jobs with a visit in the future"          → BOOKED
//   expiring_within_30_days  "active jobs that are expiring within 30 days"    → BOOKED
//   unscheduled              "visits created, set up to be scheduled later"    → UNBOOKED
//   action_required          "still active, but no more upcoming visits — like
//                            being 'on hold'; a prompt to either schedule more
//                            visits or close the job"                          → UNBOOKED
//   on_hold                  (Jobber's own alias for action_required)          → UNBOOKED
//   requires_invoicing       "overdue invoice reminder — create an invoice"    → work done
//   archived                 "closed jobs you are done with"                   → closed
// COMPLETED is not in the current enum — kept defensively for older
// webhook payloads/API versions (completedAt is the real done signal).
export const JOB_STATUS: Record<string, string> = {
  ACTIVE: 'in_progress', COMPLETED: 'completed',
  REQUIRES_INVOICING: 'completed', LATE: 'late',
  TODAY: 'today', UPCOMING: 'upcoming', ARCHIVED: 'archived',
  UNSCHEDULED: 'unscheduled',
  ACTION_REQUIRED: 'action_required', ON_HOLD: 'on_hold',
  EXPIRING_WITHIN_30_DAYS: 'in_progress',
}

// Unbooked job statuses: nothing on the calendar, nothing underway —
// UNSCHEDULED (visits to be scheduled later), ACTION_REQUIRED (no more
// upcoming visits; Jobber: "you can think of action required like being
// 'on hold' … a prompt to either schedule more visits or close the job"),
// and ON_HOLD (Jobber's alias for the same state). Unbooked work is NOT
// current work: stage derivation treats it like a quote of the same age
// (fresh → live deal, aged → Nurturing / backfill stale-close) instead of
// 'Job in Progress'; before these entries such jobs fell to 'unknown' and
// pinned their lead at Job in Progress forever (Tami Wollner's dormant
// unscheduled job; Wendy Blanch's 2024 action_required job). Matches both
// the raw Jobber value and the mapped DB value (same word, case aside).
// completedAt/completed_at on the row wins over the label — callers guard
// that side.
const UNBOOKED_JOB_STATUSES = new Set(['unscheduled', 'action_required', 'on_hold'])
export const isUnbookedJobStatus = (status: string | null | undefined): boolean =>
  UNBOOKED_JOB_STATUSES.has((status || '').toLowerCase())

// Raw Jobber jobStatus values that mean the job is booked or underway —
// the only statuses that may promote a lead to 'Job in Progress' on the
// webhook path (JOB_CREATE/JOB_UPDATE in jobber-webhook-handlers.ts).
export const BOOKED_JOB_STATUSES = new Set(['ACTIVE', 'TODAY', 'UPCOMING', 'LATE', 'EXPIRING_WITHIN_30_DAYS'])

export const NURTURING_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

// Stage ranking for forward-progress check during stage promotion.
// Higher rank = further along the funnel. Used so an older record
// upserted later doesn't drag a Lead back from Final Processing to New.
// Webhook handlers also use this for forward-only stage promotion.
//
// These 9 values are canonical — they must match VALID_STAGES in
// /api/leads/route.ts. Webhook topics that don't map to a stage
// transition (QUOTE_APPROVED, JOB_CREATE, INVOICE_*) keep the lead's
// existing stage and only stamp event timestamps.
export const STAGE_RANK: Record<string, number> = {
  'New':              0,
  'Nurturing':        1,
  'Attempting':       2,
  'Request':          3,
  'Estimate Sent':    4,
  'Job in Progress':  5,
  'Final Processing': 6,
  'Closed Won':       7,
  'Closed Lost':      7,
}

// ── helpers ───────────────────────────────────────────────────────

// Jobber's GraphQL API returns IDs as base64-encoded global IDs like
// "Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzYxMjM5NzY=" which decodes to
// "gid://Jobber/Client/136123976". We persist the numeric portion.
export function extractJobberId(globalId: string | null | undefined): string | null {
  if (!globalId) return null
  if (/^\d+$/.test(globalId)) return globalId
  try {
    const decoded = Buffer.from(globalId, 'base64').toString('utf8')
    const match = decoded.match(/\/(\d+)$/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// ── resumable write-loop helpers ──────────────────────────────
//
// Both back the segmented, self-continuing write phase of the bulk import.
// Extracted as pure functions so the "resume doesn't double-write" and
// "yield before the Vercel wall" invariants can be unit-tested without
// standing up the whole 800s route.

/**
 * Filter a staged client set down to the ones NOT yet written for this
 * location. Idempotent-resume backbone: a resumed segment re-loads the same
 * staged clients but must skip whatever a prior segment already landed, so it
 * never re-writes (and never double-counts) the already-done prefix. Clients
 * whose Jobber id can't be extracted are treated as unwritten (processed every
 * segment) — the downstream upsert still dedupes them on jobber_client_id.
 */
export function selectUnwrittenClients<T extends { id?: string | null }>(
  clients: T[],
  alreadyWritten: Set<string>,
): T[] {
  return clients.filter((c) => {
    const id = extractJobberId(c.id)
    return id === null || !alreadyWritten.has(id)
  })
}

/**
 * Decide whether the write loop should stop THIS invocation and hand off to
 * the next segment (self-chain / sweeper). Two brakes, checked before each
 * record so we never get hard-killed mid-write at the 800s Vercel wall:
 *   - batch cap:   a fixed ceiling on records per invocation
 *   - time budget: the same wall-clock guard the fetch phase already uses,
 *                  so a heavy chunk (400 nested writes can outrun 800s) yields
 *                  gracefully instead of dying with the mutex still held.
 * The caller reacts to a truthy `stop` by persisting progress, releasing the
 * mutex, and firing selfContinue() — mirroring the batch-cap path exactly.
 */
export function writeLoopShouldYield(
  wroteThisRun: number,
  batchCap: number,
  timeLow: boolean,
): { stop: boolean; reason: string } {
  if (wroteThisRun >= batchCap) return { stop: true, reason: 'batch cap' }
  if (timeLow) return { stop: true, reason: 'time budget' }
  return { stop: false, reason: '' }
}

// The Jobber gid namespaces we round-trip through numeric storage. Every
// jobber_*_id column persists the numeric tail (via extractJobberId), so
// any outbound mutation typed EncodedId! must rebuild the base64 global id
// from that numeric — feeding the bare number is rejected with
// "'<n>' is not a valid EncodedId". User ids are the exception: the roster
// stores them already-encoded, so they never pass through here.
export type JobberIdType =
  | 'Client' | 'Request' | 'Quote' | 'Job' | 'Invoice' | 'Property'
  | 'Assessment' | 'Visit' | 'Appointment' | 'User'

// Inverse of extractJobberId: numeric (or already-encoded) → base64 global
// id. Idempotent — normalizes to numeric first, so an encoded input is
// re-canonicalized rather than double-wrapped (which would resolve to null).
export function encodeJobberId(type: JobberIdType, rawId: string): string {
  const numeric = extractJobberId(rawId) || rawId
  return Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')
}

export type ImportStampResult = { ok: true } | { ok: false; error: string }

// One-time completion gate. The bulk import calls this AFTER every record
// is processed to set locations.jobber_initial_import_completed_at, which is
// what clears the prominent "Start Import" CTA (an unset stamp = the import
// never ran, as far as the UI is concerned).
//
// This MUST fail loud. Supabase's .update() resolves with { error } instead
// of throwing, so a bare `await update(...)` in a try/catch swallows real DB
// failures silently — which is exactly how NW Arkansas landed a genuinely-
// completed import (233/233 clients, 2026-07-09) with no stamp, leaving the
// CTA showing over finished data. Here we inspect the returned error, retry
// once, log the location + job on failure, and hand the caller a result it
// must surface instead of reporting clean success over a failed stamp.
export async function writeImportCompletionStamp(
  locUuid: string,
  opts: { label?: string; stampedAt?: string } = {},
): Promise<ImportStampResult> {
  const label = opts.label ?? locUuid
  let lastError = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { error } = await supabaseService
        .from('locations')
        .update({ jobber_initial_import_completed_at: opts.stampedAt ?? new Date().toISOString() })
        .eq('id', locUuid)
      // .update() reports DB failures via `error`, not by throwing — check it.
      if (error) throw new Error(error.message || JSON.stringify(error))
      return { ok: true }
    } catch (err: any) {
      lastError = String(err?.message || err)
      console.error(
        `[jobber-initial-import STAMP WRITE FAILED] attempt ${attempt}/2 — ${label}: ${lastError}`,
      )
    }
  }
  return { ok: false, error: lastError }
}

export function determineStage(request: any): string {
  if (request._hasInvoice)    return 'Final Processing'
  if (request._hasJob)        return 'Job in Progress'
  if (request._hasQuote)      return 'Estimate Sent'
  if (request._hasAssessment) return 'Request'
  if (request.createdAt) {
    const ageMs = Date.now() - new Date(request.createdAt).getTime()
    if (ageMs > NURTURING_AGE_MS) return 'Nurturing'
  }
  return 'New'
}

// ── lead-level stage classifier (bulk import ONLY) ────────────────
// determineStage above is per-service-request and stays as-is for the
// webhook path (SR rows keep their 'Request' classification). This one
// looks at a client's ENTIRE history and answers "where does this lead
// belong on the board right now" — most recent engagement wins, so a
// new request after an old paid job classifies as 'New', not 'Closed
// Won'. All ages are measured against import time. Returns lead-stage
// strings matching BeeHub's STAGES keys; never returns 'Request'.
export function determineLeadStage(
  bundle: {
    email: string | null
    phone: string | null
    clientCreatedAt: string | null
    requests: any[]   // { createdAt }
    quotes: any[]     // { createdAt }
    jobs: any[]       // { jobStatus, startAt, completedAt, createdAt }
    invoices: any[]   // { invoiceStatus, createdAt }
  },
  nowMs: number = Date.now(),
): { stage: string; isJunk: boolean } {
  const ts = (v: any) => (v ? new Date(v).getTime() : 0)
  const aged = (t: number) => nowMs - t > NURTURING_AGE_MS
  const { email, phone, clientCreatedAt, requests, quotes, jobs, invoices } = bundle

  // 1. Unreachable and nothing to work: no way to contact, no history.
  //    Junked rather than staged — filtered off the board entirely.
  const hasActivity = requests.length > 0 || quotes.length > 0 || jobs.length > 0 || invoices.length > 0
  if (!email && !phone && !hasActivity) return { stage: 'New', isJunk: true }

  // 2. Any job still active/scheduled is current work, full stop.
  //    Unbooked jobs (unscheduled / action_required / on_hold) are
  //    exempt: nothing is booked, so nothing is in progress — they ride
  //    the quote lane below instead. Every other non-completed status,
  //    including unmapped ones, stays conservative: current work.
  const jobDone = (j: any) =>
    !!j.completedAt || (j.jobStatus || '').toLowerCase().includes('complet')
  const jobUnbooked = (j: any) => !jobDone(j) && isUnbookedJobStatus(j.jobStatus)
  if (jobs.some((j) => !jobDone(j) && !jobUnbooked(j))) return { stage: 'Job in Progress', isJunk: false }

  // Most recent engagement wins. Ties (same-timestamp chain events)
  // resolve to the more advanced state: invoice ≥ job ≥ quote ≥ request,
  // via strict > on the earlier-chain comparisons below.
  const isPaid = (i: any) => (i.invoiceStatus || '').toUpperCase() === 'PAID'
  const lastRequest = Math.max(0, ...requests.map((r) => ts(r.createdAt)))
  // Unbooked jobs ride the quote lane: agreed-but-unbooked work is an
  // estimate awaiting a response (fresh → 'Estimate Sent', aged →
  // 'Nurturing'), never job evidence — the job lane falls through to
  // 'Final Processing' (rule 3), which asserts money outstanding that an
  // unbooked job never earned.
  const lastQuote   = Math.max(0, ...quotes.map((q) => ts(q.createdAt)),
                                  ...jobs.filter(jobUnbooked).map((j) => ts(j.createdAt)))
  const lastJob     = Math.max(0, ...jobs.filter((j) => !jobUnbooked(j)).map((j) => Math.max(ts(j.completedAt), ts(j.startAt), ts(j.createdAt))))
  const lastPaid    = Math.max(0, ...invoices.filter(isPaid).map((i) => ts(i.createdAt)))
  const lastUnpaid  = Math.max(0, ...invoices.filter((i) => !isPaid(i)).map((i) => ts(i.createdAt)))
  const head = Math.max(lastRequest, lastQuote, lastJob, lastPaid, lastUnpaid)

  if (head > 0) {
    // 6. Fresh request after (or without) anything else — re-engaged.
    if (lastRequest === head && lastRequest > lastQuote && lastRequest > lastJob && lastRequest > lastPaid && lastRequest > lastUnpaid) {
      return { stage: aged(lastRequest) ? 'Nurturing' : 'New', isJunk: false }
    }
    // 5. Quote sent, nothing after it.
    if (lastQuote === head && lastQuote > lastJob && lastQuote > lastPaid && lastQuote > lastUnpaid) {
      return { stage: aged(lastQuote) ? 'Nurturing' : 'Estimate Sent', isJunk: false }
    }
    // 4. Paid, and nothing pending after the payment.
    if (lastPaid === head && lastPaid >= lastUnpaid) {
      return { stage: 'Closed Won', isJunk: false }
    }
    // 3. Completed job with an unpaid or missing invoice — money outstanding.
    return { stage: 'Final Processing', isJunk: false }
  }

  // 7. Bare contact — reachable but no activity ever. Age by client
  //    creation; unknown createdAt is treated as old (Nurturing).
  const created = ts(clientCreatedAt)
  return { stage: created && !aged(created) ? 'New' : 'Nurturing', isJunk: false }
}

// ── upserts ───────────────────────────────────────────────────────

// ── adoption pass: website lead ↔ Jobber client reconciliation ─────
// A person can arrive through BOTH doors: a website lead (MAKE →
// /api/leads/intake) and, later, a Jobber client the owner imports.
// Intake rows carry jobber_client_id = NULL, so upsertLead's
// jobber_client_id SELECT can never match one — before this pass the
// import blind-inserted a SECOND row for the same human. The owner then
// saw the person twice: the web-form context (request_details, source,
// touchpoint history) on one row, the Jobber stage + money
// (service_request/quote/job/invoice children) on the other. This is the
// NORMAL onboarding path — a territory collects leads pre-launch, then
// imports Jobber on day one.
//
// So on a jobber_client_id MISS, re-check with the SAME vocabulary the
// webform door uses (queryLeadMatches / classifyLeadMatches — see
// components/hive/shared/clientMatch.js), scoped to this location:
//
//   SOLID       — a strong key (exact email or phone_normalized) reaches
//                 exactly ONE lead, and that lead is not yet linked to a
//                 Jobber client. ADOPT it: stamp jobber_client_id and
//                 fill-empty the payload onto that row instead of
//                 inserting. One row survives, carrying both histories.
//   IN QUESTION — ambiguous: a strong key reached >1 lead, the keys
//                 conflict, it is only a name match, or the one solid
//                 match already belongs to another Jobber client. NEVER
//                 merge — fusing two different people is worse than a
//                 duplicate, and unmergeable. Insert as before, but
//                 record possible_duplicate_of.
//   NO MATCH    — insert exactly as before. No behavior change.
//
// Only UNLINKED rows are adoptable, but the ambiguity check runs over
// linked rows too — see the worked example in findAdoptionCandidate for
// why filtering them out first is a false-merge bug.
//
// A failed match read degrades to the plain insert: a duplicate is
// recoverable, a dropped Jobber client is not (same trade intake makes).
//
// NOTE: possible_duplicate_of is written here but is currently READ BY NO
// UI, so the flag is invisible to owners today. A reader (surfacing
// flagged rows for human merge) is a deliberate separate follow-up — the
// column is populated now so the data exists when that lands.

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

// The name upsertLead falls back to when a Jobber client has no personal
// and no company name. Never name-match on it — it is a placeholder, not
// an identity, and would flag every nameless client against every other.
const UNKNOWN_NAME = 'Unknown'

// Columns the import fills on an adopted row only when the row has none.
//
// SCOPE — this is an AT-ADOPTION rule, not a permanent one. Once adopted,
// the row carries a jobber_client_id, so the next sync (webhook, or a
// re-run of the idempotent bulk import) takes the `existing` branch in
// upsertLead, which applies the full payload — Jobber becomes the source
// of truth for these contact columns, exactly as it already is for every
// other Jobber-linked lead. That is the intended contract; fill-empty
// here just avoids a pointless clobber on the adopting write itself.
//
// The web-form context that must survive PERMANENTLY — request_details,
// source, project_type, preferred_contact, metadata, stage, and the
// touchpoint history — is preserved by construction: none of it appears
// in the import payload at all, on either branch.
const ADOPT_FILL_EMPTY_COLS = [
  'name', 'first_name', 'last_name', 'company',
  'email', 'phone', 'address', 'city', 'state', 'zip',
] as const

// The insert–insert race recovery below and the adopt race guard both key
// off the partial unique index leads_jobber_client_id_location_idx
// (WHERE jobber_client_id IS NOT NULL).
function isClientIdDup(error: any): boolean {
  return (
    error?.code === '23505' &&
    (error.message?.includes('leads_jobber_client_id_location_idx') ||
      error?.details?.includes('jobber_client_id'))
  )
}

type AdoptionVerdict =
  | { kind: 'adopt'; leadId: string; matchedOn: string }
  | { kind: 'flag'; candidateIds: string[] }
  | { kind: 'none' }

// Resolve what (if anything) this Jobber client should reconcile with.
// Throws only on a genuine query failure — the caller degrades to insert.
async function findAdoptionCandidate(args: {
  email: string | null
  phone: string | null
  name: string | null
  location_uuid: string
}): Promise<AdoptionVerdict> {
  const { email, phone, name, location_uuid } = args

  // Cross-tenant guard. queryLeadMatches DROPS its location scope when
  // locationUuid is falsy or the literal 'all' — an unscoped match here
  // could adopt another territory's lead, so refuse to match at all
  // rather than match globally.
  if (!location_uuid || location_uuid === 'all') return { kind: 'none' }

  // Strong keys first. queryLeadMatches carries the standing patterns:
  // .or() built only from present keys, .not('is_junk','is',true),
  // .range(0,999), and phone matched via the generated phone_normalized
  // column (raw leads.phone is free-text and never matched DB-side).
  const rows = (await queryLeadMatches(supabaseService, {
    email,
    phone,
    locationUuid: location_uuid,
  })) as Array<{ id: string; jobber_client_id?: string | null }>

  // Classify over the FULL result set — linked rows included.
  //
  // It is tempting to drop already-linked rows first ("they aren't
  // adoptable anyway"), but that is a FALSE-MERGE BUG: classifyLeadMatches
  // arbitrates ambiguity by counting how many leads each strong key
  // reaches (emailIds.size > 1 || phoneIds.size > 1 → in_question).
  // Filtering the input shrinks those counts and silently promotes
  // in_question → solid. Worked example — a shared household landline:
  //   erin — website lead, landline L, already linked to her Jobber client
  //   fay  — website lead, same landline L, unlinked
  //   import Dave, same landline L, no email on his Jobber record
  // Filter-first sees only [fay] → "exactly one" → SOLID → Dave's jobs and
  // money get stamped onto Fay's row. Unrecoverable. Classifying the full
  // set sees the landline reaching TWO leads → in_question → insert+flag.
  // erin being linked is positive PROOF the landline is shared; it is
  // evidence, not noise. (It also made adoption import-order dependent.)
  // The intake door classifies unfiltered for the same reason.
  const verdict = classifyLeadMatches(rows, { email, phone }) as {
    tier: 'solid' | 'in_question' | 'none'
    match?: { id: string; jobber_client_id?: string | null }
    matchedOn?: string
    matchIds?: string[]
  }

  if (verdict.tier === 'solid' && verdict.match?.id) {
    // Unambiguous — but only ADOPTABLE if the row isn't already spoken
    // for. A row carrying a jobber_client_id belongs to a different
    // Jobber client (ours missed the SELECT above); adopting it would
    // steal it. Flag instead: the same person reachable under two Jobber
    // clients is a real duplicate, just not one we may resolve here.
    if (isBlank(verdict.match.jobber_client_id)) {
      return { kind: 'adopt', leadId: verdict.match.id, matchedOn: verdict.matchedOn ?? 'email' }
    }
    return { kind: 'flag', candidateIds: [verdict.match.id] }
  }
  if (verdict.tier === 'in_question') {
    return { kind: 'flag', candidateIds: verdict.matchIds ?? [] }
  }

  // No strong-key hit — name-only check, mirroring the intake door
  // (app/api/leads/intake/route.ts). Name matches can NEVER adopt; they
  // can only ever flag. ilike with escaped wildcards = case-insensitive
  // exact match on the stored name.
  const trimmed = (name || '').trim()
  if (!trimmed || trimmed === UNKNOWN_NAME) return { kind: 'none' }
  const nameEsc = trimmed.replace(/[\\%_]/g, (m) => `\\${m}`)
  const { data: nameRows, error: nameErr } = await supabaseService
    .from('leads')
    .select('id')
    .eq('location_uuid', location_uuid)
    .is('jobber_client_id', null)
    .ilike('name', nameEsc)
    .not('is_junk', 'is', true)
    .range(0, 999)
  if (nameErr) throw new Error(nameErr.message)
  if (nameRows && nameRows.length > 0) {
    return { kind: 'flag', candidateIds: nameRows.map((r: { id: string }) => r.id) }
  }
  return { kind: 'none' }
}

// Execute the adoption. Returns null when the candidate turned out to be
// unusable (vanished, or linked by a racing writer) — the caller then
// falls through to the normal insert.
async function adoptLead(args: {
  candidateId: string
  jobberClientId: string
  payload: Record<string, any>
  location_uuid: string
}): Promise<{ id: string; created: false; stage: string | null } | null> {
  const { candidateId, jobberClientId, payload, location_uuid } = args

  // Fresh targeted read: the fill-empty decision must be made against the
  // row as it is NOW, and this doubles as the race guard below.
  const { data: row, error: readErr } = await supabaseService
    .from('leads')
    .select(
      'id, name, first_name, last_name, company, email, phone, address, city, state, zip, assigned_to, jobber_client_id, stage',
    )
    .eq('id', candidateId)
    .maybeSingle()
  if (readErr) throw new Error(readErr.message)
  if (!row) return null

  // Linked between the match and now. If it was linked to US, the work is
  // already done; to anyone else, it is no longer ours to adopt.
  if (!isBlank(row.jobber_client_id)) {
    return row.jobber_client_id === jobberClientId
      ? { id: row.id, created: false, stage: (row.stage as string | null) ?? null }
      : null
  }

  const patch: Record<string, any> = {
    // The adoption itself, plus bookkeeping — these always win.
    jobber_client_id: jobberClientId,
    location_id: payload.location_id,
    location_uuid: payload.location_uuid,
    jobber_synced_at: payload.jobber_synced_at,
    updated_at: payload.updated_at,
  }
  for (const col of ADOPT_FILL_EMPTY_COLS) {
    if (!isBlank(payload[col]) && isBlank((row as any)[col])) patch[col] = payload[col]
  }
  // Same "never orphaned" guarantee the insert path gives — but only when
  // the row has no owner yet; an existing assignment is the owner's.
  if (isBlank(row.assigned_to)) {
    const primaryOwner = await getPrimaryOwnerForLocation(location_uuid)
    if (primaryOwner?.id) patch.assigned_to = primaryOwner.id
  }
  // Deliberately NOT set: import_source, source, request_details, and
  // `paused`. The first three keep the row's web-form provenance intact.
  // `paused` is left exactly as-is because upsertLead also serves the
  // realtime webhook path, where a location IS active and the adopted
  // lead may have a LIVE drip sequence — stamping the import's
  // paused:true there would silently halt it. Mirrors the existing rule
  // that updates never reclassify source or flip the paused flag.

  const { error: updErr } = await supabaseService
    .from('leads')
    .update(patch)
    .eq('id', row.id)

  if (updErr) {
    // A racing writer claimed this jobber_client_id for a different row
    // between our read and this write, tripping the partial unique index.
    // The winner's row is the target — update it as the `existing` branch
    // would have, and leave our candidate unlinked (it stays a duplicate,
    // which is exactly the pre-adoption behavior — never worse).
    if (isClientIdDup(updErr)) {
      const { data: winner } = await supabaseService
        .from('leads')
        .select('id, stage')
        .eq('jobber_client_id', jobberClientId)
        .eq('location_id', payload.location_id)
        .maybeSingle()
      if (winner) {
        await supabaseService.from('leads').update(payload).eq('id', winner.id)
        return { id: winner.id, created: false, stage: (winner.stage as string | null) ?? null }
      }
    }
    throw new Error(updErr.message)
  }

  return { id: row.id, created: false, stage: (row.stage as string | null) ?? null }
}

// importSource tags the origin of records this function creates. It's
// only written on insert — updates to an already-existing lead never
// reclassify its source or flip the paused flag, so an owner-paused
// lead doesn't accidentally get un-paused by a routine webhook refresh.
//
// Defaulting to 'jobber_webhook' keeps the older two-arg call sites
// safe (the realtime webhook path); the bulk import route passes
// 'jobber_initial' explicitly.
export async function upsertLead(
  client: any,
  location_id: string,
  location_uuid: string,
  opts: { importSource?: string } = {},
) {
  const importSource = opts.importSource || 'jobber_webhook'
  const email = client.emails?.find((e: any) => e.primary)?.address ?? client.emails?.[0]?.address ?? null
  const phone = client.phones?.find((p: any) => p.primary)?.number  ?? client.phones?.[0]?.number  ?? null
  const addr  = client.billingAddress
    ? [
        client.billingAddress.street,
        client.billingAddress.city,
        client.billingAddress.province,
        client.billingAddress.postalCode,
      ].filter(Boolean).join(', ')
    : null

  const jobberClientId = extractJobberId(client.id)

  const payload = {
    location_id,
    location_uuid,
    jobber_client_id: jobberClientId,
    name: `${client.firstName || ''} ${client.lastName || ''}`.trim() || client.companyName || 'Unknown',
    first_name: client.firstName || null,
    last_name:  client.lastName  || null,
    company:    client.companyName || null,
    email, phone, address: addr,
    city:  client.billingAddress?.city       || null,
    state: client.billingAddress?.province   || null,
    zip:   client.billingAddress?.postalCode || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  const { data: existing } = await supabaseService
    .from('leads')
    .select('id, stage')
    .eq('jobber_client_id', jobberClientId)
    .eq('location_id', location_id)
    .maybeSingle()

  if (existing) {
    await supabaseService.from('leads').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false, stage: existing.stage as string | null }
  }

  // ── Adoption pass ───────────────────────────────────────────────
  // The jobber_client_id SELECT missed, so this client is new TO JOBBER —
  // but the person may already exist as a website lead. See the block
  // comment above findAdoptionCandidate. Never fatal: any failure here
  // degrades to the plain insert below.
  let possibleDuplicateIds: string[] = []
  try {
    const verdict = await findAdoptionCandidate({
      email,
      phone,
      name: payload.name,
      location_uuid,
    })
    // Adoption needs an id to stamp: an unextractable Jobber client id
    // (extractJobberId → null) has nothing to link the row to, so it can
    // only ever take the insert path.
    if (verdict.kind === 'adopt' && jobberClientId) {
      const adopted = await adoptLead({
        candidateId: verdict.leadId,
        jobberClientId,
        payload,
        location_uuid,
      })
      // null = the candidate became unusable mid-flight; fall through.
      if (adopted) return adopted
    } else if (verdict.kind === 'flag') {
      possibleDuplicateIds = verdict.candidateIds
    }
  } catch (err: any) {
    console.error(
      '[jobber-import] adoption match failed — falling back to plain insert',
      err,
    )
  }

  // Default new leads to the location's primary owner so they're never
  // orphaned (assigned_to=null). Fetched per-insert rather than once
  // up-front so the webhook path (single-record creates) also benefits.
  const primaryOwner = await getPrimaryOwnerForLocation(location_uuid)

  const { data, error } = await supabaseService
    .from('leads')
    .insert({
      ...payload,
      assigned_to: primaryOwner?.id ?? null,
      created_at: client.createdAt || new Date().toISOString(),
      import_source: importSource,
      paused: true,
      // IN QUESTION only — an ambiguous match creates the row (never
      // merge two possible people) but records what it might collide
      // with. No UI reads this yet; see the adoption block comment.
      ...(possibleDuplicateIds.length
        ? { possible_duplicate_of: possibleDuplicateIds }
        : {}),
    })
    .select('id, stage')
    .single()
  if (error) {
    // Insert–insert race: a concurrent webhook for the SAME new client (e.g.
    // REQUEST_CREATE + REQUEST_UPDATE landing ms apart) already inserted the
    // lead between our SELECT above and this INSERT, tripping the unique
    // index leads_jobber_client_id_location_idx. Recover idempotently by
    // treating the winner's row as the target: re-select and update it,
    // exactly as the `existing` branch would have.
    if (isClientIdDup(error)) {
      const { data: winner } = await supabaseService
        .from('leads')
        .select('id, stage')
        .eq('jobber_client_id', jobberClientId)
        .eq('location_id', location_id)
        .maybeSingle()
      if (winner) {
        await supabaseService.from('leads').update(payload).eq('id', winner.id)
        return { id: winner.id, created: false, stage: winner.stage as string | null }
      }
    }
    throw new Error(error.message)
  }
  return { id: data.id, created: true, stage: data.stage as string | null }
}

// `promoteLead` defaults true (import-route behavior): mirror the SR's
// classification onto leads.stage when it represents forward progress.
// Webhook handlers pass false so the route can drive lead.stage
// explicitly per the topic → stage map (see jobber-webhook-handlers.ts).
export async function upsertServiceRequest(
  request: any,
  lead_id: string,
  location_id: string,
  opts: { promoteLead?: boolean } = {},
) {
  const promoteLead = opts.promoteLead !== false
  const stage = determineStage(request)
  const jobberRequestId = extractJobberId(request.id)
  const payload = {
    lead_id, location_id,
    jobber_request_id: jobberRequestId,
    request_url: request.jobberWebUri || null,
    stage,
    status: 'active',
    source: 'jobber',
    requested_at: request.createdAt || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  // Pre-select is a stats hint only — correctness lives in the DB-level
  // upsert below. The arbiter is service_requests_location_jobber_request_id_idx
  // (non-partial since jobber_subrecord_onconflict_targetable.sql — PostgREST
  // can't arbitrate partial indexes); concurrent webhook deliveries for the
  // same request merge into one row instead of racing check-then-insert.
  const { data: existing, error: selectError } = await supabaseService
    .from('service_requests')
    .select('id')
    .eq('jobber_request_id', jobberRequestId)
    .eq('location_id', location_id)
    .maybeSingle()
  if (selectError) throw new Error(`Service request lookup: ${selectError.message}`)
  const { data, error } = await supabaseService
    .from('service_requests')
    .upsert(
      {
        ...payload,
        // Same-value on update: readers key off Jobber's timestamp either way.
        created_at: request.createdAt || new Date().toISOString(),
      },
      { onConflict: 'location_id,jobber_request_id' },
    )
    .select('id')
    .single()
  if (error) throw new Error(`Service request: ${error.message}`)
  const srId = data.id
  const created = !existing

  // Forward-only promotion: leads.stage mirrors the SR's classification
  // only when it represents forward progress. Skipped entirely when
  // promoteLead=false — webhook handlers take that path because their
  // topic→stage map is explicit (e.g. JOB_CREATE intentionally leaves
  // stage at 'Estimate Sent', so we can't let determineStage push it
  // to 'Job in Progress' here).
  const { data: currentLead } = await supabaseService
    .from('leads')
    .select('stage')
    .eq('id', lead_id)
    .single()
  const currentRank = STAGE_RANK[currentLead?.stage || 'New'] ?? 0
  const newRank = STAGE_RANK[stage] ?? 0
  const promoted = promoteLead && newRank > currentRank
  if (promoted) {
    await supabaseService
      .from('leads')
      .update({ stage })
      .eq('id', lead_id)
  }

  return {
    id: srId,
    created,
    stage,
    prev_lead_stage: currentLead?.stage || null,
    promoted,
  }
}

export async function upsertAssessment(
  request: any,
  service_request_id: string,
  lead_id: string,
  location_id: string,
) {
  const payload = {
    service_request_id, lead_id, location_id,
    jobber_request_id: extractJobberId(request.id),
    // The appointment id (Request.assessment.id) — the target for
    // appointmentEditAssignment in the engagement-assignee sync. Without
    // it that sync reports assessment=none. Stored numeric via
    // extractJobberId, matching every sibling jobber_*_id column; the
    // GraphQL selections (REQUESTS_QUERY / SINGLE_REQUEST_QUERY) now
    // fetch `assessment { id startAt }`. Guarded because a re-sync must
    // never null a good id if a payload ever arrives id-less.
    ...(request.assessment?.id
      ? { jobber_assessment_id: extractJobberId(request.assessment.id) }
      : {}),
    scheduled_at: request.assessment.startAt || null,
    // Completion state (Jobber Assessment.isComplete/completedAt — added to
    // REQUESTS_QUERY / SINGLE_REQUEST_QUERY alongside id/startAt). completed_at
    // is the load-bearing done-signal every hive derivation keys off
    // (!a.completed_at); status is the display string. isComplete is Boolean!
    // in Jobber (always present on a real payload); the else branch only fires
    // for a malformed/partial payload — there we keep the historical
    // 'scheduled' insert default but DON'T touch completed_at, so a re-sync
    // can never null a recorded completion. Jobber's model is binary (a
    // cancelled assessment is deleted → the request has no assessment), so
    // this mapping is non-lossy.
    ...(typeof request.assessment.isComplete === 'boolean'
      ? request.assessment.isComplete
        ? { status: 'completed', completed_at: request.assessment.completedAt || null }
        : { status: 'scheduled', completed_at: null }
      : { status: 'scheduled' }),
    // Appointment duration in minutes (Jobber Assessment.duration — added to
    // REQUESTS_QUERY / SINGLE_REQUEST_QUERY alongside id/startAt). Verified
    // live: `duration` is already minutes (== (endAt-startAt)/60000 exactly),
    // so it maps 1:1 to duration_minutes with no derivation. Guarded exactly
    // like the appointment id: only overwrite when the payload carries a real
    // number. Jobber leaves duration null on ~8% of assessments (no scheduled
    // end); on those we omit the key so the insert keeps the DB default (60)
    // and a re-sync never nulls a good duration. Root cause was the same shape
    // as 78f1ba8/a1cd157: the selection never fetched duration, so every row
    // held the fake uniform 60.
    ...(typeof request.assessment.duration === 'number'
      ? { duration_minutes: request.assessment.duration }
      : {}),
    source: 'jobber',
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  // Pre-select is a stats hint only (import route counts created vs
  // updated) — correctness lives in the DB-level upsert below. The
  // arbiter is assessments_service_request_id_idx; concurrent webhook
  // deliveries for the same request merge into one row instead of
  // racing check-then-insert (the Chelsea Atkins dupe snowball).
  const { data: existing, error: selectError } = await supabaseService
    .from('assessments')
    .select('id')
    .eq('service_request_id', service_request_id)
    .maybeSingle()
  if (selectError) throw new Error(`Assessment lookup: ${selectError.message}`)
  const { data, error } = await supabaseService
    .from('assessments')
    .upsert(
      {
        ...payload,
        // Re-stamped on update too (upsert sets every payload column);
        // nothing reads assessments.created_at — ordering uses scheduled_at.
        created_at: request.assessment.startAt || new Date().toISOString(),
      },
      { onConflict: 'service_request_id' },
    )
    .select('id')
    .single()
  if (error) throw new Error(`Assessment: ${error.message}`)
  return { id: data.id, created: !existing }
}

// service_request_id is null for requestless quotes (created directly on
// a client in Jobber — no service request exists). Requires the
// quotes.service_request_id NOT NULL constraint to be dropped; until that
// migration runs, a null insert fails loudly (caught per-record upstream).
export async function upsertQuote(
  quote: any,
  service_request_id: string | null,
  lead_id: string,
  location_id: string,
) {
  const jobberQuoteId = extractJobberId(quote.id)
  // Map Jobber's quoteStatus enum to local string columns. The bulk
  // import doesn't fetch quoteStatus (would explode complexity score),
  // so when absent default to 'sent' as before.
  const status = (quote.quoteStatus || '').toUpperCase()
  const approvedAt = status === 'APPROVED' ? new Date().toISOString() : null
  const payload: Record<string, any> = {
    service_request_id, lead_id, location_id,
    jobber_quote_id: jobberQuoteId,
    quote_url: quote.jobberWebUri || null,
    status: status === 'APPROVED' ? 'approved'
          : status === 'CONVERTED' ? 'approved'
          : status === 'ARCHIVED' ? 'archived'
          : status === 'CHANGES_REQUESTED' ? 'changes_requested'
          : 'sent',
    subtotal:        quote.amounts?.subtotal       ? parseFloat(quote.amounts.subtotal)       : null,
    tax_amount:      quote.amounts?.taxAmount      ? parseFloat(quote.amounts.taxAmount)      : null,
    discount_amount: quote.amounts?.discountAmount ? parseFloat(quote.amounts.discountAmount) : null,
    total:           quote.amounts?.total          ? parseFloat(quote.amounts.total)          : null,
    sent_at: quote.createdAt || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (approvedAt) payload.approved_at = approvedAt
  // Pre-select is a stats hint plus the approved_at-once guard —
  // correctness lives in the DB-level upsert below. The arbiter is
  // quotes_location_jobber_quote_id_idx (non-partial since
  // jobber_subrecord_onconflict_targetable.sql — PostgREST can't
  // arbitrate partial indexes); concurrent webhook deliveries for the
  // same quote merge into one row instead of racing check-then-insert.
  const { data: existing, error: selectError } = await supabaseService
    .from('quotes')
    .select('id, approved_at')
    .eq('jobber_quote_id', jobberQuoteId)
    .eq('location_id', location_id)
    .maybeSingle()
  if (selectError) throw new Error(`Quote lookup: ${selectError.message}`)
  // Preserve an earlier approved_at if already set — only stamp once.
  if (existing?.approved_at) delete payload.approved_at
  const { data, error } = await supabaseService
    .from('quotes')
    .upsert(
      {
        ...payload,
        // Same-value on update: every quote query shape fetches createdAt,
        // and readers (engagements activity, people-mapper's estimateSent
        // fallback) key off Jobber's timestamp either way.
        created_at: quote.createdAt || new Date().toISOString(),
      },
      { onConflict: 'location_id,jobber_quote_id' },
    )
    .select('id')
    .single()
  if (error) throw new Error(`Quote: ${error.message}`)
  return { id: data.id, created: !existing, status: payload.status as string }
}

export async function upsertJob(
  job: any,
  service_request_id: string | null,
  lead_id: string,
  location_id: string,
) {
  const jobberJobId = extractJobberId(job.id)

  // Job.quote → jobs.quote_id (Phase 1 step 3; JOBS_QUERY/SINGLE_JOB_QUERY
  // widened fail-loud per decision 14 context). Only written when the quote
  // row already exists locally, and never nulled here — a missed lookup
  // (e.g. JOB_CREATE webhook racing QUOTE_CREATE) can't erase an earlier
  // link; the next job upsert heals it.
  let quoteDbId: string | null = null
  const jobberQuoteId = extractJobberId(job.quote?.id)
  if (jobberQuoteId) {
    const { data: quoteRow } = await supabaseService
      .from('quotes')
      .select('id')
      .eq('jobber_quote_id', jobberQuoteId)
      .eq('location_id', location_id)
      .maybeSingle()
    if (quoteRow) quoteDbId = quoteRow.id
  }

  const mappedStatus = JOB_STATUS[job.jobStatus?.toUpperCase()]
  const payload: Record<string, any> = {
    service_request_id, lead_id, location_id,
    jobber_job_id: jobberJobId,
    job_url: job.jobberWebUri || null,
    title: job.title || null,
    status: mappedStatus ?? 'unknown',
    scheduled_start: job.startAt || null,
    completed_at:    job.completedAt || null,
    total: job.total ? parseFloat(job.total) : null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (quoteDbId) payload.quote_id = quoteDbId
  // Pre-select is a stats hint only — correctness lives in the DB-level
  // upsert below (status also feeds the unmapped-status alarm, which is
  // best-effort). The arbiter is jobs_location_jobber_job_id_idx
  // (non-partial since jobber_subrecord_onconflict_targetable.sql);
  // concurrent webhook deliveries for the same job merge into one row
  // instead of racing check-then-insert.
  const { data: existing, error: selectError } = await supabaseService
    .from('jobs')
    .select('id, status')
    .eq('jobber_job_id', jobberJobId)
    .eq('location_id', location_id)
    .maybeSingle()
  if (selectError) throw new Error(`Job lookup: ${selectError.message}`)
  const { data, error } = await supabaseService
    .from('jobs')
    .upsert(
      {
        ...payload,
        // Same-value on update: every job query shape fetches createdAt.
        created_at: job.createdAt || new Date().toISOString(),
      },
      { onConflict: 'location_id,jobber_job_id' },
    )
    .select('id')
    .single()
  if (error) throw new Error(`Job: ${error.message}`)

  // Unmapped-status alarm: a jobStatus value missing from JOB_STATUS
  // lands as 'unknown', which derivation reads conservatively as current
  // work — a never-seen Jobber status must surface on the webhook
  // dashboard within hours, not months later via a confused client
  // (Wendy Blanch's 2024 action_required job). The topic= token is what
  // makes the row render there (lib/webhook-observability.ts). Fires on
  // the first landing only (new row, or an existing row that wasn't
  // already 'unknown') so webhook re-deliveries don't storm the log;
  // best-effort by design — writeSyncLog never throws.
  if (mappedStatus === undefined && existing?.status !== 'unknown') {
    await writeSyncLog({
      location_id,
      entity_id: data.id,
      entity_type: 'job',
      direction: 'inbound',
      jobber_record_id: jobberJobId ?? undefined,
      status: 'error',
      message: `[job-status] topic=JOB_STATUS_UNMAPPED unmapped Jobber job status: ${job.jobStatus ?? '(null)'} — stored 'unknown' (derivation reads it as current work until mapped) job=${jobberJobId} lead=${lead_id}`,
    })
  }
  return { id: data.id, created: !existing, quote_db_id: quoteDbId }
}

export async function upsertInvoice(
  invoice: any,
  job_id: string | null,
  service_request_id: string | null,
  lead_id: string,
  location_id: string,
) {
  const jobberInvoiceId = extractJobberId(invoice.id)
  const status = (invoice.invoiceStatus || '').toUpperCase()
  const isPaid = status === 'PAID'
  const totalNum = invoice.amounts?.total ? parseFloat(invoice.amounts.total) : null
  // Latest real money-in date, when the caller's query selected paymentRecords
  // (SINGLE_INVOICE_QUERY does; the bulk-import queries don't). Only PAYMENT
  // and DEPOSIT are money in — REFUND / FAILED_ACH_PAYMENT / VOIDED /
  // BAD_DEBT / CORRECTION are also PaymentRecords and must never be read as
  // "when this was paid". ISO-8601 sorts lexicographically = chronologically.
  const MONEY_IN = new Set(['PAYMENT', 'DEPOSIT'])
  const paidAtFromPayments =
    (invoice.paymentRecords?.nodes || [])
      .filter((p: any) => p?.entryDate && MONEY_IN.has(String(p.adjustmentType || '').toUpperCase()))
      .map((p: any) => p.entryDate as string)
      .sort()
      .pop() || null
  const payload: Record<string, any> = {
    job_id, service_request_id, lead_id, location_id,
    jobber_invoice_id: jobberInvoiceId,
    invoice_url: invoice.jobberWebUri || null,
    status: isPaid ? 'paid'
          : status === 'PARTIAL' ? 'partial'
          : status === 'BAD_DEBT' ? 'bad_debt'
          : 'sent',
    subtotal:        invoice.amounts?.subtotal       ? parseFloat(invoice.amounts.subtotal)       : null,
    tax_amount:      invoice.amounts?.taxAmount      ? parseFloat(invoice.amounts.taxAmount)      : null,
    discount_amount: invoice.amounts?.discountAmount ? parseFloat(invoice.amounts.discountAmount) : null,
    total:           totalNum,
    // Payment fields (read by people-mapper's invoice mapping). PAID stays
    // all-or-nothing: paid = full total, balance 0.
    //
    // paid_at prefers the real money-in date from paymentRecords. It falls
    // back to createdAt (the ISSUE date) only when the caller's query didn't
    // select paymentRecords — i.e. the bulk-import paths. That fallback is
    // why existing rows carry issue dates as payment dates: Jobber does
    // expose paymentRecords { entryDate } and amounts { paymentsTotal
    // tipsTotal invoiceBalance }; SINGLE_INVOICE_QUERY simply never asked
    // until now. Repairing the already-stamped rows is a separate decision.
    paid_amount:   isPaid ? totalNum : null,
    balance_owing: isPaid ? 0 : totalNum,
    paid_at:       isPaid ? (paidAtFromPayments || invoice.createdAt || null) : null,
    issued_at: invoice.createdAt || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  // Pre-select is a stats hint only — correctness lives in the DB-level
  // upsert below. The arbiter is invoices_location_jobber_invoice_id_idx
  // (non-partial since jobber_subrecord_onconflict_targetable.sql);
  // concurrent webhook deliveries for the same invoice merge into one
  // row instead of racing check-then-insert.
  const { data: existing, error: selectError } = await supabaseService
    .from('invoices')
    .select('id')
    .eq('jobber_invoice_id', jobberInvoiceId)
    .eq('location_id', location_id)
    .maybeSingle()
  if (selectError) throw new Error(`Invoice lookup: ${selectError.message}`)
  const { data, error } = await supabaseService
    .from('invoices')
    .upsert(
      {
        ...payload,
        // Same-value on update: every invoice query shape fetches createdAt.
        created_at: invoice.createdAt || new Date().toISOString(),
      },
      { onConflict: 'location_id,jobber_invoice_id' },
    )
    .select('id')
    .single()
  if (error) throw new Error(`Invoice: ${error.message}`)
  return { id: data.id, created: !existing, status: payload.status as string }
}

// ── stage promotion helper (webhook handlers) ─────────────────────
// Updates leads.stage to `newStage` iff it represents forward progress.
// Returns the prior stage (or null) and whether a change was applied —
// callers use this to drive applyDripSideEffects.
export async function promoteLeadStage(
  lead_id: string,
  newStage: string,
): Promise<{ prevStage: string | null; promoted: boolean }> {
  const { data: lead } = await supabaseService
    .from('leads')
    .select('stage')
    .eq('id', lead_id)
    .maybeSingle()
  const prevStage = lead?.stage || null
  const currentRank = STAGE_RANK[prevStage || 'New'] ?? 0
  const newRank = STAGE_RANK[newStage] ?? 0
  if (newRank <= currentRank) return { prevStage, promoted: false }
  await supabaseService.from('leads').update({ stage: newStage }).eq('id', lead_id)
  return { prevStage, promoted: true }
}
