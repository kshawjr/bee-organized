// app/api/engagements/[id]/route.ts
//
// GET   /api/engagements/:id — engagement + full children (chronological)
//   + client summary (name, lifetime paid across ALL engagements, prior
//   count, other-open count). Fetched by EngagementPanel on open so the
//   board rows stay lightweight. Panel open also DRIFT-RECOVERS linked
//   engagements (recoverEngagementStageDrift): forward-only, silent
//   re-derive from the children fetched here — self-heals a stale stage
//   left by a swallowed webhook failure.
// PATCH /api/engagements/:id — { stage? , title? }
//   stage: TERMINAL-ONLY (decision 2026-07-10, Kevin — all business
//   flows through Jobber, so a manual non-terminal stage assertion is
//   always fiction; the panel Advance button and board pipeline drag
//   were removed the same day). The only human stage write is the
//   close: 'Closed Won' / 'Closed Lost' from an open stage, stamping
//   stage_entered_at / closed_at / closed_reason. Non-terminal stage
//   values are rejected for EVERY engagement, linked or local —
//   pipeline stages move only via the Jobber derivation (webhooks /
//   import / panel-open drift recovery), which writes the DB directly
//   and never through this route.
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
import { ENGAGEMENT_STAGE_RANK, recoverEngagementStageDrift, type EngagementStage } from '@/lib/engagements'

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

  const [srRes, quotesRes, jobsRes, invoicesRes, clientRes, clientEngsRes, assessRes, notesRes, buzzRes, touchRes, locRes, dripRes] = await Promise.all([
    supabaseService.from('service_requests').select('*').eq('engagement_id', id).order('requested_at', { ascending: true, nullsFirst: false }),
    supabaseService.from('quotes').select('*').eq('engagement_id', id).order('sent_at', { ascending: true, nullsFirst: false }),
    supabaseService.from('jobs').select('*').eq('engagement_id', id).order('scheduled_start', { ascending: true, nullsFirst: false }),
    supabaseService.from('invoices').select('*').eq('engagement_id', id).order('issued_at', { ascending: true, nullsFirst: false }),
    supabaseService.from('leads').select('id, name, email, phone, address, city, state, zip, request_details, source, referred_by_kind, referred_by_id').eq('id', engagement.client_id).maybeSingle(),
    supabaseService.from('engagements').select('id, stage, total_paid').eq('client_id', engagement.client_id),
    supabaseService.from('assessments').select('*').eq('engagement_id', id).order('scheduled_at', { ascending: true, nullsFirst: false }),
    // Engagement-scoped notes (kind='job' via the panel composer); newest
    // first. Degrades to [] pre-migration (query errors, data stays null).
    supabaseService.from('lead_notes').select('id, kind, text, user_label, created_at').eq('engagement_id', id).order('created_at', { ascending: false }).limit(50),
    // Client-level buzz timeline for the strip's bee drawer.
    supabaseService.from('lead_notes').select('id, text, user_label, created_at').eq('lead_id', engagement.client_id).eq('kind', 'buzz').order('created_at', { ascending: false }).limit(50),
    // THIS engagement's touchpoints — interleaved with notes in the
    // panel's activity stream.
    supabaseService.from('touchpoints').select('id, kind, method, label, notes, occurred_at, user_id').eq('engagement_id', id).order('occurred_at', { ascending: false }).limit(50),
    // Location name for the v2 masthead's client line.
    supabaseService.from('locations').select('name').eq('id', engagement.location_uuid).maybeSingle(),
    // LIVE drip only (stopped/completed excluded — Kevin's rule: the
    // banner is gone once the drip ends; paused still shows). Same
    // active-row filter the outreach-timeline endpoint uses.
    supabaseService.from('lead_drip_progress')
      .select('id, drip_path_id, current_step, next_send_at, paused_at, drip_paths(name)')
      .eq('lead_id', engagement.client_id)
      .is('stopped_at', null)
      .is('completed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  // Drip banner summary — step count is one extra tiny query, only when
  // a live drip exists (most engagements are past Jobber and have none).
  let drip: { path_name: string | null, current_step: number, total_steps: number | null, next_send_at: string | null, paused: boolean } | null = null
  const prog: any = dripRes.data
  if (prog) {
    const { count: totalSteps } = await supabaseService
      .from('drip_path_steps')
      .select('id', { count: 'exact', head: true })
      .eq('drip_path_id', prog.drip_path_id)
    const path = Array.isArray(prog.drip_paths) ? prog.drip_paths[0] : prog.drip_paths
    drip = {
      path_name: path?.name ?? null,
      current_step: prog.current_step,
      total_steps: totalSteps ?? null,
      next_send_at: prog.next_send_at ?? null,
      paused: !!prog.paused_at,
    }
  }

  // touchpoints carry user_id but no user_label — resolve author names
  // from hub_users in one shot so the activity stream can say who.
  const touches = touchRes.data ?? []
  const authorIds = Array.from(new Set(touches.map(t => t.user_id).filter(Boolean)))
  let authorById: Record<string, string> = {}
  if (authorIds.length > 0) {
    const { data: authors } = await supabaseService
      .from('hub_users')
      .select('id, full_name, first_name, last_name')
      .in('id', authorIds)
    for (const a of authors ?? []) {
      authorById[a.id] = a.full_name || [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || '—'
    }
  }
  const touchpoints = touches.map(t => ({ ...t, user_label: t.user_id ? (authorById[t.user_id] ?? null) : null }))

  // Drift recovery — LINKED engagements only (any child record: the
  // webhook derivation owns their stage, but its write is swallow-and-
  // log and there's no reconciliation job, so panel open self-heals).
  // Re-derives from the children fetched above; forward-only; silent
  // (automated — never the human close popup, even when it derives to
  // Closed Won); writes nothing at all when the stage already matches.
  // LOCAL engagements (no children) derive to Request → structurally a
  // no-op, so the hasAnyChild gate is belt-and-suspenders.
  let engagementOut = engagement
  // Terminal stages are settled — except a machine-stamped stale close
  // (closed_reason 'stale_on_import'), which drift recovery may flip to
  // Closed Won when the children prove paid-in-full (import ordering can
  // stamp Lost before the paid job/invoices attach).
  const isTerminalStage = engagement.stage === 'Closed Won' || engagement.stage === 'Closed Lost'
  const staleLostRecoverable =
    engagement.stage === 'Closed Lost' && engagement.closed_reason === 'stale_on_import'
  const hasAnyChild =
    (srRes.data?.length ?? 0) > 0 || (quotesRes.data?.length ?? 0) > 0 ||
    (jobsRes.data?.length ?? 0) > 0 || (invoicesRes.data?.length ?? 0) > 0 ||
    (assessRes.data?.length ?? 0) > 0
  if (hasAnyChild && (!isTerminalStage || staleLostRecoverable)) {
    const drift = await recoverEngagementStageDrift(engagement, {
      sr: srRes.data?.[0] ?? null,
      quotes: quotesRes.data ?? [],
      jobs: jobsRes.data ?? [],
      invoices: invoicesRes.data ?? [],
    })
    if (drift.corrected && drift.patch) {
      engagementOut = { ...engagement, ...drift.patch }
    }
  }

  // Referrer name resolution — same polymorphic lookup as the profile
  // route: kind 'partner' → partners row (contacts share the table),
  // kind 'lead' → another leads row. The panel's ReferrerField shows who.
  let referredByName: string | null = null
  const clientLead = clientRes.data
  if (clientLead?.referred_by_kind && clientLead?.referred_by_id) {
    const { data: ref } = await supabaseService
      .from(clientLead.referred_by_kind === 'lead' ? 'leads' : 'partners')
      .select('name')
      .eq('id', clientLead.referred_by_id)
      .maybeSingle()
    referredByName = ref?.name ?? null
  }

  const siblings = clientEngsRes.data ?? []
  const num = (v: any) => (v == null ? 0 : Number(v) || 0)
  const lifetimePaid = siblings.reduce((s, e) => s + num(e.total_paid), 0)
  const isOpen = (s: string) => s !== 'Closed Won' && s !== 'Closed Lost'
  const otherOpen = siblings.filter(e => e.id !== id && isOpen(e.stage)).length
  const priorCount = Math.max(0, siblings.length - 1)

  return NextResponse.json({
    engagement: engagementOut,
    children: {
      service_requests: srRes.data ?? [],
      assessments: assessRes.data ?? [],
      quotes: quotesRes.data ?? [],
      jobs: jobsRes.data ?? [],
      invoices: invoicesRes.data ?? [],
      notes: notesRes.data ?? [],
      touchpoints,
    },
    drip,
    client: {
      id: engagement.client_id,
      location_name: locRes.data?.name ?? null,
      name: clientRes.data?.name ?? 'Unknown',
      email: clientRes.data?.email ?? null,
      phone: clientRes.data?.phone ?? null,
      address: clientRes.data?.address ?? null,
      city: clientRes.data?.city ?? null,
      state: clientRes.data?.state ?? null,
      zip: clientRes.data?.zip ?? null,
      request_details: clientRes.data?.request_details ?? null,
      source: clientRes.data?.source ?? null,
      referred_by_kind: clientRes.data?.referred_by_kind ?? null,
      referred_by_id: clientRes.data?.referred_by_id ?? null,
      referred_by_name: referredByName,
      buzz: buzzRes.data ?? [],
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
  const descriptionRaw = body?.description as unknown
  const projectTypeRaw = body?.project_type as unknown

  if (stage === undefined && titleRaw === undefined && descriptionRaw === undefined && projectTypeRaw === undefined) {
    return NextResponse.json({ error: 'nothing_to_update', accepts: ['stage', 'title', 'description', 'project_type'] }, { status: 400 })
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

  // Description: editable anytime; empty string clears (→ null).
  if (descriptionRaw !== undefined) {
    if (typeof descriptionRaw !== 'string') {
      return NextResponse.json({ error: 'invalid_description' }, { status: 400 })
    }
    patch.description = descriptionRaw.trim().slice(0, 2000) || null
  }

  // Project type: a label from the admin lookups list (category
  // 'project_types') — stored as text, matching the leads convention.
  // Explicit null clears (the meta row's None option); empty string too.
  if (projectTypeRaw !== undefined) {
    if (projectTypeRaw !== null && typeof projectTypeRaw !== 'string') {
      return NextResponse.json({ error: 'invalid_project_type' }, { status: 400 })
    }
    patch.project_type = projectTypeRaw === null ? null : (projectTypeRaw.trim().slice(0, 100) || null)
  }

  if (stage !== undefined) {
    if (!stage || !(stage in ENGAGEMENT_STAGE_RANK)) {
      return NextResponse.json(
        { error: 'invalid_stage', allowed: Object.keys(ENGAGEMENT_STAGE_RANK) },
        { status: 400 },
      )
    }
    const targetTerminal = stage === 'Closed Won' || stage === 'Closed Lost'
    const currentTerminal = engagement.stage === 'Closed Won' || engagement.stage === 'Closed Lost'
    if (stage !== engagement.stage) {
      // Manual stage moves are gone (7/10): the only stage this route
      // accepts is a terminal close. Non-terminal values are rejected
      // for every engagement — Jobber derivation owns pipeline moves.
      if (!targetTerminal) {
        return NextResponse.json(
          {
            error: 'manual_stage_move_rejected',
            message: 'Pipeline stages move only via Jobber — this route accepts terminal closes only',
            current: engagement.stage,
            requested: stage,
          },
          { status: 409 },
        )
      }
      // Terminal→terminal stays rejected (a settled close never flips
      // through this route; stale_on_import recovery is the GET's job).
      if (currentTerminal) {
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

  // Stage-change trail — mirrors the leads-PATCH auto-log so the unified
  // timeline can show engagement moves. GOING FORWARD ONLY: there is no
  // stage-history table, so moves made before this landed are
  // unrecoverable — never backfill. Insert failure is non-fatal (the
  // stage change itself already committed).
  if (stageChanged) {
    const { hubUser } = auth
    await supabaseService.from('touchpoints').insert({
      lead_id: engagement.client_id,
      location_uuid: engagement.location_uuid,
      engagement_id: id,
      kind: 'stage_change',
      label: `Stage: ${engagement.stage} → ${patch.stage}`,
      user_id: hubUser.id,
      occurred_at: nowIso,
    })
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
    description: patch.description !== undefined ? patch.description : engagement.description,
    project_type: patch.project_type !== undefined ? patch.project_type : engagement.project_type,
    changed: stageChanged || patch.title !== undefined || patch.description !== undefined || patch.project_type !== undefined,
  })
}
