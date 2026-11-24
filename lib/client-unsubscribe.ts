// lib/client-unsubscribe.ts
// ─────────────────────────────────────────────────────────────────────────────
// FL-75 slice 2 (2026-11-23) — a CLIENT's unsubscribe link, made the same way
// as the partner one (lib/network/partner-unsubscribe.ts): OPENING THE LINK
// ONLY READS. Pressing the button is what unsubscribes.
//
// WHY NOW: mail programs and security scanners open every link in an email,
// and so do link previews and prefetches. Until this slice, opening a client's
// link unsubscribed that one record. From this slice on, a client's no goes on
// the shared no-marketing list (migrations/marketing_unsubscribes.sql) and
// stops marketing at all 54 locations, by address — so a scanner opening the
// link would do far more harm than before. Two of the six unsubscribes on
// record happened 31 and 53 seconds after the email went out; the data cannot
// tell a scanner from a quick human.
//
//   clientUnsubscribeStatus      what the page calls on open — reads only
//   consumeClientUnsubscribe     what the button's POST calls — the only
//                                thing that records a client's own
//                                unsubscribe
//
// The withdrawal itself is the same write the page used to make on open
// (both columns, first-press-wins at the database), plus the same opt-out
// cascade and timeline note. The database trigger puts the address on the
// shared list in the same transaction as that write.
//
// lib/marketing-unsubscribe.ts (the token mint) is not touched: an existing
// guard holds it to main.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'
import { applyDripSideEffects } from '@/lib/drip-lifecycle'

// The client key: 24 random bytes as hex (lib/marketing-unsubscribe.ts). All
// 781 keys minted so far have this shape. A partner key is 64 hex, so the two
// can never be confused.
export const CLIENT_TOKEN_PATTERN = /^[0-9a-f]{48}$/

type LeadRow = {
  id: string
  first_name: string | null
  name: string | null
  location_uuid: string | null
  marketing_unsubscribed_at: string | null
  marketing_opt_out: boolean | null
}

export function firstNameOf(lead: { first_name?: string | null; name?: string | null }): string | null {
  const explicit = (lead.first_name || '').trim()
  if (explicit) return explicit.split(/\s+/)[0]
  const full = (lead.name || '').trim()
  if (full) return full.split(/\s+/)[0]
  return null
}

// Any lookup failure — unknown token, or the columns missing — reads as "no
// row": the page shows its clean inactive state, never an error, and the
// partner lookup still gets its turn.
async function findLead(token: string): Promise<LeadRow | null> {
  try {
    const { data, error } = await supabaseService
      .from('leads')
      .select('id, first_name, name, location_uuid, marketing_unsubscribed_at, marketing_opt_out')
      .eq('unsubscribe_token', token)
      .maybeSingle()
    if (error) {
      console.warn('[unsubscribe] token lookup failed', error.message)
      return null
    }
    return (data as LeadRow | null) ?? null
  } catch (err) {
    console.warn('[unsubscribe] token lookup threw', err)
    return null
  }
}

export type ClientUnsubscribeStatus =
  | { outcome: 'pending' | 'already'; firstName: string | null }
  | { outcome: 'not_found' }

// What OPENING the link calls. One SELECT; never writes anything.
export async function clientUnsubscribeStatus(token: string): Promise<ClientUnsubscribeStatus> {
  if (!token) return { outcome: 'not_found' }
  const lead = await findLead(token)
  if (!lead) return { outcome: 'not_found' }
  // marketing_unsubscribed_at is the "already" flag (only the button stamps
  // it). A staff-set No marketing emails without it still shows the button,
  // so the person's OWN act gets its own dated record.
  return { outcome: lead.marketing_unsubscribed_at ? 'already' : 'pending', firstName: firstNameOf(lead) }
}

export type ClientUnsubscribeResult =
  | { outcome: 'unsubscribed' | 'already'; firstName: string | null }
  | { outcome: 'not_found' }
  // The write failed: never tell the person they are unsubscribed when we do
  // not know that they are.
  | { outcome: 'failed' }

// What PRESSING the button calls (app/unsubscribe/[token]/confirm, a POST).
export async function consumeClientUnsubscribe(token: string): Promise<ClientUnsubscribeResult> {
  if (!CLIENT_TOKEN_PATTERN.test(token || '')) return { outcome: 'not_found' }
  const lead = await findLead(token)
  if (!lead) return { outcome: 'not_found' }
  const firstName = firstNameOf(lead)
  if (lead.marketing_unsubscribed_at) return { outcome: 'already', firstName }

  // Both columns, one write: marketing_opt_out is the do-not-send flag every
  // send rail honours; marketing_unsubscribed_at is WHEN the person withdrew.
  // marketing_consented_at is deliberately NOT cleared. The .is(...) filter
  // makes the write first-press-wins at the database.
  const now = new Date().toISOString()
  const { error } = await supabaseService
    .from('leads')
    .update({ marketing_opt_out: true, marketing_unsubscribed_at: now, updated_at: now })
    .eq('id', lead.id)
    .is('marketing_unsubscribed_at', null)
  if (error) {
    console.error('[unsubscribe] withdrawal write failed', error.message)
    return { outcome: 'failed' }
  }

  // The same immediate-silence cascade a staff-set opt-out gets. Belt and
  // braces — every send rail re-checks at send time — so a failure here is
  // warned, never shown.
  try {
    await applyDripSideEffects({
      leadId: lead.id,
      locationUuid: lead.location_uuid || '',
      prevStage: null,
      patch: { marketing_opt_out: true },
    })
  } catch (err) {
    console.warn('[unsubscribe] opt-out cascade failed', err)
  }

  // The person's own timeline. Non-fatal. location_uuid is required by the
  // table: before FL-75 slice 2 the page left it out, so this note was
  // refused every time (0 written for the 6 unsubscribes on record).
  try {
    const { error: tpError } = await supabaseService.from('touchpoints').insert({
      lead_id: lead.id,
      location_uuid: lead.location_uuid,
      kind: 'system',
      method: 'system',
      label: 'Unsubscribed from marketing emails',
      notes: 'Pressed Unsubscribe in a marketing email. Marketing opt-out set at every location for this email address; consent history retained.',
      status: 'done',
      occurred_at: now,
    })
    if (tpError) console.warn('[unsubscribe] withdrawal touchpoint failed', tpError.message)
  } catch (err) {
    console.warn('[unsubscribe] withdrawal touchpoint failed', err)
  }

  return { outcome: 'unsubscribed', firstName }
}
