// lib/drip-enrol-outcome.ts
// ─────────────────────────────────────────────────────────────
// WHY A LEAD DID OR DIDN'T START NURTURE EMAILS — named, stored, and shown.
//
// THE BUG THIS CLOSES (Test Fornat, Test Location, 2026-09-27). The lead was
// created with Drip ticked; startDripForLead looked for step 1 of the
// location's Moving sequence, found none (its only step is numbered 3), wrote
// one console.error, and returned. Nothing on the lead, the card or the
// Timeline said so — the card told the owner to "contact support". Enrolment
// had twelve such quiet exits. Silence was the bug, not any one cause.
//
// Now every attempt ends in a DripEnrolResult: enrolled, or not enrolled with
// one of eight reasons. Each reason has a KIND that decides who hears about it:
//
//   by_design  card only           — the lead SHOULDN'T be mailed right now,
//                                    and the owner can see why on the card.
//   setup      card + Timeline +   — a location setting is wrong; EVERY new
//              ops alert (once per  lead there fails the same way until it's
//              location)             fixed, so Kevin hears the first time.
//   system     card + Timeline     — a read or write failed; Activate retries.
//
// The last outcome is stored on the lead (leads.drip_enrol_reason — null once
// enrolled — and leads.drip_enrol_at), the way drip_last_send_* stores the
// last send. migrations/drip_enrol_reason.sql adds the columns; until it runs
// the write is skipped with a warning and the card keeps its old inference.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

export const DRIP_ENROL_REASONS = [
  'drip_not_ticked',
  'paused_import',
  'opted_out',
  'location_not_live',
  'no_default_path',
  'path_missing',
  'path_has_no_first_email',
  'lookup_failed',
] as const
export type DripEnrolReason = (typeof DRIP_ENROL_REASONS)[number]

export type DripEnrolResult =
  | { enrolled: true }
  | { enrolled: false; reason: DripEnrolReason; sequence?: 'Moving' | 'Organizing' | null }

export type DripEnrolKind = 'by_design' | 'setup' | 'system'

export const DRIP_ENROL_KIND: Record<DripEnrolReason, DripEnrolKind> = {
  drip_not_ticked: 'by_design',
  paused_import: 'by_design',
  opted_out: 'by_design',
  location_not_live: 'by_design',
  no_default_path: 'setup',
  path_missing: 'setup',
  path_has_no_first_email: 'setup',
  lookup_failed: 'system',
}

export const SETUP_REASONS: DripEnrolReason[] = DRIP_ENROL_REASONS.filter((r) => DRIP_ENROL_KIND[r] === 'setup')

export function isDripEnrolReason(v: unknown): v is DripEnrolReason {
  return typeof v === 'string' && (DRIP_ENROL_REASONS as readonly string[]).includes(v)
}

// One plain-words line per reason — used by the New sheet's warning, the
// Timeline entry and the ops alert. Never "contact support": every one of
// these is either by design or something the owner can put right.
export function dripEnrolReasonText(
  reason: DripEnrolReason,
  ctx: { sequence?: 'Moving' | 'Organizing' | null; locationName?: string | null } = {},
): string {
  const seq = ctx.sequence ? `${ctx.sequence} ` : ''
  const loc = ctx.locationName || 'this location'
  switch (reason) {
    case 'drip_not_ticked': return 'Drip wasn’t ticked when this client was added'
    case 'paused_import': return 'this client was imported, and imported clients start paused'
    case 'opted_out': return 'the client has opted out of marketing emails'
    case 'location_not_live': return `${loc} isn’t live yet — nurture emails start once it is`
    case 'no_default_path': return `no ${seq}sequence is chosen in Settings → Emails`
    case 'path_missing': return `the ${seq}sequence chosen in Settings → Emails can’t be found`
    case 'path_has_no_first_email': return `the ${seq}sequence has no emails in it — add one in Settings → Emails`
    case 'lookup_failed': return 'a temporary error stopped them starting — tap Activate to try again'
  }
}

// Store the outcome on the lead, and write the Timeline entry for setup and
// system reasons — once per lead per reason (the stored reason is the dedup
// key, as drip_last_send_error is for send holds). Never throws: recording an
// outcome must not be the thing that breaks lead creation.
export async function recordDripEnrolOutcome(
  leadId: string,
  locationUuid: string | null,
  result: DripEnrolResult,
): Promise<void> {
  try {
    const reason = result.enrolled ? null : result.reason

    let prior: string | null | undefined
    {
      const { data, error } = await supabaseService
        .from('leads')
        .select('drip_enrol_reason')
        .eq('id', leadId)
        .maybeSingle()
      prior = error ? undefined : ((data as any)?.drip_enrol_reason ?? null)
    }

    const { error: updErr } = await supabaseService
      .from('leads')
      .update({ drip_enrol_reason: reason, drip_enrol_at: new Date().toISOString() })
      .eq('id', leadId)
    if (updErr) {
      console.warn('[drip-enrol] outcome not stored (migrations/drip_enrol_reason.sql not run?)', {
        leadId, reason, error: updErr.message,
      })
    }

    if (result.enrolled) return
    const kind = DRIP_ENROL_KIND[result.reason]
    if (kind === 'by_design') return
    if (prior === reason) return // already on the Timeline for this reason

    const { error: tpErr } = await supabaseService.from('touchpoints').insert({
      lead_id: leadId,
      location_uuid: locationUuid,
      kind: 'drip',
      method: 'email',
      status: 'failed',
      label: `Nurture emails didn’t start — ${dripEnrolReasonText(result.reason, { sequence: result.sequence })}`,
      occurred_at: new Date().toISOString(),
    })
    if (tpErr) console.error('[drip-enrol] timeline entry failed', { leadId, error: tpErr.message })
  } catch (err) {
    console.error('[drip-enrol] recording outcome threw', { leadId, err })
  }
}
