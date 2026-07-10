// @vitest-environment node
// upsertQuote / upsertJob / upsertInvoice — webhook-race idempotency,
// mirroring the assessments fix (f0068c9, beta-assessment-upsert.test.ts).
// Pins per table:
//   — writes via .upsert with onConflict:'location_id,jobber_<x>_id'
//     (DB-level idempotent; arbiters are the non-partial
//     <table>_location_jobber_<x>_id_idx indexes from
//     jobber_subrecord_onconflict_targetable.sql), NOT check-then-insert
//   — a simulated concurrent double-call for the same conflict key lands
//     ONE row, not two (the old code raced into a unique-index throw →
//     webhook retry)
//   — the pre-select survives only as a created-vs-updated stat hint and
//     its error THROWS instead of being silently discarded
// Quote-specific: an earlier approved_at is preserved (stamped once).
// Invoice-specific: job_id (nested-in-job handling) flows through.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock supabaseService: in-memory tables with REAL composite
//    unique-key semantics. .upsert merges on the onConflict columns
//    (like the prod arbiter indexes); .insert appends blindly and
//    .update is tracked — so these tests distinguish an idempotent
//    upsert from the old racy check-then-insert.
const h = vi.hoisted(() => {
  const blank = () => ({
    rows: [] as any[],
    upserts: [] as { payload: any; opts: any }[],
    inserts: [] as any[],
    updates: [] as any[],
    selectError: null as any,
  })
  const state = {
    tables: {} as Record<string, ReturnType<typeof blank>>,
    nextId: 1,
  }
  const reset = () => {
    state.tables = { quotes: blank(), jobs: blank(), invoices: blank() }
    state.nextId = 1
  }
  reset()
  const makeBuilder = (table: string) => {
    const t = state.tables[table]
    if (!t) {
      const noop: any = {}
      for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'order', 'limit']) {
        noop[m] = () => noop
      }
      noop.maybeSingle = () => Promise.resolve({ data: null, error: null })
      noop.single = () => Promise.resolve({ data: null, error: null })
      noop.then = (res: any) => Promise.resolve({ data: null, error: null }).then(res)
      return noop
    }
    const filters: Array<[string, any]> = []
    let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select'
    let written: any = null
    const b: any = {}
    b.select = () => b
    b.eq = (k: string, v: any) => { filters.push([k, v]); return b }
    b.insert = (payload: any) => {
      mode = 'insert'
      t.inserts.push(payload)
      written = { id: `${table}-${state.nextId++}`, ...payload }
      t.rows.push(written)
      return b
    }
    b.update = (payload: any) => {
      mode = 'update'
      t.updates.push(payload)
      written = payload
      return b
    }
    b.upsert = (payload: any, opts: any) => {
      mode = 'upsert'
      t.upserts.push({ payload, opts })
      const keys: string[] = (opts?.onConflict || '').split(',').filter(Boolean)
      const hit = keys.length
        ? t.rows.find(r => keys.every(k => r[k] === payload[k]))
        : undefined
      if (hit) {
        Object.assign(hit, payload)
        written = hit
      } else {
        written = { id: `${table}-${state.nextId++}`, ...payload }
        t.rows.push(written)
      }
      return b
    }
    b.maybeSingle = () => {
      if (t.selectError) return Promise.resolve({ data: null, error: t.selectError })
      const hits = t.rows.filter(r => filters.every(([k, v]) => r[k] === v))
      if (hits.length > 1) {
        // What prod PostgREST does on duplicate rows — the discarded
        // error that turned assessment dupes into a snowball.
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
        })
      }
      return Promise.resolve({ data: hits[0] ?? null, error: null })
    }
    b.single = () => Promise.resolve(
      mode === 'update'
        ? { data: written, error: null }
        : { data: written ? { id: written.id } : null, error: written ? null : { message: 'no row' } },
    )
    return b
  }
  return { state, reset, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

import { upsertQuote, upsertJob, upsertInvoice } from '@/lib/jobber-import'

const QUOTE = {
  id: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzQyMQ==',
  createdAt: '2026-07-01T15:00:00+00:00',
  jobberWebUri: 'https://secure.getjobber.com/quotes/421',
  quoteStatus: 'SENT' as string | undefined,
  amounts: { subtotal: '900', taxAmount: '74.25', discountAmount: '0', total: '974.25' },
}
const JOB = {
  id: 'Z2lkOi8vSm9iYmVyL0pvYi83NzM=',
  createdAt: '2026-07-02T15:00:00+00:00',
  jobberWebUri: 'https://secure.getjobber.com/jobs/773',
  title: 'Pantry refresh',
  jobStatus: 'ACTIVE',
  startAt: '2026-07-10T14:00:00+00:00',
  completedAt: null,
  total: '974.25',
}
const INVOICE = {
  id: 'Z2lkOi8vSm9iYmVyL0ludm9pY2UvNTUx',
  createdAt: '2026-07-03T15:00:00+00:00',
  jobberWebUri: 'https://secure.getjobber.com/invoices/551',
  invoiceStatus: 'PAID',
  amounts: { subtotal: '900', taxAmount: '74.25', discountAmount: '0', total: '974.25' },
}

const callQuote = (q: any = QUOTE) => upsertQuote(q, 'sr-1', 'lead-1', 'loc-1')
const callJob = (j: any = JOB) => upsertJob(j, 'sr-1', 'lead-1', 'loc-1')
const callInvoice = (i: any = INVOICE) => upsertInvoice(i, 'job-db-1', 'sr-1', 'lead-1', 'loc-1')

beforeEach(() => h.reset())

// Shared shape assertions, run per table — the assessments pattern.
const CASES: Array<{
  table: 'quotes' | 'jobs' | 'invoices'
  idCol: string
  call: () => Promise<{ id: string; created: boolean }>
  lookupLabel: string
}> = [
  { table: 'quotes', idCol: 'jobber_quote_id', call: callQuote, lookupLabel: 'Quote lookup' },
  { table: 'jobs', idCol: 'jobber_job_id', call: callJob, lookupLabel: 'Job lookup' },
  { table: 'invoices', idCol: 'jobber_invoice_id', call: callInvoice, lookupLabel: 'Invoice lookup' },
]

for (const { table, idCol, call, lookupLabel } of CASES) {
  describe(`upsert ${table} idempotency`, () => {
    it(`writes via upsert with onConflict location_id,${idCol}, never bare insert/update`, async () => {
      const res = await call()
      expect(res.created).toBe(true)
      const t = h.state.tables[table]
      expect(t.inserts).toHaveLength(0)
      expect(t.updates).toHaveLength(0)
      expect(t.upserts).toHaveLength(1)
      expect(t.upserts[0].opts).toMatchObject({ onConflict: `location_id,${idCol}` })
      expect(t.upserts[0].payload.location_id).toBe('loc-1')
      expect(t.upserts[0].payload[idCol]).toBeTruthy()
    })

    it('concurrent double-call for the same conflict key lands ONE row', async () => {
      // Both calls pre-select before either writes — the exact webhook
      // burst. Check-then-insert raced into a unique-index throw (and a
      // webhook retry); onConflict merges quietly.
      const [a, b] = await Promise.all([call(), call()])
      const t = h.state.tables[table]
      expect(t.rows).toHaveLength(1)
      expect(a.id).toBe(t.rows[0].id)
      expect(b.id).toBe(t.rows[0].id)
    })

    it('sequential re-sync updates the existing row and reports created:false', async () => {
      const first = await call()
      const second = await call()
      const t = h.state.tables[table]
      expect(t.rows).toHaveLength(1)
      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.id).toBe(first.id)
    })

    it('pre-select error throws instead of reading as "no rows"', async () => {
      const t = h.state.tables[table]
      t.selectError = { code: 'PGRST116', message: 'multiple (or no) rows returned' }
      await expect(call()).rejects.toThrow(new RegExp(`${lookupLabel}: .*multiple`))
      expect(t.rows).toHaveLength(0)
    })
  })
}

describe('upsertQuote approved_at semantics', () => {
  it('stamps approved_at once and preserves the earlier stamp on re-sync', async () => {
    await callQuote({ ...QUOTE, quoteStatus: 'APPROVED' })
    const t = h.state.tables.quotes
    const firstStamp = t.rows[0].approved_at
    expect(firstStamp).toBeTruthy()
    await callQuote({ ...QUOTE, quoteStatus: 'APPROVED' })
    expect(t.rows).toHaveLength(1)
    expect(t.rows[0].approved_at).toBe(firstStamp)
    // The second upsert payload must not carry approved_at at all.
    expect('approved_at' in t.upserts[1].payload).toBe(false)
  })

  it('non-approved re-sync never touches an existing approved_at', async () => {
    await callQuote({ ...QUOTE, quoteStatus: 'APPROVED' })
    const t = h.state.tables.quotes
    const stamp = t.rows[0].approved_at
    await callQuote({ ...QUOTE, quoteStatus: 'CHANGES_REQUESTED' })
    expect(t.rows[0].approved_at).toBe(stamp)
    expect(t.rows[0].status).toBe('changes_requested')
  })
})

describe('upsertJob quote-link healing (preserved behavior)', () => {
  it('links quote_id when the quote row exists, and a missed lookup cannot erase it', async () => {
    const t = h.state.tables
    t.quotes.rows.push({ id: 'quotes-db-9', jobber_quote_id: '421', location_id: 'loc-1' })
    const linked = await callJob({ ...JOB, quote: { id: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzQyMQ==' } })
    expect(linked.quote_db_id).toBe('quotes-db-9')
    expect(t.jobs.rows[0].quote_id).toBe('quotes-db-9')
    // Re-sync without the quote edge (e.g. JOB_UPDATE racing) — the
    // upsert payload must omit quote_id, not null it.
    const relinked = await callJob(JOB)
    expect(relinked.quote_db_id).toBe(null)
    expect(t.jobs.rows).toHaveLength(1)
    expect(t.jobs.rows[0].quote_id).toBe('quotes-db-9')
    expect('quote_id' in t.jobs.upserts[1].payload).toBe(false)
  })
})

describe('upsertInvoice nested-in-job handling (preserved behavior)', () => {
  it('carries job_id through the upsert payload', async () => {
    await callInvoice()
    const t = h.state.tables.invoices
    expect(t.upserts[0].payload.job_id).toBe('job-db-1')
    expect(t.rows[0].job_id).toBe('job-db-1')
    expect(t.rows[0].paid_amount).toBe(974.25)
    expect(t.rows[0].balance_owing).toBe(0)
  })
})
