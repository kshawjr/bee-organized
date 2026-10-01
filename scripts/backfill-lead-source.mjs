// ═══════════════════════════════════════════════════════════════════════════
// Backfill: the lead source on leads that arrived through the Jobber webhook
// (2026-09-30 — companion to 3b3c2fe, which started reading it for new ones)
//
// Usage:  node scripts/backfill-lead-source.mjs                 (dry run)
//         node scripts/backfill-lead-source.mjs --execute       (writes)
//         node scripts/backfill-lead-source.mjs --undo <report.run.json>
//         [--refresh]           allow the app's normal token renewal
//         [--only <slug,slug>]  limit to these locations
//         [--env <path>]        default .env.local
//
// THE GAP. Until 3b3c2fe Bee Hub never asked Jobber for a client's lead
// source, so every lead that came in through the webhook since it went live
// (6 July 2026) landed with a blank source — about 380 of them. Jobber still
// holds the answer for many. This fills those, once.
//
// IN SCOPE: leads with import_source 'jobber_webhook', a Jobber client link,
// and a source that is blank RIGHT NOW.
// NOT IN SCOPE (Kevin, 2026-09-30): the initial import back to 2022, leads
// Bee Hub sent to Jobber, and Bee Hub leads nobody set a source on.
//
// EACH CLIENT IS RE-READ FROM JOBBER AT RUN TIME. Nothing is taken from an
// earlier report. A client Jobber can't return, or that can't be read, is
// listed and left alone — never treated as "no source".
//
// THE VALUE goes through leadSourceFromJobber (lib/lead-source.ts) — the same
// function the live webhook path uses: "google" and "Google" land as one
// thing, an owner's own label comes through as typed, and Jobber's stamp of
// our app name ("Bee Organized Interface") is NOT a source and stays blank.
//
// TOKENS: a stored token is used only while valid and never renewed; a
// location without one is skipped and listed with how many leads that
// leaves. --refresh lets it use the app's normal renewal (lib/jobber.ts
// refreshJobberToken) — Kevin's call.
//
// PACE: ten clients per call, one location at a time, a pause between calls,
// and it never takes a Jobber account's query budget below half (it reads
// what is left after every call and waits for the refill) — production
// webhooks and sends draw on the same budget.
//
// WHAT IT WRITES: leads.source, and nothing else on the lead — guarded so a
// source set since the read is never overwritten. One sync_log line per
// location. No stage, no drip, no notification, no updated_at.
//
// REVERSIBLE: --undo puts each source back to what it was (blank) from the
// run report, guarded on the value the run wrote — a source an owner has
// changed since is theirs and stays.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installTsResolver } from './ts-alias-hook.mjs'

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const val = (k, d = null) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d }
const EXECUTE = argv.includes('--execute')
const REFRESH = argv.includes('--refresh')
const UNDO = val('--undo')
const ONLY = (val('--only') || '').split(',').map(s => s.trim()).filter(Boolean)

const envPath = resolvePath(process.cwd(), val('--env', '.env.local'))
if (!existsSync(envPath)) { console.error(`missing env file at ${envPath}`); process.exit(1) }
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SB_URL || !SB_KEY) { console.error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

installTsResolver(ROOT)
const imp = await import(pathToFileURL(ROOT + '/lib/jobber-import.ts').href)
const bf = await import(pathToFileURL(ROOT + '/lib/lead-source-backfill.ts').href)

async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error(`PostgREST ${res.status} ${path.slice(0, 120)}: ${(await res.text()).slice(0, 300)}`)
  const text = await res.text(); return text ? JSON.parse(text) : null
}
async function sbAll(base) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const page = await sb(`${base}${base.includes('?') ? '&' : '?'}order=id&offset=${from}&limit=1000`)
    out.push(...page); if (page.length < 1000) break
  }
  return out
}
const nowIso = () => new Date().toISOString()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const eqGuard = (col, v) => (v == null ? `${col}=is.null` : `${col}=eq.${encodeURIComponent(v)}`)

// The ONE write: leads.source on one lead, only if it is currently `expected`.
const writeSource = async (leadId, expected, next) => {
  const r = await sb(`leads?id=eq.${leadId}&${eqGuard('source', expected)}`, {
    method: 'PATCH', body: JSON.stringify({ source: next }), headers: { Prefer: 'return=representation' },
  })
  return !!r?.length
}

// What must not move: this repair writes a source and nothing else.
async function sideEffectSnapshot(leadIds) {
  const count = async (table) => {
    let n = 0
    for (let i = 0; i < leadIds.length; i += 150) n += (await sbAll(`${table}?select=id&lead_id=in.(${leadIds.slice(i, i + 150).join(',')})`)).length
    return n
  }
  return {
    lead_drip_progress: await count('lead_drip_progress'),
    scheduled_stage_emails: await count('scheduled_stage_emails'),
    notification_log: await count('notification_log'),
  }
}
function assertNoDrift(before, after) {
  const drifted = Object.keys(before).filter(k => before[k] !== after[k])
  if (drifted.length) {
    console.error(`✗ SIDE-EFFECT COUNTER DRIFT: ${drifted.map(k => `${k} ${before[k]}→${after[k]}`).join(', ')}`)
    process.exitCode = 2
  } else console.log(`side effects unchanged: ${JSON.stringify(after)}`)
}

// ── undo ────────────────────────────────────────────────────────────────────
if (UNDO) {
  const run = JSON.parse(readFileSync(UNDO, 'utf8'))
  if (run.mode !== 'execute') { console.error('--undo takes a report from an --execute run'); process.exit(1) }
  const fills = run.fills.filter(f => run.written.includes(f.id))
  const ids = fills.map(f => f.id)
  const before = await sideEffectSnapshot(ids)
  const { reverted, skipped } = await bf.undoSourceBackfill(writeSource, fills)
  for (const s of skipped) console.log(`  skipped lead ${s.id}: ${s.why}`)
  console.log(`reverted ${reverted.length}/${fills.length} lead source(s) to blank`)
  assertNoDrift(before, await sideEffectSnapshot(ids))
  process.exit()
}

console.log(`backfill-lead-source — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'} · tokens: ${REFRESH ? 'renew when needed (--refresh)' : 'valid-only, never renewed'}${ONLY.length ? ` · only: ${ONLY.join(', ')}` : ''}\n`)

// ── candidates: webhook-arrived, still blank ────────────────────────────────
const webhookLeads = await sbAll(`leads?select=id,location_id,jobber_client_id,source&import_source=eq.jobber_webhook`)
const blank = webhookLeads.filter(l => bf.isBlankSource(l.source) && (!ONLY.length || ONLY.includes(l.location_id)))
const unlinked = blank.filter(l => !l.jobber_client_id)
const candidates = blank.filter(l => l.jobber_client_id)
const bySlug = {}
for (const l of candidates) (bySlug[l.location_id] ||= []).push(l)
const slugs = Object.keys(bySlug).sort()

// ── re-read each client from Jobber, now ────────────────────────────────────
const locs = slugs.length ? await sbAll(`locations?select=location_id,name,jobber_access_token,token_expiry&location_id=in.(${slugs.map(encodeURIComponent).join(',')})`) : []
const locBySlug = Object.fromEntries(locs.map(l => [l.location_id, l]))
const fresh = l => l && l.jobber_access_token && parseInt(l.token_expiry || '', 10) > Date.now() + 5 * 60 * 1000
const jobber = REFRESH ? await import(pathToFileURL(ROOT + '/lib/jobber.ts').href) : null

const BATCH = 10            // clients per call
const BETWEEN_CALLS_MS = 600
async function tokenFor(slug) {
  // --refresh: the app's own renewal, exactly as production does it. Without
  // it: the stored token, and only while it is still valid.
  if (REFRESH) return jobber.refreshJobberToken(slug)
  return fresh(locBySlug[slug]) ? locBySlug[slug].jobber_access_token : null
}
async function askBatch(token, leads) {
  const query = `{ ${leads.map((l, j) => `c${j}: client(id: "${imp.encodeJobberId('Client', l.jobber_client_id)}") { leadSource }`).join(' ')} }`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.getjobber.com/api/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': '2025-04-16' },
      body: JSON.stringify({ query }),
    })
    if (res.status === 401) return { fatal: '401 — token not accepted' }
    if (!res.ok) return { fatal: `HTTP ${res.status}` }
    const json = await res.json()
    const throttle = json?.extensions?.cost?.throttleStatus
    const throttled = (json?.errors || []).some(e => e?.extensions?.code === 'THROTTLED')
    if (throttled && attempt < 2) {
      // Out of budget: wait for it to refill to the floor, then ask again.
      await sleep(Math.max(bf.paceWaitMs(throttle), 5000)); continue
    }
    return { json, throttle }
  }
}

const answers = new Map()
const skippedNoToken = {}
let calls = 0, waitedMs = 0
for (const slug of slugs) {
  const leads = bySlug[slug]
  let token = null
  try { token = await tokenFor(slug) } catch { token = null }
  if (!token) { skippedNoToken[slug] = leads.length; continue }
  for (let i = 0; i < leads.length; i += BATCH) {
    const chunk = leads.slice(i, i + BATCH)
    let r
    try { r = await askBatch(token, chunk) } catch (e) { r = { fatal: e.message } }
    calls++
    chunk.forEach((l, j) => {
      const alias = `c${j}`
      if (r.fatal) return answers.set(l.id, { kind: 'unreadable', error: r.fatal })
      const err = (r.json?.errors || []).find(e => !e?.path || e.path[0] === alias)
      const node = r.json?.data?.[alias]
      if (node) answers.set(l.id, { kind: 'client', leadSource: node.leadSource ?? null })
      else if (err) answers.set(l.id, { kind: 'unreadable', error: err.message || 'error' })
      else if (r.json?.data && alias in r.json.data) answers.set(l.id, { kind: 'gone' })
      else answers.set(l.id, { kind: 'unreadable', error: 'no answer' })
    })
    const wait = BETWEEN_CALLS_MS + bf.paceWaitMs(r.throttle)
    waitedMs += wait
    await sleep(wait)
  }
}

// ── plan ────────────────────────────────────────────────────────────────────
const asked = candidates.filter(l => answers.has(l.id))
const plan = bf.planSourceBackfill(asked, answers)

// ── report ──────────────────────────────────────────────────────────────────
const nameOf = slug => locBySlug[slug]?.name || slug
const slugOf = Object.fromEntries(candidates.map(l => [l.id, l.location_id]))
const tally = (ids) => { const t = {}; for (const id of ids) t[slugOf[id]] = (t[slugOf[id]] || 0) + 1; return t }
const fillBy = tally(plan.fills.map(f => f.id)), noneBy = tally(plan.noSourceInJobber), stampBy = tally(plan.appStampOnly)
const goneBy = tally(plan.goneFromJobber), unreadBy = tally(plan.unreadable.map(u => u.id))
const skippedTotal = Object.values(skippedNoToken).reduce((a, b) => a + b, 0)

console.log(`webhook leads with a blank source: ${blank.length} · with a Jobber link: ${candidates.length} across ${slugs.length} location(s) · no Jobber link (cannot be looked up): ${unlinked.length}`)
console.log(`Jobber calls: ${calls} · read: ${asked.length} · not read (no valid token): ${skippedTotal}`)
console.log(`\n→ HAVE A USABLE SOURCE IN JOBBER: ${plan.fills.length}`)
console.log(`   Jobber has none either: ${plan.noSourceInJobber.length} · only our app stamp (stays blank): ${plan.appStampOnly.length} · gone from Jobber: ${plan.goneFromJobber.length} · unreadable: ${plan.unreadable.length} · set by an owner since (left alone): ${plan.alreadySet.length}`)

console.log(`\nBY LOCATION  (blank / would fill / none in Jobber / app stamp / gone / unreadable / not read)`)
for (const slug of slugs) {
  const n = bySlug[slug].length
  console.log(`   ${nameOf(slug).padEnd(24)} ${String(n).padStart(4)} / ${String(fillBy[slug] || 0).padStart(4)} / ${String(noneBy[slug] || 0).padStart(4)} / ${String(stampBy[slug] || 0).padStart(4)} / ${String(goneBy[slug] || 0).padStart(4)} / ${String(unreadBy[slug] || 0).padStart(4)} / ${String(skippedNoToken[slug] || 0).padStart(4)}`)
}
if (skippedTotal) {
  console.log(`\nNOT READ — no valid Jobber token${REFRESH ? ' even with --refresh (needs reconnecting)' : ' (run with --refresh to renew)'}: ${Object.keys(skippedNoToken).length} location(s), ${skippedTotal} lead(s)`)
  for (const [slug, n] of Object.entries(skippedNoToken).sort((a, b) => b[1] - a[1])) console.log(`   ${nameOf(slug)} (${slug}): ${n}`)
}
const values = {}
for (const f of plan.fills) {
  const v = (values[f.after.source] ||= { n: 0, typed: new Set() })
  v.n++; if (f.jobberValue !== f.after.source) v.typed.add(f.jobberValue)
}
console.log(`\nTHE VALUES (as they would be stored):`)
for (const [v, { n, typed }] of Object.entries(values).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`   ${String(n).padStart(4)} × ${v}${typed.size ? `   (Jobber has it as: ${[...typed].map(t => JSON.stringify(t)).join(', ')})` : ''}`)
}
for (const u of plan.unreadable.slice(0, 20)) console.log(`   unreadable: ${slugOf[u.id]} ${u.id} — ${u.error}`)

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run', at: nowIso(), refresh: REFRESH, only: ONLY,
  blank: blank.length, linked: candidates.length, unlinked: unlinked.map(l => l.id),
  read: asked.length, skippedNoToken, jobberCalls: calls, pacedWaitMs: waitedMs,
  byLocation: Object.fromEntries(slugs.map(s => [s, { name: nameOf(s), blank: bySlug[s].length, fill: fillBy[s] || 0, noneInJobber: noneBy[s] || 0, appStamp: stampBy[s] || 0, gone: goneBy[s] || 0, unreadable: unreadBy[s] || 0, notRead: skippedNoToken[s] || 0 }])),
  values: Object.fromEntries(Object.entries(values).map(([v, { n }]) => [v, n])),
  fills: plan.fills,
  noSourceInJobber: plan.noSourceInJobber, appStampOnly: plan.appStampOnly,
  goneFromJobber: plan.goneFromJobber, unreadable: plan.unreadable, alreadySet: plan.alreadySet,
  written: [], errors: [],
}

// ── execute ─────────────────────────────────────────────────────────────────
if (EXECUTE) {
  console.log('\nexecuting…')
  const ids = plan.fills.map(f => f.id)
  const before = await sideEffectSnapshot(ids)
  const { written, skipped } = await bf.executeSourceBackfill(writeSource, plan.fills)
  report.written = written
  report.errors = skipped.map(s => `lead ${s.id}: ${s.why}`)
  const perSlug = tally(written)
  for (const [slug, n] of Object.entries(perSlug)) {
    await sb('sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ location_id: slug, direction: 'inbound', entity_type: 'client', status: 'success', message: `[source:backfill] ${n} lead source(s) filled from Jobber (backfill-lead-source)` }) })
  }
  console.log(`written: ${written.length}/${plan.fills.length}${skipped.length ? ` · ${skipped.length} skipped/errors` : ''}`)
  for (const s of skipped) console.log(`   skipped lead ${s.id}: ${s.why}`)
  assertNoDrift(before, await sideEffectSnapshot(ids))
}

const outPath = `backfill-lead-source.report.${EXECUTE ? 'run' : 'dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}${EXECUTE ? `  (undo: node scripts/backfill-lead-source.mjs --undo ${outPath})` : ''}`)
