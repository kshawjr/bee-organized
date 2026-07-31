// ═══════════════════════════════════════════════════════════════════════════
// #117 — archived Jobber quote should close the deal as Closed Lost.
//
// DEFAULTS TO DRY RUN. It lists every engagement that WOULD close under the
// rule so Kevin can review. Writes happen ONLY when --execute is passed.
//
// Usage:
//   node scripts/backfill-archived-quote-close.mjs [envfile]              (dry run)
//   node scripts/backfill-archived-quote-close.mjs [envfile] --execute    (writes)
//   node scripts/backfill-archived-quote-close.mjs [envfile] --execute \
//        --exclude=<eng-id>,<eng-id>          (skip specific engagement ids)
//   (--exclude may also be spelled  --exclude <ids>  and may repeat.)
//
// THE RULE (mirrors deriveEngagementStage's closeOnArchivedQuote branch in
// lib/engagements.ts — keep in sync):
//   Close an engagement Closed Lost (closed_reason 'quote_archived') when, and
//   only when:
//     · it is NOT already terminal (stage ∉ {Closed Won, Closed Lost})
//     · it has ≥1 quote and EVERY quote is status 'archived'
//     · it has NO jobs at all (booked or unbooked)
//     · it has NO invoices at all (incl. jobless rule-6 invoices)
//   Anything with a live quote, a job, or an invoice behind it is left exactly
//   as it is — real work never gets auto-closed.
//
// GUARDS RE-RUN AT EXECUTE TIME: every run recomputes the candidate set from
// LIVE data (engagements/quotes/jobs/invoices fetched fresh) — the dry-run
// report is NEVER trusted as input. As a second belt, each PATCH carries a
// stage=not.in.(terminal) filter so a deal that closed between the read and
// the write is left untouched (the write returns zero rows and is reported).
//
// SOFT CLOSE ONLY (#66 cascade trap): the execute path does an UPDATE of
// stage / closed_reason / closed_at / closed_note (+ stage_entered_at /
// updated_at) — NEVER a DELETE. engagement_assignees cascades on delete, so it
// is never referenced here at all. No touchpoint / sync_log is written (this
// mirrors the live webhook advance, which is also silent).
//
// Writes backfill-archived-quote-close.report.json on every run and, under
// --execute, the engagement UPDATEs above and nothing else.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'

// ── arg parsing: --execute, --exclude (=list | <list>, repeatable), envfile ──
const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const excludeIds = new Set()
const consumed = new Set()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--exclude') {
    ;(argv[i + 1] || '').split(',').forEach(s => s.trim() && excludeIds.add(s.trim()))
    consumed.add(i + 1)
  } else if (a.startsWith('--exclude=')) {
    a.slice('--exclude='.length).split(',').forEach(s => s.trim() && excludeIds.add(s.trim()))
  }
}
const envPath = argv.find((a, i) => !a.startsWith('--') && !consumed.has(i)) || '.env.local'

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
// PATCH helper — used ONLY by the execute path. return=representation so we can
// confirm a row actually changed (empty = the terminal guard blocked it).
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

const TERMINAL = new Set(['Closed Won', 'Closed Lost'])
const isArchived = q => (q.status || '').toLowerCase() === 'archived'
const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]) }
// Terminal-exclusion filter reused on every PATCH (belt to the recompute).
const NOT_TERMINAL_FILTER =
  `stage=not.in.(${encodeURIComponent('"Closed Won"')},${encodeURIComponent('"Closed Lost"')})`

console.log(`backfill-archived-quote-close — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'} #117`)
if (excludeIds.size) console.log(`excluding ${excludeIds.size} engagement id(s): ${[...excludeIds].join(', ')}`)
console.log('')

// ── load scope + children (fresh — this IS the guard re-run) ─────────────────
const engs = await sbAll('engagements?select=id,stage,client_id,location_uuid,created_at,stage_entered_at')
const quotes = await sbAll('quotes?select=id,engagement_id,status,jobber_quote_id,quote_url,created_at,sent_at&engagement_id=not.is.null')
const jobs = await sbAll('jobs?select=id,engagement_id&engagement_id=not.is.null')
const invoices = await sbAll('invoices?select=id,engagement_id&engagement_id=not.is.null')
const leads = await sbAll('leads?select=id,name,email,location_uuid')
const locations = await sbAll('locations?select=id,name,location_id')

const qBy = new Map(), jBy = new Map(), iBy = new Map()
for (const q of quotes) push(qBy, q.engagement_id, q)
for (const j of jobs) push(jBy, j.engagement_id, j)
for (const iv of invoices) push(iBy, iv.engagement_id, iv)
const leadById = new Map(leads.map(l => [l.id, l]))
const locName = Object.fromEntries(locations.map(l => [l.id, l.name]))
const locSlug = Object.fromEntries(locations.map(l => [l.id, l.location_id]))

// ── apply THE RULE against the freshly-fetched data ──────────────────────────
let excludedCount = 0
const candidates = []
for (const e of engs) {
  if (TERMINAL.has(e.stage)) continue
  const eq = qBy.get(e.id) || []
  const ej = jBy.get(e.id) || []
  const ei = iBy.get(e.id) || []
  if (eq.length === 0 || !eq.every(isArchived)) continue  // no quotes, or a live quote remains
  if (ej.length > 0 || ei.length > 0) continue             // a job or invoice advanced past the quote
  if (excludeIds.has(e.id)) { excludedCount++; continue }  // Kevin's explicit skip
  const lead = leadById.get(e.client_id)
  candidates.push({
    engagement_id: e.id,
    stage_now: e.stage,
    location: locName[e.location_uuid] || e.location_uuid,
    location_slug: locSlug[e.location_uuid] || 'unknown',
    client: lead?.name || '(unknown)',
    client_email: lead?.email || null,
    client_id: e.client_id,
    quotes: eq.map(q => ({
      jobber_quote_id: q.jobber_quote_id,
      status: q.status,
      quote_url: q.quote_url,
      quote_created_at: q.created_at,
      quote_sent_at: q.sent_at,
    })),
    engagement_created_at: e.created_at,
    engagement_stage_entered_at: e.stage_entered_at,
    would_write: { stage: 'Closed Lost', closed_reason: 'quote_archived' },
  })
}

candidates.sort((a, b) => (a.location_slug || '').localeCompare(b.location_slug || ''))

// ── the write body, matching the live path (lib/engagements.ts) ──────────────
const nowIso = new Date().toISOString()
const CLOSED_NOTE = 'Closed automatically: the quote was archived in Jobber (#117).'
const closeBody = () => ({
  stage: 'Closed Lost',
  closed_reason: 'quote_archived',
  closed_at: nowIso,
  closed_note: CLOSED_NOTE,
  stage_entered_at: nowIso,
  updated_at: nowIso,
})

let closed = 0, blocked = 0
for (const r of candidates) {
  const head = `• [${r.location_slug}] ${r.client}  (eng ${r.engagement_id.slice(0, 8)}…, now: ${r.stage_now})`
  if (!EXECUTE) {
    console.log(head)
    for (const q of r.quotes) {
      console.log(`    quote ${q.jobber_quote_id}  status=${q.status}  created=${(q.quote_created_at || '').slice(0, 10)}  ${q.quote_url || ''}`)
    }
    continue
  }
  // EXECUTE: soft-close via UPDATE, guarded once more against a terminal race.
  const rows = await sbPatch(`engagements?id=eq.${r.engagement_id}&${NOT_TERMINAL_FILTER}`, closeBody())
  if (rows.length === 1) {
    closed++
    console.log(`✓ CLOSED  ${head}`)
  } else {
    blocked++
    console.log(`⤫ SKIPPED (terminal since read / already closed)  ${head}`)
  }
}

const byLoc = candidates.reduce((m, r) => (m[r.location_slug] = (m[r.location_slug] || 0) + 1, m), {})
console.log(`\n──────────────────────────────────────────`)
if (EXECUTE) {
  console.log(`CLOSED: ${closed} engagement(s) → Closed Lost / quote_archived`)
  if (blocked) console.log(`SKIPPED at write time (terminal race): ${blocked}`)
} else {
  console.log(`WOULD CLOSE: ${candidates.length} engagement(s) → Closed Lost / quote_archived`)
}
console.log(`  by location: ${JSON.stringify(byLoc)}`)
if (excludedCount) console.log(`  excluded by --exclude: ${excludedCount}`)
console.log(`(engagement_assignees never touched: soft-close only — UPDATE, never DELETE.)`)

writeFileSync('backfill-archived-quote-close.report.json', JSON.stringify({
  mode: EXECUTE ? 'execute' : 'dry_run',
  rule: 'all quotes archived, no jobs, no invoices, non-terminal → Closed Lost / quote_archived',
  candidate_count: candidates.length,
  ...(EXECUTE ? { closed, blocked_terminal_race: blocked } : {}),
  excluded_ids: [...excludeIds],
  excluded_count: excludedCount,
  by_location: byLoc,
  rows: candidates,
}, null, 2))
console.log('\nwrote backfill-archived-quote-close.report.json')
