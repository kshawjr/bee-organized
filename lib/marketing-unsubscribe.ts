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
import {
  buildMarketingFooter,
  unsubscribePathFor,
  type MarketingAudience,
} from './marketing-consent'

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

// ── The CAN-SPAM footer rail (#115) ─────────────────────────────────────────
//
// The one seam a COMMERCIAL send rail calls to attach a compliant footer to its
// already-rendered html + text. It ties the three pieces the scout found on the
// shelf (token mint, absolute unsubscribe URL, postal address) into a single
// call, and — critically — FAILS CLOSED.
//
// WHY fail closed: a commercial email that carries no working unsubscribe link,
// or no physical postal address, is the CAN-SPAM violation itself. Sending a
// non-compliant email is worse than not sending; a held send self-heals (the
// caller leaves its schedule intact and retries) the moment the address env is
// set or the token can be minted. So the two required elements are checked
// BEFORE the bodies are touched, and any miss returns { ok: false } with a
// reason the caller logs — it never returns a partially-footered body.
//
// It deliberately does NOT call marketingSendBlockReason: that gate demands a
// positive marketing_consented_at, which is the OPT-IN mailing-list contract,
// not CAN-SPAM. CAN-SPAM turns on opt-out-honored + address + accurate headers,
// none of which need prior consent. The rails keep their own marketing_opt_out
// check; this helper adds only the footer + token.
export type AppendCanSpamFooterResult =
  | { ok: true; html: string; text: string }
  | { ok: false; reason: 'no_token' | 'no_postal_address' }

export async function appendCanSpamFooter(
  html: string,
  text: string,
  args: { leadId: string; audience: MarketingAudience },
): Promise<AppendCanSpamFooterResult> {
  // Postal address first — it's a pure env read, so a misconfiguration is caught
  // before we spend a DB round-trip minting a token. process.env.MARKETING_POSTAL_ADDRESS
  // is confirmed set in Vercel production; this is the read that never existed.
  const postalAddress = (process.env.MARKETING_POSTAL_ADDRESS || '').trim()
  if (!postalAddress) {
    console.error('[can-spam] MARKETING_POSTAL_ADDRESS not set — refusing commercial send', {
      leadId: args.leadId,
    })
    return { ok: false, reason: 'no_postal_address' }
  }

  // A null token means no working unsubscribe link could be established — refuse.
  const token = await ensureUnsubscribeToken(args.leadId)
  if (!token) {
    console.error('[can-spam] could not establish unsubscribe token — refusing commercial send', {
      leadId: args.leadId,
    })
    return { ok: false, reason: 'no_token' }
  }

  // The unsubscribe link MUST be absolute in an email. NEXT_PUBLIC_APP_URL is the
  // stable custom domain (same source the #90 drip logo uses); NEXT_PUBLIC_SITE_URL
  // is the alternate key. Both are set in production.
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(
    /\/+$/,
    '',
  )
  const unsubscribeUrl = `${base}${unsubscribePathFor(token)}`

  const footer = buildMarketingFooter({ unsubscribeUrl, postalAddress, audience: args.audience })
  return {
    ok: true,
    html: `${html}${footer.html}`,
    text: `${text}\n\n${footer.text}`,
  }
}
