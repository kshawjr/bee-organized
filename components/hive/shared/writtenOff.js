// components/hive/shared/writtenOff.js
// ─────────────────────────────────────────────────────────────
// THE WRITTEN-OFF CLOSE (2026-09-27, Kevin's ruling).
//
// Bad debt is a real outcome in this business, and it is neither a win nor
// a loss. A deal where the work was done and the money is never coming must
// not close as Won — that would say the owner was paid when he was not — and
// "lost" says the client went elsewhere, which is not what happened either.
//
// HOW IT IS STORED. stage 'Closed Lost' + closed_reason WRITTEN_OFF, with the
// amount in engagements.written_off_amount. Stored on the Lost side on
// purpose (Kevin chose this over a third stage): every "is this deal closed?"
// check in the app already treats Closed Lost as closed, and nothing that
// totals revenue reads Closed Lost, so a written-off deal is closed
// everywhere and counted as revenue nowhere BY CONSTRUCTION. What makes it
// its own outcome is the display: every screen that names a closed deal asks
// closedOutcome() / engagementStageLabel() and says "Written off", never
// "lost", and the lost counts leave it out.
//
// NOT the owing override (WON_OVER_BALANCE). That one means "it is settled
// outside Jobber — we were paid"; it closes Won. This one means "we will
// never get this money"; it closes written off. Different verb, different
// icon, different outcome, different wizard.
//
// PURE: no React, no fetch. Imported by the PATCH route (server) and the
// panel/wizard (client), so the value and the amount rule exist once.
// ─────────────────────────────────────────────────────────────

import { stageDisplayLabel } from './stageConfig'
import { isDeletedInvoice } from './invoiceDeleted'

export const WRITTEN_OFF = 'written_off'
export const WRITTEN_OFF_LABEL = 'Written off'

const CLOSED_LOST = 'Closed Lost'
const CLOSED_WON = 'Closed Won'

export function isWrittenOff(e) {
  return !!e && e.stage === CLOSED_LOST && e.closed_reason === WRITTEN_OFF
}

// 'won' | 'written_off' | 'lost' | null (open).
export function closedOutcome(e) {
  if (!e) return null
  if (e.stage === CLOSED_WON) return 'won'
  if (e.stage === CLOSED_LOST) return e.closed_reason === WRITTEN_OFF ? 'written_off' : 'lost'
  return null
}

// The stage label for a whole engagement row — the stage's own label,
// except a written-off deal, which never reads "Closed lost".
export function engagementStageLabel(e) {
  if (isWrittenOff(e)) return WRITTEN_OFF_LABEL
  return stageDisplayLabel(e?.stage)
}

// A written-off engagement's chip style key. Gray, like every closed deal —
// the word carries the meaning, not an alarm colour.
export const WRITTEN_OFF_STYLE_KEY = 'gray'

const num = (v) => (v == null ? 0 : Number(v) || 0)

/**
 * The amount being written off, from the engagement's invoices:
 *   · a paid invoice contributes nothing;
 *   · a BAD-DEBT invoice contributes what was never received — its total
 *     less what did come in (paid_amount carries money received on an
 *     unpaid invoice once Jobber's amounts are read). Jobber shows its
 *     balance as $0 after the write-off, so the balance cannot be used;
 *   · any other unpaid invoice contributes what it still owes — the
 *     balance the owner is giving up on (a voided invoice owes $0 and
 *     adds nothing).
 * Never negative per invoice: a credit note is not a write-off.
 */
export function writtenOffAmountFromInvoices(invoices = []) {
  let total = 0
  for (const i of invoices || []) {
    // paid, or deleted in Jobber (invoiceDeleted.js): nothing to write off
    if (!i || i.status === 'paid' || isDeletedInvoice(i)) continue
    if (i.status === 'bad_debt') {
      total += Math.max(0, num(i.total) - num(i.paid_amount))
    } else {
      const owed = i.balance_owing != null ? num(i.balance_owing) : num(i.total) - num(i.paid_amount)
      total += Math.max(0, owed)
    }
  }
  return Math.round(total * 100) / 100
}

/** Jobber has at least one of these invoices marked bad debt. */
export function hasBadDebt(invoices = []) {
  return (invoices || []).some(i => i?.status === 'bad_debt')
}

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()

// ── wording (one source for panel, menu, wizard and closed line) ──

// The control. Starts with a different verb from the override ("Close it
// anyway — it's settled in Jobber") so the two can't be read as one.
export const WRITE_OFF_ACTION = 'Write it off — this money isn’t coming'

// Shown under the owing explainer, beside the override, so an owner who
// is NOT going to be paid has somewhere to go that isn't "close it anyway".
export const WRITE_OFF_HINT =
  'If this money is never coming, write it off instead. That closes the deal as Written off — not a win, and it never counts as revenue.'

export const WRITE_OFF_TITLE = 'Write this off'
export function writeOffSummary(amount) {
  return `You’re writing off ${money(amount)}. This closes the deal as Written off — not won, not lost. It never counts as a win or as revenue, and the ${money(amount)} stays on the record so you can see it later.`
}
export const WRITE_OFF_REASON_LABEL = 'Why is this money not coming?'
export const WRITE_OFF_REASON_PLACEHOLDER = 'e.g. Client stopped answering after the job; not worth sending to collections'
export const WRITE_OFF_REASON_MISSING = 'Tell us why first — a write-off can’t be saved without a reason.'
export function writeOffConfirmLabel(amount) {
  return `Write off ${money(amount)}`
}

// Final Processing, when Jobber already has the money as bad debt: there
// is nothing left to collect and nothing was paid, so neither Mark won
// nor the override is right.
export function writtenOffInJobberExplainer(amount) {
  return {
    title: 'Written off in Jobber',
    body: `Jobber has ${money(amount)} of this marked as bad debt, so there’s nothing left to collect — and it wasn’t paid, so it isn’t a win. Close it here as Written off.`,
  }
}

// The closed outcome line (ClosedSummary): "Written off · $7,694 · 24 September 2026".
export function writtenOffAmountText(e) {
  const amt = num(e?.written_off_amount)
  return amt > 0 ? money(amt) : null
}
