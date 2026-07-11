// app/api/leads/[id]/drip-resume/route.ts
//
// POST /api/leads/:id/drip-resume — manually resume paused drips.
// Clears leads.paused AND paused_at on the progress rows; if
// next_send_at is in the past it's pushed to the next 9am in the
// location's timezone (catch-up logic: don't blast all missed steps at
// once when a lead was paused for several days).
//
// Flag sync ordering matters: leads.paused=false is written FIRST so
// the imported-lead seed path inside resumePausedDripsForLead (which
// delegates to startDripForLead, guarded on leads.paused) can actually
// fire. Before the sync, resuming a never-enrolled imported lead
// through this endpoint silently did nothing.
//
// Mirrors the PATCH paused=false path by firing sendDripStep inline so
// a freshly-seeded step 1 lands in seconds instead of on the next
// hourly cron tick. Wired to Classic's DripSection + Outreach tab
// resume buttons (components/BeeHub.jsx).
//
// Auth + scoping match drip-pause.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { resumePausedDripsForLead } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'

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

  // Flag first (see header: the seed path reads it), then rows. A
  // failed flag write aborts — resuming rows while the flag still says
  // paused would recreate exactly the divergence this sync removes.
  const { error: flagErr } = await supabaseService
    .from('leads')
    .update({ paused: false, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (flagErr) {
    console.error('[drip-resume] leads.paused flag sync failed', { id, flagErr })
    return NextResponse.json({ error: 'flag_sync_failed', detail: flagErr.message }, { status: 500 })
  }

  await resumePausedDripsForLead(id)

  try {
    await sendDripStep(id)
  } catch (err) {
    console.error('[drip-resume] inline sendDripStep threw', err)
  }

  return NextResponse.json({ ok: true })
}
