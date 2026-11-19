// @vitest-environment node
//
// Network & Nurture, slice 2 — the migration, the backfill and their undos.
//
// These files are run BY HAND, by Kevin, against real owners' contacts, and
// no test here can run SQL. So this file holds them still instead:
//
//   · it reads the SQL as text and refuses anything but what was reviewed:
//     the migration only ADDS, the backfill writes three columns on one
//     table, the undos remove only what was added;
//   · it holds the SQL rules and the TypeScript rules (lib/network/
//     live-mapping.ts) to the same answer. The SQL's answers were captured by
//     running the real MAPPING block — over every row in production (269, on
//     a scratch copy whose fingerprints equal production's) and over a
//     made-up grid of every combination — and are in
//     __fixtures__/live-mapping-sql.json. Change either set of rules and
//     this fails until the other is changed and the answers re-captured;
//   · it checks Network is still closed and nothing live reads the new
//     columns.
//
// What was proved once by running, and is recorded rather than re-run here
// (the proof script and its 41 results are beside the dry-run report in
// ~/Projects/bee-organized-repair-reports/2026-11-15/): every old column on
// every row unchanged after the backfill; a second backfill changes 0 rows;
// both undos return the table to where it started; nothing outside partners
// is written.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RULED_NOT_SURE_IDS, mapLivePartner, summarizeMapping } from './live-mapping'
import { NET_TYPES, PARTNER_LEVELS, PARTNER_STAGES } from './types'
import fixture from './__fixtures__/live-mapping-sql.json'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** The SQL with its comments taken out, so words in the notes are never mistaken for statements. */
const code = (p: string) => read(p).split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
const statements = (p: string) => code(p).split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
const mappingBlock = (p: string) => {
  const parts = read(p).split('-- MAPPING BEGIN')
  expect(parts, `${p} has one MAPPING block`).toHaveLength(2)
  return parts[1]!.split('-- MAPPING END')[0]!
}
const quoted = (s: string) => Array.from(s.matchAll(/'([^']*)'/g)).map((m) => m[1]!)

const NEW_COLUMNS = ['network_types', 'partner_level', 'partner_stage', 'birthday', 'birthday_reminder']
const NEW_RULES = [
  'partners_network_types_check', 'partners_partner_level_check', 'partners_partner_stage_check',
  'partners_birthday_check', 'partners_birthday_reminder_check',
]
const OLD_COLUMNS = [
  'id', 'location_id', 'type', 'name', 'email', 'phone', 'company_id', 'stage', 'specialties', 'tier', 'tags',
  'addresses', 'notes', 'next_steps', 'referrals', 'activity', 'deleted_at', 'created_at', 'updated_at', 'created_by',
  'title', 'company', 'website', 'how_we_met', 'met_date', 'last_contact', 'is_customer', 'relationship', 'card_image',
  'customer_lead_id', 'last_contacted_at',
]
// Any word that changes data or structure. Checked against comment-free SQL.
const WRITES = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|merge|copy|call|do)\b/gi

const COLUMNS = 'migrations/network_model_columns.sql'
const COLUMNS_UNDO = 'migrations/network_model_columns_undo.sql'
const BACKFILL = 'migrations/network_model_backfill.sql'
const BACKFILL_UNDO = 'migrations/network_model_backfill_undo.sql'
const CHECK = 'migrations/network_model_check.sql'

describe('Step 1, the migration: it only adds', () => {
  const all = statements(COLUMNS)

  it('every statement is an ALTER of public.partners and nothing else', () => {
    expect(all.length).toBeGreaterThan(0)
    for (const s of all) expect(s, s).toMatch(/^alter table public\.partners (add column if not exists|drop constraint if exists|add constraint) /)
  })
  it('adds exactly the five new columns, each only if it is not there', () => {
    const added = all.filter((s) => s.includes(' add column ')).map((s) => s.match(/add column if not exists (\w+)/)![1])
    expect(added).toEqual(NEW_COLUMNS)
  })
  it('gives them the reviewed types, and only the reminder a default', () => {
    const def = (col: string) => all.find((s) => s.includes(`add column if not exists ${col} `))!.split(`${col} `)[1]
    expect(def('network_types')).toBe('text[]')
    expect(def('partner_level')).toBe('text')
    expect(def('partner_stage')).toBe('text')
    expect(def('birthday')).toBe('text')
    expect(def('birthday_reminder')).toBe('boolean not null default false')
  })
  it('never drops, renames or alters a column, and never touches a row', () => {
    const text = all.join(' ; ')
    expect(text).not.toMatch(/drop column|rename|alter column|set data type|set default|drop default|set not null|drop not null/i)
    expect(text).not.toMatch(/\b(insert|update|delete|truncate|create|drop table)\b/i)
  })
  it('names no existing column as something to change', () => {
    for (const s of all.filter((x) => x.includes(' add column '))) {
      for (const old of OLD_COLUMNS) expect(s, s).not.toMatch(new RegExp(`add column if not exists ${old}\\b`))
    }
  })
  it('puts on exactly the five new rules, each taken off first so a second run leaves one', () => {
    const dropped = all.filter((s) => s.includes(' drop constraint ')).map((s) => s.match(/drop constraint if exists (\w+)/)![1])
    const added = all.filter((s) => s.includes(' add constraint ')).map((s) => s.match(/add constraint (\w+)/)![1])
    expect(added).toEqual(NEW_RULES)
    expect(dropped).toEqual(NEW_RULES)
    for (const name of NEW_RULES) {
      const off = all.findIndex((s) => s.includes(`drop constraint if exists ${name}`))
      const on = all.findIndex((s) => s.includes(`add constraint ${name} `))
      expect(off, name).toBeLessThan(on)
    }
  })
  it('never takes off a rule the table already has', () => {
    expect(all.join(' ')).not.toMatch(/partners_type_check|partners_pkey|_fkey/)
  })
  it('has no separate potential-partner column: Potential is a level', () => {
    expect(code(COLUMNS)).not.toMatch(/potential_partner/)
    expect(all.find((s) => s.includes('add constraint partners_partner_level_check'))).toContain("'potential'")
  })
  it("allows exactly Kevin's five types, three levels and five stages, as lib/network/types.ts spells them", () => {
    const rule = (name: string) => all.find((s) => s.includes(`add constraint ${name} `))!
    expect(quoted(rule('partners_network_types_check'))).toEqual([...NET_TYPES])
    expect(quoted(rule('partners_partner_level_check'))).toEqual([...PARTNER_LEVELS, 'partner'])
    expect(quoted(rule('partners_partner_stage_check'))).toEqual([...PARTNER_STAGES, 'partner'])
  })
  it('lets only a Referral partner hold a level or a stage', () => {
    for (const name of ['partners_partner_level_check', 'partners_partner_stage_check']) {
      expect(all.find((s) => s.includes(`add constraint ${name} `))).toContain("network_types is not null and 'partner' = any (network_types)")
    }
  })
})

describe('Step 2, the backfill: three columns, one table, empty rows only', () => {
  const all = statements(BACKFILL)

  it('is one statement', () => {
    expect(all).toHaveLength(1)
  })
  it('writes once, to public.partners', () => {
    const writes = all[0]!.match(WRITES)!.map((w) => w.toLowerCase())
    expect(writes).toEqual(['update'])
    expect(all[0]).toMatch(/update public\.partners p set /)
  })
  it('sets exactly network_types, partner_level and partner_stage', () => {
    const set = all[0]!.split(/update public\.partners p set /)[1]!.split(/ from mapped m /)[0]!
    expect(set.split(',').map((s) => s.trim().split(' = ')[0])).toEqual(['network_types', 'partner_level', 'partner_stage'])
    for (const old of OLD_COLUMNS) expect(set, old).not.toMatch(new RegExp(`\\b${old}\\s*=`))
  })
  it('fills only rows that have no type yet, which is what makes a second run do nothing', () => {
    expect(all[0]!.endsWith('where m.id = p.id and p.network_types is null')).toBe(true)
  })
  it('reads only partners, their tags, the tag list and the referred-by link', () => {
    const tables = Array.from(new Set(Array.from(all[0]!.matchAll(/public\.(\w+)/g)).map((m) => m[1]))).sort()
    expect(tables).toEqual(['leads', 'lookups', 'partner_tags', 'partners'])
  })
  it('never guesses from a trade tag: the only tag names it knows are Partner, Referral and Vendor', () => {
    const block = mappingBlock(BACKFILL).split('\n').filter((l) => l.includes('lk.label')).join(' ')
    expect(quoted(block).filter((q) => /^[a-z]+$/.test(q))).toEqual(['partner', 'referral', 'vendor'])
  })
})

describe('The check query: read-only', () => {
  it('is one SELECT with no word that writes', () => {
    const all = statements(CHECK)
    expect(all).toHaveLength(1)
    expect(all[0]!.match(WRITES)).toBeNull()
    expect(all[0]).toMatch(/^with /)
  })
  it('works the mapping out with the very same text the backfill runs', () => {
    expect(mappingBlock(CHECK)).toBe(mappingBlock(BACKFILL))
  })
  it('fingerprints all 31 existing columns, and only those', () => {
    const row = code(CHECK).split('md5(row(')[1]!.split(')::text)')[0]!
    const named = Array.from(row.matchAll(/p\.(\w+)/g)).map((m) => m[1])
    expect(named).toEqual(OLD_COLUMNS)
  })
})

describe('The SQL rules and the TypeScript rules give the same answer', () => {
  const answer = (m: ReturnType<typeof mapLivePartner>) => `${m.types.join('+')}|${m.level ?? ''}|${m.stage ?? ''}`
  // A shape marked `ruled` is one of the four contacts held by id (rule 6). The
  // fixture carries no ids, so any one of the four stands in: the rule is the
  // same for each.
  type Shape = (typeof fixture.shapes)[number]
  const factsOf = (s: Shape) => ({
    id: s.ruled ? RULED_NOT_SURE_IDS[0] : null, tier: s.tier, stage: s.stage, tagLabels: s.tags, hasSentLead: s.sent,
  })

  it('the SQL in the backfill is the SQL the answers were captured from', () => {
    expect(sha256(mappingBlock(BACKFILL))).toBe(fixture.mappingBlockSha256)
  })
  it('on every shape of contact in production: all 269 rows, 263 of them live', () => {
    let rows = 0
    let live = 0
    for (const s of fixture.shapes) {
      const ts = mapLivePartner(factsOf(s))
      expect({ types: ts.types, level: ts.level, stage: ts.stage }, JSON.stringify(s))
        .toEqual({ types: s.types, level: s.level, stage: s.stage_out })
      rows += s.live + s.binned
      live += s.live
    }
    expect([rows, live]).toEqual([269, 263])
    expect([fixture.rows, fixture.live]).toEqual([269, 263])
  })
  it('which, counted by the TypeScript rules, is 51 Referral partners (6 also Vendor), 15 Vendor only, 197 Not sure yet', () => {
    const live = fixture.shapes.flatMap((s) => Array.from({ length: s.live }, () => factsOf(s)))
    const sum = summarizeMapping(live)
    expect([sum.total, sum.referralPartner, sum.referralAndVendor, sum.vendorOnly, sum.notSure, sum.ruledNotSure]).toEqual([263, 51, 6, 15, 197, 4])
  })
  it('the four contacts Kevin ruled on are the same four ids in the SQL and in the TypeScript', () => {
    const inSql = Array.from(mappingBlock(BACKFILL).matchAll(/'([0-9a-f]{8}-[0-9a-f-]{27})'/g)).map((m) => m[1])
    expect(inSql).toEqual([...RULED_NOT_SURE_IDS])
    expect(fixture.shapes.filter((s) => s.ruled).reduce((n, s) => n + s.live + s.binned, 0)).toBe(4)
  })
  it('and each of the four is Not sure yet in both, even given a Power tier, both tags and a sent lead', () => {
    const f = fixture.ruled.facts
    expect(fixture.ruled.answers.map((a) => a.id)).toEqual([...RULED_NOT_SURE_IDS])
    for (const a of fixture.ruled.answers) {
      expect(a.a, a.id).toBe('unsure||')
      expect(answer(mapLivePartner({ id: a.id, tier: f.tier, stage: f.stage, tagLabels: f.tags, hasSentLead: f.sent })), a.id).toBe(a.a)
    }
  })
  it('on a made-up grid of every tier, stage, tag set and sent-a-lead: 1,728 combinations', () => {
    const g = fixture.grid
    let n = 0
    const wrong: string[] = []
    for (const tier of g.tiers) for (const stage of g.stages) for (const tags of g.tagSets) for (const sent of g.sent) {
      const ts = answer(mapLivePartner({ tier, stage, tagLabels: tags, hasSentLead: sent }))
      if (ts !== g.answers[n]) wrong.push(`${JSON.stringify({ tier, stage, tags, sent })}: TypeScript ${ts}, SQL ${g.answers[n]}`)
      n++
    }
    expect(n).toBe(1728)
    expect(g.answers).toHaveLength(1728)
    expect(wrong).toEqual([])
  })
  it('the grid reaches every level and stage the rules can give', () => {
    const answers = fixture.grid.answers
    for (const stage of PARTNER_STAGES) expect(answers.some((a) => a.endsWith(`|${stage}`)), stage).toBe(true)
    expect(answers.some((a) => a.includes('|power|'))).toBe(true)
    expect(answers.some((a) => a.startsWith('partner+vendor|'))).toBe(true)
    expect(answers).toContain('vendor||')
    expect(answers).toContain('unsure||')
  })
})

describe('The undos take back only what was added', () => {
  it('the full undo drops the five rules and the five columns, each only if it is there, and nothing else', () => {
    const all = statements(COLUMNS_UNDO)
    const rules = all.filter((s) => s.includes(' drop constraint ')).map((s) => s.match(/^alter table public\.partners drop constraint if exists (\w+)$/)![1])
    const cols = all.filter((s) => s.includes(' drop column ')).map((s) => s.match(/^alter table public\.partners drop column if exists (\w+)$/)![1])
    expect(rules.slice().sort()).toEqual(NEW_RULES.slice().sort())
    expect(cols.slice().sort()).toEqual(NEW_COLUMNS.slice().sort())
    expect(all).toHaveLength(10)
    for (const old of OLD_COLUMNS) expect(cols).not.toContain(old)
  })
  it('the backfill undo is one UPDATE of public.partners that empties the three mapped columns only', () => {
    const all = statements(BACKFILL_UNDO)
    expect(all).toHaveLength(1)
    expect(all[0]!.match(WRITES)!.map((w) => w.toLowerCase())).toEqual(['update'])
    const set = all[0]!.split(/^update public\.partners set /)[1]!.split(' where ')[0]!
    expect(set.split(',').map((s) => s.trim())).toEqual(['network_types = null', 'partner_level = null', 'partner_stage = null'])
    expect(Array.from(new Set(Array.from(all[0]!.matchAll(/public\.(\w+)/g)).map((m) => m[1])))).toEqual(['partners'])
  })
})

describe('The column snapshot', () => {
  it('keeps the 31 existing partners columns in their order and adds the five new ones after them', () => {
    const line = read('lib/db-columns.snapshot.txt').split('\n').find((l) => l.startsWith('partners:'))!
    // ...then first_name and last_name (migrations/network_names_columns.sql, run 2026-11-19)
    expect(line.slice('partners:'.length).split(',')).toEqual([...OLD_COLUMNS, ...NEW_COLUMNS, 'first_name', 'last_name'])
  })
})

describe('Network is still closed, and nothing live reads the new columns', () => {
  const beeHub = read('components/BeeHub.jsx')

  it('the closed-sections block is byte-for-byte what it was before this slice', () => {
    const block = beeHub.match(/const CLOSED_NAV = \{[\s\S]*?\n  \}\n/)![0]
    expect(sha256(block)).toBe('499e1534747596f88c74af50e409ca483cb641221613a5d126b8ea0bf46ce725')
  })
  it('Network & Nurture is in it, marked Under redesign', () => {
    const lines = beeHub.split('\n').filter((l) => l.trimStart().startsWith('partners:') && l.includes('Under redesign'))
    expect(lines).toHaveLength(1)
    expect(sha256(lines[0]!)).toBe('5457919304c3ea2b38cb67ba7b3391bfdd189773c0dd1cb5ef35d8364a618842')
  })
  it('the menu and the page both still ask that block whether a section is closed', () => {
    // Slice 3: they ask through closedFor(), which is that block with ONE
    // exception — Network, for a viewer lib/network/access.ts says yes to
    // (super admins). lib/network/doors.test.tsx proves every other role
    // still gets the grey, door by door.
    expect(beeHub).toContain("const closedFor = key => (key === 'partners' && networkOpen ? null : (CLOSED_NAV[key] || null))")
    expect(beeHub).toContain('soon: !!closedFor(item.key), note: closedFor(item.key)?.note,')
    expect(beeHub).toContain('if (closedFor(activeNav)) {')
    expect(beeHub).not.toMatch(/CLOSED_NAV\[(?!key\])/)
  })
  it('the live partners read names none of the new columns, so it is the same before and after the migration', () => {
    const cols = read('lib/crm.ts').split('export const PARTNER_COLS =')[1]!.split('export const COMPANY_COLS')[0]!
    for (const c of NEW_COLUMNS) expect(cols, c).not.toContain(c)
    expect(cols).not.toContain('*')
  })
  it('outside the Network code, no screen, route or shared code names a new column', () => {
    // Slice 3 reads them in exactly one place outside lib/network/: the
    // super-admin-only route app/api/network/list (the `network` folders are
    // skipped below). Everything else — every screen an owner can reach, and
    // the old partners read above — still knows nothing of them.
    const SKIP = new Set(['node_modules', '.next', '.git', 'network'])
    const found: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(root, dir))) {
        const p = `${dir}/${name}`
        if (statSync(join(root, p)).isDirectory()) { if (!SKIP.has(name)) walk(p); continue }
        if (!/\.(ts|tsx|js|jsx|mjs)$/.test(name)) continue
        const text = read(p)
        // Whole words only: the lookup lists `partner_stages` and `partner_tiers` are something else.
        // `birthday` alone is an ordinary word, so it is not searched for.
        if (/\b(network_types|partner_level|partner_stage|birthday_reminder)\b/.test(text)) found.push(p)
      }
    }
    for (const dir of ['app', 'components', 'lib']) walk(dir)
    expect(found).toEqual([])
  })
})
