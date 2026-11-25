// @vitest-environment node
//
// FL-75 slice 5 (2026-11-24) — "Who goes to Mailchimp". Pins (Kevin's list):
//   A. nothing in this slice sends — at run time (Mailchimp sees only GETs,
//      Bee Hub sees only selects plus writes to the choices table) and by
//      fingerprint (the sending files are byte for byte as on main d41e711)
//   B. a person on the no-marketing list can never be ticked, by any route
//   C. archived people start unticked and are never hidden
//   D. a phone match never joins records on its own
//   E. choices survive leaving and coming back
//   F. the sending switch and the first-sync confirmation are untouched
// Plus Kevin's 2026-11-24 ruling: everyone else starts ticked, including
// people with no history in Bee Hub.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { join } from 'path'

const svc = vi.hoisted(() => ({} as any))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: svc }))
vi.mock('./supabase-service', () => ({ supabaseService: svc }))

import { buildReview, isIncluded, countAdding, groupWords, BULK_DAY_MIN, type ReviewLead, type ReviewMember, type StoredChoice } from './mailchimp-review'
import { loadReview } from './mailchimp-review-load'
import { saveChoice, validateChoice } from './mailchimp-review-choices'
import { withoutMailchimpReviewSlice5Pieces } from './network/mailchimp-review-hub-footprint'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const TZ = 'America/New_York'
const LOC = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'fake0token0' + 'qq42k-us77'

const lead = (id: string, over: Partial<ReviewLead> = {}): ReviewLead => ({
  id, email: `${id}@example.com`, phone: null, first_name: id, last_name: 'Test', created_at: '2026-06-01T15:00:00Z',
  is_junk: false, marketing_opt_out: false, marketing_unsubscribed_at: null, archived_at: null, ...over,
})
const member = (email: string, over: Partial<ReviewMember> = {}): ReviewMember => ({ id: 'm-' + email, email, emailKey: email.toLowerCase(), status: 'subscribed', phone: null, ...over })
const gc = (m: ReturnType<typeof buildReview>) => Object.fromEntries(m.groups.map((g) => [g.key, g.choice]))

describe('Kevin 2026-11-24: everyone starts ticked, except archived', () => {
  const leads = [
    lead('worked'),
    lead('nohistory', { created_at: '2025-03-01T15:00:00Z' }),
    lead('arch', { archived_at: '2026-08-17T23:30:00Z' }),
  ]
  const m = buildReview({ leads, contacted: new Set(['worked']), suppressed: new Set(), members: [], choices: [], timeZone: TZ })
  it('people with no history in Bee Hub start TICKED', () => {
    const p = m.people.find((x) => x.k === 'nohistory@example.com')!
    expect(p.g).toBe('never_other')
    expect(isIncluded(p, gc(m))).toBe(true)
  })
  it('worked-with-you people start ticked', () => {
    const p = m.people.find((x) => x.k === 'worked@example.com')!
    expect(p.g).toBe('worked')
    expect(isIncluded(p, gc(m))).toBe(true)
  })
  it('C. archived people start UNTICKED, are in the list, and carry their archive date', () => {
    const p = m.people.find((x) => x.k === 'arch@example.com')!
    expect(p).toBeTruthy()
    expect(p.g).toBe('archived')
    expect(p.a).toBe('2026-08-17T23:30:00Z')
    expect(isIncluded(p, gc(m))).toBe(false)
    expect(m.groups.find((g) => g.key === 'archived')!.defaultIn).toBe(false)
  })
  it('the big number counts the ticked people', () => expect(m.adding).toBe(2))
  it('C. archived people come FIRST in the list, so no search or filter is needed to see them', () => {
    expect(m.people[0].k).toBe('arch@example.com')
  })
  it('C. archived is a group of its own, shown first — never folded away', () => {
    expect(m.groups[0].key).toBe('archived')
    expect(m.groups[0].count).toBe(1)
  })
})

describe('bulk days: no-history people added together show as their own group', () => {
  const many = Array.from({ length: BULK_DAY_MIN }, (_, i) => lead('bulk' + i, { created_at: '2024-11-15T20:00:00Z' }))
  const few = Array.from({ length: 3 }, (_, i) => lead('few' + i, { created_at: '2024-11-16T20:00:00Z' }))
  const m = buildReview({ leads: [...many, ...few], contacted: new Set(), suppressed: new Set(), members: [], choices: [], timeZone: TZ })
  it('a day with BULK_DAY_MIN or more is "Added on <day>"', () => {
    expect(m.groups.find((g) => g.key === 'added:2024-11-15')!.count).toBe(BULK_DAY_MIN)
    expect(groupWords('added:2024-11-15', 50).label).toBe('Added on Nov 15, 2024')
  })
  it('smaller days fold into "No history in Bee Hub"', () => expect(m.groups.find((g) => g.key === 'never_other')!.count).toBe(3))
  it('the day is the LOCATION’s day (an evening record is not moved to tomorrow)', () => {
    const late = Array.from({ length: BULK_DAY_MIN }, (_, i) => lead('late' + i, { created_at: '2024-11-16T03:00:00Z' })) // 10pm on the 15th in New York
    const m2 = buildReview({ leads: late, contacted: new Set(), suppressed: new Set(), members: [], choices: [], timeZone: TZ })
    expect(m2.groups[0].key).toBe('added:2024-11-15')
  })
  it('the whole bulk group can be unticked in one go', () => {
    const m3 = buildReview({ leads: [...many, ...few], contacted: new Set(), suppressed: new Set(), members: [], timeZone: TZ, choices: [{ scope: 'group', key: 'added:2024-11-15', choice: 'out' }] })
    expect(m3.adding).toBe(3)
  })
})

describe('already in Mailchimp vs new to Mailchimp', () => {
  const m = buildReview({
    leads: [lead('both'), lead('both', { id: 'both2' }), lead('new1'), lead('nomail', { email: null })],
    contacted: new Set(), suppressed: new Set(), choices: [], timeZone: TZ,
    members: [member('both@example.com'), member('mconly@example.com', { status: 'cleaned' })],
  })
  it('counts addresses on both sides as already there, not as a decision', () => {
    expect(m.alreadyInMailchimp).toBe(1)
    expect(m.alreadyByStatus).toEqual({ subscribed: 1 })
    expect(m.people.map((p) => p.k)).toEqual(['new1@example.com'])
  })
  it('a failed Mailchimp read (members = null) counts nobody as already there and says it is unknown', () => {
    const u = buildReview({ leads: [lead('both'), lead('new1')], contacted: new Set(), suppressed: new Set(), members: null, choices: [], timeZone: TZ })
    expect(u.mailchimpKnown).toBe(false)
    expect(u.alreadyInMailchimp).toBe(0)
    expect(u.adding).toBe(2)
  })
})

describe('B. the no-marketing list, opted-out, unsubscribed, Recycle Bin: never in the list, never counted', () => {
  const leads = [
    lead('saidno'), lead('optout', { marketing_opt_out: true }), lead('unsub', { marketing_unsubscribed_at: '2026-01-01T00:00:00Z' }),
    lead('junk', { is_junk: true }), lead('ok'),
  ]
  // Every route the owner has: a person tick, a group tick.
  const choices: StoredChoice[] = ['saidno', 'optout', 'unsub', 'junk'].map((k) => ({ scope: 'person', key: k + '@example.com', choice: 'in' }))
  choices.push({ scope: 'group', key: 'never_other', choice: 'in' })
  const m = buildReview({ leads, contacted: new Set(), suppressed: new Set(['saidno@example.com']), members: [], choices, timeZone: TZ })
  it('only the one person who can be marketed to is offered', () => {
    expect(m.people.map((p) => p.k)).toEqual(['ok@example.com'])
    expect(m.adding).toBe(1)
  })
  it('the others are a count with reasons, nothing to tick', () => {
    expect(m.notOffered.total).toBe(4)
    expect(m.notOffered.byReason).toEqual({ unsubscribed_elsewhere: 1, opted_out: 1, unsubscribed: 1, junk: 1 })
  })
  it('the server refuses to save a tick IN for them (each reason), and never writes', async () => {
    for (const k of ['saidno', 'optout', 'unsub', 'junk', 'stranger']) {
      const db = fakeDb({ leads })
      const r = await saveChoice(LOC, 'u1', { scope: 'person', key: k + '@example.com', choice: 'in' }, { db, loadSuppressed: async () => new Set(['saidno@example.com']) })
      expect(r.ok, k).toBe(false)
      expect(db.writes, k).toEqual([])
    }
  })
  it('untick (out) is always allowed — it can only keep someone out', async () => {
    const db = fakeDb({ leads })
    const r = await saveChoice(LOC, 'u1', { scope: 'person', key: 'saidno@example.com', choice: 'out' }, { db, loadSuppressed: async () => new Set(['saidno@example.com']) })
    expect(r.ok).toBe(true)
  })
  it('the database guard refuses it too (by any route) — the migration carries both checks', () => {
    const sql = read('migrations/mailchimp_review_choices.sql')
    expect(sql).toMatch(/NEW\.scope = 'person' AND NEW\.choice = 'in'/)
    expect(sql).toMatch(/marketing_address_said_no\(NEW\.key\)/)
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE ON public\.mailchimp_review_choices/)
    expect(sql).toMatch(/REVOKE ALL ON public\.mailchimp_review_choices FROM PUBLIC, anon, authenticated/)
  })
})

describe('D. a phone-only match is a suggestion, never a join', () => {
  const leads = [lead('jane', { phone: '(423) 555-0101' }), lead('other')]
  const members = [member('jane.old@example.org', { phone: '423-555-0101' })]
  const input = JSON.stringify(leads)
  const m = buildReview({ leads, contacted: new Set(), suppressed: new Set(), members, choices: [], timeZone: TZ })
  it('offers it once, unanswered', () => {
    expect(m.phone).toHaveLength(1)
    expect(m.phone[0]).toMatchObject({ id: 'm-jane.old@example.org|jane@example.com', answer: null, beeHubEmail: 'jane@example.com', mailchimpEmail: 'jane.old@example.org' })
  })
  it('unanswered: the Bee Hub person is still new, still ticked, still counted', () => {
    expect(m.people.map((p) => p.k)).toContain('jane@example.com')
    expect(m.adding).toBe(2)
    expect(m.alreadyInMailchimp).toBe(0)
  })
  it('nothing about either record is changed by building the screen', () => expect(JSON.stringify(leads)).toBe(input))
  it('only a "same" answer counts them as already in Mailchimp — and they stay in the list', () => {
    const s = buildReview({ leads, contacted: new Set(), suppressed: new Set(), members, timeZone: TZ, choices: [{ scope: 'phone', key: 'm-jane.old@example.org|jane@example.com', choice: 'same' }] })
    expect(s.adding).toBe(1)
    expect(s.alreadyInMailchimp).toBe(1)
    expect(s.alreadyByPhone).toBe(1)
    expect(s.people.map((p) => p.k)).toContain('jane@example.com')
  })
  it('"different" changes nothing', () => {
    const d = buildReview({ leads, contacted: new Set(), suppressed: new Set(), members, timeZone: TZ, choices: [{ scope: 'phone', key: 'm-jane.old@example.org|jane@example.com', choice: 'different' }] })
    expect(d.adding).toBe(2)
  })
  it('the only write a phone answer makes is the answer itself, to the choices table', async () => {
    const db = fakeDb({ leads })
    expect((await saveChoice(LOC, 'u1', { scope: 'phone', key: 'm-jane.old@example.org|jane@example.com', choice: 'same' }, { db })).ok).toBe(true)
    expect(db.writes.map((w) => w.table)).toEqual(['mailchimp_review_choices'])
  })
})

describe('E. choices survive leaving the screen and coming back', () => {
  const leads = [lead('a'), lead('b'), lead('c', { archived_at: '2026-08-16T12:00:00Z' })]
  it('saved through saveChoice, read back by loadReview', async () => {
    const db = fakeDb({ leads })
    await saveChoice(LOC, 'u1', { scope: 'group', key: 'never_other', choice: 'out' }, { db, loadSuppressed: async () => new Set() })
    await saveChoice(LOC, 'u1', { scope: 'person', key: 'a@example.com', choice: 'in' }, { db, loadSuppressed: async () => new Set() })
    await saveChoice(LOC, 'u1', { scope: 'person', key: 'c@example.com', choice: 'in' }, { db, loadSuppressed: async () => new Set() })
    const r = await loadReview(LOC, { db, fetchImpl: mailchimpFake([]).fetch, loadSuppressed: async () => new Set() })
    if (!r.ok) throw new Error(r.words)
    const m = r.model
    expect(m.groups.find((g) => g.key === 'never_other')!.choice).toBe('out')
    expect(m.people.find((p) => p.k === 'a@example.com')!.c).toBe('in')
    // a: own tick in · b: group out · c: archived, ticked in by hand
    expect(m.adding).toBe(2)
  })
  it('"back to default" removes the saved row', async () => {
    const db = fakeDb({ leads })
    await saveChoice(LOC, 'u1', { scope: 'group', key: 'worked', choice: 'out' }, { db })
    await saveChoice(LOC, 'u1', { scope: 'group', key: 'worked', choice: null }, { db })
    expect(db.tables.mailchimp_review_choices).toEqual([])
  })
  it('a person tick overrides the group, the group overrides the default', () => {
    expect(isIncluded({ k: 'x', e: 'x', n: '', g: 'worked', c: 'out' }, { worked: 'in' })).toBe(false)
    expect(isIncluded({ k: 'x', e: 'x', n: '', g: 'archived', c: 'in' }, { archived: 'out' })).toBe(true)
    expect(isIncluded({ k: 'x', e: 'x', n: '', g: 'archived' }, { archived: 'in' })).toBe(true)
    expect(isIncluded({ k: 'x', e: 'x', n: '', g: 'never_other' }, {})).toBe(true)
  })
  it('choices are refused when they cannot be read (bad scope, key, value)', () => {
    expect(validateChoice({ scope: 'group', key: 'everyone', choice: 'in' }).ok).toBe(false)
    expect(validateChoice({ scope: 'person', key: 'Jane@Example.com', choice: 'in' }).ok).toBe(false)
    expect(validateChoice({ scope: 'phone', key: 'm1|jane@example.com', choice: 'in' }).ok).toBe(false)
    expect(validateChoice({ scope: 'lead', key: 'x', choice: 'in' }).ok).toBe(false)
    expect(validateChoice({ scope: 'group', key: 'added:2024-11-15', choice: 'out' }).ok).toBe(true)
  })
  it('before the migration is run, the screen still loads and says saving is not on', async () => {
    const db = fakeDb({ leads, noChoicesTable: true })
    const r = await loadReview(LOC, { db, fetchImpl: mailchimpFake([]).fetch, loadSuppressed: async () => new Set() })
    expect(r.ok && r.choicesReady).toBe(false)
    const s = await saveChoice(LOC, 'u1', { scope: 'group', key: 'worked', choice: 'out' }, { db })
    expect(s.ok === false && s.error).toBe('not_ready')
  })
})

describe('A. nothing sends — at run time', () => {
  it('loadReview: Mailchimp sees GET only; Bee Hub sees select only; the token never comes back', async () => {
    const db = fakeDb({ leads: [lead('a'), lead('b')] })
    const mc = mailchimpFake([{ id: 'm1', email_address: 'a@example.com', status: 'subscribed', merge_fields: {}, tags: [] }])
    const r = await loadReview(LOC, { db, fetchImpl: mc.fetch, loadSuppressed: async () => new Set() })
    expect(r.ok).toBe(true)
    expect(mc.methods.length).toBeGreaterThan(0)
    expect(new Set(mc.methods)).toEqual(new Set(['GET']))
    expect(db.writes).toEqual([])
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    if (r.ok) { expect(r.model.alreadyInMailchimp).toBe(1); expect(r.model.adding).toBe(1) }
  })
  it('a Mailchimp failure is said plainly and nobody is counted as already there', async () => {
    const db = fakeDb({ leads: [lead('a')] })
    const r = await loadReview(LOC, { db, fetchImpl: async () => ({ status: 401, headers: { get: () => null }, text: async () => '{"detail":"bad ' + TOKEN + '"}' }), loadSuppressed: async () => new Set(), sleep: async () => {} })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.model.mailchimpKnown).toBe(false)
      expect(r.mailchimpWords).toMatch(/reconnect/)
    }
    expect(JSON.stringify(r)).not.toContain(TOKEN)
  })
  it('same read rule as slice 4: an inactive location is refused before its token is read', async () => {
    const db = fakeDb({ leads: [], location: { lifecycle_status: 'closed' } })
    const r = await loadReview(LOC, { db, fetchImpl: mailchimpFake([]).fetch })
    expect(r.ok === false && r.reason).toBe('location_inactive')
    expect(db.reads.some((x) => x.includes('mailchimp_access_token'))).toBe(false)
  })
  it('the sending switch is never read by this slice', async () => {
    const db = fakeDb({ leads: [lead('a')] })
    await loadReview(LOC, { db, fetchImpl: mailchimpFake([]).fetch, loadSuppressed: async () => new Set() })
    expect(db.reads.some((x) => x.includes('mailchimp_sync_live'))).toBe(false)
  })
})

describe('A + F. nothing sends — by fingerprint', () => {
  const NEW = ['lib/mailchimp-review.ts', 'lib/mailchimp-review-load.ts', 'lib/mailchimp-review-choices.ts', 'app/api/mailchimp/review/route.ts', 'components/settings/MailchimpReviewScreen.jsx']
  it('no new file imports the sending code or lib/mailchimp.ts', () => {
    for (const f of NEW) {
      const s = read(f)
      // any quoted path to them — import … from, a bare import, require, import()
      expect(s, f).not.toMatch(/['"][^'"\n]*mailchimp-sync(\.ts)?['"]/)
      expect(s, f).not.toMatch(/['"](@\/lib\/|\.\/|\.\.\/lib\/)mailchimp(\.ts)?['"]/)
      expect(s, f).not.toMatch(/\/api\/mailchimp\/sync/)
    }
  })
  it('the only call out to Mailchimp is the slice 4 GET reader', () => {
    for (const f of NEW) expect(read(f), f).not.toMatch(/api\.mailchimp\.com|mailchimp_access_token[^'"\n]*\.(update|upsert|insert)/)
    expect(read('lib/mailchimp-review-load.ts')).toMatch(/readAudience\(/)
  })
  it('the loader writes nothing at all', () => {
    expect(read('lib/mailchimp-review-load.ts')).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/)
  })
  it('the choices writer writes one table only', () => {
    const s = read('lib/mailchimp-review-choices.ts')
    const tables = Array.from(s.matchAll(/\.from\('([a-z_]+)'\)\.(upsert|insert|update|delete)\(/g)).map((m) => m[1])
    expect(tables.length).toBeGreaterThan(0)
    expect(new Set(tables)).toEqual(new Set(['mailchimp_review_choices']))
    expect(s).not.toMatch(/\.rpc\(/)
  })
  it('the screen only ever calls its own route', () => {
    const urls = Array.from(read('components/settings/MailchimpReviewScreen.jsx').matchAll(/fetch\(\s*'([^']+)'/g)).map((m) => m[1])
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u.startsWith('/api/mailchimp/review')).toBe(true)
  })
  // 2026-11-25, FL-75 slice 6 is the slice that sends, so it changes the
  // sending file, its route and the card's confirmation ON PURPOSE. These
  // slice 5 claims ("slice 5 changed none of them") are kept, checked at main
  // a8c77c0 — the last commit before slice 6 — instead of the working tree.
  // Slice 6's own tests (lib/mailchimp-first-push.test.ts) pin what changed.
  const SLICE5_DONE = 'a8c77c0'
  const at = (rev: string, f: string) => execSync(`git show ${rev}:${f}`, { cwd: ROOT, maxBuffer: 1 << 27 }).toString()
  it('F. the sending files, the switch route and the first-sync confirmation are byte for byte as on main d41e711', () => {
    for (const f of ['lib/mailchimp-sync.ts', 'lib/mailchimp.ts', 'app/api/mailchimp/sync/route.ts', 'app/api/mailchimp/status/route.ts', 'lib/mailchimp-connection-state.ts', 'lib/mailchimp-rules.ts', 'lib/marketing-no-list.ts', 'lib/mailchimp-audience-look.ts']) {
      const then = execSync(`git show d41e711:${f}`, { cwd: ROOT, maxBuffer: 1 << 26 }).toString()
      expect(sha(at(SLICE5_DONE, f)), f).toBe(sha(then))
    }
    // and the files slice 6 did not need to touch are still exactly so today
    for (const f of ['lib/mailchimp.ts', 'app/api/mailchimp/status/route.ts', 'lib/mailchimp-connection-state.ts', 'lib/mailchimp-rules.ts', 'lib/marketing-no-list.ts', 'lib/mailchimp-audience-look.ts']) {
      expect(sha(read(f)), f).toBe(sha(at('d41e711', f)))
    }
  })
  it('BeeHub.jsx is main d41e711 plus the slice 5 pieces, and nothing else', () => {
    const then = execSync('git show d41e711:components/BeeHub.jsx', { cwd: ROOT, maxBuffer: 1 << 27 }).toString()
    // The file is read as it was at a8c77c0, before the Slack and Jobber
    // screens, so only slice 5's own pieces come out.
    expect(sha(withoutMailchimpReviewSlice5Pieces(at(SLICE5_DONE, 'components/BeeHub.jsx')))).toBe(sha(then))
  })
  it('F. the Mailchimp card’s Sync now and its first-sync confirmation are untouched', () => {
    const then = execSync('git show d41e711:components/BeeHub.jsx', { cwd: ROOT, maxBuffer: 1 << 27 }).toString()
    const now = at(SLICE5_DONE, 'components/BeeHub.jsx')
    const cut = (s: string, from: string, to: string) => { const a = s.indexOf(from); const b = s.indexOf(to, a); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return s.slice(a, b) }
    const runSync = (s: string) => cut(s, '  async function runSync(confirm = null) {', '  const needsAudience')
    const confirmBlock = (s: string) => cut(s, '{/* First sync: nothing has been sent; the server is asking. */}', '{syncResult && (')
    expect(runSync(now)).toBe(runSync(then))
    expect(confirmBlock(now)).toBe(confirmBlock(then))
  })
})

// ── fakes ────────────────────────────────────────────────────────────────────
function fakeDb(o: { leads: ReviewLead[]; location?: any; noChoicesTable?: boolean }) {
  const tables: Record<string, any[]> = { mailchimp_review_choices: [] }
  const writes: { table: string; op: string }[] = []
  const reads: string[] = []
  const location = { id: LOC, name: 'Test', location_id: 'loc_t', timezone: 'Eastern Time (ET)', lifecycle_status: 'active', mailchimp_connected: true, mailchimp_list_id: 'list1', mailchimp_list_name: 'Friends', ...(o.location || {}) }
  const cred = { mailchimp_access_token: TOKEN, mailchimp_server_prefix: 'us77' }
  const db: any = {
    tables, writes, reads,
    rpc: () => { throw new Error('rpc is a write here') },
    from: (table: string) => {
      const f: { col: string; val: any; op: string }[] = []
      let cols = ''
      let range: [number, number] | null = null
      let mode: 'select' | 'delete' = 'select'
      const b: any = {}
      const missing = () => ({ data: null, error: { code: '42P01', message: 'relation "mailchimp_review_choices" does not exist' } })
      b.select = (c: string) => { cols = c; reads.push(`${table}:${c}`); return b }
      b.eq = (col: string, val: any) => { f.push({ col, val, op: 'eq' }); return b }
      b.ilike = (col: string, val: any) => { f.push({ col, val, op: 'ilike' }); return b }
      b.order = () => b
      b.range = (a: number, z: number) => { range = [a, z]; return b }
      b.maybeSingle = () => Promise.resolve({ data: table === 'locations' ? (cols.includes('mailchimp_access_token') ? cred : location) : null, error: null })
      const rows = () => {
        let all: any[] = table === 'leads' ? o.leads.map((l) => ({ ...l, location_uuid: LOC })) : (tables[table] || [])
        for (const x of f) all = all.filter((r) => x.op === 'ilike' ? String(r[x.col] || '').toLowerCase() === String(x.val).replace(/\\(.)/g, '$1').toLowerCase() : r[x.col] === x.val)
        return range ? all.slice(range[0], range[1] + 1) : all
      }
      for (const w of ['insert', 'update']) b[w] = () => { writes.push({ table, op: w }); throw new Error(`${w} not expected`) }
      b.upsert = (row: any) => {
        writes.push({ table, op: 'upsert' })
        if (table !== 'mailchimp_review_choices') throw new Error('upsert to ' + table)
        if (o.noChoicesTable) return Promise.resolve(missing())
        const list = tables[table]
        const i = list.findIndex((r) => r.location_id === row.location_id && r.scope === row.scope && r.key === row.key)
        if (i >= 0) list[i] = row; else list.push(row)
        return Promise.resolve({ data: null, error: null })
      }
      b.delete = () => { writes.push({ table, op: 'delete' }); if (table !== 'mailchimp_review_choices') throw new Error('delete on ' + table); mode = 'delete'; return b }
      b.then = (res: any, rej: any) => {
        if (table === 'mailchimp_review_choices' && o.noChoicesTable) return Promise.resolve(missing()).then(res, rej)
        if (mode === 'delete') {
          const keep = tables[table].filter((r) => !f.every((x) => r[x.col] === x.val))
          tables[table] = keep
          return Promise.resolve({ data: null, error: null }).then(res, rej)
        }
        return Promise.resolve({ data: rows(), error: null }).then(res, rej)
      }
      return b
    },
  }
  return db as { tables: Record<string, any[]>; writes: { table: string; op: string }[]; reads: string[]; from: (t: string) => any; rpc: () => never }
}

function mailchimpFake(members: any[]) {
  const methods: string[] = []
  const fetch = async (url: string, init: any) => {
    methods.push(init?.method)
    if (init?.method !== 'GET') throw new Error('not a GET')
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ members, total_items: members.length }) }
  }
  return { fetch, methods }
}
