// ═══════════════════════════════════════════════════════════════════════════
// Jobber live-schema introspection — READ-ONLY.
//
// Answers "what does the schema ACTUALLY accept" questions before we
// write a mutation (the billing-address push had to ship on secondhand
// schema evidence because this didn't exist; the property push didn't —
// Kevin authorized the pattern 7/10).
//
// Usage:  node scripts/introspect-jobber-schema.mjs ClientEditInput PropertyEditInput
//    or:  node scripts/introspect-jobber-schema.mjs --mutations propert --queries visit
//    or:  node scripts/introspect-jobber-schema.mjs --enum ScheduledItemType
// Flags:  --env <path>       env file (default .env.local — run from repo root)
//         --mutations <re>   list mutation fields (with args) matching the regex
//         --queries <re>     list root query fields matching the regex
//         --enum <name>      dump an enum's values
//
// READ-ONLY: pure __type/__schema introspection — zero data reads, zero
// writes. Uses a stored token as-is and NEVER refreshes; refreshing would
// rotate the production token columns, which a read-only run must not do.
//
// Health is judged by lib/jobber-status.ts, NOT by access-token expiry —
// see the block above the query below for why that distinction matters.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const flagVal = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null }
const typeNames = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')))

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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// ─── Token health ──────────────────────────────────────────────────────────
// Reuse the SHARED derivation instead of holding a second opinion. Node
// (>= 22.18) strips the types natively, so the .ts helper imports directly
// from this .mjs — no copy to drift.
//
// Why this matters: an earlier version of this check demanded a non-expired
// ACCESS token. Access tokens live 55 minutes (app/api/jobber/callback) and
// refresh ONLY ON DEMAND, so unless a location transacted within the last
// ~50 minutes it looked dead — the script declared "no valid token" across a
// fleet that was entirely healthy, and cost an evening chasing a production
// outage that did not exist. That is precisely the v2 false alarm
// lib/jobber-status.ts was written to kill: "a normally-expired access token
// with a HEALTHY refresh token is NOT broken."
let jobberStatusView
try {
  ;({ jobberStatusView } = await import('../lib/jobber-status.ts'))
} catch (err) {
  console.error(
    'HEALTH_HELPER_UNAVAILABLE: could not import lib/jobber-status.ts.\n' +
      `  This script imports the shared TypeScript helper rather than keeping a second\n` +
      `  copy of the health rules, which needs Node >= 22.18 for native type stripping.\n` +
      `  Node here is ${process.version}.\n  ${err?.message || err}`,
  )
  process.exit(2)
}

// The error is CAPTURED, not discarded. A wrong column name (jobber_reauth_required
// is not a column — it errors 42703) otherwise reads exactly like a dead fleet, and
// has already sent one scout chasing a phantom bad token. A query failure must never
// look like a token problem.
const { data: locs, error: locsError } = await sb
  .from('locations')
  .select(
    'location_id, jobber_connected, jobber_access_token, jobber_refresh_token, ' +
      'token_expiry, last_sync_status',
  )

if (locsError) {
  console.error(
    'LOCATIONS_QUERY_FAILED: could not read the locations table. This is a QUERY\n' +
      '  failure, not a token failure — no conclusion about Jobber health is implied.\n' +
      `  ${locsError.code || '?'}: ${locsError.message}` +
      (locsError.details ? `\n  details: ${locsError.details}` : '') +
      (locsError.hint ? `\n  hint: ${locsError.hint}` : ''),
  )
  process.exit(2)
}

const now = Date.now()
// token_expiry is epoch-ms-as-string; parseInt is the house convention.
const expiryMsOf = l => parseInt(l.token_expiry ?? '', 10)

const graded = (locs || []).map(l => ({
  loc: l,
  view: jobberStatusView({
    connected: !!l.jobber_connected,
    tokenExpiry: l.token_expiry ?? null,
    lastSyncStatus: l.last_sync_status ?? null,
    hasAccessToken: !!l.jobber_access_token,
    hasRefreshToken: !!l.jobber_refresh_token,
  }),
}))

// Usable = the helper says 'connected'. Because hasAccessToken is threaded in,
// that verdict already guarantees a bearer token exists to send. Expiry is only
// a PREFERENCE: a token still inside its 55-minute window (less 5 min of skew)
// is certain to be accepted, so try those first; otherwise fall back to a
// healthy-but-stale one, which normally still works and at worst 401s with the
// explicit message in gql() below. We never refresh to make one fresh.
const usable = graded.filter(g => g.view.status === 'connected')
const isFresh = g => Number.isFinite(expiryMsOf(g.loc)) && now < expiryMsOf(g.loc) - 5 * 60 * 1000
const picked = usable.find(isFresh) || usable[0]

if (!picked) {
  // Say WHICH condition failed. The old wording — every access token has
  // expired — was literally true of a healthy fleet and told the operator
  // nothing actionable.
  const tally = { connected: 0, reconnect_required: 0, disconnected: 0 }
  for (const g of graded) tally[g.view.status]++

  // Reporting only — mirrors the helper's precedence to explain its verdict; it
  // does not re-decide it.
  const reasonFor = ({ loc }) => {
    if (typeof loc.last_sync_status === 'string' && loc.last_sync_status.startsWith('RECONNECT REQUIRED'))
      return `last_sync_status: ${loc.last_sync_status}`
    if (!loc.jobber_access_token) return 'no access token stored — the OAuth exchange never completed'
    if (!loc.jobber_refresh_token) return 'no refresh token — nothing left to renew with'
    return 'unknown'
  }

  const lines = ['NO_USABLE_LOCATION: no location passed the Jobber health check.']
  if (!graded.length) {
    lines.push('  The locations query succeeded but returned 0 rows.')
  } else {
    lines.push(
      `  ${graded.length} location(s): ${tally.connected} connected, ` +
        `${tally.reconnect_required} reconnect required, ${tally.disconnected} disconnected.`,
    )
    // Enumerate ONLY the reconnect-required group — each line is actionable and
    // that set should be small. Never-connected locations are just the long tail
    // of unsold territories; the tally above already accounts for them, and
    // listing all 45 buries the signal.
    const broken = graded.filter(g => g.view.status === 'reconnect_required')
    for (const g of broken.slice(0, 12)) {
      lines.push(`  - ${g.loc.location_id || '(no location_id)'}: ${reasonFor(g)}`)
    }
    if (broken.length > 12) lines.push(`  - ...and ${broken.length - 12} more needing reconnect.`)
    if (!broken.length) {
      lines.push('  No location is broken — none has ever completed the Jobber OAuth connect.')
    }
  }
  lines.push(
    '  Usable means: connected + a refresh token present + no "RECONNECT REQUIRED" stamp',
    '  on last_sync_status. An EXPIRED ACCESS TOKEN IS NOT A FAILURE — it renews on',
    '  demand. This read-only run never refreshes.',
  )
  console.error(lines.join('\n'))
  process.exit(2)
}

const live = picked.loc
const liveExpiry = expiryMsOf(live)
console.log(
  `# token: ${live.location_id} — ${picked.view.label}` +
    (Number.isFinite(liveExpiry)
      ? ` (access token ${now < liveExpiry ? 'valid until' : 'expired'} ${new Date(liveExpiry).toISOString()})`
      : ' (no token_expiry recorded)'),
)
if (picked.view.autoRefreshing) {
  console.log('#   past its 55-min marker but healthy — normal. Not refreshing (read-only run).')
}
console.log('')

async function gql(query, variables) {
  const res = await fetch('https://api.getjobber.com/api/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${live.jobber_access_token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': '2025-04-16',
    },
    body: JSON.stringify({ query, variables }),
  })
  // Reachable because we accept a healthy-but-stale access token above. Jobber
  // rejecting it is NOT a broken connection — it just needs the on-demand
  // refresh this read-only script deliberately won't perform.
  if (res.status === 401) {
    console.error(
      `JOBBER_401: ${live.location_id}'s stored access token was rejected.\n` +
        '  The location is still HEALTHY (refresh token present, no reconnect stamp) —\n' +
        '  the token is simply past its 55-minute window and this script never refreshes\n' +
        '  (that would write to the production token columns). Do any authenticated action\n' +
        '  in the app for that location to refresh on demand, then re-run.',
    )
    process.exit(2)
  }
  return res.json()
}

const fmtType = t => {
  if (!t) return '?'
  if (t.kind === 'NON_NULL') return `${fmtType(t.ofType)}!`
  if (t.kind === 'LIST') return `[${fmtType(t.ofType)}]`
  return t.name
}

const TYPE_Q = `query T($name: String!) { __type(name: $name) {
  name kind
  inputFields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
  fields { name type { kind name ofType { kind name ofType { kind name } } } args { name type { kind name ofType { kind name } } } }
  enumValues { name }
} }`

async function dumpType(name) {
  const r = await gql(TYPE_Q, { name })
  const t = r?.data?.__type
  if (!t) { console.log(`## ${name}: NOT FOUND\n`); return }
  console.log(`## ${t.name} (${t.kind})`)
  if (t.enumValues?.length) console.log(`  ${t.enumValues.map(v => v.name).join(', ')}`)
  for (const f of t.inputFields || t.fields || []) {
    const args = f.args?.length ? `(${f.args.map(a => `${a.name}: ${fmtType(a.type)}`).join(', ')})` : ''
    console.log(`  ${f.name}${args}: ${fmtType(f.type)}`)
  }
  console.log('')
}

async function dumpRoot(kind, re) {
  const r = await gql(`{ __schema { ${kind} { fields { name args { name type { kind name ofType { kind name } } } } } } }`)
  const fields = r?.data?.__schema?.[kind]?.fields || []
  console.log(`## ${kind} matching /${re}/i`)
  for (const m of fields.filter(m => new RegExp(re, 'i').test(m.name))) {
    console.log(`  ${m.name}(${m.args.map(a => `${a.name}: ${fmtType(a.type)}`).join(', ')})`)
  }
  console.log('')
}

for (const n of typeNames) await dumpType(n)
if (flagVal('--enum')) await dumpType(flagVal('--enum'))
if (flagVal('--mutations')) await dumpRoot('mutationType', flagVal('--mutations'))
if (flagVal('--queries')) await dumpRoot('queryType', flagVal('--queries'))
if (!typeNames.length && !flagVal('--enum') && !flagVal('--mutations') && !flagVal('--queries')) {
  console.error('nothing to do — pass type names and/or --mutations/--queries/--enum')
  process.exit(1)
}
