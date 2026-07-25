// ═══════════════════════════════════════════════════════════════════════════
// DRY-RUN ONLY: list every lead_notification_externals row whose email also
// belongs to a hub_user at the SAME location — the cross-table twins the Zoho
// seed/top-up created before the accept-route cleanup existed.
//
// READ-ONLY BY CONSTRUCTION. There is deliberately NO --execute path in this
// script: Kevin reviews the printed list first, and deletion is a separate
// decision (scripts/cleanup-owner-duplicate-externals.mjs is the existing
// review-gated deleter; the accept route now prevents new twins going
// forward). Matching is case-insensitive on the lowercased email — the
// 2026-07-19 seed predates lowercased storage — and location-scoped: the same
// address at a different location is NOT a twin.
//
// Output is split the same way the runtime cleanup splits:
//   · WOULD DELETE — twin of an owner/manager (interface roles). These people
//     are auto-included by the resolver; the external row only duplicates the
//     Settings list and defeats unsubscribe.
//   · REVIEW ONLY — twin of a non-interface role (lite_user, admin). The
//     external row is the only thing notifying them; deleting it silences
//     them. Listed so the overlap is visible, never a delete candidate here.
//
// Run: node scripts/find-twin-externals.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'node:fs'

const envCandidates = [
  '.env.local',
  '/Users/flightdeck/projects/clients/bee-organized/repo/.env.local',
]
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
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function get(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()} for ${path}`)
  return r.json()
}

// Mirrors RECIPIENT_INTERFACE_ROLES (lib/notification-recipients.ts) and the
// role gate in removeExternalTwinsForHubUser.
const INTERFACE_ROLES = ['owner', 'manager']

const norm = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '')

const [locations, hubUsers, externals] = await Promise.all([
  get('locations?select=id,name,location_id'),
  get('hub_users?select=id,email,role,location_id,disabled_at'),
  get('lead_notification_externals?select=id,location_id,email,first_name,last_name,category'),
])

const locById = new Map(locations.map((l) => [l.id, l]))
const usersByLoc = new Map()
for (const u of hubUsers) {
  if (!u.location_id || !norm(u.email)) continue
  const list = usersByLoc.get(u.location_id) || []
  list.push(u)
  usersByLoc.set(u.location_id, list)
}

const wouldDelete = []
const reviewOnly = []
for (const ext of externals) {
  const key = norm(ext.email)
  if (!key) continue
  const twins = (usersByLoc.get(ext.location_id) || []).filter((u) => norm(u.email) === key)
  if (twins.length === 0) continue
  const loc = locById.get(ext.location_id)
  const row = {
    location: loc?.location_id || ext.location_id,
    location_name: loc?.name || '(unknown)',
    email: ext.email,
    external_id: ext.id,
    external_category: ext.category,
    hub_user_roles: twins.map((u) => u.role + (u.disabled_at ? ' (disabled)' : '')).join(', '),
  }
  if (twins.some((u) => INTERFACE_ROLES.includes(u.role))) wouldDelete.push(row)
  else reviewOnly.push(row)
}

const print = (rows) => {
  for (const r of rows) {
    console.log(
      `  ${r.location} (${r.location_name})  ${r.email}  role=${r.hub_user_roles}  category=${r.external_category}  ext_id=${r.external_id}`,
    )
  }
}

console.log('DRY RUN — no writes. This script has no execute mode.\n')
console.log(`Externals scanned: ${externals.length} across ${locations.length} locations`)
console.log(`\nWOULD DELETE (owner/manager twin — resolver already auto-includes them): ${wouldDelete.length}`)
print(wouldDelete)
console.log(`\nREVIEW ONLY (non-interface twin — external row is what notifies them, do NOT delete blindly): ${reviewOnly.length}`)
print(reviewOnly)
if (wouldDelete.length === 0 && reviewOnly.length === 0) {
  console.log('\nNo twins found — nothing to clean.')
}
