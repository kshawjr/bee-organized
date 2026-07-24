// @vitest-environment node
// /api/leads/intake — ONE vocabulary for leads.source.
//
// Make scenarios stamp per-form slugs (seattle_assessment, web_form,
// facebook_lead_ad) that were stored raw. The admin lead_sources vocab is
// human labels, so the Source picker couldn't check-mark a slug — and
// selecting anything silently overwrote the attribution. These tests pin
// the intake-side normalization that closes that trap:
//   · *_assessment slugs and web_form/website_form land as 'Website'
//   · contract slugs facebook_lead_ad / instagram_lead_ad land as labels
//   · absent source lands as 'Website' (this door IS the website form)
//   · human labels pass through untouched
//   · UNKNOWN slugs pass through verbatim — a new producer slug must
//     surface off-vocab and visible, never be silently misfiled
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalizeLeadSource, DEFAULT_LEAD_SOURCE } from '@/lib/lead-source'

// ── mock supabaseService: recording query-builder with per-table FIFO
//    response queues (same harness as beta-intake-dedup.test.ts).
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
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte']) {
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
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => {}),
}))
vi.mock('@/lib/drip-send', () => ({
  sendDripStep: vi.fn(async () => ({ sent: true })),
}))
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))

import { POST } from '@/app/api/leads/intake/route'
import { writeSyncLog } from '@/lib/sync-log'

const LOC = {
  id: 'loc-uuid-1',
  name: 'Boulder',
  location_id: 'boulder-01',
  lifecycle_status: 'onboarding',
}

const makeReq = (body: any, key = 'test-key') => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? key : null) },
  json: async () => body,
}) as any

const submission = (over: any = {}) => ({
  location_slug: 'boulder-01',
  full_name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  ...over,
})

const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const insertPayloads = (table: string) =>
  callsFor(table).flatMap(c => c.ops.filter(o => o[0] === 'insert').map(o => o[1][0]))

// Clean-insert path: strong-key query → none, name query → none, insert.
const enqueueNoMatchInsert = (id = 'lead-new-1') => {
  h.enqueue('leads', []) // strong keys
  h.enqueue('leads', []) // name
  h.enqueue('leads', { id })
}

const postSource = async (source: string | undefined) => {
  enqueueNoMatchInsert()
  const res = await POST(makeReq(submission(source === undefined ? {} : { source })))
  const body = await res.json()
  expect(body.success).toBe(true)
  const ins = insertPayloads('leads')
  expect(ins).toHaveLength(1)
  return ins[0].source
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  process.env.LEAD_INTAKE_API_KEY = 'test-key'
  h.enqueue('locations', LOC)
})

// ═══ normalizeLeadSource — the vocabulary seam ═════════════
describe('normalizeLeadSource', () => {
  it('maps every *_assessment scenario slug to Website', () => {
    for (const slug of ['global_assessment', 'seattle_assessment', 'nwarkansas_assessment', 'rhodeisland_assessment']) {
      expect(normalizeLeadSource(slug)).toBe('Website')
    }
  })
  it('maps the contract slugs to their labels', () => {
    expect(normalizeLeadSource('web_form')).toBe('Website')
    expect(normalizeLeadSource('website_form')).toBe('Website')
    expect(normalizeLeadSource('facebook_lead_ad')).toBe('Facebook')
    expect(normalizeLeadSource('instagram_lead_ad')).toBe('Instagram')
  })
  it('passes human labels through untouched', () => {
    for (const label of ['Website', 'Referral', 'Word of Mouth', 'Manual', 'TikTok']) {
      expect(normalizeLeadSource(label)).toBe(label)
    }
  })
  it('passes UNKNOWN slugs through verbatim — off-vocab must stay visible, never be misfiled', () => {
    expect(normalizeLeadSource('smoke_test')).toBe('smoke_test')
    expect(normalizeLeadSource('scout_test')).toBe('scout_test')
    expect(normalizeLeadSource('tiktok_lead_gen')).toBe('tiktok_lead_gen')
  })
  it('empty / non-string → null (callers apply the Website default)', () => {
    expect(normalizeLeadSource('')).toBeNull()
    expect(normalizeLeadSource('   ')).toBeNull()
    expect(normalizeLeadSource(null)).toBeNull()
    expect(normalizeLeadSource(undefined)).toBeNull()
    expect(DEFAULT_LEAD_SOURCE).toBe('Website')
  })
})

// ═══ intake route — stored value is the normalized label ═══
describe('intake stores normalized source', () => {
  it('assessment scenario slug lands as Website', async () => {
    expect(await postSource('seattle_assessment')).toBe('Website')
  })
  it('facebook_lead_ad lands as Facebook', async () => {
    expect(await postSource('facebook_lead_ad')).toBe('Facebook')
  })
  it('absent source defaults to Website (not the web_form slug)', async () => {
    expect(await postSource(undefined)).toBe('Website')
  })
  it('a human label passes through untouched', async () => {
    expect(await postSource('Referral')).toBe('Referral')
  })
  it('an unknown slug is stored verbatim, not misfiled', async () => {
    expect(await postSource('smoke_test')).toBe('smoke_test')
  })
  it('sync_log success row reports the normalized source', async () => {
    await postSource('katy_assessment')
    const messages = vi.mocked(writeSyncLog).mock.calls.map(c => (c[0] as any)?.message ?? '')
    expect(messages.some(m => m.includes('source=Website'))).toBe(true)
    expect(messages.some(m => m.includes('katy_assessment'))).toBe(false)
  })
})
