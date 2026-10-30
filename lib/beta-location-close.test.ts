// @vitest-environment node
// Closing a location (lib/location-close.ts) over an in-memory database that
// records every write. Pinned:
//   • closing releases every zip for that location and no zips for any other
//   • a released zip routes a new enquiry to Other (through routeByZip)
//   • leads move to Other in BOTH the slug column and the uuid column, and
//     every other client table moves in its own reference style
//   • no billing_invoices or subscription_seats row is deleted (seats end)
//   • the location's users are disabled and none deleted; reopen re-enables
//     exactly them
//   • the dry run writes nothing, and its counts equal what the real run does
//   • a non-super_admin cannot close (lib gate AND the route), nothing written
//   • the typed name must match; a blocker refuses before any write
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = { tables: {} as Record<string, any[]>, writes: [] as { table: string; op: string }[], sessionRole: 'super_admin' }
  const rowsOf = (t: string) => (state.tables[t] ||= [])

  const makeBuilder = (table: string) => {
    const ctx: any = { op: 'select', filters: [] as ((r: any) => boolean)[], payload: null, head: false, count: false, range: null, cols: '*' }
    const b: any = {}
    b.select = (cols = '*', opts: any = {}) => {
      if (ctx.op === 'select') { ctx.cols = cols; ctx.head = !!opts.head; ctx.count = opts.count === 'exact' }
      return b
    }
    b.update = (p: any, opts: any = {}) => { ctx.op = 'update'; ctx.payload = p; ctx.count = opts.count === 'exact'; return b }
    b.delete = (opts: any = {}) => { ctx.op = 'delete'; ctx.count = opts.count === 'exact'; return b }
    b.insert = (p: any) => { ctx.op = 'insert'; ctx.payload = p; return b }
    b.eq = (c: string, v: any) => { ctx.filters.push((r: any) => r[c] === v); return b }
    b.neq = (c: string, v: any) => { ctx.filters.push((r: any) => r[c] !== null && r[c] !== undefined && r[c] !== v); return b }
    b.is = (c: string, v: any) => { ctx.filters.push((r: any) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return b }
    b.not = (c: string, op: string, v: any) => {
      if (op !== 'is') throw new Error(`fake: not(${op}) unsupported`)
      ctx.filters.push((r: any) => (v === null ? r[c] !== null && r[c] !== undefined : r[c] !== v))
      return b
    }
    b.in = (c: string, vs: any[]) => { ctx.filters.push((r: any) => vs.includes(r[c])); return b }
    b.gt = (c: string, v: any) => { ctx.filters.push((r: any) => r[c] !== null && r[c] > v); return b }
    b.order = () => b
    b.range = (from: number, to: number) => { ctx.range = [from, to]; return b }
    const match = (r: any) => ctx.filters.every((f: any) => f(r))
    const shape = (r: any) => {
      if (table === 'location_zips' && String(ctx.cols).includes('location:locations')) {
        const l = rowsOf('locations').find((x: any) => x.id === r.location_uuid)
        return { zip: r.zip, location: l ? { location_id: l.location_id, lifecycle_status: l.lifecycle_status } : null }
      }
      return { ...r }
    }
    const run = () => {
      const all = rowsOf(table)
      const hit = all.filter(match)
      if (ctx.op === 'update') {
        state.writes.push({ table, op: 'update' })
        hit.forEach((r: any) => Object.assign(r, ctx.payload))
        return { data: null, error: null, count: ctx.count ? hit.length : null }
      }
      if (ctx.op === 'delete') {
        state.writes.push({ table, op: 'delete' })
        state.tables[table] = all.filter((r: any) => !match(r))
        return { data: null, error: null, count: ctx.count ? hit.length : null }
      }
      if (ctx.op === 'insert') {
        state.writes.push({ table, op: 'insert' })
        all.push({ ...ctx.payload })
        return { data: ctx.payload, error: null }
      }
      const sliced = ctx.range ? hit.slice(ctx.range[0], ctx.range[1] + 1) : hit
      return { data: ctx.head ? null : sliced.map(shape), error: null, count: ctx.count ? hit.length : null }
    }
    const single = () => {
      const r = run()
      return Promise.resolve({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data })
    }
    b.maybeSingle = single
    b.single = single
    b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return b
  }
  const db = { from: (t: string) => makeBuilder(t) }
  return { state, rowsOf, db }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: h.db }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'caller-1' } } }) },
    from: (t: string) => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'caller-1', role: h.state.sessionRole }, error: null }) }) }),
    }),
  }),
}))
vi.mock('@/lib/location-close-deps', () => ({ liveCloseDeps: {} }))

import {
  closeLocation,
  planLocationClose,
  reopenLocation,
  LOCATION_REFERENCES,
  OTHER_UUID,
  OTHER_SLUG,
} from '@/lib/location-close'
import { routeByZip } from '@/lib/zip-routing'
import { POST as CLOSE_ROUTE } from '@/app/api/admin/locations/[id]/close/route'

const NOW = '2026-10-29T15:00:00.000Z'
const KC = '11111111-1111-4111-8111-111111111111'
const DEN = '22222222-2222-4222-8222-222222222222'
const KC_SLUG = 'loc_kc'
const DEN_SLUG = 'loc_denver'
const SUPER = { hubUserId: 'kevin', role: 'super_admin' }

function seed() {
  const t = h.state.tables
  for (const k of Object.keys(t)) delete t[k]
  h.state.writes = []
  t.locations = [
    { id: KC, name: 'Kansas City', location_id: KC_SLUG, lifecycle_status: 'active', notifications_live: true, jobber_account_id: 'acct-kc', jobber_connected: true, jobber_access_token: 'tok', stripe_subscription_id: 'sub_kc', subscription_status: 'active', slack_bot_token: 'xoxb', slack_connected: true, close_record: null },
    { id: DEN, name: 'Denver', location_id: DEN_SLUG, lifecycle_status: 'active', notifications_live: true, jobber_account_id: 'acct-den', stripe_subscription_id: 'sub_den', subscription_status: 'active', close_record: null },
    { id: OTHER_UUID, name: 'Other', location_id: OTHER_SLUG, lifecycle_status: 'onboarding', notifications_live: true, close_record: null },
  ]
  t.location_zips = [
    { id: 'z1', zip: '64101', location_uuid: KC },
    { id: 'z2', zip: '64102', location_uuid: KC },
    { id: 'z3', zip: '64103', location_uuid: KC },
    { id: 'z4', zip: '80203', location_uuid: DEN },
    { id: 'z5', zip: '80204', location_uuid: DEN },
  ]
  t.leads = [
    { id: 'l1', location_id: KC_SLUG, location_uuid: KC, jobber_client_id: 'jc1', is_junk: false, archived_at: null },
    { id: 'l2', location_id: KC_SLUG, location_uuid: KC, jobber_client_id: null, is_junk: false, archived_at: null },
    { id: 'l3', location_id: KC_SLUG, location_uuid: KC, jobber_client_id: null, is_junk: true, archived_at: null },
    { id: 'l9', location_id: DEN_SLUG, location_uuid: DEN, jobber_client_id: 'jc9', is_junk: false, archived_at: null },
  ]
  t.engagements = [{ id: 'e1', client_id: 'l1', location_uuid: KC }, { id: 'e9', client_id: 'l9', location_uuid: DEN }]
  t.touchpoints = [{ id: 't1', lead_id: 'l1', location_uuid: KC }, { id: 't2', lead_id: 'l2', location_uuid: KC }, { id: 't9', lead_id: 'l9', location_uuid: DEN }]
  t.lead_notes = [{ id: 'n1', lead_id: 'l1', location_uuid: KC }]
  t.lead_contacts = [{ id: 'c1', lead_id: 'l2', location_uuid: KC }]
  t.quotes = [{ id: 'q1', lead_id: 'l1', location_id: KC_SLUG, jobber_quote_id: 'jq1' }, { id: 'q9', lead_id: 'l9', location_id: DEN_SLUG, jobber_quote_id: 'jq9' }]
  t.jobs = [{ id: 'j1', lead_id: 'l1', location_id: KC_SLUG, jobber_job_id: 'jj1' }]
  t.invoices = [{ id: 'i1', lead_id: 'l1', location_id: KC_SLUG, jobber_invoice_id: 'ji1' }]
  t.service_requests = [{ id: 'sr1', lead_id: 'l1', location_id: KC_SLUG, jobber_request_id: 'jr1' }]
  t.assessments = [{ id: 'a1', lead_id: 'l1', location_id: KC_SLUG }]
  t.payments = []
  t.job_visits = []
  t.notes = []
  t.lead_drip_progress = [
    { id: 'p1', lead_id: 'l1', stopped_at: null, completed_at: null, stopped_reason: null },
    { id: 'p2', lead_id: 'l2', stopped_at: '2026-10-01T00:00:00.000Z', completed_at: null, stopped_reason: 'stage_changed' },
    { id: 'p9', lead_id: 'l9', stopped_at: null, completed_at: null, stopped_reason: null },
  ]
  t.scheduled_stage_emails = [
    { id: 's1', lead_id: 'l2', sent_at: null, cancelled_at: null, cancelled_reason: null },
    { id: 's2', lead_id: 'l1', sent_at: '2026-10-02T00:00:00.000Z', cancelled_at: null },
    { id: 's9', lead_id: 'l9', sent_at: null, cancelled_at: null },
  ]
  // hub_users.location_id holds the UUID as text — not the slug.
  t.hub_users = [
    { id: 'u-owner', location_id: KC, role: 'owner', disabled_at: null, disabled_by: null },
    { id: 'u-mgr', location_id: KC, role: 'manager', disabled_at: null, disabled_by: null },
    { id: 'u-gone', location_id: KC, role: 'manager', disabled_at: '2026-09-01T00:00:00.000Z', disabled_by: 'someone' },
    { id: 'u-den', location_id: DEN, role: 'owner', disabled_at: null, disabled_by: null },
  ]
  t.pending_invites = [
    { id: 'pi1', location_id: KC, accepted_at: null, invite_expires_at: '2026-11-05T00:00:00.000Z' },
    { id: 'pi2', location_id: KC, accepted_at: null, invite_expires_at: '2026-10-01T00:00:00.000Z' },
    { id: 'pi9', location_id: DEN, accepted_at: null, invite_expires_at: '2026-11-05T00:00:00.000Z' },
  ]
  t.email_accounts = [{ id: 'g1', location_id: KC, sync_enabled: true }]
  t.subscription_seats = [
    { id: 'seat1', location_id: KC, status: 'active', removed_at: null, tier: 'owner' },
    { id: 'seat2', location_id: KC, status: 'active', removed_at: null, tier: 'manager' },
    { id: 'seat9', location_id: DEN, status: 'active', removed_at: null, tier: 'owner' },
  ]
  t.billing_invoices = [{ id: 'bi1', location_id: KC, amount_cents: 9900 }, { id: 'bi2', location_id: KC, amount_cents: 9900 }]
  t.import_jobs = []
}

const deps = (over: any = {}) => ({
  now: () => NOW,
  cancelStripeSubscription: vi.fn(async () => 'canceled'),
  setAuthBan: vi.fn(async () => true),
  ...over,
})
const byId = (table: string, id: string) => h.rowsOf(table).find((r: any) => r.id === id)

beforeEach(() => { seed(); h.state.sessionRole = 'super_admin' })

describe('the enumeration', () => {
  it('names leads twice — slug and uuid — both moved', () => {
    const leads = LOCATION_REFERENCES.filter((r) => r.table === 'leads')
    expect(leads.map((r) => [r.column, r.form, r.action])).toEqual([
      ['location_id', 'slug', 'move'],
      ['location_uuid', 'uuid', 'move'],
    ])
  })
  it('never moves or deletes billing', () => {
    const billing = LOCATION_REFERENCES.filter((r) => r.table === 'billing_invoices' || r.table === 'subscription_seats')
    expect(billing.map((r) => r.action).sort()).toEqual(['end', 'history'])
  })
})

describe('dry run', () => {
  it('writes nothing, and its counts equal what the real close then does', async () => {
    const before = JSON.stringify(h.state.tables)
    const out = await closeLocation(h.db, { locationId: KC, actor: SUPER, dryRun: true }, deps())
    expect(out.status).toBe(200)
    expect(h.state.writes).toEqual([])
    expect(JSON.stringify(h.state.tables)).toBe(before)

    const plan = out.body.plan!
    expect(plan.counts).toEqual({
      zips_released: 3,
      moved: { engagements: 1, touchpoints: 2, lead_notes: 1, lead_contacts: 1, quotes: 1, jobs: 1, invoices: 1, payments: 0, service_requests: 1, assessments: 1, job_visits: 0, notes: 0, leads: 3 },
      drips_stopped: 1,
      stage_emails_cancelled: 1,
      users_disabled: 2,
      invites_expired: 1,
      gmail_accounts_paused: 1,
      seats_ended: 2,
    })
    expect(plan.facts.leads_joining_other_queue).toBe(2)
    expect(plan.facts.released_zips).toEqual(['64101', '64102', '64103'])

    const real = await closeLocation(h.db, { locationId: KC, actor: SUPER, dryRun: false, confirmName: 'Kansas City' }, deps())
    expect(real.status).toBe(200)
    expect(real.body.done).toEqual(plan.counts)
  })
})

describe('the real close', () => {
  const close = (d = deps()) =>
    closeLocation(h.db, { locationId: KC, actor: SUPER, dryRun: false, confirmName: '  kansas city ' }, d)

  it('releases every zip for that location and no zips for any other', async () => {
    await close()
    const zips = h.rowsOf('location_zips')
    expect(zips.filter((z: any) => z.location_uuid === KC)).toEqual([])
    expect(zips.map((z: any) => z.zip).sort()).toEqual(['80203', '80204'])
    expect(byId('locations', KC).close_record.released_zips).toEqual(['64101', '64102', '64103'])
  })

  it('a released zip routes a new enquiry to Other', async () => {
    expect((await routeByZip('64101')).slug).toBe(KC_SLUG)
    await close()
    const d = await routeByZip('64101')
    expect(d).toMatchObject({ slug: OTHER_SLUG, reason: 'unmatched' })
    expect((await routeByZip('80203')).slug).toBe(DEN_SLUG)
  })

  it('moves leads to Other in BOTH the slug and the uuid column, and every child table', async () => {
    await close()
    for (const id of ['l1', 'l2', 'l3']) {
      expect(byId('leads', id)).toMatchObject({ location_id: OTHER_SLUG, location_uuid: OTHER_UUID })
    }
    expect(byId('leads', 'l9')).toMatchObject({ location_id: DEN_SLUG, location_uuid: DEN })
    for (const [t, id] of [['engagements', 'e1'], ['touchpoints', 't1'], ['touchpoints', 't2'], ['lead_notes', 'n1'], ['lead_contacts', 'c1']]) {
      expect(byId(t, id).location_uuid).toBe(OTHER_UUID)
    }
    for (const [t, id] of [['quotes', 'q1'], ['jobs', 'j1'], ['invoices', 'i1'], ['service_requests', 'sr1'], ['assessments', 'a1']]) {
      expect(byId(t, id).location_id).toBe(OTHER_SLUG)
    }
    expect(byId('quotes', 'q9').location_id).toBe(DEN_SLUG)
    expect(byId('engagements', 'e9').location_uuid).toBe(DEN)
  })

  it('deletes no billing_invoices or subscription_seats row; seats are ended', async () => {
    await close()
    expect(h.state.writes.filter((w: any) => w.op === 'delete').map((w: any) => w.table)).toEqual(['location_zips'])
    expect(h.rowsOf('billing_invoices')).toHaveLength(2)
    expect(h.rowsOf('subscription_seats')).toHaveLength(3)
    expect(byId('subscription_seats', 'seat1')).toMatchObject({ status: 'inactive', removed_at: NOW })
    expect(byId('subscription_seats', 'seat9')).toMatchObject({ status: 'active', removed_at: null })
  })

  it('disables the location\'s users and deletes none; reopen re-enables exactly them', async () => {
    const d = deps()
    await close(d)
    expect(h.rowsOf('hub_users')).toHaveLength(4)
    expect(byId('hub_users', 'u-owner')).toMatchObject({ disabled_at: NOW, disabled_by: 'kevin' })
    expect(byId('hub_users', 'u-mgr')).toMatchObject({ disabled_at: NOW })
    expect(byId('hub_users', 'u-gone').disabled_at).toBe('2026-09-01T00:00:00.000Z')
    expect(byId('hub_users', 'u-den').disabled_at).toBeNull()
    expect(d.setAuthBan.mock.calls.map((c: any) => c.join(':')).sort()).toEqual(['u-mgr:true', 'u-owner:true'])

    const r = await reopenLocation(h.db, { locationId: KC, actor: SUPER, dryRun: false, confirmName: 'Kansas City' }, d)
    expect(r.status).toBe(200)
    expect(r.body.users_reenabled).toBe(2)
    expect(byId('hub_users', 'u-owner').disabled_at).toBeNull()
    expect(byId('hub_users', 'u-gone').disabled_at).toBe('2026-09-01T00:00:00.000Z')
    expect(byId('locations', KC)).toMatchObject({ lifecycle_status: 'active', notifications_live: true })
    // Clients stay in Other.
    expect(byId('leads', 'l1').location_id).toBe(OTHER_SLUG)
  })

  it('stops the sends, disconnects Jobber + Slack, cancels Stripe, sets closed', async () => {
    const d = deps()
    const out = await close(d)
    expect(out.body.warnings).toEqual([])
    expect(byId('lead_drip_progress', 'p1')).toMatchObject({ stopped_at: NOW, stopped_reason: 'location_closed' })
    expect(byId('lead_drip_progress', 'p2').stopped_reason).toBe('stage_changed')
    expect(byId('lead_drip_progress', 'p9').stopped_at).toBeNull()
    expect(byId('scheduled_stage_emails', 's1')).toMatchObject({ cancelled_at: NOW, cancelled_reason: 'location_closed' })
    expect(byId('scheduled_stage_emails', 's9').cancelled_at).toBeNull()
    const loc = byId('locations', KC)
    expect(loc).toMatchObject({
      lifecycle_status: 'closed', notifications_live: false, jobber_connected: false, jobber_access_token: null,
      jobber_account_id: null, slack_bot_token: null, slack_connected: false, subscription_status: 'canceled',
    })
    expect(loc.close_record).toMatchObject({ from_status: 'active', notifications_live: true, jobber_account_id: 'acct-kc', closed_by: 'kevin' })
    expect(d.cancelStripeSubscription).toHaveBeenCalledWith('sub_kc')
  })

  it('a second run finds nothing left and keeps the first run\'s record', async () => {
    await close()
    const first = byId('locations', KC).close_record.closed_at
    const plan = await planLocationClose(h.db, KC, { now: () => '2026-10-30T00:00:00.000Z' })
    expect(plan!.already_closed).toBe(true)
    expect(plan!.counts.zips_released).toBe(0)
    expect(Object.values(plan!.counts.moved).every((v) => v === 0)).toBe(true)
    expect(plan!.counts.users_disabled).toBe(0)
    await closeLocation(h.db, { locationId: KC, actor: SUPER, dryRun: false, confirmName: 'Kansas City' }, deps({ now: () => '2026-10-30T00:00:00.000Z' }))
    expect(byId('locations', KC).close_record.closed_at).toBe(first)
  })
})

describe('gates', () => {
  it.each([['admin'], ['owner'], ['manager'], ['lite_user'], ['']])('role %s cannot close — 403, nothing written', async (role) => {
    const out = await closeLocation(h.db, { locationId: KC, actor: { hubUserId: 'x', role }, dryRun: false, confirmName: 'Kansas City' }, deps())
    expect(out.status).toBe(403)
    expect(h.state.writes).toEqual([])
  })

  it('the route refuses a corporate admin session, nothing written', async () => {
    h.state.sessionRole = 'admin'
    const res = await CLOSE_ROUTE({ json: async () => ({ mode: 'close', confirm_name: 'Kansas City' }) } as any, { params: { id: KC } })
    expect(res.status).toBe(403)
    expect(h.state.writes).toEqual([])
    expect(byId('locations', KC).lifecycle_status).toBe('active')
  })

  it('the route is a dry run unless mode is exactly "close"', async () => {
    for (const body of [{}, { mode: 'Close', confirm_name: 'Kansas City' }, { confirm_name: 'Kansas City' }]) {
      const res = await CLOSE_ROUTE({ json: async () => body } as any, { params: { id: KC } })
      expect(res.status).toBe(200)
      expect((await res.json()).mode).toBe('dry_run')
    }
    expect(h.state.writes).toEqual([])
  })

  it('a wrong typed name refuses, nothing written', async () => {
    const out = await closeLocation(h.db, { locationId: KC, actor: SUPER, dryRun: false, confirmName: 'Denver' }, deps())
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('confirmation_mismatch')
    expect(h.state.writes).toEqual([])
  })

  it('a half-moved lead blocks the close before any write', async () => {
    h.rowsOf('leads').push({ id: 'lx', location_id: KC_SLUG, location_uuid: DEN, is_junk: false, archived_at: null })
    const out = await closeLocation(h.db, { locationId: KC, actor: SUPER, dryRun: false, confirmName: 'Kansas City' }, deps())
    expect(out.status).toBe(409)
    expect(out.body.plan!.blockers.join(' ')).toMatch(/one column but not the other/)
    expect(h.state.writes).toEqual([])
  })

  it('a Jobber id already at Other blocks the close before any write', async () => {
    h.rowsOf('quotes').push({ id: 'qo', location_id: OTHER_SLUG, jobber_quote_id: 'jq1' })
    const out = await closeLocation(h.db, { locationId: KC, actor: SUPER, dryRun: false, confirmName: 'Kansas City' }, deps())
    expect(out.status).toBe(409)
    expect(out.body.plan!.blockers.join(' ')).toMatch(/quotes row\(s\) share a Jobber id/)
    expect(h.state.writes).toEqual([])
  })

  it('Other itself cannot be closed', async () => {
    const out = await closeLocation(h.db, { locationId: OTHER_UUID, actor: SUPER, dryRun: false, confirmName: 'Other' }, deps())
    expect(out.status).toBe(409)
    expect(h.state.writes).toEqual([])
  })
})
