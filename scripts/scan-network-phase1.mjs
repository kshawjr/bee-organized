// scripts/scan-network-phase1.mjs
// ═══════════════════════════════════════════════════════════════════════════
// READ-ONLY dry analysis for migrations/network_phase1.sql (Network tab,
// Phase 1). Reports the current state of every table the migration touches
// so the migration can be reviewed against real numbers before Kevin runs
// it in the SQL editor. NO WRITES — every query is a count or a select.
//
// Reports:
//   · partners / companies / touchpoints / lead-referral row counts
//   · dangling partners.company_id (soft ref today; the migration adds a
//     real FK, so dangling ids must be counted and nulled first)
//   · touchpoints method/kind value distribution (the migration widens the
//     method CHECK — confirm no existing value falls outside the new set)
//
// Usage: node scripts/scan-network-phase1.mjs [path/to/.env.local]
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const envPath = process.argv[2] || '.env.local'
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const count = async (table, refine) => {
  let q = sb.from(table).select('*', { count: 'exact', head: true })
  if (refine) q = refine(q)
  const { count: n, error } = await q
  if (error) return `ERR ${error.message}`
  return n
}

console.log('═══ Network Phase 1 — dry analysis (read-only) ═══\n')

console.log('partners total            ', await count('partners'))
console.log('partners live             ', await count('partners', q => q.is('deleted_at', null)))
console.log('  type=partner            ', await count('partners', q => q.is('deleted_at', null).eq('type', 'partner')))
console.log('  type=contact            ', await count('partners', q => q.is('deleted_at', null).eq('type', 'contact')))
console.log('companies total           ', await count('companies'))
console.log('companies live            ', await count('companies', q => q.is('deleted_at', null)))
console.log('touchpoints total         ', await count('touchpoints'))
console.log('leads referred_by set     ', await count('leads', q => q.not('referred_by_id', 'is', null)))
console.log('  kind=partner            ', await count('leads', q => q.eq('referred_by_kind', 'partner')))
console.log('  kind=lead               ', await count('leads', q => q.eq('referred_by_kind', 'lead')))

// ── Dangling company_id (FK precondition) ─────────────────────────────────
// PostgREST can't anti-join, so pull both id sets and diff in JS. Partner
// and company row counts are small (CRM-scale, not lead-scale).
const { data: partnerRefs, error: pErr } = await sb
  .from('partners')
  .select('id, name, company, company_id, deleted_at')
  .not('company_id', 'is', null)
const { data: companyIds, error: cErr } = await sb
  .from('companies')
  .select('id')
if (pErr || cErr) {
  console.log('\ndangling company_id       ERR', pErr?.message || cErr?.message)
} else {
  const known = new Set((companyIds || []).map(c => c.id))
  const dangling = (partnerRefs || []).filter(p => !known.has(p.company_id))
  console.log('\npartners with company_id  ', (partnerRefs || []).length)
  console.log('  dangling (no company)   ', dangling.length)
  for (const d of dangling) {
    console.log(`    ${d.id}  ${d.name}  company="${d.company}"  →  ${d.company_id}${d.deleted_at ? '  (soft-deleted)' : ''}`)
  }
}

// ── touchpoints method/kind distribution (CHECK-widening safety) ──────────
const { data: tp, error: tErr } = await sb
  .from('touchpoints')
  .select('kind, method')
  .limit(50000)
if (tErr) {
  console.log('\ntouchpoint values         ERR', tErr.message)
} else {
  const tally = (key) => {
    const m = {}
    for (const t of tp || []) { const v = t[key] ?? '(null)'; m[v] = (m[v] || 0) + 1 }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ')
  }
  console.log(`\ntouchpoint kinds (n=${(tp || []).length})   `, tally('kind'))
  console.log('touchpoint methods        ', tally('method'))
}

// ── referral-target resolution health (polymorphic link) ──────────────────
const { data: refLeads } = await sb
  .from('leads')
  .select('id, referred_by_kind, referred_by_id')
  .not('referred_by_id', 'is', null)
  .limit(10000)
if (refLeads?.length) {
  const partnerTargets = [...new Set(refLeads.filter(l => l.referred_by_kind === 'partner').map(l => l.referred_by_id))]
  const leadTargets = [...new Set(refLeads.filter(l => l.referred_by_kind === 'lead').map(l => l.referred_by_id))]
  const chunk = (arr, n) => arr.length ? Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n)) : []
  const resolve = async (table, ids) => {
    const found = new Set()
    for (const c of chunk(ids, 200)) {
      const { data } = await sb.from(table).select('id').in('id', c)
      for (const r of data || []) found.add(r.id)
    }
    return found
  }
  const foundPartners = await resolve('partners', partnerTargets)
  const foundLeads = await resolve('leads', leadTargets)
  console.log('\nreferrer targets (partner)', partnerTargets.length, '· dangling', partnerTargets.filter(id => !foundPartners.has(id)).length)
  console.log('referrer targets (lead)   ', leadTargets.length, '· dangling', leadTargets.filter(id => !foundLeads.has(id)).length)
}

console.log('\nDone. No writes were performed.')
