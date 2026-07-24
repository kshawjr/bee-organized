// ═══════════════════════════════════════════════════════════════════════════
// Backfill the BLANK lead assignments — the leads that came through the intake
// door before /api/leads/intake wrote any assignment at all.
//
// DRY RUN BY DEFAULT. Writes nothing without --execute. Run the dry run, get the
// numbers approved, then re-run with --execute.
//
//   node scripts/backfill-lead-assignments.mjs
//   node scripts/backfill-lead-assignments.mjs --execute
//
// PRECONDITION for --execute ONLY: migrations/lead_assignees.sql must be
// APPLIED. The DRY RUN deliberately works WITHOUT the table — the plan is pure
// resolution and nothing about it needs the junction to exist, so the numbers
// can be reviewed and approved BEFORE the migration is run. --execute refuses
// without the table: a backfill that wrote only leads.assigned_to would look
// like it worked while silently leaving the plural truth empty.
//
// ── SCOPE — deliberately narrow ────────────────────────────────────────────
// ONLY leads with assigned_to IS NULL. That is the 106-row blank cohort (all of
// it from the intake door, verified 2026-07-23). The ~7,129 leads carrying an
// import BLANKET STAMP (every lead at a location stamped with that location's
// owner at import time — ClickUp 868kdy5fm) are NOT touched: they already have
// a value, that value is not evidence anybody chose anything, and rewriting
// them would be a 7,000-row change nobody asked for. A row is skipped if it has
// ANY existing lead_assignees row, so a re-run is idempotent and can never
// stomp a human's pick.
//
// ── RULE — identical to the live path ──────────────────────────────────────
// Re-implemented here against PostgREST rather than imported, because the app
// module is TypeScript behind Next's module graph. The logic is pinned against
// lib/lead-assignment.ts by lib/beta-lead-assignment.test.ts; if you change one,
// change both.
//   1. split_notifications_enabled OFF        → location owner
//   2. split ON, someone claims the type      → all claiming hub_users (multi)
//   3. split ON, nobody assignable claims it  → location owner
//   4. externals are never assigned
//   5. never nobody — a lead we cannot resolve is REPORTED, not silently left
//
// ── EXECUTION RECORD — 2026-07-24 ──────────────────────────────────────────
// EXECUTED against prod 2026-07-24. Dry run matched the plan exactly: 104 in
// scope, 2 project_type (both loc_test, via the 'organizing' legacy alias →
// "Home or Office Organizing", kshawjr), 23 location_owner, 79 unwritable
// (locations with ZERO hub_users — nobody to assign to until onboarded). All
// 25 writable junction rows landed; final state verified 25/25 with
// leads.assigned_to === earliest junction hub_user_id, 0 disagreements, and
// leads assigned_to-NULL non-junk down to the expected 79.
//
// ⚠ PARTIAL WRITE on that run, since FIXED below. The post() helper called
// r.json() on PostgREST's 201 EMPTY body (Prefer: return=minimal returns 201,
// not 204), which threw "Unexpected end of JSON input" AFTER each lead_assignees
// insert had already committed but BEFORE the paired leads.assigned_to PATCH ran.
// Net effect: all 25 junction rows written correctly, but assigned_to left NULL
// on all 25, and the run mis-reported 0/25 success. The helper now reads the raw
// text and parses only when non-empty, so a 201-empty-body is a success, not a
// crash. The assigned_to gap was closed FORWARD-ONLY (no deletes): assigned_to
// was reconciled from the junction (earliest created_at = primary = exactly what
// this script's patch() writes), which is idempotent. A clean re-run of THIS
// fixed script is a no-op — every target already has a junction row and is
// skipped, and assigned_to already agrees.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'node:fs'

const EXECUTE = process.argv.includes('--execute')

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
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function get(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()} for ${path}`)
  return r.json()
}
async function post(path, body, prefer = 'return=minimal') {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...H, Prefer: prefer },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()} for POST ${path}`)
  // Prefer: return=minimal returns 201 with an EMPTY body (not 204), so a blind
  // r.json() throws "Unexpected end of JSON input" AFTER the insert already
  // landed — reporting failure on a successful write. Read the raw text and
  // parse only when there's something to parse.
  const text = await r.text()
  return text ? JSON.parse(text) : null
}
async function patch(path, body) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()} for PATCH ${path}`)
}

console.log(`env:  ${envPath}`)
console.log(`mode: ${EXECUTE ? '*** EXECUTE — WILL WRITE ***' : 'DRY RUN (writes nothing)'}\n`)

// ── 0. Is the junction there yet? ──────────────────────────────────────────
// Blocking for --execute, informational for the dry run.
let junctionExists = true
try {
  await get('lead_assignees?select=lead_id&limit=1')
} catch (err) {
  junctionExists = false
  if (EXECUTE) {
    console.error('REFUSING TO EXECUTE — lead_assignees is not readable.')
    console.error('Apply migrations/lead_assignees.sql in the Supabase SQL editor first.')
    console.error(`  ${String(err.message).slice(0, 300)}`)
    process.exit(1)
  }
  console.log('NOTE: lead_assignees does not exist yet (migration not applied).')
  console.log('      The dry-run plan below is unaffected — it is pure resolution.')
  console.log('      Apply the migration before re-running with --execute.\n')
}

// ── 1. Reference data ──────────────────────────────────────────────────────
const locations = await get(
  'locations?select=id,name,location_id,lifecycle_status,split_notifications_enabled',
)
const locById = new Map(locations.map((l) => [l.id, l]))
const nameOf = (id) => locById.get(id)?.location_id || locById.get(id)?.name || String(id)

const hubUsers = await get('hub_users?select=id,email,full_name,role,location_id')
const usersByLocation = new Map()
for (const u of hubUsers) {
  if (!usersByLocation.has(u.location_id)) usersByLocation.set(u.location_id, [])
  usersByLocation.get(u.location_id).push(u)
}
const userById = new Map(hubUsers.map((u) => [u.id, u]))

const prefs = await get('lead_notification_prefs?select=location_id,hub_user_id,category,subscribed')
const externals = await get('lead_notification_externals?select=location_id,email,category')
const lookups = await get('lookups?select=label,attrs,sort_order&category=eq.project_types&order=sort_order')
const vocabulary = lookups
  .map((r) => ({
    label: String(r.label || '').trim(),
    dripCategory: r?.attrs?.drip_category === 'move' ? 'move' : 'general',
  }))
  .filter((r) => r.label)

const seats = await get(
  'subscription_seats?select=location_id,user_id,tier,is_primary,status,added_at&tier=eq.owner&status=eq.active',
)

// ── 2. The rule, mirrored from lib/lead-assignment.ts ──────────────────────
const LEGACY_ALIASES = { moving: 'move', organizing: 'general' }

function canonicalProjectType(raw) {
  const s = (raw || '').trim()
  if (!s) return null
  const exact = vocabulary.find((v) => v.label.toLowerCase() === s.toLowerCase())
  if (exact) return exact.label
  const legacy = LEGACY_ALIASES[s.toLowerCase()]
  if (legacy) {
    const fam = vocabulary.find((v) => v.dripCategory === legacy)
    if (fam) return fam.label
  }
  return null
}

function parseCategory(raw) {
  if (raw == null) return { kind: 'all' }
  const s = String(raw).trim()
  if (s === '' || s === 'all') return { kind: 'all' }
  if (s === 'moving') return { kind: 'legacy-move' }
  if (s === 'organizing') return { kind: 'legacy-general' }
  let types = null
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) types = arr.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    } catch { /* fall through to CSV */ }
  }
  if (types == null) types = s.split(',').map((t) => t.trim()).filter(Boolean)
  return types.length ? { kind: 'types', types } : { kind: 'all' }
}
const claims = (category, label) => {
  const sel = parseCategory(category)
  return sel.kind === 'types' && sel.types.some((t) => t.toLowerCase() === label.toLowerCase())
}

// getPrimaryOwnerForLocation, mirrored: designated primary seat → earliest
// active owner seat → earliest hub_users role='owner'.
function primaryOwnerFor(locationUuid) {
  const locSeats = seats.filter((s) => s.location_id === locationUuid && s.user_id)
  const designated = locSeats.find((s) => s.is_primary)
  if (designated) return userById.get(designated.user_id) || null
  const earliestSeat = locSeats
    .slice()
    .sort((a, b) => String(a.added_at || '').localeCompare(String(b.added_at || '')))[0]
  if (earliestSeat) return userById.get(earliestSeat.user_id) || null
  const owners = (usersByLocation.get(locationUuid) || []).filter((u) => u.role === 'owner')
  return owners[0] || null
}

function resolve(locationUuid, projectType) {
  const loc = locById.get(locationUuid)
  const splitEnabled = loc?.split_notifications_enabled === true
  const owner = primaryOwnerFor(locationUuid)
  const ownerTier = (extra) =>
    owner
      ? { ids: [owner.id], basis: 'location_owner', ...extra }
      : { ids: [], basis: 'none', ...extra }

  if (!splitEnabled) {
    return ownerTier({ splitEnabled: false, label: null, unrecognized: false, externalClaimants: [] })
  }

  const label = canonicalProjectType(projectType)
  const unrecognized = !!(projectType || '').trim() && !label
  if (!label) return ownerTier({ splitEnabled: true, label: null, unrecognized, externalClaimants: [] })

  const externalClaimants = externals
    .filter((e) => e.location_id === locationUuid && claims(e.category, label))
    .map((e) => e.email)

  // Interface users default to subscribed/'all' when they have no pref row, and
  // 'all' never CLAIMS a type — so only users WITH a claiming pref row qualify.
  const claimants = (usersByLocation.get(locationUuid) || [])
    .filter((u) => u.role === 'owner' || u.role === 'manager')
    .filter((u) => {
      const p = prefs.find((x) => x.location_id === locationUuid && x.hub_user_id === u.id)
      return !!p && p.subscribed !== false && claims(p.category, label)
    })

  if (claimants.length > 0) {
    return { ids: claimants.map((u) => u.id), basis: 'project_type', splitEnabled: true, label, unrecognized, externalClaimants }
  }
  return ownerTier({ splitEnabled: true, label, unrecognized, externalClaimants })
}

// ── 3. The cohort ──────────────────────────────────────────────────────────
const blanks = []
for (let from = 0; ; from += 1000) {
  const page = await get(
    `leads?select=id,name,project_type,source,stage,created_at,location_uuid,is_junk&assigned_to=is.null&order=created_at.desc&offset=${from}&limit=1000`,
  )
  blanks.push(...page)
  if (page.length < 1000) break
}

// Already-assigned rows (junction) are skipped — idempotent re-runs. Nothing
// can be already-assigned if the table isn't there yet.
const alreadyAssigned = new Set(
  junctionExists ? (await get('lead_assignees?select=lead_id')).map((r) => r.lead_id) : [],
)

console.log(`── COHORT ──────────────────────────────────────────────`)
console.log(`  leads with assigned_to IS NULL          ${blanks.length}`)
const junked = blanks.filter((l) => l.is_junk === true)
const noLocation = blanks.filter((l) => !l.location_uuid)
const skipExisting = blanks.filter((l) => alreadyAssigned.has(l.id))
console.log(`  · in the recycle bin (is_junk)          ${junked.length}   SKIPPED`)
console.log(`  · no location_uuid                      ${noLocation.length}   SKIPPED`)
console.log(`  · already have a lead_assignees row     ${skipExisting.length}   SKIPPED`)

const targets = blanks.filter(
  (l) => l.is_junk !== true && l.location_uuid && !alreadyAssigned.has(l.id),
)
console.log(`  → TO BACKFILL                           ${targets.length}\n`)

// ── 4. Plan ────────────────────────────────────────────────────────────────
const plan = []
const byBasis = { project_type: 0, location_owner: 0, none: 0 }
const byLocation = new Map()
const unrecognizedTypes = new Map()
const unresolvable = []

for (const lead of targets) {
  const r = resolve(lead.location_uuid, lead.project_type)
  byBasis[r.basis]++
  const key = nameOf(lead.location_uuid)
  if (!byLocation.has(key)) byLocation.set(key, { n: 0, project_type: 0, owner: 0, none: 0, multi: 0 })
  const agg = byLocation.get(key)
  agg.n++
  if (r.basis === 'project_type') agg.project_type++
  else if (r.basis === 'location_owner') agg.owner++
  else agg.none++
  if (r.ids.length > 1) agg.multi++

  if (r.unrecognized) {
    const k = String(lead.project_type)
    unrecognizedTypes.set(k, (unrecognizedTypes.get(k) || 0) + 1)
  }
  if (r.basis === 'none') unresolvable.push({ lead, r })

  plan.push({ lead, r })
}

console.log(`── PLAN BY BASIS ───────────────────────────────────────`)
console.log(`  project_type (a recipient claims the type)  ${byBasis.project_type}`)
console.log(`  location_owner (fallback)                   ${byBasis.location_owner}`)
console.log(`  none (NO OWNER — cannot assign)             ${byBasis.none}`)
const multi = plan.filter((p) => p.r.ids.length > 1).length
console.log(`  of which MULTI-assign (>1 assignee)         ${multi}\n`)

console.log(`── PLAN BY LOCATION ────────────────────────────────────`)
for (const [loc, a] of [...byLocation].sort((x, y) => y[1].n - x[1].n)) {
  console.log(
    `  ${String(loc).padEnd(22)} n=${String(a.n).padStart(3)}  project_type=${a.project_type}  owner=${a.owner}  none=${a.none}  multi=${a.multi}`,
  )
}

if (unrecognizedTypes.size) {
  console.log(`\n── PROJECT-TYPE DRIFT (fell back to the owner) ─────────`)
  console.log(`  These project_type values are not a known lookups label, so no`)
  console.log(`  project-type claim could match them. Falling back to the owner is`)
  console.log(`  correct — this is listed so the drift is VISIBLE, not silent.`)
  for (const [k, v] of [...unrecognizedTypes].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(k).padEnd(30)} ${v} lead(s)`)
  }
}

if (unresolvable.length) {
  console.log(`\n── ⚠ UNRESOLVABLE — no hub user to assign to ───────────`)
  console.log(`  Rule 5 says never nobody, and these violate it. They are NOT`)
  console.log(`  written. Grouped by location with the REASON, because the two`)
  console.log(`  causes need completely different fixes:`)
  console.log(``)
  console.log(`    NOT ONBOARDED — the location has ZERO hub_users. Leads arrive`)
  console.log(`      and are notified (via lead_notification_externals), but there`)
  console.log(`      is no one IN the app to hand the work to. Nothing to fix in`)
  console.log(`      code — the location has to be onboarded.`)
  console.log(`    NO OWNER — the location HAS hub users but none resolves as the`)
  console.log(`      owner (no primary seat, no active owner seat, no role='owner').`)
  console.log(`      That is a data problem worth fixing, then re-run.`)
  console.log(``)
  const byLoc = new Map()
  for (const { lead } of unresolvable) {
    const k = lead.location_uuid
    if (!byLoc.has(k)) byLoc.set(k, 0)
    byLoc.set(k, byLoc.get(k) + 1)
  }
  let notOnboarded = 0
  let noOwner = 0
  for (const [locUuid, n] of [...byLoc].sort((a, b) => b[1] - a[1])) {
    const users = usersByLocation.get(locUuid) || []
    const reason = users.length === 0 ? 'NOT ONBOARDED (0 hub_users)' : `NO OWNER (${users.length} hub_user(s), roles: ${[...new Set(users.map(u => u.role))].join('/')})`
    if (users.length === 0) notOnboarded += n
    else noOwner += n
    console.log(`    ${nameOf(locUuid).padEnd(22)} ${String(n).padStart(3)} lead(s)   ${reason}`)
  }
  console.log(``)
  console.log(`    blocked by NOT ONBOARDED  ${notOnboarded}`)
  console.log(`    blocked by NO OWNER       ${noOwner}`)
}

console.log(`\n── SAMPLE (first 25 writes) ────────────────────────────`)
for (const { lead, r } of plan.filter((p) => p.r.ids.length > 0).slice(0, 25)) {
  const who = r.ids.map((id) => userById.get(id)?.email || id).join(', ')
  console.log(
    `  ${nameOf(lead.location_uuid).padEnd(20)} pt=${String(lead.project_type || '—').padEnd(26)} via=${String(r.basis).padEnd(14)} → ${who}`,
  )
}

// ── 5. Execute ─────────────────────────────────────────────────────────────
const writable = plan.filter((p) => p.r.ids.length > 0)

if (!EXECUTE) {
  console.log(`\n── DRY RUN COMPLETE — nothing written ──────────────────`)
  console.log(`  would write ${writable.reduce((s, p) => s + p.r.ids.length, 0)} lead_assignees row(s)`)
  console.log(`  across ${writable.length} lead(s), and stamp leads.assigned_to on each.`)
  console.log(`\n  Re-run with --execute once these numbers are approved.`)
  process.exit(0)
}

console.log(`\n── EXECUTING ───────────────────────────────────────────`)
let wroteRows = 0
let wroteLeads = 0
let failed = 0
for (const { lead, r } of writable) {
  try {
    await post(
      'lead_assignees?on_conflict=lead_id,hub_user_id',
      r.ids.map((hub_user_id) => ({
        lead_id: lead.id,
        hub_user_id,
        assigned_via: r.basis,
      })),
      'return=minimal,resolution=ignore-duplicates',
    )
    // Legacy singular column — first assignee, matching the app's write.
    await patch(`leads?id=eq.${lead.id}`, { assigned_to: r.ids[0] })
    wroteRows += r.ids.length
    wroteLeads++
    if (wroteLeads % 25 === 0) console.log(`  … ${wroteLeads}/${writable.length}`)
  } catch (err) {
    failed++
    console.error(`  FAILED lead ${lead.id} (${lead.name}): ${String(err.message).slice(0, 200)}`)
  }
}
console.log(`\n  leads assigned      ${wroteLeads}/${writable.length}`)
console.log(`  junction rows       ${wroteRows}`)
console.log(`  failures            ${failed}`)
console.log(`  left unassigned     ${unresolvable.length} (no owner at the location)`)

// ── 6. Verify ──────────────────────────────────────────────────────────────
const after = await get('leads?select=id&assigned_to=is.null&is_junk=not.eq.true')
console.log(`\n── VERIFY ──────────────────────────────────────────────`)
console.log(`  leads still assigned_to IS NULL (non-junk): ${after.length}`)
console.log(`  expected: ${unresolvable.length} (the no-owner locations) + any junk-flagged rows`)
