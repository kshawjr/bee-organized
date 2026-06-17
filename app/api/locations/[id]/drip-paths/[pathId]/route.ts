// app/api/locations/[id]/drip-paths/[pathId]/route.ts
//
// DELETE /api/locations/:id/drip-paths/:pathId
//   Delete a location-owned drip path. Used by "Reset to master" — the
//   location's customized copy is wiped and the renderer falls back to
//   the master (resolved in lib/drip-lifecycle startDripForLead).
//
//   Cascades to drip_path_steps via FK ON DELETE CASCADE. If any
//   lead_drip_progress rows reference this path they're cascaded too —
//   guard against that by refusing if there are active progress rows.
//
// Auth: super_admin any location; owner only their own.
// Refuses to delete master paths (is_master = true) — those are managed
// in Admin → Content, not per-location.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; pathId: string } },
) {
  const { id: locId, pathId } = params

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  // Drip-path management is owner/elevated config — block lite_user (read-only)
  // and manager (operational lead; no drip config).
  if (hubUser.role === 'lite_user' || hubUser.role === 'manager') {
    return NextResponse.json({ error: 'forbidden_read_only' }, { status: 403 })
  }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== locId) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // Load the path + verify it belongs to this location and is not a master
  const { data: path, error: pathErr } = await supabaseService
    .from('drip_paths')
    .select('id, location_uuid, is_master, path_key')
    .eq('id', pathId)
    .maybeSingle()

  if (pathErr) {
    return NextResponse.json({ error: 'path_lookup_failed', detail: pathErr.message }, { status: 500 })
  }
  if (!path) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (path.is_master) {
    return NextResponse.json({ error: 'cannot_delete_master' }, { status: 400 })
  }
  if (path.location_uuid !== locId) {
    return NextResponse.json({ error: 'path_belongs_to_other_location' }, { status: 400 })
  }

  // Refuse if there are active progress rows.
  const { count: activeProgress } = await supabaseService
    .from('lead_drip_progress')
    .select('id', { count: 'exact', head: true })
    .eq('drip_path_id', pathId)
    .is('completed_at', null)
    .is('stopped_at', null)

  if ((activeProgress ?? 0) > 0) {
    return NextResponse.json({
      error: 'active_progress_exists',
      detail: `${activeProgress} lead(s) currently in this path — stop them or wait for completion before resetting`,
    }, { status: 409 })
  }

  const { error: delErr } = await supabaseService
    .from('drip_paths')
    .delete()
    .eq('id', pathId)

  if (delErr) {
    console.error('[/api/locations/[id]/drip-paths/[pathId] DELETE] error', delErr.message)
    return NextResponse.json({ error: 'delete_failed', detail: delErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, deleted: { id: pathId, path_key: path.path_key } })
}
