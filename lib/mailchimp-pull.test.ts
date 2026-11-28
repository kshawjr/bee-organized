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
const plan1 = (m: MailchimpMember, here: PullLead[] = [], staff: string[] = []) =>
  planPull({ members: [m], leadsHere: here, staffKeys: new Set(staff) }).decisions[0]

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
  it('Kevin 2026-11-27: a name match with a different email is NOT a "same person?" — they come in as new', () => {
    expect(plan1(mem('a', { firstName: 'Mariellen', lastName: 'Davis' }), [lead('L1', { name: 'Mariellen  Davis', email: 'dc@x.com' })])).toMatchObject({ kind: 'create' })
    expect(plan1(mem('a', { firstName: 'Katie', lastName: 'Lambremont' }), [lead('L1', { first_name: 'katie', last_name: 'LAMBREMONT' })])).toMatchObject({ kind: 'create' })
  })
  it('same phone, different email is the ONLY "same person?" case', () => {
    const p = planPull({ members: [
      mem('ph', { phone: '4235550100' }),
      mem('nm', { firstName: 'Jo', lastName: 'Ng' }),
      mem('mc1', { firstName: 'Sam', lastName: 'Oak' }), mem('mc2', { firstName: 'Sam', lastName: 'Oak' }),
    ], leadsHere: [lead('L1', { phone: '423 555 0100', email: 'z@x.com' }), lead('L2', { name: 'Jo Ng', email: 'jo@x.com' })], staffKeys: new Set() })
    expect(p.decisions.map((d) => d.kind + ':' + ((d as any).reason || ''))).toEqual(['held:phone_match', 'create:', 'create:', 'create:'])
    expect(Object.keys(p.counts.held).sort()).toEqual(['duplicate_in_mailchimp', 'phone_match'])
  })
  it('a held phone match must still pass every create rule (no join date → skipped, not asked)', () => {
    expect(plan1(mem('a', { phone: '4235550100', joinedAt: null }), [lead('L1', { phone: '423 555 0100' })])).toMatchObject({ kind: 'skipped', reason: 'no_join_date' })
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
  it('only match is in the Recycle Bin by email or phone → skipped', () => {
    expect(plan1(mem('a'), [lead('B1', { email: 'a@example.org', is_junk: true })])).toMatchObject({ kind: 'skipped', reason: 'recycle_bin_only', ids: ['B1'] })
    expect(plan1(mem('a', { phone: '4235550100' }), [lead('B1', { phone: '423 555 0100', is_junk: true })])).toMatchObject({ kind: 'skipped', reason: 'recycle_bin_only' })
  })
  // Kevin, 2026-11-27: a name is too weak to ask about, so it is far too weak to drop someone silently.
  it('the Recycle Bin check never matches on a name: a shared name alone → brought in as an ordinary new person', () => {
    const binned = [lead('B1', { name: 'Jo Ng', first_name: 'Jo', last_name: 'Ng', is_junk: true } as any)]
    expect(plan1(mem('a', { firstName: 'Jo', lastName: 'Ng' }), binned)).toMatchObject({ kind: 'create' })
    expect(plan1(mem('a', { firstName: 'JO', lastName: ' ng ' }), binned)).toMatchObject({ kind: 'create' })
    // …and the same person by email or phone is still skipped.
    expect(plan1(mem('a', { firstName: 'Jo', lastName: 'Ng' }), [lead('B1', { name: 'Jo Ng', email: 'a@example.org', is_junk: true })])).toMatchObject({ kind: 'skipped', reason: 'recycle_bin_only' })
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
    expect(plan1(mem('a', { email: 'KShawJr+LiveTest@gmail.com' }), [], ['kshawjr@gmail.com'])).toMatchObject({ kind: 'skipped', reason: 'staff' })
    expect(plan1(mem('a', { email: 'kshawjr2@gmail.com' }), [], ['kshawjr@gmail.com'])).toMatchObject({ kind: 'create' })
  })
  it('a plus-addressed user account covers its plain address too', async () => {
    const locRow = { id: LOC.id, name: 'Test Location', location_id: 'loc_test', lifecycle_status: 'active', mailchimp_connected: true, mailchimp_list_id: 'aud1', mailchimp_access_token: 'tok', mailchimp_server_prefix: 'us1' }
    const page = { total_items: 1, members: [{ id: 'm1', email_address: 'kevin@bmave.com', status: 'subscribed', timestamp_opt: '2024-07-01T10:00:00+00:00', merge_fields: {} }] }
    const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(page) })
    const r: any = await loadPull(LOC.id, { db: fakeDb([], { tables: { locations: [locRow], hub_users: [{ email: 'Kevin+Admin@bmave.com' }], leads: [] } }), fetchImpl })
    expect(r.plan.decisions[0]).toMatchObject({ kind: 'skipped', reason: 'staff' })
  })
  it('an email on a Bee Hub user account → skipped as staff', () => {
    expect(plan1(mem('a', { email: 'zach@me.com' }), [], ['zach@me.com'])).toMatchObject({ kind: 'skipped', reason: 'staff' })
  })
  it('Kevin 2026-11-27: someone at ANOTHER location comes in as new here — other locations are not even read', async () => {
    const locRow = { id: LOC.id, name: 'Test Location', location_id: 'loc_test', lifecycle_status: 'active', mailchimp_connected: true, mailchimp_list_id: 'aud1', mailchimp_access_token: 'tok', mailchimp_server_prefix: 'us1' }
    const page = { total_items: 1, members: [{ id: 'm1', email_address: 'away@example.org', status: 'subscribed', timestamp_opt: '2024-07-01T10:00:00+00:00', merge_fields: {} }] }
    const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(page) })
    const leadReads: any[] = []
    const db: any = fakeDb([], { tables: { locations: [locRow], hub_users: [], leads: [{ id: 'X1', email: 'away@example.org', location_uuid: 'elsewhere', is_junk: false }] }, onRead: (t, f) => { if (t === 'leads') leadReads.push(f) } })
    const r: any = await loadPull(LOC.id, { db, fetchImpl })
    expect(r.plan.decisions[0]).toMatchObject({ kind: 'create' })
    expect(leadReads.every((f) => f.some(([o, k, v]: any) => o === 'eq' && k === 'location_uuid' && v === LOC.id))).toBe(true)
  })
  it('no join date → skipped (created_at must be the join date)', () => {
    expect(plan1(mem('a', { joinedAt: null }))).toMatchObject({ kind: 'skipped', reason: 'no_join_date' })
  })
  it('two would-be records with the same phone → both held', () => {
    const p = planPull({ members: [mem('a', { phone: '4235550100' }), mem('b', { phone: '423-555-0100' })], leadsHere: [], staffKeys: new Set() })
    expect(p.decisions.map((d) => d.kind + ':' + ((d as any).reason || ''))).toEqual(['held:duplicate_in_mailchimp', 'held:duplicate_in_mailchimp'])
  })
  it('unsubscribed with no match → created, flagged unsubscribed', () => {
    expect(plan1(mem('a', { status: 'unsubscribed' }))).toMatchObject({ kind: 'create', unsubscribed: true })
  })
  it('counts add up to everyone read', () => {
    const p = planPull({ members: [mem('a'), mem('b', { status: 'cleaned' }), mem('c', { email: 'c@beeorganized.com' })], leadsHere: [], staffKeys: new Set() })
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
function fakeDb(calls: string[], opts: { rpcError?: boolean; existing?: string[]; tables?: Record<string, any[]>; failTable?: string; failWrite?: string; onRead?: (table: string, filters: any[]) => void } = {}) {
  // Each fake gets its own copy of the rows, so a test that writes can't leak into the next.
  const tables: Record<string, any[]> = Object.fromEntries(Object.entries(opts.tables || {}).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const chain = (table: string, op: string, payload?: any) => {
    const filters: Array<[string, string, any]> = []
    const q: any = {
      select: () => q, order: () => q, range: () => q, limit: () => q,
      eq: (k: string, v: any) => { filters.push(['eq', k, v]); return q }, neq: (k: string, v: any) => { filters.push(['neq', k, v]); return q },
      ilike: (k: string, v: any) => { filters.push(['ilike', k, v]); return q },
      in: (k: string, v: any) => { filters.push(['in', k, v]); return q },
      or: (expr: string) => { filters.push(['or', expr, null]); return q },
      single: () => q, maybeSingle: () => q,
      then: (ok: any, bad: any) => {
        if (opts.failTable === table) return Promise.resolve({ data: null, error: { message: 'unreadable' } }).then(ok, bad)
        const orOk = (r: any, expr: string) => expr.split(',').some((part) => {
          const [col, how, ...rest] = part.split('.'); const val = rest.join('.')
          return how === 'is' && val === 'null' ? r[col] == null : how === 'eq' ? String(r[col]) === val : false
        })
        const match = (r: any) => filters.every(([o, k, v]) => (o === 'eq' ? r[k] === v : o === 'neq' ? r[k] !== v : o === 'in' ? v.includes(r[k]) : o === 'or' ? orOk(r, k) : true))
        if ((op === 'insert' || op === 'upsert') && opts.failWrite === table) return Promise.resolve({ data: null, error: { message: 'write refused' } }).then(ok, bad)
        if (op === 'insert' && table === 'lead_notes') {
          calls.push(`note ${payload.lead_id} ${payload.text}`)
          ;(tables.lead_notes ||= []).push({ ...payload })
          return Promise.resolve({ data: null, error: null }).then(ok, bad)
        }
        if (op === 'upsert' && table === 'lead_tags') {
          calls.push(`tag ${payload.map((r: any) => r.lead_id + '+' + r.tag_lookup_id).join(',')}`)
          ;(tables.lead_tags ||= []).push(...payload.map((r: any) => ({ ...r })))
          return Promise.resolve({ data: null, error: null }).then(ok, bad)
        }
        if (op === 'insert') {
          calls.push(`insert ${table} ${payload.email}`)
          if (tables[table]) tables[table].push({ id: 'new-' + payload.email, is_junk: false, ...payload })
          return Promise.resolve({ data: { id: 'new-' + payload.email }, error: null }).then(ok, bad)
        }
        if (op === 'upsert') {
          if (!tables[table]) return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } }).then(ok, bad)
          calls.push(`upsert ${table} ${payload.scope}:${payload.key}=${payload.choice}`)
          tables[table] = tables[table].filter((r) => !(r.location_id === payload.location_id && r.scope === payload.scope && r.key === payload.key)).concat([{ ...payload }])
          return Promise.resolve({ data: null, error: null }).then(ok, bad)
        }
        if (op === 'delete') {
          if (!tables[table]) return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } }).then(ok, bad)
          const gone = tables[table].filter(match)
          calls.push(`delete ${table} ${gone.map((r) => r.scope + ':' + r.key).join(',')}`)
          tables[table] = tables[table].filter((r) => !match(r))
          return Promise.resolve({ data: null, error: null }).then(ok, bad)
        }
        if (op === 'select' && opts.onRead) opts.onRead(table, filters)
        if (table === 'leads' && filters.some((f) => f[0] === 'ilike')) {
          const e = String(filters.find((f) => f[0] === 'ilike')![2]).replace(/\\/g, '')
          calls.push(`recheck ${e}`)
          const found = (tables.leads || []).filter((r) => match(r) && String(r.email || '').trim().toLowerCase() === e.toLowerCase())
          return Promise.resolve({ data: (opts.existing || []).includes(e) ? [{ id: 'old', email: e }] : found, error: null }).then(ok, bad)
        }
        if (!tables[table] && table === 'mailchimp_import_choices') return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } }).then(ok, bad)
        const rows = tables[table] || []
        const out = rows.filter(match)
        return Promise.resolve({ data: op === 'one' || table === 'locations' ? out[0] ?? null : out, error: null }).then(ok, bad)
      },
    }
    return q
  }
  return {
    from: (t: string) => ({ select: () => chain(t, 'select').select(), insert: (row: any) => chain(t, 'insert', row), upsert: (row: any) => chain(t, 'upsert', row), delete: () => chain(t, 'delete') }),
    tables,
    rpc: async (fn: string, args: any) => { calls.push(`rpc ${fn} ${args.p_email}`); return opts.rpcError ? { data: null, error: { message: 'boom' } } : { data: true, error: null } },
  }
}

describe('the real run', () => {
  const planOf = (...m: MailchimpMember[]) => planPull({ members: m, leadsHere: [], staffKeys: new Set() })
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
    const p = planPull({ members: [mem('a', { status: 'cleaned' }), mem('b', { email: 'b@beeorganized.com' }), mem('c', { phone: '4235550100' }), mem('d', { email: 'd@x.com' })], leadsHere: [lead('L1', { phone: '423-555-0100' }), lead('L2', { email: 'd@x.com' })], staffKeys: new Set() })
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
  const dbWith = (calls: string[], extra: Record<string, any[]> = {}) => {
    const d: any = fakeDb(calls, { tables: { locations: [locRow], hub_users: [], leads, ...extra } })
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
    expect(r.model.held).toMatchObject([{ k: 'm3', reason: 'phone_match', p: '4235550100', match: { n: 'Pat Lee', e: 'pat@x.com', p: '423-555-0100' } }])
    expect(r.model.already).toBe(1)
  })
  it('only the ticked people are created', async () => {
    const calls: string[] = []
    const out = [{ location_id: LOC.id, scope: 'person', key: 'one@example.org', choice: 'out' }]
    const r: any = await importChosen(LOC.id, ['m2'], 1, 'u', { db: dbWith(calls, { mailchimp_import_choices: out }), fetchImpl })
    expect(r).toMatchObject({ ok: true, created: 1, createdUnsubscribed: 1 })
    expect(calls.filter((c) => c.startsWith('insert'))).toEqual(['insert leads two@example.org'])
  })
  it('a held person is never brought in because the page sends them — only on a saved "Different people"', async () => {
    const calls: string[] = []
    const r: any = await importChosen(LOC.id, ['m1', 'm3'], 2, 'u', { db: dbWith(calls), fetchImpl })
    expect(r).toMatchObject({ ok: false, reason: 'changed' })
    expect(calls.filter((c) => c.startsWith('insert') || c.startsWith('rpc'))).toEqual([])
    // "Same person" (saved 'out') keeps them out too.
    const same = [{ location_id: LOC.id, scope: 'person', key: 'three@example.org', choice: 'out' }]
    expect(await importChosen(LOC.id, ['m1', 'm3'], 2, 'u', { db: dbWith(calls, { mailchimp_import_choices: same }), fetchImpl })).toMatchObject({ ok: false, reason: 'changed' })
    expect(calls.filter((c) => c.startsWith('insert'))).toEqual([])
  })
  it('"Different people" brings the held person in as new; the group tick never does', async () => {
    const calls: string[] = []
    const diff = [{ location_id: LOC.id, scope: 'person', key: 'three@example.org', choice: 'in' }, { location_id: LOC.id, scope: 'group', key: 'new', choice: 'out' }]
    const r: any = await importChosen(LOC.id, ['m3'], 1, 'u', { db: dbWith(calls, { mailchimp_import_choices: diff }), fetchImpl })
    expect(r).toMatchObject({ ok: true, created: 1 })
    expect(calls.filter((c) => c.startsWith('insert'))).toEqual(['insert leads three@example.org'])
    const model: any = await reviewModel(LOC.id, { db: dbWith([], { mailchimp_import_choices: [{ location_id: LOC.id, scope: 'group', key: 'new', choice: 'in' }] }), fetchImpl })
    expect(model.model.held[0].c).toBeUndefined()
  })
  it('the count must match the ticks, or nothing happens', async () => {
    const calls: string[] = []
    expect(await importChosen(LOC.id, ['m1', 'm2'], 1, 'u', { db: dbWith(calls), fetchImpl })).toMatchObject({ ok: false, reason: 'bad_request' })
    expect(await importChosen(LOC.id, [], 0, 'u', { db: dbWith(calls), fetchImpl })).toMatchObject({ ok: false, reason: 'bad_request' })
    expect(calls).toEqual([])
  })
})

// ── The owner's ticks are saved, and a saved tick is never trusted on its own ──
import { saveImportChoice, loadImportChoices, isTicked } from './mailchimp-import-choices'

describe('saved ticks: kept, re-checked, spent', () => {
  const locRow = { id: LOC.id, name: 'Test Location', location_id: 'loc_test', lifecycle_status: 'active', mailchimp_connected: true, mailchimp_list_id: 'aud1', mailchimp_access_token: 'tok', mailchimp_server_prefix: 'us1' }
  const mc = (id: string, email: string, extra: any = {}) => ({ id, email_address: email, status: 'subscribed', timestamp_opt: '2024-07-01T10:00:00+00:00', merge_fields: {}, ...extra })
  const members = [
    mc('m1', 'one@example.org'),
    mc('m2', 'two@example.org'),
    mc('mS', 'kshawjr+x@gmail.com'),                                  // staff (plus-address of a user)
    mc('mA', 'kept@example.org'),                                     // already in Bee Hub
    mc('mH', 'three@example.org', { merge_fields: { PHONE: '4235550100' } }), // held: phone match
    mc('mC', 'bounced@example.org', { status: 'cleaned' }),           // skipped: bounced
    mc('mB', 'binned@example.org'),                                   // skipped: only in the Recycle Bin
  ]
  const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ total_items: members.length, members }) })
  const leads = [
    { id: 'L1', name: 'Pat Lee', email: 'pat@x.com', phone: '423-555-0100', location_uuid: LOC.id, is_junk: false },
    { id: 'L2', email: 'kept@example.org', location_uuid: LOC.id, is_junk: false },
    { id: 'L3', email: 'binned@example.org', location_uuid: LOC.id, is_junk: true },
  ]
  const newDb = (calls: string[], choices: any[] = []): any =>
    fakeDb(calls, { tables: { locations: [locRow], hub_users: [{ email: 'kshawjr@gmail.com' }], leads, mailchimp_import_choices: choices } })
  const row = (scope: string, key: string, choice: string) => ({ location_id: LOC.id, scope, key, choice })

  it('choices survive leaving the review and coming back', async () => {
    const calls: string[] = []
    const db = newDb(calls)
    expect(await saveImportChoice(LOC.id, 'u', { scope: 'group', key: 'new', choice: 'out' }, { db })).toEqual({ ok: true })
    expect(await saveImportChoice(LOC.id, 'u', { scope: 'person', key: 'two@example.org', choice: 'in' }, { db })).toEqual({ ok: true })
    // "Come back": a brand-new review read from the same database.
    const r: any = await reviewModel(LOC.id, { db, fetchImpl })
    expect(r.model.choicesReady).toBe(true)
    expect(r.model.group).toBe('out')
    expect(r.model.create).toEqual([expect.objectContaining({ k: 'm1' }), expect.objectContaining({ k: 'm2', c: 'in' })])
    expect(r.model.create[0].c).toBeUndefined()
  })
  it('only differences from "ticked" are stored: ticking back to the default deletes the row', async () => {
    const calls: string[] = []
    const db = newDb(calls)
    await saveImportChoice(LOC.id, 'u', { scope: 'person', key: 'one@example.org', choice: 'out' }, { db })
    await saveImportChoice(LOC.id, 'u', { scope: 'person', key: 'one@example.org', choice: null }, { db })
    expect(db.tables.mailchimp_import_choices).toEqual([])
  })
  it('the import follows the saved ticks, not just the page', async () => {
    const calls: string[] = []
    const db = newDb(calls, [row('person', 'one@example.org', 'out')])
    // The page says both, but one@ was unticked and saved: nobody comes in.
    expect(await importChosen(LOC.id, ['m1', 'm2'], 2, 'u', { db, fetchImpl })).toMatchObject({ ok: false, reason: 'changed' })
    expect(calls.filter((c) => c.startsWith('insert') || c.startsWith('rpc'))).toEqual([])
  })
  it('a saved tick is re-checked against every rule at import time', async () => {
    const calls: string[] = []
    // Saved "in" for every kind of person who must never come in (written
    // straight into the table, as if by any route, bypassing the save check).
    const sneaky = ['kshawjr+x@gmail.com', 'kept@example.org', 'bounced@example.org', 'binned@example.org'].map((e) => row('person', e, 'in'))
    const db = newDb(calls, [row('group', 'new', 'out'), ...sneaky])
    const r: any = await reviewModel(LOC.id, { db, fetchImpl })
    expect(r.model.create.map((p: any) => p.k)).toEqual(['m1', 'm2'])       // none of them offered
    expect(r.model.held.map((p: any) => p.k)).toEqual(['mH'])
    expect(r.model.skipped.byReason).toEqual({ staff: 1, cleaned: 1, recycle_bin_only: 1 })
    expect(r.model.already).toBe(1)
    // The page asks for all of them: refused, nothing written.
    expect(await importChosen(LOC.id, ['mS', 'mA', 'mC', 'mB'], 4, 'u', { db, fetchImpl })).toMatchObject({ ok: false, reason: 'changed' })
    // Group unticked + those saved ticks = nobody ticked; asking for m1 is refused too.
    expect(await importChosen(LOC.id, ['m1'], 1, 'u', { db, fetchImpl })).toMatchObject({ ok: false, reason: 'changed' })
    expect(calls.filter((c) => c.startsWith('insert') || c.startsWith('rpc'))).toEqual([])
  })
  it('nothing about who is skipped or held changes when ticks are saved', async () => {
    const plain: any = await reviewModel(LOC.id, { db: newDb([]), fetchImpl })
    const ticked: any = await reviewModel(LOC.id, { db: newDb([], [row('group', 'new', 'out'), row('person', 'three@example.org', 'in'), row('person', 'one@example.org', 'out')]), fetchImpl })
    const shape = (m: any) => ({ create: m.create.map((p: any) => p.k), held: m.held.map((h: any) => h.k + ':' + h.reason), skipped: m.skipped, already: m.already, read: m.read })
    expect(shape(ticked.model)).toEqual(shape(plain.model))
  })
  it('someone already imported is not offered again, and their saved choice is spent', async () => {
    const calls: string[] = []
    const db = newDb(calls, [row('person', 'one@example.org', 'in'), row('person', 'two@example.org', 'out')])
    const r: any = await importChosen(LOC.id, ['m1'], 1, 'u', { db, fetchImpl })
    expect(r).toMatchObject({ ok: true, created: 1 })
    expect(db.tables.mailchimp_import_choices).toEqual([row('person', 'two@example.org', 'out')])   // one@ spent
    const again: any = await reviewModel(LOC.id, { db, fetchImpl })
    expect(again.model.create.map((p: any) => p.k)).toEqual(['m2'])
    expect(again.model.already).toBe(2)
    expect(await saveImportChoice(LOC.id, 'u', { scope: 'person', key: 'one@example.org', choice: 'in' }, { db })).toMatchObject({ ok: false, error: 'already_here' })
    expect(await importChosen(LOC.id, ['m1'], 1, 'u', { db, fetchImpl })).toMatchObject({ ok: false, reason: 'changed' })
    expect(calls.filter((c) => c.startsWith('insert'))).toEqual(['insert leads one@example.org'])
  })
  it('before the table exists: nothing is saved, everyone new counts as ticked', async () => {
    const d: any = fakeDb([], { tables: { locations: [locRow], hub_users: [], leads: [] } })
    expect(await saveImportChoice(LOC.id, 'u', { scope: 'group', key: 'new', choice: 'out' }, { db: d })).toMatchObject({ ok: false, error: 'not_ready' })
    const c = await loadImportChoices(LOC.id, d)
    expect(c.ready).toBe(false)
    expect(isTicked('anyone@example.org', c)).toBe(true)
  })
  it('Chattanooga: a tick cannot even be saved', async () => {
    const boom: any = { from: () => { throw new Error('read') } }
    expect(await saveImportChoice('e7b05e53-7bd7-48de-a13b-10018c8b1b08', 'u', { scope: 'group', key: 'new', choice: 'out' }, { db: boom })).toMatchObject({ ok: false, error: 'not_available' })
  })
  it('only the one group and real addresses can be saved', async () => {
    const db = newDb([])
    for (const bad of [{ scope: 'group', key: 'archived', choice: 'out' }, { scope: 'person', key: 'One@Example.org', choice: 'out' }, { scope: 'person', key: 'x', choice: 'in' }, { scope: 'phone', key: 'a|b@c.d', choice: 'same' }, { scope: 'person', key: 'a@b.co', choice: 'maybe' }]) {
      expect(await saveImportChoice(LOC.id, 'u', bad, { db })).toMatchObject({ ok: false, error: 'bad_request' })
    }
    expect(db.tables.mailchimp_import_choices).toEqual([])
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
    const files = Array.from(['lib/mailchimp-pull.ts', 'lib/mailchimp-pull-review.ts', 'lib/mailchimp-import-choices.ts', 'app/api/mailchimp/import/route.ts', 'app/api/mailchimp/import/choice/route.ts']
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
    expect(urls.length).toBe(3)
    for (const u of urls) expect(u.startsWith('/api/mailchimp/import')).toBe(true)
  })
})

// ── Tags (Kevin's ruling, 2026-11-27) ──
import { tagsFor, tagNoteText, isNeverCopied, isIgnoredTag, QUIZ_NOTE, type TagDef } from './mailchimp-pull'

describe('Mailchimp tags: attach what exists, note the rest, never create, never Profile Quiz', () => {
  const corp = (id: string, label: string): TagDef => ({ id, label, location_id: null })
  const own = (id: string, label: string): TagDef => ({ id, label, location_id: LOC.id })
  it('a tag is attached only when the location already has that exact name', () => {
    const r = tagsFor(['VIP', 'Friend & Family', 'vip', 'Realtors'], [corp('t1', 'VIP'), corp('t2', 'Realtor')])
    expect(r.attach.map((t) => t.id)).toEqual(['t1'])
    expect(r.noted).toEqual(['Friend & Family', 'vip', 'Realtors'])   // exact name: no case or plural guessing
  })
  it('a corporate tag wins over the location’s own tag of the same name', () => {
    expect(tagsFor(['Lead'], [own('o1', 'Lead'), corp('c1', 'Lead')]).attach.map((t) => t.id)).toEqual(['c1'])
  })
  it('"Profile Quiz" is never attached as a tag, in any capitals, even if Bee Hub had one', () => {
    for (const name of ['Profile Quiz', 'profile quiz', 'PROFILE QUIZ', ' Profile  Quiz ', 'pRoFiLe QuIz']) expect(isNeverCopied(name)).toBe(true)
    const r = tagsFor(['Profile Quiz', 'PROFILE QUIZ', 'profile quiz', 'Spring 2024'], [corp('pq', 'Profile Quiz')])
    expect(r.attach).toEqual([])
    expect(r.noted).toEqual(['Spring 2024'])
    expect(r.quiz).toBe(true)
    expect(isNeverCopied('Profile Quizzes')).toBe(false)
    expect(tagsFor(['Profile Quizzes'], []).quiz).toBe(false)
  })
  it('the note names every leftover tag, once, in plain words; no leftovers → no note', () => {
    expect(tagNoteText(['Friend & Family', 'Spring 2024'])).toBe('Tags from Mailchimp: Friend & Family, Spring 2024. Bee Hub has no tag with these names, so they are kept here.')
    expect(tagNoteText(['Friend & Family'])).toBe('Tags from Mailchimp: Friend & Family. Bee Hub has no tag with this name, so it is kept here.')
    expect(tagNoteText([])).toBeNull()
    expect(tagsFor(['A', 'A', ' A '], []).noted).toEqual(['A'])
  })
  it('"Profile Quiz" goes in the note in plain words, never as the raw tag name', () => {
    expect(QUIZ_NOTE).toBe('Joined your mailing list by taking the quiz on your website.')
    expect(tagNoteText([], true)).toBe(QUIZ_NOTE)
    expect(tagNoteText(['Friend & Family'], true)).toBe('Joined your mailing list by taking the quiz on your website. Tags from Mailchimp: Friend & Family. Bee Hub has no tag with this name, so it is kept here.')
    const t = tagsFor(['PROFILE QUIZ'], [])
    expect(tagNoteText(t.noted, t.quiz)).not.toMatch(/profile quiz/i)
  })
  it('"CLOSEDJOB" appears nowhere: no tag, no note, not counted — in any capitals, even if Bee Hub had one', () => {
    for (const name of ['CLOSEDJOB', 'closedjob', ' ClosedJob ']) expect(isIgnoredTag(name)).toBe(true)
    const r = tagsFor(['CLOSEDJOB', 'closedjob', 'Friend & Family'], [corp('cj', 'CLOSEDJOB')])
    expect(r).toEqual({ attach: [], noted: ['Friend & Family'], quiz: false })
    expect(tagsFor(['CLOSEDJOB'], [])).toEqual({ attach: [], noted: [], quiz: false })
    expect(tagNoteText(tagsFor(['CLOSEDJOB'], []).noted)).toBeNull()
    expect(isIgnoredTag('CLOSED JOB 2')).toBe(false)
  })

  const locRow = { id: LOC.id, name: 'Test Location', location_id: 'loc_test', lifecycle_status: 'active', mailchimp_connected: true, mailchimp_list_id: 'aud1', mailchimp_access_token: 'tok', mailchimp_server_prefix: 'us1' }
  const tagRows = [
    { id: 'tVIP', category: 'tags', label: 'VIP', location_id: null, is_active: true },
    { id: 'tOld', category: 'tags', label: 'Follow Up', location_id: null, is_active: false },            // switched off
    { id: 'tAway', category: 'tags', label: 'Garden Club', location_id: 'another-loc', is_active: true }, // another location's own
    { id: 'tOwn', category: 'tags', label: 'Book Club', location_id: LOC.id, is_active: true },
    { id: 'tPQ', category: 'tags', label: 'Profile Quiz', location_id: null, is_active: true },
    { id: 'tCJ', category: 'tags', label: 'CLOSEDJOB', location_id: null, is_active: true },
  ]
  const mcTags = (...names: string[]) => names.map((name) => ({ name }))
  const page = { total_items: 2, members: [
    { id: 'm1', email_address: 'ann@example.org', status: 'subscribed', timestamp_opt: '2024-07-01T10:00:00+00:00', merge_fields: { FNAME: 'Ann', LNAME: 'Lee' }, tags: mcTags('VIP', 'Follow Up', 'Garden Club', 'Book Club', 'Profile Quiz', 'CLOSEDJOB', 'Friend & Family') },
    { id: 'm2', email_address: 'bo@example.org', status: 'subscribed', timestamp_opt: '2024-07-02T10:00:00+00:00', merge_fields: {}, tags: [] },
  ] }
  const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(page) })
  const db = (calls: string[], extra: any = {}) => fakeDb(calls, { tables: { locations: [locRow], hub_users: [], leads: [], lookups: tagRows, mailchimp_import_choices: [] }, ...extra })

  it('the tag list is read fresh with the plan: switched on, corporate or this location’s own only', async () => {
    const r: any = await loadPull(LOC.id, { db: db([]), fetchImpl })
    expect(r.tags.map((t: TagDef) => t.id).sort()).toEqual(['tCJ', 'tOwn', 'tPQ', 'tVIP'])
  })
  it('both guards hold on their own: the question asks only for switched-on tags here, and the answer is checked again', async () => {
    const asked: any[] = []
    const d: any = db([], { onRead: (t: string, f: any[]) => { if (t === 'lookups') asked.push(f) } })
    await loadPull(LOC.id, { db: d, fetchImpl })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toEqual(expect.arrayContaining([['eq', 'is_active', true], ['or', `location_id.is.null,location_id.eq.${LOC.id}`, null]]))
    // A database that ignores every filter and hands back every tag: still only the right ones.
    const loose: any = db([])
    const from = loose.from
    loose.from = (t: string) => t !== 'lookups' ? from(t) : { select: () => { const q: any = { in: () => q, eq: () => q, or: () => q, then: (ok: any) => Promise.resolve({ data: tagRows, error: null }).then(ok) }; return q } }
    const r: any = await loadPull(LOC.id, { db: loose, fetchImpl })
    expect(r.tags.map((t: TagDef) => t.id).sort()).toEqual(['tCJ', 'tOwn', 'tPQ', 'tVIP'])
  })
  it('the tag list can’t be read → nobody is brought in', async () => {
    const calls: string[] = []
    expect(await loadPull(LOC.id, { db: db(calls, { failTable: 'lookups' }), fetchImpl })).toMatchObject({ ok: false, reason: 'tags_unreadable' })
    expect(await importChosen(LOC.id, ['m1', 'm2'], 2, 'u', { db: db(calls, { failTable: 'lookups' }), fetchImpl })).toMatchObject({ ok: false, reason: 'tags_unreadable' })
    expect(calls.filter((c) => /^(insert|tag|note|rpc)/.test(c))).toEqual([])
  })
  it('after import: matching tags attached (by the owner who confirmed), the rest in one note with the quiz in plain words, CLOSEDJOB nowhere, no tag made', async () => {
    const calls: string[] = []
    const d: any = db(calls)
    const r: any = await importChosen(LOC.id, ['m1', 'm2'], 2, 'owner-1', { db: d, fetchImpl })
    expect(r).toMatchObject({ ok: true, created: 2, taggedPeople: 1, notedPeople: 1, tagsFailed: 0 })
    expect(d.tables.lead_tags).toEqual([
      { lead_id: 'new-ann@example.org', tag_lookup_id: 'tVIP', added_by: 'owner-1' },
      { lead_id: 'new-ann@example.org', tag_lookup_id: 'tOwn', added_by: 'owner-1' },
    ])
    expect(d.tables.lead_notes).toEqual([{ lead_id: 'new-ann@example.org', location_uuid: LOC.id, kind: 'buzz', user_id: null, user_label: 'Mailchimp',
      text: 'Joined your mailing list by taking the quiz on your website. Tags from Mailchimp: Follow Up, Garden Club, Friend & Family. Bee Hub has no tag with these names, so they are kept here.' }])
    expect(JSON.stringify([d.tables.lead_tags, d.tables.lead_notes])).not.toMatch(/profile quiz|tPQ|closedjob|tCJ/i)
    expect(r.quizPeople).toBe(1)
    expect(JSON.stringify(r)).not.toMatch(/closedjob/i)
    expect(d.tables.lookups).toEqual(tagRows)                                   // no tag created or changed
    expect(calls.filter((c) => c.includes('lookups'))).toEqual([])
    // Bo had no tags: no tag link, no note.
    expect(calls.filter((c) => c.includes('new-bo@'))).toEqual([])
  })
  it('the tag links and the note pass the real database rules', async () => {
    const d: any = enforceRealRules(db([]))
    const r: any = await importChosen(LOC.id, ['m1', 'm2'], 2, 'owner-1', { db: d, fetchImpl })
    expect(r).toMatchObject({ ok: true, created: 2, taggedPeople: 1, notedPeople: 1, tagsFailed: 0 })
    expect(d.refused).toEqual([])
  })
  it('a tag or note write that fails never undoes the person, and is said out loud', async () => {
    const calls: string[] = []
    const r: any = await importChosen(LOC.id, ['m1', 'm2'], 2, 'u', { db: db(calls, { failWrite: 'lead_tags' }), fetchImpl })
    expect(r).toMatchObject({ ok: true, created: 2, tagsFailed: 1 })
  })
  it('no file in the import path can write the tag list', () => {
    for (const f of ['lib/mailchimp-pull.ts', 'lib/mailchimp-pull-review.ts', 'app/api/mailchimp/import/route.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src).not.toMatch(/from\(\s*['"]lookups['"]\s*\)\s*\.\s*(insert|upsert|update|delete)/)
      const lookupsCalls = Array.from(src.matchAll(/from\(\s*['"]lookups['"]\s*\)\s*\.\s*(\w+)/g)).map((m) => m[1])
      expect(lookupsCalls.every((m) => m === 'select')).toBe(true)
    }
  })
})
