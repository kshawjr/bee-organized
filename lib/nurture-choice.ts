// lib/nurture-choice.ts
// ─────────────────────────────────────────────────────────────
// FL-137/135 (Kevin, 2026-11-28): SAVING the owner's choice about one person
// at one location — "nurture them?" (leads.nurture_choice) and "send them to
// Mailchimp?" (leads.mailchimp_choice). Columns: migrations/
// nurture_and_mailchimp_choices.sql.
//
// THIS FILE ONLY WRITES THOSE COLUMNS. It never sends anything and imports
// nothing that does, so the 35-day auto-close can use it and stay silent
// (lib/auto-close.test.ts spies on fetch and on every email sender). The
// Mailchimp send that follows an 'in' lives in lib/nurture-mailchimp.ts.
//
// Never marketing_opt_out: that is the PERSON's no, shared by every
// location, and it stops Bee Hub's own emails. This is the owner's judgment.
//
// Who writes a choice, and how:
//   · Closed Lost by hand, the box (any reason but Junk Lead and Duplicate):
//       ticked   → Nurturing 'in',  Mailchimp 'in'  (Mailchimp only where open)
//       unticked → Nurturing 'out', Mailchimp 'out' — for good
//   · The 35-day auto-close → 'in' and 'in': nobody is there to tick a box,
//     and every lead consented at intake.
//   · Send to Jobber's box → Mailchimp only ('in' ticked, 'out' unticked).
//   · The Nurturing tab's Add → Nurturing 'in'; Mailchimp 'in' only if its box
//     was ticked.
// A newer choice replaces an older one. Old closes are never answered for
// anyone (Kevin): nothing here runs over people already closed.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { mailchimpOpenFor } from './mailchimp-rollout'
import { nurtureBoxShows } from '@/components/hive/shared/nurtureBox'

export type Choice = 'in' | 'out'
export type NurtureHow = 'closed_lost' | 'auto_close' | 'nurturing_add'
export type MailchimpHow = 'send_to_jobber' | 'closed_lost' | 'auto_close' | 'nurturing_add'

type Deps = { db?: any; now?: () => number }

async function write(leadId: string, patch: Record<string, unknown>, deps: Deps): Promise<boolean> {
  const db = deps.db || supabaseService
  const { error } = await db.from('leads').update(patch).eq('id', leadId)
  if (error) { console.error('[nurture-choice] not saved', { leadId, error: error.message }); return false }
  return true
}

export function saveNurtureChoice(leadId: string, choice: Choice, how: NurtureHow, by: string | null, deps: Deps = {}): Promise<boolean> {
  const at = new Date((deps.now || Date.now)()).toISOString()
  return write(leadId, { nurture_choice: choice, nurture_choice_at: at, nurture_choice_how: how, nurture_choice_by: by }, deps)
}

export function saveMailchimpChoice(leadId: string, choice: Choice, how: MailchimpHow, by: string | null, deps: Deps = {}): Promise<boolean> {
  const at = new Date((deps.now || Date.now)()).toISOString()
  return write(leadId, { mailchimp_choice: choice, mailchimp_choice_at: at, mailchimp_choice_how: how, mailchimp_choice_by: by }, deps)
}

export type BoxSaved = { nurture: Choice; mailchimp: Choice | null; saved: boolean }

/**
 * The Closed Lost box, saved. Returns null when this close has no box (Junk
 * Lead, Duplicate, or the caller sent no answer) — then NOTHING is written
 * and the catch-all decides, exactly as before.
 */
export async function saveCloseBox(args: { leadId: string; locationUuid: string | null; reason: string | null | undefined; ticked: unknown; by: string | null }, deps: Deps = {}): Promise<BoxSaved | null> {
  if (!nurtureBoxShows(args.reason)) return null
  if (typeof args.ticked !== 'boolean') return null
  const choice: Choice = args.ticked ? 'in' : 'out'
  const a = await saveNurtureChoice(args.leadId, choice, 'closed_lost', args.by, deps)
  // Mailchimp is part of the same box only where Mailchimp is open; elsewhere
  // the box never mentions it, so nothing is recorded for it.
  const mc = mailchimpOpenFor(args.locationUuid) ? choice : null
  const b = mc ? await saveMailchimpChoice(args.leadId, mc, 'closed_lost', args.by, deps) : true
  return { nurture: choice, mailchimp: mc, saved: a && b }
}

/** The 35-day auto-close: in, and (where Mailchimp is open) to Mailchimp. Writes only. */
export async function saveAutoCloseChoice(leadId: string, locationUuid: string | null, deps: Deps = {}): Promise<{ mailchimp: boolean }> {
  await saveNurtureChoice(leadId, 'in', 'auto_close', null, deps)
  if (!mailchimpOpenFor(locationUuid)) return { mailchimp: false }
  const ok = await saveMailchimpChoice(leadId, 'in', 'auto_close', null, deps)
  return { mailchimp: ok }
}
