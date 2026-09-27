// lib/lead-paid-total.ts
// ─────────────────────────────────────────────────────────────
// leads.paid_amount is the person's LIFETIME paid total: the sum of every
// paid invoice on the lead. It feeds the Past-client status (paid > 0 with
// no win), the returning-client drip choice (isPastClient) and the profile's
// lifetime-paid fallback.
//
// It used to be written as "the total of whichever invoice was paid last" —
// the INVOICE webhook and the import both OVERWROTE it per invoice — so a
// person with three paid jobs read as the last job only, and a person whose
// last paid invoice was a -$92.58 refund read as -$92.58 lifetime (2026-09-27
// scout: 1,684 people off, 24 at zero or less despite paid invoices).
//
// leads.balance_owing had the same defect (2026-09-27, 35 people off by
// ~$95k in all): the webhook overwrote it with the invoice in hand — 0 on a
// paid event, that invoice's total otherwise — so a second open invoice hid
// the first. It is now the sum of what every invoice on the lead still owes,
// by the SAME formula the engagement roll-up uses (maybeAdvanceEngagementStage
// in lib/engagements.ts), so person, engagements and screens agree.
//
// Now every writer recomputes from the invoices table instead of carrying
// one invoice's number. invoices.paid_amount is the per-invoice paid figure
// (upsertInvoice writes the full total when Jobber says PAID, null otherwise),
// so summing the 'paid' rows gives the lifetime total, and a refund / credit
// invoice (a paid invoice with a negative total) reduces it rather than
// replacing it.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

type InvoiceMoney = { status?: string | null; total?: number | string | null; paid_amount?: number | string | null; balance_owing?: number | string | null }

/**
 * Lifetime paid total from invoice rows: the sum of paid_amount over the
 * rows Jobber calls paid. null when the lead has no paid invoice at all —
 * "never paid" stays distinct from "paid, then refunded to zero".
 * Rounded to cents so float noise never reads as a mismatch.
 */
export function sumPaidInvoices(invoices: InvoiceMoney[]): number | null {
  const paid = invoices.filter(i => (i.status ?? null) === 'paid')
  if (paid.length === 0) return null
  const total = paid.reduce((s, i) => s + (Number(i.paid_amount) || 0), 0)
  return Math.round(total * 100) / 100
}

/**
 * What the lead still owes: the sum over EVERY invoice of its stored
 * balance_owing, falling back to total - paid_amount when the balance is
 * missing — the engagement roll-up's formula exactly. A paid invoice carries
 * balance 0 (upsertInvoice), so it adds nothing; every other Jobber state
 * (awaiting payment, sent-not-due, past due, draft, bad debt) is stored with
 * its balance and counts, as it does on the engagement. An unpaid credit
 * note (negative total) makes the sum negative, and it stays negative: the
 * engagement shows the same figure. null when the lead has no invoice.
 */
export function sumBalanceOwing(invoices: InvoiceMoney[]): number | null {
  if (invoices.length === 0) return null
  const num = (v: unknown) => (v == null ? 0 : Number(v) || 0)
  const total = invoices.reduce(
    (s, i) => s + (i.balance_owing != null ? num(i.balance_owing) : num(i.total) - num(i.paid_amount)), 0)
  return Math.round(total * 100) / 100
}

/**
 * Read the lead's invoices once and return both roll-ups. Returns
 * { ok: false } on a read error so the caller leaves the stored values
 * alone rather than write wrong ones.
 */
export async function readLeadMoneyTotals(
  leadId: string,
): Promise<{ ok: true; paidAmount: number | null; balanceOwing: number | null } | { ok: false; error: string }> {
  const { data, error } = await supabaseService
    .from('invoices')
    .select('status, total, paid_amount, balance_owing')
    .eq('lead_id', leadId)
  if (error) return { ok: false, error: error.message }
  const rows = data ?? []
  return { ok: true, paidAmount: sumPaidInvoices(rows), balanceOwing: sumBalanceOwing(rows) }
}
