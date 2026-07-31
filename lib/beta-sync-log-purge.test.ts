// @vitest-environment node
//
// #110b — sync_log retention purge cron (/api/cron/sync-log-purge).
//
// Pins the load-bearing safety behaviors:
//   • DRY-RUN BY DEFAULT — reports a would-delete count, deletes NOTHING,
//     until SYNC_LOG_PURGE_ENABLED=true (env) or ?execute=true (query).
//   • LIVE deletes ONLY rows older than the 90-day window; rows inside are
//     untouched.
//   • CRON auth: fail-closed without CRON_SECRET (500), 401 on a wrong one,
//     and no delete on a rejected request.
//   • BATCHING: a large deletable set is removed in bounded chunks, never a
//     single unbounded statement.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── stateful fake sync_log: deletes actually remove rows (so the batch
//    loop terminates and batch counts are real), and every delete id-list
//    is recorded so "deletes nothing" / "bounded chunks" are assertions
//    about what was ATTEMPTED. ──────────────────────────────────────
const store = vi.hoisted(() => ({ db: null as any }))

function makeDb(initialRows: Array<{ id: string; created_at: string }>) {
  let rows = initialRows.map(r => ({ ...r }))
  const deletes: string[][] = []
  const from = (_table: string) => {
    const state: any = { head: false, filters: [] as any[], orderCol: null, orderAsc: true, limitN: null, mode: 'rows' }
    const applyFilters = () => {
      let out = rows
      for (const [op, col, val] of state.filters) {
        if (op === 'lt') out = out.filter(r => (r as any)[col] < val)
        if (op === 'in') out = out.filter(r => val.includes((r as any)[col]))
      }
      if (state.orderCol) {
        out = [...out].sort((a, b2) => {
          const x = (a as any)[state.orderCol], y = (b2 as any)[state.orderCol]
          const c = x < y ? -1 : x > y ? 1 : 0
          return state.orderAsc ? c : -c
        })
      }
      if (state.limitN != null) out = out.slice(0, state.limitN)
      return out
    }
    const resolveValue = () => {
      if (state.mode === 'delete') {
        const inF = state.filters.find((f: any) => f[0] === 'in')
        const ids = inF ? inF[2] : []
        deletes.push([...ids])
        rows = rows.filter(r => !ids.includes(r.id))
        return { data: null, error: null }
      }
      if (state.head) return { data: null, error: null, count: applyFilters().length }
      return { data: applyFilters(), error: null }
    }
    const thenable = () => ({ then: (res: any, rej: any) => Promise.resolve(resolveValue()).then(res, rej) })
    const b: any = {}
    b.select = (_cols: string, opts?: any) => { if (opts?.head) state.head = true; return b }
    b.lt = (col: string, val: any) => { state.filters.push(['lt', col, val]); return b }
    b.in = (col: string, vals: any[]) => { state.filters.push(['in', col, vals]); return b }
    b.order = (col: string, o?: any) => { state.orderCol = col; state.orderAsc = o?.ascending !== false; return b }
    b.limit = (n: number) => { state.limitN = n; return thenable() }
    b.delete = () => { state.mode = 'delete'; return b }
    b.then = (res: any, rej: any) => Promise.resolve(resolveValue()).then(res, rej)
    return b
  }
  return { from, getRows: () => rows, getDeletes: () => deletes }
}

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => store.db.from(t) },
}))

import { GET } from '@/app/api/cron/sync-log-purge/route'

const DAY = 24 * 60 * 60 * 1000
const iso = (ageDays: number) => new Date(Date.now() - ageDays * DAY).toISOString()
const makeRows = (n: number, ageDays: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, created_at: iso(ageDays) }))

const SECRET = 'right-secret'
const req = (opts: { auth?: string; query?: string } = {}) => {
  const url = `http://localhost/api/cron/sync-log-purge${opts.query ?? ''}`
  const headers: Record<string, string> = {}
  if (opts.auth) headers['authorization'] = opts.auth
  return new NextRequest(url, { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = SECRET
  delete process.env.SYNC_LOG_PURGE_ENABLED
})
afterEach(() => {
  delete process.env.SYNC_LOG_PURGE_ENABLED
})

describe('sync-log-purge — auth (fail-closed)', () => {
  it('missing CRON_SECRET → 500, deletes nothing', async () => {
    delete process.env.CRON_SECRET
    store.db = makeDb(makeRows(5, 100, 'old'))
    const res = await GET(req({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('cron_secret_not_configured')
    expect(store.db.getDeletes()).toEqual([])
  })

  it('wrong bearer token → 401, deletes nothing', async () => {
    store.db = makeDb(makeRows(5, 100, 'old'))
    const res = await GET(req({ auth: 'Bearer wrong' }))
    expect(res.status).toBe(401)
    expect(store.db.getDeletes()).toEqual([])
    expect(store.db.getRows().length).toBe(5)
  })

  it('wrong ?secret → 401, deletes nothing', async () => {
    store.db = makeDb(makeRows(5, 100, 'old'))
    const res = await GET(req({ query: '?secret=nope&execute=true' }))
    expect(res.status).toBe(401)
    expect(store.db.getDeletes()).toEqual([])
  })
})

describe('sync-log-purge — dry run (default)', () => {
  it('reports a would-delete count but deletes NOTHING', async () => {
    // 7 old (older than 90d) + 4 inside the window.
    store.db = makeDb([...makeRows(7, 100, 'old'), ...makeRows(4, 10, 'new')])
    const res = await GET(req({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('dry_run')
    expect(body.would_delete).toBe(7)
    expect(body.deleted).toBe(0)
    expect(body.retention_days).toBe(90)
    expect(body.oldest).toBeTruthy()
    expect(body.newest).toBeTruthy()
    // The invariant: nothing removed.
    expect(store.db.getDeletes()).toEqual([])
    expect(store.db.getRows().length).toBe(11)
  })

  it('a valid ?secret (no execute) is still a dry run', async () => {
    store.db = makeDb(makeRows(3, 100, 'old'))
    const res = await GET(req({ query: `?secret=${SECRET}` }))
    const body = await res.json()
    expect(body.mode).toBe('dry_run')
    expect(store.db.getDeletes()).toEqual([])
  })
})

describe('sync-log-purge — live (explicitly enabled)', () => {
  it('?execute=true deletes ONLY rows older than the window; inside-window rows untouched', async () => {
    store.db = makeDb([...makeRows(6, 100, 'old'), ...makeRows(4, 10, 'new')])
    const res = await GET(req({ auth: `Bearer ${SECRET}`, query: '?execute=true' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('live')
    expect(body.deleted).toBe(6)
    const left = store.db.getRows()
    expect(left.length).toBe(4)
    expect(left.every((r: any) => r.id.startsWith('new'))).toBe(true)
  })

  it('SYNC_LOG_PURGE_ENABLED=true enables live deletion for the scheduled cron', async () => {
    process.env.SYNC_LOG_PURGE_ENABLED = 'true'
    store.db = makeDb([...makeRows(5, 100, 'old'), ...makeRows(2, 5, 'new')])
    const res = await GET(req({ auth: `Bearer ${SECRET}` }))
    const body = await res.json()
    expect(body.mode).toBe('live')
    expect(body.deleted).toBe(5)
    expect(store.db.getRows().length).toBe(2)
  })

  it('all rows inside the window → live run deletes nothing', async () => {
    store.db = makeDb(makeRows(8, 10, 'new'))
    const res = await GET(req({ auth: `Bearer ${SECRET}`, query: '?execute=true' }))
    const body = await res.json()
    expect(body.deleted).toBe(0)
    expect(store.db.getDeletes()).toEqual([])
    expect(store.db.getRows().length).toBe(8)
  })
})

describe('sync-log-purge — bounded batching (not one statement)', () => {
  it('a large deletable set is removed in ≤500-row chunks', async () => {
    // 1200 old rows → 500 + 500 + 200 = 3 batches.
    store.db = makeDb([...makeRows(1200, 100, 'old'), ...makeRows(3, 10, 'new')])
    const res = await GET(req({ auth: `Bearer ${SECRET}`, query: '?execute=true' }))
    const body = await res.json()
    expect(body.deleted).toBe(1200)
    expect(body.batches).toBe(3)
    const batches = store.db.getDeletes()
    expect(batches.length).toBe(3)                       // NOT one statement
    expect(batches.every((b: string[]) => b.length <= 500)).toBe(true)
    expect(batches[0].length).toBe(500)
    expect(batches[2].length).toBe(200)
    // Inside-window rows survived the sweep.
    expect(store.db.getRows().length).toBe(3)
  })
})
