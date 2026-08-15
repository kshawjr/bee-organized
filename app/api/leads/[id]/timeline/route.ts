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
import { resolveLocationTemplateForks } from '@/lib/template-fork'
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
    // Masters carry legacy_id (customs/forks never do). name + subject default
    // from the master; `id` is selected so issue 206's fork override below can
    // map a location's copy back to its key via cloned_from_id.
    const { data: masters } = await supabaseService
      .from('templates')
      .select('id, legacy_id, name, subject')
      .in('legacy_id', keys)
    const masterIdToKey: Record<string, string> = {}
    for (const t of masters ?? []) {
      templByKey[t.legacy_id] = { name: t.name ?? null, subject: t.subject ?? null }
      masterIdToKey[t.id] = t.legacy_id
    }

    // issue 206 — once the sender prefers a location's customized copy, this
    // preview must show the SAME subject or it actively misleads the owner
    // watching this tab. A fork carries location_uuid set AND legacy_id NULL,
    // so it's reached via cloned_from_id → master.id, filtered to this location
    // and to ACTIVE rows, newest-first so the most-recently-updated fork wins
    // when Duplicate was pressed more than once. Only the SUBJECT is overridden
    // — the name (label) stays the master's, mirroring the sender, which keeps
    // the master name as the touchpoint label once the email actually sends.
    const masterIds = Object.keys(masterIdToKey)
    if (masterIds.length > 0 && lead.location_uuid) {
      // issue 240 step 8 — was a fourth inline copy of the fork rule.
      const forks = await resolveLocationTemplateForks(masterIds, lead.location_uuid, '[timeline]')
      // Walk masterIds rather than the Map: this tsconfig's target cannot
      // iterate a Map without downlevelIteration, and vitest transpiles it
      // happily so only `npm run build` catches it.
      for (const masterId of masterIds) {
        const fork = forks.get(masterId)
        const key = masterIdToKey[masterId]
        if (!fork || !key || !templByKey[key]) continue
        templByKey[key] = { ...templByKey[key], subject: fork.subject ?? null }
      }
    }
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
