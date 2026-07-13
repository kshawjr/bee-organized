// Read-only diagnostic: Jobber token health across all locations.
// Prints ONLY metadata (presence booleans, expiry timestamps, lengths) —
// never the token secrets themselves. Usage: node scripts/diag-jobber-tokens.mjs
import { readFileSync } from 'fs'

const envPath = process.argv.slice(2).find(a => !a.startsWith('--')) || '.env.local'
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
  return res.json()
}

const now = Date.now()
const rows = await sb('locations?select=location_id,name,is_active,jobber_connected,lifecycle_status,jobber_access_token,jobber_refresh_token,token_expiry,token_expiry_display,last_sync_status,jobber_account_name,updated_at&order=updated_at.desc')

console.log(`\nnow = ${now} (${new Date(now).toISOString()})\n`)
const out = []
for (const r of rows) {
  const hasAccess = !!r.jobber_access_token
  const hasRefresh = !!r.jobber_refresh_token
  if (!hasAccess && !hasRefresh) continue // never connected — skip noise
  const expiry = r.token_expiry ? parseInt(r.token_expiry) : 0
  let state = 'unknown'
  if (expiry) {
    const minsLeft = Math.round((expiry - now) / 60000)
    state = expiry <= now ? `EXPIRED ${-minsLeft}m ago` : minsLeft < 5 ? `near-expiry ${minsLeft}m` : `valid ${minsLeft}m`
  }
  out.push({
    loc: r.location_id, name: r.name, status: `active=${r.is_active} connected=${r.jobber_connected} lifecycle=${r.lifecycle_status}`,
    access: hasAccess ? `yes(len ${r.jobber_access_token.length})` : 'MISSING',
    refresh: hasRefresh ? `yes(len ${r.jobber_refresh_token.length})` : 'MISSING',
    expiry_raw: r.token_expiry, state,
    expiry_display: r.token_expiry_display,
    last_sync: r.last_sync_status, acct: r.jobber_account_name,
    updated_at: r.updated_at,
  })
}
console.log(`connected locations: ${out.length}\n`)
for (const o of out) {
  console.log(`• ${o.name} [${o.loc}] status=${o.status} acct=${o.acct ?? '—'}`)
  console.log(`    access=${o.access} refresh=${o.refresh} expiry=${o.expiry_raw} → ${o.state}`)
  console.log(`    display=${o.expiry_display} updated=${o.updated_at}`)
  console.log(`    last_sync=${o.last_sync}`)
}
