// @vitest-environment node
//
// FL-75 slice 4 (2026-11-23) — lib/mailchimp-audience-look.ts: look at both
// sides, write nothing. Pins (Kevin's list):
//   • not one write, to either side — at run time (every database call a
//     select, every request a GET) and by fingerprint (the file has no write
//     verb; the existing Mailchimp files are byte for byte as they were)
//   • a connected but inactive location is refused, before its token is read
//   • phone never joins two records on its own
//   • a partial read is reported as partial
//   • no token ever reaches a log, a test result or a report
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { join } from 'path'

// One shared stand-in, so the sending code (imported below for the switch
// proof) can be given a database per test.
const svc = vi.hoisted(() => ({} as any))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: svc }))
vi.mock('./supabase-service', () => ({ supabaseService: svc }))

import {
  readRefusal, readAudience, compareSides, lookAtLocation, scrub, PARTIAL_WORDS,
  type MailchimpMember, type BeeHubLead,
} from './mailchimp-audience-look'
import { syncWebsiteLeadsToMailchimp } from './mailchimp-sync'

// A made-up token. Never a real one: the real ones are read at run time only.
const TOKEN = 'fake0token0' + 'zq81x7-us99'
const LOC = 'loc-test'

// ── a database that only answers reads, and records everything asked of it ──
type Op = { table: string; op: string; columns?: string }
function makeDb(tables: { location?: any; cred?: any; leads?: any[]; leadsError?: any }) {
  const ops: Op[] = []
  const db: any = {
    rpc: (...a: any[]) => { ops.push({ table: '(rpc)', op: 'rpc' }); throw new Error('rpc is a write here') },
    from: (table: string) => {
      const q: any = { cols: '', range: [0, 999] }
      const b: any = {}
      b.select = (cols: string) => { q.cols = cols; ops.push({ table, op: 'select', columns: cols }); return b }
      for (const w of ['insert', 'update', 'upsert', 'delete']) b[w] = () => { ops.push({ table, op: w }); throw new Error(`${w} is a write`) }
      b.eq = () => b; b.is = () => b; b.in = () => b; b.order = () => b
      b.range = (a: number, z: number) => { q.range = [a, z]; return b }
      b.maybeSingle = () => {
        if (table !== 'locations') return Promise.resolve({ data: null, error: null })
        return Promise.resolve({ data: q.cols.includes('mailchimp_access_token') ? tables.cred : tables.location, error: null })
      }
      b.then = (res: any, rej: any) => {
        if (table === 'leads') {
          if (tables.leadsError) return Promise.resolve({ data: null, error: tables.leadsError }).then(res, rej)
          const all = tables.leads || []
          return Promise.resolve({ data: all.slice(q.range[0], q.range[1] + 1), error: null }).then(res, rej)
        }
        return Promise.resolve({ data: [], error: null }).then(res, rej)
      }
      return b
    },
  }
  return { db, ops }
}

const ACTIVE = {
  id: LOC, name: 'Test Location', is_active: true, lifecycle_status: 'active', mailchimp_sync_live: true,
  mailchimp_connected: true, mailchimp_list_id: 'list-1', mailchimp_list_name: 'Test Bee Organized',
}
const CRED = { mailchimp_access_token: TOKEN, mailchimp_server_prefix: 'us99' }

// ── a Mailchimp that records every request ──
type Req = { url: string; method: string; auth: string }
function makeMailchimp(pages: Array<{ status: number; body?: any; retryAfter?: string } | ((offset: number) => { status: number; body?: any; retryAfter?: string })>) {
  const reqs: Req[] = []
  let i = 0
  const fetchImpl = async (url: string, init: any) => {
    reqs.push({ url, method: init?.method, auth: init?.headers?.Authorization })
    const offset = Number(new URL(url).searchParams.get('offset'))
    const p = pages[Math.min(i++, pages.length - 1)]
    const r = typeof p === 'function' ? p(offset) : p
    return { status: r.status, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? r.retryAfter ?? null : null) }, text: async () => JSON.stringify(r.body ?? {}) }
  }
  return { fetchImpl, reqs }
}
const member = (id: string, email: string, over: any = {}) => ({ id, email_address: email, status: 'subscribed', timestamp_opt: '2026-01-02T00:00:00Z', tags: [{ id: 1, name: 'Website' }], merge_fields: {}, ...over })
const page = (members: any[], total = members.length) => ({ status: 200, body: { total_items: total, members } })
const noSleep = vi.fn(async (_ms: number) => {})
const noSuppressed = async () => new Set<string>()
const lead = (id: string, email: string | null, over: Partial<BeeHubLead> = {}): BeeHubLead => ({ id, email, phone: null, is_junk: false, marketing_opt_out: false, marketing_unsubscribed_at: null, archived_at: null, ...over })

beforeEach(() => { noSleep.mockClear() })

// ── 1. not one write ───────────────────────────────────────────────────────
describe('not one write, to either side', () => {
  it('a whole look reads only: every database call is a select, every Mailchimp request a GET', async () => {
    const { db, ops } = makeDb({ location: ACTIVE, cred: CRED, leads: [lead('l1', 'a@x.com'), lead('l2', 'b@x.com')] })
    const mc = makeMailchimp([page([member('m1', 'a@x.com'), member('m2', 'c@x.com', { status: 'unsubscribed' })])])
    const r = await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed })
    expect(r.ok).toBe(true)
    expect(ops.map((o) => o.op)).toEqual(['select', 'select', 'select'])
    expect(new Set(mc.reqs.map((q) => q.method))).toEqual(new Set(['GET']))
    expect(mc.reqs.every((q) => /\/3\.0\/lists\/list-1\/members\?/.test(q.url))).toBe(true)
  })
  it('a Mailchimp-side unsubscribe is noted, and nothing is written because of it (no list row, no rpc)', async () => {
    const { db, ops } = makeDb({ location: ACTIVE, cred: CRED, leads: [lead('l1', 'a@x.com')] })
    const mc = makeMailchimp([page([member('m1', 'a@x.com', { status: 'unsubscribed' }), member('m2', 'z@x.com', { status: 'cleaned' })])])
    const r: any = await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed })
    expect(r.comparison.mailchimpSaidNo).toEqual([{ memberId: 'm1', emailKey: 'a@x.com', status: 'unsubscribed' }, { memberId: 'm2', emailKey: 'z@x.com', status: 'cleaned' }])
    expect(ops.filter((o) => o.op !== 'select')).toEqual([])
    expect(ops.some((o) => o.table === 'marketing_unsubscribes')).toBe(false)
  })
  it('by fingerprint: the file has no write verb, no non-GET method, and does not import the Sync now engine', () => {
    const src = readFileSync(join(process.cwd(), 'lib/mailchimp-audience-look.ts'), 'utf8')
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(code).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/)
    expect(code).not.toMatch(/method:\s*['"](PUT|POST|PATCH|DELETE)/)
    expect(code).not.toMatch(/\b(PUT|POST|PATCH|DELETE)\b/)
    expect(code).not.toContain('mailchimp-' + 'sync')
    expect(code).not.toMatch(/console\./)
  })
  it('by fingerprint: the existing Mailchimp files are byte for byte what they were at eeaedb2', () => {
    const sha = (f: string) => createHash('sha256').update(readFileSync(join(process.cwd(), f))).digest('hex')
    // 2026-11-25, FL-75 slice 6: the sending file was rebuilt on purpose (it is
    // the slice that sends). Its pin moves to the commit this claim was made
    // at; slice 6's own tests pin the new file.
    const shaAt = (rev: string, f: string) => createHash('sha256').update(execSync(`git show ${rev}:${f}`, { cwd: process.cwd(), maxBuffer: 1 << 26 })).digest('hex')
    expect({
      sync: shaAt('eeaedb2', 'lib/mailchimp-' + 'sync.ts'),
      client: sha('lib/mailchimp.ts'),
      rules: sha('lib/mailchimp-rules.ts'),
      noList: sha('lib/marketing-no-list.ts'),
    }).toEqual(PINNED)
  })
})
// sha256 at eeaedb2 (2026-11-23).
const PINNED = {
  sync: '812dd07d96a54495a257518ea813ce5130dd8591d997f0ee798337bf4b04fc2f',
  client: '0ce2b7b7618f7875f7a2ed25ab41821800f3db80ca89e0a8b41433eb02775ec4',
  rules: '348f8df0073472bc82320a01c20234a7ada18cb937eb446fc71be73bfb0b3064',
  noList: '4d85b5984c0a5f9d309655a3579cbb1e98d886e43b22d8d8adae5a3e979e62e7',
}

// ── 2. a connected but inactive location is refused ────────────────────────
// Kevin's ruling, corrected 2026-11-23: read when connected, an audience is
// chosen and lifecycle is 'active'. Nothing else — not is_active, and NOT
// the sending switch (mailchimp_sync_live).
describe('a connected but inactive location is refused, before its token is read', () => {
  const cases: [string, any, string][] = [
    ['closed', { lifecycle_status: 'closed' }, 'location_inactive'],
    ['onboarding', { lifecycle_status: 'onboarding' }, 'location_inactive'],
    ['no lifecycle at all', { lifecycle_status: null }, 'location_inactive'],
    ['closed, even with the switch on', { lifecycle_status: 'closed', mailchimp_sync_live: true }, 'location_inactive'],
    ['no audience chosen (Orlando, Southwest Austin)', { mailchimp_list_id: null, is_active: false, mailchimp_sync_live: false }, 'no_audience'],
    ['not connected', { mailchimp_connected: false }, 'not_connected'],
  ]
  for (const [name, over, reason] of cases) {
    it(`${name} → ${reason}, no Mailchimp request, token never selected`, async () => {
      const { db, ops } = makeDb({ location: { ...ACTIVE, ...over }, cred: CRED, leads: [] })
      const mc = makeMailchimp([page([])])
      const r: any = await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed })
      expect(r).toMatchObject({ ok: false, reason })
      expect(r.words).toBeTruthy()
      expect(mc.reqs).toEqual([])
      expect(ops.some((o) => (o.columns || '').includes('mailchimp_access_token'))).toBe(false)
    })
  }
  it('the rule itself: connected + audience + lifecycle active reads; is_active and the switch are not asked', () => {
    expect(readRefusal(ACTIVE)).toBeNull()
    for (const is_active of [true, false, null]) for (const mailchimp_sync_live of [true, false, null]) {
      expect(readRefusal({ ...ACTIVE, is_active, mailchimp_sync_live } as any)).toBeNull()
    }
  })
  it('the flags it reads do not include the switch or is_active', async () => {
    const { db, ops } = makeDb({ location: ACTIVE, cred: CRED, leads: [] })
    const mc = makeMailchimp([page([])])
    await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed })
    const flags = ops.find((o) => o.table === 'locations')!.columns!
    expect(flags).not.toContain('mailchimp_sync_live')
    expect(flags).not.toContain('is_active')
  })
})

// ── 3. phone never joins ───────────────────────────────────────────────────
describe('phone never joins two records on its own', () => {
  it('a different email, same phone: a suggestion only — the member stays Mailchimp only, the record stays Bee Hub only', () => {
    const c = compareSides({
      members: [{ id: 'm1', email: 'new@x.com', emailKey: 'new@x.com', status: 'subscribed', joinedAt: null, tags: [], phone: '(615) 555-0101' }],
      leads: [lead('l1', 'old@x.com', { phone: '615-555-0101' })],
      suppressed: new Set(), complete: true,
    })
    expect(c).toMatchObject({ mailchimpOnly: 1, both: 0, beeHubOnly: 1 })
    expect(c.phoneSuggestions).toEqual([{ memberId: 'm1', leadIds: ['l1'] }])
  })
  it('a Bee Hub record with no email, same phone: a suggestion, never "both"', () => {
    const c = compareSides({
      members: [{ id: 'm1', email: 'p@x.com', emailKey: 'p@x.com', status: 'subscribed', joinedAt: null, tags: [], phone: '6155550101' }],
      leads: [lead('l1', null, { phone: '615.555.0101' })],
      suppressed: new Set(), complete: true,
    })
    expect(c).toMatchObject({ mailchimpOnly: 1, both: 0, beeHubOnly: 0 })
    expect(c.phoneSuggestions).toHaveLength(1)
  })
  it('the same email is "both" even when the phones differ', () => {
    const c = compareSides({
      members: [{ id: 'm1', email: ' A@X.com ', emailKey: 'a@x.com', status: 'subscribed', joinedAt: null, tags: [], phone: '6155550101' }],
      leads: [lead('l1', 'a@x.com', { phone: '2125550199' })],
      suppressed: new Set(), complete: true,
    })
    expect(c).toMatchObject({ mailchimpOnly: 0, both: 1, beeHubOnly: 0 })
    expect(c.phoneSuggestions).toEqual([])
  })
})

// ── 4. a partial read is reported as partial ───────────────────────────────
describe('a partial read is never reported as the whole picture', () => {
  const two = (n: number, start = 0) => Array.from({ length: n }, (_, i) => member(`m${start + i}`, `p${start + i}@x.com`))
  it('page 2 keeps failing: complete false, Bee Hub only unknown, the words say so', async () => {
    const { db } = makeDb({ location: ACTIVE, cred: CRED, leads: [lead('l1', 'p0@x.com'), lead('l2', 'never@x.com')] })
    const mc = makeMailchimp([page(two(2), 4), { status: 500, body: { detail: 'oops' } }])
    const r: any = await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed, pageSize: 2 })
    expect(r.ok).toBe(true)
    expect(r.complete).toBe(false)
    expect(r.words).toBe(PARTIAL_WORDS)
    expect(r.mailchimp).toMatchObject({ totalReported: 4, membersRead: 2, stopped: { reason: 'mailchimp_error', atOffset: 2 } })
    expect(r.comparison.beeHubOnly).toBeNull()
    expect(r.comparison.beeHubOnlyEligible).toBeNull()
    expect(r.comparison.complete).toBe(false)
  })
  it('the audience changes size mid-read: partial, never a guess', async () => {
    const mc = makeMailchimp([page(two(2), 4), page(two(2, 2), 5)])
    const r: any = await readAudience({ token: TOKEN, serverPrefix: 'us99', listId: 'list-1', fetchImpl: mc.fetchImpl, sleep: noSleep, pageSize: 2 })
    expect(r).toMatchObject({ ok: true, complete: false, stopped: { reason: 'changed_while_reading' } })
  })
  it('Mailchimp says more people than it sends: partial', async () => {
    const mc = makeMailchimp([page(two(2), 3), page([], 3)])
    const r: any = await readAudience({ token: TOKEN, serverPrefix: 'us99', listId: 'list-1', fetchImpl: mc.fetchImpl, sleep: noSleep, pageSize: 2 })
    expect(r.complete).toBe(false)
  })
  it('the first page fails: the look fails outright, nothing is compared', async () => {
    const { db, ops } = makeDb({ location: ACTIVE, cred: CRED, leads: [lead('l1', 'a@x.com')] })
    const mc = makeMailchimp([{ status: 500 }])
    const r: any = await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed })
    expect(r).toMatchObject({ ok: false, reason: 'mailchimp_error' })
    expect(ops.some((o) => o.table === 'leads')).toBe(false)
  })
  it('a whole big audience is paged to the end (2,500 people, pages of 1,000)', async () => {
    const all = two(2500)
    const mc = makeMailchimp([(off: number) => page(all.slice(off, off + 1000), 2500)])
    const r: any = await readAudience({ token: TOKEN, serverPrefix: 'us99', listId: 'list-1', fetchImpl: mc.fetchImpl, sleep: noSleep })
    expect(r).toMatchObject({ ok: true, complete: true, pagesRead: 3, totalReported: 2500 })
    expect(r.members).toHaveLength(2500)
    expect(mc.reqs.map((q) => new URL(q.url).searchParams.get('offset'))).toEqual(['0', '1000', '2000'])
  })
  it('Bee Hub records past the first 1,000 are read too', async () => {
    const leads = Array.from({ length: 2300 }, (_, i) => lead(`l${String(i).padStart(4, '0')}`, `b${i}@x.com`))
    const { db } = makeDb({ location: ACTIVE, cred: CRED, leads })
    const mc = makeMailchimp([page([])])
    const r: any = await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed })
    expect(r.comparison.beeHubRecords).toBe(2300)
    expect(r.comparison.beeHubOnly).toBe(2300)
  })
})

// ── 5. when it goes wrong ──────────────────────────────────────────────────
describe('when it goes wrong', () => {
  const look = async (pages: any[]) => {
    const { db } = makeDb({ location: ACTIVE, cred: CRED, leads: [] })
    const mc = makeMailchimp(pages)
    return { r: await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed }) as any, mc }
  }
  it('an expired or rejected token (401): token_rejected, one request, no retry', async () => {
    const { r, mc } = await look([{ status: 401, body: { title: 'API Key Invalid', detail: 'Your API key may be invalid, or you’ve attempted to access the wrong datacenter.' } }])
    expect(r).toMatchObject({ ok: false, reason: 'token_rejected' })
    expect(r.words).toContain('reconnect')
    expect(mc.reqs).toHaveLength(1)
  })
  it('an audience that no longer exists (404): audience_gone', async () => {
    const { r } = await look([{ status: 404, body: { title: 'Resource Not Found' } }])
    expect(r).toMatchObject({ ok: false, reason: 'audience_gone' })
    expect(r.words).toContain('choose an audience again')
  })
  it('rate limited (429): waits as told, retries 3 times, then stops and says so', async () => {
    const { r, mc } = await look([{ status: 429, retryAfter: '2' }])
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited' })
    expect(mc.reqs).toHaveLength(4)
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([2000, 2000, 2000])
  })
  it('rate limited once, then fine: the read completes', async () => {
    const { r } = await look([{ status: 429 }, page([member('m1', 'a@x.com')])])
    expect(r).toMatchObject({ ok: true, complete: true })
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([1000])
  })
  it('Bee Hub cannot be read: nothing is compared', async () => {
    const { db } = makeDb({ location: ACTIVE, cred: CRED, leadsError: { message: 'boom' } })
    const mc = makeMailchimp([page([])])
    const r: any = await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed })
    expect(r).toMatchObject({ ok: false, reason: 'beehub_read_failed' })
  })
})

// ── 6. no token ever gets out ──────────────────────────────────────────────
describe('no token ever reaches a log, a result or a report', () => {
  let spies: any[] = []
  beforeEach(() => { spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {})) })
  afterEach(() => { spies.forEach((s) => s.mockRestore()) })
  const echo = { detail: `bad token ${TOKEN} / Authorization: Bearer ${TOKEN}` }
  const scenarios: [string, any[]][] = [
    ['success', [page([member('m1', 'a@x.com')])]],
    ['401 that echoes the token', [{ status: 401, body: echo }]],
    ['404 that echoes the token', [{ status: 404, body: echo }]],
    ['429 every time', [{ status: 429 }]],
    ['500 on page 2 that echoes the token', [page([member('m1', 'a@x.com')], 2), { status: 500, body: echo }]],
  ]
  for (const [name, pages] of scenarios) {
    it(`${name}: not in the result, not in any console line, sent only in the Authorization header`, async () => {
      const { db } = makeDb({ location: ACTIVE, cred: CRED, leads: [lead('l1', 'a@x.com')] })
      const mc = makeMailchimp(pages)
      const r = await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed, pageSize: 1 })
      expect(JSON.stringify(r)).not.toContain(TOKEN)
      expect(JSON.stringify(r)).not.toContain('us99')
      for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(TOKEN)
      expect(mc.reqs.every((q) => q.auth === `Bearer ${TOKEN}` && !q.url.includes(TOKEN))).toBe(true)
    })
  }
  it('a request that throws with the token in its message is scrubbed', async () => {
    const r: any = await readAudience({ token: TOKEN, serverPrefix: 'us99', listId: 'l', sleep: noSleep, fetchImpl: async () => { throw new Error(`socket closed for ${TOKEN}`) } })
    expect(r).toMatchObject({ ok: false, reason: 'request_failed' })
    expect(r.detail).toBe('socket closed for [token]')
  })
  it('scrub also hides a bare Authorization value', () => {
    expect(scrub('Authorization: Bearer abc.DEF-123', null)).toBe('Authorization: Bearer [token]')
  })
})

// ── 7. the counts ──────────────────────────────────────────────────────────
describe('the three counts follow the slice 1 rules', () => {
  const m = (id: string, email: string, status = 'subscribed'): MailchimpMember => ({ id, email, emailKey: email.trim().toLowerCase(), status, joinedAt: null, tags: [], phone: null })
  it('counts addresses, not records; two records at one address are one person, and are named as two records', () => {
    const c = compareSides({
      members: [m('m1', 'A@x.com'), m('m2', 'only-mc@x.com'), m('m3', 'gone@x.com', 'unsubscribed')],
      leads: [lead('l1', 'a@x.com'), lead('l1b', ' a@X.com '), lead('l2', 'only-bh@x.com'), lead('l3', 'opt@x.com', { marketing_opt_out: true }), lead('l4', 'gone@x.com'), lead('l5', null)],
      suppressed: new Set(), complete: true,
    })
    expect(c).toMatchObject({ mailchimpOnly: 1, both: 2, beeHubOnly: 2, beeHubOnlyEligible: 1, beeHubOnlyNotOffered: { opted_out: 1 }, bothLeadRecords: 3, addressesWithSeveralRecords: 1, beeHubRecords: 6, beeHubRecordsWithEmail: 5, beeHubAddresses: 4 })
    expect(c.bothByMailchimpStatus).toEqual({ subscribed: 1, unsubscribed: 1 })
  })
  it('the no-marketing list makes a Bee Hub-only address "not offered", with its reason', () => {
    const c = compareSides({ members: [], leads: [lead('l1', 'no@x.com')], suppressed: new Set(['no@x.com']), complete: true })
    expect(c).toMatchObject({ beeHubOnly: 1, beeHubOnlyEligible: 0, beeHubOnlyNotOffered: { unsubscribed_elsewhere: 1 } })
  })
})

// ── 8. the switch off: can be read, still cannot be sent to ───────────────
describe('a location with the sending switch OFF can be read, and still cannot be sent to', () => {
  const CHATTANOOGA_TODAY = { ...ACTIVE, is_active: false, mailchimp_sync_live: false }
  afterEach(() => { delete svc.from; delete svc.rpc; vi.unstubAllGlobals() })
  it('the look reads it in full, GET only, writing nothing', async () => {
    const { db, ops } = makeDb({ location: CHATTANOOGA_TODAY, cred: CRED, leads: [lead('l1', 'a@x.com'), lead('l2', 'b@x.com')] })
    const mc = makeMailchimp([page([member('m1', 'a@x.com')])])
    const r: any = await lookAtLocation(LOC, { db, fetchImpl: mc.fetchImpl, sleep: noSleep, loadSuppressed: noSuppressed })
    expect(r).toMatchObject({ ok: true, complete: true })
    expect(r.comparison).toMatchObject({ both: 1, beeHubOnly: 1, mailchimpOnly: 0 })
    expect(mc.reqs.map((q) => q.method)).toEqual(['GET'])
    expect(ops.filter((o) => o.op !== 'select')).toEqual([])
  })
  it('the sending code, unchanged, still refuses it: sync_not_enabled, zero requests to Mailchimp, zero writes', async () => {
    // The same location row, as the sending code reads it — switch off.
    const { db, ops } = makeDb({ location: { ...CHATTANOOGA_TODAY, ...CRED }, cred: { ...CHATTANOOGA_TODAY, ...CRED }, leads: [lead('l1', 'a@x.com')] })
    svc.from = db.from; svc.rpc = db.rpc
    const fetchSpy = vi.fn(async () => { throw new Error('nothing may be sent') })
    vi.stubGlobal('fetch', fetchSpy)
    const first = await syncWebsiteLeadsToMailchimp(LOC)
    // even with a confirmation naming a count and the audience
    const confirmed = await syncWebsiteLeadsToMailchimp(LOC, { confirm: { count: 1, listId: 'list-1', flows: 'any' } })
    for (const r of [first, confirmed]) expect(r).toMatchObject({ ran: false, reason: 'sync_not_enabled', pushed: 0, failed: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ops.filter((o) => o.op !== 'select')).toEqual([])
  })
  it('the sending switch is still checked in the sending code, byte for byte (pinned above)', () => {
    const src = readFileSync(join(process.cwd(), 'lib/mailchimp-' + 'sync.ts'), 'utf8')
    // 2026-11-25, FL-75 slice 6: same check, new helper name (refuse, not zeroReport).
    expect(src).toContain("if (!loc.mailchimp_sync_live) return refuse('sync_not_enabled')")
  })
})
