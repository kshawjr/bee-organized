// lib/drip-lifecycle.ts
// Side-effect helpers the PATCH /api/leads/[id] route fires off when a
// lead's stage / paused / is_junk changes. All functions are
// fire-and-forget — they log errors and never throw, so PATCH responses
// are never blocked by drip bookkeeping.

import { supabaseService } from './supabase-service'
import { nextSendAt } from './drip-time'
import {
  scheduleStageEmails,
  cancelStageEmails,
  resolveDripCategory,
} from './stage-emails'
import { cancelPendingWelcomeEmail } from './welcome-email'

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
  | 'opted_out'

interface LocationCtx {
  id: string
  timezone: string | null
}

// Start a drip when a lead enters 'New'. Resolves the lead's project_type
// through its Move/Organizing tag to pick the location's move vs organizing
// default path, finds step 1, computes next_send_at in the location's tz,
// and inserts a lead_drip_progress row idempotently.
//
// Skips entirely when leads.paused = true. Imported leads (Jobber
// initial / webhooks / CSV) land with paused = true so the day-0 New
// Lead email doesn't get sent to historical clients — the owner has to
// flip paused = false (via the Activate Drips button) to opt them in,
// which routes back through here via resumePausedDripsForLead.
export async function startDripForLead(leadId: string, locationUuid: string): Promise<void> {
  try {
    const { data: leadRow, error: leadErr } = await supabaseService
      .from('leads')
      .select('paused, marketing_opt_out, project_type')
      .eq('id', leadId)
      .maybeSingle()
    if (leadErr) {
      console.error('[drip] startDrip: lead lookup failed', { leadId, leadErr })
      return
    }
    if (leadRow?.paused) {
      // Imported lead — owner must explicitly activate drips first.
      return
    }
    if (leadRow?.marketing_opt_out) {
      // Opted out of marketing — never enroll. sendDripStepForRow also
      // enforces this at send time (the authoritative gate).
      return
    }

    const { data: loc, error: locErr } = await supabaseService
      .from('locations')
      .select('id, timezone, default_drip_path, default_move_drip_path, lifecycle_status')
      .eq('id', locationUuid)
      .maybeSingle()

    if (locErr || !loc) {
      console.error('[drip] startDrip: location lookup failed', { leadId, locationUuid, locErr })
      return
    }

    // SAFETY GATE (interface-active): client drips fire ONLY for locations
    // ACTIVE on the interface — the interface is the only place a drip can
    // be stopped, so a non-active location must NEVER enroll an
    // uncontrollable client drip. This is the SAME lifecycle_status ===
    // 'active' condition the intake caller has always used (9d5811f's
    // non-active-location gate), lifted here to the shared enrollment
    // chokepoint so every caller inherits it — intake, POST/PATCH
    // /api/leads, the Jobber webhook stage-promotion path, drip-restart,
    // and the imported-lead resume seed. The internal lead notification
    // (B2/B3) is a separate path and is unaffected.
    if (loc.lifecycle_status !== 'active') {
      console.log(
        `[drip] startDrip: location ${locationUuid} not active ` +
          `(lifecycle_status=${loc.lifecycle_status ?? 'null'}) — lead ${leadId} not enrolled`,
      )
      return
    }

    // New Client Drip selection: the lead's project_type resolves through
    // its admin-configured Move/Organizing tag (lookups.attrs.drip_category)
    // to pick which of the location's two default paths to enroll:
    //   - Move-tagged   → default_move_drip_path
    //   - Organizing / untagged / unrecognized → default_drip_path
    // resolveDripCategory defaults to 'general' (Organizing) for a null /
    // unknown project_type, so the fallback is safe by construction. A
    // Move-tagged lead at a location that never configured a move path
    // falls back to the organizing default rather than enrolling nothing.
    const dripCategory = await resolveDripCategory(leadRow?.project_type ?? null)
    const pathKey =
      dripCategory === 'move'
        ? loc.default_move_drip_path || loc.default_drip_path
        : loc.default_drip_path

    if (!pathKey) {
      // Owner hasn't picked the relevant default — silently skip.
      return
    }

    // Look for a location-owned copy first; fall back to the corp master.
    // This mirrors the templates pattern: owners can clone-and-customize
    // a path for their location (drip_paths.is_master = false +
    // location_uuid = <loc>), and if they haven't, we use the master
    // (is_master = true + location_uuid IS NULL) directly.
    let path: { id: string } | null = null
    {
      const { data: locCopy, error: locCopyErr } = await supabaseService
        .from('drip_paths')
        .select('id')
        .eq('location_uuid', locationUuid)
        .eq('path_key', pathKey)
        .eq('is_active', true)
        .maybeSingle()
      if (locCopyErr) {
        console.error('[drip] startDrip: location-copy lookup failed', { leadId, locCopyErr })
        return
      }
      if (locCopy) {
        path = locCopy
      } else {
        const { data: master, error: masterErr } = await supabaseService
          .from('drip_paths')
          .select('id')
          .eq('is_master', true)
          .eq('path_key', pathKey)
          .eq('is_active', true)
          .maybeSingle()
        if (masterErr) {
          console.error('[drip] startDrip: master lookup failed', { leadId, masterErr })
          return
        }
        path = master
      }
    }

    if (!path) {
      console.error('[drip] startDrip: path not found (neither copy nor master)', {
        leadId,
        locationUuid,
        path_key: pathKey,
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

    // Step 1 with delay_days=0 should feel "immediate" to the user who
    // just created the lead — schedule it for now() so the next hourly
    // cron tick (up to ~1 hour) picks it up. Falling through to
    // nextSendAt() would push the welcome email to 9am the following
    // day (a 23-hour delay for leads created after 9am local).
    // Subsequent steps still flow through nextSendAt() in the cron.
    const delayDays = step1.delay_days ?? 0
    const next =
      delayDays === 0
        ? new Date()
        : nextSendAt({
            from: new Date(),
            tz: loc.timezone ?? 'UTC',
            delayDays,
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
//
// Imported-lead case: a lead that landed paused = true never had
// startDripForLead run (it was skipped by the paused guard), so there
// are no progress rows to resume. When the owner clicks Activate Drips
// we need to seed step 1 instead — detect "no progress rows + lead in a
// drip-eligible stage" and delegate to startDripForLead.
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

    if (!rows || rows.length === 0) {
      // No paused rows to revive. Could be an imported lead being
      // activated for the first time, or a lead whose drip already
      // completed/stopped — only the former should start a fresh drip.
      const { data: lead } = await supabaseService
        .from('leads')
        .select('location_uuid, stage')
        .eq('id', leadId)
        .maybeSingle()
      if (!lead?.location_uuid) return

      // Don't re-seed if there's any non-paused progress row (i.e. an
      // active or already-stopped/completed drip). The owner can use
      // the super_admin drip-restart endpoint for that.
      const { data: anyProgress } = await supabaseService
        .from('lead_drip_progress')
        .select('id')
        .eq('lead_id', leadId)
        .limit(1)
        .maybeSingle()
      if (anyProgress) return

      // Drip-eligible stages mirror the start-trigger in applyDripSideEffects.
      if (lead.stage === 'New' || lead.stage === 'Attempting') {
        await startDripForLead(leadId, lead.location_uuid)
      }
      return
    }

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
//
// prevStage semantics:
//   - null/undefined → no prior state (fresh lead create). 'New' should
//     start the drip; other stages no-op (no active drips to stop).
//   - string         → existing lead transitioning. Compare to patch.stage.
export async function applyDripSideEffects(args: {
  leadId: string
  locationUuid: string
  prevStage: string | null
  patch: Record<string, unknown>
}): Promise<void> {
  const { leadId, locationUuid, prevStage, patch } = args
  const tasks: Promise<void>[] = []

  // Stages that trigger opportunity-stage scheduled emails. Used to decide
  // whether to fire scheduleStageEmails on entry and cancelStageEmails on
  // exit.
  const STAGE_EMAIL_TRIGGER_STAGES = new Set(['Closed Won', 'Estimate Sent'])

  if ('stage' in patch && typeof patch.stage === 'string' && patch.stage !== prevStage) {
    const newStage = patch.stage
    const isFreshCreate = prevStage === null || prevStage === undefined
    if (newStage === 'New') {
      // Fires for both create-into-New and transition-into-New. startDrip
      // is idempotent (unique on lead_id + drip_path_id) so re-entry is safe.
      tasks.push(startDripForLead(leadId, locationUuid))
    } else if (newStage === 'Attempting') {
      // leave active drips alone — drip continues through Attempting
    } else if (DRIP_STOP_STAGES.has(newStage) && !isFreshCreate) {
      // Only stop drips on a real transition. A fresh lead can't have
      // active drips to stop, and the lookup just wastes a round trip.
      tasks.push(stopActiveDripsForLead(leadId, 'stage_changed'))
      // The pending Welcome Email rides the new-lead drip — once the
      // lead moves past New/Attempting (booked, nurturing, closed) a
      // "thanks for reaching out" 24h follow-up reads wrong. Cancel it
      // alongside the drip stop. Stage emails are deliberately NOT
      // touched here beyond the existing trigger-stage logic below.
      tasks.push(cancelPendingWelcomeEmail(leadId, 'stage_changed'))
    }

    // Opportunity Stage emails — independent of the drip-stop logic above.
    // Schedule on entry into trigger stages; cancel pending on exit from
    // them. Fresh creates can still trigger entry (a lead imported as
    // already-Closed-Won gets the 3mo/12mo follow-ups scheduled).
    if (STAGE_EMAIL_TRIGGER_STAGES.has(newStage)) {
      tasks.push(scheduleStageEmailsForLead(leadId, newStage, patch))
    } else if (
      !isFreshCreate &&
      prevStage &&
      STAGE_EMAIL_TRIGGER_STAGES.has(prevStage)
    ) {
      tasks.push(cancelStageEmails({ leadId, reason: 'stage_changed' }))
    }
  }

  if ('is_junk' in patch && patch.is_junk === true) {
    tasks.push(stopActiveDripsForLead(leadId, 'junk'))
    tasks.push(cancelStageEmails({ leadId, reason: 'junk' }))
    // Junk also kills a pending Welcome Email (sendWelcomeEmail
    // double-checks is_junk at send time as the backstop).
    tasks.push(cancelPendingWelcomeEmail(leadId, 'junk'))
  }

  if ('marketing_opt_out' in patch && patch.marketing_opt_out === true) {
    // Compliance: opting out silences everything immediately — active
    // drips stop, pending stage emails cancel, pending welcome cancels.
    // The three send paths also each re-check the flag at send time, so
    // this hook is belt-and-braces, not the sole gate.
    tasks.push(stopActiveDripsForLead(leadId, 'opted_out'))
    tasks.push(cancelStageEmails({ leadId, reason: 'opted_out' }))
    tasks.push(cancelPendingWelcomeEmail(leadId, 'opted_out'))
  }

  if ('paused' in patch) {
    if (patch.paused === true) tasks.push(pauseActiveDripsForLead(leadId))
    else if (patch.paused === false) tasks.push(resumePausedDripsForLead(leadId))
  }

  await Promise.all(tasks)
}

// Wrapper that resolves project_type (from patch or DB) before delegating
// to scheduleStageEmails. Keeps the side-effects orchestration simple.
async function scheduleStageEmailsForLead(
  leadId: string,
  newStage: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    let projectType: string | null = null
    if ('project_type' in patch && typeof patch.project_type === 'string') {
      projectType = patch.project_type
    } else {
      const { data } = await supabaseService
        .from('leads')
        .select('project_type')
        .eq('id', leadId)
        .maybeSingle()
      projectType = data?.project_type ?? null
    }
    await scheduleStageEmails({ leadId, newStage, projectType })
  } catch (err) {
    console.error('[drip] scheduleStageEmailsForLead: unexpected error', { leadId, err })
  }
}

// Used by location ctx in cron — exported so the cron file can reuse it.
export type { LocationCtx }
