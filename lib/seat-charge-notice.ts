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
//
// issue 225 — WHICH FIGURES ARE PROMISES AND WHICH ARE FORECASTS.
// One case names a number that Stripe, not this codebase, ultimately
// computes: the `charge` case, where our whole-day proration against
// paid_through_date is settled per-second by Stripe against its own
// subscription period. That figure is hedged ("about"), in both this
// module's functions. Nothing else is: an invoiced amount is one WE bill,
// a $0 tier is exactly free, charge_zero_today is exactly nothing today,
// charge_unpriced names no figure at all, and the annual line is the
// catalog rate rather than a proration. Hedging those would be its own
// small dishonesty — a hedge on an exact number reads as doubt about a
// fact we actually know.
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

    // issue 225 — "ABOUT", BECAUSE STRIPE DOES THIS SUM, NOT US.
    //
    // We work the figure out in whole days against the location's own
    // paid_through_date. Stripe works it out to the SECOND against its own
    // subscription period. The two agree to within cents, never exactly: a
    // screen that says $372.60 can produce an invoice reading $372.19.
    //
    // Kevin's call is NOT to close that gap — an upcoming-invoice call on
    // every tier selection is a round trip we would pay on every keystroke,
    // it has no answer at all on the 32-of-55 locations with no
    // subscription, and the disagreement is pennies. So the words carry it
    // instead: this is the one case where the number on screen is a forecast
    // of somebody else's arithmetic, and it says so rather than promising an
    // amount we do not control.
    //
    // ONLY THIS CASE, AND ONLY THE TODAY FIGURE. The invoiced case names an
    // amount WE will bill, so our number is the number; a $0 tier is exactly
    // free; charge_zero_today is exactly nothing; charge_unpriced names no
    // figure to hedge. And the annual figure below is the catalog price, not
    // a proration — nothing prorates it, so nothing softens it.
    const amount = money(quote.totalCents)
    return {
      kind: 'charge',
      tone: 'charge',
      heading: `You'll be charged about ${amount} today`,
      body:
        (renewal
          ? `This is for the part of your year that's left, up to your renewal ` +
            `on ${renewal}. It goes on the card you already have on file. `
          : `This is for the part of your year that's left. It goes on the ` +
            `card you already have on file. `) +
        `The exact amount is settled when the payment goes through, so it may ` +
        `come out a few cents either side of ${amount} — your receipt shows ` +
        `what was actually taken. After that, this ${seatWord} is included in ` +
        `your usual renewal.`,
      // The button is the last thing read before committing, which makes it
      // the worst place to state a figure more precisely than we know it.
      confirmLabel: `Confirm & Pay about ${amount}`,
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

// ─────────────────────────────────────────────────────────────
// issue 224 — THE SAME SIX ANSWERS, ONE STEP EARLIER.
//
// WHAT KEVIN SAW: the tier picker offered "Hive Manager — $400/yr" and then
// said underneath, in effect, "that isn't what you'll pay; we'll tell you the
// real number on the next screen." Asking someone to choose between tiers
// while withholding the price of each is a strange thing to do, and the fact
// that the withheld number was correct doesn't redeem it.
//
// So the picker names both figures: what leaves the account today, and what
// the seat costs every year from the renewal onward. Both come from the
// server's quote (see lib/seat-cost) — the picker computes neither, which is
// the rule issue 216 fixed and issue 217 closed.
//
// WHY THIS IS A SEPARATE FUNCTION FROM seatChargeNotice. Same six outcomes,
// different job. seatChargeNotice is the last thing read before committing:
// it explains, in sentences, what confirming will do. This is a price label
// on a choice — two short lines beside a tier the owner has not committed to
// — and the pressure on it is that a glance must land on the right number.
// Writing it as a "shorter notice" would mean one function with a verbosity
// flag and six cases that quietly drift toward each other, which is the
// collapse issue 223 exists to prevent. The taxonomy is shared; the words are
// not.
//
// EVERY CASE ANSWERS BOTH QUESTIONS, INCLUDING THE ONES WHERE THE ANSWER IS
// "NOTHING" OR "WE CAN'T SAY YET". A blank second line would read as free.
// ─────────────────────────────────────────────────────────────

export type SeatPickerQuote = SeatChargeQuote & {
  // issue 224 — whole cents added to the yearly bill at renewal, from the
  // server's `cost.annual_total_cents`. null when a rate is unknown; that is
  // NOT the same as zero and must never render as free.
  annualTotalCents: number | null
}

export type SeatPickerPrice = {
  // Same taxonomy as the confirm notice, so the two screens cannot classify
  // one purchase differently.
  kind: SeatChargeNoticeKind
  tone: 'charge' | 'free' | 'later'
  // The prominent line: what happens to money TODAY.
  today: string
  // The quiet line under it: what it costs each year afterwards. Always says
  // something.
  renews: string
}

// Annual rates are whole dollars (tier_prices.price_annual is a dollar
// integer), so cents are noise on this line — but formatCurrency's 'never'
// mode ROUNDS UP, so a non-whole figure would be overstated. Only drop the
// cents when there are none to drop.
const wholeMoney = (cents: number): string =>
  cents % 100 === 0
    ? formatCurrency(cents / 100, { showCents: 'never' })
    : formatCurrency(cents / 100, { showCents: 'always' })

// The price label for one tier the owner is considering.
export function seatPickerPrice(args: {
  quote: SeatPickerQuote
  preview: SeatChargePreview
}): SeatPickerPrice {
  const { quote, preview } = args
  const renewal = renewalPhrase(quote.renewalDate)
  const annual = quote.annualTotalCents === null ? null : wholeMoney(quote.annualTotalCents)

  // The yearly half, shared by every case that has a yearly cost. "Then"
  // carries the whole contrast with the line above it — this is the number
  // that is NOT being charged now.
  const renewsAnnually = annual
    ? renewal
      ? `Then ${annual} a year, starting ${renewal}`
      : `Then ${annual} a year at your renewal`
    : renewal
      ? `Then the full year's price from ${renewal}`
      : `Then the full year's price at each renewal`

  if (preview.willCharge) {
    // No renewal date of our own to work from, so there is no figure for
    // today — issue 217 refuses to invent an anchor. The yearly price is
    // still perfectly knowable, so only the first line goes quiet.
    if (quote.totalCents === null) {
      return {
        kind: 'charge_unpriced',
        tone: 'charge',
        today: 'Amount worked out when you pay',
        renews: renewsAnnually,
      }
    }

    // A paid tier added on (or effectively on) the renewal date: there is no
    // part of this year left to pay for. Not free — it is on the plan from
    // the renewal onward, which is what the second line is for.
    if (quote.totalCents === 0) {
      return {
        kind: 'charge_zero_today',
        tone: 'later',
        today: 'Nothing to pay today',
        renews: renewsAnnually,
      }
    }

    // issue 225 — the same hedge as the confirm notice, for the same reason:
    // Stripe prorates to the second against its own period and we prorate in
    // whole days against paid_through_date, so this figure is a close forecast
    // rather than a quoted price. `renews` is untouched — the annual figure is
    // the catalog rate, which nothing prorates and nothing rounds.
    return {
      kind: 'charge',
      tone: 'charge',
      today: `About ${money(quote.totalCents)} today`,
      renews: renewsAnnually,
    }
  }

  switch (preview.reason) {
    // The only genuinely free case: a $0 tier. Free now AND at renewal, and
    // the second line has to say the second half or this reads like every
    // other "nothing today".
    case 'zero_rate':
      return {
        kind: 'free_tier',
        tone: 'free',
        today: 'Free',
        renews: 'Free at renewal too — it adds nothing to your yearly bill',
      }

    // Corporate / prepaid. Nothing is owed by this owner in either column,
    // which is different from the seat being free.
    case 'non_paying':
      return {
        kind: 'covered',
        tone: 'free',
        today: 'Nothing to pay',
        renews: 'Your account is billed separately, not by card',
      }

    // Owed but not collectable by card. NAMES the amount — this is the
    // 32-of-55 no-subscription case, and a blank or cheerful line here is
    // the original issue 223 lie one screen earlier.
    default:
      return {
        kind: 'invoiced',
        tone: 'later',
        today:
          quote.totalCents !== null && quote.totalCents > 0
            ? `${money(quote.totalCents)} — we'll invoice you`
            : "We'll invoice you for this",
        renews: renewsAnnually,
      }
  }
}
