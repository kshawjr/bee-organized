// migrations/network_types_fix_26.sql, read as text (the full proof is the dry
// run on a copy of production:
// ~/Projects/bee-organized-repair-reports/2026-11-19/network-types-fix-26.md).
// What this pins:
//   · its mapping is the slice 2 backfill's, byte for byte (nothing new decided)
//   · it touches exactly the 26 ids, only while still empty, so a second run
//     fills nothing and a contact made later is not touched
//   · it writes network_types, partner_level, partner_stage and nothing else
//   · the undo names the same 26 and nothing else
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const fix = read('migrations/network_types_fix_26.sql')
const undo = read('migrations/network_types_fix_26_undo.sql')
const backfill = read('migrations/network_model_backfill.sql')
const mapping = (s: string) => s.slice(s.indexOf('-- MAPPING BEGIN'), s.indexOf('-- MAPPING END'))
const ids = (s: string) => Array.from(s.slice(s.lastIndexOf('id in (')).matchAll(/'([0-9a-f-]{36})'/g)).map((m) => m[1])
const code = fix.replace(/--.*$/gm, '')

describe('the fix for the 26', () => {
  it('maps exactly as the slice 2 backfill did, byte for byte', () => {
    expect(mapping(fix).length).toBeGreaterThan(1000)
    expect(mapping(fix)).toBe(mapping(backfill))
  })
  it('names 26 distinct contacts, and the undo names the same 26', () => {
    expect(new Set(ids(fix)).size).toBe(26)
    expect(ids(fix)).toHaveLength(26)
    expect(ids(undo).sort()).toEqual(ids(fix).sort())
  })
  it('fills only while still empty, so a second run fills nothing', () => {
    expect(code).toMatch(/and p\.network_types is null\s+and p\.id in \(/)
  })
  it('writes the three model columns and nothing else, in one statement', () => {
    const set = code.match(/update public\.partners p\s+set ([\s\S]*?)\nfrom mapped m/)![1]!
    expect(Array.from(set.matchAll(/(\w+)\s*=/g)).map((m) => m[1])).toEqual(['network_types', 'partner_level', 'partner_stage'])
    expect(code.trim().split(';').filter((s) => s.trim())).toHaveLength(1)
  })
})
