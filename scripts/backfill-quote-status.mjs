// ═══════════════════════════════════════════════════════════════════════════
// Backfill: correct quotes.status (+ approved_at) from Jobber's real
// quoteStatus, for quotes imported BEFORE the forward fix (ClickUp 868kbc91q).
//
// WHY. The bulk QUOTES_QUERY used to omit quoteStatus, so every bulk-imported
// quote landed status='sent', approved_at=null regardless of its true Jobber
// state (2,325 of 2,345 prod rows; a hard floor of 918 provably wrong). The
// forward fix (41f5b34) makes FUTURE imports correct; this repairs the rows
// already on disk WITHOUT re-running the full import (which is heavy and would
// re-trigger the paid_at re-stamp on invoices — a separate, deliberately-left
// decision).
//
// WHAT IT TOUCHES. Only two columns, and only on rows that would actually
// change: `status` and (for newly-APPROVED rows with no stamp yet) `approved_at`
// — plus updated_at / jobber_synced_at housekeeping. It re-fetches ONLY
// { id, quoteStatus } from Jobber, so it can never disturb amounts, sent_at,
// or any other column. It maps quoteStatus through the SAME shared mapper the
// import and webhook use (lib/quote-status-map) — no parallel implementation.
//
// DRY RUN BY DEFAULT. Prints, per location: rows examined, matched-in-Jobber,
// how many WOULD change, the before→after status distribution, and a sample of
// changes — and writes NOTHING to the quotes table. Pass --execute to write.
//
// ⚠ TOKEN SIDE-EFFECT (applies even in dry run). To read Jobber, getValidToken
// may refresh an expired access token, which ROTATES the locations row's
// jobber_access_token / jobber_refresh_token / token_expiry (a production write
// to `locations`, NOT to `quotes`). This is the same authorized side-effect the
// existing scan scripts carry. Locations with a dead refresh token (historically
// loc_kc, loc_scottsdale) will FAIL the refresh — the script SKIPS that location,
// reports it, and continues. A location is never half-written: the Jobber token
// is obtained before any quote write, so a token failure means zero quote writes
// for that location.
//
// IDEMPOTENT. A row already carrying the correct status (and approved_at where
// due) is left untouched, so re-running writes nothing new. approved_at, once
// set, is never cleared or overwritten — mirroring upsertQuote.
//
// SCOPE (default): the 6 active locations + loc_scottsdale. Reported per
// location so each can be approved/run independently via --loc <slug>.
//
// Usage:
//   node scripts/backfill-quote-status.mjs                 # dry run, all scope
//   node scripts/backfill-quote-status.mjs --loc loc_portland
//   node scripts/backfill-quote-status.mjs --execute       # write, all scope
//   node scripts/backfill-quote-status.mjs --loc loc_omaha --execute
//   [--env <path>]  # default: .env.local, then the main checkout's copy
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const locArgIdx = args.indexOf('--loc')
const ONLY_LOC = locArgIdx !== -1 ? args[locArgIdx + 1] : null
const envArgIdx = args.indexOf('--env')
const envArg = envArgIdx !== -1 ? args[envArgIdx + 1] : null

// ── Env ──────────────────────────────────────────────────────────────────
const envCandidates = [
  envArg && resolve(envArg),
  join(repoRoot, '.env.local'),
  '/Users/flightdeck/projects/clients/bee-organized/repo/.env.local',
].filter(Boolean)
const envPath = envCandidates.find((p) => existsSync(p))
if (!envPath) {
  console.error(`No env file found. Tried:\n  ${envCandidates.join('\n  ')}`)
  process.exit(1)
}
const env = {}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JOBBER_CLIENT_ID', 'JOBBER_CLIENT_SECRET']) {
  if (!env[k]) { console.error(`Missing required env in ${envPath}: ${k}`); process.exit(1) }
}

// ── The ONE shared mapper (pure, dependency-free — Node strips the types) ──
const { mapQuoteStatus, quoteStatusStampsApproval } =
  await import(join(repoRoot, 'lib/quote-status-map.ts'))

// ── Supabase REST ──────────────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`PostgREST ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
async function sbAll(pathBase) {
  const out = []; let from = 0; const PAGE = 1000
  for (;;) {
    const page = await sb(pathBase, { headers: { Range: `${from}-${from + PAGE - 1}` } })
    out.push(...page)
    if (page.length < PAGE) break
    from += PAGE
  }
  return out
}

// ── Jobber (throttle-aware; ports scan-blind-spot's helpers) ────────────────
const JOBBER_URL = 'https://api.getjobber.com/api/graphql'
const JOBBER_VERSION = '2025-04-16'
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
  return res.json()
}
let lastThrottle = { maximumAvailable: 2500, currentlyAvailable: 2500, restoreRate: 50 }
async function jobberQueryThrottled(token, query, variables, retries = 3) {
  const estimatedCost = 50
  if (lastThrottle.currentlyAvailable < estimatedCost) {
    const waitMs = Math.ceil(((estimatedCost - lastThrottle.currentlyAvailable) / lastThrottle.restoreRate + 0.5) * 1000)
    await sleep(waitMs)
  }
  const result = await jobberQuery(token, query, variables)
  const ts = result?.extensions?.cost?.throttleStatus
  if (ts) lastThrottle = ts
  if (result?.errors?.some(e => e.extensions?.code === 'THROTTLED')) {
    if (retries > 0) {
      const cooldownMs = Math.ceil((lastThrottle.maximumAvailable / lastThrottle.restoreRate) * 1000)
      process.stdout.write(`    [throttle] pausing ${cooldownMs}ms\n`)
      await sleep(cooldownMs)
      return jobberQueryThrottled(token, query, variables, retries - 1)
    }
    throw new Error('Jobber rate limit exhausted: ' + JSON.stringify(result.errors))
  }
  return result
}

// getValidToken — refreshes + ROTATES the locations row when the access token
// is expired (see header). Throws on refresh failure so the caller can skip the
// location cleanly.
async function getValidToken(location) {
  const expiry = location.token_expiry ? parseInt(location.token_expiry) : 0
  if (expiry && Date.now() < expiry - 5 * 60 * 1000) return location.jobber_access_token
  const test = await jobberQuery(location.jobber_access_token, '{ account { id } }')
  if (test?.data?.account?.id) return location.jobber_access_token
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
  const raw = await res.text()
  let tokens = null
  try { tokens = JSON.parse(raw) } catch {}
  if (!res.ok || !tokens?.access_token) {
    throw new Error(`token refresh failed (${res.status}): ${raw.slice(0, 160)}`)
  }
  const expiryMs = Date.now() + 55 * 60 * 1000
  await sb(`locations?location_id=eq.${encodeURIComponent(location.location_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      jobber_access_token: tokens.access_token,
      jobber_refresh_token: tokens.refresh_token,
      token_expiry: expiryMs,
      token_expiry_display: new Date(expiryMs).toISOString().slice(0, 19),
      last_sync_status: `Token refreshed: ${new Date().toISOString().slice(0, 19)}`,
      updated_at: new Date().toISOString(),
    }),
    headers: { Prefer: 'return=minimal' },
  }) // MUST NOT be swallowed — Jobber rotates refresh tokens.
  console.log(`    [token] refreshed + rotated for ${location.location_id}`)
  return tokens.access_token
}

const QUOTES_STATUS_QUERY = `
  query GetQuoteStatuses($after: String) {
    quotes(first: 50, after: $after) {
      nodes { id quoteStatus }
      pageInfo { hasNextPage endCursor }
    }
  }
`

// gid://Jobber/Quote/421 (or base64 thereof) → "421". Matches extractJobberId.
const numericId = gid => {
  if (!gid) return null
  if (/^\d+$/.test(gid)) return gid
  try {
    const m = Buffer.from(gid, 'base64').toString('utf8').match(/\/(\d+)$/)
    return m ? m[1] : null
  } catch { return null }
}

const tally = (arr, key) => arr.reduce((m, x) => { const k = key(x); m[k] = (m[k] || 0) + 1; return m }, {})
const fmtTally = t => Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'

// ── Scope ────────────────────────────────────────────────────────────────
const DEFAULT_SCOPE = [
  'loc_test', 'loc_portland', 'loc_nwarkansas', 'loc_palmbeach', 'loc_omaha', 'loc_temecula',
  'loc_scottsdale',
]
const SCOPE = ONLY_LOC ? [ONLY_LOC] : DEFAULT_SCOPE

// ── Run ────────────────────────────────────────────────────────────────────
console.log('═'.repeat(78))
console.log(`Quote-status backfill — ${EXECUTE ? '🔴 EXECUTE (writes quotes)' : '🟢 DRY RUN (no quote writes)'}`)
console.log(`Env: ${envPath}`)
console.log(`Scope: ${SCOPE.join(', ')}`)
console.log('═'.repeat(78))

const summary = []
for (const slug of SCOPE) {
  console.log(`\n■ ${slug}`)
  const locRows = await sb(`locations?location_id=eq.${encodeURIComponent(slug)}&select=location_id,jobber_access_token,jobber_refresh_token,token_expiry`)
  const location = locRows?.[0]
  if (!location) { console.log('    location not found — skipping'); summary.push({ slug, skipped: 'not found' }); continue }
  if (!location.jobber_access_token || !location.jobber_refresh_token) {
    console.log('    no Jobber tokens on this location — skipping'); summary.push({ slug, skipped: 'no tokens' }); continue
  }

  // Token FIRST — a failure here means zero writes for this location.
  let token
  try {
    token = await getValidToken(location)
  } catch (e) {
    console.log(`    ⚠ token unavailable (${e.message}) — SKIPPING location, continuing`)
    summary.push({ slug, skipped: `token: ${e.message}` }); continue
  }

  // Fetch { id, quoteStatus } for every quote in Jobber (paginated).
  const jobberStatus = new Map() // numericId -> quoteStatus enum
  try {
    let after = null
    for (;;) {
      const r = await jobberQueryThrottled(token, QUOTES_STATUS_QUERY, { after })
      if (r?.errors) throw new Error(JSON.stringify(r.errors).slice(0, 200))
      const conn = r?.data?.quotes
      for (const n of (conn?.nodes || [])) {
        const nid = numericId(n.id)
        if (nid) jobberStatus.set(nid, n.quoteStatus)
      }
      if (!conn?.pageInfo?.hasNextPage) break
      after = conn.pageInfo.endCursor
    }
  } catch (e) {
    console.log(`    ⚠ Jobber quote fetch failed (${e.message}) — SKIPPING location, continuing`)
    summary.push({ slug, skipped: `jobber fetch: ${e.message}` }); continue
  }

  // Local quotes for this location.
  const localQuotes = await sbAll(`quotes?location_id=eq.${encodeURIComponent(slug)}&select=id,jobber_quote_id,status,approved_at`)

  const matched = []
  let unmatched = 0
  for (const q of localQuotes) {
    const real = jobberStatus.get(String(q.jobber_quote_id))
    if (real === undefined) { unmatched++; continue } // not returned by Jobber (deleted/inaccessible) — never touched
    const desired = mapQuoteStatus(real)
    const wantStamp = quoteStatusStampsApproval(real) && !q.approved_at
    const needs = q.status !== desired || wantStamp
    matched.push({ q, real, desired, wantStamp, needs })
  }

  const changes = matched.filter(m => m.needs)
  const before = tally(matched, m => m.q.status)
  const after = tally(matched, m => m.desired)

  console.log(`    local quotes:        ${localQuotes.length}`)
  console.log(`    matched in Jobber:   ${matched.length}   (unmatched, untouched: ${unmatched})`)
  console.log(`    WOULD change:        ${changes.length}${EXECUTE ? '  → writing…' : ''}`)
  console.log(`    before:  ${fmtTally(before)}`)
  console.log(`    after:   ${fmtTally(after)}`)
  const stampCount = changes.filter(c => c.wantStamp).length
  if (stampCount) console.log(`    approved_at newly stamped on: ${stampCount}`)
  if (changes.length) {
    const sample = changes.slice(0, 6).map(c => `${c.q.jobber_quote_id}: ${c.q.status}→${c.desired}${c.wantStamp ? ' (+approved_at)' : ''}`)
    console.log(`    e.g.  ${sample.join('   ')}`)
  }

  let written = 0, writeErrors = 0
  if (EXECUTE && changes.length) {
    const nowIso = new Date().toISOString()
    for (const c of changes) {
      const patch = { status: c.desired, updated_at: nowIso, jobber_synced_at: nowIso }
      if (c.wantStamp) patch.approved_at = nowIso
      try {
        await sb(`quotes?id=eq.${encodeURIComponent(c.q.id)}&location_id=eq.${encodeURIComponent(slug)}`, {
          method: 'PATCH', body: JSON.stringify(patch), headers: { Prefer: 'return=minimal' },
        })
        written++
      } catch (e) {
        writeErrors++
        console.log(`    ✗ write failed for quote ${c.q.jobber_quote_id}: ${e.message}`)
      }
    }
    console.log(`    written: ${written}${writeErrors ? `   errors: ${writeErrors}` : ''}`)
  }

  summary.push({
    slug, examined: localQuotes.length, matched: matched.length, unmatched,
    wouldChange: changes.length, stamped: stampCount,
    ...(EXECUTE ? { written, writeErrors } : {}),
  })
}

console.log('\n' + '═'.repeat(78))
console.log('SUMMARY')
for (const s of summary) {
  if (s.skipped) { console.log(`  ${s.slug.padEnd(16)} SKIPPED — ${s.skipped}`); continue }
  console.log(`  ${s.slug.padEnd(16)} examined=${s.examined} matched=${s.matched} unmatched=${s.unmatched} wouldChange=${s.wouldChange}` +
    (EXECUTE ? `  written=${s.written}${s.writeErrors ? ` errors=${s.writeErrors}` : ''}` : ''))
}
const totChange = summary.reduce((a, s) => a + (s.wouldChange || 0), 0)
console.log('─'.repeat(78))
console.log(`  TOTAL would-change: ${totChange}${EXECUTE ? `   written: ${summary.reduce((a, s) => a + (s.written || 0), 0)}` : ''}`)
if (!EXECUTE) console.log('  DRY RUN — no quote rows written. Re-run with --execute to apply.')
console.log('═'.repeat(78))
