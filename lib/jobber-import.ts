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
        assessment { startAt }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const QUOTES_QUERY = `
  query GetQuotes($after: String) {
    quotes(first: 50, after: $after) {
      nodes {
        id createdAt jobberWebUri
        request { id }
        amounts { subtotal taxAmount discountAmount total }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const JOBS_QUERY = `
  query GetJobs($after: String) {
    jobs(first: 50, after: $after) {
      nodes {
        id createdAt jobberWebUri title jobStatus startAt completedAt total
        request { id }
        invoices(first: 10) {
          nodes {
            id createdAt jobberWebUri
            amounts { subtotal taxAmount discountAmount total }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
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
      assessment { startAt }
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
      amounts { subtotal taxAmount discountAmount total }
    }
  }
`

export const SINGLE_JOB_QUERY = `
  query GetJob($id: EncodedId!) {
    job(id: $id) {
      id createdAt jobberWebUri title jobStatus startAt completedAt total
      request { id client { id } }
      client { id }
      invoices(first: 10) {
        nodes {
          id createdAt jobberWebUri
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

// ── constants ─────────────────────────────────────────────────────

export const JOB_STATUS: Record<string, string> = {
  ACTIVE: 'in_progress', COMPLETED: 'completed',
  REQUIRES_INVOICING: 'completed', LATE: 'late',
  TODAY: 'today', UPCOMING: 'upcoming', ARCHIVED: 'archived',
}

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
  if (error) throw new Error(error.message)
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
    scheduled_at: request.assessment.startAt || null,
    status: 'scheduled',
    source: 'jobber',
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService
    .from('assessments')
    .select('id')
    .eq('service_request_id', service_request_id)
    .maybeSingle()
  if (existing) {
    await supabaseService.from('assessments').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService
    .from('assessments')
    .insert({
      ...payload,
      created_at: request.assessment.startAt || new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) throw new Error(`Assessment: ${error.message}`)
  return { id: data.id, created: true }
}

export async function upsertQuote(
  quote: any,
  service_request_id: string,
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
  const { data: existing } = await supabaseService
    .from('quotes')
    .select('id, approved_at')
    .eq('jobber_quote_id', jobberQuoteId)
    .eq('location_id', location_id)
    .maybeSingle()
  if (existing) {
    // Preserve an earlier approved_at if already set — only stamp once.
    if (existing.approved_at) delete payload.approved_at
    await supabaseService.from('quotes').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false, status: payload.status as string }
  }
  const { data, error } = await supabaseService
    .from('quotes')
    .insert({ ...payload, created_at: quote.createdAt || new Date().toISOString() })
    .select('id')
    .single()
  if (error) throw new Error(`Quote: ${error.message}`)
  return { id: data.id, created: true, status: payload.status as string }
}

export async function upsertJob(
  job: any,
  service_request_id: string | null,
  lead_id: string,
  location_id: string,
) {
  const jobberJobId = extractJobberId(job.id)
  const payload = {
    service_request_id, lead_id, location_id,
    jobber_job_id: jobberJobId,
    job_url: job.jobberWebUri || null,
    title: job.title || null,
    status: JOB_STATUS[job.jobStatus?.toUpperCase()] ?? 'unknown',
    scheduled_start: job.startAt || null,
    completed_at:    job.completedAt || null,
    total: job.total ? parseFloat(job.total) : null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService
    .from('jobs')
    .select('id')
    .eq('jobber_job_id', jobberJobId)
    .eq('location_id', location_id)
    .maybeSingle()
  if (existing) {
    await supabaseService.from('jobs').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService
    .from('jobs')
    .insert({ ...payload, created_at: job.createdAt || new Date().toISOString() })
    .select('id')
    .single()
  if (error) throw new Error(`Job: ${error.message}`)
  return { id: data.id, created: true }
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
  const payload: Record<string, any> = {
    job_id, service_request_id, lead_id, location_id,
    jobber_invoice_id: jobberInvoiceId,
    invoice_url: invoice.jobberWebUri || null,
    status: status === 'PAID' ? 'paid'
          : status === 'PARTIAL' ? 'partial'
          : status === 'BAD_DEBT' ? 'bad_debt'
          : 'sent',
    subtotal:        invoice.amounts?.subtotal       ? parseFloat(invoice.amounts.subtotal)       : null,
    tax_amount:      invoice.amounts?.taxAmount      ? parseFloat(invoice.amounts.taxAmount)      : null,
    discount_amount: invoice.amounts?.discountAmount ? parseFloat(invoice.amounts.discountAmount) : null,
    total:           invoice.amounts?.total          ? parseFloat(invoice.amounts.total)          : null,
    issued_at: invoice.createdAt || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService
    .from('invoices')
    .select('id')
    .eq('jobber_invoice_id', jobberInvoiceId)
    .eq('location_id', location_id)
    .maybeSingle()
  if (existing) {
    await supabaseService.from('invoices').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false, status: payload.status as string }
  }
  const { data, error } = await supabaseService
    .from('invoices')
    .insert({ ...payload, created_at: invoice.createdAt || new Date().toISOString() })
    .select('id')
    .single()
  if (error) throw new Error(`Invoice: ${error.message}`)
  return { id: data.id, created: true, status: payload.status as string }
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
