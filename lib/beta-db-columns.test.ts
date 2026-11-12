// @vitest-environment node
//
// EVERY COLUMN THE APP ASKS THE DATABASE FOR MUST EXIST.
//
// 2026-11-12: job channels shipped selecting engagements.client_name. There is
// no such column (the engagement has client_id; the name is on the lead).
// Postgres fails the whole read for one bad column, so in production the
// Bees cell never rendered and the sweep logged
//   "column engagements.client_name does not exist"
// every 15 minutes. Every test had passed, because the stand-in databases in
// this suite hand back whatever a test seeds and never look at the column
// list — the test seeded an engagement that HAD a client_name.
//
// So this does not go through any stand-in. It reads the app's SOURCE, finds
// every `.from('<table>') … .select(<columns>)` and every filter or sort on
// that chain, and checks each column against lib/db-columns.snapshot.txt —
// the real production schema (how to refresh it: lib/db-columns-check.ts).
//
// A select whose column list cannot be worked out from the source is not
// skipped in silence: it is on the ACKNOWLEDGED list below, and a new one
// fails this file until someone looks at it and adds it by hand.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSelects, findFilters, sourceFiles } from '@/lib/db-select-scan'
import { realSchema, unknownColumns, unknownKeys } from '@/lib/db-columns-check'

const ROOTS = ['app', 'lib', 'components', 'scripts', 'middleware.ts']
// The scan helpers and the snapshot's own docs name columns as examples.
const NOT_APP_CODE = new Set(['lib/db-select-scan.ts', 'lib/db-columns-check.ts'])
const files = sourceFiles(ROOTS).filter(f => !NOT_APP_CODE.has(f))
const schema = realSchema()
const selects = findSelects(files).filter(s => schema.has(s.table))
const filters = findFilters(files).filter(f => schema.has(f.table))

// ── Columns the code names that the database does not have — ON PURPOSE ──
// Each is a read written to survive the column being absent (its own query,
// error → a safe default), waiting on a migration Kevin has not run. When the
// migration runs: refresh the snapshot and delete the line. A line here whose
// column now EXISTS, or that the code no longer names, fails the test.
const PENDING: Record<string, string> = {
  'lib/email-signature-resolve.ts hub_users.signature_linkedin_url':
    'migrations/signature_linkedin.sql not run; loadPersonLinkedin reads it alone and answers { value: null, ready: false } on the error',
}

// ── Known faults, found by this test the day it was written ──────────────
// NOT acceptable, NOT fixed here (outside the change that added this file),
// reported to Kevin. Listed so the test can be green without hiding them;
// fixing one means deleting its line.
const KNOWN_FAULTS: Record<string, string> = {
  'app/api/admin/conversions-due/route.ts hub_users.is_primary_owner':
    'no such column: the owner lookup fails whole and is ignored, so that screen resolves no owner names (reported 2026-11-12)',
}

// ── Selects whose columns are decided at run time ────────────────────────
// `file table` → how many. The scan cannot read these; each was read by hand
// on 2026-11-12. A NEW one must be read by hand and added.
const ACKNOWLEDGED: Record<string, number> = {
  'app/api/admin/feedback/[id]/route.ts feedback_items': 1,
  'app/api/admin/feedback/route.ts feedback_items': 1,
  'app/api/feedback/[id]/replies/route.ts feedback_items': 1,
  'app/api/feedback/[id]/route.ts feedback_items': 1,
  'app/api/feedback/route.ts feedback_items': 1,
  'app/api/feedback/unread/route.ts feedback_items': 1,
  'app/api/hub_users/me/route.ts hub_users': 1,
  'lib/feedback-brief-data.ts feedback_items': 1,
  'lib/other-card-sync.ts leads': 1,
  'lib/webhook-landed.ts leads': 2,
}

describe('the snapshot is the real schema', () => {
  it('knows the tables this app lives on, and what engagements really has', () => {
    expect(schema.size).toBeGreaterThanOrEqual(70)
    for (const t of ['engagements', 'leads', 'locations', 'hub_users', 'location_bees', 'engagement_bees']) expect(schema.has(t), t).toBe(true)
    const eng = schema.get('engagements')!
    expect(eng.has('client_id')).toBe(true)
    expect(eng.has('client_name')).toBe(false)   // the column that was never there
    expect(schema.get('leads')!.has('name')).toBe(true)
  })
})

describe('every select in the app names only real columns', () => {
  const resolved = selects.filter(s => s.columns !== null)
  const problems = resolved.flatMap(s => unknownColumns(s.table, s.columns!).map(p => `${s.file} ${p.table}.${p.column}`))

  it('the scan is really looking: over a thousand selects, across the app', () => {
    expect(resolved.length).toBeGreaterThan(1000)
    expect(new Set(resolved.map(s => s.file)).size).toBeGreaterThan(150)
  })

  it('no select asks for a column its table does not have', () => {
    const allowed = new Set([...Object.keys(PENDING), ...Object.keys(KNOWN_FAULTS)])
    const unexpected = Array.from(new Set(problems)).filter(p => !allowed.has(p)).sort()
    expect(unexpected, `\nColumns that do not exist in the real database:\n  ${unexpected.join('\n  ')}\n(If a migration just added one, refresh lib/db-columns.snapshot.txt — see lib/db-columns-check.ts.)\n`).toEqual([])
  })

  it('the PENDING and KNOWN_FAULTS lists carry nothing stale', () => {
    const live = new Set(problems)
    const stale = [...Object.keys(PENDING), ...Object.keys(KNOWN_FAULTS)].filter(k => !live.has(k))
    expect(stale, 'fixed or migrated — delete these lines').toEqual([])
  })

  it('a select the scan cannot read is on the acknowledged list — none slips by unread', () => {
    const counts: Record<string, number> = {}
    for (const s of selects.filter(s => s.columns === null)) counts[`${s.file} ${s.table}`] = (counts[`${s.file} ${s.table}`] || 0) + 1
    expect(counts).toEqual(ACKNOWLEDGED)
  })
})

describe('every filter and sort names only real columns', () => {
  it('the scan is really looking', () => {
    expect(filters.length).toBeGreaterThan(1500)
  })

  it('no .eq / .is / .not / .in / .order … names a column its table does not have', () => {
    const bad = Array.from(new Set(filters.filter(f => !schema.get(f.table)!.has(f.column)).map(f => `${f.file} ${f.table}.${f.column} (.${f.method})`))).sort()
    expect(bad, `\nFilters on columns that do not exist:\n  ${bad.join('\n  ')}\n`).toEqual([])
  })
})

describe('the job-channels code, by name — the code that shipped the fault', () => {
  const JOB_FILES = [
    'lib/engagement-bees.ts', 'lib/engagement-bees-gate.ts', 'lib/location-bees.ts', 'lib/slack-scopes-server.ts',
    'app/api/engagements/[id]/bees/route.ts', 'app/api/engagements/[id]/slack-channel/route.ts',
    'app/api/locations/[id]/bees/route.ts', 'app/api/locations/[id]/bees/[beeId]/route.ts',
    'app/api/cron/job-channels/route.ts', 'app/api/slack/callback/route.ts',
  ]
  const mine = selects.filter(s => JOB_FILES.includes(s.file))

  it('every one of its selects could be read, and every column in them is real', () => {
    expect(mine.length).toBeGreaterThanOrEqual(20)
    expect(mine.filter(s => s.columns === null).map(s => `${s.file}:${s.line} ${s.expr}`)).toEqual([])
    expect(mine.flatMap(s => unknownColumns(s.table, s.columns!).map(p => `${s.file}:${s.line} ${p.table}.${p.column}`))).toEqual([])
  })

  it('it reads engagements — the table it got wrong — and never asks it for a client name', () => {
    const eng = mine.filter(s => s.table === 'engagements')
    expect(eng.length).toBeGreaterThanOrEqual(3)        // the panel read, its fallback, and the sweep
    for (const s of eng) expect(s.columns, `${s.file}:${s.line}`).not.toMatch(/client_name/)
    // The name comes from the lead.
    expect(mine.some(s => s.file === 'lib/engagement-bees.ts' && s.table === 'leads' && s.columns === 'name')).toBe(true)
  })
})

describe('the check itself', () => {
  it('flags the exact fault: engagements.client_name, alone or among real columns', () => {
    expect(unknownColumns('engagements', 'id, location_uuid, client_id, client_name, project_type, closed_at'))
      .toEqual([{ table: 'engagements', column: 'client_name' }])
    expect(unknownColumns('engagements', 'id, location_uuid, client_id, project_type, closed_at')).toEqual([])
  })

  it('reads aliases, casts, json paths, * and embedded tables', () => {
    expect(unknownColumns('leads', '*')).toEqual([])
    expect(unknownColumns('leads', 'id, who:name, created_at::date, metadata->source')).toEqual([])
    expect(unknownColumns('leads', 'id, who:nickname')).toEqual([{ table: 'leads', column: 'nickname' }])
    expect(unknownColumns('engagements', 'id, leads(name, email)')).toEqual([])
    expect(unknownColumns('engagements', 'id, client:leads!inner(name, nickname)')).toEqual([{ table: 'leads', column: 'nickname' }])
  })

  it('a seeded test row with a made-up key is caught too (unknownKeys)', () => {
    expect(unknownKeys('engagements', { id: 'e', client_id: 'l', client_name: 'Sarah' })).toEqual(['client_name'])
    expect(unknownKeys('engagements', { id: 'e', client_id: 'l', project_type: 'Pantry' })).toEqual([])
  })

  // The fault was not a literal. It was a constant, joined to another inside
  // a template: `${ENG_BASE}, ${ENG_CHANNEL}`. The scan has to see through
  // that — and through a constant imported from another file.
  it('the scan sees through constants and templates — the shape the fault was written in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bee-scan-'))
    try {
      writeFileSync(join(dir, 'cols.ts'), `export const SHARED_COLS =\n  'id, name'\n`)
      writeFileSync(join(dir, 'code.ts'), [
        `import { SHARED_COLS } from './cols'`,
        `const ENG_BASE = 'id, location_uuid, client_id, client_name, project_type, closed_at'`,
        `const ENG_CHANNEL = 'slack_channel_id, slack_channel_name'`,
        `export async function a(db: any, id: string) {`,
        `  let { data } = await db.from('engagements').select(\`\${ENG_BASE}, \${ENG_CHANNEL}\`).eq('id', id).maybeSingle()`,
        `  const cols = 'id, client_name, closed_at'`,
        `  await db.from('engagements').select(cols)`,
        `    .not('slack_channel_id', 'is', null).is('closed_on', null)`,
        `  await db.from('leads').select(SHARED_COLS).eq('id', id)`,
        `  return data`,
        `}`,
      ].join('\n'))
      const found = findSelects([join(dir, 'code.ts')])
      expect(found.map(s => s.columns)).toEqual([
        'id, location_uuid, client_id, client_name, project_type, closed_at, slack_channel_id, slack_channel_name',
        'id, client_name, closed_at',
        'id, name',
      ])
      expect(found.flatMap(s => unknownColumns(s.table, s.columns!)).map(p => `${p.table}.${p.column}`))
        .toEqual(['engagements.client_name', 'engagements.client_name'])
      const f = findFilters([join(dir, 'code.ts')])
      expect(f.map(x => `${x.table}.${x.column}`)).toEqual(['engagements.id', 'engagements.slack_channel_id', 'engagements.closed_on', 'leads.id'])
      expect(f.filter(x => !schema.get(x.table)!.has(x.column)).map(x => x.column)).toEqual(['closed_on'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
