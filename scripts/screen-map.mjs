// scripts/screen-map.mjs
// ─────────────────────────────────────────────────────────────────────────────
// The engine behind docs/screen-map.json — shared by the guard test
// (lib/beta-screen-map-248.test.ts) and the line-sync CLI
// (scripts/screen-map-sync.mjs) so both agree on what "still true" means.
//
// WHY THIS EXISTS (issue 248 step 1)
// BeeHub.jsx is ~37,000 lines. A bug report that says "the notes box on a
// client record is broken" lands a scout on a FILE, not a region. The map is
// the missing index; this module is what stops it from silently rotting.
//
// THE ONE RULE: nothing in the map is hand-authored twice. A human writes the
// surface name, the plain words, the routes and the tables. The LINE RANGES
// ARE DERIVED from the anchors — never typed — so they cannot drift out of
// agreement with the code without the guard noticing.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MAP_PATH = path.join(REPO_ROOT, 'docs', 'screen-map.json')

export const NAV_SURFACES = [
  'Home', 'Clients', 'Network', 'Inbox', 'Reports', 'Back Office',
  'Settings', 'Admin', 'Feedback', 'Onboarding', 'Auth', 'Public',
]

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

// ── source reading ───────────────────────────────────────────────────────────

const fileCache = new Map()
export function readSource(relPath) {
  if (!fileCache.has(relPath)) {
    const abs = path.join(REPO_ROOT, relPath)
    fileCache.set(relPath, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null)
  }
  return fileCache.get(relPath)
}

export function fileExists(relPath) {
  return readSource(relPath) !== null
}

// A top-level declaration is one that starts at COLUMN ZERO. Anything indented
// is nested inside another component and is not addressable as a region.
const DECL_RE = new RegExp(
  '^(export\\s+default\\s+|export\\s+)?(?:async\\s+)?' +
  '(?:function\\s+([A-Za-z0-9_$]+)|' +
  'const\\s+([A-Za-z0-9_$]+)\\s*=\\s*(?:\\(|async|function|React\\.|dynamic\\(|memo\\(|forwardRef\\())'
)

const declCache = new Map()
/**
 * Every top-level declaration in a file, in source order, each with the line
 * range it owns (from its own line to the line before the next declaration).
 * That range IS the region a map entry points at.
 */
export function topLevelDecls(relPath) {
  if (declCache.has(relPath)) return declCache.get(relPath)
  const src = readSource(relPath)
  if (src === null) { declCache.set(relPath, []); return [] }
  const lines = src.split('\n')
  const out = []
  lines.forEach((line, i) => {
    const m = line.match(DECL_RE)
    if (!m) return
    const prefix = (m[1] || '').trim()
    out.push({
      name: m[2] || m[3],
      line: i + 1,
      exported: prefix.startsWith('export default') ? 'default'
        : prefix.startsWith('export') ? 'named'
        : 'internal',
    })
  })
  out.forEach((d, i) => { d.end = i + 1 < out.length ? out[i + 1].line - 1 : lines.length })
  declCache.set(relPath, out)
  return out
}

export function findDecl(relPath, symbol) {
  return topLevelDecls(relPath).find(d => d.name === symbol) || null
}

/** 1-indexed lines where `needle` appears literally. */
export function anchorLines(relPath, needle) {
  const src = readSource(relPath)
  if (src === null) return []
  const out = []
  src.split('\n').forEach((line, i) => { if (line.includes(needle)) out.push(i + 1) })
  return out
}

// ── API routes ───────────────────────────────────────────────────────────────

/** "PATCH /api/leads/[id]" → { method, urlPath, routeFile } */
export function parseRouteRef(ref) {
  const m = String(ref).match(/^([A-Z]+)\s+(\/api\/\S+)$/)
  if (!m) return null
  return {
    method: m[1],
    urlPath: m[2],
    routeFile: path.posix.join('app', m[2], 'route.ts'),
  }
}

const methodCache = new Map()
export function routeMethods(routeFile) {
  if (methodCache.has(routeFile)) return methodCache.get(routeFile)
  const src = readSource(routeFile)
  const found = src === null ? null : [...src.matchAll(
    /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g
  )].map(m => m[1])
  methodCache.set(routeFile, found)
  return found
}

// ── tables ───────────────────────────────────────────────────────────────────

let knownTables = null
/**
 * Every table name any server route or lib module actually selects from. A map
 * entry naming a table outside this set is either a typo or a table that has
 * been renamed away — both are staleness.
 */
export function knownTableNames() {
  if (knownTables) return knownTables
  const tables = new Set()
  const scan = dir => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name)
      if (entry.isDirectory()) { scan(rel); continue }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name) || /\.test\./.test(entry.name)) continue
      const src = readSource(rel)
      if (!src) continue
      for (const m of src.matchAll(/\.from\(\s*['"`]([a-z0-9_]+)['"`]/g)) tables.add(m[1])
    }
  }
  scan('app/api')
  scan('lib')
  knownTables = tables
  return tables
}

// ── the map ──────────────────────────────────────────────────────────────────

export function loadMap() {
  return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'))
}

/**
 * Derive the line range an entry OWNS, from its anchors alone.
 *
 *   · no `anchor`  → the symbol's whole top-level declaration span
 *   · an `anchor`  → from the anchor line to just before the NEXT sibling
 *                    anchor under the same symbol (last sibling runs to the
 *                    end of the symbol)
 *
 * Returns null when the symbol or anchor cannot be found — the caller reports
 * that as a hard failure, not as a silent [0,0].
 */
export function deriveLines(entry, allEntries) {
  const decl = findDecl(entry.file, entry.symbol)
  if (!decl) return null
  if (!entry.anchor) return [decl.line, decl.end]

  const hits = anchorLines(entry.file, entry.anchor)
  if (hits.length !== 1) return null
  const start = hits[0]

  const siblingStarts = allEntries
    .filter(e => e.file === entry.file && e.symbol === entry.symbol && e.anchor)
    .map(e => { const h = anchorLines(e.file, e.anchor); return h.length === 1 ? h[0] : null })
    .filter(n => n !== null)
    .sort((a, b) => a - b)

  const next = siblingStarts.find(n => n > start)
  return [start, next ? next - 1 : decl.end]
}

/**
 * The guard. Returns a flat list of human-readable problem strings; empty means
 * the map still describes the code that is actually there.
 */
export function verifyMap(map) {
  const problems = []
  const entries = map.entries || []
  const seenIds = new Set()

  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push('map has no entries')
    return problems
  }

  for (const e of entries) {
    const at = `[${e.id || '(no id)'}]`

    // ── shape ────────────────────────────────────────────────────────────────
    for (const key of ['id', 'surface', 'nav', 'file', 'symbol', 'exported', 'says']) {
      if (e[key] === undefined || e[key] === null || e[key] === '') problems.push(`${at} missing required field "${key}"`)
    }
    if (!e.id) continue
    if (seenIds.has(e.id)) problems.push(`${at} duplicate id`)
    seenIds.add(e.id)
    if (e.nav && !NAV_SURFACES.includes(e.nav)) problems.push(`${at} nav "${e.nav}" is not one of ${NAV_SURFACES.join(', ')}`)
    if (!Array.isArray(e.says) || e.says.length === 0) problems.push(`${at} "says" must list at least one plain-language phrase`)
    if (!['default', 'named', 'internal'].includes(e.exported)) problems.push(`${at} "exported" must be default | named | internal`)

    // ── the file is still there ──────────────────────────────────────────────
    if (!fileExists(e.file)) { problems.push(`${at} file does not exist: ${e.file}`); continue }

    // ── the symbol is still there, and still exported the same way ───────────
    const decl = findDecl(e.file, e.symbol)
    if (!decl) {
      problems.push(`${at} ${e.file} no longer declares "${e.symbol}" at top level`)
    } else if (decl.exported !== e.exported) {
      problems.push(`${at} "${e.symbol}" is now ${decl.exported}, map says ${e.exported}`)
    }

    // ── the sub-region anchor is still there, and still unambiguous ──────────
    if (e.anchor) {
      const hits = anchorLines(e.file, e.anchor)
      if (hits.length === 0) problems.push(`${at} anchor not found in ${e.file}: ${JSON.stringify(e.anchor)}`)
      else if (hits.length > 1) problems.push(`${at} anchor is ambiguous (${hits.length} matches) in ${e.file}: ${JSON.stringify(e.anchor)}`)
      else if (decl && (hits[0] < decl.line || hits[0] > decl.end)) {
        problems.push(`${at} anchor sits at line ${hits[0]}, outside "${e.symbol}" (${decl.line}-${decl.end})`)
      }
    }

    // ── the recorded line range still matches what the anchors derive ────────
    const derived = deriveLines(e, entries)
    if (derived === null) {
      if (decl) problems.push(`${at} line range could not be derived`)
    } else if (!Array.isArray(e.lines) || e.lines[0] !== derived[0] || e.lines[1] !== derived[1]) {
      problems.push(
        `${at} line range is stale: map says ${JSON.stringify(e.lines)}, code says [${derived[0]}, ${derived[1]}] ` +
        `— run \`node scripts/screen-map-sync.mjs\``
      )
    }

    // ── every route it claims to call still exists, with that method ─────────
    for (const ref of e.routes || []) {
      const parsed = parseRouteRef(ref)
      if (!parsed) { problems.push(`${at} route "${ref}" is not "METHOD /api/..."`); continue }
      if (!HTTP_METHODS.includes(parsed.method)) { problems.push(`${at} route "${ref}" has unknown method`); continue }
      const methods = routeMethods(parsed.routeFile)
      if (methods === null) problems.push(`${at} route file does not exist: ${parsed.routeFile} (from "${ref}")`)
      else if (!methods.includes(parsed.method)) {
        problems.push(`${at} ${parsed.routeFile} no longer exports ${parsed.method} (exports: ${methods.join(', ') || 'none'})`)
      }
    }

    // ── every table it claims to touch is still queried somewhere ────────────
    const tables = knownTableNames()
    for (const t of e.tables || []) {
      if (!tables.has(t)) problems.push(`${at} table "${t}" is not read or written by any route or lib module`)
    }
  }

  return problems
}
