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
//   6. Phase 1 step-3 dual-write (ADDITIVE): REQUEST ingests found an
//      engagement (rule 1, via fetchAndUpsertRequest); QUOTE_/JOB_/
//      INVOICE_ topics resolve + attach their row to its engagement and
//      forward-only advance the ENGAGEMENT stage (lib/engagements.ts).
//      The lead-stage map below is untouched; the board still reads
//      leads until the step-4 read flip. Engagement failures log and
//      never affect the handler result.
//
// TOPIC → STAGE MAP (matches Kevin's spec):
//   REQUEST_CREATE   → 'Request'           forward-only
//   REQUEST_UPDATE   → (no change)         soft-destroys if Jobber returns
//                                          not-found (race: DESTROY may
//                                          arrive before UPDATE in a batch);
//                                          soft-destroy runs the same #66
//                                          cleanup as REQUEST_DESTROY.
//                                          ALSO (#122): requestStatus
//                                          'archived' runs the same #66
//                                          cleanup (childless SR + empty
//                                          engagement) but does NOT null
//                                          jobber_request_id — an archived
//                                          request still EXISTS in Jobber, so
//                                          the link must survive (nulling it
//                                          would let a re-import re-link and
//                                          fight the archive)
//   REQUEST_DESTROY  → (no change)         null jobber_request_id +
//                                          jobber_assessment_id on lead, then
//                                          delete the stale service_requests
//                                          mirror + soft-close the engagement
//                                          it founded when nothing else is
//                                          left (#66; fail-soft, never fails
//                                          the webhook)
//   QUOTE_CREATE     → 'Estimate Sent'     forward-only
//   QUOTE_UPDATE     → (no change)
//   QUOTE_SENT       → 'Estimate Sent'     forward-only (idempotent)
//   QUOTE_APPROVED   → 'Job in Progress'   forward-only + stamp quote_approved_at
//   QUOTE_DESTROY    → (no change)         null jobber_quote_id on lead
//   JOB_CREATE       → 'Job in Progress'   forward-only + stamp job_created_at +
//                                          scheduled_at (belt-and-suspenders with
//                                          QUOTE_APPROVED; idempotent via rank guard).
//                                          SKIPPED when the job is unbooked
//                                          (UNSCHEDULED / ACTION_REQUIRED /
//                                          ON_HOLD) — unbooked work is not in
//                                          progress (see handleJobCore)
//   JOB_UPDATE       → (no change) EXCEPT: promotes 'Job in Progress'
//                                          (forward-only) when the refreshed
//                                          status shows the job booked/underway
//                                          (BOOKED_JOB_STATUSES) — closes the
//                                          gap an unbooked JOB_CREATE leaves
//   JOB_COMPLETE     → 'Closed Won'     forward-only + stop drip
//   JOB_DESTROY      → (no change)      null jobber_job_id on lead
//   INVOICE_CREATE   → (no change)      stamp invoice_created_at +
//                                       balance_owing
//   INVOICE_UPDATE   → 'Closed Won' when the refreshed invoiceStatus is
//                                       PAID (forward-only + stop drip);
//                                       otherwise a balance_owing refresh,
//                                       no stage change. This is the topic
//                                       Jobber actually emits on payment
//                                       (mirrors JOB_UPDATE's derive-from-
//                                       status promotion).
//   INVOICE_PAID     → 'Closed Won'     forward-only + stop drip (kept
//                                       defensively; Jobber signals payment
//                                       via INVOICE_UPDATE in practice)
//   INVOICE_DESTROY  → (no change)      null jobber_invoice_id on lead
//   CLIENT_UPDATE    → (no change)      refresh name/email/phone. ALSO (#122):
//                                       isArchived true → stamp leads.archived_at
//                                       (lead drops off Inbox/active board) +
//                                       stop drip ('client_archived'); isArchived
//                                       false → clear archived_at (reactivate,
//                                       drips stay stopped). NEVER nulls links,
//                                       deletes, marks won, or closes engagements.
//   CLIENT_DESTROY   → (no change)      null ALL jobber_*_id columns on
//                                       lead (full Jobber link break)
//   PROPERTY_CREATE  → (no change)      sync property → lead address;
//                                       set jobber_property_id
//   PROPERTY_UPDATE  → (no change)      same as PROPERTY_CREATE
//   PROPERTY_DESTROY → (no change)      null jobber_property_id on lead
//                                       (address fields preserved —
//                                       Bee Hub's record)
//   ASSESSMENT_DESTROY → (no change)    null jobber_assessment_id on
//                                       lead (keep jobber_request_id)
//   APP_DISCONNECT   → (no change)      null tokens +
//                                       jobber_connected=false on
//                                       location. Preserves
//                                       jobber_account_id + hub_users
//                                       .jobber_user_id for reconnect.
//
// In every destroy case the Bee Hub lead row PERSISTS — only the
// Jobber linkage is nulled. Bee Hub's source-of-truth for the
// customer relationship survives Jobber-side deletes.
//
// Handlers never throw out — failures bubble back as a string
// `error` field, so the dispatcher can still 200 to Jobber and
// keep a sync_log row for diagnosis.
// ─────────────────────────────────────────────────────────────

import { jobberGraphQL } from './jobber'
import { supabaseService } from './supabase-service'
import { applyDripSideEffects, stopActiveDripsForLead } from './drip-lifecycle'
import { disconnectJobberFromLocation } from './jobber-disconnect'
import {
  SINGLE_CLIENT_QUERY,
  SINGLE_REQUEST_QUERY,
  SINGLE_QUOTE_QUERY,
  SINGLE_JOB_QUERY,
  SINGLE_INVOICE_QUERY,
  SINGLE_PROPERTY_QUERY,
  upsertLead,
  upsertServiceRequest,
  upsertAssessment,
  upsertQuote,
  upsertJob,
  upsertInvoice,
  extractJobberId,
  encodeJobberId,
  promoteLeadStage,
  isUnbookedJobStatus,
  BOOKED_JOB_STATUSES,
} from './jobber-import'
import {
  ensureEngagementForServiceRequest,
  resolveEngagementForChild,
  attachToEngagement,
  maybeAdvanceEngagementStage,
} from './engagements'
import type { LocationRow } from './jobber-webhook'

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
  // `note` is rendered into the sync_log message verbatim (see route.ts).
  // Use it to surface destroy-style "what happened" detail that wouldn't
  // otherwise be visible from the bare topic + itemId.
  note?: string
  error?: string
}

// Webhook payloads ship itemId in either form: bare numeric ("136289662")
// or the full base64-encoded GraphQL global id
// ("Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzYyODk2NjI="). encodeJobberId normalizes to
// numeric first, then rebuilds the canonical global id — so base64-input
// isn't double-wrapped (which would resolve to null → "<entity>_not_found_
// in_jobber" even though the record exists). Shared from ./jobber-import.

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
  locationSlug: string,
): Promise<{ id: string; lead_id: string } | null> {
  const numeric = extractJobberId(jobberRequestGlobalId)
  if (!numeric) return null
  const { data } = await supabaseService
    .from('service_requests')
    .select('id, lead_id')
    .eq('jobber_request_id', numeric)
    .eq('location_id', locationSlug)
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
type FetchRequestOk = { lead_id: string; service_request_id: string; lead_stage_before: string | null }
// Overloads: the { archived: true } outcome is reachable ONLY when the caller
// opts into archivedCleanup (handleRequestUpdate). Every other caller
// (handleRequestCreate + the quote/job/invoice fallbacks) gets the plain union
// and never has to narrow a branch it can't hit.
async function fetchAndUpsertRequest(
  requestGlobalId: string,
  ctx: HandlerCtx,
): Promise<FetchRequestOk | { error: string }>
async function fetchAndUpsertRequest(
  requestGlobalId: string,
  ctx: HandlerCtx,
  opts: { archivedCleanup: true },
): Promise<FetchRequestOk | { archived: true } | { error: string }>
async function fetchAndUpsertRequest(
  requestGlobalId: string,
  ctx: HandlerCtx,
  opts?: { archivedCleanup?: boolean },
): Promise<FetchRequestOk | { archived: true } | { error: string }> {
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

  // Archive short-circuit — REQUEST_UPDATE path only (opts.archivedCleanup).
  // An archived request is torn down by the #66 stale-mirror cleanup, so
  // re-upserting the SR and re-founding its engagement only to delete them is
  // pure churn — and on webhook re-delivery would spawn a throwaway engagement
  // each round. The quote/job/invoice fallback callers deliberately do NOT
  // pass the flag: a quote or job on an archived request is real downstream
  // work whose SR the cleanup keeps, so those still ingest normally.
  //
  // Archive rides requestStatus (there is NO Request.isArchived); the enum
  // value is the lowercase 'archived' (introspected live, API 2025-04-16).
  if (opts?.archivedCleanup && reqRec.requestStatus === 'archived') {
    return { archived: true }
  }

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

  let assessmentDbId: string | null = null
  if (reqRec.assessment?.startAt) {
    const aRes = await upsertAssessment(reqRec, sr.id, lead.id, ctx.location.location_id)
    assessmentDbId = aRes?.id ?? null
  }

  // Dual-write (step 3): rule 1 — every request founds an engagement.
  // Sits here (not just REQUEST_CREATE) so the quote/job/invoice
  // fallback ingests also found. Assessments attach alongside (no
  // ASSESSMENT_CREATE/UPDATE webhook topics exist — they ride in on
  // REQUEST fetches). Additive: failures log, never bubble.
  try {
    const ens = await ensureEngagementForServiceRequest(sr.id, lead.id)
    if (ens?.id && assessmentDbId) {
      await attachToEngagement('assessments', assessmentDbId, ens.id)
    }
  } catch (err: any) {
    console.error('[engagements] request founding failed (webhook)', err?.message || err)
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
//
// Two teardown branches, both reusing the #66 stale-mirror + engagement tidy:
//
//   1. Race-condition fallback: Jobber returns request_not_found_in_jobber —
//      the request was destroyed between the UPDATE event being queued and us
//      fetching it (Jobber sometimes ships DESTROY before UPDATE in the same
//      batch). Treat as a soft DESTROY: the record is gone, so we also null
//      the lead's jobber_request_id linkage (nullifyLeadJobberColumns).
//
//   2. Archive (#122): the fetch succeeds with requestStatus === 'archived'.
//      Archiving in Jobber does NOT emit a DESTROY — it arrives as this bare
//      UPDATE, and the archive state lives in requestStatus (never fetched
//      before). In EFFECT an archived request is like a destroy — the #66
//      cleanup deletes a childless SR mirror and soft-closes the engagement it
//      founded — but with ONE critical divergence: we do NOT null
//      jobber_request_id. The request still EXISTS in Jobber; nulling the link
//      would let a re-fetch / re-import re-link it and fight the archive.
export async function handleRequestUpdate(ctx: HandlerCtx): Promise<HandlerResult> {
  const globalId = encodeJobberId('Request', ctx.itemId)
  const res = await fetchAndUpsertRequest(globalId, ctx, { archivedCleanup: true })
  if ('error' in res) {
    if (res.error === 'request_not_found_in_jobber') {
      const spec = DESTROY_SPECS.REQUEST_DESTROY
      const destroyed = await nullifyLeadJobberColumns(
        ctx,
        spec.match,
        spec.nulls,
        'REQUEST_UPDATE→soft-destroy',
      )
      // Same stale-mirror + engagement tidy as REQUEST_DESTROY (#66).
      await applyRequestDestroyCleanup(ctx, destroyed)
      return destroyed
    }
    return { processed: false, error: res.error }
  }
  if ('archived' in res) {
    // Archived request: run the SAME #66 cleanup, but NEVER null
    // jobber_request_id (the request still exists — see above). We reach
    // cleanup WITHOUT nullifyLeadJobberColumns, so the linkage is preserved by
    // construction. The '→archived' note (no 'soft-destroy' substring) keeps
    // the landed check out of the destroy-column verification path.
    const result: HandlerResult = { processed: true, note: 'REQUEST_UPDATE→archived' }
    await applyRequestDestroyCleanup(ctx, result)
    return result
  }
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
  stagePromotion: 'Estimate Sent' | 'Job in Progress' | null,
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
  // Requestless quotes (created directly on a client — live quote-first
  // bookings) fall back to client{id}, same shape as handleJobCore. They
  // used to hard-drop here as quote_missing_request.
  let sr: { id: string; lead_id: string } | null = null
  let leadId: string | null = null

  if (quoteRec.request?.id) {
    sr = await findServiceRequestByJobberId(quoteRec.request.id, ctx.location.location_id)
    if (!sr) {
      const parent = await fetchAndUpsertRequest(quoteRec.request.id, ctx)
      if ('error' in parent) return { processed: false, error: parent.error }
      sr = { id: parent.service_request_id, lead_id: parent.lead_id }
    }
    leadId = sr.lead_id
  } else if (quoteRec.client?.id) {
    const existing = await findLeadByJobberClientId(quoteRec.client.id, ctx.location.location_id)
    if (existing) leadId = existing.id
  }

  if (!leadId) {
    return { processed: false, error: 'quote_no_matching_lead' }
  }

  // Upsert the quotes row (sub-table source of truth).
  const qRes = await upsertQuote(quoteRec, sr?.id || null, leadId, ctx.location.location_id)

  // Dual-write (step 3): resolve + attach + forward-only stage advance.
  // Additive: leads.stage promotion below is untouched.
  try {
    const engId = await resolveEngagementForChild({
      childTable: 'quotes',
      childId: qRes.id,
      leadId,
      serviceRequestId: sr?.id || null,
      locationSlug: ctx.location.location_id,
    })
    if (engId) {
      await attachToEngagement('quotes', qRes.id, engId)
      await maybeAdvanceEngagementStage(engId)
    }
  } catch (err: any) {
    console.error('[engagements] quote dual-write failed', err?.message || err)
  }

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

// QUOTE_APPROVED → 'Job in Progress' (forward-only) + stamp quote_approved_at
export function handleQuoteApproved(ctx: HandlerCtx) {
  return handleQuoteCore(ctx, 'Job in Progress', 'quote_approved_at')
}

// Internal: shared job pipeline.
async function handleJobCore(
  ctx: HandlerCtx,
  stagePromotion: 'Job in Progress' | 'Closed Won' | null,
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
    sr = await findServiceRequestByJobberId(jobRec.request.id, ctx.location.location_id)
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

  // Stage promotion is conditional on the job being booked work.
  // Unbooked jobs (unscheduled / action_required / on_hold — nothing on
  // the calendar, nothing underway) are not in progress (see JOB_STATUS
  // / BOOKED_JOB_STATUSES in jobber-import.ts) — so JOB_CREATE for one
  // keeps the lead where it is (job_created_at still stamps; the
  // timeline is true either way). Symmetrically, JOB_UPDATE — which
  // never promoted before — promotes when the refreshed status shows the
  // job booked or underway, so a job created unbooked doesn't strand its
  // lead when it finally lands on the calendar. JOB_COMPLETE ('Closed
  // Won') stays unconditional, and every promotion remains forward-only
  // via applyStagePromotion.
  let promotion = stagePromotion
  if (stagePromotion === 'Job in Progress' && isUnbookedJobStatus(jobRec.jobStatus)) {
    promotion = null
  }
  if (stagePromotion === null && BOOKED_JOB_STATUSES.has((jobRec.jobStatus || '').toUpperCase())) {
    promotion = 'Job in Progress'
  }

  const jRes = await upsertJob(jobRec, sr?.id || null, leadId, ctx.location.location_id)

  // Dual-write (step 3): resolve via SR, then Job.quote (jobs.quote_id,
  // resolved inside upsertJob), then rule-5 fallbacks. Additive.
  try {
    const engId = await resolveEngagementForChild({
      childTable: 'jobs',
      childId: jRes.id,
      leadId,
      serviceRequestId: sr?.id || null,
      quoteDbId: jRes.quote_db_id ?? null,
      title: jobRec.title || null,
      locationSlug: ctx.location.location_id,
    })
    if (engId) {
      await attachToEngagement('jobs', jRes.id, engId)
      await maybeAdvanceEngagementStage(engId)
    }
  } catch (err: any) {
    console.error('[engagements] job dual-write failed', err?.message || err)
  }

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

  if (promotion) {
    const promo = await applyStagePromotion(leadId, ctx.location.id, promotion)
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

// JOB_CREATE → 'Job in Progress' (forward-only) + stamp job_created_at + scheduled_at
//              (promotion skipped for unbooked jobs — see handleJobCore)
export function handleJobCreate(ctx: HandlerCtx) {
  return handleJobCore(ctx, 'Job in Progress', 'job_created_at')
}

// JOB_UPDATE   → refresh job data + scheduled_at; promotes 'Job in Progress'
//                only when the job is booked/underway (see handleJobCore)
export function handleJobUpdate(ctx: HandlerCtx) {
  return handleJobCore(ctx, null, null)
}

// JOB_COMPLETE → 'Closed Won' (forward-only) + stamp job_completed_at
//                + stop drip via applyDripSideEffects
export function handleJobComplete(ctx: HandlerCtx) {
  return handleJobCore(ctx, 'Closed Won', 'job_completed_at')
}

// Internal: shared invoice pipeline.
//
// `mode` decides how paid-ness is resolved:
//   'create' → treat as a fresh (unpaid) invoice: stamp invoice_created_at,
//              refresh balance_owing, no stage promotion.
//   'paid'   → treat as paid: stamp invoice_paid_at, zero the balance,
//              promote lead → 'Closed Won'.
//   'update' → DERIVE from the fetched invoiceStatus, exactly the way
//              JOB_UPDATE derives its promotion from the refreshed
//              jobStatus. Jobber emits INVOICE_UPDATE (not a distinct
//              INVOICE_PAID) when an invoice is marked paid, so a
//              now-PAID update behaves like 'paid'; any other update just
//              refreshes the invoice row + balance_owing, no stamp/promo.
// Either way, upsertInvoice writes the invoices row's status/balance from
// invoiceStatus, so the engagement re-derivation (maybeAdvanceEngagementStage,
// live mode → rests done+paid at Final Processing) is correct regardless of
// which topic fired.
async function handleInvoiceCore(
  ctx: HandlerCtx,
  mode: 'create' | 'paid' | 'update',
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

  // Ground truth for paid-ness is the fetched record, not the topic.
  // 'update' derives from it (INVOICE_UPDATE is what fires on payment);
  // 'paid'/'create' keep their explicit intent.
  const isPaid = (invRec.invoiceStatus || '').toUpperCase() === 'PAID'
  const paid = mode === 'paid' || (mode === 'update' && isPaid)

  const firstJob = invRec.jobs?.nodes?.[0]
  let sr: { id: string; lead_id: string } | null = null
  let leadId: string | null = null
  let jobDbId: string | null = null

  // The job lookup is deliberately NOT gated on the job having a parent
  // request. Jobber allows a job with no request (booked straight off a
  // quote, or created by hand), and that job still identifies the invoice's
  // engagement via rule 3. While this lived inside the request branch, every
  // requestless job's invoice came through with job_id null — so
  // resolveEngagementForChild had no rule-3 key, and the invoice orphaned.
  if (firstJob?.id) {
    const jobNumeric = extractJobberId(firstJob.id)
    if (jobNumeric) {
      const { data: jobRow } = await supabaseService
        .from('jobs')
        .select('id')
        .eq('jobber_job_id', jobNumeric)
        .maybeSingle()
      jobDbId = jobRow?.id || null
    }
  }

  if (firstJob?.request?.id) {
    sr = await findServiceRequestByJobberId(firstJob.request.id, ctx.location.location_id)
    if (!sr) {
      const parent = await fetchAndUpsertRequest(firstJob.request.id, ctx)
      if ('error' in parent) return { processed: false, error: parent.error }
      sr = { id: parent.service_request_id, lead_id: parent.lead_id }
    }
    leadId = sr.lead_id
  } else if (invRec.client?.id) {
    const existing = await findLeadByJobberClientId(invRec.client.id, ctx.location.location_id)
    if (existing) leadId = existing.id
  }

  if (!leadId) {
    return { processed: false, error: 'invoice_no_matching_lead' }
  }

  const iRes = await upsertInvoice(invRec, jobDbId, sr?.id || null, leadId, ctx.location.location_id)

  // Dual-write (step 3): invoice attaches via its job (then SR / rule-5
  // fallbacks). Additive.
  let attachNote: string | undefined
  try {
    const engId = await resolveEngagementForChild({
      childTable: 'invoices',
      childId: iRes.id,
      leadId,
      serviceRequestId: sr?.id || null,
      jobDbId,
      locationSlug: ctx.location.location_id,
    })
    if (engId) {
      await attachToEngagement('invoices', iRes.id, engId)
      await maybeAdvanceEngagementStage(engId)
    } else {
      // Unattachable: the row is written but belongs to no engagement, so it
      // contributes to no rollup and shows on no board. checkLanded already
      // records not_landed for this; the note carries the WHY into the
      // sync_log message so the digest doesn't just say "didn't land".
      attachNote = `engagement unresolved (job_id=${jobDbId ?? 'null'} sr=${sr?.id ?? 'null'}) — invoice written but unattached`
      console.error('[engagements] invoice unattachable', {
        invoiceDbId: iRes.id, leadId, jobDbId, srId: sr?.id ?? null,
      })
    }
  } catch (err: any) {
    attachNote = `engagement dual-write failed: ${err?.message || err}`
    console.error('[engagements] invoice dual-write failed', err?.message || err)
  }

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
    // invoice_created_at is a create-time stamp only — an unpaid UPDATE
    // (JOB_UPDATE-style refresh) must not re-stamp it.
    if (mode === 'create') leadPatch.invoice_created_at = stampIso
  }
  await supabaseService.from('leads').update(leadPatch).eq('id', leadId)

  if (paid) {
    const promo = await applyStagePromotion(leadId, ctx.location.id, 'Closed Won')
    return {
      processed: true,
      lead_id: leadId,
      lead_stage: promo.lead_stage,
      prev_stage: promo.prev_stage,
      ...(attachNote ? { note: attachNote } : {}),
    }
  }
  const stage = await readLeadStage(leadId)
  return {
    processed: true,
    lead_id: leadId,
    lead_stage: stage,
    prev_stage: stage,
    ...(attachNote ? { note: attachNote } : {}),
  }
}

// INVOICE_CREATE → no stage change + invoice_created_at + balance_owing
export function handleInvoiceCreate(ctx: HandlerCtx) {
  return handleInvoiceCore(ctx, 'create')
}

// INVOICE_PAID → 'Closed Won' + invoice_paid_at + paid_amount + stop drip
// (Jobber appears to signal payment via INVOICE_UPDATE instead — kept wired
// defensively so a real INVOICE_PAID delivery is never dropped.)
export function handleInvoicePaid(ctx: HandlerCtx) {
  return handleInvoiceCore(ctx, 'paid')
}

// INVOICE_UPDATE → refresh the invoice row; derive paid-ness from the
// refreshed invoiceStatus (mirrors JOB_UPDATE). A now-PAID invoice promotes
// like INVOICE_PAID (→ 'Closed Won' on the lead board; engagement rests at
// Final Processing in live mode); any other update is a balance refresh.
// This is the topic Jobber actually emits when an invoice is marked paid,
// so it drives the live "fully paid → Close Won reachable" chain.
export function handleInvoiceUpdate(ctx: HandlerCtx) {
  return handleInvoiceCore(ctx, 'update')
}

// CLIENT_UPDATE — refresh name/email/phone/address. No stage change.
//
// #122 archive branch: archiving a client in Jobber emits this bare UPDATE (not
// a DESTROY), carrying Client.isArchived. The client STILL EXISTS and stays a
// lead — archive is a soft-inactive state, not a link break:
//   • isArchived true  → stamp leads.archived_at (idempotent) so the lead drops
//     off the Inbox / active board / active lists, and stop any active drip
//     (reason 'client_archived'). NEVER null Jobber links, delete the lead, or
//     mark it won. Open engagements are deliberately left untouched (archiving
//     says the person is inactive, NOT that the deal was lost) — they drop off
//     the active board via the archived-lead exclusion, still reachable in the
//     client's record and via Search.
//   • isArchived false → un-archive: clear archived_at (reactivates the lead).
//     Drips stay stopped — the owner re-activates by hand (the #112 re-spam
//     guard); reactivating a lead is not re-enrolling marketing.
// Fail-soft: an archive-bookkeeping error never fails the webhook.
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

  let archiveNote: string | undefined
  try {
    if (clientRec.isArchived === true) {
      // Stamp archived_at only if not already set — preserves the original
      // archive time across repeat CLIENT_UPDATEs (idempotent redelivery).
      const { error: aErr } = await supabaseService
        .from('leads')
        .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', lead.id)
        .is('archived_at', null)
      if (aErr) throw new Error(aErr.message)
      // Idempotent: only touches non-stopped drip rows.
      await stopActiveDripsForLead(lead.id, 'client_archived')
      // State-based note (fires whether or not THIS delivery stamped) so the
      // landed check verifies archived_at is set even on redelivery.
      archiveNote = 'CLIENT_UPDATE→archived'
    } else {
      // Un-archive: clear only if currently set, so a normal (non-archive)
      // client update stays a plain field refresh with no note.
      const { data: cleared, error: uErr } = await supabaseService
        .from('leads')
        .update({ archived_at: null, updated_at: new Date().toISOString() })
        .eq('id', lead.id)
        .not('archived_at', 'is', null)
        .select('id')
      if (uErr) throw new Error(uErr.message)
      if (cleared && cleared.length > 0) archiveNote = 'CLIENT_UPDATE→unarchived'
    }
  } catch (err: any) {
    console.error('[jobber-webhook] CLIENT_UPDATE archive bookkeeping failed (webhook still processed)', {
      itemId: ctx.itemId,
      location: ctx.location.location_id,
      error: err?.message || err,
    })
  }

  return {
    processed: true,
    lead_id: lead.id,
    lead_stage: lead.stage,
    prev_stage: lead.stage,
    ...(archiveNote ? { note: archiveNote } : {}),
  }
}

// ── destroy + disconnect handlers ─────────────────────────────
//
// Destroy webhooks ship only { topic, accountId, itemId, occurredAt } —
// the resource is already gone in Jobber, so there's nothing to fetch.
// The handler just finds the matching Bee Hub lead by the column that
// stores this Jobber ID and nulls the relevant linkage column(s).
//
// The lead row itself is never deleted: Bee Hub is the source of truth
// for the customer relationship, and the owner may still want to work
// the lead even after the Jobber-side artifact has been removed.

type JobberMatchColumn =
  | 'jobber_client_id'
  | 'jobber_property_id'
  | 'jobber_request_id'
  | 'jobber_quote_id'
  | 'jobber_job_id'
  | 'jobber_invoice_id'
  | 'jobber_assessment_id'

// Single source for which lead columns each destroy topic matches on and
// nulls. The handlers below write from this map, and lib/webhook-landed.ts
// verifies the same columns afterward — sharing it means the "landed"
// check can never drift from what the handler actually nulled.
export const DESTROY_SPECS: Record<
  string,
  { match: JobberMatchColumn; nulls: string[] }
> = {
  REQUEST_DESTROY:    { match: 'jobber_request_id',    nulls: ['jobber_request_id', 'jobber_assessment_id'] },
  QUOTE_DESTROY:      { match: 'jobber_quote_id',      nulls: ['jobber_quote_id'] },
  JOB_DESTROY:        { match: 'jobber_job_id',        nulls: ['jobber_job_id'] },
  INVOICE_DESTROY:    { match: 'jobber_invoice_id',    nulls: ['jobber_invoice_id'] },
  ASSESSMENT_DESTROY: { match: 'jobber_assessment_id', nulls: ['jobber_assessment_id'] },
  PROPERTY_DESTROY:   { match: 'jobber_property_id',   nulls: ['jobber_property_id'] },
  CLIENT_DESTROY: {
    match: 'jobber_client_id',
    nulls: [
      'jobber_client_id',
      'jobber_property_id',
      'jobber_request_id',
      'jobber_assessment_id',
      'jobber_job_id',
      'jobber_quote_id',
      'jobber_invoice_id',
    ],
  },
}

// Shared "find lead by jobber_<x>_id, null these columns" helper used
// by every destroy handler and the REQUEST_UPDATE soft-destroy fallback.
async function nullifyLeadJobberColumns(
  ctx: HandlerCtx,
  matchColumn: JobberMatchColumn,
  nullColumns: string[],
  noun: string,
): Promise<HandlerResult> {
  const numeric = extractJobberId(ctx.itemId) || ctx.itemId
  const { data: lead } = await supabaseService
    .from('leads')
    .select('id, name, stage')
    .eq(matchColumn, numeric)
    .eq('location_id', ctx.location.location_id)
    .maybeSingle()

  if (!lead) {
    // No-op: the Jobber record was never imported into this location.
    // Common when a record is created + deleted faster than the import
    // catches it, or when destroy webhooks fire for old records that
    // pre-date this location's Bee Hub connection.
    return {
      processed: true,
      note: `${noun}: no matching lead for ${matchColumn}=${numeric} (no-op)`,
    }
  }

  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  for (const col of nullColumns) patch[col] = null
  await supabaseService.from('leads').update(patch).eq('id', lead.id)

  return {
    processed: true,
    lead_id: lead.id,
    lead_stage: lead.stage || null,
    prev_stage: lead.stage || null,
    note: `${noun}: nulled ${nullColumns.join(', ')} on lead ${lead.id}`,
  }
}

// REQUEST_DESTROY → null jobber_request_id + jobber_assessment_id (paired)
// on the lead, then tidy the stale service_requests mirror + its engagement
// (see cleanupDestroyedRequest / applyRequestDestroyCleanup below).
export async function handleRequestDestroy(ctx: HandlerCtx): Promise<HandlerResult> {
  const spec = DESTROY_SPECS.REQUEST_DESTROY
  const result = await nullifyLeadJobberColumns(ctx, spec.match, spec.nulls, 'REQUEST_DESTROY')
  await applyRequestDestroyCleanup(ctx, result)
  return result
}

// ── stale-request cleanup (#66) ───────────────────────────────
//
// A REQUEST_DESTROY (or the REQUEST_UPDATE soft-destroy fallback) means
// Jobber deleted the request. nullifyLeadJobberColumns clears the lead's
// linkage columns — but those are only ever set by the Send-to-Jobber path;
// the import pipeline never writes leads.jobber_request_id (upsertLead only
// stamps jobber_client_id). So for an *imported* request that lead match
// no-ops, and the real mirror — the service_requests row — is left behind: a
// phantom "Request" on the engagement card (confirmed live, loc_test 7/24).
// The reliable key is the SR table itself, which always carries
// jobber_request_id.
//
// This is BOOKKEEPING and the caller MUST fail-soft: the Jobber-side delete
// already committed, so a cleanup failure must never fail the webhook.
// cleanupDestroyedRequest may throw on a hard DB error;
// applyRequestDestroyCleanup owns the try/catch.
//
// Safe by construction:
//   • An SR with downstream work (a quote/job/invoice references it via
//     service_request_id) is real history — left intact, engagement
//     untouched. This also keeps the delete FK-safe: we never delete a row
//     other rows point at.
//   • Only a request-founded engagement left with nothing is closed, and it
//     is SOFT-closed (Closed Lost / closed_reason='request_destroyed'),
//     never deleted — the engagement's assignee join is ON DELETE CASCADE, so
//     a delete would erase the crew (the #66 trap). Manual containers
//     (founded_by='manual') and engagements still holding other children are
//     left exactly as-is, stage untouched.
async function cleanupDestroyedRequest(ctx: HandlerCtx): Promise<string | null> {
  const numeric = extractJobberId(ctx.itemId) || ctx.itemId

  const { data: sr, error: srErr } = await supabaseService
    .from('service_requests')
    .select('id, lead_id, engagement_id')
    .eq('jobber_request_id', numeric)
    .eq('location_id', ctx.location.location_id)
    .maybeSingle()
  if (srErr) throw new Error(`SR lookup: ${srErr.message}`)
  if (!sr) return null // request was never imported into this location — no-op

  // Existence probe via select+limit(1) (NOT count(): PostgREST aggregates
  // are disabled here — see engagementHasServiceRequest for the same idiom).
  const anyRows = async (table: string, col: string, val: string): Promise<boolean> => {
    const { data, error } = await supabaseService.from(table).select('id').eq(col, val).limit(1)
    if (error) throw new Error(`${table}.${col} check: ${error.message}`)
    return (data?.length ?? 0) > 0
  }

  // SR that produced downstream work is legitimate history: leave it and the
  // engagement fully intact (stage untouched).
  const hasChildWork =
    (await anyRows('quotes', 'service_request_id', sr.id)) ||
    (await anyRows('jobs', 'service_request_id', sr.id)) ||
    (await anyRows('invoices', 'service_request_id', sr.id))
  if (hasChildWork) {
    return `REQUEST_DESTROY: SR ${sr.id} kept — has downstream quote/job/invoice`
  }

  // Childless SR = the request never advanced. Its Jobber assessment (if any)
  // was destroyed with the request; drop our mirror child first (FK), then
  // the SR row.
  const { error: aErr } = await supabaseService
    .from('assessments')
    .delete()
    .eq('service_request_id', sr.id)
  if (aErr) throw new Error(`assessment delete: ${aErr.message}`)
  const { error: dErr } = await supabaseService
    .from('service_requests')
    .delete()
    .eq('id', sr.id)
  if (dErr) throw new Error(`SR delete: ${dErr.message}`)

  const engId = sr.engagement_id
  if (!engId) return `REQUEST_DESTROY: deleted stale SR ${sr.id} (no engagement)`

  const { data: eng, error: eErr } = await supabaseService
    .from('engagements')
    .select('id, stage, founded_by')
    .eq('id', engId)
    .maybeSingle()
  if (eErr) throw new Error(`engagement read: ${eErr.message}`)
  if (!eng) return `REQUEST_DESTROY: deleted stale SR ${sr.id}`

  // Only an engagement this request FOUNDED is a candidate to close. A manual
  // container (or a quote/job-founded engagement) keeps its own meaning even
  // with this SR gone.
  if (eng.founded_by !== 'request') {
    return `REQUEST_DESTROY: deleted stale SR ${sr.id}; engagement ${engId} left (founded_by=${eng.founded_by})`
  }

  // Anything else still hanging off the engagement? (another SR, or a
  // quote/job/invoice attached by engagement_id) → real work remains: leave
  // it, stage untouched.
  const stillHasChildren =
    (await anyRows('service_requests', 'engagement_id', engId)) ||
    (await anyRows('quotes', 'engagement_id', engId)) ||
    (await anyRows('jobs', 'engagement_id', engId)) ||
    (await anyRows('invoices', 'engagement_id', engId))
  if (stillHasChildren) {
    return `REQUEST_DESTROY: deleted stale SR ${sr.id}; engagement ${engId} left (other children remain)`
  }

  // Already terminal — idempotent re-delivery, or a human already closed it.
  if (eng.stage === 'Closed Won' || eng.stage === 'Closed Lost') {
    return `REQUEST_DESTROY: deleted stale SR ${sr.id}; engagement ${engId} already ${eng.stage}`
  }

  // Nothing left to represent → SOFT-close. Never delete (assignee cascade).
  // closed_reason='request_destroyed' is a human-close reason, so the panel's
  // drift recovery (which only re-derives stale_on_import closes) leaves it.
  const nowIso = new Date().toISOString()
  const { error: uErr } = await supabaseService
    .from('engagements')
    .update({
      stage: 'Closed Lost',
      closed_reason: 'request_destroyed',
      closed_at: nowIso,
      closed_note: 'Founding Jobber request was deleted; no other work on this engagement.',
      stage_entered_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', engId)
  if (uErr) throw new Error(`engagement close: ${uErr.message}`)

  return `REQUEST_DESTROY: deleted stale SR ${sr.id}; closed empty engagement ${engId} (request_destroyed)`
}

// Fail-soft wrapper: the SR-mirror + engagement tidy must NEVER fail the
// webhook (the Jobber-side delete already committed). Enriches the result
// note when cleanup did work; swallows + logs any error otherwise. Shared by
// REQUEST_DESTROY and the REQUEST_UPDATE soft-destroy fallback.
async function applyRequestDestroyCleanup(ctx: HandlerCtx, result: HandlerResult): Promise<void> {
  try {
    const note = await cleanupDestroyedRequest(ctx)
    if (note) result.note = result.note ? `${result.note}; ${note}` : note
  } catch (err: any) {
    console.error('[jobber-webhook] REQUEST_DESTROY cleanup failed (webhook still processed)', {
      itemId: ctx.itemId,
      location: ctx.location.location_id,
      error: err?.message || err,
    })
  }
}

// QUOTE_DESTROY → null jobber_quote_id
export function handleQuoteDestroy(ctx: HandlerCtx) {
  const spec = DESTROY_SPECS.QUOTE_DESTROY
  return nullifyLeadJobberColumns(ctx, spec.match, spec.nulls, 'QUOTE_DESTROY')
}

// JOB_DESTROY → null jobber_job_id on the lead, AND mark the jobs row(s)
// deleted + re-derive their engagement.
//
// Before this, the jobs ROW was left untouched at its last known status —
// so a job deleted mid-flight froze its engagement at 'Job in Progress'
// forever (nothing re-derived, and the frozen 'upcoming' row read as live
// work), and a deleted done-job kept reading as done. Marking the row
// 'deleted' (never removing it — it is the record that work was once
// agreed) makes it invisible to stage classification, and the re-derive
// closes an all-deleted, never-invoiced engagement as Closed Lost
// ('job_deleted', Reopen-able) through the same gated advance path the
// archived-quote close uses. Fail-soft: the row marking and re-derive
// never fail the webhook — the lead nullify above already landed.
export async function handleJobDestroy(ctx: HandlerCtx): Promise<HandlerResult> {
  const spec = DESTROY_SPECS.JOB_DESTROY
  const res = await nullifyLeadJobberColumns(ctx, spec.match, spec.nulls, 'JOB_DESTROY')
  try {
    const { data: rows, error } = await supabaseService
      .from('jobs')
      .select('id, engagement_id, status')
      .eq('jobber_job_id', ctx.itemId)
      .eq('location_id', ctx.location.location_id)
    if (error) throw new Error(error.message)
    for (const row of rows || []) {
      await supabaseService
        .from('jobs')
        .update({ status: 'deleted', updated_at: new Date().toISOString() })
        .eq('id', row.id)
      if (row.engagement_id) await maybeAdvanceEngagementStage(row.engagement_id)
    }
    if (rows?.length) {
      res.note = `${res.note || 'JOB_DESTROY'}; marked ${rows.length} job row(s) deleted + re-derived engagement`
    }
  } catch (err: any) {
    console.warn('[jobber-webhook] JOB_DESTROY job-row cleanup failed (webhook still processed)', {
      itemId: ctx.itemId,
      error: err?.message || String(err),
    })
  }
  return res
}

// INVOICE_DESTROY → null jobber_invoice_id
export function handleInvoiceDestroy(ctx: HandlerCtx) {
  const spec = DESTROY_SPECS.INVOICE_DESTROY
  return nullifyLeadJobberColumns(ctx, spec.match, spec.nulls, 'INVOICE_DESTROY')
}

// ASSESSMENT_DESTROY → null jobber_assessment_id (keep jobber_request_id)
//
// May not actually be emitted by Jobber — wired defensively so we don't
// log "unknown topic" if it ever fires. Harmless no-op if Jobber doesn't
// support the topic at the subscription level.
export function handleAssessmentDestroy(ctx: HandlerCtx) {
  const spec = DESTROY_SPECS.ASSESSMENT_DESTROY
  return nullifyLeadJobberColumns(ctx, spec.match, spec.nulls, 'ASSESSMENT_DESTROY')
}

// PROPERTY_DESTROY → null jobber_property_id; address fields stay.
// Bee Hub's address is the local record — losing the Jobber link to a
// property doesn't invalidate the owner's notes about where the
// customer lives.
export function handlePropertyDestroy(ctx: HandlerCtx) {
  const spec = DESTROY_SPECS.PROPERTY_DESTROY
  return nullifyLeadJobberColumns(ctx, spec.match, spec.nulls, 'PROPERTY_DESTROY')
}

// CLIENT_DESTROY → null ALL jobber_*_id columns (full link break).
// The lead row stays as a Bee Hub-only record.
export function handleClientDestroy(ctx: HandlerCtx) {
  const spec = DESTROY_SPECS.CLIENT_DESTROY
  return nullifyLeadJobberColumns(ctx, spec.match, spec.nulls, 'CLIENT_DESTROY')
}

// PROPERTY_CREATE / PROPERTY_UPDATE — Jobber-side is authoritative for
// the property's address fields. Sync onto the matching lead (by
// jobber_property_id if already linked, else by jobber_client_id).
// Set jobber_property_id when missing so subsequent destroy events
// can find the lead.
async function handlePropertyCore(
  ctx: HandlerCtx,
  noun: 'PROPERTY_CREATE' | 'PROPERTY_UPDATE',
): Promise<HandlerResult> {
  const globalId = encodeJobberId('Property', ctx.itemId)
  const res = await jobberGraphQL(ctx.location.location_id, SINGLE_PROPERTY_QUERY, {
    id: globalId,
  })
  if (res.errors?.length) {
    console.error('[jobber-webhook] property_fetch errors', {
      itemId: ctx.itemId,
      globalId,
      errors: res.errors,
    })
    return { processed: false, error: `property_fetch: ${res.errors[0]?.message || 'unknown'}` }
  }
  const propRec = res.data?.property
  if (!propRec) {
    // Race: property was deleted between event + fetch. Treat the same
    // way as PROPERTY_DESTROY (best-effort cleanup by ID).
    console.warn('[jobber-webhook] property_not_found_in_jobber — falling through to destroy', {
      itemId: ctx.itemId,
      globalId,
    })
    const spec = DESTROY_SPECS.PROPERTY_DESTROY
    return nullifyLeadJobberColumns(
      ctx,
      spec.match,
      spec.nulls,
      `${noun}→soft-destroy`,
    )
  }

  const propertyNumeric = extractJobberId(propRec.id)
  const clientNumeric   = extractJobberId(propRec.client?.id)

  // Find the matching lead. Routing order (the two-address feature):
  //   1. The lead whose CURRENT address IS this property
  //      (jobber_property_id match) → update the current columns below.
  //   2. The lead holding this property as a FORMER address → update that
  //      stored entry only; the current address is a DIFFERENT property
  //      and must not be stomped.
  //   3. Client-link fallback, ONLY when that lead has no property link
  //      yet (the original backfill case: PROPERTY_CREATE arriving before
  //      jobber_property_id exists). A lead linked to a DIFFERENT
  //      property is deliberately left alone — before this rule, any
  //      property event on a multi-property client overwrote the lead's
  //      address and re-pointed its link at whichever property last fired.
  let lead: { id: string; name: string | null; stage: string | null } | null = null
  if (propertyNumeric) {
    const { data } = await supabaseService
      .from('leads')
      .select('id, name, stage')
      .eq('jobber_property_id', propertyNumeric)
      .eq('location_id', ctx.location.location_id)
      .maybeSingle()
    if (data) lead = data
  }

  // 2. A former address of some lead? Update the stored entry in place.
  //    (jsonb containment: [{"jobber_property_id": N}] matches an array
  //    holding an object with that pair.) Fail-soft pre-migration: the
  //    filter errors while the column is absent, and nothing can match
  //    anyway.
  if (!lead && propertyNumeric) {
    const { data: formerHolder, error: fhErr } = await supabaseService
      .from('leads')
      .select('id, name, stage, former_addresses')
      .eq('location_id', ctx.location.location_id)
      .filter('former_addresses', 'cs', JSON.stringify([{ jobber_property_id: propertyNumeric }]))
      .maybeSingle()
    if (fhErr) {
      if (!/former_addresses/i.test(fhErr.message || '')) {
        console.warn('[jobber-webhook] former-address lookup failed', fhErr.message)
      }
    } else if (formerHolder) {
      const a2 = propRec.address || {}
      const joined = [a2.street, a2.city, a2.province, a2.postalCode].filter(Boolean).join(', ')
      const updatedList = (Array.isArray(formerHolder.former_addresses) ? formerHolder.former_addresses : []).map(
        (e: any) => (e && String(e.jobber_property_id || '') === String(propertyNumeric)
          ? {
              ...e,
              street: a2.street || e.street,
              city: a2.city || e.city,
              state: a2.province || e.state,
              zip: a2.postalCode || e.zip,
              display: joined || e.display,
            }
          : e),
      )
      await supabaseService
        .from('leads')
        .update({ former_addresses: updatedList, updated_at: new Date().toISOString() })
        .eq('id', formerHolder.id)
      return {
        processed: true,
        lead_id: formerHolder.id,
        lead_stage: formerHolder.stage || null,
        prev_stage: formerHolder.stage || null,
        note: `${noun}: synced FORMER address entry (property=${propertyNumeric}) on lead ${formerHolder.id}; current address untouched`,
      }
    }
  }

  // 3. Client fallback — unlinked leads only.
  if (!lead && clientNumeric) {
    const { data } = await supabaseService
      .from('leads')
      .select('id, name, stage, jobber_property_id')
      .eq('jobber_client_id', clientNumeric)
      .eq('location_id', ctx.location.location_id)
      .maybeSingle()
    if (data) {
      const linkedElsewhere =
        !!(data as any).jobber_property_id &&
        String((data as any).jobber_property_id) !== String(propertyNumeric ?? '')
      if (linkedElsewhere) {
        return {
          processed: true,
          note: `${noun}: property=${propertyNumeric} is not lead ${data.id}'s linked property (${(data as any).jobber_property_id}) — left alone`,
        }
      }
      lead = { id: data.id, name: data.name, stage: data.stage }
    }
  }

  if (!lead) {
    return {
      processed: true,
      note: `${noun}: no matching lead for property=${propertyNumeric} client=${clientNumeric} (no-op)`,
    }
  }

  const a = propRec.address || {}
  const addrJoined = [a.street, a.city, a.province, a.postalCode]
    .filter(Boolean)
    .join(', ') || null

  const patch: Record<string, any> = {
    jobber_property_id: propertyNumeric,
    address: addrJoined,
    city:    a.city       || null,
    state:   a.province   || null,
    zip:     a.postalCode || null,
    updated_at: new Date().toISOString(),
  }
  await supabaseService.from('leads').update(patch).eq('id', lead.id)

  return {
    processed: true,
    lead_id: lead.id,
    lead_stage: lead.stage || null,
    prev_stage: lead.stage || null,
    note: `${noun}: synced property address to lead ${lead.id}`,
  }
}

export function handlePropertyCreate(ctx: HandlerCtx) {
  return handlePropertyCore(ctx, 'PROPERTY_CREATE')
}

export function handlePropertyUpdate(ctx: HandlerCtx) {
  return handlePropertyCore(ctx, 'PROPERTY_UPDATE')
}

// APP_DISCONNECT — a Jobber admin clicked "Disconnect" on the Bee Hub
// app listing. The tokens we hold are now invalid. Mark the location as
// disconnected and clear token columns, but preserve jobber_account_id
// and hub_users.jobber_user_id so the account identity persists across
// connect / disconnect cycles (cleaner reconnect, preserved analytics).
//
// Shares disconnectJobberFromLocation with the in-app Disconnect button
// (POST /api/locations/[id]/jobber-disconnect) so the two paths can never
// drift in which columns they clear.
//
// itemId is unused — APP_DISCONNECT scopes by accountId only.
export async function handleAppDisconnect(ctx: HandlerCtx): Promise<HandlerResult> {
  const { error } = await disconnectJobberFromLocation(ctx.location.id, {
    lastSyncStatus: `Disconnected from Jobber: ${new Date().toLocaleString()}`,
  })

  if (error) {
    return { processed: false, error: `app_disconnect_write: ${error}` }
  }

  return {
    processed: true,
    note: `APP_DISCONNECT: cleared tokens + jobber_connected=false for location "${ctx.location.name || ctx.location.location_id}" (jobber_account_id preserved)`,
  }
}

// ── dispatch table ────────────────────────────────────────────

export const TOPIC_HANDLERS: Record<string, (ctx: HandlerCtx) => Promise<HandlerResult>> = {
  REQUEST_CREATE:     handleRequestCreate,
  REQUEST_UPDATE:     handleRequestUpdate,
  REQUEST_DESTROY:    handleRequestDestroy,
  QUOTE_CREATE:       handleQuoteCreate,
  QUOTE_UPDATE:       handleQuoteUpdate,
  QUOTE_SENT:         handleQuoteSent,
  QUOTE_APPROVED:     handleQuoteApproved,
  QUOTE_DESTROY:      handleQuoteDestroy,
  JOB_CREATE:         handleJobCreate,
  JOB_UPDATE:         handleJobUpdate,
  JOB_COMPLETE:       handleJobComplete,
  JOB_DESTROY:        handleJobDestroy,
  INVOICE_CREATE:     handleInvoiceCreate,
  INVOICE_UPDATE:     handleInvoiceUpdate,
  INVOICE_PAID:       handleInvoicePaid,
  INVOICE_DESTROY:    handleInvoiceDestroy,
  CLIENT_UPDATE:      handleClientUpdate,
  CLIENT_DESTROY:     handleClientDestroy,
  PROPERTY_CREATE:    handlePropertyCreate,
  PROPERTY_UPDATE:    handlePropertyUpdate,
  PROPERTY_DESTROY:   handlePropertyDestroy,
  ASSESSMENT_DESTROY: handleAssessmentDestroy,
  APP_DISCONNECT:     handleAppDisconnect,
}

export const SUPPORTED_TOPICS = Object.keys(TOPIC_HANDLERS)
