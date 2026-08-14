// @vitest-environment node
//
// issue 185 — "Get payment link" button in the LocationDetailSheet
// Subscription section.
//
// The button (components/BeeHub.jsx: GetPaymentLinkButton) drives the issue-182
// route and surfaces its result so Kevin can copy a Stripe checkout link to an
// owner. This file pins:
//
//   A) The copy/format helpers (lib/payment-link-copy) — error tokens become
//      actionable sentences; the sanity summary (seat composition, projected
//      total) formats the way Kevin reads it before sending a link.
//   B) The component itself, by SOURCE MATCH (GetPaymentLinkButton is a BeeHub
//      internal with no export to mount — the house pattern for these):
//        • renders only inside the canEditSubscription gate,
//        • success shows the url + anchor date + projected total,
//        • an error renders as translated copy, not a raw token,
//        • a location with an existing stripe_subscription_id is guarded
//          against minting a DUPLICATE subscription.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  translatePaymentLinkError,
  formatCheckoutLines,
  formatProjectedAnnual,
  PAYMENT_LINK_ERROR_COPY,
} from '@/lib/payment-link-copy'

// ── A) Helpers ────────────────────────────────────────────────
describe('translatePaymentLinkError — the tokens Kevin will actually hit', () => {
  it('translates each known token into actionable copy, never the raw token', () => {
    for (const token of [
      'location_not_active',
      'paid_through_not_future',
      'no_billable_seats',
      'seat_tier_not_priced',
    ]) {
      const copy = translatePaymentLinkError(token)
      expect(copy).toBe(PAYMENT_LINK_ERROR_COPY[token])
      expect(copy).not.toBe(token)
      expect(copy.length).toBeGreaterThan(20)
    }
  })

  it('folds the server detail into stripe_error and reassures nothing was created', () => {
    const copy = translatePaymentLinkError('stripe_error', 'card_declined')
    expect(copy).toMatch(/card_declined/)
    expect(copy).toMatch(/[Nn]othing was created/)
  })

  it('frames an unknown token as an error instead of leaking it bare', () => {
    const copy = translatePaymentLinkError('some_new_token')
    expect(copy).toMatch(/some_new_token/)
    expect(copy).not.toBe('some_new_token')
    expect(copy).toMatch(/[Cc]ouldn’t generate/)
  })

  it('handles a missing token', () => {
    expect(translatePaymentLinkError(undefined)).toMatch(/[Ss]omething went wrong/)
  })
})

describe('formatCheckoutLines — the composition Kevin sanity-checks', () => {
  it('renders "owner + 2 managers" for the KC-shaped composition', () => {
    expect(
      formatCheckoutLines([
        { tier: 'owner', quantity: 1, unit_price_annual: 550 },
        { tier: 'manager', quantity: 2, unit_price_annual: 400 },
      ]),
    ).toBe('owner + 2 managers')
  })

  it('drops zero-quantity lines and falls back for empty input', () => {
    expect(formatCheckoutLines([{ tier: 'owner', quantity: 0, unit_price_annual: 550 }])).toBe('—')
    expect(formatCheckoutLines([])).toBe('—')
    expect(formatCheckoutLines(null)).toBe('—')
  })

  it('keeps an unknown tier rather than silently dropping it', () => {
    expect(formatCheckoutLines([{ tier: 'partner', quantity: 3, unit_price_annual: 100 }])).toBe('3 partners')
  })
})

describe('formatProjectedAnnual', () => {
  it('renders cents as a thousands-grouped annual dollar figure', () => {
    expect(formatProjectedAnnual(135000)).toBe('$1,350/yr')
  })
  it('guards non-finite input to $0, never $NaN', () => {
    expect(formatProjectedAnnual(null)).toBe('$0/yr')
    expect(formatProjectedAnnual(undefined as any)).toBe('$0/yr')
  })
})

// ── B) Component source pins ───────────────────────────────────
const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

// The GetPaymentLinkButton component body.
const compStart = beehub.indexOf('function GetPaymentLinkButton')
const comp = beehub.slice(compStart, beehub.indexOf('function ConvertBillingModal', compStart))

// The LocationDetailSheet body (holds the mount + its gate).
const sheet = beehub.slice(
  beehub.indexOf('function LocationDetailSheet'),
  beehub.indexOf('function GetPaymentLinkButton'),
)

describe('GetPaymentLinkButton exists and is wired to the issue-182 route', () => {
  it('is defined and POSTs the open location to the checkout-link route', () => {
    expect(compStart).toBeGreaterThan(-1)
    expect(comp).toMatch(/\/api\/admin\/subscription-checkout-link/)
    expect(comp).toMatch(/location_id:\s*location\.id/)
  })
})

describe('renders only for canEditSubscription', () => {
  it('is mounted inside the sheet’s canEditSubscription gate', () => {
    // issue 226 step 4 — the sheet is tabbed now and opens SEVERAL
    // `canEditSubscription && (` blocks (Subscription, Careful, Billing
    // notes). The button moved into Careful. The guarantee is unchanged and
    // still worth pinning, so anchor on the LAST gate before the mount rather
    // than counting every gate in the file.
    const mountIdx = sheet.indexOf('<GetPaymentLinkButton')
    expect(mountIdx).toBeGreaterThan(-1)
    const gateIdx = sheet.lastIndexOf('canEditSubscription && (', mountIdx)
    expect(gateIdx).toBeGreaterThan(-1)
    // Nothing re-opens the gate between it and the mount, so the mount lives
    // directly under it.
    expect(sheet.slice(gateIdx + 1, mountIdx)).not.toContain('canEditSubscription && (')
    // …and that gate is the Careful block, which is where anything that can
    // charge a location belongs.
    expect(sheet.slice(gateIdx - 400, mountIdx)).toContain('Careful')
    // The component renders no gate of its own — it trusts the call-site gate.
    expect(comp).not.toMatch(/role\s*===\s*'super_admin'/)
  })
})

describe('success shows the url plus anchor date and projected total', () => {
  it('renders the returned url, anchor_date, seat composition and projected total', () => {
    // The URL is shown in a copyable field.
    expect(comp).toMatch(/value=\{result\.url\}/)
    expect(comp).toMatch(/copyUrl/)
    expect(comp).toMatch(/clipboard\.writeText/)
    // Anchor date (first invoice) is shown.
    expect(comp).toMatch(/result\.anchor_date/)
    // Seat composition + projected total via the tested helpers.
    expect(comp).toMatch(/formatCheckoutLines\(result\.lines\)/)
    expect(comp).toMatch(/formatProjectedAnnual\(result\.projected_annual_cents\)/)
  })

  it('states the ~24h expiry so Kevin knows the link is not permanent', () => {
    expect(comp).toMatch(/expires in about 24 hours/i)
    expect(comp).toMatch(/generate a new one/i)
  })
})

describe('an error string renders as readable copy', () => {
  it('routes the route error through translatePaymentLinkError, not a raw print', () => {
    expect(comp).toMatch(/translatePaymentLinkError\(data\?\.error,\s*data\?\.detail\)/)
    expect(comp).toMatch(/\{errorCopy\}/)
  })
})

describe('the duplicate-subscription guard', () => {
  it('reads the location’s stripe_subscription_id up front', () => {
    expect(comp).toMatch(/\/api\/locations\/\$\{location\.id\}\/subscription/)
    expect(comp).toMatch(/stripe_subscription_id/)
  })

  it('gates minting behind an explicit confirm when a subscription exists or is unverified', () => {
    // needsConfirm blocks the direct generate() path.
    expect(comp).toMatch(/needsConfirm\s*=\s*!!existingSubId\s*\|\|\s*metaError/)
    expect(comp).toMatch(/if\s*\(needsConfirm\)\s*\{\s*setConfirming\(true\);\s*return\s*\}/)
    // The confirm panel warns about a duplicate before the danger action.
    expect(comp).toMatch(/duplicate subscription/i)
    expect(comp).toMatch(/Generate anyway/)
  })
})
