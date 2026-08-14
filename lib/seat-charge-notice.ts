// lib/seat-charge-notice.ts
// ─────────────────────────────────────────────────────────────
// issue 223 — SAY WHAT WILL ACTUALLY HAPPEN, AT THE MOMENT OF CONFIRMING.
//
// THE BUG THIS EXISTS TO KILL: both owner seat modals rendered one fixed
// notice — "Online payment isn't set up yet, so no card will be charged.
// Confirming records this purchase and Bee Organized will invoice you for it
// separately." That was true when it was written. Since issues 161 and 219
// it is false: /api/seats and /api/seats/buy-and-invite both charge, as
// lines on the location's Stripe subscription. So an owner was told a seat
// was free, confirmed, and was billed for it.
//
// Every other billing defect this week was a ledger disagreement — two
// numbers that should have matched. This one is a promise made to a person
// and then broken, which is worse, and it is why the fix is not "delete the
// notice" but "make the notice true in every case".
//
// FOUR OUTCOMES ARE GENUINELY FREE OR DEFERRED, AND THEY ARE NOT THE SAME
// SENTENCE. Collapsing them back into one message is how this bug happened:
//
//   zero_rate         a $0 tier. Watcher and Worker are price_annual 0, so
//                     the seat really does cost nothing, now and at renewal.
//                     "No charge" here is honest.
//   no_subscription   32 of 55 locations. The seat is created and its cost
//                     recorded, but no subscription exists to bill it on.
//                     Money IS owed. Saying "no charge" here would be the
//                     original lie wearing a different hat, so this one says
//                     it will be invoiced.
//   non_paying        corporate / prepaid. Someone else is paying; this
//                     owner will not see a bill at all.
//   stripe_unconfigured / no_price
//                     a misconfiguration on our side. The seat is owed for
//                     and will be invoiced — it must never read as free.
//
// WHAT THIS MODULE IS NOT. It does not decide anything. The figure comes
// from lib/seat-cost's quote and the outcome from lib/seat-stripe-sync's
// preview, both server-side; this turns that verdict into sentences. Keeping
// the words here rather than inline in the modals means the copy for a case
// can be read, tested, and changed in one place, and means both modals
// cannot drift into saying different things about the same outcome.
//
// AUDIENCE. Owners are 45-65 and non-technical. No "prorated line item", no
// "subscription quantity", no "proration" — the idea is expressed as the
// part of the year that is left before renewal, which is what it means.
// ─────────────────────────────────────────────────────────────

import { formatCurrency, formatRenewalDate, parsePaidThroughDate } from './subscription-math'

// The server's answer to "will this charge, and if not why not". Mirrors the
// `billing` block of GET /api/seats/quote.
export type SeatChargePreview = {
  willCharge: boolean
  reason:
    | 'zero_rate'
    | 'no_subscription'
    | 'non_paying'
    | 'stripe_unconfigured'
    | 'no_price'
    | 'stripe_error'
    | null
}

export type SeatChargeQuote = {
  // Whole cents for the entire purchase. null when the server could not
  // price it — issue 217's no-anchor / unpriced-tier rule.
  totalCents: number | null
  // 'YYYY-MM-DD' — the location's own paid_through_date.
  renewalDate: string | null
}

export type SeatChargeNoticeKind =
  | 'charge'
  | 'charge_unpriced'
  | 'charge_zero_today'
  | 'free_tier'
  | 'covered'
  | 'invoiced'

export type SeatChargeNotice = {
  kind: SeatChargeNoticeKind
  // 'charge' = money moves now; 'free' = nothing is ever owed; 'later' =
  // owed but not collected here. Drives the colour, never the wording.
  tone: 'charge' | 'free' | 'later'
  heading: string
  body: string
  // What the confirm button should promise. Never a bare "Confirm" when
  // money moves — the button is the last thing read before committing.
  confirmLabel: string
}

const renewalPhrase = (renewalDate: string | null): string | null => {
  const parsed = parsePaidThroughDate(renewalDate)
  return parsed ? formatRenewalDate(parsed) : null
}

// showCents:'always'. formatCurrency's 'auto' mode rounds anything over $100
// UP to whole dollars, which is fine for an estimate on a pricing card and
// wrong here — a screen that says "$220" before charging $219.45 has told
// the owner a number they will not see on their statement.
const money = (cents: number): string => formatCurrency(cents / 100, { showCents: 'always' })

// Build the notice for one pending seat purchase.
//
// `seatWord` is the noun to use for what is being bought ("seat" / "2 seats"),
// supplied by the caller because only it knows the quantity and tier name.
export function seatChargeNotice(args: {
  quote: SeatChargeQuote
  preview: SeatChargePreview
  seatWord: string
}): SeatChargeNotice {
  const { quote, preview, seatWord } = args
  const renewal = renewalPhrase(quote.renewalDate)

  // ── Money moves now ────────────────────────────────────────
  if (preview.willCharge) {
    // The figure is unknown: the location has no renewal date of its own to
    // work from (issue 217 refuses to invent one). It is still charged —
    // Stripe bills against the real subscription period, which is not a
    // guess — so this must say a charge is coming without naming a figure
    // it does not have.
    if (quote.totalCents === null) {
      return {
        kind: 'charge_unpriced',
        tone: 'charge',
        heading: 'Your card will be charged',
        body:
          `Adding this ${seatWord} will charge the card you have on file. ` +
          `You'll pay for the part of your year that's left, so the exact ` +
          `amount is worked out when the payment goes through — it'll be on ` +
          `your receipt.`,
        confirmLabel: 'Confirm & Add',
      }
    }

    // Priced at exactly nothing today: a paid tier added on (or effectively
    // on) the renewal date. Nothing is collected now, but the seat is on the
    // plan and will be paid for from the renewal onward — "free" would be
    // wrong in a way the owner would discover on their next invoice.
    if (quote.totalCents === 0) {
      return {
        kind: 'charge_zero_today',
        tone: 'later',
        heading: 'Nothing to pay today',
        body: renewal
          ? `Your renewal on ${renewal} is so close that there's nothing left ` +
            `of this year to pay for, so your card won't be charged now. This ` +
            `${seatWord} is part of your plan from ${renewal} onward and will ` +
            `be included in that renewal.`
          : `There's nothing left of this year to pay for, so your card won't ` +
            `be charged now. This ${seatWord} is part of your plan and will be ` +
            `included in your next renewal.`,
        confirmLabel: 'Confirm & Add',
      }
    }

    const amount = money(quote.totalCents)
    return {
      kind: 'charge',
      tone: 'charge',
      heading: `You'll be charged ${amount} today`,
      body: renewal
        ? `This is for the part of your year that's left, up to your renewal ` +
          `on ${renewal}. It goes on the card you already have on file, and ` +
          `after that this ${seatWord} is included in your usual renewal.`
        : `This is for the part of your year that's left. It goes on the card ` +
          `you already have on file, and after that this ${seatWord} is ` +
          `included in your usual renewal.`,
      confirmLabel: `Confirm & Pay ${amount}`,
    }
  }

  // ── Nothing moves ──────────────────────────────────────────
  switch (preview.reason) {
    // Honestly free: the tier is priced at $0. Not now, not at renewal.
    case 'zero_rate':
      return {
        kind: 'free_tier',
        tone: 'free',
        heading: 'This one is free',
        body:
          `This ${seatWord} is included in your plan at no cost, so your card ` +
          `won't be charged now and it won't add anything to your renewal.`,
        confirmLabel: 'Confirm & Add',
      }

    // Somebody else pays: corporate or prepaid. The owner sees no bill at
    // all — which is different from the seat being free.
    case 'non_paying':
      return {
        kind: 'covered',
        tone: 'free',
        heading: 'Covered by your plan',
        body:
          `Your account is billed separately, not by card, so nothing is ` +
          `charged here. This ${seatWord} is added to your team right away.`,
        confirmLabel: 'Confirm & Add',
      }

    // Owed, but not collectable here. no_subscription is the 32-of-55 case;
    // stripe_unconfigured / no_price / stripe_error are misconfigurations on
    // our side. All four owe money, so all four say invoiced — never free.
    default:
      return {
        kind: 'invoiced',
        tone: 'later',
        heading: 'We’ll invoice you for this',
        body: (quote.totalCents !== null && quote.totalCents > 0
          ? `This ${seatWord} costs ${money(quote.totalCents)} for the part of ` +
            `your year that's left${renewal ? `, up to your renewal on ${renewal}` : ''}. `
          : `This ${seatWord} is added to your team right away. `) +
          `There's no card on file to charge, so nothing is taken now — Bee ` +
          `Organized will send you an invoice for it.`,
        confirmLabel: 'Confirm & Add',
      }
  }
}
