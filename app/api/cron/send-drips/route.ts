// app/api/cron/send-drips/route.ts
//
// GET /api/cron/send-drips — Vercel cron entrypoint, fires every hour.
//
// Pulls every lead_drip_progress row whose next_send_at <= now() (and is
// not paused/stopped/completed), renders the step's template with the
// lead+location context, sends via Resend, and advances current_step.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. For
// manual testing in dev, also accepts `?secret=<value>`.
//
// Channel scope: email only for now. SMS/call steps auto-advance without
// sending (placeholder until those channels are wired up).

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { sendEmail, renderTemplate, type RenderContext } from '@/lib/resend'
import { nextSendAt } from '@/lib/drip-time'

// Prevent Next.js from trying to prerender this route at build time.
export const dynamic = 'force-dynamic'

// Hard cap per cron run — safety against a flood, prevents Vercel
// function timeout. Hourly cron + 100 cap = up to 2400 sends/day,
// plenty for our launch volume.
const BATCH_LIMIT = 100

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const expected = `Bearer ${secret}`
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== expected && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ─── Pull due rows ─────────────────────────────────────────────
  // We hydrate progress + the joined step/template inline. Lead and
  // location are loaded in follow-up queries (Supabase REST nested-select
  // syntax gets brittle once we need both directions of joins).
  const nowIso = new Date().toISOString()
  const { data: dueRows, error: dueErr } = await supabaseService
    .from('lead_drip_progress')
    .select(
      `
      id, lead_id, drip_path_id, current_step, next_send_at,
      drip_paths!inner ( id, path_key, location_uuid )
      `,
    )
    .lte('next_send_at', nowIso)
    .is('paused_at', null)
    .is('stopped_at', null)
    .is('completed_at', null)
    .limit(BATCH_LIMIT)

  if (dueErr) {
    console.error('[cron] due-rows query failed', dueErr)
    return NextResponse.json({ error: 'due_query_failed', detail: dueErr.message }, { status: 500 })
  }

  let sent = 0
  let skipped = 0
  let failed = 0
  const errors: Array<{ progressId: string; reason: string }> = []

  for (const row of dueRows ?? []) {
    // Supabase returns the joined relation as a single object when the
    // FK is single-valued, but the TS types narrow it to an array. Cast.
    const path = (Array.isArray((row as any).drip_paths)
      ? (row as any).drip_paths[0]
      : (row as any).drip_paths) as { id: string; location_uuid: string } | null

    if (!path) {
      failed++
      errors.push({ progressId: row.id, reason: 'no_path_join' })
      continue
    }

    // Step for current_step + the linked master template
    const { data: step, error: stepErr } = await supabaseService
      .from('drip_path_steps')
      .select(
        `
        id, step_order, delay_days, channel, subject, body, master_template_id,
        master_templates ( subject, body )
        `,
      )
      .eq('drip_path_id', path.id)
      .eq('step_order', row.current_step)
      .maybeSingle()

    if (stepErr || !step) {
      failed++
      errors.push({ progressId: row.id, reason: `step_lookup: ${stepErr?.message ?? 'missing'}` })
      continue
    }

    // Lead
    const { data: lead, error: leadErr } = await supabaseService
      .from('leads')
      .select('id, name, first_name, email, location_uuid')
      .eq('id', row.lead_id)
      .maybeSingle()

    if (leadErr || !lead) {
      failed++
      errors.push({ progressId: row.id, reason: `lead_lookup: ${leadErr?.message ?? 'missing'}` })
      continue
    }

    // No email → stop this drip permanently with reason='no_email'
    if (!lead.email || typeof lead.email !== 'string' || !lead.email.trim()) {
      await supabaseService
        .from('lead_drip_progress')
        .update({ stopped_at: new Date().toISOString(), stopped_reason: 'no_email' })
        .eq('id', row.id)
      skipped++
      continue
    }

    // Non-email channel → advance past it for now (sms/call not wired).
    if (step.channel !== 'email') {
      await advanceOrComplete(row.id, path.id, row.current_step, null)
      skipped++
      continue
    }

    // Location (for sender context + timezone for scheduling next step)
    const { data: loc, error: locErr } = await supabaseService
      .from('locations')
      .select('id, name, sender_name, phone, calendar_link, city, state, timezone')
      .eq('id', path.location_uuid)
      .maybeSingle()

    if (locErr || !loc) {
      failed++
      errors.push({ progressId: row.id, reason: `loc_lookup: ${locErr?.message ?? 'missing'}` })
      continue
    }

    // Phone fallback: location.phone, else owner's hub_users.phone.
    let phone: string | null = loc.phone ?? null
    if (!phone) {
      const { data: owner } = await supabaseService
        .from('hub_users')
        .select('phone')
        .eq('location_id', loc.id)
        .eq('role', 'owner')
        .limit(1)
        .maybeSingle()
      phone = owner?.phone ?? null
    }

    // Subject/body: step override > template
    const masterTpl = (Array.isArray((step as any).master_templates)
      ? (step as any).master_templates[0]
      : (step as any).master_templates) as { subject: string | null; body: string } | null

    const subjectSource = step.subject ?? masterTpl?.subject ?? null
    const bodySource = step.body ?? masterTpl?.body ?? null

    if (!bodySource) {
      failed++
      errors.push({ progressId: row.id, reason: 'no_body_source' })
      continue
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
    }

    const rendered = renderTemplate({ subject: subjectSource, body: bodySource }, ctx)

    // Plain text fallback derived from the body (Resend accepts both)
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
      failed++
      errors.push({ progressId: row.id, reason: `send: ${result.error}` })
      // Leave row unchanged so next hour retries.
      continue
    }

    sent++
    await advanceOrComplete(row.id, path.id, row.current_step, loc.timezone)
  }

  return NextResponse.json({
    sent,
    skipped,
    failed,
    considered: dueRows?.length ?? 0,
    errors: errors.slice(0, 20),
  })
}

// Look for the next step. If it exists, schedule its send. If not, mark
// the drip completed. `tz` is the location timezone (null is fine — the
// helper falls back to UTC).
async function advanceOrComplete(
  progressId: string,
  dripPathId: string,
  currentStepOrder: number,
  tz: string | null,
): Promise<void> {
  const { data: nextStep, error: nextErr } = await supabaseService
    .from('drip_path_steps')
    .select('step_order, delay_days')
    .eq('drip_path_id', dripPathId)
    .eq('step_order', currentStepOrder + 1)
    .maybeSingle()

  const nowIso = new Date().toISOString()

  if (nextErr) {
    console.error('[cron] next-step lookup failed', { progressId, nextErr })
    return
  }

  if (!nextStep) {
    // No more steps — mark complete.
    await supabaseService
      .from('lead_drip_progress')
      .update({ completed_at: nowIso, last_sent_at: nowIso })
      .eq('id', progressId)
    return
  }

  // Schedule next send at 9am in location tz, `delay_days` after now.
  // The step's delay_days are absolute-from-start, but for scheduling
  // the *next* gap we want the difference vs. the current step. Look
  // up the current step's delay_days for that math.
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
}

// Minimal text→HTML: escape, then turn paragraph breaks into <p>.
// Templates are plain text today; this keeps Resend's HTML field happy
// without pretending to be a full Markdown renderer.
function bodyToHtml(text: string): string {
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
