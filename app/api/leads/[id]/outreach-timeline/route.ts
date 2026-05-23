// app/api/leads/[id]/outreach-timeline/route.ts
//
// GET /api/leads/:id/outreach-timeline
//
// Returns a per-lead drip timeline: past sent steps (best-effort dates),
// the currently scheduled step, and all remaining future steps with
// computed fire dates. The Outreach tab in PersonPanel merges this with
// in-memory stage changes + manual reach-outs from person.outreachTimeline.
//
// Only "active" drips (stopped_at IS NULL AND completed_at IS NULL) are
// considered. Completed/stopped drips return no items here — those states
// are represented only via the existing /api/leads/:id/drip endpoint.
//
// Auth: same as other lead endpoints — owner sees own location's leads,
// super_admin sees all.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { renderTemplate, type RenderContext } from '@/lib/resend'

type TimelineStatus = 'sent' | 'scheduled' | 'paused' | 'scheduled_future' | 'paused_future'

interface TimelineItem {
  id: string
  type: 'drip'
  step_order: number
  template_name: string | null
  subject: string | null
  channel: 'email' | 'sms' | 'call' | string
  status: TimelineStatus
  fired_at: string | null
  scheduled_at: string | null
  drip_progress_id: string
  paused: boolean
}

// Day in ms — used for sent-step backfill estimation when we don't have
// per-step send history yet.
const DAY_MS = 24 * 60 * 60 * 1000

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  const { data: lead } = await supabaseService
    .from('leads')
    .select('id, name, first_name, location_uuid')
    .eq('id', id)
    .single()
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })

  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // ─── Find the active drip (if any) ─────────────────────────────────
  const { data: prog, error: progErr } = await supabaseService
    .from('lead_drip_progress')
    .select(
      'id, drip_path_id, current_step, next_send_at, last_sent_at, paused_at, drip_paths(name, path_key)',
    )
    .eq('lead_id', id)
    .is('stopped_at', null)
    .is('completed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (progErr) {
    console.error('[outreach-timeline] progress lookup failed', progErr)
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 })
  }

  if (!prog) {
    // Lead might still have a completed/stopped drip — surface that flag
    // so the UI can show a "Drip completed/stopped" marker. We do not
    // enumerate steps for inactive drips.
    const { data: inactive } = await supabaseService
      .from('lead_drip_progress')
      .select('id, completed_at, stopped_at, drip_paths(name, path_key)')
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const inactivePath = inactive
      ? (Array.isArray((inactive as any).drip_paths)
          ? (inactive as any).drip_paths[0]
          : (inactive as any).drip_paths)
      : null

    return NextResponse.json({
      items: [],
      drip_progress_id: inactive?.id ?? null,
      drip_path_name: inactivePath?.name ?? null,
      paused: false,
      stopped: !!inactive?.stopped_at,
      completed: !!inactive?.completed_at,
      completed_at: (inactive as any)?.completed_at ?? null,
      stopped_at: (inactive as any)?.stopped_at ?? null,
    })
  }

  const path = Array.isArray((prog as any).drip_paths)
    ? (prog as any).drip_paths[0]
    : (prog as any).drip_paths

  // ─── Pull all steps + linked template content ──────────────────────
  const { data: steps, error: stepsErr } = await supabaseService
    .from('drip_path_steps')
    .select(
      'id, step_order, delay_days, channel, subject, body, master_template_id, templates:master_template_id(name, subject)',
    )
    .eq('drip_path_id', prog.drip_path_id)
    .order('step_order', { ascending: true })

  if (stepsErr) {
    console.error('[outreach-timeline] steps lookup failed', stepsErr)
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 })
  }

  // ─── Render-context for subject previews ───────────────────────────
  // Mirrors cron's renderTemplate inputs so the previewed subject matches
  // what will actually send.
  const { data: loc } = await supabaseService
    .from('locations')
    .select('name, sender_name, phone, calendar_link, city, state')
    .eq('id', lead.location_uuid)
    .maybeSingle()

  const firstName =
    lead.first_name && (lead.first_name as string).trim()
      ? (lead.first_name as string).trim()
      : (lead.name ?? '').toString().trim().split(/\s+/)[0] || null

  const serviceArea =
    loc?.city && loc?.state
      ? `${loc.city}, ${loc.state}`
      : loc?.city || loc?.state || null

  const ctx: RenderContext = {
    first_name: firstName,
    organizer_name: loc?.sender_name ?? null,
    location_name: loc?.name ?? null,
    phone: loc?.phone ?? null,
    booking_link: loc?.calendar_link ?? null,
    service_area: serviceArea,
  }

  // ─── Build the items ───────────────────────────────────────────────
  const paused = !!prog.paused_at
  const items: TimelineItem[] = []

  // Find the current step's delay so future-step dates can be offset from
  // next_send_at by the gap between their delay and current_step's delay.
  const currentStepRow = (steps ?? []).find((s) => s.step_order === prog.current_step)
  const currentDelay = currentStepRow?.delay_days ?? 0
  const lastSentAt = prog.last_sent_at ? new Date(prog.last_sent_at) : null
  const nextSendAt = prog.next_send_at ? new Date(prog.next_send_at) : null

  for (const step of steps ?? []) {
    const tpl = (Array.isArray((step as any).templates)
      ? (step as any).templates[0]
      : (step as any).templates) as { name: string | null; subject: string | null } | null

    const subjectSource = (step.subject as string | null) ?? tpl?.subject ?? null
    const rendered = renderTemplate({ subject: subjectSource, body: '' }, ctx)
    const subjectPreview = rendered.subject || null
    const templateName = tpl?.name ?? null
    const stepDelay = step.delay_days ?? 0

    let status: TimelineStatus
    let firedAt: string | null = null
    let scheduledAt: string | null = null

    if (step.step_order < prog.current_step) {
      // Already sent. Best-effort date: the most recently sent step
      // (step_order = current_step - 1) is anchored to last_sent_at.
      // Earlier steps are backed out by their delay diffs.
      status = 'sent'
      if (lastSentAt) {
        const lastSentDelay =
          (steps ?? []).find((s) => s.step_order === prog.current_step - 1)?.delay_days ?? 0
        const offsetDays = Math.max(0, lastSentDelay - stepDelay)
        firedAt = new Date(lastSentAt.getTime() - offsetDays * DAY_MS).toISOString()
      }
    } else if (step.step_order === prog.current_step) {
      status = paused ? 'paused' : 'scheduled'
      scheduledAt = nextSendAt ? nextSendAt.toISOString() : null
    } else {
      status = paused ? 'paused_future' : 'scheduled_future'
      if (nextSendAt) {
        const offsetDays = Math.max(0, stepDelay - currentDelay)
        scheduledAt = new Date(nextSendAt.getTime() + offsetDays * DAY_MS).toISOString()
      }
    }

    items.push({
      id: `drip-step-${step.step_order}-${prog.id}`,
      type: 'drip',
      step_order: step.step_order,
      template_name: templateName,
      subject: subjectPreview,
      channel: (step.channel as string) || 'email',
      status,
      fired_at: firedAt,
      scheduled_at: scheduledAt,
      drip_progress_id: prog.id,
      paused,
    })
  }

  return NextResponse.json({
    items,
    drip_progress_id: prog.id,
    drip_path_name: path?.name ?? null,
    paused,
    stopped: false,
    completed: false,
    completed_at: null,
    stopped_at: null,
  })
}
