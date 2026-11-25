// Owner-safe Network routes, part two: THE GATE HAS NOT WIDENED.
//
// lib/network/owner-safe-routes.test.ts opens the gate in its own file to test
// what owners will meet after the un-grey. This file keeps the REAL gate and
// pins that, today, nobody below super admin gets anything from any Network
// route, and that the files outside Network that these routes lean on are
// byte for byte what they were.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { withoutNotFoundFix } from '@/lib/not-found-footprint'

const h = vi.hoisted(() => {
  const state: any = { hubUser: null, calls: [] as any[] }
  const builder = (table: string, client: string): any => {
    const b: any = new Proxy({}, {
      get(_t, k: string) {
        if (k === 'then') return (res: any) => { state.calls.push({ table, client }); return Promise.resolve({ data: client === 'session' && table === 'hub_users' ? state.hubUser : [], error: null }).then(res) }
        if (k === 'single' || k === 'maybeSingle') return () => { state.calls.push({ table, client }); return Promise.resolve({ data: client === 'session' && table === 'hub_users' ? state.hubUser : null, error: null }) }
        return () => b
      },
    })
    return b
  }
  return { state, builder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.builder(t, 'service') } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'me' } } }) }, from: (t: string) => h.builder(t, 'session') }),
}))

import { NEW_NETWORK_ROLES } from './access'
import * as list from '@/app/api/network/list/route'
import * as nurturing from '@/app/api/network/nurturing/route'
import * as counts from '@/app/api/network/counts/route'
import * as person from '@/app/api/network/nurturing/[id]/route'
import * as followUp from '@/app/api/network/nurturing/[id]/follow-up/route'
import * as nurtureBulk from '@/app/api/network/nurturing/bulk/route'
import * as overview from '@/app/api/network/overview/route'
import * as add from '@/app/api/network/contacts/route'
import * as contact from '@/app/api/network/contacts/[id]/route'
import * as contactBulk from '@/app/api/network/contacts/bulk/route'
import * as importRoute from '@/app/api/network/import/route'
import * as sequences from '@/app/api/network/contacts/[id]/sequences/route'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const ID = 'a1000000-0000-4000-8000-0000000000c1'
const req = (url: string, body?: any) => { const u = new URL(url, 'http://x'); return { nextUrl: u, url: u.toString(), json: async () => body, text: async () => JSON.stringify(body) } as any }
const p = { params: Promise.resolve({ id: ID }) }
const HANDLERS: [string, () => Promise<Response>][] = [
  ['GET list', () => list.GET(req(`/x?location_id=${LOC}`))],
  ['GET nurturing', () => nurturing.GET(req(`/x?location_id=${LOC}`))],
  ['GET counts', () => counts.GET(req(`/x?location_id=${LOC}`))],
  ['GET nurturing/[id]', () => person.GET(req('/x'), p)],
  ['POST follow-up', () => followUp.POST(req('/x', { due_on: '2026-12-01', note: 'x' }), p)],
  ['POST nurturing/bulk', () => nurtureBulk.POST(req('/x', { location_id: LOC, action: 'tag_add', tag_id: ID, selection: { ids: [ID] }, dry_run: true }))],
  ['GET overview', () => overview.GET()],
  ['POST contacts', () => add.POST(req('/x', { location_id: LOC, name: 'X' }))],
  ['GET contacts/[id]', () => contact.GET(req('/x'), p)],
  ['PATCH contacts/[id]', () => contact.PATCH(req('/x', { changes: {} }), p)],
  // Partner emails slice 5: a partner's sequences (start / stop).
  ['GET contacts/[id]/sequences', () => sequences.GET(req('/x'), p)],
  ['POST contacts/[id]/sequences', () => sequences.POST(req('/x', { pathKey: 'partner-introduction', confirmed: true }), p)],
  ['DELETE contacts/[id]/sequences', () => sequences.DELETE(req('/x', { pathKey: 'partner-introduction', confirmed: true }), p)],
  ['POST contacts/bulk', () => contactBulk.POST(req('/x', { location_id: LOC, ids: [ID], action: 'level', value: 'power', confirmed: true }))],
  ['GET import', () => importRoute.GET(req(`/x?location_id=${LOC}`))],
  ['POST import', () => importRoute.POST(req('/x', { location_id: LOC, csv: 'Name\nX\n', mode: 'check' }))],
]

beforeEach(() => { h.state.calls = [] })

describe('the gate itself does not widen', () => {
  it('Network is still super admins only', () => {
    expect([...NEW_NETWORK_ROLES]).toEqual(['super_admin'])
  })
  for (const role of ['admin', 'owner', 'manager', 'lite_user']) {
    for (const [name, run] of HANDLERS) {
      it(`${role} · ${name} → 403 before any data is read`, async () => {
        h.state.hubUser = { id: 'me', role, location_id: LOC }
        const res = await run()
        expect(res.status).toBe(403)
        expect(h.state.calls.filter((c: any) => c.client === 'service')).toEqual([])
      })
    }
  }
})

describe('every Network route asks the gate first, then the location rule', () => {
  const root = join(process.cwd(), 'app/api/network')
  const files: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { const x = join(d, f); statSync(x).isDirectory() ? walk(x) : f === 'route.ts' && files.push(x) } }
  walk(root)
  // Partner emails slice 5 added contacts/[id]/sequences (GET, POST, DELETE).
  // 2026-11-25: counts (GET), the two numbers on the tabs.
  it('there are 13 route files, 17 handlers', () => {
    expect(files.length).toBe(13)
    const handlers = files.flatMap((f) => readFileSync(f, 'utf8').match(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g) || [])
    expect(handlers.length).toBe(17)
  })
  for (const f of files) {
    const rel = f.slice(root.length + 1)
    if (rel === 'summary/route.ts') continue // the old screen's route: location-checked through lib/crm, unchanged (fingerprinted below)
    it(`${rel}: gate, then lib/network/route-access`, () => {
      const src = readFileSync(f, 'utf8')
      expect(src).toMatch(/maySeeNewNetwork\(caller\.role\)/)
      expect(src).toMatch(/from '@\/lib\/network\/route-access'/)
      expect(src.indexOf('maySeeNewNetwork(caller.role)')).toBeLessThan(src.search(/(mayReadNetworkLocation|maySeeAllNetworkLocations|networkWriteVerdict|mayRemindNetworkLocation)\(/))
    })
  }
})

describe('nothing outside Network changes', () => {
  // sha256 (first 16) as of 9245454, the commit before owner-safe routes.
  const PINNED: Record<string, string> = {
    'lib/crm.ts': '0f15c0b894575bbc',
    'lib/read-only-access.ts': '5401c65cf277c0bf',
    'app/api/network/summary/route.ts': '075d9fd79131455d',
    'lib/network/access.ts': '2c76af86bf29a472',
  }
  for (const [f, sha] of Object.entries(PINNED)) {
    it(`${f} is byte for byte unchanged`, () => {
      expect(createHash('sha256').update(withoutNotFoundFix(f, readFileSync(join(process.cwd(), f), 'utf8'))).digest('hex').slice(0, 16)).toBe(sha)
    })
  }
})
