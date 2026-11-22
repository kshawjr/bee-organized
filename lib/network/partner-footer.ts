// lib/network/partner-footer.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 3 (2026-11-22) — the unsubscribe footer a PARTNER
// email carries. Pure: no database, no email.
//
// Every partner email promotes the business, so every one carries the
// CAN-SPAM footer: a working unsubscribe link and the company-wide postal
// address (MARKETING_POSTAL_ADDRESS, the same one client emails print —
// Kevin, 2026-11-22). It is the client footer (lib/marketing-consent.ts
// buildMarketingFooter, untouched) with two of its words made true for a
// partner:
//   · the "why you're getting this" line says they are a referral partner,
//     not a client (an inaccurate line is its own CAN-SPAM problem);
//   · "one click" is dropped: a partner's link opens a page with a button
//     (slice 2, so a mail scanner cannot unsubscribe them), which is two.
// Both new sentences are PLACEHOLDERS FOR KEVIN TO WORD.
// ─────────────────────────────────────────────────────────────

import { buildMarketingFooter } from '@/lib/marketing-consent'

export const PARTNER_FOOTER_REASON = "You're receiving this because you're one of Bee Organized's referral partners."
const CLIENT_REASON = "You're receiving this because you're a Bee Organized client."
const ONE_CLICK = ' at any time — one click, nothing to fill in.'
const PARTNER_HOW = ' at any time — nothing to fill in.'

// The client footer escapes text this way (& < > " '); the swap must match it.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function buildPartnerFooter(args: { unsubscribeUrl: string; postalAddress: string | null }): { html: string; text: string } {
  const base = buildMarketingFooter({ unsubscribeUrl: args.unsubscribeUrl, postalAddress: args.postalAddress, audience: 'client' })
  const html = base.html.replace(esc(CLIENT_REASON), esc(PARTNER_FOOTER_REASON)).replace(ONE_CLICK, PARTNER_HOW)
  const text = base.text.replace(CLIENT_REASON, PARTNER_FOOTER_REASON)
  // If the client footer's words ever change, fail loudly rather than send a
  // partner a footer that calls them a client.
  if (html.includes(esc(CLIENT_REASON)) || text.includes(CLIENT_REASON) || !html.includes(esc(PARTNER_FOOTER_REASON)) || !text.includes(PARTNER_FOOTER_REASON)) {
    throw new Error('partner footer: the client footer wording changed; update lib/network/partner-footer.ts')
  }
  return { html, text }
}

// What a TEST partner email's unsubscribe link points at: a fixed address
// that is no one's key (not a client's 48 hex, not a partner's 64 hex), so
// the page answers "This link is no longer active" and nothing is recorded.
// The same placeholder the client test send uses.
export const TEST_UNSUBSCRIBE_PATH = '/unsubscribe/test-email'

// The made-up partner every TEST partner email (and the screen's preview)
// greets: "Hi Taylor,". Never a real contact; nothing reads a partner row.
export const TEST_SAMPLE_PARTNER = { name: 'Taylor', first_name: 'Taylor', network_types: ['partner'] as string[] }
