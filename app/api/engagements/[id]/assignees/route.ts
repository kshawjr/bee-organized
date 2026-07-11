// app/api/engagements/[id]/assignees/route.ts
//
// Engagement-level Assigned To — the junction write path.
//   POST   { hub_user_id }            → assign a hub_user (idempotent)
//   DELETE ?hub_user_id=<uuid>        → unassign
//
// Assignment moved from leads.assigned_to (single) to a many-to-many
// junction (engagement_assignees). The picker in the EngagementPanel
// masthead writes here. Both verbs push the resulting set to Jobber as the
// TEAM/CREW (non-fatal): ALL mapped assignees onto the assessment
// appointment team AND every non-completed job visit's crew. Requests are
// not assigned (pre-work, no crew concept). See lib/engagement-assignee-sync.
//
// Auth mirrors the sibling engagements route: logged-in hub_user;
// super_admin/admin any location, everyone else scoped to their own
// (hub_users.location_id === engagement.location_uuid). The assignee
// must belong to the engagement's location too (or the caller is admin)
// — you can't assign someone from another franchise.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import {
  getEngagementAssignees,
  syncEngagementAssignmentToJobber,
  resolveLocationSlug,
} from '@/lib/engagement-assignee-sync'

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
    .select('id, location_uuid')
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

// Fire-and-await the Jobber push, but never let its failure fail the
// request — the junction write already committed.
async function pushToJobber(engagementId: string, locationUuid: string) {
  try {
    const slug = await resolveLocationSlug(locationUuid)
    if (!slug) return null // location not connected to Jobber — internal-only assignment
    return await syncEngagementAssignmentToJobber(engagementId, slug)
  } catch (err: any) {
    console.error('[assignees] Jobber sync failed (non-fatal)', err?.message || err)
    return null
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await authAndLoad(id)
  if ('error' in auth) return auth.error
  const { hubUser, engagement } = auth

  let body: any = {}
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const hubUserId = body?.hub_user_id
  if (typeof hubUserId !== 'string' || !hubUserId.trim()) {
    return NextResponse.json({ error: 'hub_user_id_required' }, { status: 400 })
  }

  // The assignee must be a real hub_user AND (unless the caller is admin)
  // belong to the engagement's location. Prevents cross-franchise assign.
  const { data: assignee } = await supabaseService
    .from('hub_users')
    .select('id, location_id')
    .eq('id', hubUserId)
    .maybeSingle()
  if (!assignee) {
    return NextResponse.json({ error: 'assignee_not_found' }, { status: 404 })
  }
  if (!isAdmin(hubUser.role) && assignee.location_id !== engagement.location_uuid) {
    return NextResponse.json({ error: 'assignee_wrong_location' }, { status: 400 })
  }

  // Idempotent insert — PK(engagement_id, hub_user_id); a re-add is a no-op.
  const { error: insErr } = await supabaseService
    .from('engagement_assignees')
    .upsert(
      { engagement_id: id, hub_user_id: hubUserId },
      { onConflict: 'engagement_id,hub_user_id', ignoreDuplicates: true },
    )
  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  const jobber_sync = await pushToJobber(id, engagement.location_uuid)
  const assignees = await getEngagementAssignees(id)
  return NextResponse.json({ assignees, jobber_sync })
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await authAndLoad(id)
  if ('error' in auth) return auth.error
  const { engagement } = auth

  const url = new URL(req.url)
  const hubUserId = url.searchParams.get('hub_user_id')
  if (!hubUserId) {
    return NextResponse.json({ error: 'hub_user_id_required' }, { status: 400 })
  }

  const { error: delErr } = await supabaseService
    .from('engagement_assignees')
    .delete()
    .eq('engagement_id', id)
    .eq('hub_user_id', hubUserId)
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  const jobber_sync = await pushToJobber(id, engagement.location_uuid)
  const assignees = await getEngagementAssignees(id)
  return NextResponse.json({ assignees, jobber_sync })
}
