// ═══════════════════════════════════════════════════════════════════════════
// Repair: stale-stamped Closed Lost engagements that are actually WON —
// the PAID-INVOICE variant (2026-07-21 — companion to repair-stale-won.mjs)
//
// Usage:  node scripts/repair-stale-won-paid.mjs [envfile]            (dry run)
//         node scripts/repair-stale-won-paid.mjs [envfile] --execute  (writes)
//
// WHY A SECOND SCRIPT. repair-stale-won.mjs (2026-07-10) recovered stale-Lost
// rows whose CHILDREN satisfy deriveEngagementStage's won-condition: ≥1 booked
// job, ALL booked jobs done, ≥1 invoice, all paid. These 16 do NOT: their
// Jobber job card sits at action_required / unscheduled / late (never marked
// complete), so deriveEngagementStage yields Estimate / Job in Progress — both
// LOWER rank than Closed Lost — and the staleLostOverride never fires. They do
// not self-heal on webhook/panel re-derive. Yet the money IS collected: each
// has a converted (approved) Jobber quote and a PAID-in-full invoice
// (invoiceStatus=paid, balance 0, PAYMENT/DEPOSIT records only — refund/void
// checked and none found, 2026-07-21 Jobber re-verify).
//
// POLICY THIS ENCODES (the deliberate difference from deriveEngagementStage):
// a paid-in-full invoice = won money even when the Jobber job was never marked
// complete. This is a repair judgment, NOT a change to the live derivation —
// nothing here re-implements stage derivation; it is a scoped one-shot write,
// exactly as repair-stale-won.mjs is.
//
// SCOPE (belt-and-suspenders): engagements at stage 'Closed Lost' AND
// closed_reason 'stale_on_import' (machine stamps only — human closes carry
// other reasons and are never touched) whose invoices are FULLY PAID
// (≥1 invoice, every invoice status 'paid'), AND whose id is in the explicit
// ALLOWLIST of the 16 rows verified against Jobber. Any row not in the
// allowlist is reported and SKIPPED even if it matches the predicate.
//
// The flip mirrors repair-stale-won.mjs exactly:
//   stage 'Closed Won' · closed_reason 'won' ·
//   closed_at = REAL last paid_at · closed_note null ·
//   stage_entered_at/updated_at = now
// plus a system stage_change touchpoint (user_id null) + sync_log per flip.
//
// Idempotent: a flipped row no longer matches (closed_reason becomes 'won').
// Dry run writes repair-stale-won-paid.report.dryrun.json and touches nothing.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'

const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const envPath = argv.find(a => !a.startsWith('--')) || '.env.local'

// The 16 engagement ids verified against Jobber (converted quote + paid-in-full
// invoice, no refund/void) on 2026-07-21. The WHERE is scoped to these ids so
// it is structurally incapable of touching any other engagement.
const ALLOWLIST = new Set([
  '3522348d-e4ff-4e2f-bfd8-54d90fafd760', // Carol Melville        loc_temecula
  'fb06bfee-0c79-43d3-b7a4-475c9bd0c1db', // Barrie Calhoun        loc_temecula
  'b7e3ae10-dcda-49ba-a773-21fb9cc1014a', // Paige Hardy           loc_temecula
  'e4933ea7-98d8-48a0-b33a-530f4851f637', // Barrie Calhoun        loc_temecula
  '741622f0-8f16-4a1e-88be-8796fc19c172', // Megan McKinney-Rickey loc_temecula
  '44a79127-ed38-402e-ab2b-4dc29cc69e11', // George Simmons        loc_temecula
  'dfa1f7d3-ad9f-4814-8bae-52b0c96c63bc', // Margo Smith           loc_temecula
  'df3dee3f-a8f0-4242-adad-4f96330defdc', // Jamaal Turner         loc_temecula
  '66db44e0-9b69-4615-821a-b54531909323', // Adina Stern           loc_temecula
  '78a138c1-f164-4eb2-bf04-3b9836e231eb', // Kennise Clark         loc_temecula
  '9153dad2-8c96-4d76-a69f-5bfff148a18c', // Shelia & Bill Guy     loc_temecula
  '417beb10-ffae-4aa0-a22e-8965ede6f30e', // Eric Powell           loc_temecula
  'd6d3b691-818c-4116-a2e0-f61446207e31', // Michelle Wright       loc_temecula
  '5abe87e3-9b5a-4982-9697-934961e3c47c', // Allison Hoge          loc_temecula
  '6de5a215-f37b-4624-a88d-12acedc5d35a', // Allison Hoge          loc_temecula
  'c61497e3-9f5c-474f-a54f-d7800d27a9f8', // Mary Jochim           loc_omaha
])

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SB_URL || !SB_KEY) { console.error('missing supabase env'); process.exit(1) }

async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error(`PostgREST ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`)
  const text = await res.text(); return text ? JSON.parse(text) : null
}
async function sbAll(base) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const page = await sb(`${base}${base.includes('?') ? '&' : '?'}offset=${from}&limit=1000`)
    out.push(...page); if (page.length < 1000) break
  }
  return out
}
const ts = v => (v ? new Date(v).getTime() || 0 : 0)
const nowIso = () => new Date().toISOString()
const THIRTY_D = 30 * 24 * 60 * 60 * 1000

console.log(`repair-stale-won-paid — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'}\n`)

// ── load scope + children ───────────────────────────────────────────────────
const locations = await sbAll('locations?select=id,name,location_id')
const locName = Object.fromEntries(locations.map(l => [l.id, l.name]))
const locSlug = Object.fromEntries(locations.map(l => [l.id, l.location_id]))

const staleLost = await sbAll(
  'engagements?stage=eq.Closed%20Lost&closed_reason=eq.stale_on_import' +
  '&select=id,client_id,location_uuid,total_paid,total_invoiced,closed_at,closed_note')

const invAll = await sbAll('invoices?select=engagement_id,status,paid_amount,paid_at&engagement_id=not.is.null')
const invBy = {}
for (const i of invAll) (invBy[i.engagement_id] ||= []).push(i)

// ── classify: fully-paid AND allowlisted → flip ─────────────────────────────
const flips = []
const predicateMatchedNotAllowlisted = []
for (const e of staleLost) {
  const invs = invBy[e.id] || []
  const fullyPaid = invs.length > 0 && invs.every(i => i.status === 'paid') // invoicesFullyPaid semantics
  if (!fullyPaid) continue
  if (!ALLOWLIST.has(e.id)) { predicateMatchedNotAllowlisted.push(e.id); continue }
  const lastPaidAt = Math.max(0, ...invs.map(i => ts(i.paid_at)))
  flips.push({
    ...e,
    loc: locName[e.location_uuid] || e.location_uuid,
    slug: locSlug[e.location_uuid] || 'unknown',
    paid: Number(e.total_paid) || 0,
    newClosedAt: new Date(lastPaidAt || Date.now()).toISOString(),
  })
}

// ── project people-side effect (Past→Client), same derivation the app uses ──
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
const statusMoves = {}, moveList = []
for (const cid of new Set(flips.map(f => f.client_id))) {
  const l = leadById[cid]; if (!l || l.is_junk === true) continue
  const before = derive(l, wonIds), after = derive(l, wonIdsAfter)
  if (before !== after) {
    const key = `${before} → ${after}`
    statusMoves[key] = (statusMoves[key] || 0) + 1
    moveList.push({ lead_id: cid, name: l.name, loc: locName[l.location_uuid], move: key })
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const perLoc = {}
for (const f of flips) { const s = (perLoc[f.loc] ||= { flips: 0, dollars: 0 }); s.flips++; s.dollars += f.paid }

console.log(`allowlist size: ${ALLOWLIST.size}`)
console.log(`stale_on_import + fully-paid in prod: ${flips.length + predicateMatchedNotAllowlisted.length}`)
console.log(`  → allowlisted flips: ${flips.length}  ($${Math.round(flips.reduce((s, f) => s + f.paid, 0)).toLocaleString()})`)
console.log(`  → matched predicate but NOT allowlisted (skipped): ${predicateMatchedNotAllowlisted.length}`, predicateMatchedNotAllowlisted)
for (const [n, s] of Object.entries(perLoc)) console.log(`  ${n}: ${s.flips} flips, $${Math.round(s.dollars).toLocaleString()}`)
console.log(`\nbefore → after (each engagement):`)
for (const f of flips) {
  console.log(`  ${f.slug} ${leadById[f.client_id]?.name || f.client_id}`)
  console.log(`    stage:         Closed Lost → Closed Won`)
  console.log(`    closed_reason: stale_on_import → won`)
  console.log(`    closed_at:     ${f.closed_at} → ${f.newClosedAt}`)
  console.log(`    closed_note:   ${JSON.stringify(f.closed_note)} → null`)
  console.log(`    paid:          $${f.paid}`)
}
console.log(`\npeople-side status moves (${moveList.length} clients):`)
for (const [k, n] of Object.entries(statusMoves)) console.log(`  ${k}: ${n}`)
for (const m of moveList) console.log(`    ${m.name} (${m.loc}): ${m.move}`)

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run',
  allowlistSize: ALLOWLIST.size,
  flips: flips.length,
  predicateMatchedNotAllowlisted,
  perLocation: perLoc,
  dollarsRecovered: Math.round(flips.reduce((s, f) => s + f.paid, 0)),
  statusMoves, moveList,
  flipIds: flips.map(f => ({ id: f.id, client_id: f.client_id, loc: f.loc, paid: f.paid, closed_at_before: f.closed_at, closed_at_after: f.newClosedAt })),
  errors: [],
}

// ── execute ─────────────────────────────────────────────────────────────────
if (EXECUTE) {
  console.log('\nexecuting…')
  let done = 0
  for (const f of flips) {
    try {
      const stamp = nowIso()
      // Guarded: id-pinned + stage + closed_reason — cannot hit a row that
      // isn't this exact stale-Lost engagement.
      await sb(`engagements?id=eq.${f.id}&stage=eq.Closed%20Lost&closed_reason=eq.stale_on_import`, {
        method: 'PATCH',
        body: JSON.stringify({
          stage: 'Closed Won', closed_reason: 'won', closed_at: f.newClosedAt,
          closed_note: null, stage_entered_at: stamp, updated_at: stamp,
        }),
        headers: { Prefer: 'return=minimal' },
      })
      try {
        await sb('touchpoints', {
          method: 'POST',
          body: JSON.stringify({
            lead_id: f.client_id, location_uuid: f.location_uuid, engagement_id: f.id,
            kind: 'stage_change', label: 'Stage: Closed Lost → Closed Won', occurred_at: stamp,
          }),
          headers: { Prefer: 'return=minimal' },
        })
        await sb('sync_log', {
          method: 'POST',
          body: JSON.stringify({
            location_id: f.slug, direction: 'inbound', entity_type: 'engagement',
            entity_id: f.id, status: 'success',
            message: `[engagement:repair] stale_on_import Lost → Won (paid-in-full, job never marked complete; $${f.paid}); closed_at ${f.newClosedAt}`,
          }),
          headers: { Prefer: 'return=minimal' },
        })
      } catch (e) { console.error(`  audit-trail write failed for ${f.id} (flip committed):`, e.message) }
      done++
    } catch (err) { report.errors.push(`${f.id}: ${err.message}`); console.error(`  ✗ ${f.id}: ${err.message}`) }
  }
  console.log(`flipped ${done}/${flips.length}`)
}

const outPath = `repair-stale-won-paid.report.${EXECUTE ? 'run' : 'dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}`)
