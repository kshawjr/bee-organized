// ═══════════════════════════════════════════════════════════════════════════
// Engagement opened-date backfill (2026-07-24)
//
// Usage:
//   node scripts/backfill-engagement-dates.mjs [envfile] [--execute]
//        [--report path] [--include-held-out]
//
// DRY-RUN BY DEFAULT — zero writes unless --execute is passed.
//
// WHY: foundEngagement stamped created_at AND stage_entered_at with nowIso
// unconditionally until 91fd43c. Every bulk-imported engagement therefore
// reads "came in today" on the board while the Inbox (leads.created_at)
// ages correctly, and the 21-day pre-nurture cue is shifted by the import
// offset. The forward fix only covers foundings from 91fd43c onward; the
// already-founded prod rows need this pass.
//
// DATE RULES (modelled on scripts/backfill-engagements.mjs):
//   founded_by='request'  → the founding SR's requested_at (else its created_at)
//   founded_by='quote'    → the earliest attached quote's created_at
//   founded_by='job'      → the earliest attached job's created_at
//   founded_by='manual'   → SKIPPED (now IS the truth for a manual founding)
//   stage_entered_at      → last activity across the chain, NON-TERMINAL only
//
// DATES ONLY. This script never writes stage, closed_reason, closed_at,
// closed_note, or any money column. The engagements PATCH body is
// asserted against a whitelist before it leaves the process.
//
// SCOPE: Portland and Palm Beach are HELD OUT — their request-founded rows
// came from scripts/backfill-engagements.mjs and already carry the true
// date; their quote/job-founded cohort needs the founding-child
// distinction and is a separate decision. --include-held-out overrides.
//
// EXCLUSIONS (reported, never guessed): no founding child of the founding
// type, ambiguous founding child (>1 SR on a request-founded row with
// disagreeing dates), unknown/absent founded_by, a computed date outside
// the sanity window, and rows whose stage_entered_at already diverges from
// created_at (evidence of a real post-founding stage move — that timestamp
// is truth and is left alone; created_at is still corrected).
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'

// ── args / env ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const INCLUDE_HELD_OUT = args.includes('--include-held-out')
const reportIdx = args.indexOf('--report')
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--report')
const envPath = positional[0] || '.env.local'
const reportPath = reportIdx >= 0
  ? args[reportIdx + 1]
  : `backfill-engagement-dates.${EXECUTE ? 'run' : 'dryrun'}.json`

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    })
)
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !KEY) { console.error('missing supabase env in ' + envPath); process.exit(1) }
const H = { apikey: KEY, authorization: `Bearer ${KEY}` }

const NOW = Date.now()
const NOW_ISO = new Date(NOW).toISOString()
const ts = v => { const t = v ? new Date(v).getTime() : 0; return Number.isFinite(t) ? t : 0 }
const iso = ms => new Date(ms).toISOString()
const DAY = 24 * 60 * 60 * 1000

// Sanity window for any date this script would store. Jobber history for
// these accounts does not predate 2015; a future opened-date is never real.
const FLOOR = Date.parse('2015-01-01T00:00:00Z')

// Terminal stages — stage_entered_at on a closed row is the close moment
// and is not ours to move. (project_terminal_stage_values)
const TERMINAL = new Set(['Closed Won', 'Closed Lost'])

// Held out of the blanket pass — see header. ('Test Location' surfaced in
// the dry run outside the original six and was explicitly approved into
// scope on 2026-07-24 — it is NOT held out.)
const HELD_OUT_RE = /portland|palm\s*beach/i

// A real post-founding stage move vs the IMPORT'S OWN stage-advance.
// foundEngagement and the import's advanceEngagementStage are sequential
// writes in one request, so the import's stage_entered_at lands within
// seconds of created_at (measured: 3,913 of 4,061 rows under one minute,
// widest same-run straggler ~40min). Anything more than an hour after the
// founding postdates the import — a live webhook/drift advance whose
// timestamp is the truth. Those rows keep their stage_entered_at.
const REAL_MOVE_MS = 60 * 60 * 1000

// The only columns this script may ever write.
const WRITE_KEYS = new Set(['created_at', 'stage_entered_at'])

// ── fetch helpers ───────────────────────────────────────────────────────────

async function fetchAll(table, select, extra = '') {
  const out = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const r = await fetch(`${URL_}/rest/v1/${table}?select=${select}&order=id.asc${extra}`, {
      headers: { ...H, range: `${from}-${from + page - 1}` },
    })
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${await r.text()}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < page) break
  }
  return out
}

async function patch(table, filter, body) {
  for (const k of Object.keys(body)) {
    if (!WRITE_KEYS.has(k)) throw new Error(`REFUSING to write disallowed column "${k}"`)
  }
  const r = await fetch(`${URL_}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...H, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`PATCH ${table}?${filter}: HTTP ${r.status} ${await r.text()}`)
}

async function pool(items, worker, size = 8) {
  let i = 0
  const errors = []
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const item = items[i++]
      try { await worker(item) } catch (e) { errors.push({ id: item.id, error: String(e) }) }
    }
  }))
  return errors
}

// ── load ────────────────────────────────────────────────────────────────────

console.error(`mode: ${EXECUTE ? 'EXECUTE (writes!)' : 'dry-run (no writes)'}`)
console.error('loading tables…')

const [locations, engagements, srs, quotes, jobs, invoices] = await Promise.all([
  fetchAll('locations', 'id,location_id,name'),
  fetchAll('engagements', 'id,client_id,location_uuid,stage,founded_by,title,created_at,stage_entered_at,closed_at,closed_reason'),
  fetchAll('service_requests', 'id,engagement_id,requested_at,created_at'),
  fetchAll('quotes', 'id,engagement_id,created_at,sent_at,approved_at'),
  fetchAll('jobs', 'id,engagement_id,created_at,completed_at,scheduled_start'),
  fetchAll('invoices', 'id,engagement_id,created_at,issued_at,paid_at'),
])
console.error(`loaded: ${engagements.length} engagements, ${srs.length} SRs, ${quotes.length} quotes, ${jobs.length} jobs, ${invoices.length} invoices`)

const locByUuid = new Map(locations.map(l => [l.id, l]))
const locName = uuid => {
  const l = locByUuid.get(uuid)
  return l ? (l.name || l.location_id) : `UNKNOWN(${uuid ?? 'null'})`
}

const byEngagement = (rows) => {
  const m = new Map()
  for (const r of rows) {
    if (!r.engagement_id) continue
    if (!m.has(r.engagement_id)) m.set(r.engagement_id, [])
    m.get(r.engagement_id).push(r)
  }
  return m
}
const srByEng = byEngagement(srs)
const quoteByEng = byEngagement(quotes)
const jobByEng = byEngagement(jobs)
const invByEng = byEngagement(invoices)

// ── activity (same shape as scripts/backfill-engagements.mjs) ───────────────

const srActivity = s => ts(s.requested_at) || ts(s.created_at)
const quoteActivity = q => Math.max(ts(q.approved_at), ts(q.sent_at), ts(q.created_at))
// scheduled_start can legitimately be in the FUTURE (a booked visit). It
// still counts as chain activity, but a stored stage_entered_at in the
// future would read as a negative age everywhere — clamped below.
const jobActivity = j => Math.max(ts(j.completed_at), ts(j.scheduled_start), ts(j.created_at))
const invActivity = i => Math.max(ts(i.paid_at), ts(i.issued_at), ts(i.created_at))

// ── plan ────────────────────────────────────────────────────────────────────

const planned = []     // { id, loc, patch, before, after, ... }
const excluded = []    // { id, loc, reason, … }
const stageMoveProtected = []  // non-terminal rows whose stage_entered_at is a real move
const heldOut = {}
const perLoc = {}      // locName → tallies

const bump = (loc, key, n = 1) => {
  perLoc[loc] ??= {
    examined: 0, would_change: 0, created_at_changes: 0, stage_entered_at_changes: 0,
    unchanged: 0, excluded: 0, skipped_manual: 0, stage_moved_since_founding: 0,
    terminal_stage_entered_at_left_alone: 0, clamped_future_activity: 0,
  }
  perLoc[loc][key] += n
}

for (const e of engagements) {
  const loc = locName(e.location_uuid)

  if (!INCLUDE_HELD_OUT && HELD_OUT_RE.test(loc)) {
    heldOut[loc] ??= {}
    heldOut[loc][e.founded_by ?? 'null'] = (heldOut[loc][e.founded_by ?? 'null'] ?? 0) + 1
    continue
  }
  bump(loc, 'examined')

  // manual foundings: the founding moment IS the truth. Never touched.
  if (e.founded_by === 'manual') { bump(loc, 'skipped_manual'); bump(loc, 'unchanged'); continue }

  const eSrs = srByEng.get(e.id) ?? []
  const eQuotes = quoteByEng.get(e.id) ?? []
  const eJobs = jobByEng.get(e.id) ?? []
  const eInvs = invByEng.get(e.id) ?? []

  // ── founding date: the founding child of the founded_by type ──────────
  let openedMs = 0
  let source = null
  if (e.founded_by === 'request') {
    if (eSrs.length === 0) {
      excluded.push({ id: e.id, loc, founded_by: e.founded_by, reason: 'no_founding_service_request' })
      bump(loc, 'excluded'); continue
    }
    const dated = eSrs.map(srActivity).filter(Boolean)
    if (dated.length === 0) {
      excluded.push({ id: e.id, loc, founded_by: e.founded_by, reason: 'founding_service_request_has_no_date', srIds: eSrs.map(s => s.id) })
      bump(loc, 'excluded'); continue
    }
    // >1 SR on one engagement is off-model (hub-and-spoke is 1:1). If they
    // disagree the founding SR is ambiguous — exclude rather than guess.
    if (eSrs.length > 1 && new Set(dated.map(d => iso(d).slice(0, 10))).size > 1) {
      excluded.push({
        id: e.id, loc, founded_by: e.founded_by, reason: 'ambiguous_multiple_service_requests',
        srIds: eSrs.map(s => s.id), dates: dated.map(iso),
      })
      bump(loc, 'excluded'); continue
    }
    openedMs = Math.min(...dated)
    source = 'service_requests.requested_at'
  } else if (e.founded_by === 'quote' || e.founded_by === 'job') {
    const kids = e.founded_by === 'quote' ? eQuotes : eJobs
    const dated = kids.map(k => ts(k.created_at)).filter(Boolean)
    if (dated.length === 0) {
      excluded.push({
        id: e.id, loc, founded_by: e.founded_by,
        reason: kids.length === 0 ? `no_founding_${e.founded_by}_attached` : `founding_${e.founded_by}_has_no_created_at`,
      })
      bump(loc, 'excluded'); continue
    }
    openedMs = Math.min(...dated)   // earliest attached child of that type
    source = `${e.founded_by === 'quote' ? 'quotes' : 'jobs'}.created_at (earliest)`
  } else {
    excluded.push({ id: e.id, loc, founded_by: e.founded_by ?? null, reason: 'unknown_founded_by' })
    bump(loc, 'excluded'); continue
  }

  if (!(openedMs >= FLOOR) || openedMs > NOW) {
    excluded.push({
      id: e.id, loc, founded_by: e.founded_by, reason: 'computed_date_out_of_sanity_window',
      computed: iso(openedMs),
    })
    bump(loc, 'excluded'); continue
  }

  // ── stage_entered_at: last chain activity, NON-TERMINAL rows only ──────
  const terminal = TERMINAL.has(e.stage)
  if (terminal) bump(loc, 'terminal_stage_entered_at_left_alone')
  // Divergence beyond the import window = a live stage move stamped it.
  const foundingGapMs = ts(e.stage_entered_at) - ts(e.created_at)
  const movedSinceFounding = foundingGapMs > REAL_MOVE_MS
  if (movedSinceFounding) {
    bump(loc, 'stage_moved_since_founding')
    if (!terminal) {
      stageMoveProtected.push({
        id: e.id, loc, stage: e.stage, gap_hours: Math.round(foundingGapMs / 36e5),
        stage_entered_at: e.stage_entered_at, created_at: e.created_at,
      })
    }
  }

  let lastActivityMs = 0
  if (!terminal && !movedSinceFounding) {
    lastActivityMs = Math.max(
      openedMs,
      0, ...eQuotes.map(quoteActivity),
      ...eJobs.map(jobActivity),
      ...eInvs.map(invActivity),
    )
    if (lastActivityMs > NOW) { lastActivityMs = NOW; bump(loc, 'clamped_future_activity') }
    if (lastActivityMs < openedMs) lastActivityMs = openedMs
  }

  // ── diff ──────────────────────────────────────────────────────────────
  const body = {}
  if (ts(e.created_at) !== openedMs) { body.created_at = iso(openedMs); bump(loc, 'created_at_changes') }
  if (lastActivityMs && ts(e.stage_entered_at) !== lastActivityMs) {
    body.stage_entered_at = iso(lastActivityMs); bump(loc, 'stage_entered_at_changes')
  }
  if (Object.keys(body).length === 0) { bump(loc, 'unchanged'); continue }

  bump(loc, 'would_change')
  planned.push({
    id: e.id, loc, founded_by: e.founded_by, stage: e.stage, terminal,
    source, patch: body,
    before: { created_at: e.created_at, stage_entered_at: e.stage_entered_at },
    after: { created_at: body.created_at ?? e.created_at, stage_entered_at: body.stage_entered_at ?? e.stage_entered_at },
    shift_days: Math.round((ts(e.created_at) - openedMs) / DAY),
  })
}

// ── report ──────────────────────────────────────────────────────────────────

const exclusionsByReason = {}
for (const x of excluded) {
  exclusionsByReason[x.reason] ??= { count: 0, by_location: {}, sample_ids: [] }
  const b = exclusionsByReason[x.reason]
  b.count++
  b.by_location[x.loc] = (b.by_location[x.loc] ?? 0) + 1
  if (b.sample_ids.length < 5) b.sample_ids.push(x.id)
}

const samplesByLoc = {}
for (const p of planned) {
  samplesByLoc[p.loc] ??= []
  if (samplesByLoc[p.loc].length < 5) {
    samplesByLoc[p.loc].push({
      id: p.id, founded_by: p.founded_by, stage: p.stage, source: p.source,
      created_at: `${p.before.created_at}  →  ${p.after.created_at}`,
      stage_entered_at: p.patch.stage_entered_at
        ? `${p.before.stage_entered_at}  →  ${p.after.stage_entered_at}`
        : `${p.before.stage_entered_at}  (unchanged: ${p.terminal ? 'terminal row' : 'no change / real stage move'})`,
      shift_days: p.shift_days,
    })
  }
}

// Shift distribution — how far back the opened-date moves.
const buckets = { '0': 0, '1-7': 0, '8-30': 0, '31-180': 0, '181-365': 0, '365+': 0, 'forward(<0)': 0 }
for (const p of planned) {
  const d = p.shift_days
  if (d < 0) buckets['forward(<0)']++
  else if (d === 0) buckets['0']++
  else if (d <= 7) buckets['1-7']++
  else if (d <= 30) buckets['8-30']++
  else if (d <= 180) buckets['31-180']++
  else if (d <= 365) buckets['181-365']++
  else buckets['365+']++
}

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  generated_at: NOW_ISO,
  scope: {
    held_out: INCLUDE_HELD_OUT ? 'NONE (--include-held-out)' : 'Portland, Palm Beach',
    held_out_rows_skipped: heldOut,
    locations_in_scope: Object.keys(perLoc).sort(),
  },
  totals: {
    engagements_examined: Object.values(perLoc).reduce((s, v) => s + v.examined, 0),
    would_change: planned.length,
    created_at_writes: planned.filter(p => p.patch.created_at).length,
    stage_entered_at_writes: planned.filter(p => p.patch.stage_entered_at).length,
    unchanged: Object.values(perLoc).reduce((s, v) => s + v.unchanged, 0),
    excluded: excluded.length,
    stage_entered_at_protected_real_move: stageMoveProtected.length,
  },
  per_location: perLoc,
  shift_distribution_days: buckets,
  exclusions_by_reason: exclusionsByReason,
  stage_entered_at_protected_sample: stageMoveProtected.slice(0, 10),
  samples_by_location: samplesByLoc,
}

console.log('\n== engagement opened-date backfill plan ==')
console.log(JSON.stringify({
  ...report, samples_by_location: undefined, exclusions_by_reason: undefined,
  stage_entered_at_protected_sample: undefined,
}, null, 2))
writeFileSync(reportPath, JSON.stringify({ ...report, excluded, stageMoveProtected, planned }, null, 2))
console.log(`\nexclusions: ${excluded.length} (by reason + samples in report)`)
console.log(`report written: ${reportPath}`)

if (!EXECUTE) {
  console.log('\nDRY RUN — no writes performed. Re-run with --execute after review.')
  process.exit(0)
}

// ── execute ─────────────────────────────────────────────────────────────────

// Pre-write snapshot of every field this pass must NOT move.
const stageSnapshot = new Map(engagements.map(e => [e.id, JSON.stringify({
  stage: e.stage, closed_at: e.closed_at, closed_reason: e.closed_reason, title: e.title,
  client_id: e.client_id, location_uuid: e.location_uuid, founded_by: e.founded_by,
})]))

console.log(`\nEXECUTING: patching ${planned.length} engagements (dates only)…`)
let done = 0
const writeErrors = await pool(planned, async (p) => {
  await patch('engagements', `id=eq.${p.id}`, p.patch)
  done++
  if (done % 250 === 0) console.log(`  ${done}/${planned.length}`)
})

console.log(`\nwrote ${done}/${planned.length}; errors: ${writeErrors.length}`)

// ── verify: re-read and confirm ──────────────────────────────────────────────

console.log('\nre-reading engagements to verify…')
const after = await fetchAll('engagements', 'id,client_id,location_uuid,stage,founded_by,title,created_at,stage_entered_at,closed_at,closed_reason')
const afterById = new Map(after.map(e => [e.id, e]))

const plannedById = new Map(planned.map(p => [p.id, p]))
const verify = {
  rows_confirmed: 0,
  rows_mismatched: [],
  stage_or_meta_drift: [],
  per_location_confirmed: {},
}
for (const [id, snap] of stageSnapshot) {
  const a = afterById.get(id)
  if (!a) { verify.stage_or_meta_drift.push({ id, issue: 'row_missing_after_write' }); continue }
  const nowSnap = JSON.stringify({
    stage: a.stage, closed_at: a.closed_at, closed_reason: a.closed_reason, title: a.title,
    client_id: a.client_id, location_uuid: a.location_uuid, founded_by: a.founded_by,
  })
  if (nowSnap !== snap) verify.stage_or_meta_drift.push({ id, before: JSON.parse(snap), after: JSON.parse(nowSnap) })
}
for (const p of plannedById.values()) {
  const a = afterById.get(p.id)
  if (!a) continue
  const okCreated = !p.patch.created_at || ts(a.created_at) === ts(p.patch.created_at)
  const okStage = !p.patch.stage_entered_at || ts(a.stage_entered_at) === ts(p.patch.stage_entered_at)
  if (okCreated && okStage) {
    verify.rows_confirmed++
    verify.per_location_confirmed[p.loc] = (verify.per_location_confirmed[p.loc] ?? 0) + 1
  } else {
    verify.rows_mismatched.push({ id: p.id, expected: p.patch, actual: { created_at: a.created_at, stage_entered_at: a.stage_entered_at } })
  }
}

console.log('\n== verification ==')
console.log(JSON.stringify({
  rows_confirmed: verify.rows_confirmed,
  rows_mismatched: verify.rows_mismatched.length,
  stage_or_meta_drift: verify.stage_or_meta_drift.length,
  per_location_confirmed: verify.per_location_confirmed,
}, null, 2))

writeFileSync(reportPath.replace(/\.json$/, '.verify.json'),
  JSON.stringify({ verify, writeErrors }, null, 2))

if (writeErrors.length || verify.rows_mismatched.length || verify.stage_or_meta_drift.length) {
  console.error('\nISSUES FOUND — see the .verify.json report. Re-run is safe (idempotent).')
  for (const e of writeErrors.slice(0, 10)) console.error(`  ${e.id}: ${e.error}`)
  process.exit(3)
}
console.log('\nDONE — all writes confirmed, zero stage/meta drift.')
