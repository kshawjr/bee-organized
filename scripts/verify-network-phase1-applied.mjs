// scripts/verify-network-phase1-applied.mjs
// READ-ONLY gate for Network Phase 2: confirm migrations/network_phase1.sql
// actually ran in prod before any code builds on it. The migration is ONE
// transaction (BEGIN…COMMIT), so the new columns existing proves the whole
// file committed — the CHECK/FK pieces ride the same commit.
//
// Usage: node scripts/verify-network-phase1-applied.mjs [path/to/.env.local]

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

let ok = true
const probe = async (label, table, cols) => {
  const { error } = await sb.from(table).select(cols).limit(1)
  const pass = !error
  if (!pass) ok = false
  console.log(`${pass ? '✓' : '✗'} ${label}${pass ? '' : ` — ${error.message}`}`)
}

console.log('═══ network_phase1.sql applied? (read-only probes) ═══')
await probe('touchpoints.partner_id column', 'touchpoints', 'id, partner_id')
await probe('partners.last_contacted_at column', 'partners', 'id, last_contacted_at')

// Sanity: a partner touchpoint may already exist (not required — just report).
const { count: partnerTps } = await sb
  .from('touchpoints')
  .select('*', { count: 'exact', head: true })
  .not('partner_id', 'is', null)
console.log(`  partner-subject touchpoints so far: ${partnerTps ?? '?'}`)
const { count: companyRefs } = await sb
  .from('leads')
  .select('*', { count: 'exact', head: true })
  .eq('referred_by_kind', 'company')
console.log(`  company-referred leads so far: ${companyRefs ?? '?'}`)

console.log(ok
  ? '\nPASS — single-transaction migration committed; safe to build Phase 2.'
  : '\nFAIL — migration NOT (fully) applied. STOP: do not ship Phase 2.')
process.exit(ok ? 0 : 1)
