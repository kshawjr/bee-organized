// scripts/network-model-dry-run.mjs
// ═══════════════════════════════════════════════════════════════════════════
// READ-ONLY dry run for migrations/network_model_backfill.sql (Network &
// Nurture, slice 2). NO WRITES to the database: every query is a select.
//
// It reads every Network contact from production, runs the TypeScript rules
// (lib/network/live-mapping.ts — the same file the app will use) over each
// one, and writes a report Kevin can read BEFORE anything is run:
//
//   <out>/network-model-dry-run.md    every contact by name, grouped by
//                                     location (Greensboro first), with what
//                                     it holds now and what it would hold
//   <out>/network-model-dry-run.csv   the same rows, one per line
//
// It also prints the MAPPING FINGERPRINT. migrations/network_model_check.sql
// prints the same fingerprint worked out by the SQL rules (its line 10). If
// the two match, the TypeScript and the SQL gave every single row the same
// type, level and stage.
//
// The report holds owners' contacts by name, so <out> must be OUTSIDE the
// repo. The script refuses to write inside it.
//
// Usage:
//   node scripts/network-model-dry-run.mjs <out dir> [--dump <file.json>] [--env <.env.local>]
//
//   --dump  also save the raw rows (for loading into a scratch copy of the
//           table). Personal data: keep it outside the repo too.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const outDir = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : null
const dumpPath = flag('--dump') ? resolve(flag('--dump')) : null
const envPath = flag('--env') || join(repo, '.env.local')

const insideRepo = (p) => !relative(repo, p).startsWith('..')
if (!outDir) { console.error('Usage: node scripts/network-model-dry-run.mjs <out dir> [--dump <file.json>]'); process.exit(1) }
if (insideRepo(outDir) || (dumpPath && insideRepo(dumpPath))) {
  console.error('Refusing to write inside the repo: the report names real contacts. Give a folder outside it.')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// ── The TypeScript rules, loaded as the app's own build would load them ────
const vite = await createServer({
  root: repo, configFile: false, logLevel: 'error', appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true },
})
const { mapLivePartner, summarizeMapping, RULED_NOT_SURE_IDS } = await vite.ssrLoadModule('/lib/network/live-mapping.ts')
const { TYPE_META, LEVEL_META } = await vite.ssrLoadModule('/lib/network/types.ts')
await vite.close()

// ── Reads (all select-only). A read that fills a whole page is refused: it
// could have been cut short, and a short list here would misreport someone.
const PAGE = 1000
async function readAll(table, columns, refine) {
  let q = sb.from(table).select(columns).range(0, PAGE - 1)
  if (refine) q = refine(q)
  const { data, error } = await q
  if (error) throw new Error(`${table}: ${error.message}`)
  if (data.length >= PAGE) throw new Error(`${table}: ${data.length} rows fills the page; this script needs paging before it can be trusted`)
  return data
}

const partners = await readAll('partners', '*', q => q.order('id'))
const partnerTags = await readAll('partner_tags', 'partner_id, tag_lookup_id')
const lookups = await readAll('lookups', 'id, label, category')
const sentLeads = await readAll('leads', 'id, referred_by_id', q => q.eq('referred_by_kind', 'partner'))
const locations = await readAll('locations', 'id, name')

const labelOf = new Map(lookups.map(l => [l.id, l.label]))
const locName = new Map(locations.map(l => [l.id, l.name]))
const tagsOf = new Map()
for (const t of partnerTags) {
  if (!tagsOf.has(t.partner_id)) tagsOf.set(t.partner_id, [])
  tagsOf.get(t.partner_id).push(labelOf.get(t.tag_lookup_id) ?? `(unknown tag ${t.tag_lookup_id})`)
}
const sentCount = new Map()
for (const l of sentLeads) if (l.referred_by_id) sentCount.set(l.referred_by_id, (sentCount.get(l.referred_by_id) || 0) + 1)

// ── Map every row ──────────────────────────────────────────────────────────
const TIER_LABEL = {
  'referral-partner': 'Referral Partner', 'power-partner': 'Power Partner',
  'service-provider': 'Service Provider', 'networking-contact': 'Networking Contact',
}
const rows = partners.map(p => {
  const tags = (tagsOf.get(p.id) || []).slice().sort((a, b) => a.localeCompare(b))
  const facts = { id: p.id, tier: p.tier, stage: p.stage, tagLabels: tags, hasSentLead: (sentCount.get(p.id) || 0) > 0 }
  const m = mapLivePartner(facts)
  return {
    id: p.id, live: p.deleted_at === null, location: locName.get(p.location_id) || `(unknown location ${p.location_id})`,
    name: p.name, company: p.company || '', email: p.email || '', phone: p.phone || '',
    nowType: p.type, nowTier: p.tier ? (TIER_LABEL[p.tier] || p.tier) : '', nowTierKey: p.tier || '', nowStage: p.stage || '',
    tags, sent: sentCount.get(p.id) || 0,
    fromClient: !!p.customer_lead_id, alsoClient: !!p.is_customer,
    facts, types: m.types, level: m.level, stage: m.stage, why: m.why, flags: m.flags,
  }
})

const fingerprint = createHash('md5').update(
  rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(r => `${r.id}|${r.types.join('+')}|${r.level || ''}|${r.stage || ''}`).join('\n'),
).digest('hex')

const live = rows.filter(r => r.live)
const binned = rows.filter(r => !r.live)
const sum = summarizeMapping(live.map(r => r.facts))

// ── Words ──────────────────────────────────────────────────────────────────
const typesWords = r => r.types.map(t => TYPE_META[t].label).join(' + ')
const levelWords = r => (r.level ? LEVEL_META[r.level].label : '—')
const stageWords = r => r.stage || '—'
const nowWords = r => [
  `tier ${r.nowTier || 'none'}`, `stage ${r.nowStage || 'none'}`,
  `tags ${r.tags.length ? r.tags.join(', ') : 'none'}`,
  r.sent ? `sent ${r.sent} lead${r.sent > 1 ? 's' : ''}` : 'sent no leads',
].join(' · ')
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
const who = r => (r.company && r.company !== r.name ? `${r.name} (${r.company})` : r.name)
const byName = (a, b) => a.name.localeCompare(b.name)

const both = live.filter(r => r.types.includes('partner') && r.types.includes('vendor')).sort(byName)
const droppedStage = live.filter(r => r.flags.some(f => f.includes('dropped: only a Referral partner has a stage'))).sort(byName)
const networkingElsewhere = live.filter(r => r.nowTierKey === 'networking-contact' && !r.types.includes('unsure')).sort(byName)
const ruled = rows.filter(r => RULED_NOT_SURE_IDS.includes(r.id)).sort(byName)
const noStage = live.filter(r => r.flags.some(f => f.startsWith('No live stage') || f.includes('is not one of the five'))).sort(byName)

// ── The report ─────────────────────────────────────────────────────────────
const L = []
const table = (list, extra) => {
  L.push(`| Contact | Location | Holds now | Would hold | ${extra ? extra.head + ' |' : ''}`)
  L.push(`| --- | --- | --- | --- | ${extra ? '--- |' : ''}`)
  for (const r of list) {
    L.push(`| ${cell(who(r))} | ${cell(r.location)} | ${cell(nowWords(r))} | ${cell(`${typesWords(r)} · level ${levelWords(r)} · stage ${stageWords(r)}`)} | ${extra ? cell(extra.cell(r)) + ' |' : ''}`)
  }
  L.push('')
}

L.push('# Network & Nurture — dry run of the new model')
L.push('')
L.push(`Made ${new Date().toISOString()} by \`scripts/network-model-dry-run.mjs\`. **Nothing has been changed.** This is what`)
L.push('`migrations/network_model_backfill.sql` WOULD write, worked out from production as it stands now.')
L.push('')
L.push('## Counts')
L.push('')
L.push('| | Live contacts |')
L.push('| --- | --- |')
L.push(`| Referral partner | **${sum.referralPartner}** |`)
L.push(`| … of those, also Vendor / Service Provider (two types) | ${sum.referralAndVendor} |`)
L.push(`| Vendor / Service Provider only | **${sum.vendorOnly}** |`)
L.push(`| Not sure yet | **${sum.notSure}** |`)
L.push(`| … of those, ruled Not sure yet by Kevin, by name | ${sum.ruledNotSure} |`)
L.push(`| **Total live** | **${sum.total}** |`)
L.push(`| In the recycle bin (mapped too, listed last) | ${binned.length} |`)
L.push('')
L.push(`Levels among the ${sum.referralPartner} Referral partners: ${live.filter(r => r.level === 'referral').length} Referral Partner, ${sum.powerPartner} Power Partner, ${live.filter(r => r.level === 'potential').length} Potential.`)
L.push('')
L.push(`Mapping fingerprint (TypeScript rules, all ${rows.length} rows): \`${fingerprint}\`. Line 10 of \`migrations/network_model_check.sql\` must print the same.`)
L.push('')
L.push('## Read these first')
L.push('')
L.push(`### ${ruled.length} contacts Kevin ruled are not Referral partners`)
L.push('')
L.push('Each would have counted as a Referral partner only because one client\'s "referred by" points at it. They are held by id in the rules, so they stay Not sure yet whatever tier, tag or lead they have.')
L.push('')
table(ruled, { head: 'What the rules alone would have read', cell: r => r.flags.join('; ') || '(nothing)' })
L.push(`### ${both.length} contacts that get two types: Referral partner and Vendor`)
L.push('')
table(both, { head: 'Why both', cell: r => r.why.join('; ') })
L.push(`### ${droppedStage.length} contacts that lose a stage somebody chose`)
L.push('')
L.push('They are not Referral partners under the rules, and only a Referral partner has a stage. The old `stage` column keeps the old word; the new `partner_stage` would be empty.')
L.push('')
table(droppedStage, { head: 'Stage that would not carry across', cell: r => r.nowStage })
L.push(`### ${networkingElsewhere.length} Networking Contacts that do NOT become "Not sure yet"`)
L.push('')
table(networkingElsewhere, { head: 'What sent them elsewhere', cell: r => r.why.join('; ') })
L.push(`### ${noStage.length} Referral partners with no usable live stage`)
L.push('')
L.push('They would start at New Contact.')
L.push('')
table(noStage, { head: 'Live stage', cell: r => r.nowStage || '(blank)' })

L.push('## Every live contact, by location')
L.push('')
const locs = [...new Set(live.map(r => r.location))]
  .map(name => ({ name, list: live.filter(r => r.location === name).sort(byName) }))
  .sort((a, b) => (a.name === 'Greensboro' ? -1 : b.name === 'Greensboro' ? 1 : b.list.length - a.list.length || a.name.localeCompare(b.name)))
for (const loc of locs) {
  const n = t => loc.list.filter(t).length
  L.push(`### ${loc.name} — ${loc.list.length} contact${loc.list.length === 1 ? '' : 's'}`)
  L.push('')
  L.push(`Referral partner ${n(r => r.types.includes('partner'))} · Vendor only ${n(r => r.types.includes('vendor') && !r.types.includes('partner'))} · Not sure yet ${n(r => r.types.includes('unsure'))} · came from a client record ${n(r => r.fromClient)}`)
  L.push('')
  L.push('| Contact | Holds now | Would hold | Note |')
  L.push('| --- | --- | --- | --- |')
  for (const r of loc.list) {
    const note = [r.fromClient ? (r.alsoClient ? 'from a client record, still a client' : 'moved from a client record') : '', ...r.flags].filter(Boolean).join('; ')
    L.push(`| ${cell(who(r))} | ${cell(nowWords(r))} | ${cell(`${typesWords(r)} · level ${levelWords(r)} · stage ${stageWords(r)}`)} | ${cell(note)} |`)
  }
  L.push('')
}
L.push(`## Recycle bin — ${binned.length} deleted contacts`)
L.push('')
L.push('Mapped too, so a contact restored later comes back as what it was. Not in any count above.')
L.push('')
table(binned.sort(byName))

const csvCell = v => { const s = String(v ?? ''); const g = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g }
const csv = [
  ['Location', 'Name', 'Company', 'Live', 'Type now', 'Tier now', 'Stage now', 'Tags', 'Leads sent', 'From a client record', 'Still a client',
    'Types after', 'Level after', 'Stage after', 'Why', 'Flags', 'Id'],
  ...rows.slice().sort((a, b) => a.location.localeCompare(b.location) || byName(a, b)).map(r => [
    r.location, r.name, r.company, r.live ? 'yes' : 'recycle bin', r.nowType, r.nowTier, r.nowStage, r.tags.join('; '), r.sent,
    r.fromClient ? 'yes' : '', r.alsoClient ? 'yes' : '', typesWords(r), r.level ? LEVEL_META[r.level].label : '', r.stage || '',
    r.why.join('; '), r.flags.join('; '), r.id,
  ]),
].map(line => line.map(csvCell).join(',')).join('\n')

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'network-model-dry-run.md'), L.join('\n') + '\n')
writeFileSync(join(outDir, 'network-model-dry-run.csv'), '﻿' + csv + '\n')
if (dumpPath) {
  mkdirSync(dirname(dumpPath), { recursive: true })
  writeFileSync(dumpPath, JSON.stringify({
    partners, partnerTags, lookups, sentLeads,
    mapped: rows.map(r => ({ id: r.id, live: r.live, facts: r.facts, types: r.types, level: r.level, stage: r.stage })),
  }))
}

const greensboro = live.filter(r => r.location === 'Greensboro')
console.log('═══ Network model — dry run (read-only) ═══')
console.log(`rows read: ${rows.length} (${live.length} live, ${binned.length} in the recycle bin)`)
console.log(`Referral partner ${sum.referralPartner} (also Vendor ${sum.referralAndVendor}) · Vendor only ${sum.vendorOnly} · Not sure yet ${sum.notSure} · total ${sum.total}`)
console.log(`Greensboro: ${greensboro.length} contacts, ${greensboro.filter(r => r.types.includes('unsure')).length} Not sure yet`)
console.log(`ruled Not sure yet by name ${ruled.length} (found ${ruled.length} of ${RULED_NOT_SURE_IDS.length} ids)`)
console.log(`two types ${both.length} · chosen stage dropped ${droppedStage.length} · Networking Contact decided elsewhere ${networkingElsewhere.length} · no usable stage ${noStage.length}`)
console.log(`MAPPING FINGERPRINT (TypeScript): ${fingerprint}`)
console.log(`report: ${join(outDir, 'network-model-dry-run.md')}`)
