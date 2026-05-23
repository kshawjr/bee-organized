// app/api/leads/[id]/drip-resume/route.ts
//
// POST /api/leads/:id/drip-resume — manually resume paused drips.
// Clears paused_at and, if next_send_at is in the past, pushes it to
// the next 9am in the location's timezone (catch-up logic: don't blast
// all missed steps at once when a lead was paused for several days).
//
// Auth + scoping match drip-pause.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { resumePausedDripsForLead } from '@/lib/drip-lifecycle'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  const { data: lead } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', id)
    .single()
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })

  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== lead.location_uuid) {
      return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
    }
    if (hubUser.role === 'lite_user') {
      return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
    }
  }

  await resumePausedDripsForLead(id)
  return NextResponse.json({ ok: true })
}
