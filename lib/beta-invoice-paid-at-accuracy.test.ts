// @vitest-environment node
//
// paid_at accuracy (production bug: every paid invoice was stamped with its
// ISSUE date, not its payment date — Elon Hasson's invoice 161511391 was
// issued 2026-06-25 and paid 2026-07-10, a 15-day error).
//
// SINGLE_INVOICE_QUERY never selected payment data, and upsertInvoice's
// comment asserted Jobber "carries no per-payment data or paid timestamp".
// That was simply false: Invoice exposes paymentRecords { amount entryDate
// tipAmount adjustmentType } and amounts { paymentsTotal tipsTotal
// invoiceBalance }. The query just never asked.
//
// Pins:
//   — paid_at = the LATEST money-in entryDate when paymentRecords are present.
//   — Only PAYMENT/DEPOSIT count as money in. A later REFUND / VOIDED /
//     FAILED_ACH_PAYMENT must never be mistaken for "when this was paid".
//   — createdAt remains the fallback when paymentRecords are absent (the
//     bulk-import queries don't select them) — no regression there.
//   — Unpaid invoices still get paid_at null regardless of payment records.
//   — SINGLE_INVOICE_QUERY actually selects the fields this relies on.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = { upserted: [] as any[] }
  const reset = () => { state.upserted = [] }
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ['select', 'eq', 'limit', 'order', 'in', 'is', 'not']) {
      b[m] = () => b
    }
    b.maybeSingle = () => Promise.resolve({ data: null, error: null })
    b.upsert = (payload: any) => {
      if (table === 'invoices') state.upserted.push(payload)
      const c: any = {}
      c.select = () => c
      c.single = () => Promise.resolve({ data: { id: 'inv-db-1' }, error: null })
      c.maybeSingle = () => Promise.resolve({ data: { id: 'inv-db-1' }, error: null })
      return c
    }
    b.then = (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn() }))

import { upsertInvoice, SINGLE_INVOICE_QUERY } from '@/lib/jobber-import'

const ISSUED = '2026-06-25T13:08:56Z'
const PAID_ON = '2026-07-10T14:30:01Z'

const invoice = (over: any = {}) => ({
  id: 'gid://Jobber/Invoice/161511391',
  createdAt: ISSUED,
  jobberWebUri: 'https://jobber/x',
  invoiceStatus: 'PAID',
  amounts: { total: '906.40', subtotal: '906.40' },
  ...over,
})

const lastUpsert = () => h.state.upserted[h.state.upserted.length - 1]

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('paid_at comes from the real payment date', () => {
  it("uses paymentRecords.entryDate, not the invoice's issue date", async () => {
    await upsertInvoice(invoice({
      paymentRecords: { nodes: [{ amount: 906.4, entryDate: PAID_ON, tipAmount: 135.96, adjustmentType: 'PAYMENT' }] },
    }), null, null, 'lead-1', 'loc_portland')

    expect(lastUpsert().paid_at).toBe(PAID_ON)
    expect(lastUpsert().paid_at).not.toBe(ISSUED) // the 15-day error
  })

  it('takes the LATEST money-in date when an invoice was paid in instalments', async () => {
    await upsertInvoice(invoice({
      paymentRecords: { nodes: [
        { amount: 400, entryDate: '2026-07-01T10:00:00Z', adjustmentType: 'DEPOSIT' },
        { amount: 506.4, entryDate: PAID_ON, adjustmentType: 'PAYMENT' },
      ] },
    }), null, null, 'lead-1', 'loc_portland')

    expect(lastUpsert().paid_at).toBe(PAID_ON)
  })

  it('ignores REFUND / VOIDED / FAILED_ACH_PAYMENT records', async () => {
    await upsertInvoice(invoice({
      paymentRecords: { nodes: [
        { amount: 906.4, entryDate: PAID_ON, adjustmentType: 'PAYMENT' },
        // all AFTER the payment — a naive max() would pick one of these
        { amount: -100, entryDate: '2026-07-12T00:00:00Z', adjustmentType: 'REFUND' },
        { amount: 0, entryDate: '2026-07-13T00:00:00Z', adjustmentType: 'VOIDED' },
        { amount: 0, entryDate: '2026-07-14T00:00:00Z', adjustmentType: 'FAILED_ACH_PAYMENT' },
      ] },
    }), null, null, 'lead-1', 'loc_portland')

    expect(lastUpsert().paid_at).toBe(PAID_ON)
  })
})

describe('fallback + non-paid behaviour is unchanged', () => {
  it('falls back to createdAt when the query selected no paymentRecords (bulk import)', async () => {
    await upsertInvoice(invoice(), null, null, 'lead-1', 'loc_portland')
    expect(lastUpsert().paid_at).toBe(ISSUED)
  })

  it('falls back to createdAt when only non-money-in records exist', async () => {
    await upsertInvoice(invoice({
      paymentRecords: { nodes: [{ amount: -50, entryDate: '2026-07-12T00:00:00Z', adjustmentType: 'REFUND' }] },
    }), null, null, 'lead-1', 'loc_portland')
    expect(lastUpsert().paid_at).toBe(ISSUED)
  })

  it('an unpaid invoice has paid_at null even if a deposit exists', async () => {
    await upsertInvoice(invoice({
      invoiceStatus: 'PAST_DUE',
      paymentRecords: { nodes: [{ amount: 100, entryDate: PAID_ON, adjustmentType: 'DEPOSIT' }] },
    }), null, null, 'lead-1', 'loc_portland')

    expect(lastUpsert().paid_at).toBeNull()
    expect(lastUpsert().status).toBe('sent')
  })
})

describe('the query actually asks for what the derivation reads', () => {
  it('SINGLE_INVOICE_QUERY selects paymentRecords + the amounts fields', () => {
    expect(SINGLE_INVOICE_QUERY).toMatch(/paymentRecords\(first: \d+\)\s*{\s*nodes\s*{[^}]*entryDate/)
    expect(SINGLE_INVOICE_QUERY).toMatch(/adjustmentType/)
    expect(SINGLE_INVOICE_QUERY).toMatch(/paymentsTotal/)
    expect(SINGLE_INVOICE_QUERY).toMatch(/tipsTotal/)
    expect(SINGLE_INVOICE_QUERY).toMatch(/invoiceBalance/)
  })
})
