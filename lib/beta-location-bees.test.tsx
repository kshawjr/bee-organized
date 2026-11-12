// @vitest-environment happy-dom
//
// The bee roster (Slack job channels, slice 2 of 3) — a name and an email per
// location, typed by the owner; checked against the location's Slack when
// added. migrations/location_bees.sql · lib/location-bees.ts ·
// app/api/locations/[id]/bees · components/hive/BeeRosterSettings.jsx
//
// The database is an in-memory location_bees that enforces the real unique
// index (location_uuid, lower(email)) with Postgres' 23505, so "refused" and
// "reactivated" are tested against the constraint, not against a mock's say-so.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const TOKEN = 'xoxb-SECRET-TOKEN-1234567890'

const h = vi.hoisted(() => {
  const db: any = { bees: [] as any[], locations: new Map<string, any>(), seq: 0 }
  const state: any = { hubUser: null as any }
  const applyFilters = (rows: any[], filters: any[]) =>
    rows.filter(r => filters.every(([m, col, val]) => (m === 'eq' ? r[col] === val : true)))
  const makeBuilder = (table: string) => {
    const ctx: any = { op: 'select', filters: [] as any[], payload: null }
    const b: any = {}
    b.select = () => b
    b.order = () => b
    b.eq = (col: string, val: any) => { ctx.filters.push(['eq', col, val]); return b }
    b.insert = (p: any) => { ctx.op = 'insert'; ctx.payload = p; return b }
    b.update = (p: any) => { ctx.op = 'update'; ctx.payload = p; return b }
    const run = () => {
      if (table === 'locations') {
        const id = ctx.filters.find((f: any) => f[1] === 'id')?.[2]
        return { data: db.locations.get(id) ?? null, error: null }
      }
      if (table !== 'location_bees') return { data: null, error: null }
      const clash = (row: any, selfId: string | null) => db.bees.some((x: any) =>
        x.id !== selfId && x.location_uuid === row.location_uuid && x.email.toLowerCase() === row.email.toLowerCase())
      if (ctx.op === 'insert') {
        const now = new Date().toISOString()
        const row = { id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(++db.seq).padStart(12, '0')}`, jobber_user_id: null, slack_user_id: null,
          slack_checked_at: null, is_active: true, removed_at: null, created_at: now, updated_at: now, ...ctx.payload }
        if (clash(row, null)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "location_bees_loc_email_uniq"' } }
        db.bees.push(row)
        return { data: { ...row }, error: null }
      }
      const hits = applyFilters(db.bees, ctx.filters)
      if (ctx.op === 'update') {
        for (const r of hits) {
          const next = { ...r, ...ctx.payload }
          if (clash(next, r.id)) return { data: null, error: { code: '23505', message: 'dup' } }
          Object.assign(r, ctx.payload)
        }
        return { data: hits.map(r => ({ ...r })), error: null }
      }
      return { data: hits.map(r => ({ ...r })), error: null }
    }
    const one = () => { const r: any = run(); return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }) }
    b.single = one
    b.maybeSingle = one
    b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return b
  }
  return { db, state, makeBuilder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => {}),
  getHubUser: vi.fn(async () => h.state.hubUser),
  isAdmin: (r: string) => r === 'super_admin' || r === 'admin',
}))

import { GET, POST } from '@/app/api/locations/[id]/bees/route'
import { PATCH } from '@/app/api/locations/[id]/bees/[beeId]/route'
import BeeRosterSettings, { beeSlackLine } from '@/components/hive/BeeRosterSettings'
import { canManageBees, lookupSlackUserByEmail } from '@/lib/location-bees'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOC2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const owner = { id: 'u1', role: 'owner', location_id: LOC }

const req = (body?: any) => ({ json: async () => body ?? {} }) as any
const add = async (loc: string, body: any) => { const r = await POST(req(body), { params: { id: loc } }); return { status: r.status, j: await r.json() } }
const patch = async (loc: string, beeId: string, body: any) => { const r = await PATCH(req(body), { params: { id: loc, beeId } }); return { status: r.status, j: await r.json() } }
const list = async (loc: string) => { const r = await GET(req(), { params: { id: loc } }); return { status: r.status, j: await r.json() } }

// Slack's users.lookupByEmail, by email.
let slackUsers: Record<string, string> = {}
let slackDown: false | 'throw' | 'http500' | 'invalid_auth' = false
const fetchMock = vi.fn(async (url: string, init: any) => {
  if (slackDown === 'throw') throw new TypeError(`fetch failed ${url}`)
  if (slackDown === 'http500') return { ok: false, status: 500, json: async () => ({}) } as any
  if (slackDown === 'invalid_auth') return { ok: true, status: 200, json: async () => ({ ok: false, error: 'invalid_auth' }) } as any
  expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  const email = new URL(url).searchParams.get('email') || ''
  const id = slackUsers[email.toLowerCase()]
  return { ok: true, status: 200, json: async () => (id ? { ok: true, user: { id } } : { ok: false, error: 'users_not_found' }) } as any
})

let logs: string[] = []
beforeEach(() => {
  h.db.bees = []
  h.db.seq = 0
  h.db.locations = new Map([
    [LOC, { slack_connected: true, slack_bot_token: TOKEN, lifecycle_status: 'active', subscription_status: 'active' }],
    [LOC2, { slack_connected: false, slack_bot_token: null, lifecycle_status: 'active', subscription_status: 'active' }],
  ])
  h.state.hubUser = owner
  slackUsers = { 'sam@bee.com': 'U_SAM' }
  slackDown = false
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  logs = []
  for (const m of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')) })
  }
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('the roster', () => {
  it('1) a bee saves with a name and an email', async () => {
    const { status, j } = await add(LOC, { name: '  Sam  Bee ', email: 'sam@bee.com' })
    expect(status).toBe(200)
    expect(j.bee).toMatchObject({ name: 'Sam Bee', email: 'sam@bee.com', is_active: true })
    expect(h.db.bees).toHaveLength(1)
  })

  it('a bee needs both a name and a real-looking email', async () => {
    expect((await add(LOC, { name: '', email: 'sam@bee.com' })).status).toBe(400)
    expect((await add(LOC, { name: 'Sam', email: 'not-an-email' })).status).toBe(400)
    expect(h.db.bees).toHaveLength(0)
  })

  it('2) the same email twice at one location is refused, with a plain message', async () => {
    await add(LOC, { name: 'Sam', email: 'sam@bee.com' })
    const { status, j } = await add(LOC, { name: 'Samantha', email: '  SAM@Bee.com ' })
    expect(status).toBe(409)
    expect(j.message).toBe('Sam is already on your bees with sam@bee.com.')
    expect(h.db.bees).toHaveLength(1)
  })

  it('2b) changing an email onto another bee’s email is refused too', async () => {
    await add(LOC, { name: 'Sam', email: 'sam@bee.com' })
    const b = (await add(LOC, { name: 'Ari', email: 'ari@bee.com' })).j.bee
    const { status, j } = await patch(LOC, b.id, { email: 'Sam@bee.com' })
    expect(status).toBe(409)
    expect(j.message).toMatch(/Sam is already on your bees/)
  })

  it('3) the same email at two different locations is fine', async () => {
    expect((await add(LOC, { name: 'Sam', email: 'sam@bee.com' })).status).toBe(200)
    h.state.hubUser = { id: 'u2', role: 'owner', location_id: LOC2 }
    expect((await add(LOC2, { name: 'Sam', email: 'sam@bee.com' })).status).toBe(200)
    expect(h.db.bees).toHaveLength(2)
  })

  it('4) removing a bee sets is_active false and keeps the row', async () => {
    const b = (await add(LOC, { name: 'Sam', email: 'sam@bee.com' })).j.bee
    const { status, j } = await patch(LOC, b.id, { active: false })
    expect(status).toBe(200)
    expect(j.bee.is_active).toBe(false)
    expect(h.db.bees).toHaveLength(1)
    expect(h.db.bees[0]).toMatchObject({ id: b.id, is_active: false, slack_user_id: 'U_SAM' })
    expect(h.db.bees[0].removed_at).toBeTruthy()
  })

  it('there is no DELETE on a bee', async () => {
    const mod: any = await import('@/app/api/locations/[id]/bees/[beeId]/route')
    const top: any = await import('@/app/api/locations/[id]/bees/route')
    expect(mod.DELETE).toBeUndefined()
    expect(top.DELETE).toBeUndefined()
  })

  it('5) re-adding a removed bee reactivates the row rather than failing on the index', async () => {
    const b = (await add(LOC, { name: 'Sam', email: 'sam@bee.com' })).j.bee
    await patch(LOC, b.id, { active: false })
    fetchMock.mockClear()
    const { status, j } = await add(LOC, { name: 'Sam Again', email: 'SAM@bee.com' })
    expect(status).toBe(200)
    expect(j.reactivated).toBe(true)
    expect(j.bee).toMatchObject({ id: b.id, name: 'Sam Again', is_active: true, removed_at: null, slack_user_id: 'U_SAM' })
    expect(h.db.bees).toHaveLength(1)
    // Their Slack id survived, so no new lookup.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Bring back (PATCH active:true) restores the same row', async () => {
    const b = (await add(LOC, { name: 'Sam', email: 'sam@bee.com' })).j.bee
    await patch(LOC, b.id, { active: false })
    const { j } = await patch(LOC, b.id, { active: true })
    expect(j.bee).toMatchObject({ id: b.id, is_active: true, removed_at: null })
  })
})

describe('the Slack check', () => {
  it('6) a bee whose email matches a Slack account stores slack_user_id', async () => {
    const { j } = await add(LOC, { name: 'Sam', email: 'Sam@Bee.com' })
    expect(j.slackCheck).toBe('found')
    expect(h.db.bees[0].slack_user_id).toBe('U_SAM')
    expect(h.db.bees[0].slack_checked_at).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('7) a bee whose email matches nothing saves anyway and says so', async () => {
    const { status, j } = await add(LOC, { name: 'Pat', email: 'pat.personal@gmail.com' })
    expect(status).toBe(200)
    expect(j.slackCheck).toBe('not_found')
    expect(h.db.bees[0]).toMatchObject({ slack_user_id: null })
    expect(h.db.bees[0].slack_checked_at).toBeTruthy()
    expect(beeSlackLine(j.bee)).toEqual({ kind: 'not_found', chip: 'Not in Slack', text: 'That email isn’t in your Slack. Use the one they sign in to Slack with.', action: 'Check again' })
  })

  it('8) a location with no Slack connection saves bees with no Slack message at all', async () => {
    h.state.hubUser = { id: 'u2', role: 'owner', location_id: LOC2 }
    const { status, j } = await add(LOC2, { name: 'Sam', email: 'sam@bee.com' })
    expect(status).toBe(200)
    expect(j.slackConnected).toBe(false)
    expect(j.slackCheck).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.db.bees[0]).toMatchObject({ slack_user_id: null, slack_checked_at: null })
  })

  it.each(['throw', 'http500', 'invalid_auth'] as const)('9) a Slack outage (%s) does not fail the save', async (mode) => {
    slackDown = mode
    const { status, j } = await add(LOC, { name: 'Sam', email: 'sam@bee.com' })
    expect(status).toBe(200)
    expect(j.slackCheck).toBe('unavailable')
    // "Slack was down" is not "nobody has this email": nothing is stamped.
    expect(h.db.bees[0]).toMatchObject({ slack_user_id: null, slack_checked_at: null })
    expect(beeSlackLine(j.bee).kind).toBe('unchecked')
  })

  it('opening the list never calls Slack', async () => {
    await add(LOC, { name: 'Sam', email: 'sam@bee.com' })
    await add(LOC, { name: 'Pat', email: 'pat@gmail.com' })
    fetchMock.mockClear()
    const { j } = await list(LOC)
    expect(j.bees).toHaveLength(2)
    expect(j.slackConnected).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a new email clears the old Slack id and asks again; a rename does not', async () => {
    const b = (await add(LOC, { name: 'Sam', email: 'sam@bee.com' })).j.bee
    fetchMock.mockClear()
    await patch(LOC, b.id, { name: 'Samuel' })
    expect(fetchMock).not.toHaveBeenCalled()
    const { j } = await patch(LOC, b.id, { email: 'sam.home@gmail.com' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(j.slackCheck).toBe('not_found')
    expect(h.db.bees[0].slack_user_id).toBeNull()
  })

  it('a new email during a Slack outage still drops the old Slack id', async () => {
    const b = (await add(LOC, { name: 'Sam', email: 'sam@bee.com' })).j.bee
    expect(h.db.bees[0].slack_user_id).toBe('U_SAM')
    slackDown = 'throw'
    const { status, j } = await patch(LOC, b.id, { email: 'sam.home@gmail.com' })
    expect(status).toBe(200)
    expect(j.slackCheck).toBe('unavailable')
    expect(h.db.bees[0]).toMatchObject({ email: 'sam.home@gmail.com', slack_user_id: null, slack_checked_at: null })
  })

  it('"Check again" looks once more', async () => {
    const b = (await add(LOC, { name: 'Pat', email: 'pat@gmail.com' })).j.bee
    slackUsers['pat@gmail.com'] = 'U_PAT'
    const { j } = await patch(LOC, b.id, { recheck: true })
    expect(j.slackCheck).toBe('found')
    expect(h.db.bees[0].slack_user_id).toBe('U_PAT')
  })

  it('10) no route returns slack_bot_token — nor logs it', async () => {
    slackDown = false
    const a = await add(LOC, { name: 'Sam', email: 'sam@bee.com' })
    const p = await patch(LOC, a.j.bee.id, { recheck: true })
    const g = await list(LOC)
    slackDown = 'invalid_auth'
    const failed = await add(LOC, { name: 'Pat', email: 'pat@gmail.com' })
    slackDown = 'throw'
    const thrown = await patch(LOC, failed.j.bee.id, { recheck: true })
    for (const out of [a, p, g, failed, thrown]) {
      const s = JSON.stringify(out.j)
      expect(s).not.toContain('slack_bot_token')
      expect(s).not.toContain(TOKEN)
    }
    expect(logs.join('\n')).not.toContain(TOKEN)
    // The thrown fetch error carried the URL (with the email); the log keeps neither.
    expect(logs.join('\n')).not.toContain('pat@gmail.com')
  })

  it('lookupSlackUserByEmail: only users_not_found means not found', async () => {
    expect(await lookupSlackUserByEmail(TOKEN, 'sam@bee.com')).toEqual({ status: 'found', slackUserId: 'U_SAM' })
    expect(await lookupSlackUserByEmail(TOKEN, 'x@y.com')).toEqual({ status: 'not_found' })
    slackDown = 'invalid_auth'
    expect((await lookupSlackUserByEmail(TOKEN, 'x@y.com')).status).toBe('unavailable')
  })
})

describe('who may manage bees (the Settings › Tags check)', () => {
  it.each([
    [{ role: 'owner', location_id: LOC }, true],
    [{ role: 'manager', location_id: LOC }, true],
    [{ role: 'admin', location_id: null }, true],
    [{ role: 'super_admin', location_id: null }, true],
    [{ role: 'owner', location_id: LOC2 }, false],
    [{ role: 'manager', location_id: LOC2 }, false],
    [{ role: 'lite_user', location_id: LOC }, false],
  ])('%o → %s', (u, ok) => { expect(canManageBees(u, LOC)).toBe(ok) })

  it('routes refuse another location’s owner and a lite_user', async () => {
    h.state.hubUser = { id: 'u3', role: 'owner', location_id: LOC2 }
    expect((await add(LOC, { name: 'Sam', email: 'sam@bee.com' })).status).toBe(403)
    expect((await list(LOC)).status).toBe(403)
    h.state.hubUser = { id: 'u4', role: 'lite_user', location_id: LOC }
    expect((await add(LOC, { name: 'Sam', email: 'sam@bee.com' })).status).toBe(403)
    expect(h.db.bees).toHaveLength(0)
  })

  it('a manager of the location may add', async () => {
    h.state.hubUser = { id: 'u5', role: 'manager', location_id: LOC }
    expect((await add(LOC, { name: 'Sam', email: 'sam@bee.com' })).status).toBe(200)
  })
})

describe('Settings › Bees', () => {
  const mount = async (payload: any) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })))
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<BeeRosterSettings {...({ locationId: LOC, locationName: 'Kansas City' } as any)} />) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    return { host, root }
  }
  const bee = (o: any) => ({ id: 'b1', name: 'Sam', email: 'sam@bee.com', is_active: true, removed_at: null, slack_user_id: null, slack_checked_at: null, ...o })

  // The Slack state is ONE chip on the row. The sentence that explains it
  // appears once, under the row that needs it, with its button beside it.
  it('with Slack: each bee carries one chip — In your Slack / Not in Slack / Not checked', async () => {
    const { host, root } = await mount({ slackConnected: true, bees: [
      bee({ id: 'b1', name: 'Ann', slack_user_id: 'U1', slack_checked_at: 'x' }),
      bee({ id: 'b2', name: 'Bo', email: 'bo@gmail.com', slack_checked_at: 'x' }),
      bee({ id: 'b3', name: 'Cy', email: 'cy@x.com' }),
    ] })
    const chip = (id: string) => host.querySelectorAll(`[data-bee="${id}"] [data-bee-slack]`)
    expect(Array.from(chip('b1')).map(c => c.textContent)).toEqual(['In your Slack'])
    expect(Array.from(chip('b2')).map(c => c.textContent)).toEqual(['Not in Slack'])
    expect(Array.from(chip('b3')).map(c => c.textContent)).toEqual(['Not checked'])
    expect(chip('b1')[0].getAttribute('data-bee-slack')).toBe('found')
    expect(chip('b2')[0].getAttribute('data-bee-slack')).toBe('not_found')
    expect(chip('b3')[0].getAttribute('data-bee-slack')).toBe('unchecked')
    act(() => root.unmount())
  })

  it('the explanation appears once, under the row that needs it, with Check again beside it — a found bee has none', async () => {
    const { host, root } = await mount({ slackConnected: true, bees: [
      bee({ id: 'b1', name: 'Ann', slack_user_id: 'U1', slack_checked_at: 'x' }),
      bee({ id: 'b2', name: 'Bo', email: 'bo@gmail.com', slack_checked_at: 'x' }),
    ] })
    expect(host.querySelector('[data-bee="b1"] [data-bee-slack-note]')).toBeNull()
    expect(host.querySelector('[data-bee="b1"] [data-bee-recheck]')).toBeNull()
    const notes = host.querySelectorAll('[data-bee="b2"] [data-bee-slack-note]')
    expect(notes.length).toBe(1)
    expect(notes[0].textContent).toBe('That email isn’t in your Slack. Use the one they sign in to Slack with.Check again')
    expect((host.textContent!.match(/That email isn’t in your Slack/g) || []).length).toBe(1)

    // The button really asks: one PATCH { recheck: true } for THAT bee.
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, slackConnected: true, slackCheck: 'found', bee: bee({ id: 'b2', name: 'Bo', email: 'bo@gmail.com', slack_user_id: 'U2', slack_checked_at: 'y' }) }) }))
    vi.stubGlobal('fetch', f)
    await act(async () => { (notes[0].querySelector('[data-bee-recheck]') as HTMLButtonElement).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(f.mock.calls.map((c: any[]) => [String(c[0]), c[1]?.method, c[1]?.body])).toEqual([[`/api/locations/${LOC}/bees/b2`, 'PATCH', JSON.stringify({ recheck: true })]])
    expect(host.querySelector('[data-bee="b2"] [data-bee-slack]')!.textContent).toBe('In your Slack')
    expect(host.querySelector('[data-bee="b2"] [data-bee-slack-note]')).toBeNull()
    act(() => root.unmount())
  })

  it('a row reads as a person: initials, the name at 15px, the email at 13px, and labelled Edit and Remove icon buttons', async () => {
    const { host, root } = await mount({ slackConnected: false, bees: [bee({ name: 'Maria Santos', email: 'maria@bee.com' })] })
    const row = host.querySelector('[data-bee="b1"]') as HTMLElement
    expect(row.querySelector('[aria-hidden="true"]')!.textContent).toBe('MS')
    expect((row.querySelector('[data-bee-name]') as HTMLElement).style.fontSize).toBe('15px')
    expect((row.querySelector('[data-bee-email]') as HTMLElement).style.fontSize).toBe('13px')
    const edit = row.querySelector('button[aria-label="Edit Maria Santos"]') as HTMLElement
    const remove = row.querySelector('button[aria-label="Remove Maria Santos"]') as HTMLElement
    expect(edit && remove).toBeTruthy()
    for (const b of [edit, remove]) { expect(b.style.minHeight).toBe('36px'); expect(b.style.minWidth).toBe('36px'); expect(b.textContent).toBe('') }
    act(() => root.unmount())
  })

  it('"Add a bee" is a button that reveals a labelled form — the form is not on screen until asked for', async () => {
    const { host, root } = await mount({ slackConnected: true, bees: [] })
    expect(host.querySelector('[data-bee-add]')).toBeNull()
    expect(host.querySelector('input')).toBeNull()
    const open = host.querySelector('[data-bee-add-open]') as HTMLButtonElement
    expect(open.textContent).toBe('Add a bee')
    expect(open.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { open.click() })
    expect(open.getAttribute('aria-expanded')).toBe('true')
    const labels = Array.from(host.querySelectorAll('[data-bee-add] label')).map(l => l.querySelector('span')!.textContent)
    expect(labels).toEqual(['Name', 'Email they use for Slack'])
    expect(Array.from(host.querySelectorAll('[data-bee-add] label input')).length).toBe(2)
    act(() => root.unmount())
  })

  it('Edit swaps the row for the same labelled fields and saves with one PATCH; Remove asks first and sends active:false', async () => {
    const { host, root } = await mount({ slackConnected: false, bees: [bee({ name: 'Sam' })] })
    const f = vi.fn(async (_u: any, init: any) => ({ ok: true, status: 200, json: async () => ({ ok: true, slackConnected: false, bee: bee({ name: 'Sam', ...(JSON.parse(init.body).active === false ? { is_active: false, removed_at: 'x' } : {}) }) }) }))
    vi.stubGlobal('fetch', f)
    await act(async () => { (host.querySelector('button[aria-label="Edit Sam"]') as HTMLButtonElement).click() })
    expect(Array.from(host.querySelectorAll('[data-bee-edit] label span')).map(s => s.textContent)).toEqual(['Name', 'Email'])
    await act(async () => { (host.querySelector('[data-bee-edit] button[type="submit"]') as HTMLButtonElement).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(f.mock.calls.map((c: any[]) => [c[1].method, c[1].body])).toEqual([['PATCH', JSON.stringify({ name: 'Sam', email: 'sam@bee.com' })]])

    await act(async () => { (host.querySelector('button[aria-label="Remove Sam"]') as HTMLButtonElement).click() })
    expect(f.mock.calls.length).toBe(1)                       // nothing sent until confirmed
    const dialog = host.querySelector('[role="dialog"][aria-label="Remove Sam"]')!
    expect(dialog.textContent).toContain('You can bring them back any time')
    await act(async () => { (Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === 'Remove') as HTMLButtonElement).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(f.mock.calls[1][1].body).toBe(JSON.stringify({ active: false }))
    expect(host.querySelector('[data-bee-removed] [data-bee="b1"]')).toBeTruthy()
    act(() => root.unmount())
  })

  it('without Slack: not a word about Slack — the list, the add form and the edit form included', async () => {
    const { host, root } = await mount({ slackConnected: false, bees: [bee({ slack_checked_at: 'x' }), bee({ id: 'b2', name: 'Bo', email: 'bo@x.com' })] })
    expect(host.querySelector('[data-bee-slack]')).toBeNull()
    expect(host.querySelector('[data-bee-slack-note]')).toBeNull()
    expect(host.querySelector('[data-bee-recheck]')).toBeNull()
    expect(host.textContent).not.toMatch(/Slack/i)
    await act(async () => { (host.querySelector('[data-bee-add-open]') as HTMLButtonElement).click() })
    await act(async () => { (host.querySelector('button[aria-label="Edit Bo"]') as HTMLButtonElement).click() })
    expect(host.querySelector('[data-bee-add]') && host.querySelector('[data-bee-edit]')).toBeTruthy()
    expect(host.textContent).not.toMatch(/Slack/i)
    expect(host.innerHTML).not.toMatch(/Slack/i)
    act(() => root.unmount())
  })

  it('removed bees collapse behind a "Removed bees (n)" disclosure, each with Bring back and no Slack chip', async () => {
    const { host, root } = await mount({ slackConnected: true, bees: [bee({ is_active: false, removed_at: 'x' }), bee({ id: 'b2', name: 'Bo', email: 'bo@x.com', is_active: false, removed_at: 'x' })] })
    const details = host.querySelector('details[data-bee-removed]') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')!.textContent).toBe('Removed bees (2)')
    const row = details.querySelector('[data-bee="b1"]')!
    expect(row.textContent).toContain('Bring back')
    expect(row.querySelector('[data-bee-slack]')).toBeNull()
    expect(host.querySelectorAll('[data-bee]').length).toBe(2)   // nowhere else on the screen
    act(() => root.unmount())
  })

  it('says what makes bees different from seats: nobody signs in, nobody is billed', async () => {
    const { host, root } = await mount({ slackConnected: false, bees: [] })
    expect(host.querySelector('h2')!.textContent).toBe('Bees')
    expect(host.querySelector('[data-bee-intro]')!.textContent).toBe('The people who work your jobs. Not seats — nobody here signs in to Bee Hub and nobody is billed.')
    act(() => root.unmount())
  })
})
