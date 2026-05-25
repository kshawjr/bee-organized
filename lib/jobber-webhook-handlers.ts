// lib/jobber-webhook-handlers.ts
// ─────────────────────────────────────────────────────────────
// Per-topic handlers for /api/webhooks/jobber.
//
// Each handler:
//   1. Encodes the bare numeric itemId back to a GraphQL global id.
//   2. Fetches the corresponding record via jobberGraphQL.
//   3. Runs the record through the shared upsert functions in
//      lib/jobber-import.ts (find-or-create lead, upsert SR/quote/
//      job/invoice/etc.) — webhook calls pass promoteLead=false so
//      lead.stage is driven explicitly by this file, not by
//      determineStage.
//   4. Stamps per-event timestamps on the lead so the Outreach
//      timeline can render distinct entries even when the stage
//      doesn't change.
//   5. Forward-only stage promotion via promoteLeadStage +
//      applyDripSideEffects, but ONLY for the topics that drive a
//      transition (see TOPIC → STAGE MAP below).
//
// TOPIC → STAGE MAP (matches Kevin's spec):
//   REQUEST_CREATE  → 'Request'        forward-only
//   REQUEST_UPDATE  → (no change)
//   QUOTE_CREATE    → 'Estimate Sent'  forward-only
//   QUOTE_UPDATE    → (no change)
//   QUOTE_SENT      → 'Estimate Sent'  forward-only (idempotent)
//   QUOTE_APPROVED  → (no change)      stamp quote_approved_at
//   JOB_CREATE      → (no change)      stamp job_created_at +
//                                      scheduled_at (Job in Progress
//                                      is owner-driven only)
//   JOB_UPDATE      → (no change)
//   JOB_COMPLETE    → 'Closed Won'     forward-only + stop drip
//   INVOICE_CREATE  → (no change)      stamp invoice_created_at +
//                                      balance_owing
//   INVOICE_PAID    → 'Closed Won'     forward-only + stop drip
//   CLIENT_UPDATE   → (no change)      refresh name/email/phone
//
// Handlers never throw out — failures bubble back as a string
// `error` field, so the dispatcher can still 200 to Jobber and
// keep a sync_log row for diagnosis.
// ─────────────────────────────────────────────────────────────

import { jobberGraphQL } from './jobber'
import { supabaseService } from './supabase-service'
import { applyDripSideEffects } from './drip-lifecycle'
import {
  SINGLE_CLIENT_QUERY,
  SINGLE_REQUEST_QUERY,
  SINGLE_QUOTE_QUERY,
  SINGLE_JOB_QUERY,
  SINGLE_INVOICE_QUERY,
  upsertLead,
  upsertServiceRequest,
  upsertAssessment,
  upsertQuote,
  upsertJob,
  upsertInvoice,
  extractJobberId,
  promoteLeadStage,
} from './jobber-import'
import type { LocationRow } from './jobber-webhook'

type JobberType = 'Client' | 'Request' | 'Quote' | 'Job' | 'Invoice'

export type HandlerCtx = {
  topic: string
  itemId: string
  occurredAt: string
  location: LocationRow
}

export type HandlerResult = {
  processed: boolean
  lead_id?: string | null
  lead_stage?: string | null
  prev_stage?: string | null
  note?: string
  error?: string
}

// ── encoding helpers ──────────────────────────────────────────

// Webhook payloads ship itemId in either form: bare numeric ("136289662")
// or the full base64-encoded GraphQL global id
// ("Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzYyODk2NjI="). Normalize to numeric via
// extractJobberId, then build the canonical global id ourselves. Without
// this, base64-input gets double-wrapped → Jobber resolves to null →
// "<entity>_not_found_in_jobber" even though the record exists.
function encodeJobberId(type: JobberType, rawItemId: string): string {
  const numeric = extractJobberId(rawItemId) || rawItemId
  return Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')
}

// ── lead resolution ───────────────────────────────────────────

async function findLeadByJobberClientId(
  jobberClientGlobalId: string,
  locationSlug: string,
): Promise<{ id: string; stage: string | null } | null> {
  const numeric = extractJobberId(jobberClientGlobalId)
  if (!numeric) return null
  const { data } = await supabaseService
    .from('leads')
    .select('id, stage')
    .eq('jobber_client_id', numeric)
    .eq('location_id', locationSlug)
    .maybeSingle()
  return data ? { id: data.id, stage: data.stage } : null
}

async function findServiceRequestByJobberId(
  jobberRequestGlobalId: string,
): Promise<{ id: string; lead_id: string } | null> {
  const numeric = extractJobberId(jobberRequestGlobalId)
  if (!numeric) return null
  const { data } = await supabaseService
    .from('service_requests')
    .select('id, lead_id')
    .eq('jobber_request_id', numeric)
    .maybeSingle()
  return data ? { id: data.id, lead_id: data.lead_id } : null
}

// Fetch a request from Jobber and run it through the lead + SR upsert
// pipeline. Used by REQUEST_* handlers and as a fallback when a quote/
// job/invoice fires for a request we haven't ingested yet.
//
// Always passes promoteLead=false to upsertServiceRequest. The caller
// is responsible for driving any explicit lead.stage promotion (per
// the topic→stage map at the top of this file).
async function fetchAndUpsertRequest(
  requestGlobalId: string,
  ctx: HandlerCtx,
): Promise<{
  lead_id: string
  service_request_id: string
  lead_stage_before: string | null
} | { error: string }> {
  const res = await jobberGraphQL(ctx.location.location_id, SINGLE_REQUEST_QUERY, {
    id: requestGlobalId,
  })
  if (res.errors?.length) {
    console.error('[jobber-webhook] request_fetch errors', {
      itemId: ctx.itemId,
      globalId: requestGlobalId,
      errors: res.errors,
    })
    return { error: `request_fetch: ${res.errors[0]?.message || 'unknown'}` }
  }
  const reqRec = res.data?.request
  if (!reqRec) {
    console.error('[jobber-webhook] request_not_found_in_jobber', {
      itemId: ctx.itemId,
      globalId: requestGlobalId,
      data: res.data,
    })
    return { error: 'request_not_found_in_jobber' }
  }
  if (!reqRec.client?.id) return { error: 'request_missing_client' }

  // Hydrate the _has* flags so determineStage produces the right SR
  // classification (we don't promote the lead here, but the SR row's
  // own stage column should still reflect reality).
  reqRec._hasAssessment = !!reqRec.assessment
  reqRec._hasQuote      = (reqRec.quotes?.nodes || []).length > 0
  reqRec._hasJob        = (reqRec.jobs?.nodes   || []).length > 0
  reqRec._hasInvoice    = (reqRec.jobs?.nodes   || []).some(
    (j: any) => (j.invoices?.nodes || []).length > 0,
  )

  const lead = await upsertLead(
    reqRec.client,
    ctx.location.location_id,
    ctx.location.id,
    { importSource: 'jobber_webhook' },
  )

  const sr = await upsertServiceRequest(
    reqRec,
    lead.id,
    ctx.location.location_id,
    { promoteLead: false },
  )

  if (reqRec.assessment?.startAt) {
    await upsertAssessment(reqRec, sr.id, lead.id, ctx.location.location_id)
  }

  return {
    lead_id: lead.id,
    service_request_id: sr.id,
    lead_stage_before: sr.prev_lead_stage,
  }
}

// Apply a forward-only stage promotion + drip side-effects.
async function applyStagePromotion(
  leadId: string,
  locationUuid: string,
  newStage: string,
): Promise<{ prev_stage: string | null; lead_stage: string }> {
  const { prevStage, promoted } = await promoteLeadStage(leadId, newStage)
  if (promoted) {
    await applyDripSideEffects({
      leadId,
      locationUuid,
      prevStage,
      patch: { stage: newStage },
    })
    return { prev_stage: prevStage, lead_stage: newStage }
  }
  return { prev_stage: prevStage, lead_stage: prevStage || newStage }
}

// Fetch the current stage so handlers that don't promote can still
// report it in the response/sync_log.
async function readLeadStage(leadId: string): Promise<string | null> {
  const { data } = await supabaseService
    .from('leads')
    .select('stage')
    .eq('id', leadId)
    .maybeSingle()
  return data?.stage || null
}

// ── topic handlers ────────────────────────────────────────────

// REQUEST_CREATE → 'Request' (forward-only) + stamp request_created_at.
export async function handleRequestCreate(ctx: HandlerCtx): Promise<HandlerResult> {
  const globalId = encodeJobberId('Request', ctx.itemId)
  const res = await fetchAndUpsertRequest(globalId, ctx)
  if ('error' in res) return { processed: false, error: res.error }

  // Stamp the timeline timestamp regardless of promotion outcome.
  await supabaseService
    .from('leads')
    .update({
      request_created_at: ctx.occurredAt || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', res.lead_id)

  const promo = await applyStagePromotion(res.lead_id, ctx.location.id, 'Request')
  return {
    processed: true,
    lead_id: res.lead_id,
    lead_stage: promo.lead_stage,
    prev_stage: promo.prev_stage,
  }
}

// REQUEST_UPDATE → refresh fields, no stage change.
export async function handleRequestUpdate(ctx: HandlerCtx): Promise<HandlerResult> {
  const globalId = encodeJobberId('Request', ctx.itemId)
  const res = await fetchAndUpsertRequest(globalId, ctx)
  if ('error' in res) return { processed: false, error: res.error }
  const stage = await readLeadStage(res.lead_id)
  return {
    processed: true,
    lead_id: res.lead_id,
    lead_stage: stage,
    prev_stage: stage,
  }
}

// Internal: shared quote pipeline. `stagePromotion` is the target
// stage (or null for no promotion); `stampField` is the lead column
// that holds this event's timestamp (or null when none).
async function handleQuoteCore(
  ctx: HandlerCtx,
  stagePromotion: 'Estimate Sent' | null,
  stampField: 'quote_created_at' | 'quote_sent_at' | 'quote_approved_at' | null,
): Promise<HandlerResult> {
  const globalId = encodeJobberId('Quote', ctx.itemId)
  const res = await jobberGraphQL(ctx.location.location_id, SINGLE_QUOTE_QUERY, {
    id: globalId,
  })
  if (res.errors?.length) {
    console.error('[jobber-webhook] quote_fetch errors', {
      itemId: ctx.itemId,
      globalId,
      errors: res.errors,
    })
    return { processed: false, error: `quote_fetch: ${res.errors[0]?.message || 'unknown'}` }
  }
  const quoteRec = res.data?.quote
  if (!quoteRec) {
    console.error('[jobber-webhook] quote_not_found_in_jobber', {
      itemId: ctx.itemId,
      globalId,
      data: res.data,
    })
    return { processed: false, error: 'quote_not_found_in_jobber' }
  }
  const requestGlobalId = quoteRec.request?.id
  if (!requestGlobalId) return { processed: false, error: 'quote_missing_request' }

  let sr = await findServiceRequestByJobberId(requestGlobalId)
  let leadId: string

  if (sr) {
    leadId = sr.lead_id
  } else {
    const parent = await fetchAndUpsertRequest(requestGlobalId, ctx)
    if ('error' in parent) return { processed: false, error: parent.error }
    sr = { id: parent.service_request_id, lead_id: parent.lead_id }
    leadId = parent.lead_id
  }

  // Upsert the quotes row (sub-table source of truth).
  await upsertQuote(quoteRec, sr.id, leadId, ctx.location.location_id)

  // Lead-level denormalizations: id + amount, plus this event's timestamp.
  const stampValue = ctx.occurredAt || new Date().toISOString()
  const leadPatch: Record<string, any> = {
    jobber_quote_id: extractJobberId(quoteRec.id),
    estimate_amount: quoteRec.amounts?.total ? parseFloat(quoteRec.amounts.total) : null,
    updated_at: new Date().toISOString(),
  }
  if (stampField) leadPatch[stampField] = stampValue
  await supabaseService.from('leads').update(leadPatch).eq('id', leadId)

  if (stagePromotion) {
    const promo = await applyStagePromotion(leadId, ctx.location.id, stagePromotion)
    return {
      processed: true,
      lead_id: leadId,
      lead_stage: promo.lead_stage,
      prev_stage: promo.prev_stage,
    }
  }
  const stage = await readLeadStage(leadId)
  return { processed: true, lead_id: leadId, lead_stage: stage, prev_stage: stage }
}

// QUOTE_CREATE   → 'Estimate Sent' + quote_created_at
export function handleQuoteCreate(ctx: HandlerCtx) {
  return handleQuoteCore(ctx, 'Estimate Sent', 'quote_created_at')
}

// QUOTE_UPDATE   → no stage change, refresh fields only
export function handleQuoteUpdate(ctx: HandlerCtx) {
  return handleQuoteCore(ctx, null, null)
}

// QUOTE_SENT     → 'Estimate Sent' + quote_sent_at (idempotent on stage)
export function handleQuoteSent(ctx: HandlerCtx) {
  return handleQuoteCore(ctx, 'Estimate Sent', 'quote_sent_at')
}

// QUOTE_APPROVED → no stage change, stamp quote_approved_at
export function handleQuoteApproved(ctx: HandlerCtx) {
  return handleQuoteCore(ctx, null, 'quote_approved_at')
}

// Internal: shared job pipeline.
async function handleJobCore(
  ctx: HandlerCtx,
  stagePromotion: 'Closed Won' | null,
  stampField: 'job_created_at' | 'job_completed_at' | null,
): Promise<HandlerResult> {
  const globalId = encodeJobberId('Job', ctx.itemId)
  const res = await jobberGraphQL(ctx.location.location_id, SINGLE_JOB_QUERY, {
    id: globalId,
  })
  if (res.errors?.length) {
    console.error('[jobber-webhook] job_fetch errors', {
      itemId: ctx.itemId,
      globalId,
      errors: res.errors,
    })
    return { processed: false, error: `job_fetch: ${res.errors[0]?.message || 'unknown'}` }
  }
  const jobRec = res.data?.job
  if (!jobRec) {
    console.error('[jobber-webhook] job_not_found_in_jobber', {
      itemId: ctx.itemId,
      globalId,
      data: res.data,
    })
    return { processed: false, error: 'job_not_found_in_jobber' }
  }

  let sr: { id: string; lead_id: string } | null = null
  let leadId: string | null = null

  if (jobRec.request?.id) {
    sr = await findServiceRequestByJobberId(jobRec.request.id)
    if (!sr) {
      const parent = await fetchAndUpsertRequest(jobRec.request.id, ctx)
      if ('error' in parent) return { processed: false, error: parent.error }
      sr = { id: parent.service_request_id, lead_id: parent.lead_id }
    }
    leadId = sr.lead_id
  } else if (jobRec.client?.id) {
    const existing = await findLeadByJobberClientId(jobRec.client.id, ctx.location.location_id)
    if (existing) leadId = existing.id
  }

  if (!leadId) {
    return { processed: false, error: 'job_no_matching_lead' }
  }

  await upsertJob(jobRec, sr?.id || null, leadId, ctx.location.location_id)

  // Lead-level: jobber_job_id, scheduled_at (job.startAt), and the
  // event's own timestamp column.
  const leadPatch: Record<string, any> = {
    jobber_job_id: extractJobberId(jobRec.id),
    scheduled_at: jobRec.startAt || null,
    updated_at: new Date().toISOString(),
  }
  if (stampField) {
    leadPatch[stampField] = ctx.occurredAt || new Date().toISOString()
  }
  await supabaseService.from('leads').update(leadPatch).eq('id', leadId)

  if (stagePromotion) {
    const promo = await applyStagePromotion(leadId, ctx.location.id, stagePromotion)
    return {
      processed: true,
      lead_id: leadId,
      lead_stage: promo.lead_stage,
      prev_stage: promo.prev_stage,
    }
  }
  const stage = await readLeadStage(leadId)
  return { processed: true, lead_id: leadId, lead_stage: stage, prev_stage: stage }
}

// JOB_CREATE   → no stage change (Job in Progress is owner-driven)
//                + stamp job_created_at + scheduled_at + jobber_job_id
export function handleJobCreate(ctx: HandlerCtx) {
  return handleJobCore(ctx, null, 'job_created_at')
}

// JOB_UPDATE   → no stage change, refresh job data + scheduled_at
export function handleJobUpdate(ctx: HandlerCtx) {
  return handleJobCore(ctx, null, null)
}

// JOB_COMPLETE → 'Closed Won' (forward-only) + stamp job_completed_at
//                + stop drip via applyDripSideEffects
export function handleJobComplete(ctx: HandlerCtx) {
  return handleJobCore(ctx, 'Closed Won', 'job_completed_at')
}

// Internal: shared invoice pipeline.
async function handleInvoiceCore(
  ctx: HandlerCtx,
  paid: boolean,
): Promise<HandlerResult> {
  const globalId = encodeJobberId('Invoice', ctx.itemId)
  const res = await jobberGraphQL(ctx.location.location_id, SINGLE_INVOICE_QUERY, {
    id: globalId,
  })
  if (res.errors?.length) {
    console.error('[jobber-webhook] invoice_fetch errors', {
      itemId: ctx.itemId,
      globalId,
      errors: res.errors,
    })
    return { processed: false, error: `invoice_fetch: ${res.errors[0]?.message || 'unknown'}` }
  }
  const invRec = res.data?.invoice
  if (!invRec) {
    console.error('[jobber-webhook] invoice_not_found_in_jobber', {
      itemId: ctx.itemId,
      globalId,
      data: res.data,
    })
    return { processed: false, error: 'invoice_not_found_in_jobber' }
  }

  const firstJob = invRec.jobs?.nodes?.[0]
  let sr: { id: string; lead_id: string } | null = null
  let leadId: string | null = null
  let jobDbId: string | null = null

  if (firstJob?.request?.id) {
    sr = await findServiceRequestByJobberId(firstJob.request.id)
    if (!sr) {
      const parent = await fetchAndUpsertRequest(firstJob.request.id, ctx)
      if ('error' in parent) return { processed: false, error: parent.error }
      sr = { id: parent.service_request_id, lead_id: parent.lead_id }
    }
    leadId = sr.lead_id

    const jobNumeric = extractJobberId(firstJob.id)
    if (jobNumeric) {
      const { data: jobRow } = await supabaseService
        .from('jobs')
        .select('id')
        .eq('jobber_job_id', jobNumeric)
        .maybeSingle()
      jobDbId = jobRow?.id || null
    }
  } else if (invRec.client?.id) {
    const existing = await findLeadByJobberClientId(invRec.client.id, ctx.location.location_id)
    if (existing) leadId = existing.id
  }

  if (!leadId) {
    return { processed: false, error: 'invoice_no_matching_lead' }
  }

  await upsertInvoice(invRec, jobDbId, sr?.id || null, leadId, ctx.location.location_id)

  // Lead-level denormalizations.
  const totalNum = invRec.amounts?.total ? parseFloat(invRec.amounts.total) : null
  const stampIso = ctx.occurredAt || new Date().toISOString()
  const leadPatch: Record<string, any> = {
    jobber_invoice_id: extractJobberId(invRec.id),
    updated_at: new Date().toISOString(),
  }
  if (paid) {
    leadPatch.paid_amount = totalNum
    leadPatch.balance_owing = 0
    leadPatch.invoice_paid_at = stampIso
  } else {
    leadPatch.balance_owing = totalNum
    leadPatch.invoice_created_at = stampIso
  }
  await supabaseService.from('leads').update(leadPatch).eq('id', leadId)

  if (paid) {
    const promo = await applyStagePromotion(leadId, ctx.location.id, 'Closed Won')
    return {
      processed: true,
      lead_id: leadId,
      lead_stage: promo.lead_stage,
      prev_stage: promo.prev_stage,
    }
  }
  const stage = await readLeadStage(leadId)
  return { processed: true, lead_id: leadId, lead_stage: stage, prev_stage: stage }
}

// INVOICE_CREATE → no stage change + invoice_created_at + balance_owing
export function handleInvoiceCreate(ctx: HandlerCtx) {
  return handleInvoiceCore(ctx, false)
}

// INVOICE_PAID → 'Closed Won' + invoice_paid_at + paid_amount + stop drip
export function handleInvoicePaid(ctx: HandlerCtx) {
  return handleInvoiceCore(ctx, true)
}

// CLIENT_UPDATE — refresh name/email/phone/address. No stage change.
export async function handleClientUpdate(ctx: HandlerCtx): Promise<HandlerResult> {
  const globalId = encodeJobberId('Client', ctx.itemId)
  const res = await jobberGraphQL(ctx.location.location_id, SINGLE_CLIENT_QUERY, {
    id: globalId,
  })
  if (res.errors?.length) {
    console.error('[jobber-webhook] client_fetch errors', {
      itemId: ctx.itemId,
      globalId,
      errors: res.errors,
    })
    return { processed: false, error: `client_fetch: ${res.errors[0]?.message || 'unknown'}` }
  }
  const clientRec = res.data?.client
  if (!clientRec) {
    console.error('[jobber-webhook] client_not_found_in_jobber', {
      itemId: ctx.itemId,
      globalId,
      data: res.data,
    })
    return { processed: false, error: 'client_not_found_in_jobber' }
  }

  const lead = await upsertLead(
    clientRec,
    ctx.location.location_id,
    ctx.location.id,
    { importSource: 'jobber_webhook' },
  )

  return {
    processed: true,
    lead_id: lead.id,
    lead_stage: lead.stage,
    prev_stage: lead.stage,
  }
}

// ── dispatch table ────────────────────────────────────────────

export const TOPIC_HANDLERS: Record<string, (ctx: HandlerCtx) => Promise<HandlerResult>> = {
  REQUEST_CREATE: handleRequestCreate,
  REQUEST_UPDATE: handleRequestUpdate,
  QUOTE_CREATE:   handleQuoteCreate,
  QUOTE_UPDATE:   handleQuoteUpdate,
  QUOTE_SENT:     handleQuoteSent,
  QUOTE_APPROVED: handleQuoteApproved,
  JOB_CREATE:     handleJobCreate,
  JOB_UPDATE:     handleJobUpdate,
  JOB_COMPLETE:   handleJobComplete,
  INVOICE_CREATE: handleInvoiceCreate,
  INVOICE_PAID:   handleInvoicePaid,
  CLIENT_UPDATE:  handleClientUpdate,
}

export const SUPPORTED_TOPICS = Object.keys(TOPIC_HANDLERS)
