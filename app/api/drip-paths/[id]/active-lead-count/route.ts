// app/api/drip-paths/[id]/active-lead-count/route.ts
//
// GET /api/drip-paths/:id/active-lead-count  ->  { count }
//
// How many leads are partway through THIS path row right now. Read-only.
//
// Issue 240 step 9b needs this because the "add another email" confirmation
// has to tell an owner the truth about their own location at the moment they
// press the button, not a number baked in at build time.
//
// Scoped to the path ROW, not the path_key, and that distinction is the whole
// point: lead_drip_progress pins drip_path_id at enrolment, so a location that
// has not forked yet has its leads sitting on the MASTER row. An append to a
// freshly forked row reaches none of them. Counting by path_key would report
// those leads as reachable and the confirmation would be a lie.
//
// "Partway through" mirrors the cron's own selection in
// app/api/cron/send-drips: not stopped, not completed, not paused. A paused
// lead is excluded because it is not currently advancing; if it resumes it
// will pick up the new step like any other, which the confirmation does not
// need to enumerate.
//
// Auth mirrors the sibling step routes: signed in, and either elevated or the
// owner of the location that owns this path. A master path (location_uuid
// NULL) is readable by elevated users only — an owner has no leads on another
// location's row and no business counting them.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  const { data: path } = await supabaseService
    .from('drip_paths')
    .select('id, location_uuid, is_master')
    .eq('id', params.id)
    .maybeSingle()
  if (!path) return NextResponse.json({ error: 'path_not_found' }, { status: 404 })

  if (!isAdmin(hubUser.role) && hubUser.location_id !== path.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  const { count, error } = await supabaseService
    .from('lead_drip_progress')
    .select('id', { count: 'exact', head: true })
    .eq('drip_path_id', path.id)
    .is('stopped_at', null)
    .is('completed_at', null)
    .is('paused_at', null)

  if (error) {
    console.error('[/api/drip-paths/[id]/active-lead-count] error:', error.message)
    return NextResponse.json({ error: 'count_failed' }, { status: 500 })
  }

  return NextResponse.json({ count: count ?? 0 })
}
