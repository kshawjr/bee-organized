// ═══════════════════════════════════════════════════════════════════════════
// #121 / #66 — Stale service_requests scanner + cleanup. DRY RUN BY DEFAULT.
//
// REQUEST_DESTROY historically nulled the lead's linkage columns but left the
// service_requests mirror behind — a phantom "Request" on the engagement card.
// The going-forward fix lives in lib/jobber-webhook-handlers.ts; this script
// finds the rows that were ALREADY orphaned before the fix shipped and, under
// --execute, applies the exact same cleanup the handler now does live.
//
// WHY A JOBBER CHECK IS REQUIRED
// A stale SR is NOT detectable in-DB:
//   • service_requests.status is uniformly 'active' (never varied — write-only)
//   • leads.jobber_request_id is null for ~all leads (only Send-to-Jobber sets
//     it), so it is not a destroy signature
//   • every SR carries a jobber_request_id whether or not the request still
//     exists in Jobber
// The only reliable test is asking Jobber: request(id) returning not-found ⇒
// the request was deleted ⇒ our SR is stale. LIVE-in-Jobber rows are normal
// pending requests and are NEVER touched.
//
// CANDIDATE SCOPING (identical to the #66 handler's guards)
// The phantom only matters on engagements still at stage='Request' founded_by
// ='request' (an advanced engagement's SR is legitimate history). Those are the
// candidates checked here. Manual containers (founded_by='manual', the known
// #66 no-SR engagements) are excluded by the founded_by filter, and any SR with
// a downstream quote/job/invoice (by service_request_id) is skipped — childless
// SRs only.
//
// WHAT --execute DOES (mirrors cleanupDestroyedRequest in
// lib/jobber-webhook-handlers.ts — keep in sync). For each CONFIRMED-STALE,
// childless candidate:
//   1. delete assessments where service_request_id = sr.id   (FK child first)
//   2. delete the service_requests row
//   3. if the founding engagement (founded_by='request') is left with NO other
//      children (no SR/quote/job/invoice by engagement_id) and is non-terminal,
//      SOFT-CLOSE it: stage='Closed Lost', closed_reason='request_destroyed'.
//      Engagements are NEVER deleted — engagement_assignees is ON DELETE
//      CASCADE, so a delete would erase the crew (the #66 trap). Manual
//      containers, engagements with other children, and already-terminal
//      engagements are left exactly as-is.
//
// GUARDS RE-RUN AT EXECUTE TIME: every run recomputes candidates from LIVE data
// (DB candidate query + childless re-check + live Jobber request(id) probe) —
// there is no report file consumed as input. A request restored in Jobber
// between scan and execute verifies LIVE and is skipped.
//
// Usage:  node scripts/scan-stale-service-requests.mjs                    # dry run, verify vs Jobber
//         node scripts/scan-stale-service-requests.mjs --refresh          # allow token rotation (needed for expired-token locs)
//         node scripts/scan-stale-service-requests.mjs --no-jobber        # list candidates only (no verify)
//         node scripts/scan-stale-service-requests.mjs --location loc_kc  # scope to one location
//         node scripts/scan-stale-service-requests.mjs --refresh --execute            # ⚠ WRITES: delete stale SRs + soft-close
//         node scripts/scan-stale-service-requests.mjs --refresh --execute \
//              --exclude=<sr-id|req-id|eng-id>,<...>                      # hold specific rows back
//         (--exclude may also be spelled  --exclude <ids>  and may repeat.)
// Flags:  --env <path>   env file (default .env.local — run from repo root)
//
// Dry run is READ-ONLY against our DB. --refresh MAY rotate a location's Jobber
// token (a locations-row write) exactly like trace-job.mjs. --execute is the
// ONLY mode that deletes stale SRs / soft-closes engagements — never before.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const flagVal = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null }

const EXECUTE = flag('--execute')
// --exclude accepts SR ids, Jobber request ids, OR engagement ids. Spellings
// --exclude=a,b and --exclude a,b are both honoured and may repeat.
const excludeIds = new Set()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--exclude') (argv[i + 1] || '').split(',').forEach(s => s.trim() && excludeIds.add(s.trim()))
  else if (a.startsWith('--exclude=')) a.slice('--exclude='.length).split(',').forEach(s => s.trim() && excludeIds.add(s.trim()))
}
const isExcluded = (c) =>
  excludeIds.has(c.id) || excludeIds.has(String(c.jobber_request_id)) || excludeIds.has(c.engagements?.id)

const env = Object.fromEntries(
  readFileSync(flagVal('--env') || '.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('missing supabase env — run from repo root or pass --env <path>')
  process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const onlyLocation = flagVal('--location')

// ── 1. Candidate SRs: on a Request-stage, request-founded engagement ────────
let q = sb
  .from('service_requests')
  .select('id, jobber_request_id, requested_at, created_at, location_id, lead_id, ' +
          'engagements!inner(id, stage, founded_by), leads!inner(name)')
  .eq('engagements.stage', 'Request')
  .eq('engagements.founded_by', 'request')
if (onlyLocation) q = q.eq('location_id', onlyLocation)

const { data: candidatesRaw, error } = await q
if (error) { console.error('candidate query failed:', error.message); process.exit(1) }

// Exclude any SR that has downstream work (quote/job/invoice by
// service_request_id) — those are real history, never stale. Matches the
// handler's hasChildWork guard.
const candidates = []
for (const sr of (candidatesRaw || [])) {
  const [{ data: qz }, { data: jz }, { data: iz }] = await Promise.all([
    sb.from('quotes').select('id').eq('service_request_id', sr.id).limit(1),
    sb.from('jobs').select('id').eq('service_request_id', sr.id).limit(1),
    sb.from('invoices').select('id').eq('service_request_id', sr.id).limit(1),
  ])
  if ((qz?.length || 0) + (jz?.length || 0) + (iz?.length || 0) === 0) candidates.push(sr)
}

// Hold back any rows Kevin named on --exclude (matched on SR / request / eng id).
const heldBack = candidates.filter(isExcluded)
const scanSet = candidates.filter(c => !isExcluded(c))

console.log('═══════════════════════════════════════════════════════════════')
console.log(`#121/#66 STALE service_requests — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'}`)
console.log(`Candidates (Request-stage, request-founded, childless SR): ${candidates.length}`)
if (excludeIds.size) console.log(`Excluded by --exclude: ${heldBack.length} row(s) (ids: ${[...excludeIds].join(', ')})`)
if (onlyLocation) console.log(`Scope: location ${onlyLocation}`)
console.log('═══════════════════════════════════════════════════════════════')

if (scanSet.length === 0) process.exit(0)

// ── 2. Verify each candidate against Jobber (unless --no-jobber) ─────────────
const byLoc = {}
for (const c of scanSet) (byLoc[c.location_id] ||= []).push(c)

const print = (c, verdict) => {
  console.log(
    `  [${verdict.padEnd(18)}] loc=${c.location_id}  req=${c.jobber_request_id}  ` +
    `client="${c.leads?.name ?? '—'}"  sr=${c.id}  eng=${c.engagements?.id}\n` +
    `                        requested_at=${c.requested_at ?? '—'}  created_at=${c.created_at ?? '—'}`,
  )
}

if (flag('--no-jobber')) {
  if (EXECUTE) { console.error('refusing to --execute with --no-jobber: the live Jobber check is a required guard'); process.exit(1) }
  console.log('\nJOBBER CHECK: skipped (--no-jobber) — listing candidates only:\n')
  for (const c of scanSet) print(c, 'candidate')
  console.log(`\nDRY RUN complete. ${scanSet.length} candidate(s). Nothing was modified.`)
  process.exit(0)
}

const JOBBER_URL = 'https://api.getjobber.com/api/graphql'
const JOBBER_VERSION = '2025-04-16'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const encodeJobberId = (type, numeric) =>
  Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')

async function jobberQuery(token, query, variables) {
  const res = await fetch(JOBBER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  })
  const result = await res.json().catch(() => ({}))
  if (result?.errors?.some(e => e.extensions?.code === 'THROTTLED')) {
    await sleep(15000)
    return jobberQuery(token, query, variables)
  }
  return result
}

// Ports getValidJobberToken (lib/jobber.ts); refresh gated behind --refresh
// because the rotation is a locations-row write.
async function getValidToken(location) {
  const expiry = location.token_expiry ? parseInt(location.token_expiry) : 0
  if (expiry && Date.now() < expiry - 5 * 60 * 1000) return location.jobber_access_token
  const test = await jobberQuery(location.jobber_access_token, '{ account { id } }')
  if (test?.data?.account?.id) return location.jobber_access_token
  if (!flag('--refresh')) return null
  const res = await fetch('https://api.getjobber.com/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.JOBBER_CLIENT_ID,
      client_secret: env.JOBBER_CLIENT_SECRET,
      refresh_token: location.jobber_refresh_token,
    }),
  })
  const tokens = await res.json().catch(() => null)
  if (!res.ok || !tokens?.access_token) return null
  const expiryMs = Date.now() + 55 * 60 * 1000
  // MUST NOT be swallowed: Jobber rotates refresh tokens — losing this write
  // orphans the new refresh token and breaks the location's connection.
  const { error: wErr } = await sb.from('locations').update({
    jobber_access_token: tokens.access_token,
    jobber_refresh_token: tokens.refresh_token,
    token_expiry: expiryMs,
    token_expiry_display: new Date(expiryMs).toISOString().slice(0, 19),
    updated_at: new Date().toISOString(),
  }).eq('location_id', location.location_id)
  if (wErr) throw new Error(`token rotation write failed: ${wErr.message}`)
  return tokens.access_token
}

const REQUEST_QUERY = `query($id: EncodedId!) { request(id: $id) { id } }`

// Existence probe (select+limit(1), NOT count(): PostgREST aggregates disabled).
async function anyRows(table, col, val) {
  const { data, error } = await sb.from(table).select('id').eq(col, val).limit(1)
  if (error) throw new Error(`${table}.${col} check: ${error.message}`)
  return (data?.length ?? 0) > 0
}

// ── EXECUTE cleanup for one CONFIRMED-STALE candidate ────────────────────────
// Byte-for-byte the same decisions as cleanupDestroyedRequest in
// lib/jobber-webhook-handlers.ts. Re-runs the childless guard live right before
// the delete (belt to the candidate-build check) and only ever soft-closes.
const nowIso = () => new Date().toISOString()
async function cleanupStaleSR(c) {
  const srId = c.id
  // Re-verify childless at write time — a quote/job/invoice could have attached
  // since the candidate query. If so this SR is real history: leave everything.
  const hasChildWork =
    (await anyRows('quotes', 'service_request_id', srId)) ||
    (await anyRows('jobs', 'service_request_id', srId)) ||
    (await anyRows('invoices', 'service_request_id', srId))
  if (hasChildWork) return { label: 'kept (gained child work since scan)', srDeleted: false }

  // Drop the SR's assessment mirror first (FK), then the SR row itself.
  const { error: aErr } = await sb.from('assessments').delete().eq('service_request_id', srId)
  if (aErr) throw new Error(`assessment delete: ${aErr.message}`)
  const { error: dErr } = await sb.from('service_requests').delete().eq('id', srId)
  if (dErr) throw new Error(`SR delete: ${dErr.message}`)

  const engId = c.engagements?.id
  if (!engId) return { label: 'deleted SR (no engagement)', srDeleted: true }

  // Re-read the engagement live — it may have advanced/closed since the scan.
  const { data: eng, error: eErr } = await sb.from('engagements')
    .select('id, stage, founded_by').eq('id', engId).maybeSingle()
  if (eErr) throw new Error(`engagement read: ${eErr.message}`)
  if (!eng) return { label: 'deleted SR (engagement gone)', srDeleted: true }
  if (eng.founded_by !== 'request')
    return { label: `deleted SR; eng left (founded_by=${eng.founded_by})`, srDeleted: true }

  // Any other work still hanging off the engagement → leave it, stage untouched.
  const stillHasChildren =
    (await anyRows('service_requests', 'engagement_id', engId)) ||
    (await anyRows('quotes', 'engagement_id', engId)) ||
    (await anyRows('jobs', 'engagement_id', engId)) ||
    (await anyRows('invoices', 'engagement_id', engId))
  if (stillHasChildren)
    return { label: 'deleted SR; eng left (other children remain)', srDeleted: true }

  if (eng.stage === 'Closed Won' || eng.stage === 'Closed Lost')
    return { label: `deleted SR; eng already ${eng.stage}`, srDeleted: true }

  // Nothing left to represent → SOFT-close. Never delete (assignee cascade).
  const ts = nowIso()
  const { error: uErr } = await sb.from('engagements').update({
    stage: 'Closed Lost',
    closed_reason: 'request_destroyed',
    closed_at: ts,
    closed_note: 'Founding Jobber request was deleted; no other work on this engagement.',
    stage_entered_at: ts,
    updated_at: ts,
  }).eq('id', engId)
  if (uErr) throw new Error(`engagement close: ${uErr.message}`)
  return { label: 'deleted SR; soft-closed empty engagement (request_destroyed)', srDeleted: true, engClosed: true }
}

let stale = 0, live = 0, skipped = 0
let srDeleted = 0, engClosed = 0, engLeft = 0
for (const [locId, rows] of Object.entries(byLoc)) {
  const { data: loc } = await sb.from('locations')
    .select('location_id, jobber_access_token, jobber_refresh_token, token_expiry')
    .eq('location_id', locId).maybeSingle()
  console.log(`\n── ${locId} (${rows.length} candidate(s)) ──`)
  if (!loc?.jobber_access_token) {
    console.log('  no Jobber connection — cannot verify; skipping (not touched):')
    for (const c of rows) { print(c, 'unverified (no conn)'); skipped++ }
    continue
  }
  const token = await getValidToken(loc)
  if (!token) {
    console.log('  token expired — re-run with --refresh to rotate; skipping (not touched):')
    for (const c of rows) { print(c, 'unverified (expired)'); skipped++ }
    continue
  }
  for (const c of rows) {
    const res = await jobberQuery(token, REQUEST_QUERY, { id: encodeJobberId('Request', c.jobber_request_id) })
    const node = res?.data?.request
    if (node) { print(c, 'live in Jobber'); live++; continue }
    // CONFIRMED STALE (request not-found in Jobber).
    stale++
    if (!EXECUTE) { print(c, 'STALE (gone)'); continue }
    const outcome = await cleanupStaleSR(c)
    print(c, 'STALE → cleaned')
    console.log(`                        ${outcome.label}`)
    if (outcome.srDeleted) srDeleted++
    if (outcome.engClosed) engClosed++
    else if (outcome.srDeleted && c.engagements?.id) engLeft++
  }
}

console.log('\n═══════════════════════════════════════════════════════════════')
console.log(EXECUTE ? '⚠ EXECUTE complete — writes applied.' : 'DRY RUN complete — nothing was modified.')
console.log(`  STALE (confirmed deleted in Jobber): ${stale}`)
console.log(`  live in Jobber (leave alone):        ${live}`)
console.log(`  unverified (no conn / expired token): ${skipped}`)
if (heldBack.length) console.log(`  held back by --exclude:              ${heldBack.length}`)
if (EXECUTE) {
  console.log(`  ── writes ──`)
  console.log(`  stale SRs deleted:                   ${srDeleted}`)
  console.log(`  engagements soft-closed:             ${engClosed}`)
  console.log(`  engagements left (SR gone, kept):    ${engLeft}`)
  console.log(`  (engagement_assignees never touched — soft-close only, never DELETE.)`)
} else {
  console.log('\nReview the STALE rows above, then re-run with --refresh --execute to apply.')
}
console.log('═══════════════════════════════════════════════════════════════')
