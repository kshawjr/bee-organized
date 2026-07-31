// ═══════════════════════════════════════════════════════════════════════════
// #66 — Stale service_requests scanner. DRY RUN ONLY (no --execute path).
//
// REQUEST_DESTROY historically nulled the lead's linkage columns but left the
// service_requests mirror behind — a phantom "Request" on the engagement card.
// The going-forward fix lives in lib/jobber-webhook-handlers.ts; this script
// lists the rows that were ALREADY orphaned before the fix shipped, for Kevin
// to review before anything is removed.
//
// WHY A JOBBER CHECK IS REQUIRED
// A stale SR is NOT detectable in-DB:
//   • service_requests.status is uniformly 'active' (never varied — write-only)
//   • leads.jobber_request_id is null for ~all leads (only Send-to-Jobber sets
//     it), so it is not a destroy signature
//   • every SR carries a jobber_request_id whether or not the request still
//     exists in Jobber
// The only reliable test is asking Jobber: request(id) returning not-found ⇒
// the request was deleted ⇒ our SR is stale.
//
// CANDIDATE SCOPING
// The phantom only matters on engagements still at stage='Request' founded_by
// ='request' (an advanced engagement's SR is legitimate history). Those are the
// candidates checked here (~55 in prod at time of writing). Manual containers
// (founded_by='manual', the known #66 no-SR engagements) are excluded by the
// founded_by filter, and any SR with a downstream quote/job/invoice is skipped.
//
// Usage:  node scripts/scan-stale-service-requests.mjs            # verify vs Jobber
//         node scripts/scan-stale-service-requests.mjs --refresh  # allow token rotation
//         node scripts/scan-stale-service-requests.mjs --no-jobber# list candidates only
//         node scripts/scan-stale-service-requests.mjs --location loc_portland
// Flags:  --env <path>   env file (default .env.local — run from repo root)
//
// READ-ONLY against our DB. With --refresh it MAY rotate a location's Jobber
// token (a locations-row write) exactly like trace-job.mjs — never any delete.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const flagVal = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null }

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

console.log('═══════════════════════════════════════════════════════════════')
console.log(`#66 STALE service_requests SCAN — DRY RUN (no deletes)`)
console.log(`Candidates (Request-stage, request-founded, childless SR): ${candidates.length}`)
if (onlyLocation) console.log(`Scope: location ${onlyLocation}`)
console.log('═══════════════════════════════════════════════════════════════')

if (candidates.length === 0) process.exit(0)

// ── 2. Verify each candidate against Jobber (unless --no-jobber) ─────────────
const byLoc = {}
for (const c of candidates) (byLoc[c.location_id] ||= []).push(c)

const print = (c, verdict) => {
  console.log(
    `  [${verdict.padEnd(18)}] loc=${c.location_id}  req=${c.jobber_request_id}  ` +
    `client="${c.leads?.name ?? '—'}"  sr=${c.id}  eng=${c.engagements?.id}\n` +
    `                        requested_at=${c.requested_at ?? '—'}  created_at=${c.created_at ?? '—'}`,
  )
}

if (flag('--no-jobber')) {
  console.log('\nJOBBER CHECK: skipped (--no-jobber) — listing candidates only:\n')
  for (const c of candidates) print(c, 'candidate')
  console.log(`\nDRY RUN complete. ${candidates.length} candidate(s). Nothing was modified.`)
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

let stale = 0, live = 0, skipped = 0
for (const [locId, rows] of Object.entries(byLoc)) {
  const { data: loc } = await sb.from('locations')
    .select('location_id, jobber_access_token, jobber_refresh_token, token_expiry')
    .eq('location_id', locId).maybeSingle()
  console.log(`\n── ${locId} (${rows.length} candidate(s)) ──`)
  if (!loc?.jobber_access_token) {
    console.log('  no Jobber connection — cannot verify; listing as candidates:')
    for (const c of rows) { print(c, 'candidate (no conn)'); skipped++ }
    continue
  }
  const token = await getValidToken(loc)
  if (!token) {
    console.log('  token expired — re-run with --refresh to rotate; listing as candidates:')
    for (const c of rows) { print(c, 'candidate (expired)'); skipped++ }
    continue
  }
  for (const c of rows) {
    const res = await jobberQuery(token, REQUEST_QUERY, { id: encodeJobberId('Request', c.jobber_request_id) })
    const node = res?.data?.request
    if (!node) { print(c, 'STALE (gone)'); stale++ }
    else { print(c, 'live in Jobber'); live++ }
  }
}

console.log('\n═══════════════════════════════════════════════════════════════')
console.log(`DRY RUN complete — nothing was modified.`)
console.log(`  STALE (confirmed deleted in Jobber): ${stale}`)
console.log(`  live in Jobber (leave alone):        ${live}`)
console.log(`  unverified (no conn / expired token): ${skipped}`)
console.log('═══════════════════════════════════════════════════════════════')
console.log('Review the STALE rows above. No --execute path ships in this commit.')
