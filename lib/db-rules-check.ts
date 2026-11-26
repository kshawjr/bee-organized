// lib/db-rules-check.ts
// ─────────────────────────────────────────────────────────────
// "Would the REAL database accept this row?"
//
// WHY. On 2026-11-26 Kevin pressed Done on "Who goes to Mailchimp" and step 1
// never ticked. The code wrote a sync_log row with direction 'internal',
// entity_type 'mailchimp_review' and status 'reviewed' — three words sync_log's
// own CHECK rules refuse — so Postgres refused the whole row, every time. The
// first-sync record ('mailchimp_push' / 'complete') was refused the same way.
// Every test had passed: the stand-in databases in the suite accept any row.
// lib/db-columns-check.ts already holds reads to the real COLUMNS; nothing
// held writes to the real RULES.
//
// This file is that: lib/db-rules.snapshot.json is a copy of the real CHECK
// constraints and required (NOT NULL, no default) columns of the tables the
// Mailchimp code writes, and rowProblems() evaluates a row against them the
// way Postgres does — a CHECK fails only when it is definitely FALSE (NULL
// passes). Columns a row does not carry are "not known" and never decide a
// check, so an update patch is judged only on what it writes.
//
// enforceRealRules(db) wraps any stand-in database so its insert / update /
// upsert refuse a row the real database would refuse, with Postgres's code
// (23514 check_violation, 23502 not_null_violation, 42703 undefined_column).
//
// The expression reader understands the shapes these tables use (=, <>, <, >,
// <=, >=, = ANY (ARRAY[…]), IS [NOT] NULL, IS [NOT] DISTINCT FROM, !~~ / ~~,
// AND, OR, NOT, length / lower / btrim / nullif). A rule it cannot read is
// reported by unreadableRules() — a test holds that list empty — never skipped
// in silence.
//
// Used by tests only. Pure apart from reading the two snapshot files.
// ─────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { realSchema } from './db-columns-check'

type Rule = { name: string; def: string }
type Snapshot = { checks: Record<string, Rule[]>; required: Record<string, string[]> }

let cache: Snapshot | null = null
export function realRules(): Snapshot {
  if (cache) return cache
  cache = JSON.parse(readFileSync(join(process.cwd(), 'lib/db-rules.snapshot.json'), 'utf8')) as Snapshot
  return cache
}

// ── The expression reader ─────────────────────────────────────
const UNKNOWN = Symbol('unknown')            // a column the row does not carry
type V = string | number | boolean | null | typeof UNKNOWN | V[]
type Node = (row: Record<string, unknown>) => V

function tokenize(src: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === "'") {
      let j = i + 1, s = ''
      for (;;) {
        if (j >= src.length) throw new Error('unterminated string')
        if (src[j] === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue }
        if (src[j] === "'") break
        s += src[j++]
      }
      out.push("'" + s); i = j + 1; continue
    }
    const two = src.slice(i, i + 3)
    if (two === '!~~') { out.push('!~~'); i += 3; continue }
    const op = src.slice(i, i + 2)
    if (['<>', '>=', '<=', '::', '~~', '!='].includes(op)) { out.push(op); i += 2; continue }
    if ('()[],=<>'.includes(c)) { out.push(c); i++; continue }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(\.\d+)?/.exec(src.slice(i))
    if (!m) throw new Error(`cannot read "${src.slice(i, i + 12)}"`)
    out.push(m[0]); i += m[0].length
  }
  return out
}

const isUnknown = (v: V) => v === UNKNOWN
const kw = (t: string | undefined, w: string) => !!t && t.toUpperCase() === w

function parse(src: string): Node {
  const t = tokenize(src)
  let p = 0
  const peek = (k = 0) => t[p + k]
  const eat = (x?: string) => {
    const v = t[p]
    if (x !== undefined && !(v === x || kw(v, x))) throw new Error(`expected ${x}, got ${v}`)
    p++
    return v
  }

  const or = (): Node => {
    const parts = [and()]
    while (kw(peek(), 'OR')) { eat(); parts.push(and()) }
    if (parts.length === 1) return parts[0]
    return (r) => {
      const vs = parts.map((f) => f(r))
      if (vs.some((v) => v === true)) return true
      if (vs.some((v) => v === null || isUnknown(v))) return vs.some(isUnknown) ? UNKNOWN : null
      return false
    }
  }
  const and = (): Node => {
    const parts = [not()]
    while (kw(peek(), 'AND')) { eat(); parts.push(not()) }
    if (parts.length === 1) return parts[0]
    return (r) => {
      const vs = parts.map((f) => f(r))
      if (vs.some((v) => v === false)) return false
      if (vs.some((v) => v === null || isUnknown(v))) return vs.some(isUnknown) ? UNKNOWN : null
      return true
    }
  }
  const not = (): Node => {
    if (kw(peek(), 'NOT')) { eat(); const f = not(); return (r) => { const v = f(r); return isUnknown(v) || v === null ? v : !v } }
    return cmp()
  }
  const cmp = (): Node => {
    const left = value()
    const op = peek()
    if (kw(op, 'IS')) {
      eat()
      let negate = false
      if (kw(peek(), 'NOT')) { eat(); negate = true }
      if (kw(peek(), 'NULL')) {
        eat()
        return (r) => { const v = left(r); if (isUnknown(v)) return UNKNOWN; return negate ? v !== null : v === null }
      }
      if (kw(peek(), 'DISTINCT')) {
        eat(); eat('FROM')
        const right = value()
        return (r) => {
          const a = left(r), b = right(r)
          if (isUnknown(a) || isUnknown(b)) return UNKNOWN
          const distinct = !(a === b)
          return negate ? !distinct : distinct
        }
      }
      throw new Error(`IS ${peek()} not understood`)
    }
    if (['=', '<>', '!=', '<', '>', '<=', '>=', '~~', '!~~'].includes(op as string)) {
      eat()
      if (op === '=' && kw(peek(), 'ANY')) {
        eat('ANY'); eat('(')
        const arr = value()
        eat(')')
        return (r) => {
          const a = left(r), list = arr(r)
          if (isUnknown(a)) return UNKNOWN
          if (a === null) return null
          const items = Array.isArray(list) ? list : []
          if (items.some((x) => x === a)) return true
          return items.some((x) => x === null) ? null : false
        }
      }
      const right = value()
      return (r) => {
        const a = left(r), b = right(r)
        if (isUnknown(a) || isUnknown(b)) return UNKNOWN
        if (a === null || b === null) return null
        switch (op) {
          case '=': return a === b
          case '<>': case '!=': return a !== b
          case '<': return (a as any) < (b as any)
          case '>': return (a as any) > (b as any)
          case '<=': return (a as any) <= (b as any)
          case '>=': return (a as any) >= (b as any)
          case '~~': return likeToRe(String(b)).test(String(a))
          default: return !likeToRe(String(b)).test(String(a))
        }
      }
    }
    return left
  }
  const value = (): Node => {
    let node = atom()
    while (peek() === '::') { eat(); eat() /* type name: text, integer … */ }
    return node
  }
  const atom = (): Node => {
    const tok = peek()
    if (tok === undefined) throw new Error('unexpected end')
    if (tok === '(') { eat(); const f = or(); eat(')'); return f }
    if (tok.startsWith("'")) { eat(); const s = tok.slice(1); return () => s }
    if (/^-?\d/.test(tok)) { eat(); const n = Number(tok); return () => n }
    if (kw(tok, 'NULL')) { eat(); return () => null }
    if (kw(tok, 'TRUE')) { eat(); return () => true }
    if (kw(tok, 'FALSE')) { eat(); return () => false }
    if (kw(tok, 'ARRAY')) {
      eat(); eat('[')
      const items: Node[] = []
      if (peek() !== ']') { items.push(value()); while (peek() === ',') { eat(); items.push(value()) } }
      eat(']')
      return (r) => items.map((f) => f(r))
    }
    eat()
    if (peek() === '(') {
      eat('(')
      const args: Node[] = []
      if (peek() !== ')') { args.push(or()); while (peek() === ',') { eat(); args.push(or()) } }
      eat(')')
      const fn = tok.toLowerCase()
      const call = FUNCS[fn]
      if (!call) throw new Error(`function ${tok} not understood`)
      return (r) => { const vs = args.map((f) => f(r)); return vs.some(isUnknown) ? UNKNOWN : call(vs) }
    }
    const col = tok
    return (r) => (Object.prototype.hasOwnProperty.call(r, col) ? norm(r[col]) : UNKNOWN)
  }

  const node = or()
  if (p !== t.length) throw new Error(`left over: ${t.slice(p).join(' ')}`)
  return node
}

const FUNCS: Record<string, (v: V[]) => V> = {
  length: ([s]) => (s === null ? null : String(s).length),
  lower: ([s]) => (s === null ? null : String(s).toLowerCase()),
  btrim: ([s]) => (s === null ? null : String(s).replace(/^\s+|\s+$/g, '')),
  nullif: ([a, b]) => (a === b ? null : a),
}

function likeToRe(pat: string): RegExp {
  return new RegExp('^' + pat.split('').map((ch) => ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 's')
}

function norm(v: unknown): V {
  if (v === undefined || v === null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toISOString()
  return JSON.stringify(v)
}

const compiled = new Map<string, Node | Error>()
function compile(def: string): Node | Error {
  if (compiled.has(def)) return compiled.get(def)!
  let out: Node | Error
  try {
    const m = /^CHECK\s*\(([\s\S]*)\)\s*(NOT VALID)?$/i.exec(def.trim())
    if (!m) throw new Error('not a CHECK')
    out = parse(m[1])
  } catch (e) {
    out = e instanceof Error ? e : new Error(String(e))
  }
  compiled.set(def, out)
  return out
}

/** Rules the reader cannot evaluate. A test holds this empty. */
export function unreadableRules(): string[] {
  const out: string[] = []
  for (const [table, rules] of Object.entries(realRules().checks)) {
    for (const r of rules) { const c = compile(r.def); if (c instanceof Error) out.push(`${table}.${r.name}: ${c.message}`) }
  }
  return out
}

// ── Columns a migration adds that the real database does not have YET ─────
// Code may write them only when the write is error-tolerant and said so.
// Each names the migration that adds it; a test checks the migration really
// adds it, and that the line goes once the column is in the snapshot.
// (mailchimp_progress_dates.sql was run by Kevin 2026-11-26 10:37; its two
// columns are in the real schema now.)
export const PENDING_COLUMNS: Record<string, string> = {}

export type RuleProblem = { code: '23514' | '23502' | '42703'; table: string; rule: string; message: string }

/**
 * What the real database would refuse about this row. `insert` and `upsert`
 * also need every required column; `update` judges only what it writes.
 */
export function rowProblems(table: string, row: Record<string, unknown>, op: 'insert' | 'update' | 'upsert'): RuleProblem[] {
  const out: RuleProblem[] = []
  const cols = realSchema().get(table)
  if (cols) {
    for (const k of Object.keys(row)) {
      if (!cols.has(k) && !PENDING_COLUMNS[`${table}.${k}`]) out.push({ code: '42703', table, rule: k, message: `column ${table}.${k} does not exist` })
    }
  }
  const rules = realRules()
  if (op !== 'update') {
    for (const c of rules.required[table] || []) {
      if (row[c] === undefined || row[c] === null) out.push({ code: '23502', table, rule: c, message: `null value in column "${c}" of relation "${table}" violates not-null constraint` })
    }
  } else {
    for (const c of rules.required[table] || []) {
      if (Object.prototype.hasOwnProperty.call(row, c) && row[c] === null) out.push({ code: '23502', table, rule: c, message: `null value in column "${c}" of relation "${table}" violates not-null constraint` })
    }
  }
  for (const r of rules.checks[table] || []) {
    const f = compile(r.def)
    if (f instanceof Error) continue // reported by unreadableRules()
    if (f(row) === false) out.push({ code: '23514', table, rule: r.name, message: `new row for relation "${table}" violates check constraint "${r.name}"` })
  }
  return out
}

/** The tables the copy holds rules for. */
export const RULED_TABLES = (): string[] => Object.keys(realRules().checks)

/**
 * Wrap a stand-in database so its writes are held to the real rules. A row
 * the real database would refuse is refused here the same way — the call
 * answers { data: null, error: { code, message } } however it is chained —
 * and is NOT passed on. `refused` lists every refusal, for the test to read.
 */
export function enforceRealRules<T extends { from: (t: string) => any }>(db: T): T & { refused: RuleProblem[] } {
  const refused: RuleProblem[] = []
  const failing = (p: RuleProblem) => {
    const res = { data: null, error: { code: p.code, message: p.message }, count: null }
    const chain: any = new Proxy(function () {} as any, {
      get: (_t, k) => (k === 'then' ? (ok: any, bad: any) => Promise.resolve(res).then(ok, bad) : () => chain),
      apply: () => chain,
    })
    return chain
  }
  const wrapped: any = {
    ...db,
    refused,
    from: (table: string) => {
      const q = db.from(table)
      const guard = (op: 'insert' | 'update' | 'upsert') => (rows: any, ...rest: any[]) => {
        const list = Array.isArray(rows) ? rows : [rows]
        for (const row of list) {
          const probs = rowProblems(table, row || {}, op)
          if (probs.length) { refused.push(...probs); return failing(probs[0]) }
        }
        return q[op](rows, ...rest)
      }
      return new Proxy(q, {
        get: (target, k) => (k === 'insert' || k === 'update' || k === 'upsert') && typeof target[k] === 'function' ? guard(k) : target[k],
      })
    },
  }
  return wrapped
}
