// lib/drip-send.ts
//
// Shared per-step drip send logic. Originally lived inline in
// app/api/cron/send-drips/route.ts; extracted so /api/leads can fire
// step 1 inline at lead-create time (sub-5-second welcome email) while
// the cron remains as the hourly catch-up.
//
// sendDripStep(leadId) loads the lead's active drip progress, and if
// the current step is due, renders the template, sends via Resend, and
// advances current_step + next_send_at. Idempotent — re-entry after an
// advance sees not-due (or no active drip) and returns { sent: false }.

import { supabaseService } from './supabase-service'
import { sendEmail, renderTemplate, type RenderContext } from './resend'
import { nextSendAt } from './drip-time'
import { scheduleWelcomeEmail } from './welcome-email'

export type SendDripResult = {
  sent: boolean
  // 'no_email' / 'non_email_channel' are expected skips (drip is auto
  // stopped / auto advanced). Anything else is a real failure that the
  // cron should retry on the next tick.
  error?: string
  advanced_to_step?: number
}

export async function sendDripStep(leadId: string): Promise<SendDripResult> {
  const nowIso = new Date().toISOString()

  const { data: progress, error: progErr } = await supabaseService
    .from('lead_drip_progress')
    .select(
      `
      id, lead_id, drip_path_id, current_step, next_send_at,
      drip_paths!inner ( id, path_key )
      `,
    )
    .eq('lead_id', leadId)
    .is('paused_at', null)
    .is('stopped_at', null)
    .is('completed_at', null)
    .lte('next_send_at', nowIso)
    .order('next_send_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (progErr) {
    return { sent: false, error: `progress_lookup: ${progErr.message}` }
  }
  if (!progress) {
    // No active drip for this lead, or step isn't due yet — both no-ops.
    return { sent: false }
  }

  return sendDripStepForRow(progress as DripProgressRow)
}

type DripProgressRow = {
  id: string
  lead_id: string
  drip_path_id: string
  current_step: number
  next_send_at: string
  drip_paths: unknown
}

// Process a single already-loaded due row. Exported for the cron, which
// fetches the batch of due rows itself and avoids the extra lookup.
export async function sendDripStepForRow(row: DripProgressRow): Promise<SendDripResult> {
  const path = (Array.isArray(row.drip_paths)
    ? (row.drip_paths as any[])[0]
    : row.drip_paths) as { id: string } | null

  if (!path) return { sent: false, error: 'no_path_join' }

  // Step + linked template
  const { data: step, error: stepErr } = await supabaseService
    .from('drip_path_steps')
    .select(
      `
      id, step_order, delay_days, channel, subject, body, master_template_id,
      templates:master_template_id ( subject, body )
      `,
    )
    .eq('drip_path_id', path.id)
    .eq('step_order', row.current_step)
    .maybeSingle()

  if (stepErr || !step) {
    return { sent: false, error: `step_lookup: ${stepErr?.message ?? 'missing'}` }
  }

  // Lead
  const { data: lead, error: leadErr } = await supabaseService
    .from('leads')
    .select('id, name, first_name, email, location_uuid, assigned_to')
    .eq('id', row.lead_id)
    .maybeSingle()

  if (leadErr || !lead) {
    return { sent: false, error: `lead_lookup: ${leadErr?.message ?? 'missing'}` }
  }

  // No email → stop this drip permanently with reason='no_email'
  if (!lead.email || typeof lead.email !== 'string' || !lead.email.trim()) {
    await supabaseService
      .from('lead_drip_progress')
      .update({ stopped_at: new Date().toISOString(), stopped_reason: 'no_email' })
      .eq('id', row.id)
    return { sent: false, error: 'no_email' }
  }

  // Non-email channel → advance past it (sms/call not wired yet).
  if (step.channel !== 'email') {
    const advancedTo = await advanceOrComplete(row.id, path.id, row.current_step, null)
    return { sent: false, error: 'non_email_channel', advanced_to_step: advancedTo }
  }

  // Lead is the source of truth for location. drip_paths.location_uuid is
  // NULL on master paths by design (clone-on-customize), so reading the
  // location off the path crashes the uuid cast for any lead still on a
  // master.
  if (!lead.location_uuid) return { sent: false, error: 'no_location' }

  // Location (sender context + tz for scheduling next step). rate_per_hour
  // and reviews_link are new variables exposed to render context for the
  // 8 master path templates + opp-stage emails.
  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, sender_name, phone, calendar_link, reviews_link, rate_per_hour, city, state, timezone')
    .eq('id', lead.location_uuid)
    .maybeSingle()

  if (locErr || !loc) {
    return { sent: false, error: `loc_lookup: ${locErr?.message ?? 'missing'}` }
  }

  // Location owner (one query, two uses: phone fallback + location_owner_name).
  const { data: locOwner } = await supabaseService
    .from('hub_users')
    .select('full_name, phone')
    .eq('location_id', loc.id)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()

  const phone: string | null = loc.phone ?? locOwner?.phone ?? null
  const locationOwnerName = locOwner?.full_name ?? null

  // Assigned-to user (drives {{owner_name}} / {{owner_first_name}} for the
  // *request owner* — that's what Zoho's "Request Owner" mapped to and what
  // the email content references when it talks about the person reaching
  // out to the lead). Falls back to the location owner if unassigned, so
  // {{owner_name}} is never blank.
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

  // Subject/body: step override > linked template
  const linkedTpl = (Array.isArray((step as any).templates)
    ? (step as any).templates[0]
    : (step as any).templates) as { subject: string | null; body: string } | null

  const subjectSource = step.subject ?? linkedTpl?.subject ?? null
  const bodySource = step.body ?? linkedTpl?.body ?? null

  if (!bodySource) {
    return { sent: false, error: 'no_body_source' }
  }

  // First-name fallback: lead.first_name, else first word of lead.name
  const firstName =
    lead.first_name && lead.first_name.trim()
      ? lead.first_name.trim()
      : (lead.name ?? '').trim().split(/\s+/)[0] || null

  const serviceArea =
    loc.city && loc.state
      ? `${loc.city}, ${loc.state}`
      : loc.city || loc.state || null

  const ctx: RenderContext = {
    first_name: firstName,
    organizer_name: loc.sender_name,
    location_name: loc.name,
    phone,
    booking_link: loc.calendar_link,
    service_area: serviceArea,
    owner_name: ownerName,
    owner_first_name: ownerFirstName,
    location_owner_name: locationOwnerName,
    rate_per_hour: loc.rate_per_hour,
    location_phone: loc.phone,
    book_assessment_link: loc.calendar_link,
    reviews_link: loc.reviews_link,
  }

  const rendered = renderTemplate({ subject: subjectSource, body: bodySource }, ctx)

  const text = rendered.body
  const html = bodyToHtml(rendered.body)

  const result = await sendEmail({
    locationId: loc.id,
    to: lead.email.trim(),
    subject: rendered.subject || `(no subject)`,
    html,
    text,
  })

  if (!result.success) {
    // Leave row unchanged so the next cron tick retries.
    return { sent: false, error: `send: ${result.error}` }
  }

  // Step 1 of any new-lead drip triggers the 24h Welcome Email. Fire and
  // forget — a failed schedule is logged inside scheduleWelcomeEmail and
  // doesn't block drip progression.
  if (row.current_step === 1) {
    await scheduleWelcomeEmail(row.lead_id)
  }

  const advancedTo = await advanceOrComplete(row.id, path.id, row.current_step, loc.timezone)
  return { sent: true, advanced_to_step: advancedTo }
}

// Look for the next step. If it exists, schedule its send. If not, mark
// the drip completed. `tz` is the location timezone (null is fine — the
// helper falls back to UTC). Returns the new step_order, or undefined
// when the drip completed.
export async function advanceOrComplete(
  progressId: string,
  dripPathId: string,
  currentStepOrder: number,
  tz: string | null,
): Promise<number | undefined> {
  const { data: nextStep, error: nextErr } = await supabaseService
    .from('drip_path_steps')
    .select('step_order, delay_days')
    .eq('drip_path_id', dripPathId)
    .eq('step_order', currentStepOrder + 1)
    .maybeSingle()

  const nowIso = new Date().toISOString()

  if (nextErr) {
    console.error('[drip-send] next-step lookup failed', { progressId, nextErr })
    return undefined
  }

  if (!nextStep) {
    await supabaseService
      .from('lead_drip_progress')
      .update({ completed_at: nowIso, last_sent_at: nowIso })
      .eq('id', progressId)
    return undefined
  }

  // step.delay_days is absolute-from-start; the *gap* to the next send
  // is the diff vs the current step's delay_days.
  const { data: currentStep } = await supabaseService
    .from('drip_path_steps')
    .select('delay_days')
    .eq('drip_path_id', dripPathId)
    .eq('step_order', currentStepOrder)
    .maybeSingle()

  const currentDelay = currentStep?.delay_days ?? 0
  const gap = Math.max(0, (nextStep.delay_days ?? 0) - currentDelay)

  const next = nextSendAt({ from: new Date(), tz: tz ?? 'UTC', delayDays: gap })

  await supabaseService
    .from('lead_drip_progress')
    .update({
      current_step: nextStep.step_order,
      last_sent_at: nowIso,
      next_send_at: next.toISOString(),
    })
    .eq('id', progressId)

  return nextStep.step_order
}

// Minimal text→HTML: escape, then turn paragraph breaks into <p>.
// Templates are plain text today; this keeps Resend's HTML field happy
// without pretending to be a full Markdown renderer.
export function bodyToHtml(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const paragraphs = esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('\n')
  return `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#222">${paragraphs}</div>`
}
