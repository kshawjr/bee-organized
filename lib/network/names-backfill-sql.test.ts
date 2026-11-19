// migrations/network_names_backfill.sql, read as text (the database cannot run
// here; the full proof is the dry run on a copy of production:
// ~/Projects/bee-organized-repair-reports/2026-11-19/network-names-dry-run.md).
// What this pins in the statement itself:
//   · the seven businesses typed as a person are held out by id, every one
//   · it only fills rows whose first AND last are both blank (so a second run
//     fills nothing, and an owner's own edit is never overwritten)
//   · it writes first_name and last_name and nothing else (name untouched)
//   · it is one statement, and it skips the recycle bin, organizations,
//     joint names and anything not exactly two words
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sql = readFileSync(join(process.cwd(), 'migrations/network_names_backfill.sql'), 'utf8')
// comments taken out, whole-line and end-of-line
const code = sql.replace(/--.*$/gm, '')

const BUSINESSES: Record<string, string> = {
  '956ec9c1-fd6e-497c-97ec-cf7d45347993': 'Advanced Moving',
  'bae2cb47-5b5a-42ad-93c1-4d755099a5b5': 'Concept Cleaning',
  'b8c284dd-2d40-4f84-8669-1fbe3f2c7dad': 'Honor Floral',
  '210f2577-49ac-449c-bd07-8bc36ddecffb': 'Infinity Impressions',
  'e4b4f98a-8fe7-4446-8f85-85441eba95e1': 'Imagine Housing',
  '7c294181-26f0-4df4-a846-7637b05312d4': 'Graceful Compass',
  'cb654cc4-84d1-4ddd-b714-f388d9fb8630': 'College Hunks',
  // not a business, but held by Kevin's ruling (most likely the branded van)
  'c77409ca-dee0-4083-bafb-94b287b3ecf5': 'Bee Van',
}

describe('the names backfill statement', () => {
  it('holds out all eight, by id: seven businesses typed as a person, and Bee Van', () => {
    const held = code.match(/p\.id not in \(([^)]*)\)/)
    expect(held).not.toBeNull()
    const ids = Array.from(held![1]!.matchAll(/'([0-9a-f-]{36})'/g)).map((m) => m[1])
    expect(ids.sort()).toEqual(Object.keys(BUSINESSES).sort())
  })

  it('fills only rows whose first and last name are both still blank', () => {
    expect(code).toMatch(/and p\.first_name is null\s+and p\.last_name is null/)
  })

  it('writes first_name and last_name and nothing else', () => {
    const set = code.match(/set ([\s\S]*?)\nfrom/)![1]!
    expect(Array.from(set.matchAll(/(\w+)\s*=/g)).map((m) => m[1])).toEqual(['first_name', 'last_name'])
  })

  it('is one statement, live contacts only, exactly two words, no organizations or joint names', () => {
    expect(code.trim().split(';').filter((s) => s.trim())).toHaveLength(1)
    expect(code).toMatch(/p\.deleted_at is null/)
    expect(code).toMatch(/array_length\(s\.parts, 1\) = 2/)
    expect(code).toMatch(/not coalesce\('organization' = any \(p\.network_types\), false\)/)
    expect(code).toMatch(/p\.name !~ '\[&\+\/\]'/)
  })
})
