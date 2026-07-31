// ═══════════════════════════════════════════════════════════════════════════
// #122 — Jobber archive backfill scout. DRY RUN ONLY — writes NOTHING, EVER.
//
// Archiving in Jobber emits a bare REQUEST_UPDATE / CLIENT_UPDATE and the
// archive state (Request.requestStatus 'archived', Client.isArchived) was never
// fetched, so every archive that happened BEFORE the #122 handler shipped left
// our mirror untouched. This script lists that backlog:
//   • service_requests whose Jobber request is archived  (the request path —
//     the live handler now cleans these on the next REQUEST_UPDATE, but old
//     archives may never fire another webhook)
//   • leads whose Jobber client is archived              (the client path —
//     HELD pending Kevin's engagement decision; listed here for scope only)
//
// There is NO --execute path. This script only reads and prints. Reconciliation
// (if any) will be a separate, deliberately-authored step once the client-path
// policy is settled.
//
// COST / BOUNDING — the key design choice:
//   Jobber's root connections take a server-side archive filter
//   (introspected live, API 2025-04-16):
//       clients(filter: { isArchived: true })
//       requests(filter: { status: archived })
//   so we page ONLY the archived subset (50/page), never the whole client/
//   request book. Cost per location ≈ ceil(archivedClients/50) +
//   ceil(archivedRequests/50) paginated reads, plus a handful of cheap local
//   childless probes for the matched SRs. Throttle-aware pacing reads Jobber's
//   own restoreRate and waits when the bucket runs low. Bound the run with
//   --loc <slug> (one location) and --max-pages <n> (hard page cap per
//   connection, default 200 = 10k archived records).
//
// READ-ONLY TOKENS: uses each location's STORED access token as-is and NEVER
// refreshes (refreshing rotates the production token columns — a write). A
// location whose token is stale (401) is SKIPPED and reported, never renewed.
// Same stance as scripts/introspect-jobber-schema.mjs.
//
// Usage:
//   node scripts/backfill-jobber-archived.mjs                 # all connected locations
//   node scripts/backfill-jobber-archived.mjs --loc loc_test  # one location
//   node scripts/backfill-jobber-archived.mjs --max-pages 20  # tighter page cap
//   node scripts/backfill-jobber-archived.mjs --env ../../.env.local
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const flag = (k, d = null) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d }
const LOC = flag('--loc')
const MAX_PAGES = parseInt(flag('--max-pages', '200'), 10)
const JOBBER_VERSION = '2025-04-16'

const env = Object.fromEntries(
  readFileSync(flag('--env', '.env.local'), 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('missing supabase env — run from repo root or pass --env <path>')
  process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// ── Jobber (throttle-aware, read-only) ──────────────────────────────────────
let bucket = { currentlyAvailable: 10000, restoreRate: 500 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function jobber(token, query, variables) {
  // Pre-pace: if the bucket is low, wait for it to refill before spending.
  if (bucket.currentlyAvailable < 200) {
    const waitMs = Math.ceil(((200 - bucket.currentlyAvailable) / bucket.restoreRate + 0.3) * 1000)
    await sleep(waitMs)
  }
  const res = await fetch('https://api.getjobber.com/api/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (res.status === 401) return { unauthorized: true }
  const json = await res.json()
  const ts = json?.extensions?.cost?.throttleStatus
  if (ts) bucket = { currentlyAvailable: ts.currentlyAvailable, restoreRate: ts.restoreRate }
  return json
}

const numericOf = gid => {
  if (!gid) return null
  if (/^\d+$/.test(gid)) return gid
  try { return (Buffer.from(gid, 'base64').toString('utf8').match(/\/(\d+)$/) || [])[1] || null }
  catch { return null }
}

const ARCHIVED_CLIENTS_Q = `
  query ArchivedClients($after: String) {
    clients(filter: { isArchived: true }, first: 50, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }`
const ARCHIVED_REQUESTS_Q = `
  query ArchivedRequests($after: String) {
    requests(filter: { status: archived }, first: 50, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }`

// Page a filtered connection to numeric ids. Returns { ids, truncated }.
async function pageIds(token, query, connKey) {
  const ids = []
  let after = null, pages = 0, truncated = false
  for (;;) {
    const r = await jobber(token, query, { after })
    if (r?.unauthorized) return { unauthorized: true }
    if (r?.errors?.length) throw new Error(`${connKey}: ${r.errors[0]?.message || 'gql error'}`)
    const conn = r?.data?.[connKey]
    for (const n of conn?.nodes || []) { const num = numericOf(n.id); if (num) ids.push(num) }
    pages++
    if (!conn?.pageInfo?.hasNextPage) break
    if (pages >= MAX_PAGES) { truncated = true; break }
    after = conn.pageInfo.endCursor
  }
  return { ids, truncated }
}

// Local existence probe (PostgREST aggregates are disabled — select+limit(1)).
async function anyRows(table, col, val) {
  const { data } = await sb.from(table).select('id').eq(col, val).limit(1)
  return (data?.length ?? 0) > 0
}

async function run() {
  let q = sb
    .from('locations')
    .select('location_id, jobber_connected, jobber_access_token, jobber_refresh_token, token_expiry, last_sync_status')
    .eq('jobber_connected', true)
  if (LOC) q = q.eq('location_id', LOC)
  const { data: locs, error } = await q
  if (error) { console.error('locations query failed:', error.message); process.exit(2) }

  console.log(`\n#122 archive backfill — 🟢 DRY RUN (writes NOTHING)`)
  console.log(`Scope: ${LOC || 'all connected locations'} — ${locs?.length ?? 0} location(s); max ${MAX_PAGES} pages/connection\n`)

  const summary = []
  for (const loc of locs || []) {
    const slug = loc.location_id
    if (!loc.jobber_access_token) { console.log(`— ${slug}: no access token — SKIP`); continue }

    // ── archived REQUESTS ──────────────────────────────────────────────────
    let reqRes
    try { reqRes = await pageIds(loc.jobber_access_token, ARCHIVED_REQUESTS_Q, 'requests') }
    catch (e) { console.log(`— ${slug}: requests read failed (${e.message}) — SKIP`); continue }
    if (reqRes.unauthorized) { console.log(`— ${slug}: token stale (401) — SKIP (never refreshed in a read-only run)`); continue }

    // ── archived CLIENTS ───────────────────────────────────────────────────
    let cliRes
    try { cliRes = await pageIds(loc.jobber_access_token, ARCHIVED_CLIENTS_Q, 'clients') }
    catch (e) { console.log(`— ${slug}: clients read failed (${e.message}) — SKIP`); continue }
    if (cliRes.unauthorized) { console.log(`— ${slug}: token stale (401) — SKIP`); continue }

    const archReqIds = reqRes.ids
    const archCliIds = cliRes.ids

    // Match archived requests to local service_requests mirrors, and classify
    // each matched SR as childless (the handler would DELETE + soft-close) or
    // has-work (the handler would KEEP). Local reads only — cheap.
    let srMatched = 0, srChildless = 0, srHasWork = 0
    for (const rid of archReqIds) {
      const { data: sr } = await sb
        .from('service_requests')
        .select('id')
        .eq('jobber_request_id', rid)
        .eq('location_id', slug)
        .maybeSingle()
      if (!sr) continue
      srMatched++
      const hasWork =
        (await anyRows('quotes', 'service_request_id', sr.id)) ||
        (await anyRows('jobs', 'service_request_id', sr.id)) ||
        (await anyRows('invoices', 'service_request_id', sr.id))
      if (hasWork) srHasWork++; else srChildless++
    }

    // Match archived clients to local leads (client path is HELD — count only).
    let leadMatched = 0
    for (const cid of archCliIds) {
      const { data: lead } = await sb
        .from('leads')
        .select('id')
        .eq('jobber_client_id', cid)
        .eq('location_id', slug)
        .maybeSingle()
      if (lead) leadMatched++
    }

    console.log(
      `— ${slug}: archived in Jobber → ${archReqIds.length} request(s)${reqRes.truncated ? '+ (page cap hit)' : ''}, ` +
      `${archCliIds.length} client(s)${cliRes.truncated ? '+ (page cap hit)' : ''}\n` +
      `    request path: ${srMatched} match a local SR  (${srChildless} childless → would clean, ${srHasWork} has-work → would keep)\n` +
      `    client path : ${leadMatched} match a local lead  (HELD — no action defined yet)`,
    )
    summary.push({ slug, archReqIds: archReqIds.length, archCliIds: archCliIds.length, srMatched, srChildless, srHasWork, leadMatched })
  }

  const tot = summary.reduce((a, s) => ({
    archReqIds: a.archReqIds + s.archReqIds, archCliIds: a.archCliIds + s.archCliIds,
    srMatched: a.srMatched + s.srMatched, srChildless: a.srChildless + s.srChildless,
    srHasWork: a.srHasWork + s.srHasWork, leadMatched: a.leadMatched + s.leadMatched,
  }), { archReqIds: 0, archCliIds: 0, srMatched: 0, srChildless: 0, srHasWork: 0, leadMatched: 0 })
  console.log(
    `\nTOTAL — archived requests ${tot.archReqIds} (${tot.srMatched} mirrored: ${tot.srChildless} childless / ${tot.srHasWork} has-work); ` +
    `archived clients ${tot.archCliIds} (${tot.leadMatched} mirrored as leads).`,
  )
  console.log('DRY RUN complete — nothing was written.\n')
}

run().catch(e => { console.error('unexpected:', e?.message || e); process.exit(2) })
