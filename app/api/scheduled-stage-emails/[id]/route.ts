// app/api/scheduled-stage-emails/[id]/route.ts
//
// PATCH /api/scheduled-stage-emails/:id — { cancelled: boolean }
//   true  → sets cancelled_at + cancelled_reason='manual' (the reason the
//           enum in lib/stage-emails always allowed but nothing wired)
//   false → clears both (the timeline's undo path)
// Guard both directions on sent_at IS NULL — a sent row is immutable.
// This is the PER-ROW manual cancel; the whole-lead sweeps (stage exit /
// junk) stay in lib/stage-emails.cancelStageEmails.
//
// Auth: hub_user, lite_user blocked (it's a write), location-scoped to
// the parent lead for non-admins — mirrors /api/touchpoints.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

export async function PATCH(
  req: Request,
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
  if (hubUser.role === 'lite_user') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: any = {}
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (typeof body?.cancelled !== 'boolean') {
    return NextResponse.json({ error: 'cancelled_boolean_required' }, { status: 400 })
  }

  const { data: row } = await supabaseService
    .from('scheduled_stage_emails')
    .select('id, lead_id, sent_at, cancelled_at')
    .eq('id', id)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const { data: lead } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', row.lead_id)
    .maybeSingle()
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  if (row.sent_at) return NextResponse.json({ error: 'already_sent' }, { status: 409 })

  const patch = body.cancelled
    ? { cancelled_at: new Date().toISOString(), cancelled_reason: 'manual' }
    : { cancelled_at: null, cancelled_reason: null }

  const { error: updateError } = await supabaseService
    .from('scheduled_stage_emails')
    .update(patch)
    .eq('id', id)
    .is('sent_at', null)
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({ id, cancelled: body.cancelled })
}
