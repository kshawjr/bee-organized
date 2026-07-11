// app/api/leads/[id]/drip-pause/route.ts
//
// POST /api/leads/:id/drip-pause — manually pause a lead's active drips.
// Sets paused_at on every lead_drip_progress row for this lead that is
// not already paused, stopped, or completed, AND sets leads.paused=true
// so the flag (what the beta chip / Classic badge / welcome-hold read)
// stays in lockstep with the row state (what the cron obeys). Before
// the flag sync these two signals could diverge and the chip would show
// "Drips active" on a paused drip.
//
// Auth: hub_user required. Location scoping matches PATCH /api/leads/:id.
// Wired to Classic's DripSection + Outreach tab pause buttons
// (components/BeeHub.jsx).

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { pauseActiveDripsForLead } from '@/lib/drip-lifecycle'

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

  // ─── Read-only guard (868kawwmh) ──────────────────────────────
  const roBlock = await readOnlyWriteBlock(hubUser, lead.location_uuid)
  if (roBlock) return roBlock

  // Row state first — it's what actually stops sends — then the flag.
  // A failed flag write is logged and surfaced but doesn't undo the
  // pause: better a stale chip than an email that shouldn't have gone.
  await pauseActiveDripsForLead(id)

  const { error: flagErr } = await supabaseService
    .from('leads')
    .update({ paused: true, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (flagErr) {
    console.error('[drip-pause] leads.paused flag sync failed', { id, flagErr })
    return NextResponse.json({ ok: true, warning: 'flag_sync_failed' })
  }

  return NextResponse.json({ ok: true })
}
