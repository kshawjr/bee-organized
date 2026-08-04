// lib/payment-link-copy.ts
//
// issue 185 — copy + formatting helpers for the "Get payment link" button in
// the LocationDetailSheet Subscription section (components/BeeHub.jsx). The
// button drives POST /api/admin/subscription-checkout-link (issue 182); this
// module translates that route's raw error tokens into instructions Kevin can
// act on and formats the sanity-check summary he must read BEFORE sending a
// link (anchor date, seat composition, projected annual total).
//
// It lives in lib/ — not inline in the 30k-line component — so the translation
// and formatting are unit-testable without mounting BeeHub. The rendering +
// gating in the component are pinned by source-match (see
// lib/payment-link-button-185.test.ts).

export interface CheckoutLine {
  tier: string
  quantity: number
  unit_price_annual: number | null
}

// The route returns bare tokens (issue 182). Kevin needs an instruction, not a
// token. These are the ones he will actually hit for the ten legacy locations;
// the rest fall through to translatePaymentLinkError's framed fallback.
export const PAYMENT_LINK_ERROR_COPY: Record<string, string> = {
  location_not_active:
    'This location isn’t active yet, so it can’t be billed here. Active locations only — an inactive one activates through onboarding’s pay step, not this button.',
  paid_through_not_future:
    'This location has no future paid-through date to anchor the first invoice to. Set a paid-through date in the future first — anchoring to a past/blank date would make Stripe charge immediately.',
  no_billable_seats:
    'This location has no billable seats, so there’s nothing to put on a subscription. Add at least one paid seat first.',
  seat_tier_not_priced:
    'One of this location’s seat tiers has no Stripe price set, so the link would under-bill. Set that tier’s price in the Pricing tab before generating.',
  non_paying_source:
    'This location is on a corporate / non-paying billing source, so it never pays through Stripe. Convert it to direct billing before generating a link.',
  location_not_found:
    'Location not found — reload the page and try again.',
  stripe_not_configured:
    'Stripe isn’t configured in this environment. Nothing was created.',
  owner_price_not_configured:
    'The owner seat tier has no Stripe price set. Configure it in the Pricing tab first.',
  paid_through_unparseable:
    'This location’s paid-through date couldn’t be read. Re-save a valid future date and try again.',
  checkout_no_url:
    'Stripe accepted the request but returned no checkout URL. Nothing was sent — try again.',
  seat_read_failed:
    'Couldn’t read this location’s seats. Nothing was created — try again in a moment.',
  'location_id required':
    'No location was supplied to the request. Reload the sheet and try again.',
  'forbidden — super_admin only':
    'Only a super_admin can generate a payment link.',
  unauthorized:
    'Your session expired. Sign in again and retry.',
}

// token (+ optional server-supplied detail) → readable, actionable sentence.
// Unknown tokens are surfaced framed as an error rather than printed raw, so a
// future route change never leaks a bare token to Kevin.
export function translatePaymentLinkError(
  token: string | undefined | null,
  detail?: string | null,
): string {
  if (!token) return 'Something went wrong generating the link. Nothing was created — try again.'
  const known = PAYMENT_LINK_ERROR_COPY[token]
  if (known) return known
  if (token === 'stripe_error') {
    return `Stripe rejected the request${detail ? `: ${detail}` : ''}. Nothing was created — try again.`
  }
  return `Couldn’t generate the link (${token}). Nothing was created — check the location’s billing state and try again.`
}

const TIER_LABEL_SINGULAR: Record<string, string> = {
  owner: 'owner',
  manager: 'manager',
  light: 'light seat',
  readonly: 'read-only seat',
}
const TIER_LABEL_PLURAL: Record<string, string> = {
  owner: 'owners',
  manager: 'managers',
  light: 'light seats',
  readonly: 'read-only seats',
}

// lines → "owner + 2 managers". Quantity 1 renders the bare singular label; >1
// prefixes the count and pluralizes. Unknown tiers fall back to the raw tier
// string so nothing is silently dropped from the composition Kevin reviews.
export function formatCheckoutLines(lines: CheckoutLine[] | null | undefined): string {
  if (!lines || lines.length === 0) return '—'
  const parts = lines
    .filter((l) => l && l.quantity > 0)
    .map((l) => {
      const one = TIER_LABEL_SINGULAR[l.tier] ?? l.tier
      const many = TIER_LABEL_PLURAL[l.tier] ?? `${l.tier}s`
      return l.quantity === 1 ? one : `${l.quantity} ${many}`
    })
  return parts.length ? parts.join(' + ') : '—'
}

// projected_annual_cents → "$1,350/yr". Guards non-finite input to $0 rather
// than "$NaN/yr".
export function formatProjectedAnnual(cents: number | null | undefined): string {
  const c = typeof cents === 'number' && isFinite(cents) ? cents : 0
  const dollars = Math.round(c / 100)
  return `$${dollars.toLocaleString('en-US')}/yr`
}
