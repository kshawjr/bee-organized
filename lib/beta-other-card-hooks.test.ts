// @vitest-environment node
//
// The instant edits of Other's Slack card (lib/other-card-sync) at each way a
// lead leaves Other, naming who did it:
//   • PATCH /api/leads/:id — binned, dismissed, snoozed (behaviour, below)
//   • the Network move, and the wiring of every hook (source pins at the end)
// The transfer and no-coverage hooks are pinned in their own suites
// (beta-lead-transfer-shared, beta-no-coverage-guard).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = { queue: [] as { table: string; resp: Resp }[] }
  const reset = () => { state.queue = [] }
  const enqueue = (table: string, data: any, error: any = null) => state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex((q) => q.table === table)
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
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'hu-leslie' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/dual-write', () => ({ updateLead: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-contact-sync', () => ({ syncLeadContactToJobber: vi.fn(async () => null) }))
vi.mock('@/lib/jobber-address-sync', () => ({ syncLeadAddressToJobber: vi.fn(async () => null) }))
vi.mock('@/lib/other-card-sync', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    retireOtherCards: vi.fn(async () => ({ edited: 1, failed: 0 })),
    actorName: vi.fn(async (id: string) => (id === 'hu-leslie' ? 'Leslie Mullins' : null)),
  }
})

import { PATCH } from '@/app/api/leads/[id]/route'
import { updateLead } from '@/lib/dual-write'
import { retireOtherCards } from '@/lib/other-card-sync'

const LEAD = { id: 'lead-1', location_uuid: 'uuid-other', location_id: 'loc_other', stage: 'New', jobber_client_id: null, phone: null, email: null, address: null, city: null, state: null, zip: null, addresses: [] }
const arm = () => {
  h.enqueue('hub_users', { id: 'hu-leslie', role: 'admin', location_id: null })
  h.enqueue('leads', LEAD)
  h.enqueue('leads', { ...LEAD })
}
const patch = (body: any) => PATCH({ json: async () => body } as any, { params: Promise.resolve({ id: 'lead-1' }) } as any)

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

describe('PATCH /api/leads/:id edits Other\'s card when the lead leaves the queue', () => {
  it('binned → "🗑 Binned by Leslie Mullins."', async () => {
    arm()
    const res = await patch({ is_junk: true })
    expect(res.status).toBe(200)
    expect(retireOtherCards).toHaveBeenCalledWith({ leadId: 'lead-1', resolution: 'binned', line: '🗑 Binned by Leslie Mullins.' })
  })

  it('dismissed → "📥 Dismissed by Leslie Mullins."', async () => {
    arm()
    await patch({ inbox_dismissed_at: '2026-10-21T10:00:00Z' })
    expect(retireOtherCards).toHaveBeenCalledWith({ leadId: 'lead-1', resolution: 'dismissed', line: '📥 Dismissed by Leslie Mullins.' })
  })

  it('snoozed into the future → "💤 Snoozed until …", with the date', async () => {
    arm()
    const until = new Date(Date.now() + 4 * 86400000).toISOString()
    await patch({ snoozed_until: until })
    const call = vi.mocked(retireOtherCards).mock.calls[0][0]
    expect(call.resolution).toBe('snoozed')
    expect(call.line).toMatch(/^💤 Snoozed until \w{3} \d{1,2} by Leslie Mullins\. Its card comes back when the snooze ends\.$/)
  })

  it.each([
    ['a restore from the bin', { is_junk: false }],
    ['an undone dismiss', { inbox_dismissed_at: null }],
    ['a snooze cleared', { snoozed_until: null }],
    ['a snooze date already past', { snoozed_until: '2020-01-01T00:00:00Z' }],
    ['an ordinary edit', { project_type: 'Garage' }],
  ])('%s → no edit (the sweep reposts a lead that comes back)', async (_what, body) => {
    arm()
    await patch(body)
    expect(retireOtherCards).not.toHaveBeenCalled()
  })

  it('the write failing → no edit (the lead is still in the queue)', async () => {
    arm()
    vi.mocked(updateLead).mockRejectedValueOnce(new Error('db down'))
    const res = await patch({ is_junk: true })
    expect(res.status).toBe(500)
    expect(retireOtherCards).not.toHaveBeenCalled()
  })

  it('a failed card edit never fails the PATCH', async () => {
    arm()
    vi.mocked(retireOtherCards).mockRejectedValueOnce(new Error('slack down'))
    expect((await patch({ is_junk: true })).status).toBe(200)
  })
})

describe('every way out of Other is wired (source pins)', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('the Network move edits the card, only in move mode, after the lead write', () => {
    const s = read('app/api/leads/[id]/network/route.ts')
    const write = s.indexOf('await updateLead(id, leadPatch as any)')
    const hook = s.indexOf("await retireOtherCards({ leadId: id, resolution: 'network', line: exitLine('network', { who: await actorName(caller.userId) }) })")
    expect(write).toBeGreaterThan(-1)
    expect(hook).toBeGreaterThan(write)
    expect(s.slice(write, hook)).toContain("if (mode === 'move') {")
  })

  it.each([
    ['lib/lead-transfer.ts', "resolution: 'moved'"],
    ['lib/lead-no-coverage.ts', "resolution: 'no_coverage'"],
    ['app/api/leads/[id]/route.ts', 'resolution: exit'],
    ['app/api/leads/[id]/network/route.ts', "resolution: 'network'"],
  ])('%s calls retireOtherCards (%s)', (file, marker) => {
    const s = read(file)
    expect(s).toContain('retireOtherCards(')
    expect(s).toContain(marker)
  })

  it('the sweep is registered every 5 minutes', () => {
    const crons = JSON.parse(read('vercel.json')).crons
    expect(crons).toContainEqual({ path: '/api/cron/other-cards', schedule: '*/5 * * * *' })
  })
})
