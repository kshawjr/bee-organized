// lib/welcome-email.ts
//
// Auto Welcome Email — single corp master template that fires 24 hours
// after Email 1 of a new-lead drip path. Scheduled by drip-send when
// step 1 of a drip fires successfully; sent by the cron when due.
//
// NEW LEADS ONLY. Retired on 2026-08-19 (issue 314, 281ebdf) and restored
// on Kevin's word that the retirement was a mistake. What the restore adds:
// a returning client is NEVER welcomed. The trigger used to be "step 1 of any
// drip", which greets anyone whose drip starts — a Jobber-imported client an
// owner activates, and (since 2026-09-03) every past client whose website
// form enrols them on the returning-a..d sequence. Two gates now stand in the
// way, both using the app's one existing rule (isPastClient in
// lib/drip-lifecycle.ts, the same facts the Inbox's "Back again" chip reads):
//   · schedule time — scheduleWelcomeEmail refuses a past client, and refuses
//     when it cannot tell (a failed lookup is not proof of a stranger);
//   · send time — sendWelcomeEmail re-asks, because someone can become a
//     client inside the 24 hours (a Closed Won, a payment).
// drip-send also skips the returning-a..d paths outright, before either.
//
// Schema (drip_followup_infrastructure.sql):
//   leads.welcome_email_scheduled_at — when to fire (set by scheduleWelcomeEmail)
//   leads.welcome_email_sent_at      — when it actually sent (set by sendWelcomeEmail)
//
// Both NULL = no welcome pending or sent (steady state for leads that
// never went into a drip, e.g. junk-on-create).

import { supabaseService } from './supabase-service'
import { sendEmail, renderTemplate, type RenderContext } from './resend'
import { blockedOnMissingRate } from './rate-guard'
import { resolveOwnerBookingLink, blockedOnMissingBookingLink } from './booking-link'
import {
  buildBrandedDripHtml,
  buildBrandedDripText,
  type BrandedEmailContext,
  type CardFooter,
} from './drip-email-layout'
import { getPrimaryOwnerForLocation } from './owner-resolution'
import { hasSignatureTag } from './email-signature'
import { resolveEmailSignature } from './email-signature-resolve'
import { buildCanSpamFooter } from './marketing-unsubscribe'
import { resolveLocationTemplateFork } from './template-fork'
// Type-only: erased at build, so it adds no runtime cycle (drip-lifecycle
// imports this file; the value import below stays dynamic for that reason).
import type { PastClientFacts } from './drip-lifecycle'

const WELCOME_LEGACY_ID = 'welcome'
const WELCOME_DELAY_MS = 24 * 60 * 60 * 1000  // 24 hours

// ──────────────────────────────────────────────────────────────────────
// Render
// ──────────────────────────────────────────────────────────────────────
// The welcome renders through the #90 Bee Organized branded layout — the same
// one drips and the stage emails use: logo, white card, teal band, any
// "word (https://…)" link made clickable on the word, the Google Reviews line
// and the location phone, and {{signature}} laid out inside the card.
//
// It is COMMERCIAL (pure brand promo, no transactional content), so its #115
// CAN-SPAM footer is REQUIRED and sits in the card's footer slot, above the
// teal band. It used to be held on the plain bodyToHtml path because branded
// chrome on a footer-less commercial email would have looked official while
// non-compliant; #115 shipped the footer, so that reason is gone.
//
// FAIL CLOSED, same as the Closed-Job follow-ups: no footer → throw rather
// than render a footer-less commercial email. sendWelcomeEmail builds the
// footer first and holds the send if it can't, so this is a backstop.
// Pure + exported so layout and footer placement are testable without the DB.
export function renderWelcomeEmailContent(
  renderedBody: string,
  brandCtx: BrandedEmailContext,
  canSpamFooter: CardFooter | null | undefined,
): { html: string; text: string } {
  if (!canSpamFooter) {
    throw new Error('the welcome email is commercial and needs its CAN-SPAM footer')
  }
  return {
    html: buildBrandedDripHtml(renderedBody, brandCtx, canSpamFooter),
    text: buildBrandedDripText(renderedBody, brandCtx, canSpamFooter),
  }
}

// ──────────────────────────────────────────────────────────────────────
// Schedule
// ──────────────────────────────────────────────────────────────────────
// Idempotent: skips leads that already have welcome_email_sent_at set
// (already sent — don't reschedule) or welcome_email_scheduled_at set
// (already pending — don't push it out). Caller is fire-and-forget; the
// result is for logs and tests, never for control flow.
//
// NEW LEADS ONLY: a past client is refused before anything is written, and
// so is anyone the past-client lookup could not answer for. The cost of a
// wrong "no" is one missed brand email to a stranger; the cost of a wrong
// "yes" is an owner's client being welcomed like someone off the street.

export type ScheduleWelcomeResult = 'scheduled' | 'returning_client' | 'check_failed' | 'error'

export async function scheduleWelcomeEmail(
  leadId: string,
  // The caller's already-loaded lead facts, when it has them (drip-send does).
  known: PastClientFacts | null = null,
): Promise<ScheduleWelcomeResult> {
  try {
    const { pastClientCheck } = await import('./drip-lifecycle')
    const who = await pastClientCheck(leadId, known)
    if (who.past) return 'returning_client'
    if (who.failed) {
      console.error('[welcome] scheduleWelcomeEmail: past-client check failed — not scheduling', { leadId })
      return 'check_failed'
    }

    const scheduledAt = new Date(Date.now() + WELCOME_DELAY_MS).toISOString()

    const { error } = await supabaseService
      .from('leads')
      .update({ welcome_email_scheduled_at: scheduledAt })
      .eq('id', leadId)
      .is('welcome_email_sent_at', null)
      .is('welcome_email_scheduled_at', null)

    if (error) {
      console.error('[welcome] scheduleWelcomeEmail: update failed', { leadId, error })
      return 'error'
    }
    return 'scheduled'
  } catch (err) {
    console.error('[welcome] scheduleWelcomeEmail: unexpected error', { leadId, err })
    return 'error'
  }
}

// ──────────────────────────────────────────────────────────────────────
// Cancel
// ──────────────────────────────────────────────────────────────────────
// Clears a PENDING welcome (scheduled, not yet sent) back to the
// documented steady state (both columns NULL — "no welcome pending or
// sent"). Used when the lead is junked, opts out of marketing, or exits
// New/Attempting: the welcome is an extension of the new-lead drip, and
// a "thanks for reaching out" email after any of those transitions
// reads wrong. Clearing scheduled_at (rather than tombstoning sent_at
// the way the no-email path does) deliberately leaves the lead eligible
// for a future re-schedule if a fresh drip ever fires step 1 again —
// e.g. an opt-out that later gets reversed.
//
// PAUSE IS DIFFERENT: pause does NOT cancel. A paused lead's welcome is
// HELD by the send-time gate in sendWelcomeEmail (pause is temporary;
// the cron re-picks the row every tick and sends on the first tick
// after resume). Junk / opt-out / stage-exit cancel; pause holds.

export async function cancelPendingWelcomeEmail(
  leadId: string,
  // 'closed_lost' — issue 204, a no-engagement lead closed "not interested".
  // 'returning_client' — the send-time new-leads-only gate found a past client.
  reason: 'junk' | 'opted_out' | 'stage_changed' | 'closed_lost' | 'returning_client',
): Promise<void> {
  try {
    const { error } = await supabaseService
      .from('leads')
      .update({ welcome_email_scheduled_at: null })
      .eq('id', leadId)
      .is('welcome_email_sent_at', null)
      .not('welcome_email_scheduled_at', 'is', null)

    if (error) {
      console.error('[welcome] cancelPendingWelcomeEmail: update failed', { leadId, reason, error })
    }
  } catch (err) {
    console.error('[welcome] cancelPendingWelcomeEmail: unexpected error', { leadId, reason, err })
  }
}

// ──────────────────────────────────────────────────────────────────────
// Send
// ──────────────────────────────────────────────────────────────────────
// Render the Welcome master template against the lead's context and
// send. Sets welcome_email_sent_at on success (idempotent: stops the
// row from being picked up again by the cron). Records a 'drip'
// touchpoint so it shows up in the Outreach timeline.
//
// Send-time gates (authoritative — the lifecycle cancel hooks are best
// effort): junk and marketing_opt_out CANCEL the pending welcome;
// paused HOLDS it (row untouched, released by the first cron tick after
// resume).

export type SendWelcomeResult = {
  sent: boolean
  error?: string
}

// ──────────────────────────────────────────────────────────────────────
// Resolve the location's customized copy of the Welcome template (issue 206)
// ──────────────────────────────────────────────────────────────────────
// Identical latent constraint to the stage emails (see lib/stage-emails.ts):
// the Welcome master is Duplicate-able in the Templates tab, which forks a
// location-scoped copy carrying location_uuid set AND legacy_id NULL — so the
// fork matches neither of the master's predicates and is reached via
// cloned_from_id → master.id. Prefer the active fork; fall back to the master
// on an inactive/deleted fork, no fork, or a DB error. Most-recently-updated
// active fork wins when Duplicate was pressed more than once.

export async function sendWelcomeEmail(leadId: string): Promise<SendWelcomeResult> {
  // Lead
  const { data: lead, error: leadErr } = await supabaseService
    .from('leads')
    .select('id, name, first_name, email, location_uuid, assigned_to, welcome_email_sent_at, is_junk, paused, marketing_opt_out, import_source, paid_amount')
    .eq('id', leadId)
    .maybeSingle()

  if (leadErr || !lead) {
    return { sent: false, error: `lead_lookup: ${leadErr?.message ?? 'missing'}` }
  }

  // Already sent (cron raced itself, or this was called twice). No-op.
  if (lead.welcome_email_sent_at) return { sent: false, error: 'already_sent' }

  // Junked → cancel the pending welcome (the lifecycle hook already
  // tries this on the is_junk PATCH; this is the authoritative backstop).
  if (lead.is_junk === true) {
    await cancelPendingWelcomeEmail(leadId, 'junk')
    return { sent: false, error: 'junk' }
  }

  // Opted out of marketing → cancel, never send.
  if (lead.marketing_opt_out === true) {
    await cancelPendingWelcomeEmail(leadId, 'opted_out')
    return { sent: false, error: 'opted_out' }
  }

  // Paused → HOLD, don't cancel. Leaving the row untouched means the
  // cron re-considers it every tick and the welcome goes out on the
  // first tick after the lead is resumed.
  if (lead.paused === true) {
    return { sent: false, error: 'paused' }
  }

  // Returning client → CANCEL, never send. The schedule-time gate already
  // refuses them; this is the backstop for someone who became a client in the
  // 24 hours since (a Closed Won, a payment), or a row queued by any other
  // door. A lookup that fails HOLDS instead (scheduled_at intact, the cron
  // asks again next tick) — never a send on a guess.
  {
    const { pastClientCheck } = await import('./drip-lifecycle')
    const who = await pastClientCheck(leadId, {
      import_source: lead.import_source ?? null,
      paid_amount: lead.paid_amount ?? null,
    })
    if (who.past) {
      await cancelPendingWelcomeEmail(leadId, 'returning_client')
      return { sent: false, error: 'returning_client' }
    }
    if (who.failed) {
      return { sent: false, error: 'past_client_check_failed' }
    }
  }

  // No email → mark sent so it never gets retried, log skip.
  if (!lead.email || typeof lead.email !== 'string' || !lead.email.trim()) {
    await supabaseService
      .from('leads')
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq('id', leadId)
    return { sent: false, error: 'no_email' }
  }

  // Location
  if (!lead.location_uuid) return { sent: false, error: 'no_location' }
  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, sender_name, phone, calendar_link, reviews_link, rate_per_hour, city, state')
    .eq('id', lead.location_uuid)
    .maybeSingle()

  if (locErr || !loc) {
    return { sent: false, error: `loc_lookup: ${locErr?.message ?? 'missing'}` }
  }

  // Welcome template — the master (location_uuid IS NULL). This is the default
  // and the fallback; issue 206 prefers the location's customized copy (fork)
  // below. `id` is selected so the fork can be found via cloned_from_id.
  const { data: master, error: tplErr } = await supabaseService
    .from('templates')
    .select('id, subject, body')
    .eq('legacy_id', WELCOME_LEGACY_ID)
    .is('location_uuid', null)
    .maybeSingle()

  if (tplErr || !master) {
    return { sent: false, error: `template_lookup: ${tplErr?.message ?? 'missing'}` }
  }

  // issue 206 — prefer the owner's customized copy, falling back to the master.
  // The CAN-SPAM footer below stays unconditional for Welcome (a commercial
  // email), and the rate / booking-link holds run against this `tpl` — so a
  // customized body can neither strip the footer nor ship an unfilled token.
  const fork = await resolveLocationTemplateFork(master.id, loc.id)
  const tpl = {
    subject: fork?.subject ?? master.subject,
    body: fork?.body ?? master.body,
  }

  // RATE GUARD: template quotes {{rate_per_hour}} but the location has no
  // rate. HOLD — scheduled_at stays intact so the cron retries every tick
  // and the welcome goes out on the first tick after the rate is entered.
  if (blockedOnMissingRate(tpl, loc.rate_per_hour)) {
    console.warn('[welcome] held: template quotes {{rate_per_hour}} but location rate is blank', {
      leadId, locationId: loc.id,
    })
    return { sent: false, error: 'missing_rate' }
  }

  // Owners (location owner + assigned-to user). Location owner resolves to the
  // DESIGNATED primary owner (Phase 2) via the shared resolver, which falls
  // back to legacy hub_users role='owner' for pre-seat locations.
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

  // BOOKING-LINK GUARD: the welcome asks the client to click a scheduling
  // link and none resolves. HOLD — scheduled_at intact so the cron retries
  // every tick and it goes out on the first tick after a link is set.
  if (
    blockedOnMissingBookingLink(
      { subject: tpl.subject, body: tpl.body },
      { ownerBookingLink, locationCalendarLink: loc.calendar_link },
    )
  ) {
    console.warn('[welcome] held: template quotes a booking tag but no link resolves', {
      leadId, locationId: loc.id,
    })
    return { sent: false, error: 'missing_booking_link' }
  }

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

  const rendered = renderTemplate({ subject: tpl.subject, body: tpl.body }, ctx, { signatureMarker: true })

  // SUBJECT GUARD (issue 316): the resolved subject is blank — the template
  // subject is NULL/empty, or it renders to nothing. HOLD — scheduled_at stays
  // intact so the cron retries every tick and the welcome goes out on the
  // first tick after a subject is saved on the template. Never substitute a
  // placeholder-subject fallback — that disguised the gap for a month in
  // July 2026.
  if (!rendered.subject.trim()) {
    console.warn('[welcome] held: email subject is blank — send held until a subject is set on the template', {
      leadId, locationId: loc.id,
    })
    return { sent: false, error: 'missing_subject' }
  }

  // {{signature}}: resolved only when the template uses it — same chain as
  // drips and follow-ups.
  const signature = hasSignatureTag(tpl.body)
    ? await resolveEmailSignature({
        locationId: loc.id,
        locationName: loc.name,
        assigneeUserId: lead.assigned_to ?? null,
      })
    : null

  // #115 — the Welcome email is COMMERCIAL (pure brand promo, no transactional
  // content), so it must carry a CAN-SPAM footer: a working unsubscribe link +
  // physical postal address. Audience 'inquiry' because the recipient asked
  // about Bee Organized (they never joined a mailing list — an inaccurate reason
  // line is itself a deceptive-header problem). It goes inside the branded
  // card, above the teal band (renderWelcomeEmailContent).
  //
  // FAIL CLOSED: if no token can be minted or MARKETING_POSTAL_ADDRESS is unset,
  // HOLD — leave welcome_email_scheduled_at intact (do NOT mark sent) so the cron
  // retries and the email goes out on the first tick after the gap is fixed,
  // exactly like the rate / booking-link holds above. A non-compliant send is the
  // violation; not sending is the safe failure.
  const footer = await buildCanSpamFooter({ leadId: lead.id, audience: 'inquiry' })
  if (!footer.ok) {
    console.warn('[welcome] held: CAN-SPAM footer could not be built — send refused', {
      leadId, locationId: loc.id, reason: footer.reason,
    })
    return { sent: false, error: `canspam_${footer.reason}` }
  }

  const { html, text } = renderWelcomeEmailContent(
    rendered.body,
    {
      location_name: loc.name,
      location_phone: loc.phone,
      reviews_link: loc.reviews_link,
      signature,
    },
    { html: footer.html, text: footer.text },
  )

  const result = await sendEmail({
    locationId: loc.id,
    to: lead.email.trim(),
    subject: rendered.subject,
    html,
    text,
    // Notebook context (#103): welcome shares the drip's sendEmail path and
    // had the same null email_kind / lead_id gap. Stamp it so it isn't the one
    // outbound rail still invisible to the notification_log queries.
    lead_id: lead.id,
    lead_name: lead.name ?? null,
    email_kind: 'welcome',
  })

  if (!result.success) {
    // Leave scheduled_at intact so cron retries next tick.
    return { sent: false, error: `send: ${result.error}` }
  }

  // Mark sent + record a touchpoint.
  const nowIso = new Date().toISOString()
  const { error: updErr } = await supabaseService
    .from('leads')
    .update({ welcome_email_sent_at: nowIso })
    .eq('id', leadId)
  if (updErr) {
    console.error('[welcome] sendWelcomeEmail: mark-sent failed', { leadId, updErr })
  }

  const { error: tpErr } = await supabaseService.from('touchpoints').insert({
    lead_id: leadId,
    location_uuid: loc.id,
    kind: 'drip',
    method: 'email',
    label: 'Welcome Email',
    status: 'sent',
    occurred_at: nowIso,
  })
  if (tpErr) {
    console.error('[welcome] sendWelcomeEmail: touchpoint insert failed', { leadId, tpErr })
  }

  return { sent: true }
}
