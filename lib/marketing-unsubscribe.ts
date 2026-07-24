// lib/marketing-unsubscribe.ts
//
// The unsubscribe token mint — the impure half of the marketing rail (the
// pure gate + footer live in lib/marketing-consent, same split as
// no-coverage-copy / no-coverage-email).
//
// WHY first-mint-wins, the OPPOSITE of the opt-in token's overwrite-on-retry:
// optin_token is re-minted per no-coverage send because each send is a fresh
// offer with a fresh 45-day window. unsubscribe_token is the key printed into
// EVERY marketing email's footer — overwriting it would break the link in
// every message already sitting in an inbox. So it is minted at most once per
// lead and then stable for the life of the lead, with the same DB-side
// .is(null) guard the consent write uses: two concurrent sends racing to mint
// cannot each stamp their own token, and both re-read whichever won.
//
// A null return means "no token could be established" (columns missing
// pre-migration, or a write failure). The caller MUST NOT send marketing to
// that lead: an unsubscribe link that 404s is a CAN-SPAM violation, not a
// degraded send.

import crypto from 'node:crypto'
import { supabaseService } from './supabase-service'

// Same shape as the invite + opt-in rails: 24 random bytes → 48 hex chars.
export async function ensureUnsubscribeToken(leadId: string): Promise<string | null> {
  try {
    const { data: existing, error: readError } = await supabaseService
      .from('leads')
      .select('unsubscribe_token')
      .eq('id', leadId)
      .maybeSingle()
    if (readError) {
      console.warn('[marketing-unsubscribe] token read failed', readError.message)
      return null
    }
    if (existing?.unsubscribe_token) return existing.unsubscribe_token

    const token = crypto.randomBytes(24).toString('hex')
    const { error: writeError } = await supabaseService
      .from('leads')
      .update({ unsubscribe_token: token, updated_at: new Date().toISOString() })
      .eq('id', leadId)
      .is('unsubscribe_token', null)
    if (writeError) {
      console.warn('[marketing-unsubscribe] token mint failed', writeError.message)
      return null
    }

    // Re-read rather than trusting our own write: if a concurrent mint won the
    // .is(null) race, THEIR token is the one on the row and ours went nowhere.
    const { data: after, error: rereadError } = await supabaseService
      .from('leads')
      .select('unsubscribe_token')
      .eq('id', leadId)
      .maybeSingle()
    if (rereadError) {
      console.warn('[marketing-unsubscribe] token re-read failed', rereadError.message)
      return null
    }
    return after?.unsubscribe_token ?? null
  } catch (err) {
    console.warn('[marketing-unsubscribe] token mint threw', err)
    return null
  }
}
