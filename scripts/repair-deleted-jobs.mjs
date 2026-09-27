// ═══════════════════════════════════════════════════════════════════════════
// Repair: jobs deleted in Jobber are marked deleted in Bee Hub, and their
// deals do what the 2026-08-29 rule always meant them to
// (2026-09-27 — companion to handleJobDestroy + jobDeleted.js)
//
// Usage:  node scripts/repair-deleted-jobs.mjs                 (dry run)
//         node scripts/repair-deleted-jobs.mjs --execute       (writes)
//         node scripts/repair-deleted-jobs.mjs --undo <report.run.json>
//         [--refresh]           allow the app's normal token renewal
//         [--ids <uuid,uuid>]   also consider these job rows
//         [--env <path>]        default .env.local
//
// THE DEFECT. Jobber told us about every one of these deletions
// (JOB_DESTROY, in sync_log) and the handler compared Jobber's ENCODED id
// with our plain numeric one, so it never matched: 56 deletions, none
// applied, 55 jobs still reading as live work. The handler now decodes the
// id; this applies the deletions already missed.
//
// CANDIDATES: every job row not already deleted whose Jobber id appears in a
// JOB_DESTROY sync_log event (decoded), plus any --ids. EACH IS RE-CHECKED IN
// JOBBER AT RUN TIME: only a job Jobber answers "no such job" for, with no
// error, is marked. Anything Jobber still has, or can't be read, is left.
//
// WHAT IT DOES TO EACH DEAL — exactly what the webhook would have done
// (stageAdvanceFor in lib/engagements.ts, the same function the webhook
// uses): re-derive with the deleted jobs ignored and move the deal only
// FORWARD. In practice:
//   · every job deleted, nothing invoiced → Closed Lost 'job_deleted',
//     with a note and the Reopen button (Kevin's 2026-08-29 rule);
//   · the deleted job was the last unfinished one → Final Processing;
//   · a CLOSED deal (Won or Lost) never moves — Closed Won rows whose job
//     was deleted are left exactly as they are (Kevin, 2026-09-27: the money
//     is real and reopening a correct close makes things worse).
//
// THE REPLACEMENT CHECK (Kevin: "just close them if they are not in
// jobber"). Before ANY deal moves, Jobber is asked for every job that client
// has. If one could be the work remade under a new number
// (findReplacementJobs in jobDeleted.js), the deal is HELD: the job row is
// still marked deleted (it is), but the stage is not touched, and the
// report says whether Bee Hub even has that replacement job — if it does
// not, we are missing a job Jobber has (a separate bug, not fixed here).
// A client Jobber can't be read for is held too.
//
// MONEY: a job carries none of its own. Invoices on a deleted job are real
// invoices and are not touched; no money column is written.
//
// TOKENS: a stored token is used only while valid and never renewed; a
// location without one is skipped and listed. --refresh lets it use the
// app's normal renewal (lib/jobber.ts jobberGraphQL) — Kevin's call.
//
// REVERSIBLE: --undo puts every job row and every moved deal back from the
// run report, guarded on the values the run wrote.
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
const EXTRA_IDS = (val('--ids') || '').split(',').map(s => s.trim()).filter(Boolean)

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
const { deriveEngagementStage, stageAdvanceFor } = await import(pathToFileURL(ROOT + '/lib/engagements.ts').href)
const del = await import(pathToFileURL(ROOT + '/components/hive/shared/jobDeleted.js').href)

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
async function sbIn(table, select, col, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 150) out.push(...await sbAll(`${table}?select=${select}&${col}=in.(${ids.slice(i, i + 150).map(encodeURIComponent).join(',')})`))
  return out
}
const nowIso = () => new Date().toISOString()
const money = n => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const LIVE_STATUSES = new Set(['upcoming', 'today', 'late', 'in_progress', 'active', 'unscheduled', 'action_required', 'on_hold', 'requires_invoicing'])
const STAGE_COLS = ['stage', 'stage_entered_at', 'closed_reason', 'closed_at', 'closed_note']

async function sideEffectSnapshot(leadIds, engIds) {
  const count = async (table) => (await sbIn(table, 'id', 'lead_id', leadIds)).length
  const stages = Object.fromEntries((await sbIn('engagements', 'id,stage,closed_reason', 'id', engIds)).map(e => [e.id, `${e.stage}|${e.closed_reason ?? ''}`]))
  return {
    counters: {
      lead_drip_progress: await count('lead_drip_progress'),
      scheduled_stage_emails: await count('scheduled_stage_emails'),
      notification_log: await count('notification_log'),
      touchpoints: await count('touchpoints'),
    },
    stages,
  }
}
// Only the planned deals may move, and only to the planned stage.
function assertOnlyPlanned(before, after, planned) {
  const drifted = Object.keys(before.counters).filter(k => before.counters[k] !== after.counters[k])
  const wrong = Object.keys(before.stages).filter(id => {
    const want = planned[id] ?? before.stages[id]
    return after.stages[id] !== want
  })
  if (drifted.length || wrong.length) {
    if (drifted.length) console.error(`✗ SIDE-EFFECT COUNTER DRIFT: ${drifted.map(k => `${k} ${before.counters[k]}→${after.counters[k]}`).join(', ')}`)
    if (wrong.length) console.error(`✗ ${wrong.length} deal(s) not where the plan put them: ${wrong.map(id => `${id} ${before.stages[id]} → ${after.stages[id]}`).join('; ')}`)
    process.exitCode = 2
  } else {
    console.log(`side effects unchanged: ${JSON.stringify(after.counters)} · every deal is where the plan put it (${Object.keys(after.stages).length} checked)`)
  }
}

const JOB_COLS = 'id,jobber_job_id,location_id,lead_id,engagement_id,status,total,completed_at,created_at,scheduled_start'

// ── undo ────────────────────────────────────────────────────────────────────
if (UNDO) {
  const run = JSON.parse(readFileSync(UNDO, 'utf8'))
  if (run.mode !== 'execute') { console.error('--undo takes a report from an --execute run'); process.exit(1) }
  const leadIds = [...new Set(run.jobs.map(j => j.lead_id).filter(Boolean))]
  const engIds = run.deals.map(d => d.id)
  const before = await sideEffectSnapshot(leadIds, engIds)
  const n = { jobs: 0, deals: 0 }
  for (const c of run.jobs.filter(c => c.written)) {
    const r = await sb(`jobs?id=eq.${c.id}&status=eq.deleted`, { method: 'PATCH', body: JSON.stringify({ status: c.before.status }), headers: { Prefer: 'return=representation' } })
    if (r?.length) n.jobs++; else console.log(`  skipped job ${c.id}: no longer as the run left it`)
  }
  const moved = run.deals.filter(d => d.written)
  const planned = {}
  for (const d of moved) {
    const r = await sb(`engagements?id=eq.${d.id}&stage=eq.${encodeURIComponent(d.after.stage)}`, { method: 'PATCH', body: JSON.stringify(d.before), headers: { Prefer: 'return=representation' } })
    if (r?.length) { n.deals++; planned[d.id] = `${d.before.stage}|${d.before.closed_reason ?? ''}` } else console.log(`  skipped deal ${d.id}: changed since the run`)
  }
  console.log(`reverted jobs ${n.jobs}/${run.jobs.filter(c => c.written).length} · deals ${n.deals}/${moved.length}`)
  assertOnlyPlanned(before, await sideEffectSnapshot(leadIds, engIds), planned)
  process.exit()
}

console.log(`repair-deleted-jobs — ${EXECUTE ? '⚠ EXECUTE (writes to prod)' : 'DRY RUN (no writes)'} · tokens: ${REFRESH ? 'renew when needed (--refresh)' : 'valid-only, never renewed'}\n`)

// ── candidates: JOB_DESTROY events + --ids ──────────────────────────────────
const events = await sbAll(`sync_log?select=message,location_id,created_at&message=like.topic%3DJOB_DESTROY*`)
const destroyed = new Map() // `${slug}|${jobber id}` → first event
for (const e of events) {
  const item = (e.message.match(/item=([A-Za-z0-9+/=]+)/) || [])[1]
  const jid = item ? imp.extractJobberId(item) : null
  if (jid && !destroyed.has(`${e.location_id}|${jid}`)) destroyed.set(`${e.location_id}|${jid}`, e)
}
const destroyedIds = [...new Set([...destroyed.keys()].map(k => k.split('|')[1]))]
let candidates = destroyedIds.length ? await sbIn('jobs', JOB_COLS, 'jobber_job_id', destroyedIds) : []
candidates = candidates.filter(j => destroyed.has(`${j.location_id}|${j.jobber_job_id}`))
if (EXTRA_IDS.length) candidates.push(...await sbIn('jobs', JOB_COLS, 'id', EXTRA_IDS))
candidates = [...new Map(candidates.filter(j => !del.isDeletedJob(j)).map(j => [j.id, j])).values()]

// ── Jobber, now ─────────────────────────────────────────────────────────────
const slugs = [...new Set(candidates.map(j => j.location_id))]
const locs = await sbIn('locations', 'location_id,name,jobber_access_token,token_expiry', 'location_id', slugs)
const locBySlug = Object.fromEntries(locs.map(l => [l.location_id, l]))
const fresh = l => l && parseInt(l.token_expiry || '', 10) > Date.now() + 5 * 60 * 1000
const usable = slug => REFRESH || fresh(locBySlug[slug])
const jobber = REFRESH ? await import(pathToFileURL(ROOT + '/lib/jobber.ts').href) : null
async function ask(slug, query, variables) {
  if (REFRESH) return jobber.jobberGraphQL(slug, query, variables)
  const res = await fetch('https://api.getjobber.com/api/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${locBySlug[slug].jobber_access_token}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': '2025-04-16' },
    body: JSON.stringify({ query, variables }),
  })
  if (res.status === 401) return { errors: [{ message: '401 — token not accepted (not renewed)' }] }
  return res.json()
}
const safeAsk = async (slug, q, v) => { try { const r = await ask(slug, q, v); await sleep(300); return r } catch (e) { return { errors: [{ message: e.message }] } } }
const JOB_Q = `query($id:EncodedId!){job(id:$id){id jobStatus}}`
const CLIENT_JOBS_Q = `query($id:EncodedId!){client(id:$id){id jobs(first:100){nodes{id jobNumber title jobStatus createdAt}}}}`
const QUOTE_CLIENT_Q = `query($id:EncodedId!){quote(id:$id){client{id}}}`
const REQUEST_CLIENT_Q = `query($id:EncodedId!){request(id:$id){client{id}}}`
const CLIENT_SEARCH_Q = `query($s:String){clients(first:10, searchTerm:$s){nodes{id name}}}`
// The Jobber client for a deal: the person's stored id, else asked of Jobber
// through the deal's own quote or request (some people were never stamped).
async function jobberClientFor(slug, lead, quotes, srs) {
  if (lead.jobber_client_id) return { id: lead.jobber_client_id, via: 'person' }
  for (const q of quotes.filter(q => q.jobber_quote_id)) {
    const r = await safeAsk(slug, QUOTE_CLIENT_Q, { id: imp.encodeJobberId('Quote', q.jobber_quote_id) })
    const c = r?.data?.quote?.client?.id
    if (c) return { id: imp.extractJobberId(c), via: `quote ${q.jobber_quote_id}` }
  }
  for (const s of srs.filter(s => s.jobber_request_id)) {
    const r = await safeAsk(slug, REQUEST_CLIENT_Q, { id: imp.encodeJobberId('Request', s.jobber_request_id) })
    const c = r?.data?.request?.client?.id
    if (c) return { id: imp.extractJobberId(c), via: `request ${s.jobber_request_id}` }
  }
  // Nothing left to ask through. If every quote and request on the deal is
  // itself gone from Jobber (answered "no such record", no error), search
  // the location's clients by the person's surname: no client at all means
  // the work is not in Jobber; any hit is for a human to judge, so it holds.
  const asked = [...quotes.filter(q => q.jobber_quote_id).map(q => ['Quote', q.jobber_quote_id, QUOTE_CLIENT_Q, 'quote']),
    ...srs.filter(x => x.jobber_request_id).map(x => ['Request', x.jobber_request_id, REQUEST_CLIENT_Q, 'request'])]
  for (const [type, id, q, key] of asked) {
    const r = await safeAsk(slug, q, { id: imp.encodeJobberId(type, id) })
    if (r?.errors?.length || r?.data?.[key] !== null) return null
  }
  const surname = String(lead.name || '').trim().split(/\s+/).pop()
  if (!surname) return null
  const r = await safeAsk(slug, CLIENT_SEARCH_Q, { s: surname })
  if (r?.errors?.length || !r?.data?.clients) return null
  const hits = r.data.clients.nodes || []
  if (hits.length === 0) return { gone: true, via: `no client "${surname}" in Jobber; its quote and request are gone too` }
  return { ambiguous: hits.map(h => h.name) }
}

const confirmed = [], stillInJobber = [], unreadable = [], skipped = {}
for (const job of candidates) {
  if (!usable(job.location_id)) { skipped[job.location_id] = (skipped[job.location_id] || 0) + 1; continue }
  const r = await safeAsk(job.location_id, JOB_Q, { id: imp.encodeJobberId('Job', job.jobber_job_id) })
  if (r?.errors?.length) unreadable.push({ id: job.id, slug: job.location_id, error: r.errors[0].message })
  else if (r?.data?.job) stillInJobber.push({ id: job.id, slug: job.location_id, jobberStatus: r.data.job.jobStatus })
  else confirmed.push(job)   // "OK, no such job" — deleted in Jobber
}
const confirmedIds = new Set(confirmed.map(j => j.id))

// ── each affected deal: re-derive exactly as the webhook would ──────────────
const engIds = [...new Set(confirmed.map(j => j.engagement_id).filter(Boolean))]
const engRows = await sbIn('engagements', `id,client_id,location_uuid,${STAGE_COLS.join(',')}`, 'id', engIds)
const byKey = (rows, k) => { const m = {}; for (const r of rows) (m[r[k]] ||= []).push(r); return m }
const srBy = byKey(await sbIn('service_requests', 'engagement_id,jobber_request_id,requested_at,created_at', 'engagement_id', engIds), 'engagement_id')
const qBy = byKey(await sbIn('quotes', 'engagement_id,jobber_quote_id,status,sent_at,approved_at,created_at', 'engagement_id', engIds), 'engagement_id')
const jBy = byKey(await sbIn('jobs', JOB_COLS, 'engagement_id', engIds), 'engagement_id')
const iBy = byKey(await sbIn('invoices', 'engagement_id,status,total,paid_amount,balance_owing,paid_at,issued_at,created_at', 'engagement_id', engIds), 'engagement_id')
const leadRows = await sbIn('leads', 'id,name,jobber_client_id', 'id', [...new Set(engRows.map(e => e.client_id))])
const leadById = Object.fromEntries(leadRows.map(l => [l.id, l]))
const locName = Object.fromEntries(locs.map(l => [l.location_id, l.name || l.location_id]))
const TEST_NAMES = /^(test\b|test test$)/i

const deals = []
const at = nowIso()
for (const e of engRows) {
  const jobsNow = jBy[e.id] || []
  const jobsAfter = jobsNow.map(j => (confirmedIds.has(j.id) ? { ...j, status: del.JOB_DELETED } : j))
  const staleLostRecoverable = e.stage === 'Closed Lost' && e.closed_reason === 'stale_on_import'
  const derived = deriveEngagementStage({ sr: (srBy[e.id] || [])[0] ?? null, quotes: qBy[e.id] || [], jobs: jobsAfter, invoices: iBy[e.id] || [] },
    { mode: 'live', closeWonOnDone: staleLostRecoverable, closeOnArchivedQuote: true, closeOnDeletedJobs: true })
  const { advance, patch } = stageAdvanceFor(e, derived, at)
  const deletedHere = jobsNow.filter(j => confirmedIds.has(j.id))
  const lead = leadById[e.client_id] || {}
  const slug = deletedHere[0]?.location_id
  const deal = {
    id: e.id, who: lead.name || e.client_id, slug, location: locName[slug] || slug,
    test: TEST_NAMES.test((lead.name || '').trim()),
    stored: e.stage + (e.closed_reason ? ` / ${e.closed_reason}` : ''),
    deletedJobs: deletedHere.map(j => ({ jobber_job_id: j.jobber_job_id, status: j.status, total: j.total == null ? null : Number(j.total) })),
    liveJobsLeft: jobsAfter.filter(j => !del.isDeletedJob(j)).length,
    invoices: (iBy[e.id] || []).length,
    derived: derived.stage + (derived.closed_reason ? ` / ${derived.closed_reason}` : ''),
    advance, decision: advance ? null : 'no_move',
    replacements: [], before: Object.fromEntries(STAGE_COLS.map(k => [k, e[k] ?? null])), after: advance ? patch : null, written: false,
  }
  // The replacement check — only a deal that would MOVE is asked about.
  if (advance) {
    const client = usable(slug) ? await jobberClientFor(slug, lead, qBy[e.id] || [], srBy[e.id] || []) : null
    if (!client || client.ambiguous) {
      deal.decision = 'hold_unreadable'
      deal.why = !usable(slug) ? 'no valid token' : client?.ambiguous ? `no stored Jobber client; Jobber has similar names (${client.ambiguous.join(', ')}) — a person should look` : 'no Jobber client found for this person'
    } else if (client.gone) {
      // The client itself is gone from Jobber: nothing can have replaced the work.
      deal.jobberClientVia = client.via; deal.clientJobsInJobber = 0; deal.clientJobs = []
      deal.decision = del.deletedJobMoveDecision({ readable: true, replacements: [] })
    } else {
      deal.jobberClientVia = client.via
      const r = await safeAsk(slug, CLIENT_JOBS_Q, { id: imp.encodeJobberId('Client', client.id) })
      const readable = !r?.errors?.length && !!r?.data?.client
      const clientJobs = readable ? (r.data.client.jobs?.nodes || []).map(n => ({ ...n, id: imp.extractJobberId(n.id) })) : []
      const since = deletedHere.map(j => j.created_at).filter(Boolean).sort()[0] ?? null
      const onThisDeal = jobsNow.filter(j => !confirmedIds.has(j.id)).map(j => j.jobber_job_id)
      const reps = del.findReplacementJobs({ clientJobs, deletedJobberIds: [...destroyedIds], deletedCreatedAt: since, onThisDeal })
      deal.clientJobs = clientJobs.map(x => ({ jobNumber: x.jobNumber, jobber_job_id: x.id, jobStatus: x.jobStatus, createdAt: x.createdAt, onThisDeal: onThisDeal.includes(x.id) }))
      if (reps.length) {
        const known = await sbIn('jobs', 'jobber_job_id,engagement_id,status', 'jobber_job_id', reps.map(x => x.id))
        const knownBy = Object.fromEntries(known.filter(k => k).map(k => [k.jobber_job_id, k]))
        deal.replacements = reps.map(x => ({ jobber_job_id: x.id, jobNumber: x.jobNumber, title: x.title, jobStatus: x.jobStatus, createdAt: x.createdAt,
          inBeeHub: !!knownBy[x.id], onThisDeal: knownBy[x.id]?.engagement_id === e.id, beeHubEngagement: knownBy[x.id]?.engagement_id ?? null }))
      }
      deal.clientJobsInJobber = clientJobs.length
      deal.decision = del.deletedJobMoveDecision({ readable, replacements: reps })
      if (!readable) deal.why = r?.errors?.[0]?.message || 'client not returned'
    }
  }
  deals.push(deal)
}

// ── report ──────────────────────────────────────────────────────────────────
const live = confirmed.filter(j => LIVE_STATUSES.has(String(j.status).toLowerCase()))
const liveValue = live.reduce((s, j) => s + (Number(j.total) || 0), 0)
const tag = d => `${d.location} · ${d.who}${d.test ? '  [KEVIN’S TEST DATA]' : ''}`
console.log(`JOB_DESTROY events: ${destroyed.size} · candidate rows still live in Bee Hub: ${candidates.length}`)
console.log(`   confirmed deleted in Jobber just now: ${confirmed.length} · still in Jobber (left alone): ${stillInJobber.length} · unreadable: ${unreadable.length} · skipped (no valid token): ${Object.values(skipped).reduce((a, b) => a + b, 0)}`)
if (Object.keys(skipped).length) console.log(`   skipped: ${Object.entries(skipped).map(([k, v]) => `${k} (${v})`).join(', ')}`)
for (const s of stillInJobber) console.log(`   STILL IN JOBBER: ${s.slug} ${s.id} (${s.jobberStatus}) — not marked`)
for (const u of unreadable) console.log(`   unreadable: ${u.slug} ${u.id} — ${u.error}`)
console.log(`\n→ job rows to mark deleted: ${confirmed.length} · of them still reading as live work: ${live.length}, ${money(liveValue)}`)

const closes = deals.filter(d => d.advance && d.after?.stage === 'Closed Lost')
const toFP = deals.filter(d => d.advance && d.after?.stage === 'Final Processing')
const otherMoves = deals.filter(d => d.advance && !closes.includes(d) && !toFP.includes(d))
const line = d => {
  const reps = d.replacements.map(r => `#${r.jobNumber ?? r.jobber_job_id} ${r.jobStatus} created ${String(r.createdAt).slice(0, 10)} — ${r.inBeeHub ? (r.onThisDeal ? 'in Bee Hub on this deal' : 'in Bee Hub on ANOTHER deal') : 'NOT IN BEE HUB (missing job)'}`)
  const verdict = d.decision === 'move' ? 'MOVES' : d.decision === 'hold_replacement' ? 'HELD — replacement in Jobber' : `HELD — ${d.why}`
  return `   ${tag(d)}: ${d.stored} → ${d.after.stage}${d.after.closed_reason ? ` / ${d.after.closed_reason}` : ''} · ${verdict}` +
    (d.clientJobsInJobber != null ? ` · client has ${d.clientJobsInJobber} job(s) in Jobber${d.jobberClientVia && d.jobberClientVia !== 'person' ? ` (${d.jobberClientVia})` : ''}` : '') +
    (d.after.stage === 'Closed Lost' && d.clientJobs?.length ? `\n      their jobs in Jobber: ${d.clientJobs.map(x => `#${x.jobNumber} ${x.jobStatus} ${String(x.createdAt).slice(0, 10)}`).join(', ')}` : '') +
    (reps.length ? `\n      ${reps.join('\n      ')}` : '')
}
console.log(`\n→ deals that CLOSE as Lost ('job deleted', Reopen-able): ${closes.filter(d => d.decision === 'move').length} of ${closes.length} would-close`)
for (const d of closes) console.log(line(d))
console.log(`→ deals that move to FINAL PROCESSING: ${toFP.filter(d => d.decision === 'move').length} of ${toFP.length}`)
for (const d of toFP) console.log(line(d))
if (otherMoves.length) { console.log(`→ other moves: ${otherMoves.length}`); for (const d of otherMoves) console.log(line(d)) }
const missing = deals.flatMap(d => d.replacements.filter(r => !r.inBeeHub).map(r => ({ d, r })))
if (missing.length) {
  console.log(`\n⚠ JOBS JOBBER HAS THAT BEE HUB DOES NOT: ${missing.length} — a separate bug, not fixed here`)
  for (const { d, r } of missing) console.log(`   ${tag(d)}: Jobber job #${r.jobNumber ?? r.jobber_job_id} (${r.jobStatus}, created ${String(r.createdAt).slice(0, 10)})`)
}
const closedLeft = deals.filter(d => !d.advance && /^Closed/.test(d.stored))
console.log(`\n→ CLOSED deals left exactly as they are: ${closedLeft.length} (Won ${closedLeft.filter(d => d.stored.startsWith('Closed Won')).length}, Lost ${closedLeft.filter(d => d.stored.startsWith('Closed Lost')).length})`)
for (const d of closedLeft.filter(d => d.stored.startsWith('Closed Won') && d.liveJobsLeft === 0)) console.log(`   Closed Won, no job left: ${tag(d)}`)
const openStay = deals.filter(d => !d.advance && !/^Closed/.test(d.stored))
console.log(`→ open deals whose stage does not change: ${openStay.length}`)
for (const d of openStay) console.log(`   ${tag(d)}: stays ${d.stored} (works out to ${d.derived}; ${d.liveJobsLeft} live job(s) left, ${d.invoices} invoice(s))`)
const tests = deals.filter(d => d.test)
if (tests.length) console.log(`\nKevin’s own test data among these: ${tests.map(d => `${tag(d)} (${d.stored})`).join('; ')}`)
console.log('\nmoney: nothing written — a job carries none; invoices on deleted jobs are untouched')

const report = {
  mode: EXECUTE ? 'execute' : 'dry-run', at, refresh: REFRESH,
  destroyEvents: destroyed.size, candidates: candidates.length, skipped, stillInJobber, unreadable,
  liveWork: { jobs: live.length, value: Math.round(liveValue * 100) / 100 },
  jobs: confirmed.map(j => ({ id: j.id, slug: j.location_id, lead_id: j.lead_id, engagement_id: j.engagement_id, jobber_job_id: j.jobber_job_id, before: { status: j.status }, after: { status: del.JOB_DELETED }, written: false })),
  deals,
  errors: [],
}

// ── execute ─────────────────────────────────────────────────────────────────
if (EXECUTE) {
  console.log('\nexecuting…')
  const snapLeads = [...new Set(confirmed.map(j => j.lead_id).filter(Boolean))]
  const snapEngs = engRows.map(e => e.id)
  const before = await sideEffectSnapshot(snapLeads, snapEngs)
  const planned = {}
  const written = { jobs: 0, deals: 0 }
  for (const c of report.jobs) {
    try {
      const r = await sb(`jobs?id=eq.${c.id}&status=eq.${encodeURIComponent(c.before.status)}`,
        { method: 'PATCH', body: JSON.stringify({ status: del.JOB_DELETED }), headers: { Prefer: 'return=representation' } })
      if (r?.length) { written.jobs++; c.written = true } else report.errors.push(`job ${c.id}: changed since the plan was read — skipped`)
    } catch (e) { report.errors.push(`job ${c.id}: ${e.message}`) }
  }
  const writtenJobIds = new Set(report.jobs.filter(c => c.written).map(c => c.id))
  for (const d of report.deals.filter(d => d.decision === 'move')) {
    // Only when every job this deal's move depends on was actually marked.
    const need = (jBy[d.id] || []).filter(j => confirmedIds.has(j.id))
    if (!need.every(j => writtenJobIds.has(j.id))) { report.errors.push(`deal ${d.id}: a job was skipped — deal left alone`); continue }
    try {
      const r = await sb(`engagements?id=eq.${d.id}&stage=eq.${encodeURIComponent(d.before.stage)}`,
        { method: 'PATCH', body: JSON.stringify({ ...d.after, updated_at: nowIso() }), headers: { Prefer: 'return=representation' } })
      if (r?.length) { written.deals++; d.written = true; planned[d.id] = `${d.after.stage}|${d.after.closed_reason ?? d.before.closed_reason ?? ''}` }
      else report.errors.push(`deal ${d.id}: changed since the plan was read — skipped`)
    } catch (e) { report.errors.push(`deal ${d.id}: ${e.message}`) }
  }
  const perSlug = {}
  for (const c of report.jobs.filter(c => c.written)) perSlug[c.slug] = (perSlug[c.slug] || 0) + 1
  for (const [slug, n] of Object.entries(perSlug)) {
    await sb('sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ location_id: slug, direction: 'inbound', entity_type: 'job', status: 'success', message: `[job:repair] ${n} job(s) deleted in Jobber marked deleted (repair-deleted-jobs)` }) })
  }
  console.log(`written: jobs ${written.jobs}/${report.jobs.length} · deals moved ${written.deals}/${report.deals.filter(d => d.decision === 'move').length}${report.errors.length ? ` · ${report.errors.length} skipped/errors` : ''}`)
  for (const e of report.errors) console.log(`   ${e}`)
  assertOnlyPlanned(before, await sideEffectSnapshot(snapLeads, snapEngs), planned)
}

const outPath = `repair-deleted-jobs.report.${EXECUTE ? 'run' : 'dryrun'}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nreport written: ${outPath}${EXECUTE ? `  (undo: node scripts/repair-deleted-jobs.mjs --undo ${outPath})` : ''}`)
