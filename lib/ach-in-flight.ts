// lib/ach-in-flight.ts
// ─────────────────────────────────────────────────────────────
// "The owner is in, the money is not here yet" — issue 313.
//
// Issue 313 activates a location on checkout.session.completed even when
// payment_status is 'unpaid', because that is what an ACH bank debit always
// looks like at checkout time. The owner gets in immediately. What must NOT
// happen is that the system then FORGETS the money is still in flight: a
// location that reads active, seated and paid-through is otherwise
// indistinguishable from one whose bank transfer actually cleared, and the
// audit already found money landing against a placeholder with nobody
// noticing.
//
// WHERE THE IN-FLIGHT FACT LIVES, and why it is not a new column.
//
// It lives in `locations.billing_notes`, as an appended audit line carrying a
// bracketed marker token. Three reasons this beats a new column:
//
//   1. No migration. A new column would gate this fix behind a schema change;
//      the exposure it closes is live today, four locations deep.
//   2. billing_notes is ALREADY the audit-trail convention for money on a
//      location — the Record Payment flow appends its own line there, and the
//      admin billing card renders the field. So the in-flight fact shows up
//      in the one place a human already looks when they ask "has this
//      location paid?", with no new surface to build or remember.
//   3. It is append-only, so the history survives. "Activated on an unpaid
//      ACH on the 19th, cleared on the 25th" stays readable a year later;
//      a boolean column would have flipped and told you nothing.
//
// The ledger says the same thing independently, and that redundancy is
// deliberate: an ACH-activated location has NO billing_invoices row until the
// money actually lands, because the invoice row is written by the invoice.paid
// handler (billing_reason=subscription_create), never by the checkout path.
// So "active + a Stripe subscription + zero invoice rows" is the same fact in
// the ledger's own vocabulary. Boston and West Raleigh show both halves
// resolving together on 2026-08-11 when their transfers finally cleared.
//
// STATE IS THE LAST MARKER, not a scan for pairs. One location has one
// activation, and keying resolution to the originating session id would mean
// the invoice.paid handler — which knows a subscription id and no session id
// at all — could never clear the flag it is responsible for clearing. Reading
// the most recent marker keeps every writer able to write, and orders
// correctly by construction since the lines are appended chronologically.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

export const ACH_IN_FLIGHT = 'ACH_IN_FLIGHT'
export const ACH_CLEARED = 'ACH_CLEARED'
export const ACH_FAILED = 'ACH_FAILED'

export type AchMarker = typeof ACH_IN_FLIGHT | typeof ACH_CLEARED | typeof ACH_FAILED

const MARKER_RE = /\[(ACH_IN_FLIGHT|ACH_CLEARED|ACH_FAILED)\b[^\]]*\]/g

// The most recent ACH marker in a billing_notes blob, or null when the
// location has never been through an async payment. Pure — the unit-test
// surface for every question below.
export function lastAchMarker(billingNotes: string | null | undefined): AchMarker | null {
  if (!billingNotes) return null
  const found = billingNotes.match(MARKER_RE)
  if (!found || found.length === 0) return null
  const last = found[found.length - 1]
  const kind = last.slice(1).split(/[\s\]]/)[0]
  return kind === ACH_IN_FLIGHT || kind === ACH_CLEARED || kind === ACH_FAILED ? kind : null
}

// True when this location was let in on money that has not arrived.
export function isAchMoneyInFlight(billingNotes: string | null | undefined): boolean {
  return lastAchMarker(billingNotes) === ACH_IN_FLIGHT
}

const dollars = (cents: number | null | undefined): string =>
  cents == null ? '?' : `$${(cents / 100).toFixed(2)}`

// The audit lines. Each leads with the date so the trail reads chronologically
// in the admin billing card, and carries the session id so the row can be
// found in the Stripe dashboard without a second lookup.
export function achInFlightLine(args: {
  amountCents: number | null
  sessionId: string | null
  paymentStatus: string | null
  today?: string
}): string {
  const day = args.today || new Date().toISOString().slice(0, 10)
  return (
    `${day} — [${ACH_IN_FLIGHT} session=${args.sessionId || 'unknown'}] ` +
    `Activated on an UNPAID checkout: ${dollars(args.amountCents)} owner seat, ` +
    `payment_status=${args.paymentStatus || 'unknown'} (bank debit not yet settled). ` +
    `Access granted immediately per issue 313 — the money is still in flight. ` +
    `No billing_invoices row exists for it until invoice.paid arrives.`
  )
}

export function achClearedLine(args: {
  amountCents: number | null
  subscriptionId?: string | null
  today?: string
}): string {
  const day = args.today || new Date().toISOString().slice(0, 10)
  return (
    `${day} — [${ACH_CLEARED}${args.subscriptionId ? ` sub=${args.subscriptionId}` : ''}] ` +
    `The delayed payment settled: ${dollars(args.amountCents)} received. ` +
    `Money is no longer in flight; the invoice is recorded.`
  )
}

export function achFailedLine(args: {
  amountCents: number | null
  sessionId: string | null
  today?: string
}): string {
  const day = args.today || new Date().toISOString().slice(0, 10)
  return (
    `${day} — [${ACH_FAILED} session=${args.sessionId || 'unknown'}] ` +
    `The delayed payment FAILED: ${dollars(args.amountCents)} never cleared. ` +
    `Subscription moved to past_due (14-day grace, full access retained). ` +
    `Collect payment or wind the location down before the grace window closes.`
  )
}

// Append one audit line to locations.billing_notes. Read-then-write rather
// than an atomic append because Postgres has no array here and the notes are
// free text; the events that call this are serialized per location by Stripe's
// own delivery ordering, and the worst case of a lost race is a missing audit
// line, never a wrong location state (which lives in subscription_status).
export async function appendBillingNote(locationId: string, line: string): Promise<void> {
  const { data } = await supabaseService
    .from('locations')
    .select('billing_notes')
    .eq('id', locationId)
    .maybeSingle()
  const prior = ((data as any)?.billing_notes || '').trimEnd()
  const next = prior ? `${prior}\n${line}` : line
  const { error } = await supabaseService
    .from('locations')
    .update({ billing_notes: next })
    .eq('id', locationId)
  if (error) throw new Error(`appendBillingNote failed: ${error.message}`)
}

// Close out an in-flight marker when the money lands. A NO-OP unless the
// location is currently in flight, which is what lets the invoice.paid handler
// call it unconditionally: a card payment (never in flight) writes nothing, so
// the common path is one read and no write.
export async function clearAchInFlight(
  locationId: string,
  args: { amountCents: number | null; subscriptionId?: string | null; today?: string },
): Promise<boolean> {
  const { data } = await supabaseService
    .from('locations')
    .select('billing_notes')
    .eq('id', locationId)
    .maybeSingle()
  const notes = (data as any)?.billing_notes || ''
  if (!isAchMoneyInFlight(notes)) return false
  await appendBillingNote(locationId, achClearedLine(args))
  return true
}
