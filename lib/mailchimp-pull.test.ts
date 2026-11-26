// FL-75 slice 7: the Mailchimp → Bee Hub import. One test per Kevin rule.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'

const svc = vi.hoisted(() => ({} as any))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: svc }))
vi.mock('./supabase-service', () => ({ supabaseService: svc }))

import { planPull, newLeadRow, applyPull, loadPull, isStaffAddress, PULL_IMPORT_SOURCE, type PullLead } from './mailchimp-pull'
import type { MailchimpMember } from './mailchimp-pull'
import { emailKey } from './mailchimp-rules'
import { enforceRealRules } from './db-rules-check'

const LOC = { id: 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', name: 'Test Location', location_id: 'loc_test', audienceId: 'aud1' }
const mem = (id: string, over: Partial<MailchimpMember> = {}): MailchimpMember => {
  const email = over.email ?? `${id}@example.org`
  return { id, email, emailKey: emailKey(email), status: 'subscribed', joinedAt: '2025-03-04T05:06:07+00:00', tags: [], phone: null, firstName: null, lastName: null, ...over }
}
const lead = (id: string, over: Partial<PullLead> = {}): PullLead => ({ id, email: null, phone: null, name: null, first_name: null, last_name: null, is_junk: false, ...over })
const plan1 = (m: MailchimpMember, here: PullLead[] = [], away: PullLead[] = [], staff: string[] = []) =>
  planPull({ members: [m], leadsHere: here, leadsElsewhere: away, staffKeys: new Set(staff) }).decisions[0]

describe('who is created, held, skipped', () => {
  it('nobody matching → created, as Nurturing', () => {
    expect(plan1(mem('a'))).toMatchObject({ kind: 'create', unsubscribed: false })
  })
  it('same email at this location → already there, nothing created (archived counts as live)', () => {
    expect(plan1(mem('a'), [lead('L1', { email: ' A@Example.org ' })])).toMatchObject({ kind: 'already', ids: ['L1'] })
  })
  it('phone-only match → held for the owner, never a second record', () => {
    expect(plan1(mem('a', { phone: '(423) 555-0100' }), [lead('L1', { email: 'other@x.com', phone: '423-555-0100' })])).toMatchObject({ kind: 'held', reason: 'phone_match', ids: ['L1'] })
  })
  it('name match with a different email → held', () => {
    expect(plan1(mem('a', { firstName: 'Mariellen', lastName: 'Davis' }), [lead('L1', { name: 'Mariellen  Davis', email: 'dc@x.com' })])).toMatchObject({ kind: 'held', reason: 'name_match', ids: ['L1'] })
    expect(plan1(mem('a', { firstName: 'Katie', lastName: 'Lambremont' }), [lead('L1', { first_name: 'katie', last_name: 'LAMBREMONT' })])).toMatchObject({ kind: 'held', reason: 'name_match' })
  })
  it('first name alone is never a name match', () => {
    expect(plan1(mem('a', { firstName: 'Katie' }), [lead('L1', { name: 'Katie Smith' })])).toMatchObject({ kind: 'create' })
  })
  it('cleaned → skipped', () => {
    expect(plan1(mem('a', { status: 'cleaned' }))).toMatchObject({ kind: 'skipped', reason: 'cleaned' })
  })
  it('pending / transactional → skipped', () => {
    expect(plan1(mem('a', { status: 'pending' }))).toMatchObject({ kind: 'skipped', reason: 'other_status' })
    expect(plan1(mem('a', { status: 'transactional' }))).toMatchObject({ kind: 'skipped', reason: 'other_status' })
  })
  it('only match is in the Recycle Bin (email, phone or name) → skipped', () => {
    expect(plan1(mem('a'), [lead('B1', { email: 'a@example.org', is_junk: true })])).toMatchObject({ kind: 'skipped', reason: 'recycle_bin_only', ids: ['B1'] })
    expect(plan1(mem('a', { phone: '4235550100' }), [lead('B1', { phone: '423 555 0100', is_junk: true })])).toMatchObject({ kind: 'skipped', reason: 'recycle_bin_only' })
    expect(plan1(mem('a', { firstName: 'Jo', lastName: 'Ng' }), [lead('B1', { name: 'Jo Ng', is_junk: true })])).toMatchObject({ kind: 'skipped', reason: 'recycle_bin_only' })
  })
  it('a live match wins over a Recycle Bin match', () => {
    expect(plan1(mem('a'), [lead('B1', { email: 'a@example.org', is_junk: true }), lead('L1', { email: 'a@example.org' })])).toMatchObject({ kind: 'already', ids: ['L1'] })
  })
  it('@beeorganized.com → skipped as staff, even with no Bee Hub account', () => {
    expect(plan1(mem('a', { email: 'Kala@BeeOrganized.com' }))).toMatchObject({ kind: 'skipped', reason: 'staff' })
    expect(isStaffAddress('x@mail.beeorganized.com', new Set())).toBe(true)
    expect(isStaffAddress('x@notbeeorganized.com', new Set())).toBe(false)
  })
  it('a plus-address of a Bee Hub user account is the same mailbox → staff', () => {
    expect(plan1(mem('a', { email: 'KShawJr+LiveTest@gmail.com' }), [], [], ['kshawjr@gmail.com'])).toMatchObject({ kind: 'skipped', reason: 'staff' })
    expect(plan1(mem('a', { email: 'kshawjr2@gmail.com' }), [], [], ['kshawjr@gmail.com'])).toMatchObject({ kind: 'create' })
  })
  it('a plus-addressed user account covers its plain address too', async () => {
    const locRow = { id: LOC.id, name: 'Test Location', location_id: 'loc_test', lifecycle_status: 'active', mailchimp_connected: true, mailchimp_list_id: 'aud1', mailchimp_access_token: 'tok', mailchimp_server_prefix: 'us1' }
    const page = { total_items: 1, members: [{ id: 'm1', email_address: 'kevin@bmave.com', status: 'subscribed', timestamp_opt: '2024-07-01T10:00:00+00:00', merge_fields: {} }] }
    const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(page) })
    const r: any = await loadPull(LOC.id, { db: fakeDb([], { tables: { locations: [locRow], hub_users: [{ email: 'Kevin+Admin@bmave.com' }], leads: [] } }), fetchImpl })
    expect(r.plan.decisions[0]).toMatchObject({ kind: 'skipped', reason: 'staff' })
  })
  it('an email on a Bee Hub user account → skipped as staff', () => {
    expect(plan1(mem('a', { email: 'zach@me.com' }), [], [], ['zach@me.com'])).toMatchObject({ kind: 'skipped', reason: 'staff' })
  })
  it('a live record at ANOTHER location → held, not created', () => {
    expect(plan1(mem('a'), [], [lead('X1', { email: 'a@example.org' })])).toMatchObject({ kind: 'held', reason: 'other_location', ids: ['X1'] })
  })
  it('no join date → skipped (created_at must be the join date)', () => {
    expect(plan1(mem('a', { joinedAt: null }))).toMatchObject({ kind: 'skipped', reason: 'no_join_date' })
  })
  it('two would-be records with the same phone → both held', () => {
    const p = planPull({ members: [mem('a', { phone: '4235550100' }), mem('b', { phone: '423-555-0100' })], leadsHere: [], leadsElsewhere: [], staffKeys: new Set() })
    expect(p.decisions.map((d) => d.kind + ':' + ((d as any).reason || ''))).toEqual(['held:duplicate_in_mailchimp', 'held:duplicate_in_mailchimp'])
  })
  it('unsubscribed with no match → created, flagged unsubscribed', () => {
    expect(plan1(mem('a', { status: 'unsubscribed' }))).toMatchObject({ kind: 'create', unsubscribed: true })
  })
  it('counts add up to everyone read', () => {
    const p = planPull({ members: [mem('a'), mem('b', { status: 'cleaned' }), mem('c', { email: 'c@beeorganized.com' })], leadsHere: [], leadsElsewhere: [], staffKeys: new Set() })
    expect(p.counts).toMatchObject({ read: 3, create: 1, skipped: { cleaned: 1, staff: 1 } })
  })
})

describe('the new record', () => {
  it('Nurturing, labelled a Mailchimp import, created_at = the join date, unsubscribe date empty', () => {
    const r = newLeadRow(mem('a', { firstName: 'Jo', lastName: 'Ng', phone: '4235550100', status: 'unsubscribed' }), LOC, 'run1', true)
    expect(PULL_IMPORT_SOURCE).toBe('mailchimp_import') // never 'manual': that would put them in the Inbox
    expect(r).toMatchObject({ stage: 'Nurturing', import_source: 'mailchimp_import', source: 'Mailchimp', created_at: '2025-03-04T05:06:07+00:00', name: 'Jo Ng', phone: '(423) 555-0100', location_uuid: LOC.id, location_id: 'loc_test', marketing_opt_out: true })
    expect(r).not.toHaveProperty('marketing_unsubscribed_at')
    expect(r).not.toHaveProperty('phone_normalized')
    expect(r).not.toHaveProperty('tags')
  })
  it('no name in Mailchimp → name left empty, nothing invented', () => {
    expect(newLeadRow(mem('a'), LOC, 'run1', false)).toMatchObject({ name: null, first_name: null, last_name: null })
  })
  it('passes the real database rules for leads', () => {
    const calls: string[] = []
    const db = enforceRealRules(fakeDb(calls))
    db.from('leads').insert(newLeadRow(mem('a'), LOC, 'r', false))
    expect(db.refused).toEqual([])
  })
})

// A tiny stand-in database that records every call in order.
function fakeDb(calls: string[], opts: { rpcError?: boolean; existing?: string[]; tables?: Record<string, any[]>; failTable?: string } = {}) {
  const chain = (table: string, op: string, payload?: any) => {
    const filters: Array<[string, string, any]> = []
    const q: any = {
      select: () => q, order: () => q, range: () => q, limit: () => q,
      eq: (k: string, v: any) => { filters.push(['eq', k, v]); return q }, neq: (k: string, v: any) => { filters.push(['neq', k, v]); return q },
      ilike: (k: string, v: any) => { filters.push(['ilike', k, v]); return q },
      single: () => q, maybeSingle: () => q,
      then: (ok: any, bad: any) => {
        if (opts.failTable === table) return Promise.resolve({ data: null, error: { message: 'unreadable' } }).then(ok, bad)
        if (op === 'insert') { calls.push(`insert ${table} ${payload.email}`); return Promise.resolve({ data: { id: 'new-' + payload.email }, error: null }).then(ok, bad) }
        if (table === 'leads' && filters.some((f) => f[0] === 'ilike')) {
          const e = String(filters.find((f) => f[0] === 'ilike')![2]).replace(/\\/g, '')
          calls.push(`recheck ${e}`)
          return Promise.resolve({ data: (opts.existing || []).includes(e) ? [{ id: 'old' }] : [], error: null }).then(ok, bad)
        }
        const rows = (opts.tables || {})[table] || []
        const out = rows.filter((r) => filters.every(([o, k, v]) => (o === 'eq' ? r[k] === v : o === 'neq' ? r[k] !== v : true)))
        return Promise.resolve({ data: op === 'one' || table === 'locations' ? out[0] ?? null : out, error: null }).then(ok, bad)
      },
    }
    return q
  }
  return {
    from: (t: string) => ({ select: () => chain(t, 'select').select(), insert: (row: any) => chain(t, 'insert', row) }),
    rpc: async (fn: string, args: any) => { calls.push(`rpc ${fn} ${args.p_email}`); return opts.rpcError ? { data: null, error: { message: 'boom' } } : { data: true, error: null } },
  }
}

describe('the real run', () => {
  const planOf = (...m: MailchimpMember[]) => planPull({ members: m, leadsHere: [], leadsElsewhere: [], staffKeys: new Set() })
  it('unsubscribed: no-marketing list FIRST, then the record', async () => {
    const calls: string[] = []
    const res = await applyPull(planOf(mem('u', { status: 'unsubscribed' })), LOC, { db: fakeDb(calls), runId: 'r' })
    expect(calls).toEqual(['recheck u@example.org', 'rpc marketing_unsubscribe_from_mailchimp u@example.org', 'insert leads u@example.org'])
    expect(res[0].outcome).toBe('created_unsubscribed')
  })
  it('the list write fails → no record at all', async () => {
    const calls: string[] = []
    const res = await applyPull(planOf(mem('u', { status: 'unsubscribed' })), LOC, { db: fakeDb(calls, { rpcError: true }), runId: 'r' })
    expect(calls.filter((c) => c.startsWith('insert'))).toEqual([])
    expect(res[0].outcome).toBe('no_list_write_failed')
  })
  it('subscribed: never touches the no-marketing list', async () => {
    const calls: string[] = []
    await applyPull(planOf(mem('s')), LOC, { db: fakeDb(calls), runId: 'r' })
    expect(calls).toEqual(['recheck s@example.org', 'insert leads s@example.org'])
  })
  it('someone added since the plan → not created again', async () => {
    const calls: string[] = []
    const res = await applyPull(planOf(mem('s')), LOC, { db: fakeDb(calls, { existing: ['s@example.org'] }), runId: 'r' })
    expect(calls).toEqual(['recheck s@example.org'])
    expect(res[0].outcome).toBe('already_there')
  })
  it('held and skipped people are never written', async () => {
    const calls: string[] = []
    const p = planPull({ members: [mem('a', { status: 'cleaned' }), mem('b', { email: 'b@beeorganized.com' }), mem('c', { phone: '4235550100' }), mem('d', { email: 'd@x.com' })], leadsHere: [lead('L1', { phone: '423-555-0100' }), lead('L2', { email: 'd@x.com' })], leadsElsewhere: [], staffKeys: new Set() })
    expect(p.decisions.map((d) => d.kind)).toEqual(['skipped', 'skipped', 'held', 'already'])
    await applyPull(p, LOC, { db: fakeDb(calls), runId: 'r' })
    expect(calls).toEqual([])
  })
  it('never into Other', async () => {
    await expect(applyPull(planOf(mem('s')), { ...LOC, location_id: 'loc_other', name: 'Other' }, { db: fakeDb([]), runId: 'r' })).rejects.toThrow(/Other/)
  })
})

describe('reading refuses rather than guesses', () => {
  const locRow = (over: any = {}) => ({ id: LOC.id, name: 'Test Location', location_id: 'loc_test', lifecycle_status: 'active', mailchimp_connected: true, mailchimp_list_id: 'aud1', mailchimp_access_token: 'tok', mailchimp_server_prefix: 'us1', ...over })
  const noFetch = async () => { throw new Error('Mailchimp must not be called') }
  it('Other is refused before anything is read', async () => {
    const r = await loadPull(LOC.id, { db: fakeDb([], { tables: { locations: [locRow({ name: 'Other', location_id: 'loc_other' })] } }), fetchImpl: noFetch })
    expect(r).toMatchObject({ ok: false, reason: 'other_location_refused' })
  })
  it('reads the audience with GET only, takes names from it, and plans from both sides', async () => {
    const methods: string[] = []
    const page = { total_items: 3, members: [
      { id: 'm1', email_address: 'new@example.org', status: 'subscribed', timestamp_opt: '2024-07-01T10:00:00+00:00', merge_fields: { FNAME: 'Ana', LNAME: 'Ruiz', PHONE: '' }, tags: [{ name: 'Profile Quiz' }] },
      { id: 'm2', email_address: 'kept@example.org', status: 'subscribed', timestamp_opt: '2024-07-02T10:00:00+00:00', merge_fields: {} },
      { id: 'm3', email_address: 'boss@beeorganized.com', status: 'subscribed', timestamp_opt: '2024-07-03T10:00:00+00:00', merge_fields: {} },
    ] }
    const fetchImpl = async (_u: string, init: any) => { methods.push(init.method); return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(page) } }
    const db = fakeDb([], { tables: { locations: [locRow()], hub_users: [], leads: [{ id: 'L1', email: 'kept@example.org', location_uuid: LOC.id, is_junk: false }] } })
    const r: any = await loadPull(LOC.id, { db, fetchImpl })
    expect(r.ok).toBe(true)
    expect(methods.every((m) => m === 'GET')).toBe(true)
    expect(r.plan.decisions.map((d: any) => d.kind + (d.reason ? ':' + d.reason : ''))).toEqual(['create', 'already', 'skipped:staff'])
    expect(r.plan.decisions[0].member).toMatchObject({ firstName: 'Ana', lastName: 'Ruiz', joinedAt: '2024-07-01T10:00:00+00:00' })
  })
  it('the staff list cannot be read → nothing planned', async () => {
    const r = await loadPull(LOC.id, { db: fakeDb([], { tables: { locations: [locRow()] }, failTable: 'hub_users' }), fetchImpl: noFetch })
    expect(r).toMatchObject({ ok: false, reason: 'staff_list_unreadable' })
  })
})

// ── The owner's review and the confirmed import ──
import { reviewModel, importChosen } from './mailchimp-pull-review'
import { pullAllowed } from './mailchimp-pull-pilot'

describe('nothing comes in without the owner ticking and confirming', () => {
  const CHATT = 'e7b05e53-7bd7-48de-a13b-10018c8b1b08'
  const locRow = { id: LOC.id, name: 'Test Location', location_id: 'loc_test', lifecycle_status: 'active', mailchimp_connected: true, mailchimp_list_id: 'aud1', mailchimp_access_token: 'tok', mailchimp_server_prefix: 'us1' }
  const page = { total_items: 4, members: [
    { id: 'm1', email_address: 'one@example.org', status: 'subscribed', timestamp_opt: '2024-07-01T10:00:00+00:00', merge_fields: {} },
    { id: 'm2', email_address: 'two@example.org', status: 'unsubscribed', timestamp_opt: '2024-07-02T10:00:00+00:00', merge_fields: {} },
    { id: 'm3', email_address: 'three@example.org', status: 'subscribed', timestamp_opt: '2024-07-03T10:00:00+00:00', merge_fields: { PHONE: '4235550100' } },
    { id: 'm4', email_address: 'kept@example.org', status: 'subscribed', timestamp_opt: '2024-07-04T10:00:00+00:00', merge_fields: {} },
  ] }
  const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(page) })
  const leads = [
    { id: 'L1', name: 'Pat Lee', email: 'pat@x.com', phone: '423-555-0100', location_uuid: LOC.id, is_junk: false },
    { id: 'L2', email: 'kept@example.org', location_uuid: LOC.id, is_junk: false },
  ]
  const dbWith = (calls: string[]) => {
    const d: any = fakeDb(calls, { tables: { locations: [locRow], hub_users: [], leads } })
    const from = d.from
    d.from = (t: string) => { const q = from(t); const sel = q.select; q.select = (...a: any[]) => { const c = sel(...a); c.in = () => c; return c }; return q }
    return d
  }
  it('pilot locations only: Test Location yes, Chattanooga no', () => {
    expect(pullAllowed(LOC.id)).toBe(true)
    expect(pullAllowed(CHATT)).toBe(false)
  })
  it('Chattanooga: refused before anything is read or written', async () => {
    const boom: any = { from: () => { throw new Error('read') }, rpc: () => { throw new Error('rpc') } }
    expect(await reviewModel(CHATT, { db: boom, fetchImpl: async () => { throw new Error('mailchimp') } })).toMatchObject({ ok: false, reason: 'not_available' })
    expect(await importChosen(CHATT, ['m1'], 1, 'u', { db: boom, fetchImpl: async () => { throw new Error('mailchimp') } })).toMatchObject({ ok: false, reason: 'not_available' })
  })
  it('the review groups them: created, held with the record it matches, already', async () => {
    const r: any = await reviewModel(LOC.id, { db: dbWith([]), fetchImpl })
    expect(r.model.create.map((p: any) => p.k)).toEqual(['m1', 'm2'])
    expect(r.model.held).toMatchObject([{ k: 'm3', reason: 'phone_match' }])
    expect(r.model.already).toBe(1)
  })
  it('only the ticked people are created', async () => {
    const calls: string[] = []
    const r: any = await importChosen(LOC.id, ['m2'], 1, 'u', { db: dbWith(calls), fetchImpl })
    expect(r).toMatchObject({ ok: true, created: 1, createdUnsubscribed: 1 })
    expect(calls.filter((c) => c.startsWith('insert'))).toEqual(['insert leads two@example.org'])
  })
  it('a held person can never be brought in, even if the page sends them', async () => {
    const calls: string[] = []
    const r: any = await importChosen(LOC.id, ['m1', 'm3'], 2, 'u', { db: dbWith(calls), fetchImpl })
    expect(r).toMatchObject({ ok: false, reason: 'changed' })
    expect(calls.filter((c) => c.startsWith('insert') || c.startsWith('rpc'))).toEqual([])
  })
  it('the count must match the ticks, or nothing happens', async () => {
    const calls: string[] = []
    expect(await importChosen(LOC.id, ['m1', 'm2'], 1, 'u', { db: dbWith(calls), fetchImpl })).toMatchObject({ ok: false, reason: 'bad_request' })
    expect(await importChosen(LOC.id, [], 0, 'u', { db: dbWith(calls), fetchImpl })).toMatchObject({ ok: false, reason: 'bad_request' })
    expect(calls).toEqual([])
  })
})

// ── No side effects: the importer (and everything it imports) names no sender ──
describe('no welcome email, drip, Slack, notification or Jobber send', () => {
  const SENDERS = /welcome|drip|enrol|slack|notif|jobber|resend|sendgrid|postmark|nodemailer|twilio|sendmail|send_?email|digest-|daily_?digest|send_?digest/i
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const resolve = (from: string, spec: string) => {
    const base = spec.startsWith('@/') ? join(process.cwd(), spec.slice(2)) : join(dirname(from), spec)
    for (const ext of ['.ts', '.tsx', '.js', '/index.ts']) if (existsSync(base + ext)) return base + ext
    return null
  }
  const walk = (file: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(file)) return seen
    seen.add(file)
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const m of Array.from(src.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g))) {
      if (!m[1].startsWith('.') && !m[1].startsWith('@/')) continue
      const f = resolve(file, m[1]); if (f) walk(f, seen)
    }
    return seen
  }
  it('every file the importer loads is free of sender names', () => {
    const files = Array.from(['lib/mailchimp-pull.ts', 'lib/mailchimp-pull-review.ts', 'app/api/mailchimp/import/route.ts']
      .reduce((seen, f) => walk(join(process.cwd(), f), seen), new Set<string>()))
    const named = files.map((f) => {
      const hitAt = stripComments(readFileSync(f, 'utf8')).match(SENDERS)
      return hitAt ? `${f.replace(process.cwd() + '/', '')}: "${hitAt[0]}"` : null
    }).filter(Boolean)
    expect(named).toEqual([])
    expect(files.length).toBeGreaterThan(3)
  })
  // The screen's own words say "nothing is sent to Jobber or Slack", so it is
  // checked by what it can reach: what it imports and the one route it calls.
  it('the screen imports only React and the design tokens, and calls only its own route', () => {
    const src = readFileSync(join(process.cwd(), 'components/settings/MailchimpImportScreen.jsx'), 'utf8')
    expect(Array.from(src.matchAll(/from\s+'([^']+)'/g)).map((m) => m[1])).toEqual(['react', '@/components/design/tokens'])
    const urls = Array.from(src.matchAll(/doFetch\(\s*'([^']+)'/g)).map((m) => m[1])
    expect(urls.length).toBe(2)
    for (const u of urls) expect(u.startsWith('/api/mailchimp/import')).toBe(true)
  })
})
