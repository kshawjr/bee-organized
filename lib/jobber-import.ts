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

export const SINGLE_INVOICE_QUERY = `
  query GetInvoice($id: EncodedId!) {
    invoice(id: $id) {
      id createdAt jobberWebUri invoiceStatus
      amounts { subtotal taxAmount discountAmount total }
      client { id }
      jobs(first: 5) { nodes { id request { id } } }
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
    const isClientIdDup =
      (error as any).code === '23505' &&
      ((error.message?.includes('leads_jobber_client_id_location_idx')) ||
       (error as any).details?.includes('jobber_client_id'))
    if (isClientIdDup) {
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
  const { data: existing } = await supabaseService
    .from('service_requests')
    .select('id')
    .eq('jobber_request_id', jobberRequestId)
    .eq('location_id', location_id)
    .maybeSingle()

  let srId: string
  let created: boolean
  if (existing) {
    await supabaseService.from('service_requests').update(payload).eq('id', existing.id)
    srId = existing.id
    created = false
  } else {
    const { data, error } = await supabaseService
      .from('service_requests')
      .insert({ ...payload, created_at: request.createdAt || new Date().toISOString() })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    srId = data.id
    created = true
  }

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
    // Payment fields (read by people-mapper's invoice mapping). Jobber's
    // invoice shape here carries no per-payment data or paid timestamp, so
    // PAID is all-or-nothing: paid = full total, balance 0, and issued date
    // stands in for paid_at. PARTIAL can't be split without payments data —
    // leave amounts null rather than guess.
    paid_amount:   isPaid ? totalNum : null,
    balance_owing: isPaid ? 0 : totalNum,
    paid_at:       isPaid ? (invoice.createdAt || null) : null,
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
