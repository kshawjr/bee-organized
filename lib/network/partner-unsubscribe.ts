// lib/network/partner-unsubscribe.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 2 (2026-11-22) — the unsubscribe link for a REFERRAL
// PARTNER (the Network's `partners` table). The partner twin of
// lib/marketing-unsubscribe.ts, which is left byte for byte as it was: it is
// one of the files every client email is built from, and an existing guard
// (lib/beta-email-preview-frame.test.tsx) holds it to main.
//
// A partner gets the same kind of link, /unsubscribe/<token>, and the same
// public page (app/unsubscribe/[token]). The difference is where the key
// lives: in its own server-only table, partner_unsubscribes, never on the
// contact row the owner's screens read, and it is made by the database
// (64 hex characters, so it can never be mistaken for a client's 48).
//
// Every call goes to a database function (migrations/partner_emails.sql), so
// each is one transaction: two sends racing to make a key both get the same
// one, and an unsubscribe records the contact, the history and the stopped
// sequences together or not at all. Those functions are the ONLY way the
// unsubscribe columns can be written; the database refuses anything else.
//
// OPENING A LINK NEVER UNSUBSCRIBES (mail scanners open every link):
//   partnerUnsubscribeStatus      what the page calls on open — reads only
//   consumePartnerUnsubscribeToken  what the button's POST calls — the only
//                                 thing that records a partner's own
//                                 unsubscribe ('link', permanent)
//   markPartnerUnsubscribed       someone at the location marks them by hand
//                                 ('owner', reversible)
//   reversePartnerUnsubscribe     a super admin reverses an OWNER's mark;
//                                 never a partner's own
//
// Nothing here sends. Slice 4's sender must call ensurePartnerUnsubscribeToken
// and refuse to send on null, exactly as a client send does with
// ensureUnsubscribeToken; the footer's postal address comes from the same
// MARKETING_POSTAL_ADDRESS the client footer uses.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'

export const PARTNER_TOKEN_PATTERN = /^[0-9a-f]{64}$/

// The partner's link key, made on first need. Null = no key could be had (no
// such contact, no email address, the migration not run, a database error):
// the caller MUST NOT send.
export async function ensurePartnerUnsubscribeToken(partnerId: string): Promise<string | null> {
  if (!partnerId) return null
  try {
    const { data, error } = await supabaseService.rpc('partner_unsubscribe_token', { p_partner_id: partnerId })
    if (error) {
      console.warn('[partner-unsubscribe] token mint failed', error.message)
      return null
    }
    return typeof data === 'string' && PARTNER_TOKEN_PATTERN.test(data) ? data : null
  } catch (err) {
    console.warn('[partner-unsubscribe] token mint threw', err)
    return null
  }
}

type PartnerNames = { name: string | null; first_name: string | null; network_types: string[] | null }
type Row = { outcome?: string; partner_name?: string | null; partner_first_name?: string | null; partner_network_types?: string[] | null }
const namesOf = (row: Row): PartnerNames => ({ name: row.partner_name ?? null, first_name: row.partner_first_name ?? null, network_types: row.partner_network_types ?? null })
const missingFunction = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code
  return code === 'PGRST202' || code === '42883'
}

export type PartnerUnsubscribeStatus =
  | { outcome: 'pending' | 'already'; partner: PartnerNames }
  | { outcome: 'not_found' }
  | { outcome: 'failed' }

// What OPENING the link calls. Reads only: never records anything.
export async function partnerUnsubscribeStatus(token: string): Promise<PartnerUnsubscribeStatus> {
  if (!PARTNER_TOKEN_PATTERN.test(token || '')) return { outcome: 'not_found' }
  try {
    const { data, error } = await supabaseService.rpc('partner_unsubscribe_status', { p_token: token })
    if (error) {
      if (missingFunction(error)) return { outcome: 'not_found' }
      console.error('[unsubscribe] partner status lookup failed', error.message)
      return { outcome: 'failed' }
    }
    const row = (Array.isArray(data) ? data[0] : data) as Row | null
    if (!row || row.outcome === 'not_found') return { outcome: 'not_found' }
    if (row.outcome !== 'pending' && row.outcome !== 'already') return { outcome: 'failed' }
    return { outcome: row.outcome, partner: namesOf(row) }
  } catch (err) {
    console.error('[unsubscribe] partner status lookup threw', err)
    return { outcome: 'failed' }
  }
}

export type PartnerUnsubscribeResult =
  // 'unsubscribed' = this click did it; 'already' = an earlier one did.
  | { outcome: 'unsubscribed' | 'already'; partner: { name: string | null; first_name: string | null; network_types: string[] | null } }
  // No partner key like this one (or the migration not run yet).
  | { outcome: 'not_found' }
  // The database could not be asked, or refused: never tell the person they
  // are unsubscribed when we do not know that they are.
  | { outcome: 'failed' }

// What PRESSING the button calls (app/unsubscribe/[token]/confirm, a POST).
export async function consumePartnerUnsubscribeToken(token: string): Promise<PartnerUnsubscribeResult> {
  if (!PARTNER_TOKEN_PATTERN.test(token || '')) return { outcome: 'not_found' }
  try {
    const { data, error } = await supabaseService.rpc('partner_unsubscribe', { p_token: token })
    if (error) {
      // The function not existing yet = the migration has not run = no
      // partner link can have been sent: the clean "no longer active" state.
      if (missingFunction(error)) return { outcome: 'not_found' }
      console.error('[unsubscribe] partner withdrawal failed', error.message)
      return { outcome: 'failed' }
    }
    const row = (Array.isArray(data) ? data[0] : data) as Row | null
    if (!row || row.outcome === 'not_found') return { outcome: 'not_found' }
    if (row.outcome !== 'unsubscribed' && row.outcome !== 'already') return { outcome: 'failed' }
    return { outcome: row.outcome, partner: namesOf(row) }
  } catch (err) {
    console.error('[unsubscribe] partner withdrawal threw', err)
    return { outcome: 'failed' }
  }
}

// Someone at the location marks a contact unsubscribed by hand. The database
// checks `by` may edit that location's Network, and records who and when.
export type PartnerMarkOutcome = 'unsubscribed' | 'already' | 'not_found' | 'not_allowed' | 'failed'
export async function markPartnerUnsubscribed(partnerId: string, by: string): Promise<PartnerMarkOutcome> {
  if (!partnerId || !by) return 'not_found'
  try {
    const { data, error } = await supabaseService.rpc('partner_mark_unsubscribed', { p_partner_id: partnerId, p_by: by })
    if (error) {
      console.error('[partner-unsubscribe] mark failed', error.message)
      return 'failed'
    }
    return (['unsubscribed', 'already', 'not_found', 'not_allowed'] as const).find((o) => o === data) ?? 'failed'
  } catch (err) {
    console.error('[partner-unsubscribe] mark threw', err)
    return 'failed'
  }
}

// A super admin reverses an OWNER's mark. The database checks `by` is a super
// admin, refuses a partner's own unsubscribe, and keeps the history.
// stillBlocked: the eligibility answer afterwards (e.g. the same address is
// unsubscribed on another contact), null if they may be emailed again.
export type PartnerReverseOutcome =
  | 'reversed' | 'not_super_admin' | 'not_found' | 'not_unsubscribed' | 'partner_unsubscribed_themselves' | 'failed'
export async function reversePartnerUnsubscribe(partnerId: string, by: string): Promise<{ outcome: PartnerReverseOutcome; stillBlocked: string | null }> {
  if (!partnerId || !by) return { outcome: 'not_found', stillBlocked: null }
  try {
    const { data, error } = await supabaseService.rpc('partner_reverse_unsubscribe', { p_partner_id: partnerId, p_by: by })
    if (error) {
      console.error('[partner-unsubscribe] reverse failed', error.message)
      return { outcome: 'failed', stillBlocked: null }
    }
    const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; still_blocked?: string | null } | null
    const outcome = (['reversed', 'not_super_admin', 'not_found', 'not_unsubscribed', 'partner_unsubscribed_themselves'] as const)
      .find((o) => o === row?.outcome) ?? 'failed'
    return { outcome, stillBlocked: row?.still_blocked ?? null }
  } catch (err) {
    console.error('[partner-unsubscribe] reverse threw', err)
    return { outcome: 'failed', stillBlocked: null }
  }
}
