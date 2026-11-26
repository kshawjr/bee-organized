// FL-75 slice 6 (2026-11-25) — the first sync, push direction: the one place
// Bee Hub adds people to a location's Mailchimp audience.
//
// Kevin's pins, each one below by name:
//   P1 Nothing sends while the switch is off, by any route
//   P2 A first sync refuses without a matching count and audience
//   P3 A person who unsubscribed or was cleaned in Mailchimp is never changed
//   P4 A person on the no-marketing list is never sent, whatever the saved tick says
//   P5 Running it twice does not add anyone twice
//   P6 A half-done sync says so
// and the 2026-11-25 rulings:
//   R1 Any live flow that starts when someone is added → refuse, naming each
//   R2 Flows read live right before sending; a change between look and send → refuse
//   R3 Mailchimp unreadable → refuse ("couldn't check" is never "nothing live")
//   R4 A tag that starts a live flow is never carried without the owner's yes, one by one
import { describe, it, expect, vi, afterEach } from 'vitest'
// The engine takes its database as a dependency here; the real client must
// never be reached (and cannot start without production settings).
vi.mock('./supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
import { readFileSync } from 'fs'
import { join } from 'path'
import { syncWebsiteLeadsToMailchimp, BATCH_SIZE } from './mailchimp-sync'
import { readFlows, flowsFingerprint, type Flow, type FlowsRead } from './mailchimp-flows'
import { buildReview, type ReviewLead, type StoredChoice } from './mailchimp-review'
import { emailKey } from './mailchimp-rules'
import { enforceRealRules } from './db-rules-check'
import { syncResultWords } from '@/components/settings/MailchimpSyncAnswer'

const LOC = '11111111-1111-4111-8111-111111111111'
const LIST = 'list1'
const TOKEN = 'tok-SECRET-123'
const noSleep = async () => {}

// ── A small stand-in for Supabase ─────────────────────────────
function fakeDb(o: { leads: any[]; location?: any; noListBroken?: boolean; lookups?: any[]; leadTags?: any[]; refusals?: any[] | 'missing'; noListFnMissing?: boolean } ) {
  const tables: Record<string, any[]> = {
    leads: o.leads, sync_log: [], lookups: o.lookups || [], lead_tags: o.leadTags || [],
    engagements: [], touchpoints: [], service_requests: [], quotes: [], jobs: [], partners: [], marketing_unsubscribes: [],
    mailchimp_refusals: o.refusals === 'missing' ? [] : (o.refusals || []),
  }
  const location = {
    id: LOC, location_id: 'loc_t', mailchimp_connected: true, mailchimp_access_token: TOKEN, mailchimp_server_prefix: 'us9',
    mailchimp_list_id: LIST, mailchimp_list_name: 'Bee Organized Friends', mailchimp_sync_live: true, mailchimp_first_sync_at: null, ...(o.location || {}),
  }
  const writes: { table: string; op: string; patch?: any; ids?: string[]; row?: any }[] = []
  const from = (table: string) => {
    const f: Array<(r: any) => boolean> = []
    let head = false, limit = Infinity
    const run = () => {
      if (table === 'marketing_unsubscribes' && o.noListBroken) return { data: null, error: { message: 'broken' }, count: null }
      if (table === 'mailchimp_refusals' && o.refusals === 'missing') return { data: null, error: { code: '42P01', message: 'relation "mailchimp_refusals" does not exist' }, count: null }
      const rows = (table === 'locations' ? [location] : tables[table] || []).filter((r) => f.every((fn) => fn(r))).slice(0, limit)
      return { data: head ? null : rows, error: null, count: rows.length }
    }
    const q: any = {
      select: (_c: string, opt?: any) => { if (opt?.head) head = true; return q },
      eq: (c: string, v: any) => { f.push((r) => r[c] === v); return q },
      in: (c: string, v: any[]) => { f.push((r) => v.includes(r[c])); return q },
      is: (c: string, v: any) => { f.push((r) => (r[c] ?? null) === v); return q },
      not: (c: string, op: string, v: any) => { if (op !== 'is') throw new Error('fake: not.' + op); f.push((r) => (r[c] ?? null) !== v); return q },
      like: (c: string, pat: string) => { const pre = pat.replace(/%$/, ''); f.push((r) => typeof r[c] === 'string' && r[c].startsWith(pre)); return q },
      limit: (n: number) => { limit = n; return q },
      maybeSingle: async () => { const r = run(); return { data: (r.data || [])[0] || null, error: r.error } },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
      // update(patch) then any of .eq / .is / .in / .select, awaited at the end.
      update: (patch: any) => {
        const uf: Array<(r: any) => boolean> = []
        let ids: string[] | undefined
        const u: any = {
          eq: (c: string, v: any) => { uf.push((r) => r[c] === v); return u },
          is: (c: string, v: any) => { uf.push((r) => (r[c] ?? null) === v); return u },
          // PostgREST's or: "col.is.null,col.neq.X" — the audience write's own filter.
          or: (expr: string) => {
            const parts = expr.split(',').map((x) => { const [c, op, ...v] = x.split('.'); return { c, op, v: v.join('.') } })
            uf.push((r) => parts.some(({ c, op, v }) => op === 'is' && v === 'null' ? (r[c] ?? null) === null : op === 'neq' ? r[c] !== null && r[c] !== undefined && String(r[c]) !== v : op === 'eq' ? String(r[c]) === v : false))
            return u
          },
          in: (c: string, v: string[]) => { ids = v; uf.push((r) => v.includes(r[c])); return u },
          select: () => u,
          then: (ok: any, bad: any) => {
            const pool = table === 'locations' ? [location] : tables[table] || []
            const hit = pool.filter((r) => uf.every((fn) => fn(r)))
            writes.push({ table, op: 'update', patch, ...(ids ? { ids } : {}) })
            for (const r of hit) Object.assign(r, patch)
            return Promise.resolve({ data: hit, error: null }).then(ok, bad)
          },
        }
        return u
      },
      insert: async (row: any) => {
        if (table === 'mailchimp_refusals' && o.refusals === 'missing') return { error: { code: '42P01', message: 'missing' } }
        writes.push({ table, op: 'insert', row }); tables[table].push(row); return { error: null }
      },
      delete: () => {
        const df: Array<(r: any) => boolean> = []
        const d: any = {
          eq: (c: string, v: any) => { df.push((r) => r[c] === v); return d },
          then: (ok: any, bad: any) => {
            const before = tables[table].length
            tables[table] = tables[table].filter((r) => !df.every((fn) => fn(r)))
            writes.push({ table, op: 'delete', removed: before - tables[table].length } as any)
            return Promise.resolve({ error: null }).then(ok, bad)
          },
        }
        return d
      },
    }
    return q
  }
  const rpcCalls: { fn: string; args: any }[] = []
  const rpc = async (fn: string, args: any) => {
    if (fn !== 'marketing_unsubscribe_from_mailchimp') throw new Error('unexpected rpc ' + fn)
    if (o.noListFnMissing) return { data: null, error: { code: '42883', message: 'function does not exist' } }
    rpcCalls.push({ fn, args }); tables.marketing_unsubscribes.push({ email_normalized: String(args.p_email).trim().toLowerCase(), source: 'mailchimp' })
    return { data: true, error: null }
  }
  return { db: { from, rpc }, writes, tables, location, rpcCalls }
}

// ── A small stand-in for Mailchimp ────────────────────────────
type Member = { email: string; status: string }
function fakeMailchimp(o: { members?: Member[]; archived?: string[]; segments?: { id: string; name: string }[]; fail?: (url: string, method: string, n: number) => number | null; accepts?: (email: string) => boolean }) {
  const members: Member[] = [...(o.members || [])]
  const segments = [...(o.segments || [{ id: '16', name: 'CLOSEDJOB' }])]
  const tagged: Record<string, string[]> = {}
  const reqs: { method: string; url: string; body: any }[] = []
  let n = 0
  const fetchImpl = async (url: string, init: any) => {
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(init.body) : null
    reqs.push({ method, url, body })
    expect(String(JSON.stringify(init?.headers || {}))).toContain(`Bearer ${TOKEN}`)
    const forced = o.fail?.(url, method, n++)
    const reply = (status: number, b: any) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(b) })
    if (forced) return reply(forced, { detail: 'nope' })
    const path = url.replace(/^https:\/\/us9\.api\.mailchimp\.com\/3\.0\//, '')
    if (method === 'GET' && path.startsWith(`lists/${LIST}/members?status=archived`)) {
      const rows = (o.archived || []).map((e) => ({ email_address: e }))
      return reply(200, { total_items: rows.length, members: rows })
    }
    if (method === 'GET' && path.startsWith(`lists/${LIST}/segments?`)) return reply(200, { total_items: segments.length, segments })
    if (method === 'POST' && path === `lists/${LIST}`) {
      const new_members: any[] = [], errors: any[] = []
      for (const m of body.members) {
        const k = emailKey(m.email_address)!
        if (members.some((x) => emailKey(x.email) === k)) errors.push({ email_address: m.email_address, error: `${m.email_address} is already a list member`, error_code: 'ERROR_CONTACT_EXISTS' })
        else if (m.email_address.includes('fake') && !o.accepts?.(m.email_address)) errors.push({ email_address: m.email_address, error: `${m.email_address} looks fake or invalid, please enter a real email address.`, error_code: 'ERROR_GENERIC' })
        else if (m.email_address.includes('gone')) errors.push({ email_address: m.email_address, error: `${m.email_address} was permanently deleted and cannot be re-imported. The contact must re-subscribe to get back on the list.`, error_code: 'ERROR_GENERIC' })
        else if (m.email_address.includes('busy') && !o.accepts?.(m.email_address)) errors.push({ email_address: m.email_address, error: `${m.email_address} has signed up to a lot of lists very recently; we're not allowing more signups for now`, error_code: 'ERROR_GENERIC' })
        else { members.push({ email: m.email_address, status: m.status }); new_members.push({ email_address: m.email_address, status: m.status }) }
      }
      return reply(200, { new_members, updated_members: [], errors, total_created: new_members.length, total_updated: 0, error_count: errors.length })
    }
    if (method === 'POST' && path === `lists/${LIST}/segments`) { const id = String(100 + segments.length); segments.push({ id, name: body.name }); return reply(200, { id: Number(id), name: body.name }) }
    const seg = path.match(new RegExp(`^lists/${LIST}/segments/(\\d+)$`))
    if (method === 'POST' && seg) { const s = segments.find((x) => x.id === seg[1])!; (tagged[s.name] ||= []).push(...body.members_to_add); return reply(200, { members_added: body.members_to_add, errors: [] }) }
    return reply(404, { detail: `no fake for ${method} ${path}` })
  }
  return { fetchImpl, reqs, members, tagged, segments, writesToMembers: () => reqs.filter((r) => r.method !== 'GET' && /\/members(\/|\?|$)/.test(r.url)) }
}

// ── Flows, as lib/mailchimp-flows.ts would report them ────────
const flow = (over: Partial<Flow>): Flow => ({ kind: 'journey', id: '1', name: 'Welcome New Contacts', status: 'paused', live: false, start: 'signup', startWords: 'Contact signs up to Bee Organized Friends', tag: null, subjects: [], ...over })
const flowsAnswer = (flows: Flow[]): FlowsRead => ({
  ok: true, flows,
  mustPause: flows.filter((f) => f.live && f.start !== 'tag'),
  tagFlows: flows.filter((f) => f.live && f.start === 'tag'),
  signupFlows: flows.filter((f) => f.start !== 'tag'),
  fingerprint: flowsFingerprint(flows),
})
const PAUSED = [flow({}), flow({ id: '2', name: 'Profile Quiz - Welcome Flow' })]
const CLOSEDJOB_LIVE = flow({ id: '3', name: 'Closed Job Journey', status: 'sending', live: true, start: 'tag', startWords: 'Contact tagged CLOSEDJOB', tag: 'CLOSEDJOB' })

// ── People ────────────────────────────────────────────────────
const lead = (id: string, email: string | null, over: Partial<ReviewLead> & Record<string, any> = {}): any =>
  ({ id, email, first_name: id.toUpperCase(), last_name: 'Doe', created_at: '2026-05-01T15:00:00Z', location_uuid: LOC, project_type: null, source: null, ...over })

// The engine's "who, live" step, built the way loadReview builds it, from the
// fake Mailchimp's CURRENT members (so a second run sees the first run's adds).
function reviewFrom(dbx: ReturnType<typeof fakeDb>, mc: ReturnType<typeof fakeMailchimp>, o: { suppressed?: string[]; choices?: StoredChoice[]; calls?: { n: number } } = {}) {
  return async () => {
    if (o.calls) o.calls.n++
    const leads = dbx.tables.leads
    const members = mc.members.map((m, i) => ({ id: 'm' + i, email: m.email, emailKey: emailKey(m.email), status: m.status, phone: null }))
    const leadIdsByKey: Record<string, string[]> = {}
    for (const l of leads) { const k = emailKey(l.email); if (k) (leadIdsByKey[k] ||= []).push(l.id) }
    return {
      ok: true as const, location: { id: LOC, name: 'T', audienceName: 'Bee Organized Friends', timeZone: 'UTC' }, mailchimpWords: null, choicesReady: true,
      model: buildReview({ leads, contacted: new Set(), suppressed: new Set(o.suppressed || []), members, choices: o.choices || [], timeZone: 'UTC' }),
      leadIdsByKey,
    }
  }
}

function setup(o: { leads: any[]; members?: Member[]; flows?: Flow[] | (() => FlowsRead); suppressedAtReview?: string[]; suppressedAtSend?: string[]; choices?: StoredChoice[]; location?: any; archived?: string[]; fail?: any; noListBroken?: boolean; lookups?: any[]; leadTags?: any[]; refusals?: any[] | 'missing'; noListFnMissing?: boolean; accepts?: (email: string) => boolean }) {
  const dbx = fakeDb({ leads: o.leads, location: o.location, noListBroken: o.noListBroken, lookups: o.lookups, leadTags: o.leadTags, refusals: o.refusals, noListFnMissing: o.noListFnMissing })
  // EVERY sending test writes through the REAL database rules
  // (lib/db-rules-check.ts): a row production would refuse is refused here
  // too, and the afterEach below fails the test. A stand-in that accepts any
  // row is how two never-saved records shipped (2026-11-26).
  const ruled = enforceRealRules(dbx.db)
  lastRuled = ruled
  const mc = fakeMailchimp({ members: o.members, archived: o.archived, fail: o.fail, accepts: o.accepts })
  const flowCalls = { n: 0 }
  const reviewCalls = { n: 0 }
  const deps = {
    db: ruled, fetchImpl: mc.fetchImpl as any, sleep: noSleep,
    readFlowsImpl: async () => { flowCalls.n++; return typeof o.flows === 'function' ? o.flows() : flowsAnswer(o.flows || PAUSED) },
    loadReviewImpl: reviewFrom(dbx, mc, { suppressed: o.suppressedAtReview, choices: o.choices, calls: reviewCalls }) as any,
    loadSuppressed: async () => new Set(o.suppressedAtSend || []),
  }
  const run = (confirm?: any, extra: any = {}) => syncWebsiteLeadsToMailchimp(LOC, { confirm: confirm ?? null }, { ...deps, ...extra })
  const posts = () => mc.reqs.filter((r) => r.method === 'POST' && r.url.endsWith(`/lists/${LIST}`))
  return { dbx, mc, run, posts, flowCalls, reviewCalls }
}
let lastRuled: { refused: unknown[] } | null = null
afterEach(() => {
  const refused = lastRuled?.refused || []
  lastRuled = null
  expect(refused, 'a write the real database would refuse').toEqual([])
})
// The first-sync date as the sending code leaves it.
const firstSyncAt = (s: { dbx: { location: any } }) => s.dbx.location.mailchimp_first_sync_at as string | null
const SYNCED = { mailchimp_first_sync_at: '2026-11-20T12:00:00.000Z' }
const confirmOf = (r: any, tagsOk?: string[]) => ({ count: r.confirm.count, listId: r.confirm.listId, flows: r.confirm.flows, ...(tagsOk ? { tagsOk } : {}) })
const THREE = () => [lead('a', 'a@x.com'), lead('b', 'b@x.com'), lead('c', 'c@x.com')]

// ═════════════════════════════════════════════════════════════
describe('P1. nothing sends while the switch is off, by any route', () => {
  it('switch off → refused before anything is read: no Mailchimp request, no flows read, no records read, no writes', async () => {
    const s = setup({ leads: THREE(), location: { mailchimp_sync_live: false } })
    const r = await s.run({ count: 3, listId: LIST, flows: 'anything' })
    expect(r).toMatchObject({ ran: false, reason: 'sync_not_enabled', pushed: 0 })
    expect(s.mc.reqs).toEqual([])
    expect(s.flowCalls.n).toBe(0)
    expect(s.reviewCalls.n).toBe(0)
    expect(s.dbx.writes).toEqual([])
  })
  it('the switch is in the sending code, and the route only relays', () => {
    const engine = readFileSync(join(process.cwd(), 'lib/mailchimp-' + 'sync.ts'), 'utf8')
    expect(engine).toContain("if (!loc.mailchimp_sync_live) return refuse('sync_not_enabled')")
    // the switch is checked before the first network call in the file
    const sw = engine.indexOf("if (!loc.mailchimp_sync_live)")
    const firstRead = engine.indexOf('const flows = await readNowFlows()')
    expect(sw).toBeGreaterThan(0)
    expect(firstRead).toBeGreaterThan(sw)
    const route = readFileSync(join(process.cwd(), 'app/api/mailchimp/sync/route.ts'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(route).not.toMatch(/mailchimp_sync_live/)
  })
})

describe('R1 + R3. live sign-up flows, or flows that cannot be read: refuse', () => {
  it('a live "signs up" flow → signup_flows_live, naming it and how to pause; nothing written anywhere', async () => {
    const live = [flow({ status: 'sending', live: true }), flow({ id: '2', name: 'Profile Quiz - Welcome Flow' })]
    const s = setup({ leads: THREE(), flows: live })
    const r = await s.run()
    expect(r.reason).toBe('signup_flows_live')
    expect(r.mustPause).toEqual([{ name: 'Welcome New Contacts', status: 'sending', start: 'Contact signs up to Bee Organized Friends', subjects: [] }])
    expect(r.howToPause).toMatch(/Pause/)
    expect(s.mc.reqs.filter((q) => q.method !== 'GET')).toEqual([])
    expect(s.dbx.writes).toEqual([])
  })
  it('even with a matching confirmation, and even after the first sync is done', async () => {
    const live = [flow({ status: 'sending', live: true })]
    const s = setup({ leads: THREE(), flows: live, location: SYNCED })
    const r = await s.run({ count: 3, listId: LIST, flows: flowsFingerprint(live) })
    expect(r.reason).toBe('signup_flows_live')
    expect(s.posts()).toEqual([])
  })
  it('flows unreadable → mailchimp_unreadable, nothing sent', async () => {
    const s = setup({ leads: THREE(), flows: () => ({ ok: false, reason: 'rate_limited', detail: 'x' }) })
    const r = await s.run()
    expect(r).toMatchObject({ ran: false, reason: 'mailchimp_unreadable' })
    expect(r.words).toMatch(/could not check/)
    expect(s.posts()).toEqual([])
  })
  it('Mailchimp audience not read in full → refused, never treated as "nobody is there"', async () => {
    const s = setup({ leads: THREE() })
    const r = await syncWebsiteLeadsToMailchimp(LOC, {}, {
      db: s.dbx.db, fetchImpl: s.mc.fetchImpl as any, sleep: noSleep, readFlowsImpl: async () => flowsAnswer(PAUSED),
      loadReviewImpl: async () => ({ ...(await reviewFrom(s.dbx, s.mc)()), mailchimpWords: 'Mailchimp stopped answering partway.', model: { ...(await reviewFrom(s.dbx, s.mc)()).model, mailchimpKnown: false } }) as any,
      loadSuppressed: async () => new Set(),
    })
    expect(r.reason).toBe('mailchimp_unreadable')
    expect(s.posts()).toEqual([])
  })
  it('archived contacts cannot be read → refused', async () => {
    const s = setup({ leads: THREE(), fail: (url: string) => (url.includes('status=archived') ? 500 : null) })
    const r = await s.run()
    expect(r.reason).toBe('mailchimp_unreadable')
    expect(s.posts()).toEqual([])
  })
})

describe('P2. a first sync refuses without a matching count, audience and flows', () => {
  it('no confirm → needs_confirmation: the exact count, the audience by name, the paused flows; nothing written', async () => {
    const s = setup({ leads: THREE() })
    const r = await s.run()
    expect(r).toMatchObject({ ran: false, reason: 'needs_confirmation', first: true })
    expect(r.confirm).toMatchObject({ count: 3, listId: LIST, listName: 'Bee Organized Friends', flows: flowsFingerprint(PAUSED) })
    expect(r.confirm!.pausedFlows.map((f) => f.name)).toEqual(['Welcome New Contacts', 'Profile Quiz - Welcome Flow'])
    expect(s.mc.reqs.filter((q) => q.method !== 'GET')).toEqual([])
    expect(s.dbx.writes).toEqual([])
  })
  for (const [name, bad] of [
    ['a stale count', { count: 2 }],
    ['another audience', { listId: 'other' }],
    ['flows that changed since the owner looked', { flows: 'deadbeefdeadbeef' }],
  ] as const) {
    it(`${name} → asks again, nothing sent`, async () => {
      const s = setup({ leads: THREE() })
      const ask = await s.run()
      const r = await s.run({ ...confirmOf(ask), ...bad })
      expect(r.reason).toBe('needs_confirmation')
      expect(s.posts()).toEqual([])
    })
  }
  it('the matching confirm sends exactly the ticked people, in one batch, as new subscribers only', async () => {
    const s = setup({ leads: [...THREE(), lead('d', 'd@x.com', { archived_at: '2026-08-01T00:00:00Z' })] })
    const ask = await s.run()
    expect(ask.confirm!.count).toBe(3)                      // the archived one starts unticked
    const r = await s.run(confirmOf(ask))
    expect(r).toMatchObject({ ran: true, complete: true, pushed: 3, remaining: 0, first: true })
    expect(s.posts()).toHaveLength(1)
    const body = s.posts()[0].body
    expect(body.update_existing).toBe(false)
    expect(body.members.map((m: any) => m.email_address).sort()).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
    for (const m of body.members) { expect(m.status).toBe('subscribed'); expect(m.merge_fields).toEqual({ FNAME: expect.any(String), LNAME: 'Doe' }) }
    // A finished first sync sets the location's first-sync date — and writes nothing to sync_log.
    expect(firstSyncAt(s)).toEqual(expect.any(String))
    expect(s.dbx.writes.filter((w) => w.table === 'locations')).toEqual([{ table: 'locations', op: 'update', patch: { mailchimp_first_sync_at: expect.any(String) } }])
    expect(s.dbx.tables.sync_log).toEqual([])
  })
  it('once a run has completed, later runs need no confirm (and still check the flows)', async () => {
    const s = setup({ leads: THREE(), location: SYNCED })
    const r = await s.run()
    expect(r).toMatchObject({ ran: true, complete: true, pushed: 3, first: false })
    expect(firstSyncAt(s)).toBe(SYNCED.mailchimp_first_sync_at)   // set once, never moved
    expect(s.flowCalls.n).toBeGreaterThanOrEqual(2)
  })
  it('a partial run is NOT a finished first sync: carrying on asks again, for what is left', async () => {
    // A run that stopped partway left the first-sync date empty.
    const s = setup({ leads: THREE(), location: { mailchimp_first_sync_at: null } })
    expect((await s.run()).reason).toBe('needs_confirmation')
  })
  it('the first-sync date cannot be read (migration not run, say) → treated as a FIRST sync: asks, never guesses "not first"', async () => {
    const s = setup({ leads: THREE(), location: SYNCED })
    const base = s.dbx.db
    const db = { ...base, from: (t: string) => {
      const q = base.from(t)
      if (t !== 'locations') return q
      const sel = q.select
      q.select = (cols: string, ...rest: any[]) => cols === 'mailchimp_first_sync_at'
        ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42703', message: 'column locations.mailchimp_first_sync_at does not exist' } }) }) }
        : sel(cols, ...rest)
      return q
    } }
    const r = await syncWebsiteLeadsToMailchimp(LOC, {}, { db, fetchImpl: s.mc.fetchImpl as any, sleep: noSleep, readFlowsImpl: async () => flowsAnswer(PAUSED), loadReviewImpl: reviewFrom(s.dbx, s.mc) as any, loadSuppressed: async () => new Set() })
    expect(r).toMatchObject({ ran: false, reason: 'needs_confirmation' })
    expect(s.posts()).toEqual([])
  })
  it('the first-sync date does not land after everything went → the run says so (record_not_saved), and the next press asks again', async () => {
    const s = setup({ leads: THREE() })
    const base = s.dbx.db
    const db = { ...base, from: (t: string) => {
      const q = base.from(t)
      if (t === 'locations') q.update = () => { const u: any = { eq: () => u, is: () => u, select: () => u, then: (ok: any) => Promise.resolve({ data: null, error: { message: 'down' } }).then(ok) }; return u }
      return q
    } }
    const deps = { db, fetchImpl: s.mc.fetchImpl as any, sleep: noSleep, readFlowsImpl: async () => flowsAnswer(PAUSED), loadReviewImpl: reviewFrom(s.dbx, s.mc) as any, loadSuppressed: async () => new Set<string>() }
    const ask = await syncWebsiteLeadsToMailchimp(LOC, {}, deps)
    const r = await syncWebsiteLeadsToMailchimp(LOC, { confirm: confirmOf(ask) }, deps)
    expect(r).toMatchObject({ ran: true, pushed: 3, complete: true, stopReason: 'record_not_saved: down' })
    expect(firstSyncAt(s)).toBeNull()
  })
  it('nobody to send → an honest zero, no confirmation, nothing written', async () => {
    const s = setup({ leads: [lead('a', 'a@x.com')], members: [{ email: 'a@x.com', status: 'subscribed' }] })
    const r = await s.run()
    expect(r).toMatchObject({ ran: true, pushed: 0, complete: true })
    expect(s.posts()).toEqual([])
    expect(firstSyncAt(s)).toBeNull()
  })
})

describe('R2. the flows are read again right before every write', () => {
  it('a flow switched on between the confirmation and the send → stops before the first batch', async () => {
    let n = 0
    const s = setup({ leads: THREE(), flows: () => (++n <= 2 ? flowsAnswer(PAUSED) : flowsAnswer([flow({ status: 'sending', live: true }), PAUSED[1]])) })
    const ask = await s.run()                // read 1
    const r = await s.run(confirmOf(ask))    // read 2 passes; read 3 (right before the batch) sees it on
    expect(r).toMatchObject({ ran: true, complete: false, pushed: 0, remaining: 3, stopReason: 'flows_changed' })
    expect(s.posts()).toEqual([])
    expect(firstSyncAt(s)).toBeNull()            // stopped partway: no first-sync date
  })
  it('a flow switched on mid-run → stops before the next batch, says so', async () => {
    let n = 0
    const many = Array.from({ length: 7 }, (_, i) => lead('p' + i, `p${i}@x.com`))
    const s = setup({ leads: many, flows: () => (++n <= 3 ? flowsAnswer(PAUSED) : flowsAnswer([flow({ status: 'sending', live: true })])) })
    const ask = await s.run()
    const r = await s.run(confirmOf(ask), { batchSize: 3 })
    expect(r).toMatchObject({ complete: false, pushed: 3, remaining: 4, stopReason: 'flows_changed' })
    expect(s.posts()).toHaveLength(1)
  })
  it('a tag flow switched on between a batch and its tags → no tag is added, the tags stay owed, the run stops', async () => {
    let n = 0
    const leads = [lead('a', 'a@x.com', { project_type: 'Moving' }), lead('b', 'b@x.com', { project_type: 'Home' })]
    const lt = { lookups: [{ id: 't1', label: 'CLOSEDJOB' }], leadTags: [{ lead_id: 'a', tag_lookup_id: 't1' }] }
    // reads 1-3 (the look, the start of the run, right before the batch): the tag flow is off.
    // read 4 (right before the tags): someone has switched it on.
    const s = setup({ leads, ...lt, flows: () => (++n <= 3 ? flowsAnswer(PAUSED) : flowsAnswer([...PAUSED, CLOSEDJOB_LIVE])) })
    const r = await s.run(confirmOf(await s.run()))
    expect(s.posts()).toHaveLength(1)                       // the two people were added
    expect(s.mc.tagged).toEqual({})                         // and not one tag
    expect(s.mc.reqs.filter((q) => q.method === 'POST' && /segments/.test(q.url))).toEqual([])
    expect(r).toMatchObject({ complete: false, pushed: 2, remaining: 0, stopReason: 'flows_changed' })
    expect(s.dbx.tables.leads.map((l) => l.mailchimp_sync_error)).toEqual(['tags_pending: flows_changed', 'tags_pending: flows_changed'])
    expect(firstSyncAt(s)).toBeNull()            // stopped partway: no first-sync date
    // The next press: the owed tags go on, except the one that now starts a live flow.
    const r2 = await s.run()
    expect(s.mc.tagged['CLOSEDJOB']).toBeUndefined()
    expect(s.mc.tagged['Moving']).toEqual(['a@x.com'])
    expect(s.mc.tagged['Home']).toEqual(['b@x.com'])
    expect(r2.tagsHeld).toEqual(['CLOSEDJOB'])
  })
})

describe('P3. someone who unsubscribed or was cleaned in Mailchimp is never changed', () => {
  it('they are never in a batch; no member is ever PUT or PATCHed; every batch says update_existing:false', async () => {
    const s = setup({
      leads: THREE(),
      members: [{ email: 'a@x.com', status: 'unsubscribed' }, { email: 'b@x.com', status: 'cleaned' }],
    })
    const r = await s.run(confirmOf(await s.run()))
    expect(r.pushed).toBe(1)
    const sent = s.posts().flatMap((p) => p.body.members.map((m: any) => m.email_address))
    expect(sent).toEqual(['c@x.com'])
    expect(s.mc.reqs.some((q) => q.method === 'PUT' || q.method === 'PATCH' || q.method === 'DELETE')).toBe(false)
    expect(s.mc.writesToMembers()).toEqual([])
    for (const p of s.posts()) expect(p.body.update_existing).toBe(false)
    expect(s.mc.members.find((m) => m.email === 'a@x.com')!.status).toBe('unsubscribed')
    expect(s.mc.members.find((m) => m.email === 'b@x.com')!.status).toBe('cleaned')
  })
  it('someone who unsubscribes AFTER the read is refused by Mailchimp ("already a member"), counted as already there, and left alone', async () => {
    const s = setup({ leads: THREE() })
    const ask = await s.run()
    s.mc.members.push({ email: 'b@x.com', status: 'unsubscribed' })   // lands after the read
    const review = reviewFrom(s.dbx, { ...s.mc, members: [] } as any)  // the read saw nobody
    const r = await syncWebsiteLeadsToMailchimp(LOC, { confirm: confirmOf(ask) }, { db: s.dbx.db, fetchImpl: s.mc.fetchImpl as any, sleep: noSleep, readFlowsImpl: async () => flowsAnswer(PAUSED), loadReviewImpl: review as any, loadSuppressed: async () => new Set() })
    expect(r).toMatchObject({ pushed: 2, alreadyThere: 1 })
    expect(s.mc.members.find((m) => m.email === 'b@x.com')!.status).toBe('unsubscribed')
    expect(s.dbx.tables.leads.find((l) => l.id === 'b').mailchimp_status).toBe('already_in_mailchimp')
  })
  it('archived Mailchimp contacts are never sent (re-adding would undo the archive)', async () => {
    const s = setup({ leads: THREE(), archived: ['C@x.com'] })
    const ask = await s.run()
    expect(ask.confirm!.count).toBe(2)
    await s.run(confirmOf(ask))
    expect(s.posts()[0].body.members.map((m: any) => m.email_address)).not.toContain('c@x.com')
  })
  it('if Mailchimp ever reports an update, the run stops at once and is not complete', async () => {
    const s = setup({ leads: THREE() })
    const ask = await s.run()
    const f = s.mc.fetchImpl
    const lying = async (url: string, init: any) => init?.method === 'POST' && url.endsWith(`/lists/${LIST}`)
      ? ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ new_members: [], updated_members: [{ email_address: 'a@x.com' }], errors: [], total_updated: 1 }) })
      : f(url, init)
    const r = await s.run(confirmOf(ask), { fetchImpl: lying })
    expect(r).toMatchObject({ complete: false, stopReason: 'mailchimp_reported_an_update' })
  })
  it('the sending source never PUTs, PATCHes or DELETEs, and never sends update_existing: true', () => {
    const src = readFileSync(join(process.cwd(), 'lib/mailchimp-' + 'sync.ts'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(src).not.toMatch(/'(PUT|PATCH|DELETE)'/)
    expect(src).not.toMatch(/update_existing:\s*true/)
    expect(src).toMatch(/update_existing:\s*false/)
  })
})

describe('P4. someone on the no-marketing list is never sent, whatever the saved tick says', () => {
  it('ticked in by hand, then said no → not offered, not sent', async () => {
    const s = setup({ leads: THREE(), suppressedAtReview: ['b@x.com'], choices: [{ scope: 'person', key: 'b@x.com', choice: 'in' }] })
    const r = await s.run(confirmOf(await s.run()))
    expect(r.pushed).toBe(2)
    expect(s.posts()[0].body.members.map((m: any) => m.email_address)).not.toContain('b@x.com')
  })
  it('said no after the screen was built → the check right before sending still drops them', async () => {
    const s = setup({ leads: THREE(), suppressedAtSend: ['a@x.com'] })
    const ask = await s.run()
    expect(ask.confirm!.count).toBe(2)
    await s.run(confirmOf(ask))
    expect(s.posts()[0].body.members.map((m: any) => m.email_address)).toEqual(['b@x.com', 'c@x.com'])
  })
  it('the no-marketing list cannot be read → nothing sent', async () => {
    const s = setup({ leads: THREE(), noListBroken: true })
    const r = await s.run({ count: 3, listId: LIST, flows: flowsFingerprint(PAUSED) })
    expect(r.reason).toBe('no_list_unreadable')
    expect(s.posts()).toEqual([])
  })
  it('opted out, unsubscribed, Recycle Bin, no email: never sent', async () => {
    const s = setup({ leads: [lead('a', 'a@x.com', { marketing_opt_out: true }), lead('b', 'b@x.com', { marketing_unsubscribed_at: '2026-01-01' }), lead('c', 'c@x.com', { is_junk: true }), lead('d', null), lead('e', 'e@x.com')] })
    const ask = await s.run()
    expect(ask.confirm!.count).toBe(1)
    await s.run(confirmOf(ask))
    expect(s.posts()[0].body.members.map((m: any) => m.email_address)).toEqual(['e@x.com'])
  })
  it('the person list is recomputed at send time, every run — never taken from anything saved', async () => {
    const s = setup({ leads: THREE() })
    await s.run(); await s.run()
    expect(s.reviewCalls.n).toBe(2)
  })
})

describe('P5. running it twice does not add anyone twice', () => {
  it('second run: everyone is now in Mailchimp → nothing to send', async () => {
    const s = setup({ leads: THREE() })
    await s.run(confirmOf(await s.run()))
    const before = s.posts().length
    const r2 = await s.run()
    expect(r2).toMatchObject({ ran: true, pushed: 0 })
    expect(s.posts().length).toBe(before)
    expect(s.mc.members.filter((m) => m.email === 'a@x.com')).toHaveLength(1)
  })
  it('two records with one address → one person, one add, both records stamped', async () => {
    const s = setup({ leads: [lead('a', 'a@x.com'), lead('a2', ' A@X.com ')] })
    const r = await s.run(confirmOf(await s.run()))
    expect(r.pushed).toBe(1)
    expect(s.posts()[0].body.members).toHaveLength(1)
    for (const id of ['a', 'a2']) expect(s.dbx.tables.leads.find((l) => l.id === id).mailchimp_status).toBe('subscribed')
  })
  it('a batch retried after a lost answer: "already a member" from our own first try counts as added, once', async () => {
    let first = true
    const s = setup({ leads: THREE() })
    const ask = await s.run()
    const f = s.mc.fetchImpl
    const flaky = async (url: string, init: any) => {
      if (init?.method === 'POST' && url.endsWith(`/lists/${LIST}`) && first) { first = false; await f(url, init); throw new Error('socket hang up') }
      return f(url, init)
    }
    const r = await s.run(confirmOf(ask), { fetchImpl: flaky })
    expect(r).toMatchObject({ pushed: 3, alreadyThere: 0, complete: true })
    expect(s.mc.members).toHaveLength(3)
  })
})

describe('P6. a half-done sync says so', () => {
  it('batches of 500: 1,200 people → 500, 500, 200', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => lead('p' + i, `p${String(i).padStart(4, '0')}@x.com`))
    const s = setup({ leads: many })
    const r = await s.run(confirmOf(await s.run()))
    expect(BATCH_SIZE).toBe(500)
    expect(s.posts().map((p) => p.body.members.length)).toEqual([500, 500, 200])
    expect(r).toMatchObject({ complete: true, pushed: 1200 })
  })
  it('rate limited past the retries on batch 2 → stops: complete false, 500 added, 700 left, a partial record, never "complete"', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => lead('p' + i, `p${String(i).padStart(4, '0')}@x.com`))
    let batches = 0
    const s = setup({ leads: many, fail: (url: string, method: string) => (method === 'POST' && url.endsWith(`/lists/${LIST}`) && ++batches >= 2 ? 429 : null) })
    const r = await s.run(confirmOf(await s.run()))
    expect(r).toMatchObject({ ran: true, complete: false, pushed: 500, remaining: 700 })
    expect(r.stopReason).toMatch(/batch_failed: http 429/)
    expect(batches).toBe(1 + 4)                                  // batch 2: first try + 3 retries
    expect(firstSyncAt(s)).toBeNull()
  })
  it('…and carrying on asks again for the 700 left, sends only them, then records complete', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => lead('p' + i, `p${String(i).padStart(4, '0')}@x.com`))
    let batches = 0, failing = true
    const s = setup({ leads: many, fail: (url: string, method: string) => (failing && method === 'POST' && url.endsWith(`/lists/${LIST}`) && ++batches >= 2 ? 429 : null) })
    await s.run(confirmOf(await s.run()))
    failing = false
    const ask = await s.run()
    expect(ask.confirm!.count).toBe(700)
    const r = await s.run(confirmOf(ask))
    expect(r).toMatchObject({ complete: true, pushed: 700, remaining: 0 })
    expect(s.mc.members).toHaveLength(1200)
    expect(firstSyncAt(s)).toEqual(expect.any(String))   // only now, when everything went
  })
  it('out of time → stops before the next batch, says how many are left', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => lead('p' + i, `p${String(i).padStart(4, '0')}@x.com`))
    let t = 0
    const s = setup({ leads: many })
    const ask = await s.run()
    const r = await s.run(confirmOf(ask), { now: () => (t += 20_000) })
    expect(r.complete).toBe(false)
    expect(r.stopReason).toBe('time')
    expect(r.remaining).toBeGreaterThan(0)
    expect(r.pushed + r.remaining).toBe(1200)
  })
  it('a Bee Hub write failing mid-run → recorded partial, never complete', async () => {
    const s = setup({ leads: THREE() })
    const ask = await s.run()
    const base = s.dbx.db
    const db = { ...base, from: (t: string) => { const q = base.from(t); if (t === 'leads') q.update = () => ({ in: async () => ({ error: { message: 'disk full' } }) }); return q } }
    const r = await s.run(confirmOf(ask), { db })
    expect(r.complete).toBe(false)
    expect(r.stopReason).toMatch(/disk full/)
    expect(firstSyncAt(s)).toBeNull()            // stopped partway: no first-sync date
  })
  it('one refused address does not stop the rest; it is reported, the run still completes', async () => {
    const s = setup({ leads: [lead('a', 'a@x.com'), lead('f', 'fake@x.com'), lead('c', 'c@x.com')] })
    const r = await s.run(confirmOf(await s.run()))
    expect(r).toMatchObject({ complete: true, pushed: 2, failed: 1 })
    expect(s.dbx.tables.leads.find((l) => l.id === 'f').mailchimp_sync_error).toMatch(/fake/)
    expect(s.dbx.tables.leads.find((l) => l.id === 'f').mailchimp_synced_at).toBeUndefined()
  })
})

describe('tags carry over; R4. a tag that starts a live flow needs the owner’s yes', () => {
  const tagged = () => [
    lead('a', 'a@x.com', { project_type: 'Moving', source: 'Website' }),
    lead('b', 'b@x.com', { project_type: 'Home' }),
  ]
  const lt = { lookups: [{ id: 't1', label: 'CLOSEDJOB' }, { id: 't2', label: 'Hive Favourite' }], leadTags: [{ lead_id: 'a', tag_lookup_id: 't1' }, { lead_id: 'a', tag_lookup_id: 't2' }] }
  it('tags land on the people this run added — including a location’s own — and a missing tag is created', async () => {
    const s = setup({ leads: tagged(), flows: PAUSED, ...lt })
    await s.run(confirmOf(await s.run()))
    expect(s.mc.tagged['Moving']).toEqual(['a@x.com'])
    expect(s.mc.tagged['Website']).toEqual(['a@x.com'])
    expect(s.mc.tagged['Hive Favourite']).toEqual(['a@x.com'])
    expect(s.mc.tagged['Home']).toEqual(['b@x.com'])
    expect(s.mc.segments.some((x) => x.name === 'Hive Favourite')).toBe(true)
  })
  it('CLOSEDJOB starts a live flow → listed on the confirmation, held back without a yes', async () => {
    const s = setup({ leads: tagged(), flows: [...PAUSED, CLOSEDJOB_LIVE], ...lt })
    const ask = await s.run()
    expect(ask.confirm!.heldTags).toEqual([{ tag: 'CLOSEDJOB', flows: ['Closed Job Journey'], people: 1 }])
    const r = await s.run(confirmOf(ask))
    expect(s.mc.tagged['CLOSEDJOB']).toBeUndefined()
    expect(s.mc.tagged['Hive Favourite']).toEqual(['a@x.com'])
    expect(r.tagsHeld).toEqual(['CLOSEDJOB'])
  })
  it('…carried when the owner ticked that tag (case does not matter)', async () => {
    const s = setup({ leads: tagged(), flows: [...PAUSED, CLOSEDJOB_LIVE], ...lt })
    const r = await s.run(confirmOf(await s.run(), ['closedjob']))
    expect(s.mc.tagged['CLOSEDJOB']).toEqual(['a@x.com'])
    expect(r.tagsHeld).toEqual([])
  })
  it('one tag at a time: a yes to one held tag carries that one and still holds the other', async () => {
    const VIP_LIVE = flow({ id: '4', name: 'VIP Thanks', status: 'sending', live: true, start: 'tag', startWords: 'Contact tagged VIP', tag: 'VIP' })
    const two = { lookups: [{ id: 't1', label: 'CLOSEDJOB' }, { id: 't3', label: 'VIP' }], leadTags: [{ lead_id: 'a', tag_lookup_id: 't1' }, { lead_id: 'a', tag_lookup_id: 't3' }, { lead_id: 'b', tag_lookup_id: 't3' }] }
    const s = setup({ leads: tagged(), flows: [...PAUSED, CLOSEDJOB_LIVE, VIP_LIVE], ...two })
    const ask = await s.run()
    expect(ask.confirm!.heldTags).toEqual([{ tag: 'CLOSEDJOB', flows: ['Closed Job Journey'], people: 1 }, { tag: 'VIP', flows: ['VIP Thanks'], people: 2 }])
    const r = await s.run(confirmOf(ask, ['CLOSEDJOB']))
    expect(s.mc.tagged['CLOSEDJOB']).toEqual(['a@x.com'])
    expect(s.mc.tagged['VIP']).toBeUndefined()
    expect(r.tagsHeld).toEqual(['VIP'])
  })
  it('after the first sync there is no confirmation, so a held tag is never carried', async () => {
    const s = setup({ leads: tagged(), flows: [...PAUSED, CLOSEDJOB_LIVE], location: SYNCED, ...lt })
    const r = await s.run({ count: 2, listId: LIST, flows: 'x', tagsOk: ['CLOSEDJOB'] })
    expect(s.mc.tagged['CLOSEDJOB']).toBeUndefined()
    expect(r.tagsHeld).toEqual(['CLOSEDJOB'])
  })
  it('a tag that fails to land → the run is not complete; the next run finishes the owed tags first', async () => {
    let failTags = true
    const s = setup({ leads: tagged(), ...lt, fail: (url: string, method: string) => (failTags && method === 'POST' && /segments\/\d+$/.test(url) ? 500 : null) })
    const r1 = await s.run(confirmOf(await s.run()))
    expect(r1.complete).toBe(false)
    expect(r1.stopReason).toMatch(/tags_failed/)
    expect(s.dbx.tables.leads.find((l) => l.id === 'a').mailchimp_sync_error).toMatch(/^tags_pending:/)
    failTags = false
    const r2 = await s.run()   // everyone is in Mailchimp now; only the owed tags are left
    expect(r2.complete).toBe(true)
    expect(s.mc.tagged['Moving']).toEqual(['a@x.com'])
    expect(s.dbx.tables.leads.find((l) => l.id === 'a').mailchimp_sync_error).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════
// lib/mailchimp-flows.ts, against Mailchimp-shaped answers
describe('reading the flows (GET only, fail closed)', () => {
  function mcFlows(o: { journeys: any[]; steps: Record<string, any[] | null>; automations?: any[]; segments?: any[]; fail?: (path: string) => number | null }) {
    const reqs: { method: string; path: string }[] = []
    const fetchImpl = async (url: string, init: any) => {
      const path = url.replace(/^https:\/\/us9\.api\.mailchimp\.com\/3\.0\//, '')
      reqs.push({ method: init.method, path })
      const reply = (status: number, b: any) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(b) })
      const f = o.fail?.(path); if (f) return reply(f, { detail: 'x' })
      if (path.startsWith('customer-journeys/journeys?')) return reply(200, { journeys: o.journeys, total_items: o.journeys.length })
      const st = path.match(/^customer-journeys\/journeys\/(\d+)\/steps$/)
      if (st) return o.steps[st[1]] === null ? reply(200, { nothing: true }) : reply(200, { steps: o.steps[st[1]] })
      if (path.startsWith('automations?')) return reply(200, { automations: o.automations || [], total_items: (o.automations || []).length })
      if (path.startsWith(`lists/${LIST}/segments?`)) return reply(200, { segments: o.segments || [], total_items: (o.segments || []).length })
      return reply(404, {})
    }
    return { reqs, read: () => readFlows({ token: TOKEN, serverPrefix: 'us9', listId: LIST, fetchImpl: fetchImpl as any, sleep: noSleep }) }
  }
  const SIGNUP = [{ step_type: 'trigger', trigger_type: 'signup', display_text: 'Contact signs up to ', display_subtext: 'Bee Organized Friends' }, { step_type: 'action-send_email' }]
  const TAG = [{ step_type: 'trigger-tag_added', trigger_settings: { tag_id: 16 }, display_text: 'Contact tagged ', display_subtext: 'CLOSEDJOB' }]
  const J = (id: number, name: string, status: string, list = LIST) => ({ id, journey_name: name, status, list_id: list })

  it('Chattanooga today: two sign-up flows on → both must be paused; the tag flow is a tag flow', async () => {
    const m = mcFlows({ journeys: [J(1, 'Profile Quiz - Welcome Flow', 'sending'), J(2, 'Closed Job Journey', 'sending'), J(3, 'Welcome New Contacts', 'sending')], steps: { 1: SIGNUP, 2: TAG, 3: SIGNUP }, segments: [{ id: 16, name: 'CLOSEDJOB' }] })
    const r = await m.read()
    if (!r.ok) throw new Error('should read')
    expect(r.mustPause.map((f) => f.name).sort()).toEqual(['Profile Quiz - Welcome Flow', 'Welcome New Contacts'])
    expect(r.tagFlows).toMatchObject([{ name: 'Closed Job Journey', tag: 'CLOSEDJOB' }])
    expect(m.reqs.every((q) => q.method === 'GET')).toBe(true)
  })
  it('paused and draft are off; any other status — known or not — is live', async () => {
    const m = mcFlows({ journeys: [J(1, 'A', 'paused'), J(2, 'B', 'draft'), J(3, 'C', 'mystery_state')], steps: { 1: SIGNUP, 2: SIGNUP, 3: SIGNUP } })
    const r: any = await m.read()
    expect(r.mustPause.map((f: Flow) => f.name)).toEqual(['C'])
  })
  it('a live flow with a start we do not recognise must be paused too', async () => {
    const m = mcFlows({ journeys: [J(1, 'Birthday', 'sending')], steps: { 1: [{ step_type: 'trigger-date_based' }] } })
    const r: any = await m.read()
    expect(r.mustPause.map((f: Flow) => f.name)).toEqual(['Birthday'])
  })
  it('a tag flow whose tag cannot be named cannot be guarded → must be paused', async () => {
    const m = mcFlows({ journeys: [J(2, 'Closed Job Journey', 'sending')], steps: { 2: TAG }, segments: [] })
    const r: any = await m.read()
    expect(r.mustPause.map((f: Flow) => f.name)).toEqual(['Closed Job Journey'])
  })
  it('flows on other audiences are ignored', async () => {
    const m = mcFlows({ journeys: [J(1, 'Elsewhere', 'sending', 'other')], steps: {} })
    const r: any = await m.read()
    expect(r.flows).toEqual([])
  })
  it('a live classic automation on this audience must be paused', async () => {
    const m = mcFlows({ journeys: [], steps: {}, automations: [{ id: 'a1', status: 'sending', settings: { title: 'Old welcome' }, recipients: { list_id: LIST }, trigger_settings: { workflow_type: 'welcomeSeries' } }] })
    const r: any = await m.read()
    expect(r.mustPause.map((f: Flow) => f.name)).toEqual(['Old welcome'])
  })
  it('steps unreadable, or any read failing after retries → not ok (the sync refuses)', async () => {
    expect((await mcFlows({ journeys: [J(1, 'A', 'paused')], steps: { 1: null } }).read()).ok).toBe(false)
    const m = mcFlows({ journeys: [], steps: {}, fail: (p) => (p.startsWith('automations?') ? 429 : null) })
    expect((await m.read()).ok).toBe(false)
    expect(m.reqs.filter((q) => q.path.startsWith('automations?'))).toHaveLength(4)
  })
  it('the fingerprint moves when a flow changes state', () => {
    const a = flowsFingerprint([flow({})])
    expect(flowsFingerprint([flow({})])).toBe(a)
    expect(flowsFingerprint([flow({ status: 'sending', live: true })])).not.toBe(a)
  })
  it('the token never appears in a failure', async () => {
    const r = await mcFlows({ journeys: [], steps: {}, fail: () => 401 }).read()
    expect(JSON.stringify(r)).not.toContain(TOKEN)
  })
})

describe('slice 6 changed BeeHub.jsx in the Mailchimp card only', () => {
  it('BeeHub.jsx is main 36d0752 plus the slice 6 pieces, and nothing else', async () => {
    const { execSync } = await import('child_process')
    const { createHash } = await import('crypto')
    const { withoutMailchimpSendSlice6 } = await import('./network/mailchimp-send-hub-footprint')
    const sha = (t: string) => createHash('sha256').update(t).digest('hex')
    // 2026-11-25: brought up to date with main 36d0752 (the Slack and Jobber
    // screens). Slice 6 touches none of their lines.
    const then = execSync('git show 36d0752:components/BeeHub.jsx', { cwd: process.cwd(), maxBuffer: 1 << 27 }).toString()
    expect(sha(withoutMailchimpSendSlice6(readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')))).toBe(sha(then))
  })
})

// 2026-11-26 (Kevin): a stale first-sync date must never let a NEW audience
// skip the first-sync question — the guard built after Chattanooga.
describe('a cleared location asks the first-sync question again, with the count and the audience name', () => {
  it('first sync done on an old audience → the owner picks this one → asked again: 3 people, “Bee Organized Friends”', async () => {
    const s = setup({ leads: THREE(), location: { ...SYNCED, mailchimp_review_done_at: '2026-11-20T11:00:00.000Z', mailchimp_list_id: 'oldlist01', mailchimp_list_name: 'Old Audience' } })
    const { saveAudience } = await import('./mailchimp-connection-write')
    const saved = await saveAudience(LOC, { id: LIST, name: 'Bee Organized Friends' }, { db: enforceRealRules(s.dbx.db) })
    expect(saved).toEqual({ ok: true, changed: true, progressReset: true, previousName: 'Old Audience' })
    expect([s.dbx.location.mailchimp_first_sync_at, s.dbx.location.mailchimp_review_done_at]).toEqual([null, null])
    const r = await s.run()
    expect(r).toMatchObject({ ran: false, reason: 'needs_confirmation' })
    expect(r.confirm).toMatchObject({ count: 3, listId: LIST, listName: 'Bee Organized Friends' })
    expect(s.posts()).toEqual([])                       // nobody added without the yes
  })
  it('…while the SAME audience saved again keeps the first sync: no question, it just syncs', async () => {
    const s = setup({ leads: THREE(), location: SYNCED })
    const { saveAudience } = await import('./mailchimp-connection-write')
    expect(await saveAudience(LOC, { id: LIST, name: 'Bee Organized Friends' }, { db: enforceRealRules(s.dbx.db) })).toMatchObject({ ok: true, changed: false })
    expect(s.dbx.location.mailchimp_first_sync_at).toBe(SYNCED.mailchimp_first_sync_at)
    expect(await s.run()).toMatchObject({ ran: true, first: false, pushed: 3 })
  })
})

// 2026-11-26 (Kevin): a Mailchimp sync never reads, sends, tags, stamps or
// writes to a record in the Recycle Bin. Tags come only from live records.
// (This file's review helper hands the sync EVERY record id, bin included, as
// the loader used to — so these prove the sending code's own check.)
describe('the Recycle Bin: never read, sent, tagged, stamped or written', () => {
  const BIN = { is_junk: true }
  const touched = (s: any, id: string) => s.dbx.writes.filter((w: any) => (w.ids || []).includes(id))
  it('an address on a live record and a binned one: sent once, tagged from the live record only, only the live record stamped', async () => {
    const leads = [lead('a', 'a@x.com', { project_type: 'Moving' }), lead('abin', 'A@x.com', { ...BIN, project_type: 'Storage', source: 'Bin Source' })]
    const lt = { lookups: [{ id: 't1', label: 'BINTAG' }, { id: 't2', label: 'LIVETAG' }], leadTags: [{ lead_id: 'abin', tag_lookup_id: 't1' }, { lead_id: 'a', tag_lookup_id: 't2' }] }
    const s = setup({ leads, ...lt })
    const before = JSON.stringify(s.dbx.tables.leads.find((l: any) => l.id === 'abin'))
    const r = await s.run(confirmOf(await s.run()))
    expect(r).toMatchObject({ complete: true, pushed: 1 })
    expect(s.posts()[0].body.members.map((m: any) => m.email_address)).toEqual(['a@x.com'])
    const tags = Object.keys(s.mc.tagged)
    expect(tags).toEqual(expect.arrayContaining(['LIVETAG', 'Moving']))           // the live record's own tags
    for (const t of ['BINTAG', 'Storage', 'Bin Source']) expect(tags, t).not.toContain(t)   // nothing from the bin record
    expect(s.dbx.tables.leads.find((l: any) => l.id === 'a').mailchimp_synced_at).toEqual(expect.any(String))
    expect(touched(s, 'abin')).toEqual([])
    expect(JSON.stringify(s.dbx.tables.leads.find((l: any) => l.id === 'abin'))).toBe(before)
  })
  it('refused by Mailchimp: the refusal is written to the live record only, never the binned one (today’s dup.test.one)', async () => {
    const leads = [lead('d', 'dup.fake@x.com'), lead('dbin', 'dup.fake@x.com', BIN)]
    const s = setup({ leads })
    const r = await s.run(confirmOf(await s.run()))
    expect(r).toMatchObject({ failed: 1 })
    expect(s.dbx.tables.leads.find((l: any) => l.id === 'd').mailchimp_sync_error).toMatch(/fake/)
    expect(touched(s, 'dbin')).toEqual([])
    expect(s.dbx.tables.leads.find((l: any) => l.id === 'dbin').mailchimp_sync_error).toBeUndefined()
  })
  it('owed tags on a binned record are not finished: the record is never even read, no tag call, no write', async () => {
    const leads = [lead('p', 'p@x.com', { ...BIN, project_type: 'Moving', mailchimp_sync_error: 'tags_pending: x' }), lead('q', 'q@x.com')]
    const s = setup({ leads, members: [{ email: 'p@x.com', status: 'subscribed' }, { email: 'q@x.com', status: 'subscribed' }], location: SYNCED })
    // every row the sending code reads from leads
    const seen: string[] = []
    const realFrom = s.dbx.db.from
    s.dbx.db.from = (t: string) => {
      const q = realFrom(t)
      if (t !== 'leads') return q
      const then = q.then
      q.then = (ok: any, bad: any) => then((r: any) => { for (const row of r?.data || []) seen.push(row.id); return ok(r) }, bad)
      return q
    }
    await s.run()
    expect(seen).not.toContain('p')
    expect(s.mc.reqs.filter((q) => q.method === 'POST')).toEqual([])
    expect(touched(s, 'p')).toEqual([])
  })
  it('a record put in the bin after the screen was read is dropped right before sending (the check is in the sending code)', async () => {
    const leads = [lead('a', 'a@x.com'), lead('b', 'b@x.com')]
    const s = setup({ leads, location: SYNCED })
    // the review (read first) still offers b; the row is binned by the time the sending code reads it
    const realFrom = s.dbx.db.from
    let reads = 0
    s.dbx.db.from = (t: string) => { if (t === 'leads') { reads++; if (reads > 1) s.dbx.tables.leads.find((l: any) => l.id === 'b').is_junk = true } return realFrom(t) }
    const r = await s.run()
    expect(s.posts().flatMap((p) => p.body.members.map((m: any) => m.email_address))).toEqual(['a@x.com'])
    expect(r).toMatchObject({ pushed: 1 })
    expect(touched(s, 'b')).toEqual([])
  })
})

// 2026-11-26 (Kevin): the people Mailchimp refused are remembered, by address,
// and never silently re-sent. A "no" goes on the no-marketing list instead.
describe('the people Mailchimp refused', () => {
  const sentTo = (s: any) => s.posts().flatMap((p: any) => p.body.members.map((m: any) => m.email_address))
  const refusal = (s: any, key: string) => s.dbx.tables.mailchimp_refusals.find((r: any) => r.email_key === key)

  it('a refused person is recorded, by address, with what Mailchimp said — through the real rules', async () => {
    const s = setup({ leads: [lead('a', 'a@x.com'), lead('f', 'Bad.fake@x.com')] })
    const r = await s.run(confirmOf(await s.run()))
    expect(r).toMatchObject({ complete: true, pushed: 1, failed: 1, saidNo: 0, heldBack: 0 })
    expect(refusal(s, 'bad.fake@x.com')).toMatchObject({
      location_id: LOC, email_key: 'bad.fake@x.com', kind: 'invalid', mailchimp_code: 'ERROR_GENERIC',
      mailchimp_said: 'Bad.fake@x.com looks fake or invalid, please enter a real email address.', refused_count: 1, held: true, retry_requested_at: null,
    })
  })

  it('a refused person is NOT silently re-sent on the next sync: held, and the result says so', async () => {
    const s = setup({ leads: [lead('a', 'a@x.com'), lead('f', 'fake.one@x.com')] })
    await s.run(confirmOf(await s.run()))
    const r2 = await s.run()                               // the first sync is done: no confirmation
    expect(sentTo(s)).toEqual(['a@x.com', 'fake.one@x.com'])   // only the first run's batch went
    expect(r2).toMatchObject({ ran: true, first: false, pushed: 0, failed: 0, heldBack: 1 })
    expect(syncResultWords(r2, 'Bee Organized Friends')).toBe('Nothing new to add. 1 person Mailchimp refused before wasn’t sent again.')
  })

  it('a corrected address is a new address: it is sent on the next sync', async () => {
    const s = setup({ leads: [lead('f', 'fake.one@x.com')], location: SYNCED, refusals: [{ location_id: LOC, email_key: 'fake.one@x.com', kind: 'invalid', mailchimp_code: 'ERROR_GENERIC', mailchimp_said: 'looks fake', refused_count: 1, first_refused_at: 'x', last_refused_at: 'x', held: true, retry_requested_at: null }] })
    s.dbx.tables.leads[0].email = 'real.one@x.com'
    const r = await s.run()
    expect(sentTo(s)).toEqual(['real.one@x.com'])
    expect(r).toMatchObject({ pushed: 1, heldBack: 0 })
  })

  it('Try again sends a held address once: refused again → counted, held again; accepted → forgotten', async () => {
    let ok = false
    const held = { location_id: LOC, email_key: 'fake.one@x.com', kind: 'invalid', mailchimp_code: 'ERROR_GENERIC', mailchimp_said: 'looks fake', refused_count: 1, first_refused_at: 'x', last_refused_at: 'x', held: true, retry_requested_at: '2026-11-26T17:00:00Z' }
    const s = setup({ leads: [lead('f', 'fake.one@x.com')], location: SYNCED, refusals: [held], accepts: () => ok })
    expect(await s.run()).toMatchObject({ pushed: 0, failed: 1, heldBack: 0 })
    expect(refusal(s, 'fake.one@x.com')).toMatchObject({ refused_count: 2, held: true, retry_requested_at: null })
    expect(await s.run()).toMatchObject({ pushed: 0, heldBack: 1 })           // Try again is used up
    refusal(s, 'fake.one@x.com').retry_requested_at = '2026-11-26T18:00:00Z'
    ok = true
    expect(await s.run()).toMatchObject({ pushed: 1, failed: 0 })
    expect(refusal(s, 'fake.one@x.com')).toBeUndefined()
  })

  it('a possibly temporary refusal is tried again, and held after 3', async () => {
    const s = setup({ leads: [lead('b', 'busy@x.com')], location: SYNCED })
    for (let i = 1; i <= 3; i++) {
      expect(await s.run(), `run ${i}`).toMatchObject({ failed: 1, heldBack: 0 })
      expect(refusal(s, 'busy@x.com')).toMatchObject({ kind: 'temporary', refused_count: i, held: i >= 3 })
    }
    expect(await s.run()).toMatchObject({ failed: 0, heldBack: 1 })
    expect(sentTo(s).filter((e: string) => e === 'busy@x.com')).toHaveLength(3)
  })

  it('a "no" in Mailchimp (permanently deleted) goes on the no-marketing list — not the refused list, no Try again', async () => {
    const s = setup({ leads: [lead('g', 'gone@x.com'), lead('a', 'a@x.com')] })
    const r = await s.run(confirmOf(await s.run()))
    expect(r).toMatchObject({ complete: true, pushed: 1, failed: 0, saidNo: 1 })
    expect(s.dbx.rpcCalls).toEqual([{ fn: 'marketing_unsubscribe_from_mailchimp', args: { p_email: 'gone@x.com', p_location: LOC, p_audience: LIST, p_note: expect.stringContaining('Mailchimp said: gone@x.com was permanently deleted') } }])
    expect(refusal(s, 'gone@x.com')).toBeUndefined()
    // next sync: the no-marketing list keeps them out (loadSuppressed is this test's stand-in for it)
    expect(syncResultWords(r, 'Bee Organized Friends')).toContain('1 person had said no in Mailchimp (unsubscribed, bounced or removed), so they are now on your no-marketing list')
  })

  it('…if the no-marketing list can’t be written (its function not there yet), the "no" is kept as a refusal — never lost', async () => {
    const s = setup({ leads: [lead('g', 'gone@x.com')], noListFnMissing: true })
    const r = await s.run(confirmOf(await s.run()))
    expect(r).toMatchObject({ saidNo: 0, failed: 1 })
    expect(refusal(s, 'gone@x.com')).toMatchObject({ kind: 'temporary', held: false })
  })

  it('before the migration (no refusals table): nobody is held, nothing is recorded there, the sync runs as before', async () => {
    const s = setup({ leads: [lead('f', 'fake.one@x.com')], location: SYNCED, refusals: 'missing' })
    expect(await s.run()).toMatchObject({ ran: true, failed: 1, heldBack: 0 })
    expect(await s.run()).toMatchObject({ ran: true, failed: 1, heldBack: 0 })   // tried again: the old behaviour
    expect(s.dbx.writes.filter((w: any) => w.table === 'mailchimp_refusals')).toEqual([])
  })

  it('the result line tells the truth: today’s 14 added and 6 refused', () => {
    expect(syncResultWords({ ran: true, complete: true, pushed: 14, already: 0, failed: 6, said_no: 0, held_back: 0, remaining: 0 }, 'Test Bee Organized'))
      .toBe('Done: added 14 people to Test Bee Organized. 6 people couldn’t be added — Mailchimp refused them (see who on the Mailchimp screen).')
  })
})
