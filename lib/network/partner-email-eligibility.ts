// lib/network/partner-email-eligibility.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 2 (2026-11-22) — MAY THIS PARTNER BE EMAILED NOW?
// The one check every partner email must pass before it goes. Nothing sends
// in this slice; slice 4's sender is required to call partnerCanReceive for
// EVERY partner email, whichever way it is going out:
//
//   start   the owner starts a partner on a sequence (its first email)
//   step    the next email of a sequence comes due
//   manual  a one-off email (e.g. 502 sent by hand)
//   test    a test sent TO a partner's own address
//
// There is no kind that skips the check, and no argument that turns it off.
//
// THE ANSWER COMES FROM THE DATABASE, not from a copy of the row the caller
// happens to hold: public.partner_send_block_reason (migrations/
// partner_emails.sql) reads the contact, the permanent unsubscribe record and
// every other contact with the same address at the moment of asking. The
// database asks the same question again whenever a partner sequence row is
// active, so a sender that forgot to ask here would be refused there.
//
// FAILS CLOSED: if the database cannot be asked (an error, the migration not
// run yet), the answer is NO. Not sending is the safe mistake; sending to
// someone who unsubscribed is the CAN-SPAM violation.
//
// partnerBlockReasonFromFacts is the same rule written in TypeScript, for
// explaining an answer on a screen; the dry run holds the two equal over
// every combination of facts. It never decides a send.
// ─────────────────────────────────────────────────────────────

export const PARTNER_SEND_KINDS = ['start', 'step', 'manual', 'test'] as const
export type PartnerSendKind = (typeof PARTNER_SEND_KINDS)[number]

export const PARTNER_BLOCK_REASONS = [
  'not_found',
  'unsubscribed',
  'deleted',
  'no_email',
  'address_unsubscribed',
  'check_failed',
] as const
export type PartnerBlockReason = (typeof PARTNER_BLOCK_REASONS)[number]

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }

/** Why this partner may not be emailed now, or null if they may. Never throws. */
export async function partnerSendBlockReason(db: Rpc, partnerId: string): Promise<PartnerBlockReason | null> {
  if (!partnerId) return 'not_found'
  try {
    const { data, error } = await db.rpc('partner_send_block_reason', { p_partner_id: partnerId })
    if (error) return 'check_failed'
    if (data === null) return null
    return (PARTNER_BLOCK_REASONS as readonly unknown[]).includes(data) ? (data as PartnerBlockReason) : 'check_failed'
  } catch {
    return 'check_failed'
  }
}

/** The gate. True only when the database says this partner may be emailed now. */
export async function partnerCanReceive(db: Rpc, partnerId: string, kind: PartnerSendKind): Promise<boolean> {
  if (!(PARTNER_SEND_KINDS as readonly string[]).includes(kind)) return false
  return (await partnerSendBlockReason(db, partnerId)) === null
}

export type PartnerSendFacts = {
  exists: boolean
  unsubscribedAt: string | null
  deletedAt: string | null
  email: string | null
  /** The address is unsubscribed on the permanent record or on another contact. */
  addressUnsubscribed: boolean
}

/** The database rule, in TypeScript, in the same order. For words on a screen only. */
export function partnerBlockReasonFromFacts(f: PartnerSendFacts): Exclude<PartnerBlockReason, 'check_failed'> | null {
  if (!f.exists) return 'not_found'
  if (f.unsubscribedAt) return 'unsubscribed'
  if (f.deletedAt) return 'deleted'
  // btrim in the database trims spaces only; so does this.
  if (!(f.email || '').replace(/^ +| +$/g, '')) return 'no_email'
  if (f.addressUnsubscribed) return 'address_unsubscribed'
  return null
}
