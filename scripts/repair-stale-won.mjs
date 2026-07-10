// ═══════════════════════════════════════════════════════════════════════════
// Repair: stale-stamped Closed Lost engagements that are actually WON
// (2026-07-10 — companion to the ad7050c rank-tie fix)
//
// Usage:  node scripts/repair-stale-won.mjs [envfile]            (dry run)
//         node scripts/repair-stale-won.mjs [envfile] --execute  (writes)
//
// The 8117ff5 requestless backfill processed quotes before jobs: a stale
// quote founded an engagement immediately stamped Closed Lost
// (stale_on_import), and when the Job.quote-linked job + paid invoices
// attached, the forward-only rank rule (Won and Lost tie at terminal
// rank) blocked the re-derivation from flipping it to Closed Won. This
// script applies the same override ad7050c added to the live advance
// rule, as a one-shot repair of the rows created before that fix.
//
// Scope: engagements with stage 'Closed Lost' AND closed_reason
// 'stale_on_import' (machine stamps ONLY — human closes carry other
// reasons and are never touched) whose children prove the won-condition
// deriveEngagementStage uses: ≥1 job, ALL jobs done, ≥1 invoice, ALL
// invoices paid. Everything else — quote-only stale closes, partial
// payment, no invoices — is left exactly as it is.
//
// The flip mirrors what maybeAdvanceEngagementStage would now write:
//   stage 'Closed Won' · closed_reason 'won' ·
//   closed_at = REAL last paid_at (not repair time) ·
//   closed_note null (the stale note is wrong on a Won row) ·
//   stage_entered_at/updated_at = now
// plus the drift-recovery audit trail: a system stage_change touchpoint
// (user_id null) and a sync_log breadcrumb per flip.
//
// Idempotent: a flipped row no longer matches the scope; re-running is a
// no-op. Dry run writes repair-stale-won.report.json and touches nothing.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'

const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const envPath = argv.find(a => !a.startsWith('--')) || '.env.local'

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    })
)
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SB_URL || !SB_KEY) { console.error('missing supabase env'); process.exit(1) }

async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`PostgREST ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function sbAll(pathBase) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const page = await sb(`${pathBase}${pathBase.includes('?') ? '&' : '?'}offset=${from}&limit=1000`)
    out.push(...page)
    if (page.length < 1000) break
  }
  return out
}

const ts = v => (v ? new Date(v).getTime() || 0 : 0)
const nowIso = () => new Date().toISOString()
const jobDone = j => !!j.completed_at || (j.status || '').toLowerCase().includes('complet')
const THIRTY_D = 30 * 24 * 60 * 60 * 1000

console.log(`repair-stale-won — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'}\n`)

// ── load scope + children ───────────────────────────────────────────────────

const locations = await sbAll('locations?select=id,name,location_id')
const locName = Object.fromEntries(locations.map(l => [l.id, l.name]))
const locSlug = Object.fromEntries(locations.map(l => [l.id, l.location_id]))

const staleLost = await sbAll(
  'engagements?stage=eq.Closed%20Lost&closed_reason=eq.stale_on_import' +
  '&select=id,client_id,location_uuid,total_paid,total_invoiced,closed_at,created_at,closed_note')

const jobsAll = await sbAll('jobs?select=engagement_id,status,completed_at&engagement_id=not.is.null')
const invAll = await sbAll('invoices?select=engagement_id,status,paid_amount,paid_at&engagement_id=not.is.null')
const jobsBy = {}, invBy = {}
for (const j of jobsAll) (jobsBy[j.engagement_id] ||= []).push(j)
for (const i of invAll) (invBy[i.engagement_id] ||= []).push(i)

// ── classify ────────────────────────────────────────────────────────────────

const flips = []      // won-condition holds → flip
const heldOut = []    // money present but won-condition fails → NEVER touch, report
for (const e of staleLost) {
  const jobs = jobsBy[e.id] || []
  const invs = invBy[e.id] || []
  const won = jobs.length > 0 && jobs.every(jobDone) && invs.length > 0 && invs.every(i => i.status === 'paid')
  if (won) {
    const lastPaidAt = Math.max(0, ...invs.map(i => ts(i.paid_at)))
    flips.push({
      ...e,
      loc: locName[e.location_uuid] || e.location_uuid,
      slug: locSlug[e.location_uuid] || 'unknown',
      paid: Number(e.total_paid) || 0,
      newClosedAt: new Date(lastPaidAt || Date.now()).toISOString(),
    })
  } else if ((Number(e.total_paid) || 0) > 0) {
    heldOut.push({
      id: e.id, client_id: e.client_id, loc: locName[e.location_uuid],
      paid: Number(e.total_paid), jobs: jobs.length,
      jobsDone: jobs.filter(jobDone).length,
      invoices: invs.length, invoicesPaid: invs.filter(i => i.status === 'paid').length,
    })
  }
}

// ── project the people-side effect (Past→Client etc.) ───────────────────────
// Same derivation the app uses (clientStatus.js), before vs after the flip.

const leads = await sbAll('leads?select=id,name,email,phone,paid_amount,created_at,is_junk,location_uuid')
const engagements = await sbAll('engagements?select=client_id,stage')
const reachCutoff = new Date(Date.now() - THIRTY_D).toISOString()
const recentReach = await sbAll(`touchpoints?select=lead_id&kind=eq.reach_out&occurred_at=gt.${reachCutoff}`)
const reached = new Set(recentReach.map(t => t.lead_id))

const openIds = new Set(), wonIds = new Set()
for (const e of engagements) {
  if (e.stage === 'Closed Won') wonIds.add(e.client_id)
  else if (e.stage !== 'Closed Lost') openIds.add(e.client_id)
}
const wonIdsAfter = new Set(wonIds)
for (const f of flips) wonIdsAfter.add(f.client_id)

const nowMs = Date.now()
function derive(l, won) {
  if (!(l.email || '').trim() && !(l.phone || '').trim()) return 'no_contact'
  if (openIds.has(l.id)) return 'Active'
  if (won.has(l.id)) return 'Client'
  if ((Number(l.paid_amount) || 0) > 0) return 'Past'
  if (reached.has(l.id)) return 'Attempting'
  if (l.created_at && nowMs - new Date(l.created_at).getTime() < THIRTY_D) return 'New'
  return 'Nurturing'
}

const leadById = Object.fromEntries(leads.map(l => [l.id, l]))
const statusMoves = {}
const moveList = []
for (const cid of new Set(flips.map(f => f.client_id))) {
  const l = leadById[cid]
  if (!l || l.is_junk === true) continue
  const before = derive(l, wonIds)
  const after = derive(l, wonIdsAfter)
  if (before !== after) {
    const key = `${before} → ${after}`
    statusMoves[key] = (statusMoves[key] || 0) + 1
    moveList.push({ lead_id: cid, name: l.name, loc: locName[l.location_uuid], move: key })
  }
}

// ── report ──────────────────────────────────────────────────────────────────

const perLoc = {}
for (const f of flips) {
  const s = (perLoc[f.loc] ||= { flips: 0, dollars: 0, zeroDollar: 0 })
  s.flips++; s.dollars += f.paid
  if (f.paid === 0) s.zeroDollar++
}

console.log(`stale_on_import Closed Lost in prod: ${staleLost.length}`)
console.log(`won-condition flips: ${flips.length}  ($${Math.round(flips.reduce((s, f) => s + f.paid, 0)).toLocaleString()} recovered)`)
for (const [n, s] of Object.entries(perLoc)) {
  console.log(`  ${n}: ${s.flips} flips, $${Math.round(s.dollars).toLocaleString()}${s.zeroDollar ? ` (${s.zeroDollar} with $0 paid — all-paid-status invoices, zero amounts)` : ''}`)
}
console.log(`held out (money but won-condition fails — untouched): ${heldOut.length}`)
for (const a of heldOut) console.log('  ', JSON.stringify(a))
console.log(`\npeople-side status moves (${moveList.length} clients):`)
for (const [k, n] of Object.entries(statusMoves)) console.log(`  ${k}: ${n}`)

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  scope: { staleLostTotal: staleLost.length, flips: flips.length, heldOut },
  perLocation: perLoc,
  dollarsRecovered: Math.round(flips.reduce((s, f) => s + f.paid, 0)),
  statusMoves,
  moveList,
  flipIds: flips.map(f => ({ id: f.id, client_id: f.client_id, loc: f.loc, paid: f.paid, newClosedAt: f.newClosedAt })),
  errors: [],
}

// ── execute ─────────────────────────────────────────────────────────────────

if (EXECUTE) {
  console.log('\nexecuting…')
  let done = 0
  for (const f of flips) {
    try {
      const stamp = nowIso()
      await sb(`engagements?id=eq.${f.id}&stage=eq.Closed%20Lost&closed_reason=eq.stale_on_import`, {
        method: 'PATCH',
        body: JSON.stringify({
          stage: 'Closed Won',
          closed_reason: 'won',
          closed_at: f.newClosedAt,
          closed_note: null,
          stage_entered_at: stamp,
          updated_at: stamp,
        }),
        headers: { Prefer: 'return=minimal' },
      })
      // Audit trail — mirrors recoverEngagementStageDrift: system
      // touchpoint (user_id null) + sync_log breadcrumb. Non-fatal.
      try {
        await sb('touchpoints', {
          method: 'POST',
          body: JSON.stringify({
            lead_id: f.client_id,
            location_uuid: f.location_uuid,
            engagement_id: f.id,
            kind: 'stage_change',
            label: 'Stage: Closed Lost → Closed Won',
            occurred_at: stamp,
          }),
          headers: { Prefer: 'return=minimal' },
        })
        await sb('sync_log', {
          method: 'POST',
          body: JSON.stringify({
            location_id: f.slug, direction: 'inbound', entity_type: 'engagement',
            entity_id: f.id, status: 'success',
            message: `[engagement:repair] stale_on_import Lost → Won (paid-in-full, $${f.paid}); closed_at set to last paid_at ${f.newClosedAt}`,
          }),
          headers: { Prefer: 'return=minimal' },
        })
      } catch (e) { console.error(`  audit-trail write failed for ${f.id} (flip committed):`, e.message) }
      done++
    } catch (err) {
      report.errors.push(`${f.id}: ${err.message}`)
      console.error(`  ✗ ${f.id}: ${err.message}`)
    }
  }
  console.log(`flipped ${done}/${flips.length}`)
}

const outPath = `repair-stale-won.report${EXECUTE ? '.run' : '.dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}`)
