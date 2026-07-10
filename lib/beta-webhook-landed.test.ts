// @vitest-environment node
//
// checkLanded — recorded "landed" verification (webhook observability
// Phase 1). Pins per rule:
//   — landed is judged by RE-READING record state, never by "no error
//     threw": a JOB_COMPLETE whose engagement never advanced records
//     'not_landed' even though the handler returned processed=true
//     (the silent-stuck case the dashboard's amber rows surface)
//   — JOB_COMPLETE requires rank ≥ 'Job in Progress', NOT ≥ 'Final
//     Processing' (a sibling job still open legitimately holds the
//     engagement — that is not stuck)
//   — errored results record 'na' (the ✗ row carries the story), and
//     the check does zero DB reads for them
//   — CLIENT_UPDATE is processed-only → 'na', zero DB reads
//   — destroys verify the DESTROY_SPECS columns are actually null on
//     the matched lead; a no-op destroy (no lead matched) is 'na'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabaseService mock (stage-drift pattern): chainable
//    builder, per-table FIFO response queues. ────────────────────
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
}))
vi.mock('@/lib/jobber-disconnect', () => ({
  disconnectJobberFromLocation: vi.fn(async () => ({ error: null })),
}))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn() }))

import { checkLanded } from '@/lib/webhook-landed'
import { DESTROY_SPECS } from '@/lib/jobber-webhook-handlers'

const ctx = (topic: string, itemId = '555') => ({
  topic,
  itemId,
  location: { id: 'loc-uuid-1', location_id: 'loc_test' } as any,
})
const ok = (over: any = {}) => ({ processed: true, lead_id: 'lead-1', ...over })

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

describe('checkLanded — JOB_COMPLETE (the key silent-stuck case)', () => {
  const doneJob = {
    id: 'j1', engagement_id: 'e1',
    status: 'complete', completed_at: '2026-07-01T00:00:00Z',
  }

  it('job done + engagement attached + stage advanced → landed', async () => {
    h.enqueue('jobs', doneJob)
    h.enqueue('engagements', { stage: 'Job in Progress' })
    expect(await checkLanded(ctx('JOB_COMPLETE'), ok())).toBe('landed')
  })

  it('rank ≥ Job in Progress is enough — Final Processing NOT required (sibling-job case)', async () => {
    h.enqueue('jobs', doneJob)
    h.enqueue('engagements', { stage: 'Closed Won' })
    expect(await checkLanded(ctx('JOB_COMPLETE'), ok())).toBe('landed')
  })

  it('processed ok but engagement never advanced (stage still Estimate) → not_landed', async () => {
    h.enqueue('jobs', doneJob)
    h.enqueue('engagements', { stage: 'Estimate' })
    expect(await checkLanded(ctx('JOB_COMPLETE'), ok())).toBe('not_landed')
  })

  it('processed ok but job never attached to an engagement → not_landed', async () => {
    h.enqueue('jobs', { ...doneJob, engagement_id: null })
    expect(await checkLanded(ctx('JOB_COMPLETE'), ok())).toBe('not_landed')
  })

  it('job row not marked done → not_landed', async () => {
    h.enqueue('jobs', { id: 'j1', engagement_id: 'e1', status: 'active', completed_at: null })
    expect(await checkLanded(ctx('JOB_COMPLETE'), ok())).toBe('not_landed')
  })

  it('jobs row missing entirely (upsert never wrote) → not_landed', async () => {
    // queue empty → maybeSingle resolves { data: null }
    expect(await checkLanded(ctx('JOB_COMPLETE'), ok())).toBe('not_landed')
  })
})

describe('checkLanded — errored + processed-only results', () => {
  it('errored result → na, zero DB reads', async () => {
    const res = await checkLanded(
      ctx('JOB_COMPLETE'),
      { processed: false, error: 'job_fetch: boom' },
    )
    expect(res).toBe('na')
    expect(h.state.calls.length).toBe(0)
  })

  it('CLIENT_UPDATE → na, zero DB reads', async () => {
    expect(await checkLanded(ctx('CLIENT_UPDATE'), ok())).toBe('na')
    expect(h.state.calls.length).toBe(0)
  })

  it('unknown topic → na', async () => {
    expect(await checkLanded(ctx('SOMETHING_ELSE'), ok())).toBe('na')
  })
})

describe('checkLanded — quotes', () => {
  it('QUOTE_CREATE attached + engagement at Estimate → landed', async () => {
    h.enqueue('quotes', { id: 'q1', engagement_id: 'e1' })
    h.enqueue('engagements', { stage: 'Estimate' })
    expect(await checkLanded(ctx('QUOTE_CREATE'), ok())).toBe('landed')
  })

  it('QUOTE_SENT attached but engagement still at Request → not_landed', async () => {
    h.enqueue('quotes', { id: 'q1', engagement_id: 'e1' })
    h.enqueue('engagements', { stage: 'Request' })
    expect(await checkLanded(ctx('QUOTE_SENT'), ok())).toBe('not_landed')
  })

  it('QUOTE_APPROVED with approved_at stamped → landed', async () => {
    h.enqueue('quotes', { id: 'q1', engagement_id: 'e1', status: 'sent', approved_at: '2026-07-01T00:00:00Z' })
    expect(await checkLanded(ctx('QUOTE_APPROVED'), ok())).toBe('landed')
  })

  it('QUOTE_APPROVED processed but quote row never marked approved → not_landed', async () => {
    h.enqueue('quotes', { id: 'q1', engagement_id: 'e1', status: 'sent', approved_at: null })
    expect(await checkLanded(ctx('QUOTE_APPROVED'), ok())).toBe('not_landed')
  })

  it('QUOTE_UPDATE is row-written only: row exists → landed', async () => {
    h.enqueue('quotes', { id: 'q1' })
    expect(await checkLanded(ctx('QUOTE_UPDATE'), ok())).toBe('landed')
  })
})

describe('checkLanded — requests + invoices', () => {
  it('REQUEST_CREATE with engagement founded → landed', async () => {
    h.enqueue('service_requests', { id: 'sr1', engagement_id: 'e1' })
    expect(await checkLanded(ctx('REQUEST_CREATE'), ok())).toBe('landed')
  })

  it('REQUEST_CREATE row written but engagement founding silently failed → not_landed', async () => {
    h.enqueue('service_requests', { id: 'sr1', engagement_id: null })
    expect(await checkLanded(ctx('REQUEST_CREATE'), ok())).toBe('not_landed')
  })

  it('INVOICE_PAID with invoice row paid + attached → landed', async () => {
    h.enqueue('invoices', { id: 'i1', engagement_id: 'e1', status: 'paid' })
    expect(await checkLanded(ctx('INVOICE_PAID'), ok())).toBe('landed')
  })

  it('INVOICE_PAID processed but invoice row never marked paid → not_landed', async () => {
    h.enqueue('invoices', { id: 'i1', engagement_id: 'e1', status: 'sent' })
    expect(await checkLanded(ctx('INVOICE_PAID'), ok())).toBe('not_landed')
  })

  it('INVOICE_CREATE attached → landed', async () => {
    h.enqueue('invoices', { id: 'i1', engagement_id: 'e1' })
    expect(await checkLanded(ctx('INVOICE_CREATE'), ok())).toBe('landed')
  })
})

describe('checkLanded — destroys verify the DESTROY_SPECS columns', () => {
  it('CLIENT_DESTROY with every linkage column nulled → landed', async () => {
    const lead: any = {}
    for (const c of DESTROY_SPECS.CLIENT_DESTROY.nulls) lead[c] = null
    h.enqueue('leads', lead)
    expect(await checkLanded(ctx('CLIENT_DESTROY'), ok())).toBe('landed')
  })

  it('CLIENT_DESTROY with a column still set → not_landed', async () => {
    const lead: any = {}
    for (const c of DESTROY_SPECS.CLIENT_DESTROY.nulls) lead[c] = null
    lead.jobber_job_id = '999' // the write silently missed one
    h.enqueue('leads', lead)
    expect(await checkLanded(ctx('CLIENT_DESTROY'), ok())).toBe('not_landed')
  })

  it('destroy that matched no lead (documented no-op) → na', async () => {
    expect(
      await checkLanded(ctx('QUOTE_DESTROY'), { processed: true, note: 'QUOTE_DESTROY: no matching lead for jobber_quote_id=555 (no-op)' }),
    ).toBe('na')
    expect(h.state.calls.length).toBe(0)
  })

  it('REQUEST_UPDATE soft-destroy verifies like REQUEST_DESTROY', async () => {
    h.enqueue('leads', { jobber_request_id: null, jobber_assessment_id: null })
    expect(
      await checkLanded(
        ctx('REQUEST_UPDATE'),
        ok({ note: 'REQUEST_UPDATE→soft-destroy: nulled jobber_request_id, jobber_assessment_id on lead "x"' }),
      ),
    ).toBe('landed')
  })
})

describe('checkLanded — property + disconnect', () => {
  it('PROPERTY_UPDATE with lead pointing at this property → landed', async () => {
    h.enqueue('leads', { jobber_property_id: '555' })
    expect(await checkLanded(ctx('PROPERTY_UPDATE'), ok())).toBe('landed')
  })

  it('PROPERTY_CREATE processed but jobber_property_id never set → not_landed', async () => {
    h.enqueue('leads', { jobber_property_id: null })
    expect(await checkLanded(ctx('PROPERTY_CREATE'), ok())).toBe('not_landed')
  })

  it('PROPERTY_* with no matching lead (no-op) → na', async () => {
    expect(
      await checkLanded(ctx('PROPERTY_CREATE'), { processed: true, note: 'PROPERTY_CREATE: no matching lead for property=555 client=1 (no-op)' }),
    ).toBe('na')
  })

  it('APP_DISCONNECT with location actually flipped → landed', async () => {
    h.enqueue('locations', { jobber_connected: false })
    expect(await checkLanded(ctx('APP_DISCONNECT'), ok({ lead_id: undefined }))).toBe('landed')
  })

  it('APP_DISCONNECT processed but location still shows connected → not_landed', async () => {
    h.enqueue('locations', { jobber_connected: true })
    expect(await checkLanded(ctx('APP_DISCONNECT'), ok({ lead_id: undefined }))).toBe('not_landed')
  })
})
