// lib/db-write-scan.ts
// Finds every `.from('<table>') … .insert / .update / .upsert(<row>)` in the
// app's source, following the chain call by call, and reads the row when it is
// written out in the code: its keys, and the fixed values it sets. Used by
// tests only (lib/beta-mailchimp-writes-real-rules.test.ts,
// lib/beta-mailchimp-connection-clears.test.ts); the companion of
// lib/db-select-scan.ts, which does the same for reads.
//
// A row built at run time (a variable, or an object with a spread) comes back
// as not readable (parseObject → null / spread: true); callers must treat
// that as "not checked here", never as "fine".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Write = { file: string; table: string; op: 'insert' | 'update' | 'upsert'; arg: string | null }

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

export function findWrites(files: string[]): Write[] {
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
export function literalChoices(v: string): unknown[] | undefined {
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

export type Parsed = { keys: string[]; fixed: Record<string, unknown[]>; spread: boolean }
export function parseObject(arg: string): Parsed | null {
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

export function combos(fixed: Record<string, unknown[]>): Record<string, unknown>[] {
  let rows: Record<string, unknown>[] = [{}]
  for (const [k, vs] of Object.entries(fixed)) rows = rows.flatMap((r) => vs.map((v) => ({ ...r, [k]: v }))).slice(0, 256)
  return rows
}

