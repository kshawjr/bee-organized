// lib/marketing-consent.ts
//
// The marketing-send consent gate + the CAN-SPAM footer. PURE: no imports, no
// side effects, no server-only deps — the same split as lib/no-coverage-copy,
// and for the same reason: whatever surface one day PREVIEWS a marketing email
// must render the exact footer the send attaches, or the preview lies.
//
// There is deliberately NO marketing sender in this file, and none exists in
// the app yet — nothing mails the mailing-list cohort today. This gate ships
// FIRST so that the future sender starts life behind it rather than growing
// one later. The contract for that sender:
//
//   1. call marketingSendBlockReason(lead) and refuse on any non-null reason
//   2. call ensureUnsubscribeToken(leadId)   (lib/marketing-unsubscribe — the
//      impure half) and refuse to send if no token could be minted: a
//      marketing email without a working unsubscribe link is a CAN-SPAM
//      violation, not a degraded send
//   3. append buildMarketingFooter(...) to BOTH the html and text bodies
//
// WHY the gate is three checks and not just marketing_opt_out:
//   marketing_opt_out is "do not send" — necessary but not sufficient. This
//   list is consent-BASED (people joined it by clicking the opt-in link), so
//   the gate also demands the positive consent record. A lead that never
//   consented is just as unmailable as one who opted out; they differ only in
//   which compliance question they'd fail.

export type MarketingConsentFields = {
  marketing_opt_out?: boolean | null
  marketing_consented_at?: string | null
  marketing_unsubscribed_at?: string | null
}

export type MarketingBlockReason = 'opted_out' | 'unsubscribed' | 'no_consent'

// The send-time gate. Null = this lead may receive marketing; any string is
// the refusal reason, ordered most-explicit-first so a lead that both opted
// out and lacks consent reports the stronger fact.
//
// marketing_unsubscribed_at is checked in its own right even though the
// unsubscribe page also sets marketing_opt_out: the two columns have different
// writers (staff can set opt_out from the app; only the public page stamps
// unsubscribed_at), and the gate must hold even if some future path resets one
// flag without the other.
export function marketingSendBlockReason(
  lead: MarketingConsentFields,
): MarketingBlockReason | null {
  if (lead.marketing_opt_out === true) return 'opted_out'
  if (lead.marketing_unsubscribed_at) return 'unsubscribed'
  if (!lead.marketing_consented_at) return 'no_consent'
  return null
}

// Path (not URL) for an unsubscribe token — single spelling of the route so
// the page, the footer builder's callers, and tests can't drift apart.
export function unsubscribePathFor(token: string): string {
  return `/unsubscribe/${token}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// The CAN-SPAM footer, in both parts, from one place. Two required elements:
// a working unsubscribe link and the sender's physical postal address.
//
// postalAddress comes in as an argument (the send rail reads it from
// MARKETING_POSTAL_ADDRESS) rather than being hardcoded: inventing an address
// here would manufacture a compliance fact. Null renders no address line —
// TOLERATED by the builder so previews work before configuration, but the
// future sender must treat a missing address like a missing unsubscribe
// token: refuse to send.
export function buildMarketingFooter(args: {
  unsubscribeUrl: string
  postalAddress?: string | null
}): { html: string; text: string } {
  const { unsubscribeUrl } = args
  const postal = (args.postalAddress || '').trim()

  const textLines = [
    '—',
    "You're receiving this because you joined the Bee Organized mailing list.",
    `Unsubscribe at any time: ${unsubscribeUrl}`,
    ...(postal ? [`Bee Organized · ${postal}`] : []),
  ]
  const text = textLines.join('\n')

  const html = `<div style="margin-top:28px;padding-top:14px;border-top:1px solid rgba(0,0,0,0.08);font-size:11px;line-height:1.6;color:#8a9e9a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <p style="margin:0 0 4px;">You're receiving this because you joined the Bee Organized mailing list.</p>
  <p style="margin:0 0 4px;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#4a5e5a;text-decoration:underline;">Unsubscribe</a> at any time — one click, nothing to fill in.</p>
  ${postal ? `<p style="margin:0;">Bee Organized &middot; ${escapeHtml(postal)}</p>` : ''}
</div>`

  return { html, text }
}
