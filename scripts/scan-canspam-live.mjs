// scripts/scan-canspam-live.mjs
//
// READ-ONLY. The live half of the CAN-SPAM check.
//
// lib/beta-drip-canspam-tripwire.test.ts checks the master copy in migrations/
// on every test run, but most of what actually sends lives only in the
// database: every location's own drip sequences, every owner-edited copy of a
// standalone template, and any master edited in the app rather than by
// migration. This script runs the SAME rules (lib/canspam-classifier.ts) over
// all of it:
//
//   • the 7 standalone masters (welcome, the 2 Closed-Job follow-ups, the 4
//     estimate follow-ups) and every ACTIVE owner-edited copy of them
//   • every email step of every drip sequence, master and location-owned —
//     the text that actually sends (the step's own body, else its linked
//     template's, exactly as lib/drip-send.ts chooses)
//
// It flags:
//   NEEDS A LOOK  a footer-less email (a drip step or estimate follow-up) that
//                 carries an offer or the brand story, or doesn't mention the
//                 recipient's own enquiry
//   CHANGED       a standard (master) email whose promo content no longer
//                 matches what was assessed
// Emails that carry the unsubscribe footer (welcome, 3- and 12-month
// follow-ups) are compliant by the footer and are only checked for CHANGED.
//
// A flag means "a person should read this email", not "this is a violation".
//
// Writes nothing. Usage:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/scan-canspam-live.mjs
// (the flag only hushes Node's notice about loading a .ts file; harmless without it)
// Exit: 0 nothing flagged · 1 something flagged · 2 could not read the data

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  auditLiveEmail,
  COMMERCIAL_PRIMARY,
  PROMO_MARKERS,
  INCIDENTAL_PROMO,
  STANDARD,
  ACCEPTED_WITHOUT_ENQUIRY_WORDS,
} = await import(
  pathToFileURL(join(ROOT, 'lib/canspam-classifier.ts')).href
)

for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const TEMPLATE_KEYS = [
  'welcome',
  'opp_closed_job_3mo',
  'opp_closed_job_12mo',
  'opp_organizing_estimate_3d',
  'opp_organizing_estimate_30d',
  'opp_moving_estimate_3d',
  'opp_moving_estimate_30d',
]

function fail(what, error) {
  console.error(`Could not read ${what}: ${error.message}`)
  process.exit(2)
}

// Every row, 1000 at a time (the API's page size).
async function all(what, build) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) fail(what, error)
    rows.push(...data)
    if (data.length < 1000) return rows
  }
}

// ── Read ─────────────────────────────────────────────────────────────────
const locations = new Map(
  (await all('locations', () => db.from('locations').select('id, name'))).map((l) => [l.id, l.name]),
)
const where = (locId) => (locId ? `Bee Organized ${locations.get(locId) ?? locId}` : 'Standard (all locations)')

const masters = await all('standard templates', () =>
  db.from('templates').select('id, legacy_id, name, body').is('location_uuid', null).in('legacy_id', TEMPLATE_KEYS),
)
const masterById = new Map(masters.map((t) => [t.id, t]))
const copies = await all('owner-edited template copies', () =>
  db
    .from('templates')
    .select('id, name, body, location_uuid, cloned_from_id, updated_at')
    .not('location_uuid', 'is', null)
    .eq('is_active', true)
    .in('cloned_from_id', masters.map((t) => t.id)),
)

const paths = await all('drip sequences', () =>
  db.from('drip_paths').select('id, location_uuid, path_key, name, is_active, is_master'),
)
const pathById = new Map(paths.map((p) => [p.id, p]))
const steps = await all('drip steps', () =>
  db
    .from('drip_path_steps')
    .select('id, drip_path_id, step_order, channel, body, is_active, templates:master_template_id ( body )')
    .eq('channel', 'email'),
)

// Which sequences have someone on them right now.
const liveLeads = new Map()
for (const r of await all('drip progress', () =>
  db.from('lead_drip_progress').select('drip_path_id').is('completed_at', null).is('stopped_at', null),
)) {
  liveLeads.set(r.drip_path_id, (liveLeads.get(r.drip_path_id) ?? 0) + 1)
}

// ── Build the list of emails, as they send ──────────────────────────────
const emails = []

for (const t of masters) {
  emails.push({
    key: t.legacy_id,
    isMaster: true,
    footered: COMMERCIAL_PRIMARY.includes(t.legacy_id),
    body: t.body ?? '',
    place: STANDARD,
    where: where(null),
    what: t.name ?? t.legacy_id,
    inUse: 'standard copy',
  })
}
for (const t of copies) {
  const m = masterById.get(t.cloned_from_id)
  emails.push({
    key: m.legacy_id,
    isMaster: false,
    footered: COMMERCIAL_PRIMARY.includes(m.legacy_id),
    body: t.body ?? '',
    place: t.location_uuid,
    where: where(t.location_uuid),
    what: `${t.name ?? m.name} (their edited copy of "${m.name}")`,
    inUse: `edited ${String(t.updated_at).slice(0, 10)}`,
  })
}
for (const s of steps) {
  const p = pathById.get(s.drip_path_id)
  if (!p) continue
  const linked = Array.isArray(s.templates) ? s.templates[0] : s.templates
  const body = s.body ?? linked?.body ?? ''
  if (!body.trim()) continue // drip-send refuses a blank body; nothing goes out
  const n = liveLeads.get(p.id) ?? 0
  emails.push({
    key: `${p.path_key}#${s.step_order}`,
    isMaster: p.is_master === true,
    footered: false,
    body,
    place: p.is_master ? STANDARD : p.location_uuid,
    where: where(p.is_master ? null : p.location_uuid),
    what: `"${p.name}" sequence, email ${s.step_order}`,
    inUse:
      p.is_active === false || s.is_active === false
        ? 'switched off'
        : n
          ? `${n} lead${n === 1 ? '' : 's'} on it now`
          : 'nobody on it now',
  })
}

// ── Check ────────────────────────────────────────────────────────────────
// The line(s) that tripped a promo marker, so the reader can see why.
function promoLines(body) {
  const flagged = Object.keys(PROMO_MARKERS).filter((k) => !INCIDENTAL_PROMO.includes(k))
  return body
    .split('\n')
    .filter((line) => flagged.some((k) => PROMO_MARKERS[k].test(line)))
    .map((line) => line.trim())
    .filter(Boolean)
}

const flagged = []
for (const e of emails) {
  const findings = auditLiveEmail(e)
  if (findings.length) flagged.push({ ...e, findings })
}

// ── Report ───────────────────────────────────────────────────────────────
const count = (pred) => emails.filter(pred).length
console.log('CAN-SPAM live check — read-only')
console.log(
  `Checked ${emails.length} emails: ${count((e) => !e.footered)} with no unsubscribe footer ` +
    `(drip steps, estimate follow-ups), ${count((e) => e.footered)} with the footer ` +
    `(welcome, 3- and 12-month follow-ups).`,
)
console.log(
  `  ${masters.length} standard templates, ${copies.length} owner-edited copies, ` +
    `${steps.length} drip emails across ${paths.length} sequences.`,
)
console.log('')

for (const level of ['problem', 'changed']) {
  const rows = flagged.filter((f) => f.findings.some((x) => x.level === level))
  const title =
    level === 'problem'
      ? 'NEEDS A LOOK — goes out with no unsubscribe footer, and the rules cannot see why that is allowed'
      : 'CHANGED — a standard email no longer matches what was assessed'
  console.log(`${title}: ${rows.length}`)
  for (const f of rows) {
    console.log(`  • ${f.where} — ${f.what} [${f.inUse}]`)
    for (const x of f.findings.filter((x) => x.level === level)) console.log(`      ${x.reason}`)
    if (level === 'problem') for (const line of promoLines(f.body)) console.log(`      > ${line}`)
  }
  console.log('')
}

console.log(
  `Reviewed and accepted (lib/canspam-classifier.ts, with the reason): ${ACCEPTED_WITHOUT_ENQUIRY_WORDS.length} ` +
    'returning-client nudges — they stay accepted only while their text is unchanged.',
)
console.log('')
console.log(flagged.length ? `${flagged.length} email(s) need a person to read them.` : 'Nothing flagged.')
process.exit(flagged.length ? 1 : 0)
