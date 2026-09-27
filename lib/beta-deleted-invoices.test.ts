// @vitest-environment node
//
// INVOICES DELETED IN JOBBER (2026-09-27).
//
// INVOICE_DESTROY used to clear a link on the person and leave the invoice
// unpaid at full balance: 13 deleted invoices showed $26,008 owed. Now the
// row is marked 'deleted', owes nothing, every screen leaves it out, and the
// deal's money is recomputed WITHOUT touching its stage.
//
// THE EXCEPTION, PINNED HARDEST BELOW: a deleted invoice that was PAID keeps
// its collected money (Kevin: Laura Wood $370, Carol Sullivan $180 — the
// clients did pay). If a test in the "keeps its collected money" block fails,
// do not "fix" the test — someone has removed the exception.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) => state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in', 'gt', 'lt']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn() }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-disconnect', () => ({ disconnectJobberFromLocation: vi.fn(async () => ({ error: null })) }))

import { handleInvoiceDestroy } from '@/lib/jobber-webhook-handlers'
import { rollUpInvoiceMoney, deriveEngagementStage } from '@/lib/engagements'
import { sumPaidInvoices, sumBalanceOwing } from '@/lib/lead-paid-total'
import {
  deletedInvoicePatch, keepsCollectedMoney, isDeletedInvoice, liveInvoices, invoicesForReasoning, INVOICE_DELETED,
} from '@/components/hive/shared/invoiceDeleted'
import { owedOnInvoices, finalProcessingCase } from '@/components/hive/shared/finalProcessing'
import { invoicesSettled } from '@/components/hive/shared/closeEngagement'
import { deriveStatusChip } from '@/components/hive/shared/engagementStatus'
import { writtenOffAmountFromInvoices } from '@/components/hive/shared/writtenOff'

beforeEach(() => { h.reset(); vi.clearAllMocks() })

const gid = (n: string) => Buffer.from(`gid://Jobber/Invoice/${n}`).toString('base64')
const ctx = (itemId: string) => ({ topic: 'INVOICE_DESTROY', itemId, occurredAt: '2026-09-27T12:00:00Z', location: { id: 'loc-uuid', location_id: 'loc_carmel', name: 'Carmel' } as any })
const updates = (table: string) => h.state.calls.filter(c => c.table === table)
  .flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))

const paidInv = (total: number, over: any = {}) => ({ status: 'paid', total, paid_amount: total, balance_owing: 0, paid_at: '2026-08-28T00:00:00Z', ...over })
const openInv = (total: number, over: any = {}) => ({ status: 'sent', total, paid_amount: 0, balance_owing: total, paid_at: null, ...over })
const deletedUnpaid = (total: number) => ({ status: 'deleted', total, paid_amount: 0, balance_owing: 0, paid_at: null })

// ── 1. the webhook ───────────────────────────────────────────────────────
describe('INVOICE_DESTROY marks the invoice deleted with $0 owing and recomputes', () => {
  it('Danielle Fiega\'s $3,350: decoded id, status deleted, $0 owing, nothing received; deal + person recomputed', async () => {
    h.enqueue('leads', { id: 'lead-1', name: 'Danielle', stage: 'Closed Won' })                    // nullify: find lead
    h.enqueue('invoices', [{ id: 'inv-1', engagement_id: 'eng-1', lead_id: 'lead-1', status: 'sent' }]) // rows for this id
    h.enqueue('invoices', null)                                                                     // the deletion write
    h.enqueue('invoices', [ { ...deletedUnpaid(3350) }, paidInv(3378) ])                            // refresh: engagement invoices
    h.enqueue('invoices', [ { ...deletedUnpaid(3350) }, paidInv(3378) ])                            // person invoices
    const res = await handleInvoiceDestroy(ctx(gid('169566910')))
    expect(res.processed).toBe(true)
    // matched on the DECODED numeric id, at this location
    const rowLookup = h.state.calls.find(c => c.table === 'invoices' && c.ops.some(o => o[0] === 'select'))!
    expect(rowLookup.ops).toContainEqual(['eq', ['jobber_invoice_id', '169566910']])
    const inv = updates('invoices')[0]
    expect(inv).toMatchObject({ status: INVOICE_DELETED, balance_owing: 0, paid_amount: 0 })
    const eng = updates('engagements')[0]
    expect(eng).toMatchObject({ total_invoiced: 3378, total_paid: 3378, balance_owing: 0 })
    const lead = updates('leads').find(u => 'balance_owing' in u)!
    expect(lead).toMatchObject({ paid_amount: 3378, balance_owing: 0 })
  })

  it('an already-deleted row is not touched again (idempotent re-delivery)', async () => {
    h.enqueue('leads', null)
    h.enqueue('invoices', [{ id: 'inv-1', engagement_id: 'eng-1', lead_id: 'lead-1', status: 'deleted' }])
    await handleInvoiceDestroy(ctx(gid('169566910')))
    expect(updates('invoices')).toEqual([])
    expect(updates('engagements')).toEqual([])
  })
})

// ── 2. the deal's stage never moves ──────────────────────────────────────
describe('a deletion never moves the deal\'s stage', () => {
  it('the engagement write carries money only — no stage, no close fields', async () => {
    h.enqueue('leads', null)
    h.enqueue('invoices', [{ id: 'inv-1', engagement_id: 'eng-1', lead_id: 'lead-1', status: 'sent' }])
    h.enqueue('invoices', null)
    h.enqueue('invoices', [deletedUnpaid(95), paidInv(1342.5)])
    h.enqueue('invoices', [deletedUnpaid(95), paidInv(1342.5)])
    await handleInvoiceDestroy(ctx(gid('172076538')))
    for (const u of updates('engagements')) {
      expect(Object.keys(u).sort()).toEqual(['balance_owing', 'total_invoiced', 'total_paid', 'updated_at'])
    }
  })

  it('the handler never calls the stage advance (source pin)', () => {
    const src = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
    const body = src.slice(src.indexOf('export async function handleInvoiceDestroy'), src.indexOf('// ASSESSMENT_DESTROY'))
    expect(body).toContain('refreshEngagementMoney(')
    expect(body).not.toContain('maybeAdvanceEngagementStage')
  })

  it('the repair script writes no stage either, and checks stages before/after', () => {
    const src = readFileSync('scripts/repair-deleted-invoices.mjs', 'utf8')
    expect(src).toContain('assertNoDrift(before, await sideEffectSnapshot(')
    expect(src).not.toMatch(/stage:\s*['"]/)
  })
})

// ── 3. THE EXCEPTION — pinned hardest ────────────────────────────────────
describe('a deleted PAID invoice keeps its collected money (Kevin\'s ruling — do not remove)', () => {
  // Laura Wood, Greensboro — her only invoice: $370, paid 3 Aug, deleted in Jobber 31 Aug.
  const laura = { id: 'ab06adba', status: 'paid', total: 370, paid_amount: 370, balance_owing: 0, paid_at: '2026-08-03T14:25:12Z' }
  // Carol Sullivan, West Raleigh — her only invoice: $180, paid 13 Aug, deleted 26 Aug.
  const carol = { id: 'd6a2ca83', status: 'paid', total: 180, paid_amount: 180, balance_owing: 0, paid_at: '2026-08-13T13:26:49Z' }

  it('the deletion write for a PAID invoice does not touch paid_amount, total or paid_at', () => {
    const p = deletedInvoicePatch(laura)
    expect(p).toEqual({ status: 'deleted', balance_owing: 0 })
    expect('paid_amount' in p).toBe(false)
    expect('total' in p).toBe(false)
    expect('paid_at' in p).toBe(false)
  })

  it('...whereas an UNPAID invoice drops what it had recorded as received', () => {
    expect(deletedInvoicePatch(openInv(500, { paid_amount: 100 }))).toEqual({ status: 'deleted', balance_owing: 0, paid_amount: 0 })
  })

  it('Laura Wood after deletion: still $370 collected on her deal and her person record, $0 owed', () => {
    const row = { ...laura, ...deletedInvoicePatch(laura) }
    expect(keepsCollectedMoney(row)).toBe(true)
    expect(rollUpInvoiceMoney([row])).toEqual({ total_invoiced: 370, total_paid: 370, balance_owing: 0 })
    expect(sumPaidInvoices([row])).toBe(370)
    expect(sumBalanceOwing([row])).toBeNull()
  })

  it('Carol Sullivan after deletion: still $180 collected', () => {
    const row = { ...carol, ...deletedInvoicePatch(carol) }
    expect(rollUpInvoiceMoney([row]).total_paid).toBe(180)
    expect(sumPaidInvoices([row])).toBe(180)
  })

  it('through the webhook: a PAID invoice\'s deletion write leaves its money alone', async () => {
    h.enqueue('leads', null)
    h.enqueue('invoices', [{ id: 'inv-l', engagement_id: 'eng-l', lead_id: 'lead-l', status: 'paid' }])
    h.enqueue('invoices', null)
    h.enqueue('invoices', [{ ...laura, status: 'deleted' }])
    h.enqueue('invoices', [{ ...laura, status: 'deleted' }])
    await handleInvoiceDestroy(ctx(gid('166639167')))
    const inv = updates('invoices')[0]
    expect(inv.status).toBe('deleted')
    expect('paid_amount' in inv).toBe(false)
    expect(updates('engagements')[0]).toMatchObject({ total_paid: 370, balance_owing: 0 })
    expect(updates('leads').find(u => 'paid_amount' in u)).toMatchObject({ paid_amount: 370 })
  })

  it('a paid-then-deleted invoice reads as paid for stage and for Mark won — never as unfinished or owing', () => {
    const row = { ...laura, ...deletedInvoicePatch(laura) }
    expect(invoicesForReasoning([row])[0]).toMatchObject({ status: 'paid', balance_owing: 0 })
    expect(invoicesSettled([row])).toBe(true)
    expect(owedOnInvoices([row])).toBe(0)
  })
})

// ── 4. no screen counts a deleted invoice ────────────────────────────────
describe('no screen counts a deleted invoice', () => {
  const list = [paidInv(2604.5), { ...deletedUnpaid(2604.61), balance_owing: 2604.61 }] // even if a balance lingered

  it('Final Processing owed amount, case, Mark won gate, card chip, written-off amount, person balance, deal balance', () => {
    const fpEng = { stage: 'Final Processing', balance_owing: 0 }
    expect(owedOnInvoices(list)).toBe(0)
    expect(finalProcessingCase(fpEng, list)).toBe('paid')
    expect(invoicesSettled(list)).toBe(true)
    expect(deriveStatusChip({ ...fpEng, invoices: list } as any)?.label).toBe('Paid')
    expect(writtenOffAmountFromInvoices(list)).toBe(0)
    expect(sumBalanceOwing(list)).toBe(0)
    expect(rollUpInvoiceMoney(list).balance_owing).toBe(0)
    expect(liveInvoices(list)).toHaveLength(1)
  })

  it('the stage derivation does not see an unpaid deleted invoice', () => {
    const d = deriveEngagementStage({
      sr: null, quotes: [],
      jobs: [{ status: 'completed', completed_at: '2026-08-10T00:00:00Z', scheduled_start: null, created_at: '2026-08-01T00:00:00Z' }],
      invoices: [paidInv(2604.5), deletedUnpaid(2604.61)],
    }, { closeWonOnDone: false })
    expect(d).toEqual({ stage: 'Final Processing' })   // not blocked by the deleted one
  })

  it('the card chip\'s inline copy of the rule answers the same as the shared rule', () => {
    const kept = { ...paidInv(370), ...deletedInvoicePatch(paidInv(370)) }
    for (const invs of [[kept], [deletedUnpaid(95)], [paidInv(100), deletedUnpaid(95)], [openInv(50), kept]]) {
      const e = { stage: 'Final Processing', balance_owing: owedOnInvoices(invs), invoices: invs }
      const shared = invoicesForReasoning(invs)
      const expected = shared.length === 0 ? 'Never Invoiced' : owedOnInvoices(invs) > 0 ? `Owes $${owedOnInvoices(invs)}` : 'Paid'
      expect(deriveStatusChip(e as any)?.label).toBe(expected)
    }
  })

  it('every place that fetches invoices for a screen leaves deleted ones out (source pins)', () => {
    const pins: Array<[string, RegExp]> = [
      ['app/api/engagements/[id]/route.ts', /from\('invoices'\)\.select\('\*'\)\.eq\('engagement_id', id\)\.neq\('status', 'deleted'\)/],   // panel list, FP, Mark won, override
      ['app/api/engagements/route.ts', /byEng\(invoicesRaw\.filter\(\(i: any\) => i\.status !== 'deleted'\)\)/],                         // board + list chips
      ['app/api/clients/[id]/profile/route.ts', /\.in\('engagement_id', openIds\)\.neq\('status', 'deleted'\)/],                         // client card
      ['app/api/leads/[id]/route.ts', /from\('invoices'\)\.select\('\*'\)\.eq\('lead_id', id\)\.neq\('status', 'deleted'\)/],            // person refetch
      ['app/api/leads/[id]/timeline/route.ts', /\.eq\('lead_id', id\)\s*\.neq\('status', 'deleted'\)/],                                  // timeline
      ['app/_hub-page.tsx', /const liveInvoiceRows = liveInvoices\(invoicesRaw\)/],                                                       // Home, people, directory
    ]
    for (const [f, re] of pins) expect(readFileSync(f, 'utf8'), f).toMatch(re)
    const overview = readFileSync('lib/hub-all-overview.ts', 'utf8')                                                                    // aged debt + outstanding
    expect(overview.match(/\.neq\('status', 'deleted'\)/g)?.length).toBe(2)
    const hub = readFileSync('app/_hub-page.tsx', 'utf8')
    expect(hub).not.toMatch(/groupBy\(invoicesRaw\)|byEngagement\(invoicesRaw\)/)
  })
})

// ── 5. the four Final Processing deals ───────────────────────────────────
describe('the four Final Processing deals become Mark-won-ready; Ingrid Lowery drops to $2,580.15', () => {
  const fp = { stage: 'Final Processing' }
  const ready = (invs: any[]) => ({ case: finalProcessingCase(fp, invs), canCloseWon: invoicesSettled(invs), owed: owedOnInvoices(invs) })
  const del = (row: any) => ({ ...row, ...deletedInvoicePatch(row) })

  it('Susan Garrity (Scottsdale): deleted $2,604.61, paid replacement $2,604.50', () => {
    const before = [openInv(2604.61), paidInv(2604.5)]
    expect(ready(before)).toMatchObject({ case: 'owing', canCloseWon: false })
    expect(ready([del(openInv(2604.61)), paidInv(2604.5)])).toEqual({ case: 'paid', canCloseWon: true, owed: 0 })
  })
  it('Sharon Shedrick (Chattanooga): three deleted ($570.16, $571, $107.94), two paid', () => {
    const after = [del(openInv(570.16)), del(openInv(571)), del(openInv(107.94)), paidInv(370), paidInv(1599.1)]
    expect(ready(after)).toEqual({ case: 'paid', canCloseWon: true, owed: 0 })
  })
  it('Yetunde Marquis (North Jersey): deleted $937.30, two paid', () => {
    expect(ready([del(openInv(937.3)), paidInv(1059.98), paidInv(1236)])).toEqual({ case: 'paid', canCloseWon: true, owed: 0 })
  })
  it('Kelly Miller (San Diego): deleted $95, paid replacement', () => {
    expect(ready([del(openInv(95)), paidInv(1342.5)])).toEqual({ case: 'paid', canCloseWon: true, owed: 0 })
  })
  it('Ingrid Lowery (Portland): $6,824.21 → $2,580.15 — the one genuinely open invoice stays', () => {
    const paidOnes = [683.32, 705.1, 3484.69, 4481.06, 4207.65, 1040].map(t => paidInv(t))
    const before = [...paidOnes, openInv(4244.06), openInv(2580.15), { ...openInv(0), total: null, balance_owing: null }]
    expect(Math.round(owedOnInvoices(before) * 100) / 100).toBe(6824.21)
    const after = [...paidOnes, del(openInv(4244.06)), openInv(2580.15), del({ ...openInv(0), total: null, balance_owing: null })]
    expect(owedOnInvoices(after)).toBe(2580.15)
    expect(finalProcessingCase(fp, after)).toBe('owing')
  })
})

// ── 6. the message ───────────────────────────────────────────────────────
describe('"not found" now says what it means', () => {
  it('the balance repair calls an absent invoice "deleted in Jobber"', () => {
    const src = readFileSync('scripts/repair-invoice-balances.mjs', 'utf8')
    expect(src).not.toMatch(/\|\| 'not found'/)
    expect(src).toContain('inv_deleted.DELETED_IN_JOBBER_MESSAGE')
    expect(isDeletedInvoice({ status: 'deleted' })).toBe(true)
  })
})
