// issue 218 — the dead Payment-Link branch in the owner seat modals.
//
// Bee Hub had TWO Stripe mechanisms sketched in the client. Only one was
// ever wired:
//
//   LIVE   — Checkout Sessions. /api/locations/[id]/checkout mints a
//            session; OnboardingScreen puts its URL in serverPayUrl and
//            hands it to PaymentConfirmStep + StripeCheckoutWait. This is
//            how a location actually pays to activate.
//   DEAD   — Payment Links. A per-tier tier_prices.payment_link_url, read
//            through TierPricesContext.getTierLink, run through
//            buildStripePayUrl. AddSeatsModal and InviteTeamMemberModal
//            each built a `stripePayUrl` from it, with a 402 + pay_url
//            response as the fallback trigger.
//
// The dead branch was unreachable from BOTH ends, which is why it is
// deleted rather than wired:
//
//   • no tier carries a payment_link_url (all four rows NULL in
//     production), so buildStripePayUrl(...) returns null; and
//   • getStripeRequirement — the only thing that builds a 402 pay_url
//     response — has no callers, so no route can supply the fallback.
//
// Wiring it would have meant maintaining a second way to charge for the
// same seat. These tests pin the delete: the seat modals carry no
// Payment-Link branch, and the LIVE onboarding path is untouched.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
const TEST_FILE = 'lib/beta-seat-modal-stripe-branch-218.test.ts'

// Every .ts/.tsx/.js/.jsx under the given roots.
function sourceFiles(roots: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full)
    }
  }
  for (const root of roots) walk(join(process.cwd(), root))
  return out
}

// Slice a top-level component body: from its declaration to the next
// declaration at column 0. Coarse but stable — these are all top-level.
function sliceComponent(name: string): string {
  const start = SRC.search(new RegExp(`^(export )?function ${name}\\(`, 'm'))
  expect(start, `${name} should exist in BeeHub.jsx`).toBeGreaterThan(-1)
  const rest = SRC.slice(start + 1)
  const nextRel = rest.search(/^(export default |export )?function [A-Za-z]/m)
  return nextRel === -1 ? rest : rest.slice(0, nextRel)
}

// Comments in these components explain WHY the branch was deleted, and so
// name the very symbols being asserted absent. Match against code only.
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const SEAT_MODALS = ['AddSeatsModal', 'InviteTeamMemberModal'] as const

// ── A) the seat modals carry no Payment-Link branch ───────────────────
describe('issue 218 — seat modals have no dead Stripe branch', () => {
  // Every symbol the branch was built from.
  const REMOVED: Array<[string, RegExp]> = [
    ['stripePayUrl binding', /const stripePayUrl\s*=/],
    ['stripePayUrl use', /\bstripePayUrl\s*(\?|\}|\))/],
    ['serverPayUrl state', /setServerPayUrl|\bserverPayUrl\b/],
    ['402 pay_url handler', /402\s*&&|pay_url/],
    ['buildStripePayUrl call', /buildStripePayUrl\s*\(/],
    ['getTierLink call', /getTierLink/],
    ['beginStripeWait', /beginStripeWait/],
    ['finishStripePurchase', /finishStripePurchase/],
    ['finishStripeBuy', /finishStripeBuy/],
    ['stripeWait step', /'stripeWait'|"stripeWait"/],
    ['StripeCheckoutWait render', /<StripeCheckoutWait/],
    ['baselineRef', /baselineRef/],
  ]

  for (const modal of SEAT_MODALS) {
    const body = codeOnly(sliceComponent(modal))
    for (const [label, pattern] of REMOVED) {
      it(`${modal} no longer contains ${label}`, () => {
        expect(pattern.test(body), `${modal} still references ${label}`).toBe(false)
      })
    }

    it(`${modal} still renders PaymentConfirmStep for the record path`, () => {
      expect(body).toMatch(/<PaymentConfirmStep/)
    })

    it(`${modal} passes PaymentConfirmStep no Stripe props`, () => {
      expect(body).not.toMatch(/stripePayUrl=|onStripeOpen=/)
    })
  }

  it('AddSeatsModal always shows the quantity picker (it was hidden on the Stripe path)', () => {
    const body = codeOnly(sliceComponent('AddSeatsModal'))
    expect(body).toMatch(/Cap 10 per request/)
    expect(body).not.toMatch(/pick the number of seats on the Stripe checkout page/i)
  })

  // The removed Stripe branch swapped the confirm step's quote to the
  // un-prorated ANNUAL price via a `stripePayUrl ? annual : prorated`
  // ternary. issue 223 then moved the figure itself to the server, so the
  // local totals these once named are gone — but the property is the same
  // one, and stronger: there is no branch, and the amount is the quote's.
  for (const modal of SEAT_MODALS) {
    it(`${modal} passes one unconditional total, taken from the server quote`, () => {
      const body = codeOnly(sliceComponent(modal))
      expect(body).toMatch(/total=\{quoteView\.totalDollars \?\? 0\}/)
      expect(body).not.toMatch(/total=\{[^}]*\?[^}]*:/)
    })
  }
})

// ── B) the LIVE onboarding Checkout-Session path is untouched ─────────
describe('issue 218 — onboarding Stripe checkout stays live', () => {
  const onboarding = sliceComponent('OnboardingScreen')

  it('still mints a checkout session and stores its URL', () => {
    expect(onboarding).toMatch(/\/checkout/)
    expect(onboarding).toMatch(/setServerPayUrl\(j\.url\)/)
  })

  it('still hands a pay URL to PaymentConfirmStep', () => {
    expect(onboarding).toMatch(/stripePayUrl=\{showStripe \? ownerStripeUrl : null\}/)
  })

  it('still renders StripeCheckoutWait on the stripe_wait step', () => {
    expect(onboarding).toMatch(/<StripeCheckoutWait/)
    expect(onboarding).toMatch(/payStep==='stripe_wait'/)
  })
})

// ── C) the shared components survive — they are shared, not duplicated ─
describe('issue 218 — shared pay components are defined once and kept', () => {
  it('PaymentConfirmStep and StripeCheckoutWait each have exactly one definition', () => {
    const defs = (re: RegExp) => (SRC.match(re) || []).length
    expect(defs(/^function PaymentConfirmStep\(/gm)).toBe(1)
    expect(defs(/^function StripeCheckoutWait\(/gm)).toBe(1)
  })

  it('StripeCheckoutWait still has a caller — onboarding — so it is not dead', () => {
    expect((SRC.match(/<StripeCheckoutWait/g) || []).length).toBe(1)
  })

  it('PaymentConfirmStep keeps its stripePayUrl branch for onboarding', () => {
    const body = sliceComponent('PaymentConfirmStep')
    expect(body).toMatch(/stripePayUrl \? \(/)
    expect(body).toMatch(/Pay with Stripe/)
  })
})

// ── D) the premise: nothing produces the 402 + pay_url response ────────
describe('issue 218 — no route supplies the 402 pay_url fallback', () => {
  const activation = readFileSync(join(process.cwd(), 'lib/subscription-activation.ts'), 'utf8')

  it('getStripeRequirement is still the only pay_url producer', () => {
    expect(activation).toMatch(/export async function getStripeRequirement/)
  })

  it('getStripeRequirement has no callers — a caller would revive the dead branch', () => {
    // If this fails, some route began returning 402 + pay_url and the
    // client half deleted in issue 218 has to come back (or that route is
    // itself wrong — Payment Links are not how Bee Hub charges).
    const callers = sourceFiles(['app', 'lib', 'components'])
      .filter(f => !f.endsWith('lib/subscription-activation.ts'))
      .filter(f => !f.endsWith(TEST_FILE))
      .filter(f => readFileSync(f, 'utf8').includes('getStripeRequirement'))
    expect(callers).toEqual([])
    // Exactly one occurrence in its own file: the definition, no self-call.
    expect((activation.match(/getStripeRequirement/g) || []).length).toBe(1)
  })
})
