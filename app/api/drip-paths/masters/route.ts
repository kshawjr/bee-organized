// app/api/drip-paths/masters/route.ts
//
// GET /api/drip-paths/masters
//   Returns the 8 corp-owned master drip paths (is_master = true,
//   location_uuid IS NULL) with their steps. Used by:
//     - onboarding picker (owner choosing default)
//     - Settings → Paths (owner sees what's available + customizes)
//     - Admin → Content (super_admin edits master content)
//
// Read-allowed to any authenticated hub_user. Editing master content
// happens via PATCH /api/drip-path-steps/[stepId] (super_admin only).

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  const [pathsRes, stepsRes] = await Promise.all([
    supabaseService
      .from('drip_paths')
      .select('id, path_key, name, is_active, is_master')
      .eq('is_master', true)
      .order('path_key', { ascending: true }),
    supabaseService
      .from('drip_path_steps')
      .select('id, drip_path_id, step_order, delay_days, channel, subject, body, is_active')
      .order('step_order', { ascending: true }),
  ])

  if (pathsRes.error) {
    console.error('[/api/drip-paths/masters GET] paths error:', pathsRes.error.message)
    return NextResponse.json({ error: 'paths_query_failed' }, { status: 500 })
  }
  if (stepsRes.error) {
    console.error('[/api/drip-paths/masters GET] steps error:', stepsRes.error.message)
    return NextResponse.json({ error: 'steps_query_failed' }, { status: 500 })
  }

  const masters = (pathsRes.data ?? []).map(p => ({
    ...p,
    steps: (stepsRes.data ?? []).filter(s => s.drip_path_id === p.id),
  }))

  return NextResponse.json({ masters })
}
