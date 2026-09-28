// @vitest-environment node
// No literal asterisks in client email copy.
//
// Client emails go out as plain paragraphs — bodyToHtml (lib/drip-send.ts) and
// the branded drip layout (lib/drip-email-layout.ts) linkify but have no
// Markdown step — so "**Be sure to check out our Google Reviews!**" reached
// clients with the asterisks showing, on the first email a new lead gets,
// from mid-July to 2026-09-27. It came from the seed file. Kevin's call: strip
// the asterisks (migrations/strip_google_reviews_asterisks.sql for the live
// rows, the seed file here), consider bold rendering later.
//
// If bold rendering is ever added, this guard is the thing to revisit — not
// to delete: it would then pin whichever emphasis syntax the renderer uses.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(__dirname, '..', 'migrations')
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8')

// Email copy in migrations is dollar-quoted as $tpl$…$tpl$ (bodies). Subjects
// are plain single-quoted literals on the line(s) before, so the SEED is also
// checked whole, minus SQL comments.
function asterisksInCopy(sql: string): string[] {
  const hits: string[] = []
  for (const m of sql.matchAll(/\$tpl\$([\s\S]*?)\$tpl\$/g)) {
    for (const line of m[1].split('\n')) if (line.includes('*')) hits.push(line)
  }
  return hits
}

function asteriskLinesOutsideComments(sql: string): string[] {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--') && l.includes('*'))
}

describe('the seed file carries no asterisks', () => {
  const seed = read('seed_master_drip_paths.sql')

  it('no email body in seed_master_drip_paths.sql has an asterisk', () => {
    expect(asterisksInCopy(seed)).toEqual([])
  })

  it('and none anywhere outside a comment — subjects, names, anything', () => {
    expect(asteriskLinesOutsideComments(seed)).toEqual([])
  })

  it('the Google Reviews line is still there, words and link intact — only the ** went', () => {
    expect(seed).toContain('\n\nBe sure to check out our Google Reviews! ({{reviews_link}})$tpl$')
  })
})

describe('no migration seeds email copy with an asterisk', () => {
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))) {
    it(f, () => {
      expect(asterisksInCopy(read(f))).toEqual([])
    })
  }
})

describe('the check catches a template that has them', () => {
  it('flags the exact line that went out for two months', () => {
    const bad = `INSERT INTO drip_path_steps (subject, body) VALUES ('Hi', $tpl$Thank you,

{{owner_name}}

**Be sure to check out our Google Reviews!** ({{reviews_link}})$tpl$);`
    expect(asterisksInCopy(bad)).toEqual(['**Be sure to check out our Google Reviews!** ({{reviews_link}})'])
  })

  it('flags single-asterisk italics too', () => {
    expect(asterisksInCopy('$tpl$help you *Simplify Your Hive!*$tpl$')).toHaveLength(1)
  })

  it('flags an asterisk in a seed subject, outside the body', () => {
    expect(asteriskLinesOutsideComments(`('x', '**Big news**',\n $tpl$fine$tpl$)`)).toHaveLength(1)
  })

  it('does not flag asterisks that live only in SQL comments', () => {
    const commented = `-- no ** or * emphasis here\n$tpl$clean$tpl$`
    expect(asterisksInCopy(commented)).toEqual([])
    expect(asteriskLinesOutsideComments(commented)).toEqual([])
  })
})
