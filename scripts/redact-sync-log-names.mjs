// ═══════════════════════════════════════════════════════════════════════════
// #125 — redact client names already sitting in sync_log.message.
//
// #110a (1a4cdcc) plugged the source: writers now log the lead UUID instead
// of the client's name. This script rewrites the ~3,549 PRE-#110a rows to the
// exact shape the post-#110a writers produce, so the name is gone but the
// troubleshooting content (and the row itself) survives. UPDATE only — this
// script NEVER deletes a row, and it touches ONLY the message column.
//
// DEFAULTS TO DRY RUN. It classifies every name-bearing row, prints
// before/after samples per class, and writes a full report JSON. Writes
// happen ONLY when --execute is passed.
//
// Usage:
//   node scripts/redact-sync-log-names.mjs [envfile]              (dry run)
//   node scripts/redact-sync-log-names.mjs [envfile] --execute    (writes)
//
// THE SIX SHAPES (100% of matching rows as of the 2026-07-31 scout; anything
// that doesn't classify is SKIPPED and reported, never guessed at):
//   founding    [engagement:X] founded via <tbl>/<id> for lead "NAME" at stage S
//                 → for lead <uuid>            (uuid = engagements.client_id)
//   close       [engagement:close] S reason=R [note="…"] — client "NAME" has …
//                 → note="…" clause DROPPED (free staff text, #110a parity),
//                   client <uuid>              (uuid = engagements.client_id)
//   reopen      [engagement:reopen] … for client "NAME"
//                 → for client <uuid>          (uuid = engagements.client_id)
//   wh-nullify  topic=… lead=<uuid> — TOPIC: nulled … on lead "NAME"
//                 → on lead <uuid>             (uuid already in the message)
//   wh-propsync topic=… lead=<uuid> — TOPIC: synced property address to lead "NAME"
//                 → to lead <uuid>             (uuid already in the message)
//
// GUARDS RE-RUN AT EXECUTE TIME: the candidate set + transforms are recomputed
// from LIVE data on every run — a dry-run report is never trusted as input.
// Each PATCH targets a single primary-key id. A transformed message is written
// only if it still classifies, no longer matches the name patterns, and its
// engagement join resolved. Idempotent: redacted rows no longer match the
// candidate filter, so a re-run finds only what's left.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'fs'

const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const envPath = argv.find(a => !a.startsWith('--')) || '.env.local'

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SB_URL || !SB_KEY) { console.error('missing supabase env'); process.exit(1) }

async function sb(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  })
  if (!res.ok) throw new Error(`PostgREST ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`)
  const t = await res.text(); return t ? JSON.parse(t) : []
}
async function sbAll(base) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const page = await sb(`${base}${base.includes('?') ? '&' : '?'}offset=${from}&limit=1000`)
    out.push(...page)
    if (page.length < 1000) break
  }
  return out
}
async function sbPatch(path, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PostgREST PATCH ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`)
  const t = await res.text(); return t ? JSON.parse(t) : []
}

console.log(`redact-sync-log-names — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'} #125`)
console.log('')

// ── 1. candidate set, fresh every run ───────────────────────────────────────
// `lead "` = *lead%20%22*   `client "` = *client%20%22*
const rows = await sbAll(
  'sync_log?select=id,created_at,entity_id,message' +
  '&or=(message.like.*lead%20%22*,message.like.*client%20%22*)&order=created_at.asc'
)
console.log(`name-bearing rows: ${rows.length}`)
if (!rows.length) { console.log('nothing to do'); process.exit(0) }

// ── 2. engagement join for the engagement-family rows ───────────────────────
// entity_id on founding/close/reopen rows is the engagement id; its client_id
// is the lead UUID the post-#110a writers log.
const ENG_FAMILY = /^\[engagement:(?!.*(?:nulled|synced))/
const engIds = [...new Set(rows.filter(r => ENG_FAMILY.test(r.message)).map(r => r.entity_id))]
const clientIdByEng = new Map()
for (let i = 0; i < engIds.length; i += 100) {
  const chunk = engIds.slice(i, i + 100)
  for (const e of await sb(`engagements?select=id,client_id&id=in.(${chunk.join(',')})`))
    clientIdByEng.set(e.id, e.client_id)
}
console.log(`engagement join: resolved ${clientIdByEng.size}/${engIds.length} engagement ids`)

// ── 3. classify + transform ─────────────────────────────────────────────────
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SHAPES = [
  {
    key: 'founding',
    // Greedy ".*" + the fixed " at stage" tail: names can contain embedded
    // quotes (e.g. a nickname in quotes) — 2 such rows exist.
    re: /^(\[engagement:[a-z_]+\] founded via [a-z_]+\/\S+ for lead )".*"( at stage .*)$/s,
    xform: (r, m) => {
      const uuid = clientIdByEng.get(r.entity_id)
      return uuid ? `${m[1]}${uuid}${m[2]}` : null
    },
  },
  {
    key: 'close',
    // note="…" (free staff text) is dropped entirely, matching #110a. The
    // " — client " separator is written literally by the old writer and the
    // note cannot contain it unquoted-and-matching thanks to the lazy note
    // group + anchored tail.
    re: /^(\[engagement:close\] Closed (?:Won|Lost) reason=.*?)(?: note=".*")? — client ".*"( has \d+ other open engagement\(s\).*)$/s,
    xform: (r, m) => {
      const uuid = clientIdByEng.get(r.entity_id)
      return uuid ? `${m[1]} — client ${uuid}${m[2]}` : null
    },
  },
  {
    key: 'reopen',
    re: /^(\[engagement:reopen\] .* for client )".*"$/s,
    xform: (r, m) => {
      const uuid = clientIdByEng.get(r.entity_id)
      return uuid ? `${m[1]}${uuid}` : null
    },
  },
  {
    key: 'wh-nullify',
    re: new RegExp(`^(.*\\blead=(${UUID}) — [A-Z_]+: nulled .* on lead )".*"(.*)$`, 's'),
    xform: (_r, m) => `${m[1]}${m[2]}${m[3]}`,
  },
  {
    key: 'wh-propsync',
    re: new RegExp(`^(.*\\blead=(${UUID}) — [A-Z_]+: synced property address to lead )".*"(.*)$`, 's'),
    xform: (_r, m) => `${m[1]}${m[2]}${m[3]}`,
  },
]
// A redacted message must no longer be a candidate — belt on every transform.
const STILL_NAMED = /(?:lead|client) "/

const planned = []   // { id, key, before, after }
const skipped = []   // { id, reason, message }
for (const r of rows) {
  let hit = null, m = null
  for (const s of SHAPES) { m = r.message.match(s.re); if (m) { hit = s; break } }
  if (!hit) { skipped.push({ id: r.id, reason: 'unclassified', message: r.message }); continue }
  const after = hit.xform(r, m)
  if (!after) { skipped.push({ id: r.id, reason: 'no-engagement-join', message: r.message }); continue }
  if (STILL_NAMED.test(after)) { skipped.push({ id: r.id, reason: 'name-survived-transform', message: r.message }); continue }
  planned.push({ id: r.id, key: hit.key, before: r.message, after })
}

const byKey = planned.reduce((a, p) => (a[p.key] = (a[p.key] || 0) + 1, a), {})
console.log('\n── plan ──')
for (const [k, n] of Object.entries(byKey)) console.log(`  ${k.padEnd(12)} ${n}`)
console.log(`  ${'TOTAL'.padEnd(12)} ${planned.length}   (skipped: ${skipped.length})`)
if (skipped.length) {
  console.log('\n⚠ SKIPPED ROWS (left untouched — investigate before executing):')
  for (const s of skipped.slice(0, 10)) console.log(`  [${s.reason}] id=${s.id}\n     ${s.message.slice(0, 200)}`)
}

console.log('\n── before/after samples ──')
for (const key of Object.keys(byKey)) {
  for (const p of planned.filter(p => p.key === key).slice(0, 2)) {
    console.log(`  [${key}] id=${p.id}`)
    console.log(`    - ${p.before.slice(0, 220)}`)
    console.log(`    + ${p.after.slice(0, 220)}`)
  }
}
// The 6 note="…"-carrying close rows are the only free-text drops — show all.
const noteRows = planned.filter(p => p.before.includes(' note="'))
if (noteRows.length) {
  console.log(`\n── all ${noteRows.length} note="…" drops ──`)
  for (const p of noteRows) {
    console.log(`  id=${p.id}\n    - ${p.before.slice(0, 220)}\n    + ${p.after.slice(0, 220)}`)
  }
}

writeFileSync('redact-sync-log-names.report.json', JSON.stringify({
  ranAt: new Date().toISOString(), execute: EXECUTE,
  candidates: rows.length, planned: planned.length, byKey, skipped, plan: planned,
}, null, 2))
console.log('\nreport → redact-sync-log-names.report.json')

if (!EXECUTE) {
  console.log('\nDRY RUN complete — no rows were modified. Re-run with --execute to write.')
  process.exit(0)
}

// ── 4. execute: single-row PATCHes by primary key, bounded concurrency ──────
console.log(`\nwriting ${planned.length} rows…`)
let done = 0, changed = 0, failed = []
const BATCH = 20
for (let i = 0; i < planned.length; i += BATCH) {
  const chunk = planned.slice(i, i + BATCH)
  const results = await Promise.allSettled(
    chunk.map(p => sbPatch(`sync_log?id=eq.${p.id}`, { message: p.after }))
  )
  results.forEach((res, j) => {
    if (res.status === 'fulfilled' && res.value.length === 1) changed++
    else failed.push({ id: chunk[j].id, error: res.status === 'rejected' ? String(res.reason).slice(0, 200) : `rows=${res.value.length}` })
  })
  done += chunk.length
  if (done % 500 < BATCH || done === planned.length) console.log(`  ${done}/${planned.length} (${changed} changed)`)
}

console.log(`\ndone: ${changed}/${planned.length} rows redacted, ${failed.length} failed`)
if (failed.length) { console.log('failures:'); failed.slice(0, 10).forEach(f => console.log(`  id=${f.id} ${f.error}`)) }

// post-write verification: candidate filter should now come up empty
const remain = await sb('sync_log?select=id&or=(message.like.*lead%20%22*,message.like.*client%20%22*)&limit=5')
console.log(`\nverify: rows still matching name pattern: ${remain.length === 0 ? '0 ✓' : `${remain.length}+ ⚠ (${remain.map(r => r.id).join(', ')})`}`)
