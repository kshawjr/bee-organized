// lib/db-select-scan.ts
// Finds every `.from('<table>') … .select(<columns>)` in the app's source and
// works out the column list being asked for, so lib/beta-db-columns.test.ts
// can hold each one to the real schema (lib/db-columns-check.ts explains why).
//
// A select's columns are usually a string literal. When they are a named
// constant (`.select(BEE_COLUMNS)`) or a template built from constants
// (`${ENG_BASE}, ${ENG_CHANNEL}` — the exact shape of the 2026-11-12 fault),
// the constant is looked up in the same file, then in the file it is
// imported from. Anything that still cannot be worked out is reported as
// `unresolved` rather than skipped in silence. Used by tests only.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export type FoundSelect = { file: string; line: number; table: string; columns: string | null; expr: string }
export type FoundFilter = { file: string; line: number; table: string; column: string; method: string }

const SOURCE_RE = /\.(jsx?|tsx?|mjs)$/
export function sourceFiles(roots: string[]): string[] {
  const walk = (d: string): string[] => readdirSync(d).flatMap(n => {
    if (n === 'node_modules' || n.startsWith('.')) return []
    const p = join(d, n)
    if (statSync(p).isDirectory()) return walk(p)
    return SOURCE_RE.test(n) && !/\.test\./.test(n) && !/\.d\.ts$/.test(n) ? [p] : []
  })
  return roots.flatMap(r => (existsSync(r) ? (statSync(r).isDirectory() ? walk(r) : [r]) : []))
}

// Read one JS string/template expression starting at `i`. Returns the text of
// a pure literal, or null when it contains anything that is not a literal or
// a resolvable constant.
function readExpr(src: string, i: number, file: string, seen: Set<string>): { value: string | null; expr: string } {
  let j = i
  const parts: (string | null)[] = []
  const start = i
  const skip = () => {
    for (;;) {
      while (/\s/.test(src[j] || '')) j++
      if (src[j] === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) j = src.length; continue }
      if (src[j] === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 2; continue }
      break
    }
  }
  for (;;) {
    skip()
    const q = src[j]
    if (q === "'" || q === '"') {
      let k = j + 1, s = ''
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') { s += src[k + 1]; k += 2 } else s += src[k++] }
      parts.push(s); j = k + 1
    } else if (q === '`') {
      let k = j + 1, s: string | null = ''
      while (k < src.length && src[k] !== '`') {
        if (src[k] === '$' && src[k + 1] === '{') {
          const end = src.indexOf('}', k)
          const name = src.slice(k + 2, end).trim()
          const v = /^[A-Za-z_$][\w$]*$/.test(name) ? resolveConst(name, file, seen) : null
          s = s === null || v === null ? null : s + v
          k = end + 1
        } else { if (s !== null) s += src[k]; k++ }
      }
      parts.push(s); j = k + 1
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(j))
      if (!m) { parts.push(null); break }
      parts.push(resolveConst(m[0], file, seen)); j += m[0].length
    }
    skip()
    if (src[j] === '+') { j++; continue }
    break
  }
  const expr = src.slice(start, j).replace(/\s+/g, ' ').slice(0, 80)
  return { value: parts.some(p => p === null) ? null : (parts as string[]).join(''), expr }
}

const fileCache = new Map<string, string>()
const read = (f: string) => { if (!fileCache.has(f)) fileCache.set(f, readFileSync(f, 'utf8')); return fileCache.get(f)! }

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? join(dirname(from), spec) : null
  if (!base) return null
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.js']) {
    const p = base + ext
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

export function resolveConst(name: string, file: string, seen = new Set<string>()): string | null {
  const key = `${file}::${name}`
  if (seen.has(key)) return null
  seen.add(key)
  const src = read(file)
  const def = new RegExp(`(?:^|[\\s;])(?:export\\s+)?(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*(?::[^=\\n]+)?=\\s*`, 'm').exec(src)
  if (def) return readExpr(src, def.index + def[0].length, file, seen).value
  const imp = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`).exec(src)
  if (imp) { const target = resolveImport(file, imp[1]); if (target) return resolveConst(name, target, seen) }
  return null
}

export function findSelects(files: string[]): FoundSelect[] {
  const out: FoundSelect[] = []
  for (const file of files) {
    const src = read(file)
    const re = /\.from\(\s*(['"`])([a-zA-Z0-9_]+)\1\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const after = m.index + m[0].length
      const rest = src.slice(after, after + 4000)
      const stop = rest.search(/\.from\(|\n\s*\n\s*(?:const|let|var|return|if|for|await|export|function)\b/)
      const chain = stop >= 0 ? rest.slice(0, stop) : rest
      // every .select( in this chain (an insert/update may be followed by one)
      const sel = /\.select\(\s*/g
      let s: RegExpExecArray | null
      while ((s = sel.exec(chain))) {
        const at = after + s.index + s[0].length
        const line = src.slice(0, m.index).split('\n').length
        if (src[at] === ')') { out.push({ file, line, table: m[2], columns: '*', expr: '' }); continue }
        const r = readExpr(src, at, file, new Set())
        out.push({ file, line, table: m[2], columns: r.value, expr: r.expr })
      }
    }
  }
  return out
}

// The columns a chain FILTERS or SORTS on: .eq('col', …), .is('col', …),
// .order('col') and friends, with the column as a plain string literal. A
// filter on a column that does not exist fails the read exactly as a select
// of one does. Columns of an embedded table (`rel.col`) are left alone.
const FILTERS = 'eq|neq|is|not|in|gt|gte|lt|lte|like|ilike|order|contains|overlaps'
export function findFilters(files: string[]): FoundFilter[] {
  const out: FoundFilter[] = []
  for (const file of files) {
    const src = read(file)
    const re = /\.from\(\s*(['"`])([a-zA-Z0-9_]+)\1\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const after = m.index + m[0].length
      const rest = src.slice(after, after + 4000)
      // Only the unbroken method chain: stop at the first thing that is not
      // `.method(…)` continuing straight on from the previous call.
      // i.e. a run of `.name( … )` and nothing else between them.
      let i = 0
      for (;;) {
        const link = /^\s*\??\.\s*[A-Za-z_$][\w$]*\s*\(/.exec(rest.slice(i))
        if (!link) break
        let k = i + link[0].length, depth = 1
        for (; k < rest.length && depth > 0; k++) {
          const ch = rest[k]
          if (ch === '(') depth++
          else if (ch === ')') depth--
        }
        if (depth !== 0) break
        i = k
      }
      const chain = rest.slice(0, i)
      const f = new RegExp(`\\.(${FILTERS})\\(\\s*(['"])([a-zA-Z_][a-zA-Z0-9_]*)\\2\\s*[,)]`, 'g')
      let x: RegExpExecArray | null
      while ((x = f.exec(chain))) {
        out.push({ file, line: src.slice(0, m.index).split('\n').length, table: m[2], column: x[3], method: x[1] })
      }
    }
  }
  return out
}
