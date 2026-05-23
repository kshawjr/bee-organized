// lib/drip-lifecycle.ts
// Side-effect helpers the PATCH /api/leads/[id] route fires off when a
// lead's stage / paused / is_junk changes. All functions are
// fire-and-forget — they log errors and never throw, so PATCH responses
// are never blocked by drip bookkeeping.

import { supabaseService } from './supabase-service'
import { nextSendAt } from './drip-time'

// Any of these stages = drip should stop (only 'New' / 'Attempting' keep
// the drip active).
const DRIP_STOP_STAGES = new Set([
  'Nurturing',
  'Request',
  'Estimate Sent',
  'Job in Progress',
  'Final Processing',
  'Closed Won',
  'Closed Lost',
])

export type DripStopReason =
  | 'stage_changed'
  | 'junk'
  | 'manual_pause'
  | 'no_email'

interface LocationCtx {
  id: string
  timezone: string | null
}

// Start a drip when a lead enters 'New'. Looks up the location's default
// drip path, finds step 1, computes next_send_at in the location's tz,
// and inserts a lead_drip_progress row idempotently.
export async function startDripForLead(leadId: string, locationUuid: string): Promise<void> {
  try {
    const { data: loc, error: locErr } = await supabaseService
      .from('locations')
      .select('id, timezone, default_drip_path')
      .eq('id', locationUuid)
      .maybeSingle()

    if (locErr || !loc) {
      console.error('[drip] startDrip: location lookup failed', { leadId, locationUuid, locErr })
      return
    }
    if (!loc.default_drip_path) {
      // Owner hasn't picked a default — silently skip.
      return
    }

    const { data: path, error: pathErr } = await supabaseService
      .from('drip_paths')
      .select('id')
      .eq('location_uuid', locationUuid)
      .eq('path_key', loc.default_drip_path)
      .eq('is_active', true)
      .maybeSingle()

    if (pathErr || !path) {
      console.error('[drip] startDrip: default path not found', {
        leadId,
        locationUuid,
        path_key: loc.default_drip_path,
      })
      return
    }

    const { data: step1, error: stepErr } = await supabaseService
      .from('drip_path_steps')
      .select('delay_days')
      .eq('drip_path_id', path.id)
      .eq('step_order', 1)
      .maybeSingle()

    if (stepErr || !step1) {
      console.error('[drip] startDrip: step 1 missing', { leadId, drip_path_id: path.id, stepErr })
      return
    }

    const next = nextSendAt({
      from: new Date(),
      tz: loc.timezone ?? 'UTC',
      delayDays: step1.delay_days ?? 0,
    })

    const { error: insertErr } = await supabaseService
      .from('lead_drip_progress')
      .insert({
        lead_id: leadId,
        drip_path_id: path.id,
        current_step: 1,
        started_at: new Date().toISOString(),
        next_send_at: next.toISOString(),
      })

    // ON CONFLICT (lead_id, drip_path_id) DO NOTHING — Postgres will
    // raise a unique-violation we can swallow.
    if (insertErr && insertErr.code !== '23505') {
      console.error('[drip] startDrip: insert failed', { leadId, insertErr })
    }
  } catch (err) {
    console.error('[drip] startDrip: unexpected error', { leadId, err })
  }
}

export async function stopActiveDripsForLead(
  leadId: string,
  reason: DripStopReason,
): Promise<void> {
  try {
    const { error } = await supabaseService
      .from('lead_drip_progress')
      .update({
        stopped_at: new Date().toISOString(),
        stopped_reason: reason,
      })
      .eq('lead_id', leadId)
      .is('stopped_at', null)
      .is('completed_at', null)

    if (error) console.error('[drip] stopActiveDrips: update failed', { leadId, reason, error })
  } catch (err) {
    console.error('[drip] stopActiveDrips: unexpected error', { leadId, err })
  }
}

export async function pauseActiveDripsForLead(leadId: string): Promise<void> {
  try {
    const { error } = await supabaseService
      .from('lead_drip_progress')
      .update({ paused_at: new Date().toISOString() })
      .eq('lead_id', leadId)
      .is('paused_at', null)
      .is('stopped_at', null)
      .is('completed_at', null)

    if (error) console.error('[drip] pauseActiveDrips: update failed', { leadId, error })
  } catch (err) {
    console.error('[drip] pauseActiveDrips: unexpected error', { leadId, err })
  }
}

// Catch-up logic when resuming: if next_send_at was already due before
// the pause, push it to the next 9am rather than blasting immediately
// (we don't want a paused-3-days lead to fire all missed steps at once).
export async function resumePausedDripsForLead(leadId: string): Promise<void> {
  try {
    const { data: rows, error: loadErr } = await supabaseService
      .from('lead_drip_progress')
      .select('id, next_send_at, lead_id, drip_path_id')
      .eq('lead_id', leadId)
      .not('paused_at', 'is', null)
      .is('stopped_at', null)
      .is('completed_at', null)

    if (loadErr) {
      console.error('[drip] resumePausedDrips: load failed', { leadId, loadErr })
      return
    }
    if (!rows || rows.length === 0) return

    // Pull the lead's location tz once (all rows here share the lead).
    const { data: lead } = await supabaseService
      .from('leads')
      .select('location_uuid')
      .eq('id', leadId)
      .maybeSingle()

    let tz = 'UTC'
    if (lead?.location_uuid) {
      const { data: loc } = await supabaseService
        .from('locations')
        .select('timezone')
        .eq('id', lead.location_uuid)
        .maybeSingle()
      if (loc?.timezone) tz = loc.timezone
    }

    const now = new Date()
    for (const row of rows) {
      const due = row.next_send_at ? new Date(row.next_send_at) : null
      const update: Record<string, unknown> = { paused_at: null }
      if (!due || due.getTime() <= now.getTime()) {
        // Push to next 9am in location tz.
        update.next_send_at = nextSendAt({ from: now, tz, delayDays: 0 }).toISOString()
      }
      const { error: updErr } = await supabaseService
        .from('lead_drip_progress')
        .update(update)
        .eq('id', row.id)
      if (updErr) console.error('[drip] resumePausedDrips: update failed', { id: row.id, updErr })
    }
  } catch (err) {
    console.error('[drip] resumePausedDrips: unexpected error', { leadId, err })
  }
}

// Routing helper — given a patch and the lead's prior + new state, do
// the right thing. Caller awaits a Promise<void[]> but each branch
// already swallows its own errors, so this never throws.
export async function applyDripSideEffects(args: {
  leadId: string
  locationUuid: string
  prevStage: string | null
  patch: Record<string, unknown>
}): Promise<void> {
  const { leadId, locationUuid, prevStage, patch } = args
  const tasks: Promise<void>[] = []

  if ('stage' in patch && typeof patch.stage === 'string' && patch.stage !== prevStage) {
    const newStage = patch.stage
    if (newStage === 'New') {
      tasks.push(startDripForLead(leadId, locationUuid))
    } else if (newStage === 'Attempting') {
      // leave active drips alone — drip continues through Attempting
    } else if (DRIP_STOP_STAGES.has(newStage)) {
      tasks.push(stopActiveDripsForLead(leadId, 'stage_changed'))
    }
  }

  if ('is_junk' in patch && patch.is_junk === true) {
    tasks.push(stopActiveDripsForLead(leadId, 'junk'))
  }

  if ('paused' in patch) {
    if (patch.paused === true) tasks.push(pauseActiveDripsForLead(leadId))
    else if (patch.paused === false) tasks.push(resumePausedDripsForLead(leadId))
  }

  await Promise.all(tasks)
}

// Used by location ctx in cron — exported so the cron file can reuse it.
export type { LocationCtx }
