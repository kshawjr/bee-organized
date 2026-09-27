// components/hive/shared/invoiceDeleted.js
// ─────────────────────────────────────────────────────────────
// INVOICES DELETED IN JOBBER (2026-09-27).
//
// Jobber tells us when an invoice is deleted (INVOICE_DESTROY). We used to
// clear a link on the person and leave the invoice row untouched — unpaid,
// full balance — so 13 deleted invoices showed $26,008 owed, most of them
// replaced in Jobber by an invoice that was then paid. Now the row is marked
// status 'deleted' (never removed: it is the record that a bill once
// existed), it owes nothing, and every screen leaves it out.
//
// THE ONE EXCEPTION — A DELETED INVOICE THAT WAS PAID KEEPS ITS MONEY.
// Kevin's ruling: Laura Wood (Greensboro, $370) and Carol Sullivan (West
// Raleigh, $180) each had one paid invoice, later deleted in Jobber. Dropping
// it would say they paid nothing, when they almost certainly did. So a paid
// invoice, when deleted, keeps paid_amount, total and paid_at — and paid_at
// is how everything else recognises it afterwards: upsertInvoice only ever
// stamps paid_at on an invoice Jobber called PAID, so "deleted AND paid_at
// set" means "deleted after it was paid". The money totals (lifetime paid,
// Collected, invoiced) still count it; nothing counts it as owed; no list
// shows it.
//
// An UNPAID invoice, when deleted, drops what it had recorded as received:
// that money (a deposit, a part payment) lives on in Jobber on the quote,
// the client's credit or the replacement invoice, and counting it here as
// well would count it twice.
//
// PURE: no React, no fetch. Imported by the webhook, the repair script,
// the money roll-ups and the screens, so "deleted" means one thing.
// ─────────────────────────────────────────────────────────────

export const INVOICE_DELETED = 'deleted'

export function isDeletedInvoice(i) {
  return (i?.status ?? null) === INVOICE_DELETED
}

// Deleted after it was paid — still money collected (the exception above).
export function keepsCollectedMoney(i) {
  return isDeletedInvoice(i) && i?.paid_at != null
}

// Every invoice a screen may show, total as owing, or reason about.
export function liveInvoices(list) {
  return (list || []).filter(i => !isDeletedInvoice(i))
}

// For stage and settled-ness: live invoices, plus a paid-then-deleted one
// read as the paid invoice it was (it must not make a finished deal look
// unfinished, and it must never read as owing).
export function invoicesForReasoning(list) {
  const out = []
  for (const i of list || []) {
    if (!isDeletedInvoice(i)) out.push(i)
    else if (keepsCollectedMoney(i)) out.push({ ...i, status: 'paid', balance_owing: 0 })
  }
  return out
}

/**
 * The write that marks an invoice deleted. Always: status 'deleted',
 * nothing owed. A PAID invoice keeps paid_amount / total / paid_at (they
 * are not in the patch — that absence IS the exception). An unpaid one
 * drops what it recorded as received.
 */
export function deletedInvoicePatch(row) {
  const wasPaid = row?.status === 'paid'
  return wasPaid
    ? { status: INVOICE_DELETED, balance_owing: 0 }
    : { status: INVOICE_DELETED, balance_owing: 0, paid_amount: 0 }
}

// The repair / script message for "Jobber has no invoice with this id" —
// an answer, not a mystery (it used to read "not found").
export const DELETED_IN_JOBBER_MESSAGE = 'deleted in Jobber — Jobber has no invoice with this id any more'
