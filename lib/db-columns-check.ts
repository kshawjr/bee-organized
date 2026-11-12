// lib/db-columns-check.ts
// ─────────────────────────────────────────────────────────────
// "Does this select name only columns the real table has?"
//
// WHY. On 2026-11-12 the job-channels code shipped selecting
// engagements.client_name — a column that does not exist. Postgres fails the
// WHOLE read for one bad column, so the Bees cell vanished and the sweep
// failed every 15 minutes. 117 tests had passed: every stand-in database in
// the suite hands back whatever rows a test seeds, with whatever keys the
// test gave them, and ignores the column list it is asked for. The test
// seeded an engagement WITH a client_name, the code asked for it, the
// stand-in obliged. Nothing in the suite knew what the real table looks like.
//
// This file is that knowledge: lib/db-columns.snapshot.txt is the real
// public schema (one line per table or view: `table:col,col,…`), and the
// helpers here hold a select — or a seeded test row — to it.
//
// THE SNAPSHOT IS A COPY, and a copy goes stale. After any migration that
// adds, renames or drops a column, regenerate it (read-only) and commit:
//
//   select string_agg(table_name || ':' || cols, E'\n' order by table_name)
//   from (select table_name,
//                string_agg(column_name, ',' order by ordinal_position) as cols
//         from information_schema.columns
//         where table_schema = 'public' group by table_name) t;
//
// A column a migration has not added YET is not in the snapshot, so code
// that selects it fails lib/beta-db-columns.test.ts until the migration has
// run and the snapshot is refreshed. That is the point: code may not get
// ahead of the database without someone deciding it may (see the test's
// PENDING list for the deliberate, error-tolerant cases).
//
// Used by tests only. Pure apart from reading the snapshot file.
// ─────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let cache: Map<string, Set<string>> | null = null

export function realSchema(): Map<string, Set<string>> {
  if (cache) return cache
  const text = readFileSync(join(process.cwd(), 'lib/db-columns.snapshot.txt'), 'utf8')
  cache = new Map()
  for (const line of text.split('\n')) {
    const at = line.indexOf(':')
    if (at < 1) continue
    cache.set(line.slice(0, at), new Set(line.slice(at + 1).split(',').map(s => s.trim()).filter(Boolean)))
  }
  return cache
}

// Split on commas that are not inside parentheses.
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map(x => x.trim()).filter(Boolean)
}

export type SelectProblem = { table: string; column: string }

/**
 * The columns in a PostgREST select string that the real `table` does not
 * have. Understands `*`, `alias:col`, `col::cast`, `col->json`, `col.count()`
 * style aggregates, and embedded relations `rel(cols)`, `alias:rel(cols)`,
 * `rel!hint(cols)`, `rel!inner(cols)` — whose inner list is checked against
 * `rel` when the snapshot knows that table.
 */
export function unknownColumns(table: string, select: string): SelectProblem[] {
  const schema = realSchema()
  const cols = schema.get(table)
  const out: SelectProblem[] = []
  if (!cols) return out // not a table we know (a storage bucket, say) — the caller decides
  for (const part of splitTop(select)) {
    if (part === '*') continue
    const open = part.indexOf('(')
    if (open >= 0 && part.endsWith(')')) {
      // An embed: [alias:]rel[!hint](inner)
      let head = part.slice(0, open).trim()
      const inner = part.slice(open + 1, -1)
      if (head.includes(':')) head = head.slice(head.indexOf(':') + 1).trim()
      const rel = head.split('!')[0].trim()
      if (rel === 'count' || rel === '') continue
      if (schema.has(rel)) out.push(...unknownColumns(rel, inner))
      continue
    }
    let col = part
    if (col.includes(':') && !col.includes('::')) col = col.slice(col.indexOf(':') + 1)
    else if (/^[a-z_][a-z0-9_]*:[a-z_]/i.test(col) && col.includes('::')) col = col.replace(/^[a-z_][a-z0-9_]*:(?!:)/i, '')
    col = col.split('::')[0].split('->')[0].split('.')[0].trim()
    if (!col || col === '*' || col === 'count') continue
    if (!/^[a-z_][a-z0-9_]*$/i.test(col)) continue // not a plain identifier — nothing to check
    if (!cols.has(col)) out.push({ table, column: col })
  }
  return out
}

/** Keys on a (seeded, inserted or updated) row that are not real columns. */
export function unknownKeys(table: string, row: Record<string, unknown> | null | undefined): string[] {
  const cols = realSchema().get(table)
  if (!cols || !row) return []
  return Object.keys(row).filter(k => !cols.has(k))
}

/** The error Postgres gives for a column that does not exist — same shape, same code. */
export const missingColumnError = (table: string, column: string) =>
  ({ code: '42703', message: `column ${table}.${column} does not exist` })
