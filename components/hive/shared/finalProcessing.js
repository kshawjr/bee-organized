// components/hive/shared/finalProcessing.js
// ─────────────────────────────────────────────────────────────
// WHY FINAL PROCESSING IS WAITING (issue 119).
//
// Nothing is broken. Final processing is a deliberate waiting room: the
// LIVE stage derivation passes closeWonOnDone false (lib/engagements.ts),
// so a done-and-paid deal RESTS here instead of auto-closing, and the
// panel's "Ready to close — Mark won" button + the close-won wizard are
// where satisfaction / review / re-engage / confetti actually happen.
// Only the bulk import auto-closes, so owners never click through years
// of history.
//
// The rules were right and the screen never said so, so a pile of
// waiting deals read as a pile of broken ones. THIS FILE IS THE WORDING
// — one source, so the panel and the list can never explain the same
// engagement two different ways.
//
// THREE CASES, and they are genuinely different situations. They must
// never collapse into one sentence:
//   · paid           → everything settled; Mark won already shows
//   · never_invoiced → no invoice was ever raised; the $0 close, which
//                      Mark won already offers (invoicesSettled counts
//                      an empty list as settled)
//   · owing          → Bee Hub still shows money outstanding, so the
//                      ordinary button is correctly absent; the
//                      deliberate second action is offered instead
//
// The case keys off invoicesSettled — THE SAME predicate the panel's
// canCloseWon gate reads — so the sentence "the button is / is not
// here" is always true of the button actually rendered beside it.
// (deriveStatusChip's Final Processing chip keys off the engagement's
// balance_owing rollup; that drives a colour, not a claim about a
// button, so the two are allowed to differ.)
//
// PURE: no React, no fetch, no tokens. Safe in any bundle.
// ─────────────────────────────────────────────────────────────

import { invoicesSettled, WON_OVER_BALANCE } from './closeEngagement'

export { WON_OVER_BALANCE }

export const FINAL_PROCESSING = 'Final Processing'

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()

// What Bee Hub still shows as outstanding, summed from the invoices the
// gate just read — so the number in the sentence and the refusal of the
// button come from the same rows. A paid invoice contributes nothing
// even if a stale balance_owing lingers on it (that is exactly what
// invoicesSettled forgives).
export function owedOnInvoices(invoices = []) {
  return (invoices || []).reduce(
    (sum, i) => sum + (i?.status === 'paid' ? 0 : Number(i?.balance_owing) || 0),
    0,
  )
}

// 'paid' | 'never_invoiced' | 'owing' — or null for any stage that is
// not Final Processing, which is how every caller renders nothing
// elsewhere without its own stage check.
export function finalProcessingCase(engagement, invoices = []) {
  if (!engagement || engagement.stage !== FINAL_PROCESSING) return null
  const list = invoices || []
  if (!invoicesSettled(list)) return 'owing'
  return list.length === 0 ? 'never_invoiced' : 'paid'
}

// The shared opening line. Owners wrote in saying these deals were
// "stuck", so the first thing the sentence does is say they are not.
export const FINAL_PROCESSING_LEAD =
  'Nothing is stuck. Final processing is where a finished deal waits for you to close it.'

// The per-case explanation shown on the engagement panel. `title` is the
// small heading, `body` the sentence. Written for a franchise owner:
// no stage ranks, no predicates, no "reconciliation".
export function finalProcessingExplainer(caseKey, invoices = []) {
  if (caseKey === 'paid') {
    return {
      title: 'Waiting on you',
      body: 'The work is finished and every invoice is paid. Nothing else is coming in on this one — press Mark won and we’ll ask a couple of quick questions on the way out.',
    }
  }
  if (caseKey === 'never_invoiced') {
    return {
      title: 'Waiting on you',
      body: 'The work is finished and no invoice was ever raised for it. If that’s right — a freebie, a warranty call, a job that never got billed — press Mark won to close it at $0.',
    }
  }
  if (caseKey === 'owing') {
    const owed = owedOnInvoices(invoices)
    return {
      title: 'Waiting on the money',
      body:
        `Bee Hub still shows ${money(owed)} owing on this one, so the usual Mark won button isn’t here. ` +
        'Settle it in Jobber and the button comes back. If it has already been paid and Bee Hub hasn’t caught up, you can close it here instead — we’ll ask you to say why.',
    }
  }
  return null
}

// The quiet second action on the owing case. DELIBERATELY not the Mark
// won button promoted: someone closing forty settled deals must not
// close an owing one by muscle memory.
export const OWING_CLOSE_ACTION = 'Close it anyway — it’s settled in Jobber'

// What the wizard asks for, and why it is not optional. Kevin's ruling:
// a close over an outstanding balance records why, and that reason shows
// on the engagement afterwards.
export const OWING_REASON_LABEL = 'Why are you closing this with money still showing?'
export const OWING_REASON_PLACEHOLDER = 'e.g. Paid cash on the day, Jobber never updated'
export const OWING_REASON_HELP =
  'This is saved on the engagement, so anyone looking at it later can see why it was closed. We need it before you can finish.'
export const OWING_REASON_MISSING = 'Tell us why first — this one can’t be closed without a reason.'

// The outcome line on an already-closed engagement (ClosedSummary).
// Distinguishable from an ordinary Closed Won on sight and in the data:
// the reason column carries WON_OVER_BALANCE, never plain 'won'.
// Sits after the "Closed won ·" verdict ClosedSummary already renders,
// so it must NOT repeat the words "closed won" — the line reads
// "Closed won · balance still showing · 11 September 2026".
export const OWING_CLOSED_LABEL = 'balance still showing'
export function owingClosedLine(engagement) {
  const owed = Number(engagement?.balance_owing) || 0
  // The balance is NOT zeroed by the close — the number stays true — so
  // read it live. Once it is genuinely settled in Jobber there is no
  // figure left to quote and the marker alone carries the history.
  return owed > 0
    ? `Bee Hub still shows ${money(owed)} owing.`
    : 'Bee Hub showed money owing when this was closed.'
}

// The note under the Final processing band in the list. One line per
// case PRESENT, with its count — the three situations stay three
// sentences here too, and a case with nothing in it says nothing.
export function finalProcessingGroupLines(rows = []) {
  const counts = { paid: 0, never_invoiced: 0, owing: 0 }
  for (const e of rows || []) {
    const k = finalProcessingCase(e, e?.invoices || [])
    if (k) counts[k] += 1
  }
  const plural = (n, one, many) => (n === 1 ? one : many)
  const lines = []
  if (counts.paid) {
    lines.push(`${counts.paid} ${plural(counts.paid, 'is', 'are')} done and fully paid. Open ${plural(counts.paid, 'it', 'one')} and press Mark won.`)
  }
  if (counts.never_invoiced) {
    lines.push(`${counts.never_invoiced} ${plural(counts.never_invoiced, 'was', 'were')} never invoiced. Close ${plural(counts.never_invoiced, 'it', 'those')} at $0 if that’s right.`)
  }
  if (counts.owing) {
    lines.push(`${counts.owing} still ${plural(counts.owing, 'shows', 'show')} money owing. Open ${plural(counts.owing, 'it', 'one')} to see the amount and decide.`)
  }
  return lines
}
