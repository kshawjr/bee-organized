// lib/drip-followups.ts
//
// Owners choosing what goes out AFTER the first email (2026-09-30).
//
// KEVIN'S RULING, deliberate — do not soften it:
//   · DRIP STEP 1 and the WELCOME EMAIL always send. They are the brand's
//     first impression and no owner setting can turn them off. So a new lead
//     always gets two emails in the first 24 hours: step 1 on arrival, the
//     welcome a day later.
//   · everything after step 1 is the owner's choice, at two levels:
//       REMOVE ONE EMAIL  drip_path_steps.is_active = false on the location's
//                         own copy of a sequence. The step keeps its number and
//                         its wording (so "Put back" and the per-row reset both
//                         still work); at send time it is skipped and the lead
//                         moves on to the next email on that email's own date.
//       SWITCH OFF THE REST  locations.drip_followups_off = true. Nothing after
//                         step 1 sends at that location.
//
// WHAT SWITCHING OFF DOES TO PEOPLE ALREADY PARTWAY (decided: they STOP).
//   The owner has said they don't want these emails; "we'd already started"
//   is not a reason to keep sending. At the moment of switching off, every
//   unfinished sequence at the location that is past step 1 is STOPPED
//   (stopped_at = now, stopped_reason = 'followups_off'). While it stays off,
//   each new lead gets step 1 and is stopped straight after it. The drip
//   record says so in plain words on the client (PreferencesBlock).
//   Someone still waiting for step 1 when it is switched off still gets step 1
//   — that email is not the owner's to stop.
//
// WHAT SWITCHING BACK ON DOES (decided: nobody resumes).
//   It applies to people who come in from then on. Anyone stopped by the
//   switch stays stopped — a stop is final everywhere else in the drip system
//   too (the resume path only revives PAUSED rows), and restarting weeks-old
//   sequences in bulk would send a burst of stale emails. The setting says
//   this in the owner's words next to the switch.
//
// NOT A MIGRATION PREREQUISITE. The column is added by
// migrations/locations_drip_followups_off.sql. Until that runs, the read below
// errors, is swallowed, and reports "on" — exactly today's behaviour.

import { supabaseService } from './supabase-service'

export const FIRST_STEP = 1
export const FOLLOWUPS_OFF_REASON = 'followups_off'

export type StepDecision = 'send' | 'skip_removed' | 'stop_followups_off'

// THE rule, at the moment a step is due. Step 1 is answered before anything
// else is looked at: no setting and no flag on the step can hold it back.
export function dripStepDecision(input: {
  stepOrder: number
  stepActive: boolean | null | undefined
  followupsOff: boolean
}): StepDecision {
  if (input.stepOrder <= FIRST_STEP) return 'send'
  if (input.followupsOff) return 'stop_followups_off'
  // Only an explicit false removes a step. NULL / missing reads as active, so
  // a row written before this existed can never be skipped by accident.
  if (input.stepActive === false) return 'skip_removed'
  return 'send'
}

// After a successful send: with the switch off, nobody is left waiting for an
// email that will never go — stop them now, so switching back on later can't
// quietly revive them (see "nobody resumes" above).
export function stopAfterSend(input: { followupsOff: boolean; hasNextStep: boolean }): boolean {
  return input.followupsOff && input.hasNextStep
}

// Server-side protection for the step editor's save. The editor never offers
// Remove on step 1; this is the lock behind it.
export function firstStepRemovalError(steps: Array<{ step_order: number; is_active?: boolean | null }>): string | null {
  const first = steps.find((s) => s.step_order === FIRST_STEP)
  if (first && first.is_active === false) return 'first_email_always_sends'
  return null
}

// Tolerant read. Any error (including the column not existing yet) → false,
// i.e. follow-ups on, i.e. exactly what happened before this feature.
export async function readFollowupsOff(locationId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseService
      .from('locations')
      .select('drip_followups_off')
      .eq('id', locationId)
      .maybeSingle()
    if (error) return false
    return (data as { drip_followups_off?: boolean | null } | null)?.drip_followups_off === true
  } catch {
    return false
  }
}

// Every unfinished sequence at this location that is past step 1 — the people
// switching off would stop. Paused ones count too: a paused lead resumes into
// step 2 or later, which the owner has just said not to send.
export async function followupsInFlight(locationId: string): Promise<{ ids: string[]; error: string | null }> {
  const { data, error } = await supabaseService
    .from('lead_drip_progress')
    .select('id, leads!inner(location_uuid)')
    .eq('leads.location_uuid', locationId)
    .gt('current_step', FIRST_STEP)
    .is('stopped_at', null)
    .is('completed_at', null)
  if (error) return { ids: [], error: error.message }
  return { ids: ((data as Array<{ id: string }>) ?? []).map((r) => r.id), error: null }
}

// Stop them. Scoped by id AND re-checked as unfinished, so a row that finished
// between the read and the write is left as it is.
export async function stopFollowupsInFlight(locationId: string): Promise<{ stopped: number; error: string | null }> {
  const found = await followupsInFlight(locationId)
  if (found.error) return { stopped: 0, error: found.error }
  if (!found.ids.length) return { stopped: 0, error: null }
  const { error } = await supabaseService
    .from('lead_drip_progress')
    .update({ stopped_at: new Date().toISOString(), stopped_reason: FOLLOWUPS_OFF_REASON })
    .in('id', found.ids)
    .is('stopped_at', null)
    .is('completed_at', null)
  if (error) return { stopped: 0, error: error.message }
  return { stopped: found.ids.length, error: null }
}
