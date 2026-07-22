// @vitest-environment node
//
// Moving lead-notification recipients out of Zoho and into Bee Hub — the
// one-time seed (scripts/seed-notification-externals.mjs) and the nightly
// additive top-up (/api/cron/zoho-recipient-topup), which share
// lib/zoho-recipient-topup.ts. Pins the load-bearing behaviors:
//
//   • SCOPE: only locations with ZERO owner/manager hub_users. The 6 that have
//     them are excluded — seeding those would ADD people to the live lists of
//     the only active locations, not move them off Zoho. Recomputed per run, so
//     gaining an owner drops a location out.
//   • MAPPING: externals.location_id gets the location UUID, NOT the slug.
//   • ADDITIVE ONLY: never update, never delete; a human's edit/removal is
//     never undone, and an email Bee Hub already has is never duplicated
//     (read-then-diff, case-insensitive — the table has no unique constraint).
//   • DRY RUN: building a plan writes NOTHING; the script needs --execute.
//   • CRON AUTH: fail-closed without CRON_SECRET, 401 on a wrong secret.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Fake supabase: chainable, records every op so "writes nothing" and
//    "additive only" are assertions about what was ATTEMPTED, not inferred. ──
type Op = { op: string; table: string; rows?: any }
function fakeSupabase(
  tables: Record<string, any[]>,
  ops: Op[],
  insertError: string | null = null,
) {
  return {
    from(table: string) {
      const filters: Array<[string, any[]]> = []
      const b: any = {}
      const resolve = () => {
        let data = tables[table] || []
        for (const [col, vals] of filters) data = data.filter((r: any) => vals.includes(r[col]))
        return { data, error: null }
      }
      b.select = () => b
      b.order = () => b
      b.in = (col: string, vals: any[]) => { filters.push([col, vals]); return b }
      b.eq = (col: string, val: any) => { filters.push([col, [val]]); return b }
      b.insert = (rows: any) => {
        ops.push({ op: 'insert', table, rows })
        return {
          then: (res: any, rej: any) =>
            Promise.resolve(
              insertError ? { data: null, error: { message: insertError } } : { data: rows, error: null },
            ).then(res, rej),
        }
      }
      b.update = (rows: any) => { ops.push({ op: 'update', table, rows }); return b }
      b.delete = () => { ops.push({ op: 'delete', table }); return b }
      b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
      return b
    },
  }
}

const contact = (over: Partial<any> = {}) => ({
  name: 'Jamie Bee',
  email: 'jamie@beeorganized.com',
  opted_out: false,
  first_name: 'Jamie',
  last_name: 'Bee',
  ...over,
})

// A fixture shaped like prod: Zoho-resolving locations + the excluded ones that
// already have an owner/manager hub_user.
const LOCATIONS = [
  { id: 'uuid-westdenver', name: 'West Denver', location_id: 'loc_westdenver' },
  { id: 'uuid-seattle', name: 'Seattle', location_id: 'loc_seattle' },
  { id: 'uuid-portland', name: 'Portland', location_id: 'loc_portland' }, // has owner
  { id: 'uuid-temecula', name: 'Temecula', location_id: 'loc_temecula' }, // has manager
  { id: 'uuid-noslug', name: 'No Slug', location_id: null },
]
const HUB_USERS = [
  { location_id: 'uuid-portland', role: 'owner' },
  { location_id: 'uuid-temecula', role: 'manager' },
]

import {
  selectTargetLocations,
  planLocationRows,
  buildTopUpPlan,
  commitTopUpPlan,
  INTERFACE_ROLES,
  SEED_CATEGORY,
} from '@/lib/zoho-recipient-topup'
import {
  RECIPIENT_INTERFACE_ROLES,
  DEFAULT_CATEGORY,
} from '@/lib/notification-recipients'

// ── Drift pin ──────────────────────────────────────────────────────────────
// zoho-recipient-topup.ts MIRRORS these constants instead of importing them, so
// that Node can load it directly from the seed script (its type-only import
// graph is erased; a runtime import of the resolver would drag in the '@/'
// alias + extensionless specifiers Node can't resolve). That's a deliberate
// trade — these assertions are what make it safe.
describe('constants mirror the resolver (they are copied, not imported)', () => {
  it('INTERFACE_ROLES === RECIPIENT_INTERFACE_ROLES', () => {
    expect([...INTERFACE_ROLES]).toEqual([...RECIPIENT_INTERFACE_ROLES])
  })
  it('SEED_CATEGORY === DEFAULT_CATEGORY', () => {
    expect(SEED_CATEGORY).toBe(DEFAULT_CATEGORY)
  })
})

// ── Scope ──────────────────────────────────────────────────────────────────
describe('selectTargetLocations — the 44 Zoho-resolving locations', () => {
  it('includes locations with ZERO owner/manager hub_users', () => {
    const t = selectTargetLocations(LOCATIONS, HUB_USERS)
    expect(t.map((l) => l.slug).sort()).toEqual(['loc_seattle', 'loc_westdenver'])
  })

  it('EXCLUDES locations that have an owner or a manager', () => {
    const t = selectTargetLocations(LOCATIONS, HUB_USERS)
    expect(t.map((l) => l.id)).not.toContain('uuid-portland')
    expect(t.map((l) => l.id)).not.toContain('uuid-temecula')
  })

  it('skips a location with no Zoho slug — nothing to seed from', () => {
    expect(selectTargetLocations(LOCATIONS, HUB_USERS).map((l) => l.id)).not.toContain(
      'uuid-noslug',
    )
  })

  it('recomputes per run: a location that GAINS an owner drops out', () => {
    const before = selectTargetLocations(LOCATIONS, HUB_USERS)
    expect(before.map((l) => l.id)).toContain('uuid-seattle')
    const after = selectTargetLocations(LOCATIONS, [
      ...HUB_USERS,
      { location_id: 'uuid-seattle', role: 'owner' },
    ])
    expect(after.map((l) => l.id)).not.toContain('uuid-seattle')
  })

  it('carries the UUID and the slug separately — they are different values', () => {
    const t = selectTargetLocations(LOCATIONS, HUB_USERS)
    const wd = t.find((l) => l.slug === 'loc_westdenver')!
    expect(wd.id).toBe('uuid-westdenver')
    expect(wd.slug).toBe('loc_westdenver')
  })
})

// ── Mapping / dedupe ───────────────────────────────────────────────────────
describe('planLocationRows — Zoho contact → external row', () => {
  it('writes the location UUID into location_id (NOT the slug)', () => {
    const { rows } = planLocationRows('uuid-westdenver', [contact()], [])
    expect(rows[0].location_id).toBe('uuid-westdenver')
    expect(rows[0].location_id).not.toBe('loc_westdenver')
  })

  it("seeds category 'all' and a null phone", () => {
    const { rows } = planLocationRows('u1', [contact()], [])
    expect(rows[0].category).toBe('all')
    expect(rows[0].phone).toBeNull()
  })

  it('maps first/last name verbatim from Zoho', () => {
    const { rows } = planLocationRows('u1', [contact({ first_name: 'Mary Jo', last_name: 'Van Der Berg' })], [])
    expect(rows[0].first_name).toBe('Mary Jo')
    expect(rows[0].last_name).toBe('Van Der Berg')
  })

  it('falls back to the display name when Zoho has only a Full_Name', () => {
    const { rows } = planLocationRows(
      'u1',
      [contact({ first_name: null, last_name: null, name: 'Jamie Bee' })],
      [],
    )
    expect(rows[0].first_name).toBe('Jamie Bee')
  })

  it('never stores the email as a name, even via the Full_Name fallback', () => {
    const { rows } = planLocationRows(
      'u1',
      [contact({ first_name: null, last_name: null, name: 'x@y.com', email: 'x@y.com' })],
      [],
    )
    expect(rows[0].first_name).toBeNull()
    expect(rows[0].last_name).toBeNull()
  })

  // Live shape: Zoho's Last_Name is required, so ~2/3 of these contacts have
  // the email pasted into it. It must not land in a name column.
  it('drops a last_name that is just the email (case-insensitively)', () => {
    const { rows } = planLocationRows(
      'u1',
      [
        contact({
          first_name: null,
          last_name: 'Valerie@BeeOrganized.com',
          name: 'valerie@beeorganized.com',
          email: 'valerie@beeorganized.com',
        }),
      ],
      [],
    )
    expect(rows[0].last_name).toBeNull()
    expect(rows[0].first_name).toBeNull()
    expect(rows[0].email).toBe('valerie@beeorganized.com')
  })

  it('keeps a REAL name that merely sits alongside an email-ish sibling field', () => {
    const { rows } = planLocationRows(
      'u1',
      [contact({ first_name: null, last_name: 'White', name: 'White', email: 'infosiouxfalls@beeorganized.com' })],
      [],
    )
    expect(rows[0].last_name).toBe('White')
  })

  it('SKIPS opted-out contacts — an external row has no opt-out concept', () => {
    const { rows, unusable } = planLocationRows('u1', [contact({ opted_out: true })], [])
    expect(rows).toEqual([])
    expect(unusable).toBe(1)
  })

  it('SKIPS contacts with no email', () => {
    const { rows, unusable } = planLocationRows('u1', [contact({ email: '' })], [])
    expect(rows).toEqual([])
    expect(unusable).toBe(1)
  })

  it('ADDITIVE: an email Bee Hub already has is not duplicated', () => {
    const { rows, already } = planLocationRows('u1', [contact()], ['jamie@beeorganized.com'])
    expect(rows).toEqual([])
    expect(already).toBe(1)
  })

  it('dedupes case-insensitively (Zoho vs hand-typed UI entries)', () => {
    const { rows, already } = planLocationRows('u1', [contact({ email: 'Jamie@BeeOrganized.com' })], [
      'jamie@beeorganized.com',
    ])
    expect(rows).toEqual([])
    expect(already).toBe(1)
  })

  it('a NEW Zoho contact absent from Bee Hub IS added alongside existing ones', () => {
    const { rows } = planLocationRows(
      'u1',
      [contact(), contact({ email: 'new@beeorganized.com', first_name: 'New' })],
      ['jamie@beeorganized.com'],
    )
    expect(rows.map((r) => r.email)).toEqual(['new@beeorganized.com'])
  })

  it('dedupes within a single batch — the table has no unique constraint to catch it', () => {
    const { rows } = planLocationRows('u1', [contact(), contact()], [])
    expect(rows).toHaveLength(1)
  })
})

// ── Plan writes nothing ────────────────────────────────────────────────────
describe('buildTopUpPlan — the dry-run gate', () => {
  const zoho = (bySlug: Record<string, any[]>, fail?: string) =>
    vi.fn(async (slug: string) => {
      if (fail && slug === fail) throw new Error('zoho boom')
      return bySlug[slug] || []
    })

  it('writes NOTHING — no insert, update, or delete', async () => {
    const ops: Op[] = []
    await buildTopUpPlan({
      supabase: fakeSupabase(
        { locations: LOCATIONS, hub_users: HUB_USERS, lead_notification_externals: [] },
        ops,
      ),
      fetchZohoContacts: zoho({ loc_westdenver: [contact()], loc_seattle: [contact({ email: 's@b.com' })] }),
    })
    expect(ops).toEqual([])
  })

  it('plans rows only for in-scope locations, keyed by UUID', async () => {
    const plan = await buildTopUpPlan({
      supabase: fakeSupabase(
        { locations: LOCATIONS, hub_users: HUB_USERS, lead_notification_externals: [] },
        [],
      ),
      fetchZohoContacts: zoho({
        loc_westdenver: [contact()],
        loc_seattle: [contact({ email: 's@b.com' })],
        loc_portland: [contact({ email: 'never@b.com' })],
      }),
    })
    expect(plan.rows.map((r) => r.location_id).sort()).toEqual(['uuid-seattle', 'uuid-westdenver'])
    expect(plan.rows.map((r) => r.email)).not.toContain('never@b.com')
  })

  it('never even asks Zoho about an excluded location', async () => {
    const fetchZohoContacts = zoho({ loc_westdenver: [contact()] })
    await buildTopUpPlan({
      supabase: fakeSupabase(
        { locations: LOCATIONS, hub_users: HUB_USERS, lead_notification_externals: [] },
        [],
      ),
      fetchZohoContacts,
    })
    const asked = fetchZohoContacts.mock.calls.map((c) => c[0])
    expect(asked).not.toContain('loc_portland')
    expect(asked).not.toContain('loc_temecula')
  })

  it('diffs against existing externals read from the DB', async () => {
    const plan = await buildTopUpPlan({
      supabase: fakeSupabase(
        {
          locations: LOCATIONS,
          hub_users: HUB_USERS,
          lead_notification_externals: [
            { location_id: 'uuid-westdenver', email: 'JAMIE@beeorganized.com' },
          ],
        },
        [],
      ),
      fetchZohoContacts: zoho({ loc_westdenver: [contact()] }),
    })
    expect(plan.rows).toEqual([])
  })

  it('a Zoho failure for ONE location does not deny the others', async () => {
    const plan = await buildTopUpPlan({
      supabase: fakeSupabase(
        { locations: LOCATIONS, hub_users: HUB_USERS, lead_notification_externals: [] },
        [],
      ),
      fetchZohoContacts: zoho(
        { loc_seattle: [contact({ email: 's@b.com' })] },
        'loc_westdenver',
      ),
    })
    expect(plan.locations.find((l) => l.location.slug === 'loc_westdenver')!.error).toBeTruthy()
    expect(plan.rows.map((r) => r.email)).toEqual(['s@b.com'])
  })
})

// ── Commit ─────────────────────────────────────────────────────────────────
describe('commitTopUpPlan — additive only', () => {
  it('inserts the planned rows and NEVER updates or deletes', async () => {
    const ops: Op[] = []
    const sb = fakeSupabase(
      { locations: LOCATIONS, hub_users: HUB_USERS, lead_notification_externals: [] },
      ops,
    )
    const plan = await buildTopUpPlan({
      supabase: sb,
      fetchZohoContacts: vi.fn(async (s: string) =>
        s === 'loc_westdenver' ? [contact()] : [],
      ),
    })
    const { inserted, errors } = await commitTopUpPlan({ supabase: sb }, plan)

    expect(inserted).toBe(1)
    expect(errors).toEqual([])
    expect(ops.map((o) => o.op)).toEqual(['insert'])
    expect(ops[0].table).toBe('lead_notification_externals')
    expect(ops[0].rows[0].location_id).toBe('uuid-westdenver')
  })

  it('an insert failure is reported per-location, not thrown', async () => {
    const ops: Op[] = []
    const sb = fakeSupabase(
      { locations: LOCATIONS, hub_users: HUB_USERS, lead_notification_externals: [] },
      ops,
      'boom',
    )
    const plan = await buildTopUpPlan({
      supabase: sb,
      fetchZohoContacts: vi.fn(async (s: string) => (s === 'loc_westdenver' ? [contact()] : [])),
    })
    const { inserted, errors } = await commitTopUpPlan({ supabase: sb }, plan)
    expect(inserted).toBe(0)
    expect(errors[0]).toMatchObject({ slug: 'loc_westdenver', reason: 'boom' })
  })

  it('an empty plan writes nothing', async () => {
    const ops: Op[] = []
    const sb = fakeSupabase({}, ops)
    await commitTopUpPlan({ supabase: sb }, { locations: [], rows: [] })
    expect(ops).toEqual([])
  })
})

// ── Lowercased storage — feeds the per-location (location_id, email) backstop ─
describe('planLocationRows — stores email lowercased', () => {
  it('lowercases the stored email (equals the dedup key + the uniqueness backstop)', () => {
    const { rows } = planLocationRows(
      'u1',
      [contact({ email: 'Jamie@BeeOrganized.com', first_name: 'Jamie', last_name: 'Bee' })],
      [],
    )
    expect(rows[0].email).toBe('jamie@beeorganized.com')
    // Name is untouched by the lowercasing — only the email is normalized.
    expect(rows[0].first_name).toBe('Jamie')
    expect(rows[0].last_name).toBe('Bee')
  })
})

// ── The unique backstop is benign — no ON CONFLICT (ships ahead of the index) ─
describe('commitTopUpPlan — a 23505 from the backstop is benign', () => {
  // A stub table that already holds one address (as if a concurrent add raced
  // in between the plan read and this commit). A batch INSERT touching it fails
  // 23505; single-row inserts of it fail 23505; everything else succeeds.
  const stub = (taken: Set<string>, landed: any[]) => ({
    from: () => ({
      insert(rowsArg: any) {
        const arr = Array.isArray(rowsArg) ? rowsArg : [rowsArg]
        if (arr.some((r) => taken.has(r.email))) {
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } })
        }
        for (const r of arr) landed.push(r)
        return Promise.resolve({ data: arr, error: null })
      },
    }),
  })
  const plan = (rows: any[]) => ({
    locations: [{ location: { id: 'u1', name: 'X', slug: 'loc_x' }, rows, already: 0, unusable: 0, error: null }],
    rows,
  })

  it('salvages the batch row-by-row so a raced dup cannot drop the new recipients', async () => {
    const landed: any[] = []
    const p = plan([
      { location_id: 'u1', email: 'new@b.com', first_name: null, last_name: null, phone: null, category: 'all' },
      { location_id: 'u1', email: 'dup@b.com', first_name: null, last_name: null, phone: null, category: 'all' },
    ])
    const { inserted, errors } = await commitTopUpPlan(
      { supabase: stub(new Set(['dup@b.com']), landed) as any },
      p as any,
    )
    expect(errors).toEqual([]) // 23505 is benign — never surfaced as an error
    expect(inserted).toBe(1) // only the genuinely-new row landed
    expect(landed.map((r) => r.email)).toEqual(['new@b.com']) // dup skipped, not thrown
  })

  it('a NON-23505 insert failure is still reported per-location', async () => {
    const failing = {
      from: () => ({
        insert: () => Promise.resolve({ data: null, error: { code: '42501', message: 'nope' } }),
      }),
    }
    const p = plan([
      { location_id: 'u1', email: 'a@b.com', first_name: null, last_name: null, phone: null, category: 'all' },
    ])
    const { inserted, errors } = await commitTopUpPlan({ supabase: failing as any }, p as any)
    expect(inserted).toBe(0)
    expect(errors[0]).toMatchObject({ slug: 'loc_x', reason: 'nope' })
  })
})

// ── Source sweeps: the review gate + cron registration ─────────────────────
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('seed script — dry run is the DEFAULT', () => {
  const src = read('scripts/seed-notification-externals.mjs')

  it('requires --execute to write, and exits before the commit without it', () => {
    expect(src).toContain("args.includes('--execute')")
    // The only commit call sits behind the `if (!EXECUTE) … process.exit(0)` gate.
    expect(src.indexOf('if (!EXECUTE)')).toBeLessThan(src.indexOf('commitTopUpPlan('))
  })

  it('reuses the shared core + real Zoho client rather than re-implementing them', () => {
    expect(src).toContain('lib/zoho-recipient-topup.ts')
    expect(src).toContain('lib/zoho.ts')
  })
})

describe('cron registration', () => {
  const vercel = JSON.parse(read('vercel.json'))
  const cron = vercel.crons.find((c: any) => c.path === '/api/cron/zoho-recipient-topup')

  it('is registered nightly', () => {
    expect(cron).toBeTruthy()
    expect(cron.schedule).toBe('0 5 * * *')
  })

  it('avoids the top of the hour that send-drips owns', () => {
    const drips = vercel.crons.find((c: any) => c.path === '/api/cron/send-drips')
    expect(drips.schedule).toBe('0 * * * *')
    // Same minute would collide with the hourly drip run every night.
    expect(cron.schedule.split(' ')[1]).not.toBe('*')
  })
})

// ── Cron auth ──────────────────────────────────────────────────────────────
// The service client THROWS by default, so an auth test that accidentally fell
// through to the body would fail loudly rather than quietly returning 200.
// The authorized test swaps in a real fake.
const svc = vi.hoisted(() => ({
  impl: null as null | ((t: string) => any),
  ops: [] as any[],
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (t: string) => {
      if (!svc.impl) throw new Error('supabase must not be touched on an auth failure')
      return svc.impl(t)
    },
  },
}))
const zohoMock = vi.hoisted(() => ({ bySlug: {} as Record<string, any[]> }))
vi.mock('@/lib/zoho', () => ({
  getZohoLocationNotificationContacts: vi.fn(async (slug: string) => zohoMock.bySlug[slug] || []),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/cron/zoho-recipient-topup/route'

const URL_BASE = 'https://app.example.com/api/cron/zoho-recipient-topup'

describe('GET /api/cron/zoho-recipient-topup — auth', () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET
    svc.impl = null
    svc.ops = []
    zohoMock.bySlug = {}
  })

  it('fail-closed 500 when CRON_SECRET is not configured', async () => {
    const res = await GET(new NextRequest(URL_BASE))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('cron_secret_not_configured')
  })

  it('401 on a wrong bearer token', async () => {
    process.env.CRON_SECRET = 'right'
    const res = await GET(
      new NextRequest(URL_BASE, { headers: { authorization: 'Bearer wrong' } }),
    )
    expect(res.status).toBe(401)
  })

  it('401 on a wrong ?secret', async () => {
    process.env.CRON_SECRET = 'right'
    const res = await GET(new NextRequest(`${URL_BASE}?secret=wrong`))
    expect(res.status).toBe(401)
  })

  it('401 with no credentials at all', async () => {
    process.env.CRON_SECRET = 'right'
    const res = await GET(new NextRequest(URL_BASE))
    expect(res.status).toBe(401)
  })

  it('the correct bearer token RUNS the top-up: in-scope only, additive insert', async () => {
    process.env.CRON_SECRET = 'right'
    zohoMock.bySlug = {
      loc_westdenver: [contact()],
      loc_seattle: [contact({ email: 'existing@b.com' })], // already in Bee Hub
      loc_portland: [contact({ email: 'never@b.com' })], // excluded from scope
    }
    const sb = fakeSupabase(
      {
        locations: LOCATIONS,
        hub_users: HUB_USERS,
        lead_notification_externals: [
          { location_id: 'uuid-seattle', email: 'existing@b.com' },
        ],
      },
      svc.ops,
    )
    svc.impl = (t: string) => sb.from(t)

    const res = await GET(new NextRequest(URL_BASE, { headers: { authorization: 'Bearer right' } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ locations_in_scope: 2, planned: 1, inserted: 1 })
    expect(body.errors).toEqual([])

    // Exactly one write, additive, keyed by UUID — and nothing for the
    // excluded location or the email Bee Hub already had.
    const inserts = svc.ops.filter((o) => o.op === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].rows).toEqual([
      expect.objectContaining({ location_id: 'uuid-westdenver', category: 'all' }),
    ])
    expect(svc.ops.some((o) => o.op === 'update' || o.op === 'delete')).toBe(false)
  })

  it('the correct ?secret also runs', async () => {
    process.env.CRON_SECRET = 'right'
    svc.impl = (t: string) =>
      fakeSupabase({ locations: [], hub_users: [] }, svc.ops).from(t)
    const res = await GET(new NextRequest(`${URL_BASE}?secret=right`))
    expect(res.status).toBe(200)
  })
})
