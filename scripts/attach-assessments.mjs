// HIVE Phase 1 — attach assessments to engagements (idempotent).
// Usage: node scripts/attach-assessments.mjs [envfile] [--execute]
// DRY-RUN BY DEFAULT. Pre-schema tolerant: the dry run works before the
// engagement_id column exists (idempotency skip only applies post-schema).
//
// Attach logic (hub-and-spoke, same as the backfill):
//   1. assessment.service_request_id → that SR's engagement (the normal
//      case — upsertAssessment always writes the SR link).
//   2. No SR link: client has exactly one engagement → trivially that one.
//   3. No SR link, several engagements → the one whose founding request
//      (created_at) is nearest the assessment's scheduled_at (logged as
//      ambiguous).
//   4. Unresolvable → left null, logged.
import { readFileSync } from 'fs'

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const envPath = args.find(a => !a.startsWith('--')) || '.env.local'
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, authorization: `Bearer ${KEY}` }

async function fetchAll(t, s) {
  const out = []
  for (let f = 0; ; f += 1000) {
    const r = await fetch(`${URL_}/rest/v1/${t}?select=${s}&order=id.asc`, { headers: { ...H, range: `${f}-${f + 999}` } })
    if (!r.ok) throw new Error(`${t}: ${r.status} ${await r.text()}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

console.error(`mode: ${EXECUTE ? 'EXECUTE (writes!)' : 'dry-run (no writes)'}`)
let assessments
let hasColumn = true
try {
  assessments = await fetchAll('assessments', 'id,lead_id,service_request_id,scheduled_at,engagement_id')
} catch (e) {
  if (!String(e).includes('engagement_id')) throw e
  hasColumn = false
  if (EXECUTE) { console.error('ABORT: engagement_id column missing — run the migration first'); process.exit(2) }
  assessments = await fetchAll('assessments', 'id,lead_id,service_request_id,scheduled_at')
  console.error('note: engagement_id column not present yet (pre-schema dry run)')
}
const [srs, engs] = await Promise.all([
  fetchAll('service_requests', 'id,engagement_id'),
  fetchAll('engagements', 'id,client_id,created_at'),
])
const srEng = new Map(srs.map(s => [s.id, s.engagement_id]))
const engsByClient = new Map()
for (const e of engs) {
  if (!engsByClient.has(e.client_id)) engsByClient.set(e.client_id, [])
  engsByClient.get(e.client_id).push(e)
}

const plan = [], ambiguous = [], unresolvable = []
let alreadyAttached = 0, viaSr = 0, viaSingle = 0, viaNearest = 0
for (const a of assessments) {
  if (hasColumn && a.engagement_id) { alreadyAttached++; continue }
  const bySr = a.service_request_id ? srEng.get(a.service_request_id) : null
  if (bySr) { plan.push({ id: a.id, engagement_id: bySr }); viaSr++; continue }
  const cands = engsByClient.get(a.lead_id) ?? []
  if (cands.length === 1) { plan.push({ id: a.id, engagement_id: cands[0].id }); viaSingle++; continue }
  if (cands.length > 1) {
    const t = new Date(a.scheduled_at || 0).getTime() || 0
    const best = cands.slice().sort((x, y) =>
      Math.abs((new Date(x.created_at).getTime() || 0) - t) - Math.abs((new Date(y.created_at).getTime() || 0) - t))[0]
    plan.push({ id: a.id, engagement_id: best.id })
    ambiguous.push({ assessment: a.id, lead: a.lead_id, chose: best.id, of: cands.length })
    viaNearest++
    continue
  }
  unresolvable.push({ assessment: a.id, lead: a.lead_id, note: 'no SR link, client has no engagements' })
}

console.log(JSON.stringify({
  total: assessments.length, alreadyAttached,
  toAttach: plan.length, viaSr, viaSingleEngagement: viaSingle, viaNearestFounding: viaNearest,
  ambiguous, unresolvable: unresolvable.length, unresolvableDetail: unresolvable.slice(0, 10),
}, null, 1))

if (!EXECUTE) { console.log('\nDRY RUN — no writes. Re-run with --execute after the migration + approval.'); process.exit(0) }

let done = 0
for (const p of plan) {
  const r = await fetch(`${URL_}/rest/v1/assessments?id=eq.${p.id}&engagement_id=is.null`, {
    method: 'PATCH', headers: { ...H, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ engagement_id: p.engagement_id }),
  })
  if (!r.ok) { console.error(`FAIL ${p.id}: ${r.status}`); continue }
  if (++done % 200 === 0) console.log(`${done}/${plan.length}`)
}
console.log(`DONE: ${done}/${plan.length} attached`)
