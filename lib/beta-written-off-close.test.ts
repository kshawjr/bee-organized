// @vitest-environment node
//
// THE WRITTEN-OFF CLOSE + JOBBER'S REAL INVOICE BALANCE (2026-09-27).
//
// Kevin's ruling: bad debt is its own outcome — not Won (that would say he
// was paid) and not Lost. Stored as Closed Lost + closed_reason
// 'written_off' with the amount in written_off_amount (his choice over a
// third stage: closed everywhere, revenue nowhere, by construction).
//
// And: an unpaid invoice now stores Jobber's invoiceBalance (deposits, part
// payments, voids, write-offs) instead of its full total.
//
// Pins, in the brief's order:
//   · a written-off close is terminal, records the amount, and appears in
//     no revenue total
//   · it is distinguishable from Closed Won and from the owing override
//   · deposit / void / write-off / part payment each store the right balance
//   · a missing invoiceBalance falls back to today's behaviour
//   · Erin Bondurant's exact shape
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null, count: number | null = null) =>
    state.queue.push({ table, resp: { data, error, count } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null, count: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
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
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { PATCH } from '@/app/api/engagements/[id]/route'
import { WON_OVER_BALANCE } from '@/lib/engagements'
import { invoiceMoneyFromJobber } from '@/lib/jobber-import'
import { rollUpEngagements } from '@/lib/engagement-rollup'
import { rollupReferredLeads, referralTotals } from '@/lib/referral-rollup'
import { profileAggregates } from '@/lib/profile-aggregates'
import { isTerminal } from '@/components/hive/shared/stageRank'
import {
  WRITTEN_OFF, isWrittenOff, closedOutcome, engagementStageLabel, writtenOffAmountFromInvoices,
  WRITE_OFF_ACTION, WRITTEN_OFF_LABEL,
} from '@/components/hive/shared/writtenOff'
import { OWING_CLOSE_ACTION, finalProcessingCase, finalProcessingExplainer } from '@/components/hive/shared/finalProcessing'
import { invoicesSettled, DEFAULT_CLOSE_LOST_REASONS } from '@/components/hive/shared/closeEngagement'
import { deriveStatusChip } from '@/components/hive/shared/engagementStatus'

beforeEach(() => { h.reset(); vi.clearAllMocks() })

// ── Erin Bondurant (KC), read live from Jobber 2026-09-27 ──────────────
// $8,294.29 invoiced · 4 × $150 paid · $7,694.29 written off as BAD_DEBT ·
// Jobber invoiceBalance $0 · invoiceStatus bad_debt · deal at Final Processing.
const ERIN_JOBBER = {
  invoiceStatus: 'bad_debt',
  amounts: { total: 8294.29, paymentsTotal: 600, depositAmount: 0, invoiceBalance: 0 },
}
const erinStored = () => ({ status: 'bad_debt', total: 8294.29, ...invoiceMoneyFromJobber(ERIN_JOBBER) })

// ── route harness (the owing-override test's pattern) ──────────────────
const ENG = (over: any = {}) => ({
  id: 'e1', client_id: 'c1', location_uuid: 'loc-uuid-1',
  stage: 'Final Processing', title: 'Whole-home organize', description: null,
  project_type: null, closed_reason: null, balance_owing: 0,
  ...over,
})
const arm = (engagement: any = ENG()) => {
  h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
  h.enqueue('engagements', engagement)
}
const armCommitTail = () => {
  h.enqueue('engagements', null)                            // the update
  h.enqueue('touchpoints', null)                            // stage_change trail
  h.enqueue('leads', { location_id: 'loc1', name: 'Erin' })  // close trail lookup
  h.enqueue('engagements', null, null, 0)                   // other-open count
}
const patch = (body: any, id = 'e1') =>
  PATCH(
    new Request(`http://test/api/engagements/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  )
const engagementWrites = () =>
  h.state.calls.filter(c => c.table === 'engagements' && c.ops.some(([m]) => m === 'update' || m === 'insert'))
const updatePayload = () => {
  const call = engagementWrites().find(c => c.ops.some(([m]) => m === 'update'))
  return call ? call.ops.find(([m]) => m === 'update')![1][0] : null
}

// ── 1. terminal, records the amount ─────────────────────────────────────
describe('a written-off close is terminal and records the amount', () => {
  it('commits as Closed Lost + written_off with the amount computed from the invoices (Erin: $7,694.29)', async () => {
    arm()
    h.enqueue('invoices', [erinStored()])
    armCommitTail()
    const res = await patch({ stage: 'Closed Lost', closed_reason: WRITTEN_OFF, closed_note: 'Four payments then nothing — not worth collections' })
    expect(res.status).toBe(200)
    const p = updatePayload()!
    expect(p.stage).toBe('Closed Lost')
    expect(p.closed_reason).toBe(WRITTEN_OFF)
    expect(p.written_off_amount).toBe(7694.29)
    expect(p.closed_at).toBeTruthy()
    expect(isTerminal(p.stage)).toBe(true)
    // the response carries the outcome so the panel never flashes "Closed lost"
    const j = await res.json()
    expect(j).toMatchObject({ stage: 'Closed Lost', closed_reason: WRITTEN_OFF, written_off_amount: 7694.29 })
  })

  it('the amount is the SERVER\'s — a figure sent from the browser is ignored', async () => {
    arm()
    h.enqueue('invoices', [erinStored()])
    armCommitTail()
    await patch({ stage: 'Closed Lost', closed_reason: WRITTEN_OFF, closed_note: 'x', written_off_amount: 1 })
    expect(updatePayload()!.written_off_amount).toBe(7694.29)
  })

  it('a write-off with no reason is refused at the route — 400, nothing written', async () => {
    arm()
    const res = await patch({ stage: 'Closed Lost', closed_reason: WRITTEN_OFF, closed_note: '   ' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('close_reason_required')
    expect(engagementWrites()).toEqual([])
  })

  it('nothing owed means nothing to write off — 400, nothing written', async () => {
    arm()
    h.enqueue('invoices', [{ status: 'paid', total: 500, paid_amount: 500, balance_owing: 0 }])
    const res = await patch({ stage: 'Closed Lost', closed_reason: WRITTEN_OFF, closed_note: 'why' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('nothing_to_write_off')
    expect(engagementWrites()).toEqual([])
  })

  it('an ordinary Lost close writes no written_off_amount at all', async () => {
    arm(ENG({ stage: 'Estimate' }))
    armCommitTail()
    await patch({ stage: 'Closed Lost', closed_reason: 'No response' })
    expect('written_off_amount' in updatePayload()!).toBe(false)
  })

  it('reopen clears the amount — but only on a written-off row', () => {
    const src = readFileSync('app/api/engagements/[id]/reopen/route.ts', 'utf8')
    expect(src).toMatch(/if \(wasWrittenOff\) patch\.written_off_amount = null/)
  })
})

describe('the amount rule', () => {
  it('bad debt contributes what never came in; an owed invoice its balance; paid and voided nothing; credits never negative', () => {
    expect(writtenOffAmountFromInvoices([
      erinStored(),                                                          // 7694.29
      { status: 'sent', total: 1000, paid_amount: 200, balance_owing: 800 }, // 800
      { status: 'paid', total: 500, paid_amount: 500, balance_owing: 0 },   // 0
      { status: 'sent', total: 556.2, paid_amount: 0, balance_owing: 0 },   // voided → 0
      { status: 'sent', total: -82.3, paid_amount: 0, balance_owing: -82.3 }, // credit → 0
    ])).toBe(8494.29)
  })
})

// ── 2. never revenue ───────────────────────────────────────────────────
describe('a written-off deal appears in no revenue total', () => {
  const erinDeal = { id: 'e1', client_id: 'erin', stage: 'Closed Lost', closed_reason: WRITTEN_OFF, written_off_amount: 7694.29, total_invoiced: 8294.29, total_paid: 600, balance_owing: 0, closed_at: '2026-09-27T00:00:00Z' }
  const wonDeal = { id: 'e2', client_id: 'erin', stage: 'Closed Won', closed_reason: 'won', total_invoiced: 1000, total_paid: 1000, balance_owing: 0, closed_at: '2026-01-01T00:00:00Z' }

  it('won count and won value (client status, Home, Inbox) — the write-off is not a win', () => {
    expect(rollUpEngagements([erinDeal]).won_summary).toBeNull()
    expect(rollUpEngagements([erinDeal, wonDeal]).won_summary).toEqual({ count: 1, value: 1000, lastClosedAt: '2026-01-01T00:00:00Z' })
  })

  it('referral conversions and revenue — not converted; revenue is only the money that really came in', () => {
    const rows = rollupReferredLeads([{ id: 'erin' } as any], [erinDeal as any])
    expect(rows[0].converted).toBe(false)
    expect(referralTotals(rows)).toMatchObject({ converted: 0, revenue: 600 })
  })

  it('profile Collected is the $600 received — never the $7,694.29 written off', () => {
    expect(profileAggregates([erinDeal]).lifetime_paid).toBe(600)
  })

  it('no file outside the write-off\'s own write path reads written_off_amount — so nothing can total it', () => {
    const allowed = new Set([
      'components/hive/shared/writtenOff.js',          // the rule + the closed-line text
      'components/hive/shared/closeEngagement.js',     // passes the route's response through
      'app/api/engagements/[id]/route.ts',             // writes it on the close
      'app/api/engagements/[id]/reopen/route.ts',      // clears it on reopen
    ])
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) { if (f !== 'node_modules' && !f.startsWith('.')) walk(p); continue }
        if (!/\.(ts|tsx|js|jsx)$/.test(f) || /\.test\./.test(f)) continue
        if (readFileSync(p, 'utf8').includes('written_off_amount') && !allowed.has(p)) hits.push(p)
      }
    }
    for (const d of ['app', 'lib', 'components']) walk(d)
    expect(hits).toEqual([])
  })
})

// ── 3. distinguishable from Won and from the owing override ────────────
describe('written off is distinguishable from Closed Won and from the owing override', () => {
  const wo = { stage: 'Closed Lost', closed_reason: WRITTEN_OFF, written_off_amount: 7694.29 }
  const override = { stage: 'Closed Won', closed_reason: WON_OVER_BALANCE }
  const lost = { stage: 'Closed Lost', closed_reason: 'No response' }

  it('three different outcomes, three different labels — never "lost", never "won"', () => {
    expect(closedOutcome(wo)).toBe('written_off')
    expect(closedOutcome(override)).toBe('won')
    expect(closedOutcome(lost)).toBe('lost')
    expect(engagementStageLabel(wo)).toBe(WRITTEN_OFF_LABEL)
    expect(engagementStageLabel(lost)).toBe('Closed lost')
    expect(isWrittenOff(override)).toBe(false)
    expect(deriveStatusChip(wo as any)?.label).toBe('Written off')
  })

  it('the two controls start with different verbs and mean opposite things', () => {
    expect(WRITE_OFF_ACTION).toMatch(/^Write it off/)
    expect(OWING_CLOSE_ACTION).toMatch(/^Close it anyway/)
    expect(WRITE_OFF_ACTION).toMatch(/isn’t coming/)
    expect(OWING_CLOSE_ACTION).toMatch(/settled in Jobber/)
    expect(WRITE_OFF_ACTION.split(' ')[0]).not.toBe(OWING_CLOSE_ACTION.split(' ')[0])
  })

  it('in the data: the override is Won + won_balance_owing; the write-off is Closed Lost + written_off', () => {
    expect(WON_OVER_BALANCE).not.toBe(WRITTEN_OFF)
  })

  it('"Written off" is no longer a Lost reason — one door, the one that records the amount', () => {
    expect(DEFAULT_CLOSE_LOST_REASONS).not.toContain('Written off')
  })
})

// ── 4. Final Processing: bad debt is never "paid", never Mark won ──────
describe('Final Processing reads bad debt as written off, not paid', () => {
  const fpEng = { stage: 'Final Processing', balance_owing: 0 }

  it('Erin\'s deal: not settled for Won, and its case is written_off (not paid, not owing)', () => {
    const inv = [erinStored()]
    expect(invoicesSettled(inv)).toBe(false)
    expect(finalProcessingCase(fpEng, inv)).toBe('written_off')
    expect(finalProcessingExplainer('written_off', inv)!.body).toMatch(/\$7,694/)
    expect(deriveStatusChip({ ...fpEng, invoices: inv } as any)?.label).toBe('Bad debt in Jobber')
  })

  it('the same before the repair (bad debt still showing its full total) — keyed on status, not balance', () => {
    expect(finalProcessingCase(fpEng, [{ status: 'bad_debt', total: 8294.29, paid_amount: null, balance_owing: 8294.29 }])).toBe('written_off')
  })

  it('bad debt plus another invoice still owed → owing (both doors offered)', () => {
    expect(finalProcessingCase(fpEng, [erinStored(), { status: 'sent', total: 300, paid_amount: 0, balance_owing: 300 }])).toBe('owing')
  })

  it('a VOIDED invoice ($0 owed, not bad debt) is settled — Mark won is right there', () => {
    expect(invoicesSettled([{ status: 'sent', total: 556.2, paid_amount: 0, balance_owing: 0 }])).toBe(true)
  })
})

// ── 5. Jobber's real balance ────────────────────────────────────────────
describe('an unpaid invoice stores Jobber\'s invoiceBalance, and what came in', () => {
  const inv = (invoiceStatus: string, amounts: any) => invoiceMoneyFromJobber({ invoiceStatus, amounts })

  it('a DEPOSIT (Eileen Schwartzman, KC): owes $509.85, $100 received', () => {
    expect(inv('past_due', { total: 609.85, paymentsTotal: 0, depositAmount: 100, invoiceBalance: 509.85 }))
      .toEqual({ paid_amount: 100, balance_owing: 509.85 })
  })

  it('a VOID (Tonya Mourning, KC): owes $0, nothing received', () => {
    expect(inv('past_due', { total: 556.2, paymentsTotal: 0, depositAmount: 0, invoiceBalance: 0 }))
      .toEqual({ paid_amount: 0, balance_owing: 0 })
  })

  it('a WRITE-OFF (Erin Bondurant, KC): owes $0, $600 received', () => {
    expect(invoiceMoneyFromJobber(ERIN_JOBBER)).toEqual({ paid_amount: 600, balance_owing: 0 })
  })

  it('a PART PAYMENT: owes the rest, the part received', () => {
    expect(inv('awaiting_payment', { total: 2000, paymentsTotal: 1000, depositAmount: 0, invoiceBalance: 1000 }))
      .toEqual({ paid_amount: 1000, balance_owing: 1000 })
  })

  it('amounts as strings (Jobber sometimes sends them so) read the same', () => {
    expect(inv('past_due', { total: '609.85', paymentsTotal: '0', depositAmount: '100', invoiceBalance: '509.85' }))
      .toEqual({ paid_amount: 100, balance_owing: 509.85 })
  })

  it('a MISSING invoiceBalance falls back to today: owes the full total, nothing recorded as received', () => {
    expect(inv('awaiting_payment', { total: 2000 })).toEqual({ paid_amount: null, balance_owing: 2000 })
  })

  it('a PAID invoice is unchanged: all of it received, nothing owed', () => {
    expect(inv('paid', { total: 750, paymentsTotal: 750, depositAmount: 0, invoiceBalance: 0 }))
      .toEqual({ paid_amount: 750, balance_owing: 0 })
  })

  it('the import\'s two invoice queries and the webhook\'s ask Jobber for it', async () => {
    const m = await import('@/lib/jobber-import')
    for (const q of [m.JOBS_QUERY, m.JOB_INVOICES_QUERY, m.SINGLE_INVOICE_QUERY]) {
      expect(q).toMatch(/invoiceBalance/)
      expect(q).toMatch(/paymentsTotal/)
      expect(q).toMatch(/depositAmount/)
    }
  })

  it('upsertInvoice stores it through invoiceMoneyFromJobber', () => {
    const src = readFileSync('lib/jobber-import.ts', 'utf8')
    expect(src).toContain('...invoiceMoneyFromJobber(invoice),')
    expect(src).not.toMatch(/balance_owing:\s*isPaid \? 0 : totalNum/)
  })
})

// ── Erin, end to end ────────────────────────────────────────────────────
describe('Erin Bondurant, pinned: $600 paid, $7,694.29 written off, Jobber balance $0', () => {
  it('stored: $0 owing, $600 received — and the write-off amount is $7,694.29', () => {
    const row = erinStored()
    expect(row.balance_owing).toBe(0)
    expect(row.paid_amount).toBe(600)
    expect(writtenOffAmountFromInvoices([row])).toBe(7694.29)
  })

  it('her deal can no longer be marked Won, and closes as Written off instead', () => {
    const row = erinStored()
    expect(invoicesSettled([row])).toBe(false)
    expect(finalProcessingCase({ stage: 'Final Processing' }, [row])).toBe('written_off')
  })
})
