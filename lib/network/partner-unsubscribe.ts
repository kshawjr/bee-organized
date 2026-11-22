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
// Both calls go to database functions (migrations/partner_emails.sql) so each
// is one transaction: two sends racing to make a key both get the same one,
// and an unsubscribe records the contact, the permanent record and the stopped
// sequences together or not at all.
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

export type PartnerUnsubscribeResult =
  // 'unsubscribed' = this click did it; 'already' = an earlier one did.
  | { outcome: 'unsubscribed' | 'already'; partner: { name: string | null; first_name: string | null; network_types: string[] | null } }
  // No partner key like this one (or the migration not run yet).
  | { outcome: 'not_found' }
  // The database could not be asked, or refused: never tell the person they
  // are unsubscribed when we do not know that they are.
  | { outcome: 'failed' }

// What the public unsubscribe page calls for a token that is not a client's.
export async function consumePartnerUnsubscribeToken(token: string): Promise<PartnerUnsubscribeResult> {
  if (!PARTNER_TOKEN_PATTERN.test(token || '')) return { outcome: 'not_found' }
  try {
    const { data, error } = await supabaseService.rpc('partner_unsubscribe', { p_token: token })
    if (error) {
      // The function not existing yet = the migration has not run = no
      // partner link can have been sent: the clean "no longer active" state.
      const code = (error as { code?: string }).code
      if (code === 'PGRST202' || code === '42883') return { outcome: 'not_found' }
      console.error('[unsubscribe] partner withdrawal failed', error.message)
      return { outcome: 'failed' }
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { outcome?: string; partner_name?: string | null; partner_first_name?: string | null; partner_network_types?: string[] | null }
      | null
    if (!row || row.outcome === 'not_found') return { outcome: 'not_found' }
    if (row.outcome !== 'unsubscribed' && row.outcome !== 'already') return { outcome: 'failed' }
    return {
      outcome: row.outcome,
      partner: { name: row.partner_name ?? null, first_name: row.partner_first_name ?? null, network_types: row.partner_network_types ?? null },
    }
  } catch (err) {
    console.error('[unsubscribe] partner withdrawal threw', err)
    return { outcome: 'failed' }
  }
}
