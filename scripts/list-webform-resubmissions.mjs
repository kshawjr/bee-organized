// ═══════════════════════════════════════════════════════════════════════════
// List every 'Webform resubmission' touchpoint so Kevin can reach the returning
// clients who were silently captured before #86 wired notifications.
//
// DRY RUN ONLY. This script has NO --execute and writes NOTHING — no rows, no
// sends, no retroactive notifications. It exists to hand Kevin a list (location,
// name, email, phone, date, message) so the backlog can be worked BY HAND. The
// forward fix (notify on every future resubmission) ships in the intake route;
// this is purely the "who did we already miss" report.
//
//   node scripts/list-webform-resubmissions.mjs
//
// The 'Webform resubmission' label is written by the SOLID-merge path in
// app/api/leads/intake/route.ts (a returning client matched an existing lead by
// email or phone). Its `notes` carry "Matched on <key>. Message: <text>"; the
// message is parsed back out below. When a resubmission carried no message the
// notes are just "Matched on <key>." and the message column reads "(none)".
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

console.log(`env:  ${envPath}`)
console.log('mode: DRY RUN — read-only, writes nothing, sends nothing\n')

// ── 1. Every resubmission touchpoint ───────────────────────────────────────
// label is an exact match; occurred_at newest-first so the freshest misses are
// at the top of the list. .range via limit is generous — this cohort is small.
const tps = await get(
  'touchpoints' +
    '?select=id,lead_id,location_uuid,notes,occurred_at' +
    '&label=eq.Webform%20resubmission' +
    '&order=occurred_at.desc' +
    '&limit=1000',
)

if (tps.length === 0) {
  console.log('No "Webform resubmission" touchpoints found. Nothing to hand off.')
  process.exit(0)
}

// ── 2. Resolve the leads and locations in one batch each ────────────────────
const leadIds = [...new Set(tps.map((t) => t.lead_id).filter(Boolean))]
const locUuids = [...new Set(tps.map((t) => t.location_uuid).filter(Boolean))]

const inList = (ids) => `(${ids.map((x) => `"${x}"`).join(',')})`

const leads = leadIds.length
  ? await get(`leads?select=id,name,email,phone&id=in.${inList(leadIds)}&limit=1000`)
  : []
const locations = locUuids.length
  ? await get(`locations?select=id,name,location_id&id=in.${inList(locUuids)}&limit=1000`)
  : []

const leadById = new Map(leads.map((l) => [l.id, l]))
const locByUuid = new Map(locations.map((l) => [l.id, l]))

// notes shape: "Matched on <key>. Message: <text>" | "Matched on <key>."
const messageFromNotes = (notes) => {
  if (!notes) return '(none)'
  const idx = notes.indexOf('Message: ')
  return idx === -1 ? '(none)' : notes.slice(idx + 'Message: '.length).trim() || '(none)'
}
const matchedKeyFromNotes = (notes) => {
  const m = (notes || '').match(/Matched on (\w+)/)
  return m ? m[1] : '?'
}

// ── 3. Group by location, print a hand-off table ────────────────────────────
const rows = tps.map((t) => {
  const lead = leadById.get(t.lead_id) || {}
  const loc = locByUuid.get(t.location_uuid) || {}
  return {
    locationName: loc.name || '(unknown location)',
    locationSlug: loc.location_id || '(no slug)',
    leadId: t.lead_id,
    name: lead.name || '(no name)',
    email: lead.email || '(none)',
    phone: lead.phone || '(none)',
    date: (t.occurred_at || '').slice(0, 10),
    matchedOn: matchedKeyFromNotes(t.notes),
    message: messageFromNotes(t.notes),
  }
})

const byLocation = new Map()
for (const r of rows) {
  if (!byLocation.has(r.locationName)) byLocation.set(r.locationName, [])
  byLocation.get(r.locationName).push(r)
}

const locationNames = [...byLocation.keys()].sort()
console.log(
  `Found ${rows.length} resubmission touchpoint(s) across ${locationNames.length} location(s).\n`,
)

for (const locName of locationNames) {
  const group = byLocation.get(locName)
  const slug = group[0].locationSlug
  console.log(`── ${locName} (${slug}) — ${group.length} ──────────────────────────`)
  for (const r of group) {
    console.log(`  ${r.date}  ${r.name}`)
    console.log(`    email:   ${r.email}`)
    console.log(`    phone:   ${r.phone}`)
    console.log(`    matched: ${r.matchedOn}   lead: ${r.leadId}`)
    console.log(`    message: ${r.message}`)
    console.log('')
  }
}

// ── 4. Machine-readable copy for spreadsheet paste ──────────────────────────
console.log('── TSV (location\tslug\tdate\tname\temail\tphone\tmatched_on\tmessage) ──')
for (const r of rows) {
  console.log(
    [
      r.locationName,
      r.locationSlug,
      r.date,
      r.name,
      r.email,
      r.phone,
      r.matchedOn,
      r.message.replace(/\s+/g, ' '),
    ].join('\t'),
  )
}

console.log('\nDRY RUN complete — nothing was written or sent.')
