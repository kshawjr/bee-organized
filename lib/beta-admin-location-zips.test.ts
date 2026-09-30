// @vitest-environment node
// Admin → Zip codes API (app/api/admin/location-zips + ./resolve), through the
// REAL handlers over an in-memory location_zips table:
//   • corporate only — owner / no session refused, table untouched
//   • add (and adding a zip another location holds says conflict:true)
//   • edit = move a row to another location
//   • remove
//   • resolve a conflict: keep one location, the others lose the zip
//   • loc_other is never a target; a bad zip is refused
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = { role: 'admin', user: { id: 'corp-1' }, zips: [] as any[], locations: [] as any[], nextId: 1 }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { op: 'select', filters: [] as [string, string, any][], payload: null }
    const b: any = {}
    b.select = () => b
    b.order = () => b
    b.range = () => b
    b.insert = (p: any) => { ctx.op = 'insert'; ctx.payload = p; return b }
    b.update = (p: any) => { ctx.op = 'update'; ctx.payload = p; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    b.eq = (c: string, v: any) => { ctx.filters.push(['eq', c, v]); return b }
    b.in = (c: string, v: any[]) => { ctx.filters.push(['in', c, v]); return b }
    const match = (r: any) => ctx.filters.every(([k, c, v]: any) => (k === 'eq' ? r[c] === v : v.includes(r[c])))
    const run = () => {
      if (client === 'session' && table === 'hub_users') {
        return { data: state.role ? { id: state.user?.id, role: state.role } : null, error: null }
      }
      if (table === 'locations') return { data: state.locations.filter(match), error: null }
      if (table === 'location_zips') {
        if (ctx.op === 'insert') {
          const row = { id: `z${state.nextId++}`, updated_at: 'now', ...ctx.payload }
          state.zips.push(row)
          return { data: row, error: null }
        }
        if (ctx.op === 'update') {
          const hit = state.zips.filter(match)
          hit.forEach((r: any) => Object.assign(r, ctx.payload))
          return { data: hit[0] ?? null, error: null }
        }
        if (ctx.op === 'delete') {
          const gone = state.zips.filter(match)
          state.zips = state.zips.filter((r: any) => !match(r))
          return { data: gone, error: null }
        }
        return { data: state.zips.filter(match), error: null }
      }
      return { data: null, error: null }
    }
    const single = () => {
      const r = run()
      return Promise.resolve({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data })
    }
    b.single = single
    b.maybeSingle = single
    b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return b
  }
  return { state, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t, 'service') },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.user } }) },
    from: (t: string) => h.makeBuilder(t, 'session'),
  }),
}))

import { GET, POST, PATCH, DELETE } from '@/app/api/admin/location-zips/route'
import { POST as RESOLVE } from '@/app/api/admin/location-zips/resolve/route'

const req = (body?: any, url = 'http://x/api/admin/location-zips') =>
  ({ json: async () => body, nextUrl: new URL(url) }) as any

const DENVER = { id: 'L-denver', name: 'Denver', location_id: 'loc_denver', lifecycle_status: 'onboarding' }
const CENTRAL = { id: 'L-central', name: 'Central Denver', location_id: 'loc_centraldenver', lifecycle_status: 'onboarding' }
const OMAHA = { id: 'L-omaha', name: 'Omaha', location_id: 'loc_omaha', lifecycle_status: 'active' }
const OTHER = { id: 'L-other', name: 'Other', location_id: 'loc_other', lifecycle_status: 'active' }

beforeEach(() => {
  h.state.role = 'admin'
  h.state.user = { id: 'corp-1' }
  h.state.locations = [DENVER, CENTRAL, OMAHA, OTHER]
  h.state.zips = [
    { id: 'z-a', zip: '80203', location_uuid: 'L-denver' },
    { id: 'z-b', zip: '80203', location_uuid: 'L-central' },
    { id: 'z-c', zip: '68007', location_uuid: 'L-omaha' },
  ]
  h.state.nextId = 1
})

describe('gate', () => {
  it.each([['owner'], [null]])('role %s → 403, nothing read or written', async (role) => {
    h.state.role = role
    const before = JSON.stringify(h.state.zips)
    expect((await GET()).status).toBe(403)
    expect((await POST(req({ zip: '68010', location_uuid: 'L-omaha' }))).status).toBe(403)
    expect((await DELETE(req(undefined, 'http://x/api/admin/location-zips?id=z-c'))).status).toBe(403)
    expect((await RESOLVE(req({ zip: '80203', location_uuid: 'L-denver' }))).status).toBe(403)
    expect(JSON.stringify(h.state.zips)).toBe(before)
  })

  it('no session → 401', async () => {
    h.state.user = null
    expect((await GET()).status).toBe(401)
  })

  it('super_admin is allowed', async () => {
    h.state.role = 'super_admin'
    expect((await GET()).status).toBe(200)
  })
})

describe('view', () => {
  it('GET lists every row and the pickable locations — loc_other excluded', async () => {
    const j = await (await GET()).json()
    expect(j.zips).toHaveLength(3)
    expect(j.locations.map((l: any) => l.location_id)).not.toContain('loc_other')
  })
})

describe('add', () => {
  it('adds a zip to a location', async () => {
    const res = await POST(req({ zip: '68010', location_uuid: 'L-omaha' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ conflict: false, row: { zip: '68010', location_uuid: 'L-omaha' } })
    expect(h.state.zips.find((z: any) => z.zip === '68010')).toMatchObject({ location_uuid: 'L-omaha', updated_by: 'corp-1' })
  })

  it('adding a zip another location holds is allowed and flagged conflict:true', async () => {
    const res = await POST(req({ zip: '68007', location_uuid: 'L-denver' }))
    expect(res.status).toBe(201)
    expect((await res.json()).conflict).toBe(true)
  })

  it('the same pair twice → 409', async () => {
    expect((await POST(req({ zip: '68007', location_uuid: 'L-omaha' }))).status).toBe(409)
  })

  it('a bad zip → 400, nothing written', async () => {
    const res = await POST(req({ zip: '6800', location_uuid: 'L-omaha' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_zip')
    expect(h.state.zips).toHaveLength(3)
  })

  it('loc_other is never a target', async () => {
    const res = await POST(req({ zip: '68010', location_uuid: 'L-other' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('cannot_assign_to_loc_other')
  })
})

describe('edit (move)', () => {
  it('moves a row to another location', async () => {
    const res = await PATCH(req({ id: 'z-c', location_uuid: 'L-denver' }))
    expect(res.status).toBe(200)
    expect(h.state.zips.find((z: any) => z.id === 'z-c').location_uuid).toBe('L-denver')
  })

  it('moving onto a location that already holds the zip → 409, unchanged', async () => {
    const res = await PATCH(req({ id: 'z-a', location_uuid: 'L-central' }))
    expect(res.status).toBe(409)
    expect(h.state.zips.find((z: any) => z.id === 'z-a').location_uuid).toBe('L-denver')
  })

  it('unknown row → 404', async () => {
    expect((await PATCH(req({ id: 'nope', location_uuid: 'L-omaha' }))).status).toBe(404)
  })
})

describe('remove', () => {
  it('removes a row', async () => {
    const res = await DELETE(req(undefined, 'http://x/api/admin/location-zips?id=z-c'))
    expect(res.status).toBe(200)
    expect(h.state.zips.map((z: any) => z.id)).toEqual(['z-a', 'z-b'])
  })

  it('unknown row → 404', async () => {
    expect((await DELETE(req(undefined, 'http://x/api/admin/location-zips?id=nope'))).status).toBe(404)
  })
})

describe('resolve a conflict', () => {
  it('keeps the chosen location, removes the others for that zip only', async () => {
    const res = await RESOLVE(req({ zip: '80203', location_uuid: 'L-central' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ zip: '80203', kept: 'L-central', removed: ['z-a'] })
    expect(h.state.zips.map((z: any) => z.id).sort()).toEqual(['z-b', 'z-c'])
  })

  it('a location that does not claim the zip cannot be picked', async () => {
    const res = await RESOLVE(req({ zip: '80203', location_uuid: 'L-omaha' }))
    expect(res.status).toBe(400)
    expect(h.state.zips).toHaveLength(3)
  })

  it('a zip not in conflict → 409, nothing deleted', async () => {
    const res = await RESOLVE(req({ zip: '68007', location_uuid: 'L-omaha' }))
    expect(res.status).toBe(409)
    expect(h.state.zips).toHaveLength(3)
  })
})
