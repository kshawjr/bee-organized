// app/api/leads/[id]/drip/route.ts
//
// GET /api/leads/:id/drip
//
// Returns the lead's most recent lead_drip_progress row joined with its
// drip_path + total step count + next step's send time. Used by
// PersonPanel's Drip section to show "On General Outreach – step X of Y,
// next send: ...".
//
// Auth: same as other lead endpoints — location-scoped for non-admins.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

export async function GET(
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

  const { data: lead } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', id)
    .single()
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })

  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // Most recent progress row. Order by created_at so re-starts (via
  // drip-restart) bubble up — they delete the old row, but if multiple
  // exist (e.g. across drip_paths) we want the freshest.
  const { data: prog, error: progErr } = await supabaseService
    .from('lead_drip_progress')
    .select('id, lead_id, drip_path_id, current_step, started_at, next_send_at, last_sent_at, completed_at, stopped_at, stopped_reason, paused_at, created_at, drip_paths(id, path_key, name, location_uuid)')
    .eq('lead_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (progErr) {
    console.error('[/api/leads/[id]/drip GET] error:', progErr.message)
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 })
  }

  if (!prog) {
    return NextResponse.json({ progress: null })
  }

  const path = Array.isArray((prog as any).drip_paths)
    ? (prog as any).drip_paths[0]
    : (prog as any).drip_paths

  // Step counts: total + current step's master template name (for the UI
  // tooltip / "Next: Welcome Email" hint).
  const [totalRes, stepRes] = await Promise.all([
    supabaseService
      .from('drip_path_steps')
      .select('id', { count: 'exact', head: true })
      .eq('drip_path_id', prog.drip_path_id),
    supabaseService
      .from('drip_path_steps')
      .select('id, step_order, channel, master_template_id, master_templates(name)')
      .eq('drip_path_id', prog.drip_path_id)
      .eq('step_order', prog.current_step)
      .maybeSingle(),
  ])

  const totalSteps = totalRes.count ?? 0
  const currentStepRow = stepRes.data
  const currentTpl = currentStepRow
    ? (Array.isArray((currentStepRow as any).master_templates)
        ? (currentStepRow as any).master_templates[0]
        : (currentStepRow as any).master_templates)
    : null

  // Effective status: stopped > completed > paused > active.
  let status: 'active' | 'paused' | 'stopped' | 'completed' = 'active'
  if (prog.stopped_at) status = 'stopped'
  else if (prog.completed_at) status = 'completed'
  else if (prog.paused_at) status = 'paused'

  return NextResponse.json({
    progress: {
      id: prog.id,
      drip_path_id: prog.drip_path_id,
      path_name: path?.name ?? null,
      path_key: path?.path_key ?? null,
      current_step: prog.current_step,
      total_steps: totalSteps,
      current_template_name: currentTpl?.name ?? null,
      started_at: prog.started_at,
      next_send_at: prog.next_send_at,
      last_sent_at: prog.last_sent_at,
      completed_at: prog.completed_at,
      stopped_at: prog.stopped_at,
      stopped_reason: prog.stopped_reason,
      paused_at: prog.paused_at,
      status,
    },
  })
}
