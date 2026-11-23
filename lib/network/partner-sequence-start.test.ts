// @vitest-environment node
//
// Partner emails, slice 5 (2026-11-23): START AND STOP, proven AT THE ROUTE
// (app/api/network/contacts/[id]/sequences), not on the screen. A small
// in-memory database answers the route's reads and applies its writes, with
// none of the real database's triggers: every refusal here is the SERVER's
// own. (The same start/stop against a real Postgres copy with the triggers
// is the PGlite run in the slice 5 report.) The first email's inline send is
// recorded, not run (the sender has its own tests and the PGlite run).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => {
  const st = {
    tables: {} as Record<string, any[]>,
    block: {} as Record<string, string | null>,
    blockError: false,
    hubUser: { id: 'u-own', role: 'super_admin', location_id: 'loc-1' } as any,
    gateRoles: ['super_admin'] as string[],
    inlineSends: [] as string[],
    writes: [] as any[],
    reads: [] as string[],
    pathOverride: null as any,
    seq: 0,
  }
  // PostgREST or=(…), just the shapes the route sends: "a.eq.x,and(b.eq.y,c.gte.z)".
  const split = (s: string) => { const out: string[] = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && !d) { out.push(cur); cur = '' } else cur += ch } out.push(cur); return out }
  const orMatch = (row: any, expr: string, all = false): boolean => {
    const parts = split(expr).map((it) => {
      const m = /^(and|or)\(([\s\S]*)\)$/.exec(it)
      if (m) return orMatch(row, m[2], m[1] === 'and')
      const [c, op, ...rest] = it.split('.'); const v = rest.join('.')
      return match(row, [[op, c, v]])
    })
    return all ? parts.every(Boolean) : parts.some(Boolean)
  }
  const match = (row: any, f: any[]): boolean => f.every(([op, c, v]) => {
    if (op === 'or') return orMatch(row, c)
    const x = row[c]
    if (op === 'eq') return v === null ? x == null : x === v
    if (op === 'lt') return x != null && x < v
    if (op === 'lte') return x != null && x <= v
    if (op === 'gte') return x != null && x >= v
    if (op === 'is') return v === null ? x == null : x === v
    throw new Error('fake db: ' + op)
  })
  const from = (table: string) => {
    const f: any[] = []
    let op = 'select'; let patch: any = null; let head = false; let order: any = null; let lim: number | null = null
    const b: any = {}
    b.select = (_s: string, o?: any) => { if (o?.head) head = true; return b }
    for (const m of ['eq', 'lt', 'lte', 'gte', 'is']) b[m] = (c: string, v: any) => { f.push([m, c, v]); return b }
    b.or = (expr: string) => { f.push(['or', expr]); return b }
    b.order = (c: string, o: any) => { order = [c, o?.ascending !== false]; return b }
    b.limit = (n: number) => { lim = n; return b }
    b.update = (p: any) => { op = 'update'; patch = p; return b }
    b.insert = (p: any) => { op = 'insert'; patch = p; return b }
    const run = (single: boolean) => {
      const rows = (st.tables[table] ||= [])
      if (op === 'insert') {
        const row = { id: `new-${++st.seq}`, status: 'active', ...patch }
        if (table === 'partner_drip_progress') {
          const p = st.tables.drip_paths.find((x) => x.id === row.drip_path_id)
          row.path_key = p?.path_key
          if (rows.some((r) => r.partner_id === row.partner_id && r.path_key === row.path_key)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "partner_drip_progress_one_per_sequence"' } }
        }
        rows.push(row); st.writes.push({ table, op, row: { ...row } })
        return { data: [{ id: row.id }], error: null }
      }
      if (op === 'select') st.reads.push(table)
      // A lookup that lies (to reach Start's second lock on its own).
      if (op === 'select' && single && table === 'drip_paths' && st.pathOverride) return { data: { ...st.pathOverride }, error: null }
      let hit = rows.filter((r) => match(r, f))
      if (op === 'update') {
        for (const r of hit) {
          Object.assign(r, patch)
          if (table === 'partner_drip_progress' && patch.drip_path_id) r.path_key = st.tables.drip_paths.find((x) => x.id === patch.drip_path_id)?.path_key
        }
        st.writes.push({ table, op, patch, filters: f, matched: hit.length })
        return { data: hit.map((r) => ({ ...r })), error: null }
      }
      if (head) return { count: hit.length, data: null, error: null }
      if (order) hit = [...hit].sort((a, z) => (a[order[0]] < z[order[0]] ? -1 : 1) * (order[1] ? 1 : -1))
      if (lim != null) hit = hit.slice(0, lim)
      if (single) return hit.length > 1 ? { data: null, error: { message: 'more than one row' } } : { data: hit[0] ? { ...hit[0] } : null, error: null }
      return { data: hit.map((r) => ({ ...r })), error: null }
    }
    b.maybeSingle = () => Promise.resolve(run(true))
    b.single = () => Promise.resolve(run(true))
    b.then = (r: any, j: any) => Promise.resolve(run(false)).then(r, j)
    return b
  }
  const rpc = async (fn: string, a: any) => {
    if (fn !== 'partner_send_block_reason') return { data: null, error: null }
    if (st.blockError) return { data: null, error: { message: 'down' } }
    const p = (st.tables.partners || []).find((x) => x.id === a.p_partner_id)
    if (!p) return { data: 'not_found', error: null }
    return { data: st.block[a.p_partner_id] ?? null, error: null }
  }
  return { st, from, rpc }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t), rpc: (f: string, a: any) => h.rpc(f, a) } }))
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: async () => ({
  auth: { getUser: async () => ({ data: { user: h.st.hubUser ? { id: h.st.hubUser.id } : null } }) },
  from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: h.st.hubUser, error: null }); return b },
}) }))
vi.mock('@/lib/network/access', () => ({ maySeeNewNetwork: (role: unknown) => typeof role === 'string' && h.st.gateRoles.includes(role) }))
vi.mock('./partner-drip-send', () => ({
  PARTNER_PROGRESS_TABLE: 'partner_drip_progress',
  sendPartnerDripStep: async (id: string) => { h.st.inlineSends.push(id); return { sent: true, advanced_to_step: 2 } },
}))

import { GET, POST, DELETE } from '@/app/api/network/contacts/[id]/sequences/route'
import { overduePartnerSequences, OVERDUE_MARGIN_HOURS } from './partner-sequence-start'

const PA = '11111111-1111-1111-1111-111111111111'
const MASTER_INTRO = { id: 'm-intro', path_key: 'partner-introduction', name: 'Partner introduction', location_uuid: null, is_master: true, is_active: true }
const MASTER_POWER = { id: 'm-power', path_key: 'partner-power-introduction', name: 'Power Partner introduction', location_uuid: null, is_master: true, is_active: true }
const CLIENT = { id: 'c-org', path_key: 'organizing-a', name: 'Organizing A', location_uuid: null, is_master: true, is_active: true }
const steps = (pathId: string, ...s: [number, number, string | null, string][]) => s.map(([o, d, u, subj]) => ({ drip_path_id: pathId, step_order: o, delay_days: d, delay_unit: u, subject: subj, channel: 'email', is_active: true, is_paused: false }))

beforeEach(() => {
  h.st.tables = {
    partners: [{ id: PA, location_id: 'loc-1', deleted_at: null, network_types: ['partner'], email: 'taylor@example.com' }],
    locations: [{ id: 'loc-1', timezone: 'America/Chicago', lifecycle_status: 'active', subscription_status: 'active' }, { id: 'loc-2', timezone: 'America/Denver', lifecycle_status: 'active' }],
    drip_paths: [{ ...MASTER_INTRO }, { ...MASTER_POWER }, { ...CLIENT }],
    drip_path_steps: [
      ...steps('m-intro', [1, 0, null, 'Great to meet you'], [2, 90, 'months', 'Thinking of you and your clients']),
      ...steps('m-power', [1, 0, null, 'Great to meet you']),
      ...steps('c-org', [1, 0, null, 'Thank you for reaching out!']),
    ],
    partner_drip_progress: [],
  }
  h.st.block = {}; h.st.blockError = false; h.st.inlineSends = []; h.st.writes = []; h.st.reads = []; h.st.pathOverride = null
  h.st.hubUser = { id: 'u-own', role: 'super_admin', location_id: 'loc-1' }
  h.st.gateRoles = ['super_admin']
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-23T15:30:00.000Z'))
})

const ctx = { params: Promise.resolve({ id: PA }) }
const post = async (body: any) => { const r = await POST(new NextRequest('http://x', { method: 'POST', body: JSON.stringify(body) }), ctx); return { status: r.status, json: await r.json() } }
const del = async (body: any) => { const r = await DELETE(new NextRequest('http://x', { method: 'DELETE', body: JSON.stringify(body) }), ctx); return { status: r.status, json: await r.json() } }
const get = async () => { const r = await GET(new NextRequest('http://x'), ctx); return { status: r.status, json: await r.json() } }
const start = (pathKey: unknown = 'partner-introduction', extra: any = {}) => post({ pathKey, confirmed: true, ...extra })
const rows = () => h.st.tables.partner_drip_progress
const progressWrites = () => h.st.writes.filter((w) => w.table === 'partner_drip_progress')

describe('Start puts the partner on the location’s copy if it has one, else the master', () => {
  it('no copy of its own: the master', async () => {
    const r = await start()
    expect(r).toEqual({ status: 200, json: { started: true, restarted: false, usedCopy: 'master', firstEmail: { sent: true, advanced_to_step: 2 } } })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ partner_id: PA, drip_path_id: 'm-intro', path_key: 'partner-introduction', current_step: 1, status: 'active',
      next_send_at: '2026-11-23T15:30:00.000Z', started_by: 'u-own', last_sent_at: null })
    expect(h.st.inlineSends).toEqual([rows()[0].id]) // the first email, now
  })
  it('the location has its own copy: that copy', async () => {
    h.st.tables.drip_paths.push({ id: 'l1-intro', path_key: 'partner-introduction', name: 'Partner introduction', location_uuid: 'loc-1', is_master: false, is_active: true })
    h.st.tables.drip_path_steps.push(...steps('l1-intro', [1, 0, null, 'Hello from Test Location']))
    const r = await start()
    expect(r.json.usedCopy).toBe('location')
    expect(rows()[0].drip_path_id).toBe('l1-intro')
  })
  it('another location’s copy is never used: the master is, and an id sent by the browser is ignored', async () => {
    h.st.tables.drip_paths.push({ id: 'l2-intro', path_key: 'partner-introduction', name: 'x', location_uuid: 'loc-2', is_master: false, is_active: true })
    h.st.tables.drip_path_steps.push(...steps('l2-intro', [1, 0, null, 'Denver']))
    const r = await start('partner-introduction', { dripPathId: 'l2-intro', drip_path_id: 'l2-intro' })
    expect(r.json.usedCopy).toBe('master')
    expect(rows()[0].drip_path_id).toBe('m-intro')
  })
  it('the first email is the lowest-numbered one, and one due later is not sent now', async () => {
    h.st.tables.drip_path_steps = h.st.tables.drip_path_steps.filter((s) => s.drip_path_id !== 'm-power')
    h.st.tables.drip_path_steps.push(...steps('m-power', [3, 5, null, 'Later']))
    await start('partner-power-introduction')
    expect(rows()[0]).toMatchObject({ current_step: 3, next_send_at: '2026-11-28T15:00:00.000Z' }) // 9am Chicago, 5 days on
    expect(h.st.inlineSends).toEqual([])
  })
})

describe('Start refuses, at the route, and writes nothing', () => {
  const refused = async (r: { status: number; json: any }, status: number, error: string) => {
    expect(r.status).toBe(status)
    expect(r.json.error).toBe(error)
    expect(progressWrites()).toEqual([])
    expect(h.st.inlineSends).toEqual([])
  }
  it('a client sequence: refused before any sequence is even looked up', async () => {
    await refused(await start('organizing-a'), 400, 'not_a_partner_sequence')
    expect(h.st.reads.filter((t) => t === 'drip_paths' || t === 'drip_path_steps')).toEqual([])
  })
  it('no sequence named at all, or not a string', async () => {
    await refused(await post({ confirmed: true }), 400, 'not_a_partner_sequence')
    await refused(await start({ id: 'm-intro' }), 400, 'not_a_partner_sequence')
  })
  it('another location’s copy, when there is no master', async () => {
    h.st.tables.drip_paths = h.st.tables.drip_paths.filter((p) => p.id !== 'm-intro')
    h.st.tables.drip_paths.push({ id: 'l2-intro', path_key: 'partner-introduction', name: 'x', location_uuid: 'loc-2', is_master: false, is_active: true })
    await refused(await start('partner-introduction', { dripPathId: 'l2-intro' }), 409, 'sequence_not_found')
  })
  it('the second lock: a lookup that hands back ANOTHER location’s copy is refused', async () => {
    h.st.pathOverride = { id: 'l2-intro', path_key: 'partner-introduction', name: 'x', location_uuid: 'loc-2', is_master: false, is_active: true }
    h.st.tables.drip_path_steps.push(...steps('l2-intro', [1, 0, null, 'Denver']))
    await refused(await start(), 409, 'sequence_wrong_location')
  })
  it('a paused sequence (the master switched off, no copy)', async () => {
    h.st.tables.drip_paths.find((p) => p.id === 'm-intro').is_active = false
    await refused(await start(), 409, 'sequence_paused')
  })
  it('a paused copy with no master to fall back to', async () => {
    h.st.tables.drip_paths = h.st.tables.drip_paths.filter((p) => p.id !== 'm-intro')
    h.st.tables.drip_paths.push({ id: 'l1-intro', path_key: 'partner-introduction', name: 'x', location_uuid: 'loc-1', is_master: false, is_active: false })
    await refused(await start(), 409, 'sequence_paused')
  })
  it('a removed sequence (no copy, no master)', async () => {
    h.st.tables.drip_paths = h.st.tables.drip_paths.filter((p) => p.id !== 'm-intro')
    await refused(await start(), 409, 'sequence_not_found')
  })
  it('a sequence with no first email', async () => {
    h.st.tables.drip_path_steps = h.st.tables.drip_path_steps.filter((s) => s.drip_path_id !== 'm-intro')
    await refused(await start(), 409, 'sequence_has_no_first_email')
  })
  for (const reason of ['no_email', 'unsubscribed', 'address_unsubscribed', 'deleted']) {
    it(`a partner who cannot be emailed: ${reason}`, async () => {
      h.st.block[PA] = reason
      const r = await start()
      await refused(r, 409, 'partner_cannot_receive')
      expect(r.json.reason).toBe(reason)
    })
  }
  it('the check itself failed: refused (fails closed)', async () => {
    h.st.blockError = true
    await refused(await start(), 409, 'partner_cannot_receive')
  })
  it('a partner already on that sequence', async () => {
    rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-intro', path_key: 'partner-introduction', status: 'active', current_step: 2 })
    await refused(await start(), 409, 'already_on_sequence')
  })
  it('two presses at once: the database’s one-per-sequence rule answers already_on_sequence', async () => {
    const [a, b] = await Promise.all([start(), start()])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(rows()).toHaveLength(1)
  })
  it('a row they unsubscribed from is never restarted', async () => {
    rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-intro', path_key: 'partner-introduction', status: 'unsubscribed', current_step: 2 })
    await refused(await start(), 409, 'partner_cannot_receive')
  })
  it('a location that is not active', async () => {
    h.st.tables.locations[0].lifecycle_status = 'paused'
    await refused(await start(), 409, 'location_not_active')
    h.st.tables.locations[0].lifecycle_status = 'closed'
    await refused(await start(), 409, 'location_not_active')
  })
  it('a contact who is not a Referral partner', async () => {
    h.st.tables.partners[0].network_types = ['vendor']
    await refused(await start(), 409, 'not_a_referral_partner')
  })
  it('without the screen’s yes', async () => { await refused(await post({ pathKey: 'partner-introduction' }), 400, 'confirmation_required') })
  it('a removed contact', async () => {
    h.st.tables.partners[0].deleted_at = '2026-11-01T00:00:00Z'
    await refused(await start(), 404, 'contact_not_found')
  })
})

describe('restarting a finished or stopped sequence starts it from the first email', () => {
  for (const status of ['completed', 'stopped']) {
    it(status, async () => {
      rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-intro', path_key: 'partner-introduction', status, current_step: 2,
        last_sent_at: '2026-08-01T15:00:00Z', stopped_at: status === 'stopped' ? '2026-09-01T00:00:00Z' : null, completed_at: status === 'completed' ? '2026-10-01T00:00:00Z' : null })
      const r = await start()
      expect(r.json).toMatchObject({ started: true, restarted: true })
      expect(rows()).toHaveLength(1)
      expect(rows()[0]).toMatchObject({ status: 'active', current_step: 1, last_sent_at: null, stopped_at: null, completed_at: null, next_send_at: '2026-11-23T15:30:00.000Z' })
      expect(progressWrites()[0].filters).toEqual([['eq', 'id', 'pdp-1'], ['eq', 'status', status]])
    })
  }
})

describe('who may start or stop: someone with access to the PARTNER’s location', () => {
  beforeEach(() => { h.st.gateRoles = ['super_admin', 'admin', 'owner', 'manager', 'lite_user'] })
  const as = (role: string, location_id: string | null) => { h.st.hubUser = { id: 'u-x', role, location_id } }
  it('no login: 401', async () => { h.st.hubUser = null; expect((await start()).status).toBe(401); expect((await del({ pathKey: 'partner-introduction', confirmed: true })).status).toBe(401) })
  it('today’s gate: an owner is refused before anything is read (403)', async () => {
    h.st.gateRoles = ['super_admin']; as('owner', 'loc-1')
    expect((await start()).status).toBe(403)
    expect(progressWrites()).toEqual([])
  })
  it('an owner of ANOTHER location: 404, exactly like a missing contact, for start, stop and the read', async () => {
    as('owner', 'loc-2')
    expect(await start()).toEqual({ status: 404, json: { error: 'contact_not_found' } })
    expect((await del({ pathKey: 'partner-introduction', confirmed: true })).status).toBe(404)
    expect((await get()).status).toBe(404)
    expect(progressWrites()).toEqual([])
  })
  it('a lite user at the location: may read, may not start or stop (403)', async () => {
    as('lite_user', 'loc-1')
    expect((await start()).status).toBe(403)
    expect((await del({ pathKey: 'partner-introduction', confirmed: true })).status).toBe(403)
    expect((await get()).status).toBe(200)
    expect(progressWrites()).toEqual([])
  })
  it('the owner and the manager of the location: may start', async () => {
    as('owner', 'loc-1'); expect((await start()).status).toBe(200)
    as('manager', 'loc-1'); expect((await start('partner-power-introduction')).status).toBe(200)
  })
  it('an owner on a read-only (paused subscription) location: may not start, may stop', async () => {
    h.st.tables.locations[0].subscription_status = 'inactive'
    rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-intro', path_key: 'partner-introduction', status: 'active', current_step: 2 })
    as('owner', 'loc-1')
    expect((await start('partner-power-introduction')).json.error).toBe('forbidden_read_only_location')
    expect((await del({ pathKey: 'partner-introduction', confirmed: true })).status).toBe(200)
  })
})

describe('Stop', () => {
  it('ends the sequence for that partner: stopped, no next send, only an active row matched', async () => {
    rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-intro', path_key: 'partner-introduction', status: 'active', current_step: 2, next_send_at: '2027-02-21T15:00:00Z' })
    expect(await del({ pathKey: 'partner-introduction', confirmed: true })).toEqual({ status: 200, json: { stopped: true, emailInFlight: false, lastEmailInFlight: false } })
    expect(rows()[0]).toMatchObject({ status: 'stopped', stopped_reason: 'owner_stopped', next_send_at: null, stopped_at: '2026-11-23T15:30:00.000Z' })
    // ONE update: active, or completed within the window. No gap between two.
    expect(progressWrites()).toHaveLength(1)
    expect(progressWrites()[0].filters).toEqual([['eq', 'partner_id', PA], ['eq', 'path_key', 'partner-introduction'],
      ['or', 'status.eq.active,and(status.eq.completed,completed_at.gte.2026-11-23T15:15:00.000Z)']])
  })
  it('the last email in flight (claimed "completed" moments ago): Stop still stops it, and says so', async () => {
    rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-power', path_key: 'partner-power-introduction', status: 'completed', current_step: 1,
      completed_at: '2026-11-23T15:29:58.000Z', last_sent_at: '2026-11-23T15:29:58.000Z', next_send_at: null })
    expect(await del({ pathKey: 'partner-power-introduction', confirmed: true })).toEqual({ status: 200, json: { stopped: true, emailInFlight: true, lastEmailInFlight: true } })
    expect(rows()[0]).toMatchObject({ status: 'stopped', stopped_reason: 'owner_stopped', next_send_at: null })
    expect(progressWrites()).toHaveLength(1)
  })
  it('a NON-last email sent or being sent moments ago (the row claimed for the next one): stopped, and says one may still arrive', async () => {
    rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-intro', path_key: 'partner-introduction', status: 'active', current_step: 2,
      completed_at: null, last_sent_at: '2026-11-23T15:29:58.000Z', next_send_at: '2027-02-21T15:00:00.000Z' })
    expect(await del({ pathKey: 'partner-introduction', confirmed: true })).toEqual({ status: 200, json: { stopped: true, emailInFlight: true, lastEmailInFlight: false } })
    expect(rows()[0].status).toBe('stopped')
  })
  it('the last email sent long ago: nothing in flight', async () => {
    rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-intro', path_key: 'partner-introduction', status: 'active', current_step: 2,
      completed_at: null, last_sent_at: '2026-11-01T15:00:00.000Z', next_send_at: '2027-01-30T15:00:00.000Z' })
    expect((await del({ pathKey: 'partner-introduction', confirmed: true })).json).toEqual({ stopped: true, emailInFlight: false, lastEmailInFlight: false })
  })
  it('a sequence that really finished (completed more than 15 minutes ago): not changed, 409', async () => {
    rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-power', path_key: 'partner-power-introduction', status: 'completed', current_step: 1,
      completed_at: '2026-11-23T15:14:00.000Z', last_sent_at: '2026-11-23T15:14:00.000Z', next_send_at: null })
    expect((await del({ pathKey: 'partner-power-introduction', confirmed: true })).json.error).toBe('not_on_sequence')
    expect(rows()[0].status).toBe('completed')
  })
  it('nothing to stop: 409, and a client key is refused', async () => {
    expect((await del({ pathKey: 'partner-introduction', confirmed: true })).json.error).toBe('not_on_sequence')
    expect((await del({ pathKey: 'organizing-a', confirmed: true })).json.error).toBe('not_a_partner_sequence')
    expect((await del({ pathKey: 'partner-introduction' })).json.error).toBe('confirmation_required')
  })
})

describe('no send outlives Stop’s in-flight window', () => {
  it('the partner cron and the Start route set a time limit far under STOP_IN_FLIGHT_MINUTES; the client cron is not touched', async () => {
    const { STOP_IN_FLIGHT_MINUTES } = await import('./partner-sequence-start')
    const seq = await import('@/app/api/network/contacts/[id]/sequences/route')
    expect((seq as any).maxDuration).toBe(60)
    const { readFileSync } = await import('node:fs')
    const cron = readFileSync('app/api/cron/send-partner-emails/route.ts', 'utf8')
    const m = /^export const maxDuration = (\d+)$/m.exec(cron)
    expect(Number(m?.[1])).toBe(300)
    expect(Number(m?.[1])).toBeLessThan(STOP_IN_FLIGHT_MINUTES * 60 / 2)
    expect(readFileSync('app/api/cron/send-drips/route.ts', 'utf8')).not.toMatch(/maxDuration/)
    expect(JSON.parse(readFileSync('vercel.json', 'utf8')).functions).toEqual({ 'app/api/import/jobber-clients/route.ts': { maxDuration: 800 } })
  })
})

describe('what the sheet reads', () => {
  it('the sequences with their emails and timing, and where the partner is', async () => {
    rows().push({ id: 'pdp-1', partner_id: PA, drip_path_id: 'm-intro', path_key: 'partner-introduction', status: 'active', current_step: 2, next_send_at: '2027-02-21T15:00:00Z', last_sent_at: '2026-11-23T15:30:00Z' })
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.json.canReceive).toBe(true)
    expect(r.json.sequences[0]).toMatchObject({ pathKey: 'partner-introduction', available: true, copy: 'master',
      emails: [{ order: 1, when: 'Right away', subject: 'Great to meet you' }, { order: 2, when: '3 months later', subject: 'Thinking of you and your clients' }] })
    expect(r.json.progress).toEqual([expect.objectContaining({ pathKey: 'partner-introduction', status: 'active', step: 2, total: 2, sent: 1, nextSendAt: '2027-02-21T15:00:00Z' })])
  })
  it('no email address: canReceive false with the reason (the quiet note)', async () => {
    h.st.block[PA] = 'no_email'
    expect((await get()).json).toMatchObject({ canReceive: false, blockReason: 'no_email' })
  })
})

describe('stuck partner sequences are counted (overdue = next send more than 2 hours late, whatever the reason)', () => {
  it('margin is 2 hours; a row 3h late counts, 1h late does not, a stopped one does not', async () => {
    expect(OVERDUE_MARGIN_HOURS).toBe(2)
    rows().push(
      { id: 'a', status: 'active', next_send_at: '2026-11-23T12:00:00.000Z' },
      { id: 'b', status: 'active', next_send_at: '2026-11-23T14:30:00.000Z' },
      { id: 'c', status: 'stopped', next_send_at: '2026-11-01T00:00:00.000Z' },
      { id: 'd', status: 'active', next_send_at: '2026-11-20T09:00:00.000Z' },
    )
    expect(await overduePartnerSequences()).toEqual({ count: 2, oldestDue: '2026-11-20T09:00:00.000Z' })
  })
})
