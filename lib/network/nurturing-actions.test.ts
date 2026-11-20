// Slice 8: Nurturing actions on the server — the bulk tag (also used for one
// person), the follow-up, and the rules behind them — against a fake database
// that keeps real rows, records every call, and can be told to fail.
//
// Pinned here:
//   · a bulk tag names the exact number (the dry run's question)
//   · a dry run and a cancel change nothing, at 18,825, by fingerprint
//   · a refusal (not confirmed, number changed) changes nothing
//   · a bulk tag that fails partway: all put back ("nothing changed"), or,
//     when even the putting back fails, exactly the people left changed
//   · said no to marketing: never tagged, never given a follow-up, whatever
//     the body says
//   · a follow-up is a reminders row and the Reminders route lists it
//   · super admins only
//   · no code path in this slice can send an email
import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.setConfig({ testTimeout: 60_000 })
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { bulkTagQuestion, planBulkTag, saidNoToMarketing, BULK_CHUNK } from './nurturing-actions'

const h = vi.hoisted(() => ({
  state: {
    calls: [] as any[], tables: {} as Record<string, any[]>, hubUser: null as any, sessionUser: null as any,
    // fail the Nth write call (1-based) on a table, or every write from N on
    failWriteAt: null as null | { table: string; n: number; also?: number[] }, writes: 0,
  },
}))
const pk = (t: string, r: any) => (t === 'lead_tags' ? `${r.lead_id}|${r.tag_lookup_id}` : r.id)
function builder(table: string) {
  const c: any = { table, op: 'select', filters: [] as any[], range: null as any, head: false, limit: null as any, payload: null as any, opts: null as any }
  const b: any = {}
  b.select = (_cols?: string, opts?: any) => { if (opts?.head) c.head = true; return b }
  b.insert = (p: any) => { c.op = 'insert'; c.payload = Array.isArray(p) ? p : [p]; return b }
  b.upsert = (p: any, o: any) => { c.op = 'upsert'; c.payload = Array.isArray(p) ? p : [p]; c.opts = o; return b }
  b.delete = () => { c.op = 'delete'; return b }
  b.update = () => { throw new Error(`update on ${table}`) }
  b.rpc = () => { throw new Error('rpc') }
  b.eq = (k: string, val: any) => { c.filters.push((r: any) => r[k] === val); return b }
  b.is = (k: string, val: any) => { c.filters.push((r: any) => (val === null ? r[k] == null : r[k] === val)); return b }
  b.not = (k: string, op: string, val: any) => { if (op === 'is' && val === true) c.filters.push((r: any) => r[k] !== true); return b }
  b.lt = (k: string, val: any) => { c.filters.push((r: any) => r[k] != null && r[k] < val); return b }
  b.in = (k: string, vals: any[]) => { c.filters.push((r: any) => vals.includes(r[k])); return b }
  b.order = () => b
  b.limit = (n: number) => { c.limit = n; return b }
  b.range = (a: number, z: number) => { c.range = [a, z]; return b }
  const run = () => {
    h.state.calls.push(c)
    if (table === 'hub_users') return { data: h.state.hubUser, error: null }
    const rows = (h.state.tables[table] ||= [])
    if (c.op !== 'select') {
      h.state.writes++
      const f = h.state.failWriteAt
      if (f && f.table === table && (h.state.writes === f.n || (f.also || []).includes(h.state.writes))) return { data: null, error: { message: `${table} write ${h.state.writes} failed` } }
    }
    if (c.op === 'insert' || c.op === 'upsert') {
      const out: any[] = []
      const have = new Set(rows.map((x) => pk(table, x)))
      for (const r of c.payload) {
        const row = { ...r }
        if (table === 'lead_tags' && !row.added_at) row.added_at = '2026-11-20T00:00:00Z'
        if (table === 'reminders' && !row.id) row.id = `rem-${rows.length + 1}`
        if (table === 'reminders') Object.assign(row, { done_at: null, created_at: '2026-11-20T00:00:00Z' })
        if (have.has(pk(table, row))) { if (c.op === 'insert') return { data: null, error: { message: 'duplicate key' } }; continue }
        have.add(pk(table, row)); rows.push(row); out.push(row)
      }
      return { data: c.payload.length === 1 ? out[0] ?? null : out, error: null }
    }
    if (c.op === 'delete') {
      const keep = rows.filter((r) => !c.filters.every((f: any) => f(r)))
      h.state.tables[table] = keep
      return { data: null, error: null }
    }
    let got = rows.filter((r) => c.filters.every((f: any) => f(r)))
    got = got.slice().sort((x: any, y: any) => (String(x.id ?? x.lead_id) < String(y.id ?? y.lead_id) ? -1 : 1))
    if (c.head) return { data: null, count: got.length, error: null }
    if (c.range) got = got.slice(c.range[0], c.range[1] + 1)
    if (c.limit != null) got = got.slice(0, c.limit)
    return { data: got, error: null }
  }
  b.maybeSingle = async () => { const r: any = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error } }
  b.single = async () => { const r: any = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error } }
  b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
  return b
}
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => builder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.state.sessionUser } }) }, from: (t: string) => builder(t) }),
}))

import * as bulkRoute from '@/app/api/network/nurturing/bulk/route'
import * as followRoute from '@/app/api/network/nurturing/[id]/follow-up/route'
import * as remindersRoute from '@/app/api/reminders/route'
import { clearNurtureCache } from './nurturing-read'

const PHILLY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TAG = '11111111-1111-4111-8111-111111111111'
const OTHER_LOC_TAG = '22222222-2222-4222-8222-222222222222'
const ME = '99999999-9999-4999-8999-999999999999'
const pid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const as = (role: string | null) => { h.state.sessionUser = role ? { id: ME } : null; h.state.hubUser = role ? { id: ME, role, location_id: null } : null }
const post = (body: any) => bulkRoute.POST({ json: async () => body } as any)
const follow = (id: string, body: any) => followRoute.POST({ json: async () => body } as any, { params: Promise.resolve({ id }) })
const fingerprint = () => createHash('sha256').update(JSON.stringify(['lead_tags', 'reminders', 'leads'].map((t) =>
  (h.state.tables[t] || []).map((r) => JSON.stringify(r)).sort()))).digest('hex')

function seed(count: number) {
  const leads: any[] = []
  for (let i = 0; i < count; i++) leads.push({ id: pid(i), location_uuid: PHILLY, location_id: 'loc_phillysuburbs', name: `Person ${String(i).padStart(5, '0')}`, email: `p${i}@x.com`, phone: null, created_at: '2025-01-01T00:00:00Z', archived_at: null, is_junk: false, marketing_opt_out: false, marketing_unsubscribed_at: null })
  // production's shape: 7 opted out, 1 unsubscribed
  for (let i = 0; i < 7; i++) leads[10 + i].marketing_opt_out = true
  leads[30].marketing_unsubscribed_at = '2026-05-01T00:00:00Z'
  h.state.tables = {
    locations: [{ id: PHILLY, slug: 'loc_phillysuburbs', name: 'Philadelphia Suburbs' }],
    leads, jobs: [], quotes: [], assessments: [], engagements: [],
    lookups: [
      { id: TAG, label: 'Garage', icon: null, category: 'tags', location_id: null, is_active: true, attrs: { group: 'project' } },
      { id: OTHER_LOC_TAG, label: 'Elsewhere tag', icon: null, category: 'tags', location_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', is_active: true, attrs: {} },
    ],
    // two already have it, one of them added by someone else long ago
    lead_tags: [
      { lead_id: pid(0), tag_lookup_id: TAG, added_at: '2025-02-02T00:00:00Z', added_by: 'someone-else' },
      { lead_id: pid(1), tag_lookup_id: TAG, added_at: '2025-03-03T00:00:00Z', added_by: null },
    ],
    reminders: [],
  }
}
const ALL = { location_id: PHILLY, action: 'tag_add', tag_id: TAG, selection: { all: true } }

beforeEach(() => {
  clearNurtureCache()
  h.state.calls = []; h.state.writes = 0; h.state.failWriteAt = null
  as('super_admin')
  seed(18825)
})

describe('the rules', () => {
  it('said no to marketing: opted out, or unsubscribed; the check takes the person and nothing else', () => {
    expect(saidNoToMarketing({ marketing_opt_out: true })).toBe(true)
    expect(saidNoToMarketing({ marketing_unsubscribed_at: '2026-01-01' })).toBe(true)
    expect(saidNoToMarketing({ marketing_opt_out: false, marketing_unsubscribed_at: null })).toBe(false)
    expect(saidNoToMarketing.length).toBe(1)
  })
  it('the question names the number', () => {
    expect(bulkTagQuestion('tag_add', 'Garage', 18816)).toBe('Add “Garage” to 18,816 people?')
    expect(bulkTagQuestion('tag_remove', 'Garage', 1)).toBe('Take “Garage” off 1 person?')
  })
  it('the plan leaves out said-no-to-marketing before anything else, even when they would change', () => {
    const p = planBulkTag({ action: 'tag_add', targets: [{ id: 'a', noMarketing: true }, { id: 'b', noMarketing: false }], haveTag: new Set() })
    expect(p).toMatchObject({ noMarketing: ['a'], change: ['b'] })
  })
})

describe('18,825 selected', () => {
  it('the dry run names the exact number and who is left out, and writes nothing', async () => {
    const before = fingerprint()
    const res = await post({ ...ALL, dry_run: true })
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j).toMatchObject({ selected: 18825, noMarketing: 8, already: 2, change: 18815 })
    expect(j.question).toBe('Add “Garage” to 18,815 people?')
    expect(j.leftOut).toEqual([
      '8 people who said no to marketing are left out. Nobody can change that from here.',
      '2 people already have it, so are left as they are.',
    ])
    expect(fingerprint()).toBe(before)
    expect(h.state.calls.filter((c) => c.op !== 'select')).toHaveLength(0)
  })
  it('a cancel is no second request: after the dry run, nothing has changed, by fingerprint', async () => {
    const before = fingerprint()
    await post({ ...ALL, dry_run: true }) // the confirmation opens …
    // … and Cancel sends nothing at all (lib/network/nurturing-actions-screen.test.tsx proves the screen sends no more)
    expect(fingerprint()).toBe(before)
  })
  it('without the yes, or with a different number, nothing is written', async () => {
    const before = fingerprint()
    expect((await post({ ...ALL })).status).toBe(400)
    expect((await post({ ...ALL, confirmed: false, expected: 18815 })).status).toBe(400)
    const changed = await post({ ...ALL, confirmed: true, expected: 18825 })
    expect(changed.status).toBe(409)
    expect((await changed.json()).change).toBe(18815)
    expect(fingerprint()).toBe(before)
  })
  it('the yes adds it to exactly 18,815, in chunks, and never to the 8 who said no', async () => {
    const res = await post({ ...ALL, confirmed: true, expected: 18815 })
    const j = await res.json()
    expect(j).toMatchObject({ ok: true, changed: 18815 })
    const tagged = new Set(h.state.tables.lead_tags.filter((r) => r.tag_lookup_id === TAG).map((r) => r.lead_id))
    expect(tagged.size).toBe(18817)
    for (const i of [10, 11, 12, 13, 14, 15, 16, 30]) expect(tagged.has(pid(i)), `person ${i}`).toBe(false)
    expect(h.state.tables.lead_tags.find((r) => r.lead_id === pid(0))).toMatchObject({ added_by: 'someone-else', added_at: '2025-02-02T00:00:00Z' })
    expect(h.state.tables.lead_tags.find((r) => r.lead_id === pid(2))).toMatchObject({ added_by: ME })
    const writes = h.state.calls.filter((c) => c.op !== 'select')
    expect(writes).toHaveLength(Math.ceil(18815 / BULK_CHUNK))
    for (const w of writes) expect(w.payload.length).toBeLessThanOrEqual(BULK_CHUNK)
  })
})

describe('a bulk tag that fails partway', () => {
  it('fails at chunk 19 of 38: everything already written is taken back out; the answer says nothing changed', async () => {
    const before = fingerprint()
    h.state.failWriteAt = { table: 'lead_tags', n: 19 }
    const res = await post({ ...ALL, confirmed: true, expected: 18815 })
    const j = await res.json()
    expect(res.status).toBe(500)
    expect(j).toMatchObject({ ok: false, state: 'nothing_changed', wrote: 9000, undone: 9000, leftChanged: [] })
    expect(j.words).toBe('That didn’t finish, so nothing was changed: the 9,000 already done were put back. Check the connection and try again.')
    expect(fingerprint()).toBe(before)
  })
  it('when even putting back fails for one chunk, it names exactly who is left changed, and that is the truth', async () => {
    h.state.failWriteAt = { table: 'lead_tags', n: 19, also: [21] } // 18 chunks written, then the 2nd undo chunk fails
    const res = await post({ ...ALL, confirmed: true, expected: 18815 })
    const j = await res.json()
    expect(j).toMatchObject({ ok: false, state: 'partly_changed', wrote: 9000, undone: 8500 })
    expect(j.leftChanged).toHaveLength(500)
    expect(j.words).toBe('That didn’t finish, and 500 people could not be put back: they still have “Garage”. Run the same action again to finish it for everyone.')
    const tagged = new Set(h.state.tables.lead_tags.map((r) => r.lead_id))
    expect(tagged.size).toBe(2 + 500)
    for (const id of j.leftChanged) expect(tagged.has(id)).toBe(true)
    // …and running it again finishes it for everyone
    h.state.failWriteAt = null
    const again = await (await post({ ...ALL, dry_run: true })).json()
    expect(again.change).toBe(18815 - 500)
    expect((await (await post({ ...ALL, confirmed: true, expected: again.change })).json()).ok).toBe(true)
    expect(new Set(h.state.tables.lead_tags.map((r) => r.lead_id)).size).toBe(18817)
  })
  it('a removal that fails puts every row back exactly as it was: same date, same person who added it', async () => {
    seed(2000)
    for (let i = 2; i < 1600; i++) h.state.tables.lead_tags.push({ lead_id: pid(i), tag_lookup_id: TAG, added_at: `2025-0${1 + (i % 9)}-01T00:00:00Z`, added_by: i % 2 ? 'owner-a' : null })
    clearNurtureCache()
    const before = fingerprint()
    const dry = await (await post({ ...ALL, action: 'tag_remove', dry_run: true })).json()
    h.state.writes = 0
    h.state.failWriteAt = { table: 'lead_tags', n: 3 }
    const j = await (await post({ ...ALL, action: 'tag_remove', confirmed: true, expected: dry.change })).json()
    expect(j).toMatchObject({ ok: false, state: 'nothing_changed', wrote: 1000 })
    expect(fingerprint()).toBe(before)
  })
})

describe('said no to marketing: no action, no override', () => {
  it('picking them by id, with any extra flag in the body, still changes nothing for them', async () => {
    const ids = [pid(10), pid(30), pid(5)]
    const body = { location_id: PHILLY, action: 'tag_add', tag_id: TAG, selection: { ids }, override: true, force: true, include_opted_out: true, role: 'super_admin' }
    const dry = await (await post({ ...body, dry_run: true })).json()
    expect(dry).toMatchObject({ selected: 3, noMarketing: 2, change: 1 })
    await post({ ...body, confirmed: true, expected: 1 })
    const tagged = new Set(h.state.tables.lead_tags.map((r) => r.lead_id))
    expect([tagged.has(pid(10)), tagged.has(pid(30)), tagged.has(pid(5))]).toEqual([false, false, true])
  })
  it('a follow-up on them is refused', async () => {
    const before = fingerprint()
    for (const id of [pid(10), pid(30)]) {
      const res = await follow(id, { due_on: '2026-12-01', note: 'Check in', override: true })
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('said_no_to_marketing')
    }
    expect(fingerprint()).toBe(before)
  })
})

describe('a follow-up is a reminder', () => {
  it('writes one reminders row for this person and the caller, and the Reminders route lists it', async () => {
    const res = await follow(pid(5), { due_on: '2026-12-01', note: 'Ask about the garage in spring' })
    expect(res.status).toBe(201)
    expect(h.state.tables.reminders).toHaveLength(1)
    expect(h.state.tables.reminders[0]).toMatchObject({ user_id: ME, lead_id: pid(5), location_uuid: PHILLY, due_on: '2026-12-01', note: 'Ask about the garage in spring' })
    const list = await (await remindersRoute.GET({ url: 'http://x/api/reminders', nextUrl: new URL('http://x/api/reminders') } as any)).json()
    const rows = list.reminders || list
    expect(rows.map((r: any) => r.lead_id)).toContain(pid(5))
  })
  it('a date and a note are needed', async () => {
    expect((await follow(pid(5), { note: 'x' })).status).toBe(400)
    expect((await follow(pid(5), { due_on: '2026-12-01', note: ' ' })).status).toBe(400)
    expect(h.state.tables.reminders).toHaveLength(0)
  })
})

describe('the tag must belong here', () => {
  it('another location’s own tag is refused', async () => {
    const res = await post({ ...ALL, tag_id: OTHER_LOC_TAG, dry_run: true })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('tag_not_offered_here')
  })
})

describe('super admins only', () => {
  it('owner, manager, read-only and corporate get 403 on both writes and change nothing', async () => {
    const before = fingerprint()
    for (const role of ['owner', 'manager', 'lite_user', 'admin']) {
      as(role)
      expect((await post({ ...ALL, confirmed: true, expected: 18815 })).status, role).toBe(403)
      expect((await follow(pid(5), { due_on: '2026-12-01', note: 'x' })).status, role).toBe(403)
    }
    expect(fingerprint()).toBe(before)
  })
})

describe('no code path in this slice can send an email', () => {
  // Follow every '@/…' and './…' import from the slice 8 files and the screens,
  // and prove none of them reaches anything that sends or syncs.
  const SENDERS = /lib\/(resend|drip-send|drip-lifecycle|welcome-email|stage-emails|mailchimp|notifications?|email-send|gmail|slack)/
  const resolve = (from: string, spec: string) => {
    const base = spec.startsWith('@/') ? spec.slice(2) : join(dirname(from), spec)
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) if (existsSync(join(process.cwd(), base + ext)) && /\.(t|j)sx?$/.test(base + ext)) return base + ext
    return null
  }
  const reach = (start: string[]) => {
    const seen = new Set<string>()
    const todo = [...start]
    while (todo.length) {
      const f = todo.pop()!
      if (seen.has(f)) continue
      seen.add(f)
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      // every way a module can be pulled in: import … from, a bare import, import(), require()
      for (const m of Array.from(src.matchAll(/(?:from\s+|import\s*\(?\s*|require\s*\(\s*)['"]((?:@\/|\.\.?\/)[^'"]+)['"]/g))) { const r = resolve(f, m[1]); if (r) todo.push(r) }
    }
    return Array.from(seen)
  }
  it('nothing the slice 8 routes and screens import, however deep, sends or syncs', () => {
    const files = reach([
      'app/api/network/nurturing/bulk/route.ts', 'app/api/network/nurturing/[id]/follow-up/route.ts',
      'components/network/NurturingScreen.jsx', 'components/network/NurtureSheet.jsx', 'components/network/NurtureBulkConfirm.jsx',
    ])
    expect(files.length).toBeGreaterThan(8)
    expect(files.filter((f) => SENDERS.test(f))).toEqual([])
  })
  it('the only tables the slice 8 writes touch are lead_tags and reminders', async () => {
    await post({ ...ALL, confirmed: true, expected: 18815 })
    await follow(pid(5), { due_on: '2026-12-01', note: 'x' })
    expect(Array.from(new Set(h.state.calls.filter((c) => c.op !== 'select').map((c) => c.table))).sort()).toEqual(['lead_tags', 'reminders'])
  })
})
