// lib/webhook-landed.ts
// ─────────────────────────────────────────────────────────────
// Recorded "landed" verification for inbound Jobber webhooks.
//
// The dispatcher (app/api/webhooks/jobber/route.ts) calls checkLanded()
// AFTER the topic handler returns and records the result in
// sync_log.landed_status. The check re-reads the record's ACTUAL state
// from the DB — it never trusts "no error threw". This is what catches
// the silent-stuck case: the engagement dual-write inside the handlers
// is swallow-and-log (console.error only), so a handler can return
// processed=true while the quote/job/invoice never attached or the
// engagement never advanced. That exact case records 'not_landed'.
//
// LANDED RULES (what "landed correctly" means, per topic):
//   REQUEST_CREATE     → service_requests row exists + engagement attached
//   REQUEST_UPDATE     → service_requests row exists (refresh semantics);
//                        the soft-destroy fallback verifies like REQUEST_DESTROY
//   QUOTE_CREATE/SENT  → quotes row exists + engagement attached +
//                        engagement stage rank ≥ 'Estimate'
//   QUOTE_UPDATE       → quotes row exists (row actually written)
//   QUOTE_APPROVED     → quotes row exists + engagement attached +
//                        approved (approved_at or status ~ approved)
//   JOB_CREATE         → jobs row exists + engagement attached + engagement
//                        stage rank ≥ 'Job in Progress' for BOOKED jobs;
//                        an unbooked job (isUnbookedJobStatus) rests at
//                        'Estimate' by design, so ≥ 'Estimate' is landed —
//                        mirrors handleJobCore's unbooked carve-out (#97)
//   JOB_UPDATE         → jobs row exists
//   JOB_COMPLETE       → jobs row done (engagementJobDone) + engagement
//                        attached + rank ≥ 'Job in Progress'. NOT
//                        ≥ 'Final Processing': a sibling job still open
//                        legitimately holds the engagement at Job in
//                        Progress — that is not stuck.
//   INVOICE_CREATE     → invoices row exists + engagement attached
//   INVOICE_UPDATE     → invoices row exists + engagement attached (refresh
//                        semantics; paid-ness derived from the record, so
//                        no status='paid' requirement)
//   INVOICE_PAID       → invoices row status='paid' + engagement attached
//   *_DESTROY          → the DESTROY_SPECS columns are actually null on
//                        the matched lead ('na' when no lead matched —
//                        a documented no-op, nothing to verify)
//   PROPERTY_CREATE/   → the lead HOLDS this property, in either of the two
//   PROPERTY_UPDATE      places the handler can put it: its primary link
//                        (jobber_property_id), OR an entry in
//                        former_addresses with this jobber_property_id —
//                        the drift and other-address branches never move
//                        the link (the d8aa5ef stomp guard). 'na' when no
//                        lead matched, or the note is one of the handler's
//                        own PROPERTY_NOOP_NOTES (it wrote nothing on purpose)
//   PROPERTY_DESTROY   → primary case: the DESTROY_SPECS link is null.
//                        Other-address case: that entry is retired and the
//                        link is not this property. 'na' for no lead, or a
//                        PROPERTY_NOOP_NOTES no-op (already retired)
//   APP_DISCONNECT     → locations row shows jobber_connected=false
//   CLIENT_UPDATE      → 'na' (field refresh; no intended state transition)
//   everything else    → 'na' (processed-only)
//   errored rows       → 'na' (the ✗ + inline error already tell that
//                        story; 'not_landed' is reserved for
//                        processed-without-error-but-record-wrong)
//
// A crash inside the check itself records 'na' (never blocks the 200
// back to Jobber or the sync_log write).
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { extractJobberId, isUnbookedJobStatus } from './jobber-import'
import {
  ENGAGEMENT_STAGE_RANK,
  engagementJobDone,
  type EngagementStage,
} from './engagements'
import {
  DESTROY_SPECS,
  PROPERTY_NOOP_NOTES,
  type HandlerCtx,
  type HandlerResult,
} from './jobber-webhook-handlers'
import { isRetiredAddress } from './lead-address'

export type LandedStatus = 'landed' | 'not_landed' | 'na'

const rankOf = (stage: string | null | undefined): number =>
  stage ? (ENGAGEMENT_STAGE_RANK[stage as EngagementStage] ?? 0) : 0

async function fetchSubRow(
  table: 'service_requests' | 'quotes' | 'jobs' | 'invoices',
  idCol: string,
  cols: string,
  numericId: string,
  locationSlug: string,
): Promise<any | null> {
  const { data } = await supabaseService
    .from(table)
    .select(cols)
    .eq(idCol, numericId)
    .eq('location_id', locationSlug)
    .maybeSingle()
  return data || null
}

async function fetchEngagementRank(engagementId: string): Promise<number> {
  const { data } = await supabaseService
    .from('engagements')
    .select('stage')
    .eq('id', engagementId)
    .maybeSingle()
  return rankOf(data?.stage)
}

// Verify a destroy actually nulled its columns on the matched lead.
async function checkDestroyLanded(
  destroyTopic: string,
  leadId: string,
): Promise<LandedStatus> {
  const spec = DESTROY_SPECS[destroyTopic]
  if (!spec) return 'na'
  const { data: lead } = await supabaseService
    .from('leads')
    .select(spec.nulls.join(', '))
    .eq('id', leadId)
    .maybeSingle()
  if (!lead) return 'not_landed'
  return spec.nulls.every(col => (lead as any)[col] == null)
    ? 'landed'
    : 'not_landed'
}

// Where a lead holds a property, in one re-read: is it the primary link, and
// which entry among the OTHER addresses carries it (if any). Same match the
// handler's own lookup makes — raw array, id compared as a string.
async function readPropertyHolding(leadId: string, propertyId: string) {
  const { data: lead } = await supabaseService
    .from('leads')
    .select(['former_addresses', ...DESTROY_SPECS.PROPERTY_DESTROY.nulls].join(', '))
    .eq('id', leadId)
    .maybeSingle()
  if (!lead) return null
  const row = lead as any
  const list: any[] = Array.isArray(row.former_addresses) ? row.former_addresses : []
  return {
    row,
    primary: row.jobber_property_id != null && String(row.jobber_property_id) === String(propertyId),
    other: list.find(e => e && String(e.jobber_property_id ?? '') === String(propertyId)) ?? null,
  }
}

// The handler said it wrote nothing on purpose, in its own exported words.
const isPropertyNoop = (note: string | undefined): boolean =>
  !!note && Object.values(PROPERTY_NOOP_NOTES).some(m => note.includes(m))

export async function checkLanded(
  ctx: Pick<HandlerCtx, 'topic' | 'itemId' | 'location'>,
  result: HandlerResult,
): Promise<LandedStatus> {
  try {
    // Errored rows: landed is moot — the ✗ row carries the error.
    if (result.error || !result.processed) return 'na'

    const topic = ctx.topic
    const numeric = extractJobberId(ctx.itemId) || ctx.itemId
    const loc = ctx.location.location_id

    // Archived request (#122): REQUEST_UPDATE with requestStatus 'archived'
    // runs the #66 cleanup, which DELETES the SR mirror when the request was
    // childless. There is no single post-condition row to verify — the SR is
    // intentionally absent for an empty archived request (and legitimately
    // present when it had downstream work), so the plain REQUEST_UPDATE
    // "SR exists → landed" rule would false-alarm 'not_landed'. This is
    // best-effort bookkeeping (fail-soft), same rationale as CLIENT_UPDATE:
    // record 'na'.
    if (topic === 'REQUEST_UPDATE' && result.note?.includes('→archived')) return 'na'

    // Archived / un-archived client (#122): CLIENT_UPDATE is normally a plain
    // field refresh ('na'), but the archive branch has a verifiable
    // post-condition on the matched lead — verify it rather than trusting
    // "no error threw" (the write is fail-soft and swallows).
    if (topic === 'CLIENT_UPDATE' && result.note) {
      const archived = result.note.includes('→archived')
      const unarchived = result.note.includes('→unarchived')
      if (archived || unarchived) {
        if (!result.lead_id) return 'na'
        const { data } = await supabaseService
          .from('leads')
          .select('archived_at')
          .eq('id', result.lead_id)
          .maybeSingle()
        if (archived) return data?.archived_at ? 'landed' : 'not_landed'
        return data && data.archived_at == null ? 'landed' : 'not_landed'
      }
    }

    // PROPERTY_DESTROY on one of the client's OTHER addresses. The handler
    // retires that entry and leaves the link alone — the link is a different
    // property — so the DESTROY_SPECS "is the link null?" check below would
    // alarm on every correct retire, and pass a failed one whenever the
    // holder's link happened to be empty. Verify the entry itself. The
    // primary path (its note says it "nulled" the link) keeps the check below.
    if (topic === 'PROPERTY_DESTROY' && result.lead_id && !result.note?.includes(': nulled ')) {
      if (isPropertyNoop(result.note)) return 'na' // already retired
      const held = await readPropertyHolding(result.lead_id, numeric)
      if (!held?.other) return 'not_landed'
      return !held.primary && isRetiredAddress(held.other) ? 'landed' : 'not_landed'
    }

    // Destroys — including the soft-destroy fallbacks that UPDATE
    // handlers take when Jobber says the record is already gone.
    const softDestroy = !!result.note?.includes('soft-destroy')
    const destroyTopic = DESTROY_SPECS[topic]
      ? topic
      : softDestroy && topic === 'REQUEST_UPDATE'
        ? 'REQUEST_DESTROY'
        : softDestroy && (topic === 'PROPERTY_CREATE' || topic === 'PROPERTY_UPDATE')
          ? 'PROPERTY_DESTROY'
          : null
    if (destroyTopic) {
      if (!result.lead_id) return 'na' // no matching lead — documented no-op
      return checkDestroyLanded(destroyTopic, result.lead_id)
    }

    switch (topic) {
      case 'REQUEST_CREATE': {
        const sr = await fetchSubRow(
          'service_requests', 'jobber_request_id', 'id, engagement_id', numeric, loc,
        )
        return sr?.engagement_id ? 'landed' : 'not_landed'
      }
      case 'REQUEST_UPDATE': {
        const sr = await fetchSubRow(
          'service_requests', 'jobber_request_id', 'id', numeric, loc,
        )
        return sr ? 'landed' : 'not_landed'
      }
      case 'QUOTE_CREATE':
      case 'QUOTE_SENT': {
        const q = await fetchSubRow(
          'quotes', 'jobber_quote_id', 'id, engagement_id', numeric, loc,
        )
        if (!q?.engagement_id) return 'not_landed'
        return (await fetchEngagementRank(q.engagement_id)) >= rankOf('Estimate')
          ? 'landed'
          : 'not_landed'
      }
      case 'QUOTE_UPDATE': {
        const q = await fetchSubRow('quotes', 'jobber_quote_id', 'id', numeric, loc)
        return q ? 'landed' : 'not_landed'
      }
      case 'QUOTE_APPROVED': {
        const q = await fetchSubRow(
          'quotes', 'jobber_quote_id', 'id, engagement_id, status, approved_at', numeric, loc,
        )
        if (!q?.engagement_id) return 'not_landed'
        return q.approved_at || /approved/i.test(q.status || '')
          ? 'landed'
          : 'not_landed'
      }
      case 'JOB_CREATE': {
        const j = await fetchSubRow(
          'jobs', 'jobber_job_id', 'id, engagement_id, status', numeric, loc,
        )
        if (!j?.engagement_id) return 'not_landed'
        // Mirror handleJobCore's unbooked carve-out: an unbooked job
        // (unscheduled / action_required / on_hold) intentionally does NOT
        // promote the engagement to 'Job in Progress' — it rests at
        // 'Estimate' (deriveEngagementStage classifies it with the quotes).
        // Requiring rank ≥ 'Job in Progress' here would flag every
        // correctly-handled unbooked JOB_CREATE as not_landed. Use the SAME
        // predicate the handler uses (imported, never re-listed) so the two
        // can't drift. Booked jobs keep the ≥ 'Job in Progress' bar.
        const requiredStage = isUnbookedJobStatus(j.status)
          ? 'Estimate'
          : 'Job in Progress'
        return (await fetchEngagementRank(j.engagement_id)) >= rankOf(requiredStage)
          ? 'landed'
          : 'not_landed'
      }
      case 'JOB_UPDATE': {
        const j = await fetchSubRow('jobs', 'jobber_job_id', 'id', numeric, loc)
        return j ? 'landed' : 'not_landed'
      }
      case 'JOB_COMPLETE': {
        const j = await fetchSubRow(
          'jobs', 'jobber_job_id', 'id, engagement_id, status, completed_at', numeric, loc,
        )
        if (!j?.engagement_id) return 'not_landed'
        if (!engagementJobDone(j)) return 'not_landed'
        return (await fetchEngagementRank(j.engagement_id)) >= rankOf('Job in Progress')
          ? 'landed'
          : 'not_landed'
      }
      case 'INVOICE_CREATE': {
        const inv = await fetchSubRow(
          'invoices', 'jobber_invoice_id', 'id, engagement_id', numeric, loc,
        )
        return inv?.engagement_id ? 'landed' : 'not_landed'
      }
      case 'INVOICE_PAID': {
        const inv = await fetchSubRow(
          'invoices', 'jobber_invoice_id', 'id, engagement_id, status', numeric, loc,
        )
        if (!inv?.engagement_id) return 'not_landed'
        return inv.status === 'paid' ? 'landed' : 'not_landed'
      }
      case 'INVOICE_UPDATE': {
        // Refresh semantics (like JOB_UPDATE): the invoice row must exist +
        // be attached to an engagement. Paid-ness is derived from the record,
        // not the topic, so we don't require status='paid' here — a non-paid
        // update that lands the row + attachment is still 'landed'.
        const inv = await fetchSubRow(
          'invoices', 'jobber_invoice_id', 'id, engagement_id', numeric, loc,
        )
        return inv?.engagement_id ? 'landed' : 'not_landed'
      }
      case 'PROPERTY_CREATE':
      case 'PROPERTY_UPDATE': {
        if (!result.lead_id) return 'na' // no matching lead — documented no-op
        // No usable address / already the primary / already one of their
        // addresses: the handler wrote nothing on purpose. Nothing to verify.
        if (isPropertyNoop(result.note)) return 'na'
        // TWO success shapes. The handler has two places to put a property,
        // and d8aa5ef forbids it moving the link to reach the second:
        //   · the primary link IS this property (primary + unlinked branches)
        //   · an OTHER address carries this id (the drift branch appends
        //     one; the in-place branch refreshes one)
        // Asking only the first alarmed on every correct drift write. A
        // failed drift write leaves neither shape, and stays not_landed.
        const held = await readPropertyHolding(result.lead_id, numeric)
        return held && (held.primary || held.other) ? 'landed' : 'not_landed'
      }
      case 'APP_DISCONNECT': {
        const { data: locRow } = await supabaseService
          .from('locations')
          .select('jobber_connected')
          .eq('id', ctx.location.id)
          .maybeSingle()
        return locRow && locRow.jobber_connected === false ? 'landed' : 'not_landed'
      }
      // CLIENT_UPDATE and anything unmapped: processed-only.
      default:
        return 'na'
    }
  } catch (err: any) {
    console.error(
      `[webhook-landed] check failed topic=${ctx.topic} item=${ctx.itemId} — recording na`,
      err?.message || err,
    )
    return 'na'
  }
}
