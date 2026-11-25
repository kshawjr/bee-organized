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
import { describe, it, expect, vi } from 'vitest'
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

const LOC = '11111111-1111-4111-8111-111111111111'
const LIST = 'list1'
const TOKEN = 'tok-SECRET-123'
const noSleep = async () => {}

// ── A small stand-in for Supabase ─────────────────────────────
function fakeDb(o: { leads: any[]; location?: any; syncLog?: any[]; noListBroken?: boolean; lookups?: any[]; leadTags?: any[] } ) {
  const tables: Record<string, any[]> = {
    leads: o.leads, sync_log: o.syncLog || [], lookups: o.lookups || [], lead_tags: o.leadTags || [],
    engagements: [], touchpoints: [], service_requests: [], quotes: [], jobs: [], partners: [], marketing_unsubscribes: [],
  }
  const location = {
    id: LOC, location_id: 'loc_t', mailchimp_connected: true, mailchimp_access_token: TOKEN, mailchimp_server_prefix: 'us9',
    mailchimp_list_id: LIST, mailchimp_list_name: 'Bee Organized Friends', mailchimp_sync_live: true, ...(o.location || {}),
  }
  const writes: { table: string; op: string; patch?: any; ids?: string[]; row?: any }[] = []
  const from = (table: string) => {
    const f: Array<(r: any) => boolean> = []
    let head = false, limit = Infinity
    const run = () => {
      if (table === 'marketing_unsubscribes' && o.noListBroken) return { data: null, error: { message: 'broken' }, count: null }
      const rows = (table === 'locations' ? [location] : tables[table] || []).filter((r) => f.every((fn) => fn(r))).slice(0, limit)
      return { data: head ? null : rows, error: null, count: rows.length }
    }
    const q: any = {
      select: (_c: string, opt?: any) => { if (opt?.head) head = true; return q },
      eq: (c: string, v: any) => { f.push((r) => r[c] === v); return q },
      in: (c: string, v: any[]) => { f.push((r) => v.includes(r[c])); return q },
      is: (c: string, v: any) => { f.push((r) => (r[c] ?? null) === v); return q },
      like: (c: string, pat: string) => { const pre = pat.replace(/%$/, ''); f.push((r) => typeof r[c] === 'string' && r[c].startsWith(pre)); return q },
      limit: (n: number) => { limit = n; return q },
      maybeSingle: async () => { const r = run(); return { data: (r.data || [])[0] || null, error: r.error } },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
      update: (patch: any) => ({
        in: async (c: string, ids: string[]) => {
          writes.push({ table, op: 'update', patch, ids })
          for (const r of tables[table]) if (ids.includes(r[c])) Object.assign(r, patch)
          return { error: null }
        },
      }),
      insert: async (row: any) => { writes.push({ table, op: 'insert', row }); tables[table].push(row); return { error: null } },
    }
    return q
  }
  return { db: { from, rpc: () => { throw new Error('no rpc') } }, writes, tables, location }
}

// ── A small stand-in for Mailchimp ────────────────────────────
type Member = { email: string; status: string }
function fakeMailchimp(o: { members?: Member[]; archived?: string[]; segments?: { id: string; name: string }[]; fail?: (url: string, method: string, n: number) => number | null }) {
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
        else if (m.email_address.includes('fake')) errors.push({ email_address: m.email_address, error: 'looks fake or invalid', error_code: 'ERROR_GENERIC' })
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

function setup(o: { leads: any[]; members?: Member[]; flows?: Flow[] | (() => FlowsRead); suppressedAtReview?: string[]; suppressedAtSend?: string[]; choices?: StoredChoice[]; location?: any; syncLog?: any[]; archived?: string[]; fail?: any; noListBroken?: boolean; lookups?: any[]; leadTags?: any[] }) {
  const dbx = fakeDb({ leads: o.leads, location: o.location, syncLog: o.syncLog, noListBroken: o.noListBroken, lookups: o.lookups, leadTags: o.leadTags })
  const mc = fakeMailchimp({ members: o.members, archived: o.archived, fail: o.fail })
  const flowCalls = { n: 0 }
  const reviewCalls = { n: 0 }
  const deps = {
    db: dbx.db, fetchImpl: mc.fetchImpl as any, sleep: noSleep,
    readFlowsImpl: async () => { flowCalls.n++; return typeof o.flows === 'function' ? o.flows() : flowsAnswer(o.flows || PAUSED) },
    loadReviewImpl: reviewFrom(dbx, mc, { suppressed: o.suppressedAtReview, choices: o.choices, calls: reviewCalls }) as any,
    loadSuppressed: async () => new Set(o.suppressedAtSend || []),
  }
  const run = (confirm?: any, extra: any = {}) => syncWebsiteLeadsToMailchimp(LOC, { confirm: confirm ?? null }, { ...deps, ...extra })
  const posts = () => mc.reqs.filter((r) => r.method === 'POST' && r.url.endsWith(`/lists/${LIST}`))
  return { dbx, mc, run, posts, flowCalls, reviewCalls }
}
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
    const s = setup({ leads: THREE(), flows: live, syncLog: [{ entity_type: 'mailchimp_push', entity_id: LOC, status: 'complete' }] })
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
    expect(s.dbx.tables.sync_log.at(-1)).toMatchObject({ entity_type: 'mailchimp_push', entity_id: LOC, status: 'complete', direction: 'outbound' })
  })
  it('once a run has completed, later runs need no confirm (and still check the flows)', async () => {
    const s = setup({ leads: THREE(), syncLog: [{ entity_type: 'mailchimp_push', entity_id: LOC, status: 'complete' }] })
    const r = await s.run()
    expect(r).toMatchObject({ ran: true, complete: true, pushed: 3, first: false })
    expect(s.flowCalls.n).toBeGreaterThanOrEqual(2)
  })
  it('a partial run is NOT a finished first sync: carrying on asks again, for what is left', async () => {
    const s = setup({ leads: THREE(), syncLog: [{ entity_type: 'mailchimp_push', entity_id: LOC, status: 'partial' }] })
    expect((await s.run()).reason).toBe('needs_confirmation')
  })
  it('the "first?" record cannot be read → throws, never guesses "not first"', async () => {
    const s = setup({ leads: THREE() })
    const db = { ...s.dbx.db, from: (t: string) => t === 'sync_log' ? { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: 'down' } }) }) }) }) }) } : s.dbx.db.from(t) }
    await expect(syncWebsiteLeadsToMailchimp(LOC, {}, { db, fetchImpl: s.mc.fetchImpl as any, sleep: noSleep, readFlowsImpl: async () => flowsAnswer(PAUSED), loadReviewImpl: reviewFrom(s.dbx, s.mc) as any, loadSuppressed: async () => new Set() })).rejects.toThrow(/first-sync record/)
    expect(s.posts()).toEqual([])
  })
  it('nobody to send → an honest zero, no confirmation, nothing written', async () => {
    const s = setup({ leads: [lead('a', 'a@x.com')], members: [{ email: 'a@x.com', status: 'subscribed' }] })
    const r = await s.run()
    expect(r).toMatchObject({ ran: true, pushed: 0, complete: true })
    expect(s.posts()).toEqual([])
    expect(s.dbx.tables.sync_log).toEqual([])
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
    expect(s.dbx.tables.sync_log.at(-1).status).toBe('partial')
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
    expect(s.dbx.tables.sync_log.map((x) => x.status)).toEqual(['partial'])
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
    expect(s.dbx.tables.sync_log.map((x) => x.status)).toEqual(['partial', 'complete'])
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
    expect(s.dbx.tables.sync_log.at(-1).status).toBe('partial')
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
  it('after the first sync there is no confirmation, so a held tag is never carried', async () => {
    const s = setup({ leads: tagged(), flows: [...PAUSED, CLOSEDJOB_LIVE], syncLog: [{ entity_type: 'mailchimp_push', entity_id: LOC, status: 'complete' }], ...lt })
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
  it('BeeHub.jsx is main a8c77c0 plus the slice 6 pieces, and nothing else', async () => {
    const { execSync } = await import('child_process')
    const { createHash } = await import('crypto')
    const { withoutMailchimpSendSlice6 } = await import('./network/mailchimp-send-hub-footprint')
    const sha = (t: string) => createHash('sha256').update(t).digest('hex')
    const then = execSync('git show a8c77c0:components/BeeHub.jsx', { cwd: process.cwd(), maxBuffer: 1 << 27 }).toString()
    expect(sha(withoutMailchimpSendSlice6(readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')))).toBe(sha(then))
  })
})
