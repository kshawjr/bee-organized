// app/api/engagements/[id]/route.ts
//
// PATCH /api/engagements/:id — move an engagement's stage (HIVE Phase 1
// step 4, EngagementBoard drag-drop). Minimal by design:
//   - body: { stage } only; anything else is rejected
//   - forward-only against ENGAGEMENT_STAGE_RANK (the engagement-only rank
//     in lib/engagements.ts — NOT the lead STAGE_RANK)
//   - stamps stage_entered_at on change; closed_at when entering a terminal
//   - NEVER touches leads.stage — the lead board stays webhook/import-driven
//     until the full read flip retires it (step 6)
//
// Auth: logged-in hub_user. super_admin/admin any location; everyone else
// scoped to their own location (hub_users.location_id is the location UUID).

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { ENGAGEMENT_STAGE_RANK, type EngagementStage } from '@/lib/engagements'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  let body: any = {}
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const stage = body?.stage as EngagementStage | undefined
  if (!stage || !(stage in ENGAGEMENT_STAGE_RANK)) {
    return NextResponse.json(
      { error: 'invalid_stage', allowed: Object.keys(ENGAGEMENT_STAGE_RANK) },
      { status: 400 },
    )
  }

  const { data: engagement, error: engError } = await supabaseService
    .from('engagements')
    .select('id, stage, location_uuid')
    .eq('id', id)
    .maybeSingle()
  if (engError || !engagement) {
    return NextResponse.json({ error: 'engagement_not_found' }, { status: 404 })
  }

  if (!isAdmin(hubUser.role) && hubUser.location_id !== engagement.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  const currentRank = ENGAGEMENT_STAGE_RANK[engagement.stage as EngagementStage] ?? 0
  const newRank = ENGAGEMENT_STAGE_RANK[stage]
  if (newRank === currentRank && stage === engagement.stage) {
    // Dropping a card back onto its own column — clean no-op.
    return NextResponse.json({ id, stage: engagement.stage, changed: false })
  }
  if (newRank <= currentRank) {
    return NextResponse.json(
      { error: 'backward_move_rejected', current: engagement.stage, requested: stage },
      { status: 409 },
    )
  }

  const nowIso = new Date().toISOString()
  const patch: Record<string, any> = {
    stage,
    stage_entered_at: nowIso,
    updated_at: nowIso,
  }
  if (stage === 'Closed Won' || stage === 'Closed Lost') {
    patch.closed_at = nowIso
    if (stage === 'Closed Won') patch.closed_reason = 'won'
  }

  const { error: updateError } = await supabaseService
    .from('engagements')
    .update(patch)
    .eq('id', id)
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ id, stage, prev_stage: engagement.stage, changed: true })
}
