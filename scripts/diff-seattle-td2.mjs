// scripts/diff-seattle-td2.mjs
//
// READ-ONLY. Dumps the full body of Gen 1 `td2` next to Seattle's
// "Seattle Organizing · Avail + Calendar + Phone" so the divergence can be
// judged by eye: real owner edit vs. incidental whitespace.
// NO WRITES.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)
const out = (...a) => console.log(...a)

const { data: td2 } = await db.from('templates')
  .select('id, name, subject, body').eq('legacy_id', 'td2').maybeSingle()
const { data: sea } = await db.from('templates')
  .select('id, name, subject, body, updated_at, created_at')
  .eq('id', '59955ed5-ba2a-4837-b270-298b3e00b5a4').maybeSingle()

const show = (label, t) => {
  out('\n' + '═'.repeat(78))
  out(`${label}  —  "${t.name}"`)
  out('═'.repeat(78))
  out(`subject: ${JSON.stringify(t.subject)}`)
  out(`body (${String(t.body ?? '').length} chars):`)
  out('┄'.repeat(78))
  out(t.body)
  out('┄'.repeat(78))
}
show('GEN 1  td2', td2)
show('SEATTLE', sea)
out(`\nSeattle created_at: ${sea.created_at}`)
out(`Seattle updated_at: ${sea.updated_at}`)

// Line-level diff, whitespace made visible.
const vis = (s) => s.replace(/\r/g, '␍').replace(/\t/g, '␉').replace(/ +$/g, m => '·'.repeat(m.length))
const A = String(td2.body ?? '').split('\n')
const B = String(sea.body ?? '').split('\n')
out('\n' + '═'.repeat(78))
out('LINE-BY-LINE  (- = td2 only, + = Seattle only, blank = identical)')
out('═'.repeat(78))
for (let i = 0; i < Math.max(A.length, B.length); i++) {
  const a = A[i], b = B[i]
  if (a === b) { out(`  ${i + 1}  ${vis(a ?? '')}`); continue }
  if (a !== undefined) out(`- ${i + 1}  ${vis(a)}`)
  if (b !== undefined) out(`+ ${i + 1}  ${vis(b)}`)
}

// Is the difference only whitespace/case?
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
out('\n── NORMALIZED COMPARISON ──')
out(`   whitespace-collapsed bodies identical? ${norm(td2.body) === norm(sea.body) ? 'YES — divergence is whitespace only' : 'NO — the text itself differs'}`)
out(`   subjects byte-identical? ${td2.subject === sea.subject ? 'YES' : 'NO'}`)
