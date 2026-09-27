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
// Now every writer recomputes from the invoices table instead of carrying
// one invoice's number. invoices.paid_amount is the per-invoice paid figure
// (upsertInvoice writes the full total when Jobber says PAID, null otherwise),
// so summing the 'paid' rows gives the lifetime total, and a refund / credit
// invoice (a paid invoice with a negative total) reduces it rather than
// replacing it.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

type InvoiceMoney = { status?: string | null; paid_amount?: number | string | null }

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
 * Read the lead's invoices and return its lifetime paid total. Returns
 * { ok: false } on a read error so the caller can leave the stored value
 * alone rather than write a wrong one.
 */
export async function readLeadPaidTotal(
  leadId: string,
): Promise<{ ok: true; paidAmount: number | null } | { ok: false; error: string }> {
  const { data, error } = await supabaseService
    .from('invoices')
    .select('status, paid_amount')
    .eq('lead_id', leadId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, paidAmount: sumPaidInvoices(data ?? []) }
}
