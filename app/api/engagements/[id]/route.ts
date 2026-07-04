// app/api/engagements/[id]/route.ts
//
// GET   /api/engagements/:id — engagement + full children (chronological)
//   + client summary (name, lifetime paid across ALL engagements, prior
//   count, other-open count). Fetched by EngagementPanel on open so the
//   board rows stay lightweight.
// PATCH /api/engagements/:id — { stage? , title? }
//   stage: forward-only against ENGAGEMENT_STAGE_RANK (engagement-only
//   rank in lib/engagements.ts), stamps stage_entered_at / closed_at.
//   title: non-empty trimmed string (≤200 chars) — retires the generic
//   'Engagement – Jul 2026' fallbacks via inline edit.
//   NEVER touches leads.stage — the lead board stays webhook/import-driven
//   until the read flip retires it (step 6).
//
// Auth (both verbs): logged-in hub_user. super_admin/admin any location;
// everyone else scoped to their own location (hub_users.location_id is
// the location UUID).

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { writeSyncLog } from '@/lib/sync-log'
import { ENGAGEMENT_STAGE_RANK, type EngagementStage } from '@/lib/engagements'

// Close-out vocabulary (doc §4). 'won' is the only Won reason; the rest
// are the Lost picker's options.
const CLOSE_REASONS = ['lost_no_response', 'lost_competitor', 'lost_not_fit', 'written_off', 'lost_other', 'won'] as const

async function authAndLoad(id: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) {
    return { error: NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 }) }
  }

  const { data: engagement, error: engError } = await supabaseService
    .from('engagements')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (engError || !engagement) {
    return { error: NextResponse.json({ error: 'engagement_not_found' }, { status: 404 }) }
  }

  if (!isAdmin(hubUser.role) && hubUser.location_id !== engagement.location_uuid) {
    return { error: NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 }) }
  }

  return { hubUser, engagement }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authAndLoad(id)
  if ('error' in auth) return auth.error
  const { engagement } = auth

  const [srRes, quotesRes, jobsRes, invoicesRes, clientRes, clientEngsRes, assessRes] = await Promise.all([
    supabaseService.from('service_requests').select('*').eq('engagement_id', id).order('requested_at', { ascending: true, nullsFirst: false }),
    supabaseService.from('quotes').select('*').eq('engagement_id', id).order('sent_at', { ascending: true, nullsFirst: false }),
    supabaseService.from('jobs').select('*').eq('engagement_id', id).order('scheduled_start', { ascending: true, nullsFirst: false }),
    supabaseService.from('invoices').select('*').eq('engagement_id', id).order('issued_at', { ascending: true, nullsFirst: false }),
    supabaseService.from('leads').select('id, name, email, phone').eq('id', engagement.client_id).maybeSingle(),
    supabaseService.from('engagements').select('id, stage, total_paid').eq('client_id', engagement.client_id),
    supabaseService.from('assessments').select('*').eq('engagement_id', id).order('scheduled_at', { ascending: true, nullsFirst: false }),
  ])

  const siblings = clientEngsRes.data ?? []
  const num = (v: any) => (v == null ? 0 : Number(v) || 0)
  const lifetimePaid = siblings.reduce((s, e) => s + num(e.total_paid), 0)
  const isOpen = (s: string) => s !== 'Closed Won' && s !== 'Closed Lost'
  const otherOpen = siblings.filter(e => e.id !== id && isOpen(e.stage)).length
  const priorCount = Math.max(0, siblings.length - 1)

  return NextResponse.json({
    engagement,
    children: {
      service_requests: srRes.data ?? [],
      assessments: assessRes.data ?? [],
      quotes: quotesRes.data ?? [],
      jobs: jobsRes.data ?? [],
      invoices: invoicesRes.data ?? [],
    },
    client: {
      id: engagement.client_id,
      name: clientRes.data?.name ?? 'Unknown',
      email: clientRes.data?.email ?? null,
      phone: clientRes.data?.phone ?? null,
      lifetime_paid: lifetimePaid,
      prior_engagements: priorCount,
      other_open: otherOpen,
    },
  })
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authAndLoad(id)
  if ('error' in auth) return auth.error
  const { engagement } = auth

  let body: any = {}
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const stage = body?.stage as EngagementStage | undefined
  const titleRaw = body?.title as unknown

  if (stage === undefined && titleRaw === undefined) {
    return NextResponse.json({ error: 'nothing_to_update', accepts: ['stage', 'title'] }, { status: 400 })
  }

  const nowIso = new Date().toISOString()
  const patch: Record<string, any> = { updated_at: nowIso }
  let stageChanged = false

  if (titleRaw !== undefined) {
    if (typeof titleRaw !== 'string' || titleRaw.trim().length === 0) {
      return NextResponse.json({ error: 'invalid_title' }, { status: 400 })
    }
    patch.title = titleRaw.trim().slice(0, 200)
  }

  if (stage !== undefined) {
    if (!stage || !(stage in ENGAGEMENT_STAGE_RANK)) {
      return NextResponse.json(
        { error: 'invalid_stage', allowed: Object.keys(ENGAGEMENT_STAGE_RANK) },
        { status: 400 },
      )
    }
    const currentRank = ENGAGEMENT_STAGE_RANK[engagement.stage as EngagementStage] ?? 0
    const newRank = ENGAGEMENT_STAGE_RANK[stage]
    const targetTerminal = stage === 'Closed Won' || stage === 'Closed Lost'
    const currentTerminal = engagement.stage === 'Closed Won' || engagement.stage === 'Closed Lost'
    if (stage !== engagement.stage) {
      // Terminal moves are ALWAYS allowed from any OPEN stage (closing is
      // not 'backward'); terminal→terminal stays rejected. Non-terminal
      // moves keep the forward-only rank rule.
      if (currentTerminal || (!targetTerminal && newRank <= currentRank)) {
        return NextResponse.json(
          { error: 'backward_move_rejected', current: engagement.stage, requested: stage },
          { status: 409 },
        )
      }
      patch.stage = stage
      patch.stage_entered_at = nowIso
      if (targetTerminal) {
        patch.closed_at = nowIso
        const reasonRaw = body?.closed_reason
        const reason = typeof reasonRaw === 'string' && (CLOSE_REASONS as readonly string[]).includes(reasonRaw)
          ? reasonRaw
          : (stage === 'Closed Won' ? 'won' : 'lost_other')
        patch.closed_reason = reason
        if (typeof body?.closed_note === 'string' && body.closed_note.trim()) {
          patch.closed_note = body.closed_note.trim().slice(0, 500)
        }
      }
      stageChanged = true
    }
  }

  const { error: updateError } = await supabaseService
    .from('engagements')
    .update(patch)
    .eq('id', id)
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  // Close-out trail (doc §4/§5): log every terminal close to sync_log —
  // a Lost close on a client with ZERO other open engagements is the
  // moment they conceptually enter the nurture pool; step 5's activation
  // work reads this trail. Fire-and-forget (writeSyncLog swallows errors).
  if (stageChanged && (patch.stage === 'Closed Won' || patch.stage === 'Closed Lost')) {
    const [{ data: clientLead }, { count: otherOpen }] = await Promise.all([
      supabaseService.from('leads').select('location_id, name').eq('id', engagement.client_id).maybeSingle(),
      supabaseService.from('engagements').select('id', { count: 'exact', head: true })
        .eq('client_id', engagement.client_id)
        .not('stage', 'in', '("Closed Won","Closed Lost")')
        .neq('id', id),
    ])
    const entersNurture = patch.stage === 'Closed Lost' && (otherOpen ?? 0) === 0
    await writeSyncLog({
      location_id: clientLead?.location_id || 'unknown',
      entity_id: id,
      entity_type: 'engagement',
      status: 'success',
      message:
        `[engagement:close] ${patch.stage} reason=${patch.closed_reason}` +
        (patch.closed_note ? ` note="${patch.closed_note}"` : '') +
        ` — client "${clientLead?.name || engagement.client_id}" has ${otherOpen ?? 0} other open engagement(s)` +
        (entersNurture ? ' → enters nurture pool (step-5 trail)' : ''),
    })
  }

  return NextResponse.json({
    id,
    stage: stageChanged ? stage : engagement.stage,
    prev_stage: engagement.stage,
    title: patch.title ?? engagement.title,
    changed: stageChanged || patch.title !== undefined,
  })
}
