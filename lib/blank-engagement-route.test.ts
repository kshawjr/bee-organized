// @vitest-environment node
//
// THE BLANK RULE at POST /api/engagements (2026-09-28). The route is the
// only door a screen has to a hand-made engagement, and it refuses one that
// doesn't say what the work is — FIRST, before the lead read, before
// reuse_open's lookup, before the founding. A blank request costs nothing
// but a 400. See blank-engagement-rule.test.ts for the function underneath.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number }
  const state = { queue: [] as { table: string; resp: Resp }[], tables: [] as string[] }
  const reset = () => { state.queue = []; state.tables = [] }
  const enqueue = (table: string, data: any, error: any = null, count?: number) =>
    state.queue.push({ table, resp: { data, error, count } })
  const makeBuilder = (table: string) => {
    state.tables.push(table)
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) b[m] = () => b
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
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
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: vi.fn(async () => null) }))
vi.mock('@/lib/lead-suppression', () => ({ fetchSuppressedLeadIds: vi.fn(async () => new Set()) }))
vi.mock('@/lib/engagements', () => ({
  foundManualEngagement: vi.fn(async (p: any) => ({ engagement: { id: 'eng-NEW', stage: 'Request', title: p.title, description: p.description }, created: true })),
  findOpenEngagementForClient: vi.fn(async () => null),
  BLANK_ENGAGEMENT_ERROR: 'blank_engagement',
}))

import { POST } from '@/app/api/engagements/route'
import { foundManualEngagement, findOpenEngagementForClient } from '@/lib/engagements'

const arm = () => {
  h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
  h.enqueue('leads', { id: 'c1', name: 'Martha Wassel', phone: null, email: null, location_uuid: 'loc-1' })
}
const post = (body: any) => POST(new Request('http://test/api/engagements', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}))

beforeEach(() => {
  h.reset()
  vi.mocked(foundManualEngagement).mockClear()
  vi.mocked(findOpenEngagementForClient).mockClear().mockResolvedValue(null as any)
})

describe('POST /api/engagements will not create an engagement with nothing on it', () => {
  const BLANKS: Array<[string, any]> = [
    ['no title', {}],
    ['title: null', { title: null }],
    ['an empty title', { title: '' }],
    ['a whitespace title', { title: '    ' }],
    ['a three-character title', { title: 'Tub' }],
    ['a description but no title', { description: 'She wants the garage done' }],
  ]
  for (const reuse of [false, true]) {
    for (const [what, extra] of BLANKS) {
      it(`${what}${reuse ? ' (reuse_open)' : ''} → 400 blank_engagement, nothing looked up, nothing founded`, async () => {
        arm()
        const res = await post({ client_id: 'c1', ...(reuse ? { reuse_open: true } : {}), ...extra })
        expect(res.status).toBe(400)
        const j = await res.json()
        expect(j.error).toBe('blank_engagement')
        expect(j.message).toMatch(/what the work is/)
        expect(foundManualEngagement).not.toHaveBeenCalled()
        expect(findOpenEngagementForClient).not.toHaveBeenCalled()
        // Refused before the lead read: the only table touched is the
        // caller's own hub_users row (auth).
        expect(h.state.tables).not.toContain('leads')
        expect(h.state.tables).not.toContain('engagements')
      })
    }
  }

  it('a title that is not a string is refused', async () => {
    arm()
    const res = await post({ client_id: 'c1', title: 4242 })
    expect(res.status).toBe(400)
    expect(foundManualEngagement).not.toHaveBeenCalled()
  })

  it('if the function underneath refuses, the route says 400 blank_engagement (not a 500)', async () => {
    arm()
    vi.mocked(foundManualEngagement).mockResolvedValueOnce({ error: 'blank_engagement: say what the work is' } as any)
    const res = await post({ client_id: 'c1', title: 'Garage shelving' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('blank_engagement')
  })

  it('a described job founds, and what was typed is handed through untouched', async () => {
    arm()
    h.enqueue('engagements', null, null, 2) // repeat count
    const res = await post({ client_id: 'c1', title: 'Bedroom closet', description: 'Wants it by December.' })
    expect(res.status).toBe(201)
    expect(foundManualEngagement).toHaveBeenCalledTimes(1)
    expect(vi.mocked(foundManualEngagement).mock.calls[0][0]).toMatchObject({
      clientId: 'c1', title: 'Bedroom closet', description: 'Wants it by December.',
    })
    const j = await res.json()
    // The row comes back carrying an EMPTY request list, so the card can
    // say it has not reached Jobber from the moment it appears.
    expect(j.engagement.service_requests).toEqual([])
    expect(j.engagement.title).toBe('Bedroom closet')
  })

  it('a description over 2000 characters is refused, not truncated silently', async () => {
    arm()
    const res = await post({ client_id: 'c1', title: 'Bedroom closet', description: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
    expect(foundManualEngagement).not.toHaveBeenCalled()
  })
})
