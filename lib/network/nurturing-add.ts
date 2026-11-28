// lib/network/nurturing-add.ts
// ─────────────────────────────────────────────────────────────
// FL-135 (Kevin, 2026-11-28): THE NURTURING TAB'S ADD. The person goes
// straight into Nurturing — no 30-day wait — because the owner said so
// (leads.nurture_choice 'in', how 'nurturing_add').
//
// Two boxes, both unticked, separate so an owner can do one without the other:
//   · "Send to Mailchimp"        → their Mailchimp choice is 'in' and the
//                                  one-person add runs (every lock applies;
//                                  only where Mailchimp is open).
//   · "Send the welcome email"   → Bee Hub's own greeting, scheduled the usual
//                                  way (24 hours, the greeting's own checks).
// Unticked: nothing is sent, and no greeting is scheduled.
//
// NOT AN ENQUIRY. The record's import_source is 'nurturing_add', so it never
// lands in the Inbox, never shows as New, and the 35-day auto-close never sees
// it (both read 'manual' only, lib/enquiry-exit.ts). No lead alert, no team
// chat post, no drip, nothing to Jobber: this file calls none of them.
//
// SAME PERSON TWICE. Someone already at this location with the same email or
// phone is not made again: the screen is told who, and the owner may put that
// person in Nurturing instead (existingId).
// ─────────────────────────────────────────────────────────────

import { phoneForWrite, phoneKey } from '../phone'
import { emailKey } from '../mailchimp-rules'
import { NURTURING_ADD_SOURCE } from '@/components/hive/shared/nurtureBox'
import { mailchimpOpenFor } from '../mailchimp-rollout'

export type AddInput = {
  firstName?: unknown; lastName?: unknown; email?: unknown; phone?: unknown
  sendMailchimp?: unknown; sendWelcome?: unknown; existingId?: unknown
}
export type AddLocation = { id: string; slug: string }

const text = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export type AddPlan =
  | { ok: false; error: 'name_required' | 'contact_required' | 'bad_email' }
  | { ok: true; first: string; last: string; email: string | null; phone: string | null; phoneNote: string | null; mailchimp: boolean; welcome: boolean }

/** What was typed, checked. Pure. */
export function planAdd(input: AddInput, loc: AddLocation): AddPlan {
  const first = text(input.firstName), last = text(input.lastName)
  if (!first && !last) return { ok: false, error: 'name_required' }
  const rawEmail = text(input.email, 320)
  const email = rawEmail ? emailKey(rawEmail) && rawEmail : null
  if (rawEmail && !email) return { ok: false, error: 'bad_email' }
  const p = phoneForWrite(text(input.phone, 60))
  if (!email && !p.value) return { ok: false, error: 'contact_required' }
  return {
    ok: true, first, last, email: email || null, phone: p.value, phoneNote: p.note,
    // Mailchimp is only offered where it is open; a tick sent from elsewhere is ignored.
    mailchimp: input.sendMailchimp === true && mailchimpOpenFor(loc.id) && !!email,
    welcome: input.sendWelcome === true && !!email,
  }
}

/** The new record. Pure. Its choices are made in the same write as the person. */
export function newNurtureRow(plan: Extract<AddPlan, { ok: true }>, loc: AddLocation, by: string, nowIso: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    location_id: loc.slug, location_uuid: loc.id,
    name: [plan.first, plan.last].filter(Boolean).join(' '),
    first_name: plan.first || null, last_name: plan.last || null,
    email: plan.email, phone: plan.phone,
    import_source: NURTURING_ADD_SOURCE,
    source: 'Added to Nurturing',
    created_at: nowIso,
    nurture_choice: 'in', nurture_choice_at: nowIso, nurture_choice_how: 'nurturing_add', nurture_choice_by: by,
  }
  if (plan.phoneNote) row.notes = `Phone as typed: ${plan.phoneNote}`
  if (plan.mailchimp) Object.assign(row, { mailchimp_choice: 'in', mailchimp_choice_at: nowIso, mailchimp_choice_how: 'nurturing_add', mailchimp_choice_by: by })
  return row
}

/** Someone already at this location with this email or phone (live records only). */
export async function findSamePerson(db: any, loc: AddLocation, plan: Extract<AddPlan, { ok: true }>): Promise<{ id: string; name: string } | null> {
  const checks: Array<() => any> = []
  if (plan.email) checks.push(() => db.from('leads').select('id, name, email').eq('location_uuid', loc.id).is('archived_at', null).not('is_junk', 'is', true).ilike('email', plan.email!.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(1))
  const pk = plan.phone ? phoneKey(plan.phone) : ''
  if (pk.length >= 7) checks.push(() => db.from('leads').select('id, name, email').eq('location_uuid', loc.id).is('archived_at', null).not('is_junk', 'is', true).eq('phone_normalized', pk).limit(1))
  for (const run of checks) {
    const { data, error } = await run()
    if (error) throw new Error(`duplicate check: ${error.message}`)
    if (data && data[0]) return { id: data[0].id, name: data[0].name || data[0].email || 'Someone' }
  }
  return null
}
