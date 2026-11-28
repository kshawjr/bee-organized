// FL-131: the ongoing Mailchimp sync. One test per Kevin rule (2026-11-27),
// and the two silence proofs: the set-up import never reaches this, and this
// reaches no sender but the greeting.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'

const h = vi.hoisted(() => ({ greet: [] as any[][], scheduleAnswer: 'scheduled' as string, nothing: new Proxy({}, { get: () => { throw new Error('the real database was reached') } }) }))
vi.mock('./welcome-email', () => ({
  scheduleWelcomeEmail: async (...a: any[]) => { h.greet.push(['schedule', ...a]); return h.scheduleAnswer },
  skipWelcomeEmail: async (...a: any[]) => { h.greet.push(['skip', ...a]); return true },
}))
vi.mock('./supabase-service', () => ({ supabaseService: h.nothing }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: h.nothing }))

import { runOngoing, greetingFor, joinedAfter, signupLeadId } from './mailchimp-ongoing'
import { MAILCHIMP_SIGNUP_SOURCE, signupTooLate, isJobberSource } from './mailchimp-signup-rules'

const TEST = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
const NOW = Date.parse('2026-11-28T12:00:00Z')
const CUTOFF = '2026-11-20T00:00:00Z'
const hoursAgo = (n: number) => new Date(NOW - n * 3600e3).toISOString()

type Person = { id: string; email: string; joined: string; status?: string; source?: string | null; phone?: string; tags?: string[] }

function world(people: Person[], o: { leads?: any[]; firstSync?: string | null; sourceFails?: Set<string> } = {}) {
  const calls: string[] = []
  const tables: Record<string, any[]> = {
    locations: [{ id: TEST, name: 'Test Location', location_id: 'loc_test', lifecycle_status: 'active', mailchimp_connected: true, mailchimp_list_id: 'aud1', mailchimp_access_token: 'tok-123456789', mailchimp_server_prefix: 'us1', mailchimp_first_sync_at: o.firstSync === undefined ? CUTOFF : o.firstSync }],
    hub_users: [{ email: 'owner@beeorganized.com' }],
    leads: (o.leads || []).map((r) => ({ is_junk: false, location_uuid: TEST, ...r })),
    lookups: [], lead_tags: [], lead_notes: [],
  }
  const db = {
    tables,
    rpc: async (fn: string, args: any) => { calls.push(`rpc ${fn} ${args.p_email}`); return { data: true, error: null } },
    from: (t: string) => {
      let op = 'select', payload: any = null, one = false
      const f: Array<[string, string, any]> = []
      const run = async () => {
        await Promise.resolve()
        const match = (r: any) => f.every(([how, k, v]) => how === 'eq' ? r[k] === v : how === 'in' ? v.includes(r[k]) : true)
        if (op === 'insert' && t === 'leads') {
          await Promise.resolve()
          if (payload.id && tables.leads.some((r) => r.id === payload.id)) { calls.push(`insert refused ${payload.email}`); return { data: null, error: { code: '23505', message: 'duplicate key' } } }
          const id = payload.id || 'rand-' + payload.email
          tables.leads.push({ ...payload, id, is_junk: false })
          calls.push(`insert leads ${payload.email}`)
          return { data: { id }, error: null }
        }
        if (op === 'insert' || op === 'upsert') { (tables[t] ||= []).push(...[].concat(payload)); calls.push(`${op} ${t}`); return { data: null, error: null } }
        if (op !== 'select') { calls.push(`${op} ${t}`); return { data: null, error: null } }
        const il = f.find(([how]) => how === 'ilike')
        let rows = (tables[t] || []).filter(match)
        if (il) rows = rows.filter((r) => String(r.email || '').toLowerCase() === String(il[2]).replace(/\\/g, '').toLowerCase())
        return { data: one ? rows[0] ?? null : rows, error: null }
      }
      const q: any = {
        select: () => q, order: () => q, range: () => q, limit: () => q, or: () => q, is: () => q, not: () => q,
        single: () => { one = true; return q }, maybeSingle: () => { one = true; return q },
        eq: (k: string, v: any) => { f.push(['eq', k, v]); return q }, in: (k: string, v: any) => { f.push(['in', k, v]); return q },
        ilike: (k: string, v: any) => { f.push(['ilike', k, v]); return q },
        insert: (p: any) => { op = 'insert'; payload = p; return q }, upsert: (p: any) => { op = 'upsert'; payload = p; return q },
        update: (p: any) => { op = 'update'; payload = p; return q }, delete: () => { op = 'delete'; return q },
        then: (ok: any, bad: any) => run().then(ok, bad),
      }
      return q
    },
  }
  const asked: string[] = []
  const fetchImpl = async (url: string, init: any) => {
    expect(init?.method || 'GET').toBe('GET')
    const one = /\/members\/([^?]+)\?fields=id,status,source$/.exec(url)
    if (one) {
      const p = people.find((x) => x.id === decodeURIComponent(one[1]))!
      asked.push(p.id)
      if (o.sourceFails?.has(p.id)) return { status: 500, headers: { get: () => null }, text: async () => '{}' }
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: p.id, status: p.status || 'subscribed', source: p.source ?? 'Embed Form' }) }
    }
    const members = people.map((p) => ({ id: p.id, email_address: p.email, status: p.status || 'subscribed', timestamp_signup: '', timestamp_opt: p.joined, tags: (p.tags || []).map((name) => ({ name })), merge_fields: { FNAME: 'Pat', LNAME: p.id, PHONE: p.phone || '' } }))
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ total_items: members.length, members }) }
  }
  return { db, calls, tables, fetchImpl, asked }
}
const run = (w: ReturnType<typeof world>) => runOngoing(TEST, { db: w.db, fetchImpl: w.fetchImpl, now: () => NOW })

beforeEach(() => { h.greet.length = 0; h.scheduleAnswer = 'scheduled' })

describe('who comes in', () => {
  it('Test Location only: anywhere else is refused before anything is read', async () => {
    const w = world([{ id: 'a', email: 'a@x.org', joined: hoursAgo(2) }])
    expect(await runOngoing('e7b05e53-7bd7-48de-a13b-10018c8b1b08', { db: w.db, fetchImpl: w.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: 'not_open' })
    expect(w.calls).toEqual([]); expect(w.asked).toEqual([])
  })
  it('set-up not finished → does nothing at all', async () => {
    const w = world([{ id: 'a', email: 'a@x.org', joined: hoursAgo(2) }], { firstSync: null })
    expect(await run(w)).toEqual({ ok: false, reason: 'setup_not_finished' })
    expect(w.calls).toEqual([]); expect(h.greet).toEqual([])
  })
  it('joined before the set-up finished → left to the silent set-up import: not brought in, not greeted', async () => {
    const w = world([{ id: 'old', email: 'old@x.org', joined: '2026-11-19T23:59:59Z' }])
    expect(await run(w)).toMatchObject({ ok: true, newSinceSetup: 0, created: 0 })
    expect(w.tables.leads).toEqual([]); expect(h.greet).toEqual([])
  })
  it('joined after → brought in as a Mailchimp sign-up, dated from joining, with a fixed id', async () => {
    const w = world([{ id: 'n1', email: 'New@X.org', joined: hoursAgo(2) }])
    expect(await run(w)).toMatchObject({ ok: true, newSinceSetup: 1, created: 1, greeted: 1 })
    expect(w.tables.leads).toHaveLength(1)
    expect(w.tables.leads[0]).toMatchObject({ id: signupLeadId(TEST, 'n1'), import_source: MAILCHIMP_SIGNUP_SOURCE, created_at: hoursAgo(2), email: 'New@X.org', location_uuid: TEST })
  })
  it('already in Bee Hub by email → nothing', async () => {
    const w = world([{ id: 'n1', email: 'here@x.org', joined: hoursAgo(2) }], { leads: [{ id: 'L1', email: 'HERE@x.org' }] })
    expect(await run(w)).toMatchObject({ ok: true, newSinceSetup: 0, created: 0 })
    expect(h.greet).toEqual([])
  })
  it('same phone as a Bee Hub person under another email → left for the owner, not brought in', async () => {
    const w = world([{ id: 'n1', email: 'two@x.org', joined: hoursAgo(2), phone: '4235550100' }], { leads: [{ id: 'L1', email: 'one@x.org', phone: '(423) 555-0100' }] })
    expect(await run(w)).toMatchObject({ ok: true, created: 0, heldForOwner: 1 })
    expect(h.greet).toEqual([])
  })
  it('Mailchimp\'s "added by" can\'t be read → not brought in this time; the next run brings them in and greets them', async () => {
    const people = [{ id: 'n1', email: 'n1@x.org', joined: hoursAgo(2) }]
    const w = world(people, { sourceFails: new Set(['n1']) })
    expect(await run(w)).toMatchObject({ ok: true, created: 0, sourceUnreadable: 1 })
    expect(w.tables.leads).toEqual([])
    w.db.tables.leads.length = 0
    const w2 = world(people)
    expect(await run(w2)).toMatchObject({ ok: true, created: 1, greeted: 1 })
  })
})

describe('the greeting: 24 hours from joining, up to 72 hours late, never for some', () => {
  it('set from their Mailchimp join time, not from pickup', async () => {
    const w = world([{ id: 'n1', email: 'n1@x.org', joined: hoursAgo(2) }])
    await run(w)
    expect(h.greet).toEqual([['schedule', signupLeadId(TEST, 'n1'), { import_source: MAILCHIMP_SIGNUP_SOURCE, paid_amount: 0 }, { from: hoursAgo(2) }]])
  })
  it('picked up 30 hours after joining → still greeted (the time has passed, so it goes at the next hourly run)', async () => {
    const w = world([{ id: 'n1', email: 'n1@x.org', joined: hoursAgo(30) }])
    expect(await run(w)).toMatchObject({ greeted: 1 })
    expect(h.greet[0][3]).toEqual({ from: hoursAgo(30) })
  })
  it('picked up 71 hours after → greeted; 73 hours after → brought in, never greeted, reason saved', async () => {
    const w = world([{ id: 'a', email: 'a@x.org', joined: hoursAgo(71) }, { id: 'b', email: 'b@x.org', joined: hoursAgo(73) }])
    expect(await run(w)).toMatchObject({ created: 2, greeted: 1, notGreeted: { too_late: 1 } })
    expect(h.greet).toEqual([
      ['schedule', signupLeadId(TEST, 'a'), expect.anything(), { from: hoursAgo(71) }],
      ['skip', signupLeadId(TEST, 'b'), 'too_late', null],
    ])
  })
  it('unsubscribed in Mailchimp → brought in marked no-marketing (list first), never greeted, reason saved', async () => {
    const w = world([{ id: 'u', email: 'u@x.org', joined: hoursAgo(2), status: 'unsubscribed' }])
    expect(await run(w)).toMatchObject({ created: 1, greeted: 0, notGreeted: { unsubscribed: 1 } })
    expect(w.calls.indexOf('rpc marketing_unsubscribe_from_mailchimp u@x.org')).toBeLessThan(w.calls.indexOf('insert leads u@x.org'))
    expect(w.tables.leads[0].marketing_opt_out).toBe(true)
    expect(h.greet).toEqual([['skip', signupLeadId(TEST, 'u'), 'unsubscribed', null]])
  })
  it('unsubscribed since the list was read (the fresh look says so) → still never greeted', async () => {
    const w = world([{ id: 'u', email: 'u@x.org', joined: hoursAgo(2) }])
    const f = w.fetchImpl
    w.fetchImpl = async (url: string, init: any) => url.includes('/members/u?') ? { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 'u', status: 'unsubscribed', source: 'Embed Form' }) } : f(url, init)
    expect(await runOngoing(TEST, { db: w.db, fetchImpl: w.fetchImpl, now: () => NOW })).toMatchObject({ created: 1, greeted: 0, notGreeted: { unsubscribed: 1 } })
  })
  it.each(['Jobber', 'jobber', ' JOBBER '])('added to Mailchimp by Jobber ("%s") → brought in, never greeted, reason saved', async (source) => {
    const w = world([{ id: 'j', email: 'j@x.org', joined: hoursAgo(2), source }])
    expect(await run(w)).toMatchObject({ created: 1, greeted: 0, notGreeted: { added_by_jobber: 1 } })
    expect(h.greet).toEqual([['skip', signupLeadId(TEST, 'j'), 'added_by_jobber', null]])
  })
  it.each(['Typeform', 'Embed Form', 'Admin Add', 'Hosted Signup Form', 'API - Generic', 'Jobber Zapier'])('added by "%s" → greeted', async (source) => {
    const w = world([{ id: 's', email: 's@x.org', joined: hoursAgo(2), source }])
    expect(await run(w)).toMatchObject({ greeted: 1 })
  })
  it('a past client (the greeting\'s own check says so) → never greeted, reason saved', async () => {
    h.scheduleAnswer = 'returning_client'
    const w = world([{ id: 'p', email: 'p@x.org', joined: hoursAgo(2) }])
    expect(await run(w)).toMatchObject({ created: 1, greeted: 0, notGreeted: { returning_client: 1 } })
    expect(h.greet[1]).toEqual(['skip', signupLeadId(TEST, 'p'), 'returning_client', null])
  })
})

describe('first one wins: never made twice, never greeted twice', () => {
  it('the notification and the sweep at the same moment → one person, one greeting', async () => {
    const w = world([{ id: 'n1', email: 'n1@x.org', joined: hoursAgo(2) }])
    const [a, b] = await Promise.all([run(w), run(w)])
    expect(w.tables.leads).toHaveLength(1)
    expect(h.greet.filter((g) => g[0] === 'schedule')).toHaveLength(1)
    expect((a as any).created + (b as any).created).toBe(1)
    expect((a as any).alreadyThere + (b as any).alreadyThere).toBe(1)
    expect(w.calls).toContain('insert refused n1@x.org')   // the database said no to the second
  })
  it('a later run finds them already in → nothing more', async () => {
    const w = world([{ id: 'n1', email: 'n1@x.org', joined: hoursAgo(2) }])
    await run(w); await run(w); await run(w)
    expect(w.tables.leads).toHaveLength(1)
    expect(h.greet).toHaveLength(1)
  })
  it('the fixed id: same location and member → same id; different → different; a real UUID', () => {
    const a = signupLeadId(TEST, 'm1')
    expect(a).toBe(signupLeadId(TEST, 'm1'))
    expect(a).not.toBe(signupLeadId(TEST, 'm2'))
    expect(a).not.toBe(signupLeadId('e7b05e53-7bd7-48de-a13b-10018c8b1b08', 'm1'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('the rules on their own', () => {
  it('greetingFor', () => {
    const base = { unsubscribed: false, source: 'Typeform', joinedAt: hoursAgo(1), nowMs: NOW }
    expect(greetingFor(base)).toEqual({ greet: true, from: hoursAgo(1) })
    expect(greetingFor({ ...base, unsubscribed: true })).toEqual({ greet: false, reason: 'unsubscribed' })
    expect(greetingFor({ ...base, source: 'Jobber' })).toEqual({ greet: false, reason: 'added_by_jobber' })
    expect(greetingFor({ ...base, joinedAt: hoursAgo(72.01) })).toEqual({ greet: false, reason: 'too_late' })
    expect(greetingFor({ ...base, joinedAt: hoursAgo(71.99) }).greet).toBe(true)
    expect(greetingFor({ ...base, joinedAt: 'not a date' })).toEqual({ greet: false, reason: 'too_late' })
  })
  it('joinedAfter is strictly after; anything unreadable is not after', () => {
    expect(joinedAfter('2026-11-20T00:00:01Z', CUTOFF)).toBe(true)
    expect(joinedAfter(CUTOFF, CUTOFF)).toBe(false)
    expect(joinedAfter(null, CUTOFF)).toBe(false)
    expect(joinedAfter('2026-11-21T00:00:00Z', null)).toBe(false)
  })
  it('the 72 hours and Jobber, as the greeting also reads them', () => {
    expect(signupTooLate(hoursAgo(72), NOW)).toBe(false)
    expect(signupTooLate(hoursAgo(72.001), NOW)).toBe(true)
    expect(isJobberSource('Jobber')).toBe(true)
    expect(isJobberSource('Jobber Zapier')).toBe(false)
    expect(isJobberSource(null)).toBe(false)
  })
})

// ── Silence ─────────────────────────────────────────────────
const SENDERS = /welcome|drip|enrol|slack|notif|jobber|resend|sendgrid|postmark|nodemailer|twilio|sendmail|send_?email|digest-|daily_?digest|send_?digest/i
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const rel = (f: string) => f.replace(process.cwd() + '/', '')
const resolve = (from: string, spec: string) => {
  const base = spec.startsWith('@/') ? join(process.cwd(), spec.slice(2)) : join(dirname(from), spec)
  for (const ext of ['.ts', '.tsx', '.js', '/index.ts']) if (existsSync(base + ext)) return base + ext
  return null
}
// stopAt: files reached but not opened (the one allowed sender).
const walk = (file: string, seen = new Set<string>(), stopAt = new Set<string>()): Set<string> => {
  if (seen.has(file)) return seen
  seen.add(file)
  if (stopAt.has(rel(file))) return seen
  const src = stripComments(readFileSync(file, 'utf8'))
  // `from '…'`, `import('…')`, and a bare `import '…'` (a side-effect import loads the file too).
  for (const m of Array.from(src.matchAll(/(?:\bfrom|\bimport\s*\(|\bimport)\s*['"]([^'"]+)['"]/g))) {
    if (!m[1].startsWith('.') && !m[1].startsWith('@/')) continue
    const f = resolve(file, m[1]); if (f) walk(f, seen, stopAt)
  }
  return seen
}

const SETUP_START = ['lib/mailchimp-pull.ts', 'lib/mailchimp-pull-review.ts', 'lib/mailchimp-import-choices.ts', 'app/api/mailchimp/import/route.ts', 'app/api/mailchimp/import/choice/route.ts']
const ONGOING_START = ['lib/mailchimp-ongoing.ts', 'app/api/mailchimp/webhook/route.ts', 'app/api/cron/mailchimp-sweep/route.ts']
const GREETING = 'lib/welcome-email.ts'
// The only words from the sender list the ongoing files may say, each for a reason:
const ALLOWED = [
  "import { scheduleWelcomeEmail, skipWelcomeEmail } from './welcome-email'",   // the one sender
  'scheduleWelcomeEmail', 'skipWelcomeEmail',                                   // …and its two doors
  'isJobberSource', 'JOBBER_SOURCE_NAME', "'jobber'", 'added_by_jobber',        // reading Mailchimp's "added by", sending nothing
]

describe('silence: the set-up import never reaches the ongoing sync', () => {
  it('nothing the set-up import loads is an ongoing file, the greeting, or the shared sign-up rules', () => {
    const reached = Array.from(SETUP_START.reduce((s, f) => walk(join(process.cwd(), f), s), new Set<string>())).map(rel)
    expect(reached.length).toBeGreaterThan(3)
    for (const f of [...ONGOING_START, GREETING, 'lib/mailchimp-signup-rules.ts', 'lib/mailchimp-webhook-key.ts']) expect(reached, f).not.toContain(f)
  })
  it('the set-up import still marks its people as the silent import, never as sign-ups', () => {
    const pull = stripComments(readFileSync(join(process.cwd(), 'lib/mailchimp-pull.ts'), 'utf8'))
    expect(pull).toContain("export const PULL_IMPORT_SOURCE = 'mailchimp_import'")
    expect(pull).not.toMatch(/mailchimp_signup/)
    for (const f of ['lib/mailchimp-pull-review.ts', 'app/api/mailchimp/import/route.ts']) {
      expect(stripComments(readFileSync(join(process.cwd(), f), 'utf8')), f).not.toMatch(/leadIdFor|importSource|mailchimp_signup/)
    }
  })
})

describe('silence: the ongoing sync reaches no sender but the greeting', () => {
  const reached = () => Array.from(ONGOING_START.reduce((s, f) => walk(join(process.cwd(), f), s, new Set([GREETING])), new Set<string>())).map(rel)
  it('it does reach the greeting — through the ongoing file, and nowhere else', () => {
    const r = reached()
    expect(r).toContain(GREETING)
    const importers = r.filter((f) => f !== GREETING && /from\s+['"][^'"]*welcome-email['"]/.test(stripComments(readFileSync(join(process.cwd(), f), 'utf8'))))
    expect(importers).toEqual(['lib/mailchimp-ongoing.ts'])
  })
  it('every other file it loads names no sender, once the greeting\'s own words are set aside', () => {
    const named = reached().filter((f) => f !== GREETING).map((f) => {
      let src = stripComments(readFileSync(join(process.cwd(), f), 'utf8'))
      for (const a of ALLOWED) src = src.split(a).join('')
      const m = src.match(SENDERS)
      return m ? `${f}: "${m[0]}"` : null
    }).filter(Boolean)
    expect(named).toEqual([])
  })
  it('only the two greeting doors are taken from the greeting', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'lib/mailchimp-ongoing.ts'), 'utf8'))
    expect(Array.from(src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/welcome-email'/g)).map((m) => m[1].trim())).toEqual(['scheduleWelcomeEmail, skipWelcomeEmail'])
    expect(src).not.toMatch(/sendWelcomeEmail|cancelPendingWelcomeEmail/)
  })
  it('it only ever asks Mailchimp (GET); it never writes to it', () => {
    for (const f of ['lib/mailchimp-ongoing.ts', 'app/api/mailchimp/webhook/route.ts', 'app/api/cron/mailchimp-sweep/route.ts']) {
      const src = stripComments(readFileSync(join(process.cwd(), f), 'utf8'))
      expect(src, f).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/)
    }
  })
})
