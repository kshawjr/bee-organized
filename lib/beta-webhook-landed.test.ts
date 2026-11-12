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
//   — a FAILED FETCH from Jobber records 'not_landed' (2026-11): the record
//     never arrived and, since the route answers 200, never will on its own.
//     Every OTHER errored result still records 'na' (the ✗ row carries the
//     story). Zero DB reads either way.
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

import { readFileSync } from 'node:fs'
import { checkLanded, isFailedFetch } from '@/lib/webhook-landed'
import { DESTROY_SPECS } from '@/lib/jobber-webhook-handlers'
import { isUnbookedJobStatus } from '@/lib/jobber-import'

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

describe('checkLanded — JOB_CREATE (unbooked carve-out mirrors the handler)', () => {
  // handleJobCore deliberately does NOT promote an unbooked job
  // (unscheduled / action_required / on_hold) to 'Job in Progress' — the
  // engagement rests at 'Estimate'. The landed check must accept that as
  // landed, or every correctly-handled unbooked JOB_CREATE reads not_landed
  // (Susan Garrity / #97). Booked jobs keep the ≥ 'Job in Progress' bar.

  it('unbooked job (unscheduled) + engagement at Estimate → landed', async () => {
    h.enqueue('jobs', { id: 'j1', engagement_id: 'e1', status: 'unscheduled' })
    h.enqueue('engagements', { stage: 'Estimate' })
    expect(await checkLanded(ctx('JOB_CREATE'), ok())).toBe('landed')
  })

  it('booked job + engagement stuck at Estimate → not_landed (rank rule still bites)', async () => {
    h.enqueue('jobs', { id: 'j1', engagement_id: 'e1', status: 'in_progress' })
    h.enqueue('engagements', { stage: 'Estimate' })
    expect(await checkLanded(ctx('JOB_CREATE'), ok())).toBe('not_landed')
  })

  it('booked job + engagement advanced to Job in Progress → landed', async () => {
    h.enqueue('jobs', { id: 'j1', engagement_id: 'e1', status: 'in_progress' })
    h.enqueue('engagements', { stage: 'Job in Progress' })
    expect(await checkLanded(ctx('JOB_CREATE'), ok())).toBe('landed')
  })

  it('jobs row missing entirely (upsert never wrote) → not_landed', async () => {
    // queue empty → maybeSingle resolves { data: null }
    expect(await checkLanded(ctx('JOB_CREATE'), ok())).toBe('not_landed')
  })

  it('jobs row present but engagement_id null → not_landed', async () => {
    h.enqueue('jobs', { id: 'j1', engagement_id: null, status: 'unscheduled' })
    expect(await checkLanded(ctx('JOB_CREATE'), ok())).toBe('not_landed')
  })

  // Drift guard: the unbooked branch must be driven by the SAME predicate
  // the handler uses (isUnbookedJobStatus, imported from jobber-import), not
  // a re-listed status set. For each status at engagement='Estimate', the
  // verdict must equal isUnbookedJobStatus(status) — so a divergent local
  // list would fail here.
  it('unbooked/booked decision tracks the imported isUnbookedJobStatus predicate', async () => {
    const statuses = [
      'unscheduled', 'action_required', 'on_hold',   // unbooked
      'in_progress', 'today', 'upcoming', 'completed', 'unknown', // booked/other
    ]
    for (const status of statuses) {
      h.reset()
      h.enqueue('jobs', { id: 'j1', engagement_id: 'e1', status })
      h.enqueue('engagements', { stage: 'Estimate' })
      const landed = await checkLanded(ctx('JOB_CREATE'), ok())
      expect(landed, `status=${status}`).toBe(
        isUnbookedJobStatus(status) ? 'landed' : 'not_landed',
      )
    }
  })

  it('imports the predicate instead of re-listing the unbooked statuses', () => {
    const src = readFileSync(new URL('./webhook-landed.ts', import.meta.url), 'utf8')
    expect(src).toMatch(
      /import\s*\{[^}]*isUnbookedJobStatus[^}]*\}\s*from\s*'\.\/jobber-import'/,
    )
    // No duplicated status Set — quoted literals of the unbooked values
    // would mean the list was copied instead of imported.
    expect(src).not.toMatch(/['"]on_hold['"]/)
    expect(src).not.toMatch(/['"]action_required['"]/)
  })
})

describe('checkLanded — errored + processed-only results', () => {
  // ── a failed fetch did not land ────────────────────────────────
  // 432 of these were logged 'na' over ten weeks — every one a webhook whose
  // record was never fetched (no_valid_jobber_token) — which is why the one
  // column built to show "didn't land" never showed the biggest cause of it.
  it.each([
    ['REQUEST_CREATE',  'request_fetch: no_valid_jobber_token'],
    ['REQUEST_UPDATE',  'request_fetch: no_valid_jobber_token'],
    ['QUOTE_UPDATE',    'quote_fetch: no_valid_jobber_token'],
    ['JOB_COMPLETE',    'job_fetch: no_valid_jobber_token'],
    ['INVOICE_UPDATE',  'invoice_fetch: no_valid_jobber_token'],
    ['CLIENT_UPDATE',   'client_fetch: no_valid_jobber_token'],
    ['PROPERTY_CREATE', 'property_fetch: no_valid_jobber_token'],
    ['QUOTE_CREATE',    'request_fetch: jobber_reauth_required'],   // parent-request fallback
    ['JOB_UPDATE',      'job_fetch: Throttled'],                     // any GraphQL error on the fetch
    ['JOB_UPDATE',      'Jobber GraphQL HTTP 503: upstream'],        // thrown by lib/jobber, caught by the route
  ])('%s failing with "%s" → not_landed, zero DB reads', async (topic, error) => {
    const res = await checkLanded(ctx(topic), { processed: false, error })
    expect(res).toBe('not_landed')
    expect(h.state.calls.length).toBe(0)
  })

  it.each([
    'quote_no_matching_lead',
    'job_no_matching_lead',
    'invoice_no_matching_lead',
    'job_not_found_in_jobber',
    'request_not_found_in_jobber',
    'request_missing_client',
    'app_disconnect_write: boom',
    'TypeError: cannot read properties of undefined',
  ])('errored for another reason ("%s") → still na, zero DB reads', async (error) => {
    const res = await checkLanded(ctx('JOB_COMPLETE'), { processed: false, error })
    expect(res).toBe('na')
    expect(h.state.calls.length).toBe(0)
  })

  it('processed=false with no error text → na', async () => {
    expect(await checkLanded(ctx('JOB_COMPLETE'), { processed: false })).toBe('na')
  })

  it('isFailedFetch matches the strings the handlers and lib/jobber really produce', () => {
    const handlers = readFileSync(new URL('./jobber-webhook-handlers.ts', import.meta.url), 'utf8')
    for (const entity of ['request', 'quote', 'job', 'invoice', 'client', 'property']) {
      expect(handlers, entity).toContain('`' + entity + '_fetch: ${')
      expect(isFailedFetch(`${entity}_fetch: anything`), entity).toBe(true)
    }
    const jobber = readFileSync(new URL('./jobber.ts', import.meta.url), 'utf8')
    expect(jobber).toContain('throw new Error(`Jobber GraphQL HTTP ${res.status}:')
    expect(isFailedFetch(null)).toBe(false)
    expect(isFailedFetch('')).toBe(false)
  })

  // The absorbers. A failed fetch is now BOTH status='error' AND not_landed;
  // two readers would otherwise say the wrong thing about it.
  it('health tiles: the not-landed count leaves out rows that errored (no double count)', () => {
    const src = readFileSync(new URL('../app/api/admin/system-health/route.ts', import.meta.url), 'utf8')
    expect(src).toContain(".eq('landed_status', 'not_landed').neq('status', 'error')")
    // both tiles still add the two numbers — which is why the filter matters
    for (const f of ['../components/hive/HomeSystemHealth.jsx', '../components/admin/SystemHealthScreen.jsx']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).toContain('(w.failed || 0) + (w.notLanded || 0)')
    }
  })

  it('webhook dashboard: a failed row that did not land is not described as "Processed"', () => {
    const src = readFileSync(new URL('../components/BeeHub.jsx', import.meta.url), 'utf8')
    expect(src).toContain(`e.landed === 'stuck' ? (e.processed ? "Processed but didn't land — record not in expected state" : "Failed and didn't land — the record was never fetched from Jobber")`)
  })

  it('CLIENT_UPDATE (plain refresh, no note) → na, zero DB reads', async () => {
    expect(await checkLanded(ctx('CLIENT_UPDATE'), ok())).toBe('na')
    expect(h.state.calls.length).toBe(0)
  })

  it('CLIENT_UPDATE→archived + lead has archived_at → landed (#122)', async () => {
    h.enqueue('leads', { archived_at: '2026-07-31T05:48:05Z' })
    expect(
      await checkLanded(ctx('CLIENT_UPDATE'), ok({ note: 'CLIENT_UPDATE→archived' })),
    ).toBe('landed')
  })

  it('CLIENT_UPDATE→archived but archived_at still NULL → not_landed (#122)', async () => {
    h.enqueue('leads', { archived_at: null })
    expect(
      await checkLanded(ctx('CLIENT_UPDATE'), ok({ note: 'CLIENT_UPDATE→archived' })),
    ).toBe('not_landed')
  })

  it('CLIENT_UPDATE→unarchived + archived_at cleared → landed (#122)', async () => {
    h.enqueue('leads', { archived_at: null })
    expect(
      await checkLanded(ctx('CLIENT_UPDATE'), ok({ note: 'CLIENT_UPDATE→unarchived' })),
    ).toBe('landed')
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

  it('REQUEST_UPDATE→archived (#122) → na, NOT the destroy-column check', async () => {
    // Archived request: the #66 cleanup may have deleted the SR (childless) or
    // kept it (had work). No single post-condition row proves success, and we
    // deliberately do NOT null jobber_request_id — so this must NOT route into
    // checkDestroyLanded (which would demand the columns be null) nor the plain
    // REQUEST_UPDATE "SR exists" rule (which would false-alarm on the empty case).
    expect(
      await checkLanded(
        ctx('REQUEST_UPDATE'),
        ok({ note: 'REQUEST_UPDATE→archived; REQUEST_DESTROY: deleted stale SR sr-1; closed empty engagement eng-1 (request_destroyed)' }),
      ),
    ).toBe('na')
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
