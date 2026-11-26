// @vitest-environment node
//
// EVERY MAILCHIMP WRITE MUST BE ONE THE REAL DATABASE ACCEPTS.
//
// 2026-11-26: Kevin pressed Done on "Who goes to Mailchimp"; step 1 never
// ticked, even after a reload. The Done write was a sync_log row with
// direction 'internal', entity_type 'mailchimp_review', status 'reviewed' —
// all three refused by sync_log's own CHECK rules — so not one was ever
// saved. The first-sync record ('mailchimp_push' / 'complete') was refused the
// same way, so a finished first sync would have asked again every time. All
// tests passed: every stand-in database here accepts any row it is given.
//
// So this file does not trust a stand-in. It holds writes to
// lib/db-rules.snapshot.json — a copy of the REAL production rules (how to
// refresh it is in the file) — through lib/db-rules-check.ts:
//   1. the copy is readable, and is the real one (sync_log's rule is pinned)
//   2. the two rows that shipped are refused, as Postgres refused them
//   3. SOURCE: every insert / update / upsert in the Mailchimp code is found,
//      and every column and fixed value it writes is checked. A write whose
//      row is built at run time must be on RUN_TIME below, naming the test
//      that runs it through the real rules — a new one fails this file.
//   4. RUN TIME: the writes that matter most are run for real, through
//      enforceRealRules (and lib/mailchimp-first-push.test.ts runs EVERY
//      sending test that way).
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourceFiles } from '@/lib/db-select-scan'
import { realSchema } from '@/lib/db-columns-check'
import { realRules, rowProblems, unreadableRules, enforceRealRules, PENDING_COLUMNS, RULED_TABLES } from '@/lib/db-rules-check'

vi.mock('./supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))

const LOC = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'

// ── 1. The copy ───────────────────────────────────────────────
describe('the rules copy is the real one, and every rule in it can be read', () => {
  it('reads every rule — none is skipped in silence', () => {
    expect(unreadableRules()).toEqual([])
    expect(RULED_TABLES().sort()).toEqual(['leads', 'locations', 'mailchimp_review_choices', 'marketing_unsubscribes', 'sync_log'])
  })

  it('holds sync_log as it really is: only Jobber-era words', () => {
    const r = realRules()
    const def = (n: string) => r.checks.sync_log.find((x) => x.name === n)!.def
    expect(def('sync_log_direction_check')).toBe("CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text])))")
    expect(def('sync_log_status_check')).toBe("CHECK ((status = ANY (ARRAY['success'::text, 'error'::text, 'partial'::text])))")
    expect(def('sync_log_entity_type_check')).not.toMatch(/mailchimp/)
    expect(r.required.sync_log).toEqual(['direction', 'entity_type', 'status'])
  })

  it('a pending column is really added by the migration it names, and is not in the real schema yet', () => {
    for (const [col, file] of Object.entries(PENDING_COLUMNS)) {
      const [table, name] = col.split('.')
      const sql = readFileSync(join(process.cwd(), file), 'utf8')
      expect(sql, `${file} adds ${name}`).toMatch(new RegExp(`ALTER TABLE public\\.${table}[\\s\\S]*ADD COLUMN ${name}\\s+timestamptz`))
      // Once the migration has run and lib/db-columns.snapshot.txt is
      // refreshed, this fails: delete the line from PENDING_COLUMNS.
      expect(realSchema().get(table)!.has(name), `${col} is real now — remove it from PENDING_COLUMNS`).toBe(false)
    }
  })
})

// ── 2. The rows that shipped ──────────────────────────────────
describe('the two rows that never saved are refused here, as the real database refused them', () => {
  it('the old Done row: three rules broken', () => {
    const p = rowProblems('sync_log', { location_id: 'loc_test', direction: 'internal', entity_type: 'mailchimp_review', entity_id: LOC, status: 'reviewed', message: 'Done pressed on Who goes to Mailchimp' }, 'insert')
    expect(p.map((x) => x.rule).sort()).toEqual(['sync_log_direction_check', 'sync_log_entity_type_check', 'sync_log_status_check'])
    expect(p.every((x) => x.code === '23514')).toBe(true)
  })
  it('the old first-sync record: kind and result refused', () => {
    const p = rowProblems('sync_log', { location_id: 'loc_test', direction: 'outbound', entity_type: 'mailchimp_push', entity_id: LOC, status: 'complete', message: '{}' }, 'insert')
    expect(p.map((x) => x.rule).sort()).toEqual(['sync_log_entity_type_check', 'sync_log_status_check'])
  })
  it('…while a row sync_log does take passes (the checker is not just saying no)', () => {
    expect(rowProblems('sync_log', { location_id: 'loc_test', direction: 'outbound', entity_type: 'client', status: 'partial' }, 'insert')).toEqual([])
  })
  it('the same shapes Postgres judges: NULL passes a check, a missing required column does not', () => {
    expect(rowProblems('leads', { address_label: null }, 'update')).toEqual([])
    expect(rowProblems('leads', { address_label: 'other', address_label_note: '  ' }, 'update').map((x) => x.rule)).toEqual(['leads_address_label_note_check'])
    expect(rowProblems('mailchimp_review_choices', { location_id: LOC, scope: 'person', key: 'Ann@x.com', choice: 'in' }, 'upsert').map((x) => x.rule)).toEqual(['mailchimp_review_choices_person_key'])
    expect(rowProblems('mailchimp_review_choices', { location_id: LOC, scope: 'phone', key: 'm|a@x.com', choice: 'in' }, 'upsert').map((x) => x.rule)).toEqual(['mailchimp_review_choices_check'])
    expect(rowProblems('sync_log', { direction: 'outbound', entity_type: 'client' }, 'insert').map((x) => `${x.code} ${x.rule}`)).toEqual(['23502 status'])
    expect(rowProblems('locations', { no_such_column: 1 }, 'update').map((x) => x.code)).toEqual(['42703'])
  })
})

// ── 3. Every Mailchimp write, from the source ─────────────────
type Write = { file: string; table: string; op: 'insert' | 'update' | 'upsert'; arg: string | null }

function balanced(src: string, open: number): string | null {
  // src[open] is '(' ; returns the text inside the matching ')', or null when
  // it cannot be read (the caller decides — never skipped for Mailchimp code).
  let depth = 0, i = open, q: string | null = null
  for (; i < src.length; i++) {
    const c = src[i]
    if (q) { if (c === '\\') { i++; continue } if (c === q) q = null; continue }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue }
    if (c === "'" || c === '"' || c === '`') { q = c; continue }
    if (c === '(' || c === '{' || c === '[') depth++
    if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) return src.slice(open + 1, i) }
  }
  return null
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0, q: string | null = null, cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) { cur += c; if (c === '\\') { cur += s[++i]; continue } if (c === q) q = null; continue }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue }
    if ('({['.includes(c)) depth++
    if (')}]'.includes(c)) depth--
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

function findWrites(files: string[]): Write[] {
  const out: Write[] = []
  for (const file of files) {
    const src = readFileSync(join(process.cwd(), file), 'utf8')
    const re = /\.from\(\s*['"]([a-z_]+)['"]\s*\)/g
    let m: RegExpExecArray | null
    const starts: { at: number; table: string }[] = []
    while ((m = re.exec(src))) starts.push({ at: m.index + m[0].length, table: m[1] })
    for (const st of starts) {
      // Follow the chain call by call: .eq(…) .select(…) .update(…) — and
      // stop where the statement stops.
      let pos = st.at
      for (;;) {
        while (/\s/.test(src[pos] || '')) pos++
        if (src[pos] !== '.') break
        const name = /^\.([A-Za-z_]\w*)\s*\(/.exec(src.slice(pos))
        if (!name) break
        const openAt = pos + name[0].length - 1
        const arg = balanced(src, openAt)
        if (['insert', 'update', 'upsert'].includes(name[1])) {
          out.push({ file, table: st.table, op: name[1] as Write['op'], arg })
          break
        }
        if (arg === null) break
        pos = openAt + arg.length + 2
      }
    }
  }
  return out
}

// A fixed value, or the fixed choices of a ternary; undefined = built at run time.
function literalChoices(v: string): unknown[] | undefined {
  const t = v.trim()
  const one = (x: string): unknown[] | undefined => {
    const s = x.trim()
    if (/^'([^'\\]|\\.)*'$/.test(s) || /^"([^"\\]|\\.)*"$/.test(s)) return [s.slice(1, -1)]
    if (/^`[^`$]*`$/.test(s)) return [s.slice(1, -1)]
    if (s === 'null') return [null]
    if (s === 'true') return [true]
    if (s === 'false') return [false]
    if (/^-?\d+(\.\d+)?$/.test(s)) return [Number(s)]
    return undefined
  }
  const q = splitTop(t, '?')
  if (q.length === 2) {
    const ab = splitTop(q[1], ':')
    if (ab.length === 2) { const a = one(ab[0]), b = one(ab[1]); return a && b ? [...a, ...b] : undefined }
  }
  return one(t)
}

type Parsed = { keys: string[]; fixed: Record<string, unknown[]>; spread: boolean }
function parseObject(arg: string): Parsed | null {
  const first = splitTop(arg, ',')[0] || ''
  if (!first.startsWith('{')) return null
  const body = first.slice(1, -1)
  const p: Parsed = { keys: [], fixed: {}, spread: false }
  for (const part of splitTop(body, ',')) {
    if (part.startsWith('...')) { p.spread = true; continue }
    const at = part.indexOf(':')
    if (at < 0) { p.keys.push(part.trim()); continue }
    const key = part.slice(0, at).trim().replace(/^['"]|['"]$/g, '')
    p.keys.push(key)
    const ch = literalChoices(part.slice(at + 1))
    if (ch) p.fixed[key] = ch
  }
  return p
}

function combos(fixed: Record<string, unknown[]>): Record<string, unknown>[] {
  let rows: Record<string, unknown>[] = [{}]
  for (const [k, vs] of Object.entries(fixed)) rows = rows.flatMap((r) => vs.map((v) => ({ ...r, [k]: v }))).slice(0, 256)
  return rows
}

// The Mailchimp code: its routes and libraries, plus ANY file in the app whose
// write names a mailchimp_ column or a Mailchimp-only table.
const ALL = sourceFiles(['app', 'lib', 'components'])
const MC_PATH = /(^|\/)(mailchimp[^/]*|marketing-[^/]*)(\/|\.(t|j)sx?$)|mailchimp-disconnect/
const allWrites = findWrites(ALL)
const mcWrites = allWrites.filter((w) =>
  MC_PATH.test(w.file) || ['mailchimp_review_choices', 'marketing_unsubscribes'].includes(w.table) || /\bmailchimp_\w+\s*:/.test(w.arg || ''))

// Writes whose row is built at run time (a variable, not an object written out).
// Each is run through the real rules by the test named. A new one fails below.
const RUN_TIME: Record<string, string> = {
  'lib/mailchimp-sync.ts leads update': 'lib/mailchimp-first-push.test.ts runs every sending test through enforceRealRules',
}

describe('every Mailchimp write in the source names real columns and values the rules accept', () => {
  it('the scan is really looking: it finds the known write sites', () => {
    const sites = new Set(mcWrites.map((w) => `${w.file} ${w.table} ${w.op}`))
    for (const s of [
      'app/api/mailchimp/audiences/route.ts locations update',
      'app/api/mailchimp/callback/route.ts locations update',
      'app/api/locations/[id]/mailchimp-disconnect/route.ts locations update',
      'lib/mailchimp-overview.ts locations update',
      'lib/mailchimp-review-choices.ts mailchimp_review_choices upsert',
      'lib/mailchimp-sync.ts locations update',
      'lib/mailchimp-sync.ts leads update',
    ]) expect(sites.has(s), s).toBe(true)
    // And across the app it finds hundreds of writes, so it is not blind.
    expect(allWrites.length).toBeGreaterThan(200)
  })

  it('no Mailchimp write goes to sync_log (Kevin, 2026-11-26: sync_log is not widened)', () => {
    expect(mcWrites.filter((w) => w.table === 'sync_log').map((w) => w.file)).toEqual([])
  })

  it('every table written has its real rules in the copy', () => {
    const tables = Array.from(new Set(mcWrites.map((w) => w.table))).sort()
    for (const t of tables) expect(RULED_TABLES(), t).toContain(t)
  })

  it('every column written is real (or added by a migration waiting to run), every fixed value passes', () => {
    const problems: string[] = []
    const runTime: Record<string, number> = {}
    for (const w of mcWrites) {
      const where = `${w.file} ${w.table} ${w.op}`
      if (w.arg === null) { problems.push(`${where}: its row could not be read from the source`); continue }
      const p = parseObject(w.arg)
      if (!p || p.spread) { runTime[where] = (runTime[where] || 0) + 1; continue }
      const cols = realSchema().get(w.table)
      if (!cols) { problems.push(`${where}: table ${w.table} is not in the real schema`); continue }
      for (const k of p.keys) if (!cols.has(k) && !PENDING_COLUMNS[`${w.table}.${k}`]) problems.push(`${where}: no column ${k}`)
      if (w.op !== 'update') {
        for (const c of realRules().required[w.table] || []) if (!p.keys.includes(c)) problems.push(`${where}: required column ${c} not written`)
      }
      for (const row of combos(p.fixed)) {
        for (const x of rowProblems(w.table, row, 'update')) problems.push(`${where}: ${x.rule} refuses ${JSON.stringify(row)}`)
      }
    }
    expect(problems).toEqual([])
    expect(Object.keys(runTime).sort(), 'a write built at run time must be on RUN_TIME, with the test that runs it through the real rules').toEqual(Object.keys(RUN_TIME).sort())
  })
})

// ── 4. Run for real, through the real rules ───────────────────
// A small stand-in that records writes; enforceRealRules refuses what the real
// database would refuse before the stand-in ever sees it.
function standIn(rows: Record<string, any[]>) {
  const writes: { table: string; op: string; row: any }[] = []
  const from = (table: string) => {
    const f: Array<(r: any) => boolean> = []
    let patch: any = null
    const run = () => {
      const hit = (rows[table] || []).filter((r) => f.every((fn) => fn(r)))
      if (patch) { for (const r of hit) Object.assign(r, patch); writes.push({ table, op: 'update', row: patch }) }
      return { data: hit, error: null }
    }
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { f.push((r) => r[c] === v); return q },
      is: (c: string, v: any) => { f.push((r) => (r[c] ?? null) === v); return q },
      maybeSingle: async () => ({ data: run().data[0] || null, error: null }),
      update: (p: any) => { patch = p; return q },
      insert: async (row: any) => { writes.push({ table, op: 'insert', row }); (rows[table] ||= []).push(row); return { error: null } },
      upsert: async (row: any) => { writes.push({ table, op: 'upsert', row }); (rows[table] ||= []).push(row); return { error: null } },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
    }
    return q
  }
  return { db: { from }, writes, rows }
}

describe('run for real: Done and the first-sync date, held to the real rules', () => {
  it('Done sets the review date on the location — and the real rules accept it', async () => {
    const { markReviewed } = await import('@/lib/mailchimp-overview')
    const s = standIn({ locations: [{ id: LOC, location_id: 'loc_test' }] })
    const db = enforceRealRules(s.db)
    expect(await markReviewed(LOC, { db, now: () => new Date('2026-11-26T15:00:00Z') })).toBe(true)
    expect(db.refused).toEqual([])
    expect(s.rows.locations[0].mailchimp_review_done_at).toBe('2026-11-26T15:00:00.000Z')
    expect(s.writes.map((w) => w.table)).toEqual(['locations'])
  })

  it('…and the checker would have stopped the old Done row (break it on purpose)', async () => {
    const s = standIn({ sync_log: [] })
    const db = enforceRealRules(s.db)
    const res = await db.from('sync_log').insert({ location_id: 'loc_test', direction: 'internal', entity_type: 'mailchimp_review', entity_id: LOC, status: 'reviewed' })
    expect(res.error?.code).toBe('23514')
    expect(s.writes).toEqual([])           // never reached the stand-in
    expect(db.refused.length).toBeGreaterThan(0)
  })

  it('Done says it did not save when the date did not land (no row matched)', async () => {
    const { markReviewed } = await import('@/lib/mailchimp-overview')
    const s = standIn({ locations: [] })
    expect(await markReviewed(LOC, { db: enforceRealRules(s.db) })).toBe(false)
  })

  it('a review choice the screen saves is accepted by the real rules', () => {
    for (const row of [
      { location_id: LOC, scope: 'group', key: 'archived', choice: 'in', chosen_by: 'u1', chosen_at: '2026-11-26T15:00:00Z' },
      { location_id: LOC, scope: 'person', key: 'ann@x.com', choice: 'out', chosen_by: 'u1', chosen_at: '2026-11-26T15:00:00Z' },
      { location_id: LOC, scope: 'phone', key: '123|ann@x.com', choice: 'same', chosen_by: 'u1', chosen_at: '2026-11-26T15:00:00Z' },
    ]) expect(rowProblems('mailchimp_review_choices', row, 'upsert'), JSON.stringify(row)).toEqual([])
  })
})
