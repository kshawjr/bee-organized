// lib/stage-emails.ts
//
// Opportunity Stages Drip — six master templates fired by lead stage
// transitions:
//
//   Closed Won →
//     opp_closed_job_3mo               (now + 90d)
//     opp_closed_job_12mo              (now + 365d)
//
//   Estimate Sent + organizing project →
//     opp_organizing_estimate_3d       (now + 3d)
//     opp_organizing_estimate_30d      (now + 30d)
//
//   Estimate Sent + moving project →
//     opp_moving_estimate_3d           (now + 3d)
//     opp_moving_estimate_30d          (now + 30d)
//
// Persistence: scheduled_stage_emails (one row per (lead, stage_email_key))
// — see drip_followup_infrastructure.sql. Insertion uses UPSERT so a
// re-entry into a trigger stage (e.g. reopened then re-closed) resets
// the scheduled row's send_at and clears any cancelled_at.

import { supabaseService } from './supabase-service'
import { sendEmail, renderTemplate, type RenderContext } from './resend'
import { blockedOnMissingRate } from './rate-guard'
import { resolveOwnerBookingLink, blockedOnMissingBookingLink } from './booking-link'
import { bodyToHtml } from './drip-send'
import { getPrimaryOwnerForLocation } from './owner-resolution'

const DAY_MS = 24 * 60 * 60 * 1000

// Stage trigger → keys + delays. The keys match templates.legacy_id.
type StageTrigger = {
  key: string
  delayDays: number
}

const CLOSED_WON_TRIGGERS: StageTrigger[] = [
  { key: 'opp_closed_job_3mo',  delayDays: 90 },
  { key: 'opp_closed_job_12mo', delayDays: 365 },
]

const ESTIMATE_ORGANIZING_TRIGGERS: StageTrigger[] = [
  { key: 'opp_organizing_estimate_3d',  delayDays: 3 },
  { key: 'opp_organizing_estimate_30d', delayDays: 30 },
]

const ESTIMATE_MOVING_TRIGGERS: StageTrigger[] = [
  { key: 'opp_moving_estimate_3d',  delayDays: 3 },
  { key: 'opp_moving_estimate_30d', delayDays: 30 },
]

// All stage_email_keys we manage — used to scope cancellations.
const ALL_STAGE_EMAIL_KEYS = [
  ...CLOSED_WON_TRIGGERS,
  ...ESTIMATE_ORGANIZING_TRIGGERS,
  ...ESTIMATE_MOVING_TRIGGERS,
].map(t => t.key)

// ──────────────────────────────────────────────────────────────────────
// Drip category lookup: project_type → 'general' | 'move'
// ──────────────────────────────────────────────────────────────────────
// Source: lookups table, category='project_types', attrs->>'drip_category'.
// Admin-editable via Configure tab in BeeHub. Defaults to 'general' if
// the project_type isn't found.

export async function resolveDripCategory(projectType: string | null): Promise<'general' | 'move'> {
  if (!projectType) return 'general'
  const { data } = await supabaseService
    .from('lookups')
    .select('attrs')
    .eq('category', 'project_types')
    .eq('label', projectType)
    .eq('is_active', true)
    .maybeSingle()
  const cat = data?.attrs?.drip_category
  return cat === 'move' ? 'move' : 'general'
}

// ──────────────────────────────────────────────────────────────────────
// Schedule stage emails on stage transition
// ──────────────────────────────────────────────────────────────────────
// Fire-and-forget: any error logs but doesn't throw. Idempotent on
// re-entry via upsert.

export async function scheduleStageEmails(args: {
  leadId: string
  newStage: string
  projectType: string | null
}): Promise<void> {
  try {
    const { leadId, newStage, projectType } = args

    // Cheap scheduling-time opt-out gate — don't queue what can never
    // send. sendStageEmail re-checks at send time (authoritative: the
    // lead can opt out after scheduling).
    const { data: optCheck } = await supabaseService
      .from('leads')
      .select('marketing_opt_out')
      .eq('id', leadId)
      .maybeSingle()
    if (optCheck?.marketing_opt_out === true) {
      console.log(`[stage-emails] lead ${leadId} opted out of marketing — not scheduling`)
      return
    }

    let triggers: StageTrigger[] = []

    if (newStage === 'Closed Won') {
      triggers = CLOSED_WON_TRIGGERS
    } else if (newStage === 'Estimate Sent') {
      const cat = await resolveDripCategory(projectType)
      triggers = cat === 'move' ? ESTIMATE_MOVING_TRIGGERS : ESTIMATE_ORGANIZING_TRIGGERS
    } else {
      return
    }

    const now = Date.now()
    const rows = triggers.map(t => ({
      lead_id: leadId,
      stage_email_key: t.key,
      send_at: new Date(now + t.delayDays * DAY_MS).toISOString(),
      sent_at: null as string | null,
      cancelled_at: null as string | null,
      cancelled_reason: null as string | null,
    }))

    const { error } = await supabaseService
      .from('scheduled_stage_emails')
      .upsert(rows, { onConflict: 'lead_id,stage_email_key' })

    if (error) {
      console.error('[stage-emails] schedule: upsert failed', { leadId, newStage, error })
    }
  } catch (err) {
    console.error('[stage-emails] schedule: unexpected error', { leadId: args.leadId, err })
  }
}

// ──────────────────────────────────────────────────────────────────────
// Cancel pending stage emails
// ──────────────────────────────────────────────────────────────────────
// Sets cancelled_at on every pending (not-sent, not-cancelled) row for
// this lead. Called when the lead transitions out of a trigger stage,
// or is flagged junk.

export async function cancelStageEmails(args: {
  leadId: string
  reason: 'stage_changed' | 'junk' | 'manual' | 'opted_out'
}): Promise<void> {
  try {
    const { leadId, reason } = args
    const { error } = await supabaseService
      .from('scheduled_stage_emails')
      .update({ cancelled_at: new Date().toISOString(), cancelled_reason: reason })
      .eq('lead_id', leadId)
      .is('sent_at', null)
      .is('cancelled_at', null)

    if (error) {
      console.error('[stage-emails] cancel: update failed', { leadId, reason, error })
    }
  } catch (err) {
    console.error('[stage-emails] cancel: unexpected error', { leadId: args.leadId, err })
  }
}

// ──────────────────────────────────────────────────────────────────────
// Send one stage email by scheduled row id
// ──────────────────────────────────────────────────────────────────────
// Renders the matching template against the lead + location context and
// sends. Sets sent_at on success and records a 'drip' touchpoint.

export type SendStageEmailResult = {
  sent: boolean
  error?: string
}

export async function sendStageEmail(scheduledRowId: string): Promise<SendStageEmailResult> {
  // Scheduled row
  const { data: row, error: rowErr } = await supabaseService
    .from('scheduled_stage_emails')
    .select('id, lead_id, stage_email_key, sent_at, cancelled_at')
    .eq('id', scheduledRowId)
    .maybeSingle()

  if (rowErr || !row) {
    return { sent: false, error: `scheduled_row_lookup: ${rowErr?.message ?? 'missing'}` }
  }
  if (row.sent_at) return { sent: false, error: 'already_sent' }
  if (row.cancelled_at) return { sent: false, error: 'cancelled' }

  // Template
  const { data: tpl, error: tplErr } = await supabaseService
    .from('templates')
    .select('subject, body, name')
    .eq('legacy_id', row.stage_email_key)
    .is('location_uuid', null)
    .maybeSingle()

  if (tplErr || !tpl) {
    return { sent: false, error: `template_lookup: ${tplErr?.message ?? 'missing'}` }
  }

  // Lead
  const { data: lead, error: leadErr } = await supabaseService
    .from('leads')
    .select('id, name, first_name, email, location_uuid, assigned_to, marketing_opt_out')
    .eq('id', row.lead_id)
    .maybeSingle()

  if (leadErr || !lead) {
    return { sent: false, error: `lead_lookup: ${leadErr?.message ?? 'missing'}` }
  }
  if (lead.marketing_opt_out === true) {
    // Opted out → cancel so the row never retries. Same shape as the
    // no-email cancel below; cancelled_reason is free text (no CHECK).
    await supabaseService
      .from('scheduled_stage_emails')
      .update({ cancelled_at: new Date().toISOString(), cancelled_reason: 'opted_out' })
      .eq('id', row.id)
    return { sent: false, error: 'opted_out' }
  }
  if (!lead.email || typeof lead.email !== 'string' || !lead.email.trim()) {
    // Cancel — no point retrying for a lead without an email.
    await supabaseService
      .from('scheduled_stage_emails')
      .update({ cancelled_at: new Date().toISOString(), cancelled_reason: 'no_email' })
      .eq('id', row.id)
    return { sent: false, error: 'no_email' }
  }
  if (!lead.location_uuid) return { sent: false, error: 'no_location' }

  // Location
  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, sender_name, phone, calendar_link, reviews_link, rate_per_hour, city, state')
    .eq('id', lead.location_uuid)
    .maybeSingle()

  if (locErr || !loc) {
    return { sent: false, error: `loc_lookup: ${locErr?.message ?? 'missing'}` }
  }

  // Owners — resolve the location's DESIGNATED primary owner (Phase 2 co-owner
  // support) so the sending identity is deterministic when a location has two
  // owners. Falls back to legacy hub_users role='owner' inside the resolver.
  const locOwner = await getPrimaryOwnerForLocation(loc.id)
  const locationOwnerName = locOwner?.full_name ?? null

  let ownerName: string | null = locationOwnerName
  if (lead.assigned_to) {
    const { data: assignee } = await supabaseService
      .from('hub_users')
      .select('full_name')
      .eq('id', lead.assigned_to)
      .maybeSingle()
    if (assignee?.full_name) ownerName = assignee.full_name
  }
  const ownerFirstName = ownerName ? ownerName.trim().split(/\s+/)[0] || null : null

  // {{owner_booking_link}} — assignee's link → location owner's → calendar_link.
  const ownerBookingLink = await resolveOwnerBookingLink({
    assignedToUserId: lead.assigned_to,
    locationOwnerUserId: locOwner?.id ?? null,
    locationCalendarLink: loc.calendar_link,
  })

  const firstName =
    lead.first_name && lead.first_name.trim()
      ? lead.first_name.trim()
      : (lead.name ?? '').trim().split(/\s+/)[0] || null

  const serviceArea =
    loc.city && loc.state ? `${loc.city}, ${loc.state}` : loc.city || loc.state || null

  const ctx: RenderContext = {
    first_name: firstName,
    organizer_name: loc.sender_name,
    location_name: loc.name,
    phone: loc.phone,
    booking_link: loc.calendar_link,
    service_area: serviceArea,
    owner_name: ownerName,
    owner_first_name: ownerFirstName,
    owner_booking_link: ownerBookingLink,
    location_owner_name: locationOwnerName,
    rate_per_hour: loc.rate_per_hour,
    location_phone: loc.phone,
    book_assessment_link: loc.calendar_link,
    reviews_link: loc.reviews_link,
  }

  // RATE GUARD: template quotes {{rate_per_hour}} but the location has no
  // rate. HOLD — send_at stays intact so the cron retries every tick and
  // the email goes out on the first tick after the rate is entered.
  if (blockedOnMissingRate(tpl, loc.rate_per_hour)) {
    console.warn('[stage-emails] held: template quotes {{rate_per_hour}} but location rate is blank', {
      rowId: row.id, leadId: lead.id, locationId: loc.id,
    })
    return { sent: false, error: 'missing_rate' }
  }

  // BOOKING-LINK GUARD: the template asks the client to click a scheduling
  // link and none resolves. HOLD — send_at stays intact so the cron retries
  // every tick and it goes out on the first tick after a link is set.
  if (
    blockedOnMissingBookingLink(tpl, { ownerBookingLink, locationCalendarLink: loc.calendar_link })
  ) {
    console.warn('[stage-emails] held: template quotes a booking tag but no link resolves', {
      rowId: row.id, leadId: lead.id, locationId: loc.id,
    })
    return { sent: false, error: 'missing_booking_link' }
  }

  const rendered = renderTemplate({ subject: tpl.subject, body: tpl.body }, ctx)
  const html = bodyToHtml(rendered.body)

  const result = await sendEmail({
    locationId: loc.id,
    to: lead.email.trim(),
    subject: rendered.subject || `(no subject)`,
    html,
    text: rendered.body,
  })

  if (!result.success) {
    // Leave send_at intact so the cron retries next tick.
    return { sent: false, error: `send: ${result.error}` }
  }

  const nowIso = new Date().toISOString()
  const { error: updErr } = await supabaseService
    .from('scheduled_stage_emails')
    .update({ sent_at: nowIso })
    .eq('id', row.id)
  if (updErr) {
    console.error('[stage-emails] mark-sent failed', { rowId: row.id, updErr })
  }

  const { error: tpErr } = await supabaseService.from('touchpoints').insert({
    lead_id: lead.id,
    location_uuid: loc.id,
    kind: 'drip',
    method: 'email',
    label: tpl.name ?? row.stage_email_key,
    status: 'sent',
    occurred_at: nowIso,
  })
  if (tpErr) {
    console.error('[stage-emails] touchpoint insert failed', { leadId: lead.id, tpErr })
  }

  return { sent: true }
}

// Re-export the list of keys for cancellation scoping (cron / tests).
export { ALL_STAGE_EMAIL_KEYS }
