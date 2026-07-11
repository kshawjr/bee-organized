// ═══════════════════════════════════════════════════════════════════════════
// Jobber live-schema introspection — READ-ONLY.
//
// Answers "what does the schema ACTUALLY accept" questions before we
// write a mutation (the billing-address push had to ship on secondhand
// schema evidence because this didn't exist; the property push didn't —
// Kevin authorized the pattern 7/10).
//
// Usage:  node scripts/introspect-jobber-schema.mjs ClientEditInput PropertyEditInput
//    or:  node scripts/introspect-jobber-schema.mjs --mutations propert --queries visit
//    or:  node scripts/introspect-jobber-schema.mjs --enum ScheduledItemType
// Flags:  --env <path>       env file (default .env.local — run from repo root)
//         --mutations <re>   list mutation fields (with args) matching the regex
//         --queries <re>     list root query fields matching the regex
//         --enum <name>      dump an enum's values
//
// READ-ONLY: pure __type/__schema introspection — zero data reads, zero
// writes. Uses a stored NON-EXPIRED token only; never refreshes (an
// expired-everywhere state exits 2 rather than rotating token columns).
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const flagVal = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null }
const typeNames = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')))

const env = Object.fromEntries(
  readFileSync(flagVal('--env') || '.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('missing supabase env — run from repo root or pass --env <path>')
  process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const { data: locs } = await sb
  .from('locations')
  .select('location_id, jobber_access_token, token_expiry')
  .not('jobber_access_token', 'is', null)

const now = Date.now()
const live = (locs || []).find(l => l.token_expiry && now < parseInt(l.token_expiry) - 5 * 60 * 1000)
if (!live) {
  console.error('NO_VALID_TOKEN: no location has a non-expired token; not refreshing (read-only run)')
  process.exit(2)
}
console.log(`# token: ${live.location_id} (expires ${new Date(parseInt(live.token_expiry)).toISOString()})\n`)

async function gql(query, variables) {
  const res = await fetch('https://api.getjobber.com/api/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${live.jobber_access_token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': '2025-04-16',
    },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

const fmtType = t => {
  if (!t) return '?'
  if (t.kind === 'NON_NULL') return `${fmtType(t.ofType)}!`
  if (t.kind === 'LIST') return `[${fmtType(t.ofType)}]`
  return t.name
}

const TYPE_Q = `query T($name: String!) { __type(name: $name) {
  name kind
  inputFields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
  fields { name type { kind name ofType { kind name ofType { kind name } } } args { name type { kind name ofType { kind name } } } }
  enumValues { name }
} }`

async function dumpType(name) {
  const r = await gql(TYPE_Q, { name })
  const t = r?.data?.__type
  if (!t) { console.log(`## ${name}: NOT FOUND\n`); return }
  console.log(`## ${t.name} (${t.kind})`)
  if (t.enumValues?.length) console.log(`  ${t.enumValues.map(v => v.name).join(', ')}`)
  for (const f of t.inputFields || t.fields || []) {
    const args = f.args?.length ? `(${f.args.map(a => `${a.name}: ${fmtType(a.type)}`).join(', ')})` : ''
    console.log(`  ${f.name}${args}: ${fmtType(f.type)}`)
  }
  console.log('')
}

async function dumpRoot(kind, re) {
  const r = await gql(`{ __schema { ${kind} { fields { name args { name type { kind name ofType { kind name } } } } } } }`)
  const fields = r?.data?.__schema?.[kind]?.fields || []
  console.log(`## ${kind} matching /${re}/i`)
  for (const m of fields.filter(m => new RegExp(re, 'i').test(m.name))) {
    console.log(`  ${m.name}(${m.args.map(a => `${a.name}: ${fmtType(a.type)}`).join(', ')})`)
  }
  console.log('')
}

for (const n of typeNames) await dumpType(n)
if (flagVal('--enum')) await dumpType(flagVal('--enum'))
if (flagVal('--mutations')) await dumpRoot('mutationType', flagVal('--mutations'))
if (flagVal('--queries')) await dumpRoot('queryType', flagVal('--queries'))
if (!typeNames.length && !flagVal('--enum') && !flagVal('--mutations') && !flagVal('--queries')) {
  console.error('nothing to do — pass type names and/or --mutations/--queries/--enum')
  process.exit(1)
}
