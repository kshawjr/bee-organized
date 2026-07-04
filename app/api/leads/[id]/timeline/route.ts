// app/api/leads/[id]/timeline/route.ts
//
// GET /api/leads/:id/timeline — the DB-backed half of the unified
// activity timeline (components/hive/shared/Timeline.jsx). Returns RAW
// rows per source; the component owns the merge/split/dedup:
//   past   — touchpoints, lead_notes, Jobber records (service_requests/
//            quotes/jobs/invoices by lead_id), engagement closes
//   future — pending scheduled_stage_emails (sent_at IS NULL AND
//            cancelled_at IS NULL, template name/subject joined via
//            templates.legacy_id), assessments, plus the lead's own
//            snoozed_until / welcome_email_scheduled_at fields
// FUTURE DRIP sends are deliberately NOT here — the component reuses the
// existing /api/leads/:id/outreach-timeline projection for those.
//
// Auth: same block as outreach-timeline — logged-in hub_user; admins any
// location, everyone else scoped to the lead's location_uuid.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

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
    .select('id, location_uuid, stage, snoozed_until, snoozed_note, welcome_email_scheduled_at, welcome_email_sent_at, created_at')
    .eq('id', id)
    .single()
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })

  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  const [touchRes, notesRes, engsRes, srRes, quotesRes, jobsRes, invoicesRes, assessRes, stageEmailsRes] = await Promise.all([
    supabaseService.from('touchpoints')
      .select('id, kind, method, label, status, notes, occurred_at, engagement_id, user_id')
      .eq('lead_id', id).order('occurred_at', { ascending: false }).limit(300),
    supabaseService.from('lead_notes')
      .select('id, kind, text, user_label, created_at, engagement_id')
      .eq('lead_id', id).order('created_at', { ascending: false }).limit(300),
    supabaseService.from('engagements')
      .select('id, stage, title, closed_at, closed_reason, closed_note, created_at')
      .eq('client_id', id),
    supabaseService.from('service_requests')
      .select('id, requested_at, created_at, engagement_id, source')
      .eq('lead_id', id),
    supabaseService.from('quotes')
      .select('id, total, status, sent_at, approved_at, created_at, engagement_id')
      .eq('lead_id', id),
    supabaseService.from('jobs')
      .select('id, title, total, status, scheduled_start, completed_at, created_at, engagement_id')
      .eq('lead_id', id),
    supabaseService.from('invoices')
      .select('id, total, status, balance_owing, issued_at, paid_at, engagement_id')
      .eq('lead_id', id),
    supabaseService.from('assessments')
      .select('id, scheduled_at, status, completed_at, engagement_id')
      .eq('lead_id', id),
    supabaseService.from('scheduled_stage_emails')
      .select('id, stage_email_key, send_at')
      .eq('lead_id', id).is('sent_at', null).is('cancelled_at', null),
  ])

  // Pending stage emails carry only a key — resolve the human name +
  // subject from the template row (legacy_id is the join key the sender
  // itself uses in lib/stage-emails).
  const stageEmails = stageEmailsRes.data ?? []
  let templByKey: Record<string, { name: string | null; subject: string | null }> = {}
  if (stageEmails.length > 0) {
    const keys = Array.from(new Set(stageEmails.map(r => r.stage_email_key).filter(Boolean)))
    const { data: templates } = await supabaseService
      .from('templates')
      .select('legacy_id, name, subject')
      .in('legacy_id', keys)
    for (const t of templates ?? []) templByKey[t.legacy_id] = { name: t.name ?? null, subject: t.subject ?? null }
  }

  return NextResponse.json({
    lead: {
      id: lead.id,
      snoozed_until: lead.snoozed_until ?? null,
      snoozed_note: lead.snoozed_note ?? null,
      welcome_email_scheduled_at: lead.welcome_email_scheduled_at ?? null,
      welcome_email_sent_at: lead.welcome_email_sent_at ?? null,
    },
    touchpoints: touchRes.data ?? [],
    notes: notesRes.data ?? [],
    engagements: engsRes.data ?? [],
    service_requests: srRes.data ?? [],
    quotes: quotesRes.data ?? [],
    jobs: jobsRes.data ?? [],
    invoices: invoicesRes.data ?? [],
    assessments: assessRes.data ?? [],
    scheduled_stage_emails: stageEmails.map(r => ({
      ...r,
      template_name: templByKey[r.stage_email_key]?.name ?? null,
      subject: templByKey[r.stage_email_key]?.subject ?? null,
    })),
  })
}
