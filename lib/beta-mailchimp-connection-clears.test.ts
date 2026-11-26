// @vitest-environment node
//
// CHANGE THE AUDIENCE, OR THE CONNECTION, AND THE SET-UP STARTS AGAIN.
//
// 2026-11-26 (Kevin): the first-sync confirmation is the guard built after the
// Chattanooga incident (19 people added to an audience without anyone meaning
// it). It is asked until locations.mailchimp_first_sync_at is set, so a date
// left over from another audience would let the new one skip it. Both dates
// (the review too — a review of who goes to one audience is not a review of
// who goes to another) are cleared whenever the connection is no longer the
// same connection: a different audience, a disconnect, a reconnect.
//
// Pinned here:
//   1. changing the audience clears both dates
//   2. disconnecting clears both dates
//   3. saving the same audience id again clears nothing
//   4. (in lib/mailchimp-first-push.test.ts) a cleared location asks the
//      first-sync question again, with the count and the audience name
//   5. the clearing happens wherever the audience is written — not on one
//      screen: the WHOLE app's source is scanned for writes to the connection
//
// Every write here goes through the REAL production rules (enforceRealRules).
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourceFiles } from '@/lib/db-select-scan'
import { findWrites, parseObject } from '@/lib/db-write-scan'
import { enforceRealRules } from '@/lib/db-rules-check'
import { saveAudience, saveConnection, clearConnection } from '@/lib/mailchimp-connection-write'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
vi.mock('./supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))

const LOC = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
const DONE = { mailchimp_review_done_at: '2026-11-20T11:00:00.000Z', mailchimp_first_sync_at: '2026-11-20T12:00:00.000Z' }

// A one-row stand-in for locations that understands the filters these writes use.
function one(row: Record<string, any>) {
  const writes: any[] = []
  const from = (table: string) => {
    if (table !== 'locations') throw new Error('only locations is written: ' + table)
    const f: Array<(r: any) => boolean> = []
    let patch: any = null
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { f.push((r) => r[c] === v); return q },
      or: (expr: string) => {
        const parts = expr.split(',').map((x) => { const [c, op, ...v] = x.split('.'); return { c, op, v: v.join('.') } })
        f.push((r) => parts.some(({ c, op, v }) => op === 'is' && v === 'null' ? (r[c] ?? null) === null : op === 'neq' ? r[c] != null && String(r[c]) !== v : false))
        return q
      },
      update: (p: any) => { patch = p; return q },
      maybeSingle: async () => ({ data: f.every((fn) => fn(row)) ? row : null, error: null }),
      then: (ok: any, bad: any) => {
        const hit = f.every((fn) => fn(row)) ? [row] : []
        if (patch && hit.length) { writes.push(patch); for (const r of hit) Object.assign(r, patch) }   // only writes that matched the row
        return Promise.resolve({ data: hit, error: null }).then(ok, bad)
      },
    }
    return q
  }
  const db = enforceRealRules({ from })
  return { db, writes, row }
}
const at = { now: () => new Date('2026-11-26T15:00:00Z') }

describe('1. changing the audience clears both dates', () => {
  it('a different audience id → the new id and name, BOTH dates empty — in the same write', async () => {
    const x = one({ id: LOC, mailchimp_list_id: 'aaa111', mailchimp_list_name: 'Old Friends', ...DONE })
    const r = await saveAudience(LOC, { id: 'bbb222', name: 'New Friends' }, { db: x.db, ...at })
    expect(r).toEqual({ ok: true, changed: true, progressReset: true, previousName: 'Old Friends' })
    expect(x.row).toMatchObject({ mailchimp_list_id: 'bbb222', mailchimp_list_name: 'New Friends', mailchimp_review_done_at: null, mailchimp_first_sync_at: null })
    expect(x.writes).toHaveLength(1)                               // one update: never the new id with the old dates
    expect(x.writes[0]).toMatchObject({ mailchimp_list_id: 'bbb222', mailchimp_review_done_at: null, mailchimp_first_sync_at: null })
    expect(x.db.refused).toEqual([])
  })
  it('the first audience ever (none before) → set; nothing to tell the owner', async () => {
    const x = one({ id: LOC, mailchimp_list_id: null, mailchimp_list_name: null, mailchimp_review_done_at: null, mailchimp_first_sync_at: null })
    expect(await saveAudience(LOC, { id: 'bbb222', name: 'New Friends' }, { db: x.db, ...at })).toEqual({ ok: true, changed: true, progressReset: false, previousName: null })
    expect(x.row.mailchimp_list_id).toBe('bbb222')
  })
  it('an id that is not a Mailchimp audience id is refused, and nothing is written', async () => {
    const x = one({ id: LOC, mailchimp_list_id: 'aaa111', ...DONE })
    expect(await saveAudience(LOC, { id: 'x,mailchimp_list_id.is.null', name: 'n' }, { db: x.db })).toEqual({ ok: false, error: 'bad_list_id' })
    expect(x.writes).toEqual([])
    expect(x.row).toMatchObject(DONE)
  })
})

describe('2. disconnecting clears both dates (and reconnecting does too)', () => {
  it('disconnect → account, audience, the switch off, and BOTH dates empty', async () => {
    const x = one({ id: LOC, mailchimp_connected: true, mailchimp_access_token: 't', mailchimp_list_id: 'aaa111', mailchimp_sync_live: true, ...DONE })
    expect(await clearConnection(LOC, { db: x.db, ...at })).toEqual({ ok: true, progressReset: true })
    expect(x.row).toMatchObject({ mailchimp_connected: false, mailchimp_access_token: null, mailchimp_list_id: null, mailchimp_sync_live: false, mailchimp_review_done_at: null, mailchimp_first_sync_at: null })
    expect(x.db.refused).toEqual([])
  })
  it('reconnect, even to the same audience → BOTH dates empty (a new connection is not the old one)', async () => {
    const x = one({ id: LOC, mailchimp_connected: true, mailchimp_access_token: 'old', mailchimp_list_id: 'aaa111', ...DONE })
    expect(await saveConnection(LOC, { accessToken: 'new', serverPrefix: 'us8', accountName: 'Test Bee Organized' }, { db: x.db, ...at })).toEqual({ ok: true, progressReset: true })
    expect(x.row).toMatchObject({ mailchimp_access_token: 'new', mailchimp_connected: true, mailchimp_list_id: 'aaa111', mailchimp_review_done_at: null, mailchimp_first_sync_at: null })
    expect(x.db.refused).toEqual([])
  })
})

describe('3. saving the same audience id again clears nothing', () => {
  it('the same id → the dates stay exactly as they were; only the name is refreshed', async () => {
    const x = one({ id: LOC, mailchimp_list_id: 'aaa111', mailchimp_list_name: 'Old name', ...DONE })
    const r = await saveAudience(LOC, { id: 'aaa111', name: 'Renamed in Mailchimp' }, { db: x.db, ...at })
    expect(r).toEqual({ ok: true, changed: false, progressReset: false, previousName: null })
    expect(x.row).toMatchObject({ mailchimp_list_id: 'aaa111', mailchimp_list_name: 'Renamed in Mailchimp', ...DONE })
    // the clearing write matched nothing (the id was the same); the one write that landed never names a date
    expect(x.writes).toEqual([{ mailchimp_list_name: 'Renamed in Mailchimp', updated_at: '2026-11-26T15:00:00.000Z' }])
    for (const w of x.writes) expect(Object.keys(w)).not.toContain('mailchimp_first_sync_at')
  })
})

// ── 5. Wherever the audience is written ──────────────────────
const HOME = 'lib/mailchimp-connection-write.ts'
// The connection: the account and the audience. (The audience's NAME alone is
// not a different connection — the same id renamed in Mailchimp.)
const CONNECTION = ['mailchimp_list_id', 'mailchimp_access_token', 'mailchimp_server_prefix', 'mailchimp_account_name', 'mailchimp_connected', 'mailchimp_connected_at']
const ALL_FILES = sourceFiles(['app', 'lib', 'components', 'scripts', 'middleware.ts'])
const writes = findWrites(ALL_FILES).filter((w) => w.table === 'locations')

describe('5. the clearing happens wherever the audience is written — the whole app, not one screen', () => {
  it('the scan is really looking: it sees the app’s many location writes, including the three Mailchimp ones', () => {
    expect(writes.length).toBeGreaterThan(30)
    expect(writes.filter((w) => w.file === HOME)).toHaveLength(4)   // change, same-again, connect, disconnect
  })

  it('no file but lib/mailchimp-connection-write.ts writes the audience or the account', () => {
    const outside = writes.filter((w) => w.file !== HOME).filter((w) => {
      const p = w.arg && parseObject(w.arg)
      return p && p.keys.some((k) => CONNECTION.includes(k) || k === 'mailchimp_list_name')
    }).map((w) => `${w.file} ${w.op}`)
    expect(outside).toEqual([])
  })

  it('a location write whose row is built at run time can never carry them: its file never names them', () => {
    const risky = writes.filter((w) => w.file !== HOME && (!w.arg || !parseObject(w.arg) || parseObject(w.arg)!.spread))
    expect(risky.length).toBeGreaterThan(0)                         // there are some (the general location edit, billing…)
    const bad = Array.from(new Set(risky.map((w) => w.file))).filter((f) => {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      return [...CONNECTION, 'mailchimp_list_name'].some((c) => src.includes(c))
    })
    expect(bad).toEqual([])
  })

  it('in that file, every write that changes the connection empties BOTH dates in the same write', () => {
    for (const w of writes.filter((x) => x.file === HOME)) {
      const p = parseObject(w.arg || '')!
      expect(p && !p.spread, 'written out, no spread').toBe(true)
      if (!p.keys.some((k) => CONNECTION.includes(k))) {
        // the same-again write: the name only, and no date
        expect(p.keys.sort()).toEqual(['mailchimp_list_name', 'updated_at'])
        continue
      }
      expect(p.fixed.mailchimp_review_done_at, 'review date emptied').toEqual([null])
      expect(p.fixed.mailchimp_first_sync_at, 'first-sync date emptied').toEqual([null])
    }
  })

  it('the three routes that change it go through it, and write no location row themselves', () => {
    for (const [route, fn] of [
      ['app/api/mailchimp/audiences/route.ts', 'saveAudience'],
      ['app/api/mailchimp/callback/route.ts', 'saveConnection'],
      ['app/api/locations/[id]/mailchimp-disconnect/route.ts', 'clearConnection'],
    ] as const) {
      const src = readFileSync(join(process.cwd(), route), 'utf8')
      expect(src, route).toContain(`import { ${fn} } from '@/lib/mailchimp-connection-write'`)
      expect(src, route).toMatch(new RegExp(`await ${fn}\\(`))
      expect(writes.filter((w) => w.file === route), route).toEqual([])
    }
  })

  it('the three routes load (a broken route file fails here, not only at build time)', async () => {
    const mods = await Promise.all([
      import('@/app/api/mailchimp/audiences/route'),
      import('@/app/api/mailchimp/callback/route'),
      import('@/app/api/locations/[id]/mailchimp-disconnect/route'),
    ])
    for (const m of mods) expect(typeof (m as any).POST === 'function' || typeof (m as any).GET === 'function').toBe(true)
  })

  it('the general location edit cannot set the audience: no Mailchimp field is on its list', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/locations/[id]/route.ts'), 'utf8')
    expect(src).toMatch(/const ALLOWED_FIELDS = \[/)
    expect(src).not.toMatch(/mailchimp/i)
  })
})
