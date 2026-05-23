// app/api/leads/[id]/drip-restart/route.ts
//
// POST /api/leads/:id/drip-restart — super_admin only.
//
// Wipes the lead's existing lead_drip_progress rows and re-runs
// startDripForLead, which inserts a fresh row at step 1 with next_send_at
// computed from the location's default drip path. Used when a drip stopped
// (junk, stage_changed, no_email) or completed but the owner wants to
// retry from scratch.
//
// Owners are not allowed to use this — re-engagement should usually go
// through changing stage back to 'New', which auto-starts a drip without
// blasting old send history.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isSuperAdmin } from '@/lib/auth'
import { startDripForLead } from '@/lib/drip-lifecycle'

export async function POST(
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
  if (!isSuperAdmin(hubUser.role)) {
    return NextResponse.json({ error: 'forbidden_super_admin_only' }, { status: 403 })
  }

  const { data: lead } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', id)
    .single()
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  if (!lead.location_uuid) {
    return NextResponse.json({ error: 'lead_missing_location' }, { status: 400 })
  }

  // Clear any previous progress rows so the UNIQUE(lead_id, drip_path_id)
  // constraint in startDripForLead doesn't no-op silently.
  const { error: delErr } = await supabaseService
    .from('lead_drip_progress')
    .delete()
    .eq('lead_id', id)
  if (delErr) {
    console.error('[/api/leads/[id]/drip-restart] delete error:', delErr.message)
    return NextResponse.json({ error: 'reset_failed', detail: delErr.message }, { status: 500 })
  }

  await startDripForLead(id, lead.location_uuid)
  return NextResponse.json({ ok: true })
}
