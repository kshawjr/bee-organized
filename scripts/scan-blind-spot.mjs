// ═══════════════════════════════════════════════════════════════════════════
// Blind-spot scan — requestless children of NON-zero-history clients.
//
// The 7/9 scan-requestless-gap.mjs only examined ZERO-history leads (no SR,
// no quotes, no jobs, no invoices). A lead with ANY local child — e.g. a
// service request that landed while the requestless quote/job dropped —
// was invisible to it (Richard Baker case), as was a returning client with
// old healthy history whose NEW requestless work dropped (Tara Gillan case).
//
// This scan joins Jobber's full requestless quote/job graph against ALL
// jobber-linked leads and diffs per-record local presence:
//   - requestless quote in Jobber, no local row with that jobber_quote_id
//   - requestless job   in Jobber, no local row with that jobber_job_id
//   - invoice nested under a requestless job, no local jobber_invoice_id
//     (counted whether or not the parent job itself landed)
//
// READ-ONLY: zero writes to Supabase data / Jobber. ONE authorized side
// effect: getValidToken may refresh an expired access token (rotates the
// locations-row token columns — same as scan-requestless-gap.mjs).
//
// Output: blind-spot-scan.report.json — same locations[slug].clients shape
// as the 2a report (only MISSING nodes included) so backfill-requestless.mjs
// can consume it directly if the wider backfill is approved.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'

const envPath = process.argv[2] || '.env.local'
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SB_URL || !SB_KEY) { console.error('missing supabase env'); process.exit(1) }

async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`PostgREST ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
async function sbAll(pathBase) {
  const out = []
  let from = 0
  const PAGE = 1000
  for (;;) {
    const page = await sb(pathBase, { headers: { Range: `${from}-${from + PAGE - 1}` } })
    out.push(...page)
    if (page.length < PAGE) break
    from += PAGE
  }
  return out
}

// ── Jobber helpers (verbatim ports from scan-requestless-gap.mjs) ──────────

const JOBBER_URL = 'https://api.getjobber.com/api/graphql'
const JOBBER_VERSION = '2025-04-16'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function jobberQuery(token, query, variables) {
  const res = await fetch(JOBBER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

let lastThrottle = { maximumAvailable: 2500, currentlyAvailable: 2500, restoreRate: 50 }
async function jobberQueryThrottled(token, query, variables, retries = 3) {
  const estimatedCost = 50
  if (lastThrottle.currentlyAvailable < estimatedCost) {
    const waitMs = Math.ceil(((estimatedCost - lastThrottle.currentlyAvailable) / lastThrottle.restoreRate + 0.5) * 1000)
    await sleep(waitMs)
  }
  const result = await jobberQuery(token, query, variables)
  const ts = result?.extensions?.cost?.throttleStatus
  if (ts) lastThrottle = ts
  if (result?.errors?.some(e => e.extensions?.code === 'THROTTLED')) {
    if (retries > 0) {
      const cooldownMs = Math.ceil((lastThrottle.maximumAvailable / lastThrottle.restoreRate) * 1000)
      process.stdout.write(`  [throttle] THROTTLED — pausing ${cooldownMs}ms\n`)
      await sleep(cooldownMs)
      return jobberQueryThrottled(token, query, variables, retries - 1)
    }
    throw new Error('Jobber rate limit exhausted: ' + JSON.stringify(result.errors))
  }
  return result
}

async function getValidToken(location) {
  const expiry = location.token_expiry ? parseInt(location.token_expiry) : 0
  if (expiry && Date.now() < expiry - 5 * 60 * 1000) return location.jobber_access_token
  const test = await jobberQuery(location.jobber_access_token, '{ account { id } }')
  if (test?.data?.account?.id) return location.jobber_access_token
  const res = await fetch('https://api.getjobber.com/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.JOBBER_CLIENT_ID,
      client_secret: env.JOBBER_CLIENT_SECRET,
      refresh_token: location.jobber_refresh_token,
    }),
  })
  const raw = await res.text()
  let tokens = null
  try { tokens = JSON.parse(raw) } catch {}
  if (!res.ok || !tokens?.access_token) {
    throw new Error(`token refresh failed (${res.status}) for ${location.location_id}: ${raw.slice(0, 200)}`)
  }
  const expiryMs = Date.now() + 55 * 60 * 1000
  await sb(`locations?location_id=eq.${encodeURIComponent(location.location_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      jobber_access_token: tokens.access_token,
      jobber_refresh_token: tokens.refresh_token,
      token_expiry: expiryMs,
      token_expiry_display: new Date(expiryMs).toISOString().slice(0, 19),
      last_sync_status: `Token refreshed: ${new Date().toISOString().slice(0, 19)}`,
      updated_at: new Date().toISOString(),
    }),
    headers: { Prefer: 'return=minimal' },
  }) // MUST NOT be swallowed — Jobber rotates refresh tokens.
  console.log(`  [token] refreshed + rotated for ${location.location_id}`)
  return tokens.access_token
}

const QUOTES_QUERY = `
  query GetQuotes($after: String) {
    quotes(first: 50, after: $after) {
      nodes {
        id createdAt quoteStatus
        request { id }
        client { id }
        amounts { total }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`
const JOBS_QUERY = `
  query GetJobs($after: String) {
    jobs(first: 50, after: $after) {
      nodes {
        id createdAt jobStatus startAt completedAt total
        request { id }
        quote { id }
        client { id }
        invoices(first: 10) {
          nodes { id createdAt invoiceStatus amounts { total } }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`
const JOB_INVOICES_QUERY = `
  query GetJobInvoices($id: EncodedId!, $after: String) {
    job(id: $id) {
      invoices(first: 50, after: $after) {
        nodes { id createdAt invoiceStatus amounts { total } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

async function drainJobInvoices(token, jobNode) {
  let pageInfo = jobNode?.invoices?.pageInfo
  while (pageInfo?.hasNextPage) {
    const res = await jobberQueryThrottled(token, JOB_INVOICES_QUERY, { id: jobNode.id, after: pageInfo.endCursor })
    if (res.errors?.length) throw new Error(`job_invoices (${jobNode.id}): ${JSON.stringify(res.errors).slice(0, 300)}`)
    if (!res.data?.job) break
    const conn = res.data.job.invoices
    jobNode.invoices.nodes.push(...(conn?.nodes || []))
    pageInfo = conn?.pageInfo
    jobNode.invoices.pageInfo = pageInfo
  }
}

async function fetchAllJobber(token, query, key) {
  const all = []
  let cursor = null
  let pages = 0
  for (;;) {
    const vars = cursor ? { after: cursor } : {}
    const res = await jobberQueryThrottled(token, query, vars)
    if (res.errors?.some(e => e.extensions?.code !== 'THROTTLED')) {
      throw new Error(`${key}: ${JSON.stringify(res.errors).slice(0, 300)}`)
    }
    const page = res.data?.[key]
    if (!page) break
    if (key === 'jobs') {
      for (const j of page.nodes) {
        if (j.invoices?.pageInfo?.hasNextPage) await drainJobInvoices(token, j)
      }
    }
    all.push(...page.nodes)
    pages++
    if (pages % 10 === 0) process.stdout.write(`  [${key}] ${all.length} fetched...\n`)
    if (!page.pageInfo.hasNextPage) break
    cursor = page.pageInfo.endCursor
  }
  return all
}

const numericId = gid => {
  if (!gid) return null
  if (/^\d+$/.test(gid)) return gid
  try {
    const m = Buffer.from(gid, 'base64').toString('utf8').match(/\/(\d+)$/)
    return m ? m[1] : null
  } catch { return null }
}

// ── main ────────────────────────────────────────────────────────────────────

const locations = await sbAll(
  'locations?select=id,location_id,name,jobber_access_token,jobber_refresh_token,token_expiry,jobber_initial_import_completed_at' +
  '&jobber_initial_import_completed_at=not.is.null&jobber_access_token=not.is.null'
)
console.log(`imported locations: ${locations.map(l => `${l.name} (${l.location_id})`).join(', ')}\n`)

const report = {
  generated_note: 'blind-spot scan — requestless children of non-zero-history clients (2026-07-10). Missing nodes only; backfill-requestless.mjs compatible.',
  locations: {},
}

for (const loc of locations) {
  console.log(`═══ ${loc.name} (${loc.location_id}) ═══`)
  const slug = encodeURIComponent(loc.location_id)

  // 1. ALL jobber-linked leads + local child jobber-id sets + history map
  const leads = await sbAll(`leads?select=id,name,jobber_client_id,stage,is_junk&location_uuid=eq.${loc.id}&jobber_client_id=not.is.null`)
  const byJobberId = new Map(leads.map(l => [String(l.jobber_client_id), l]))

  const withHistory = new Set()
  const localQuoteIds = new Set()
  const localJobIds = new Set()
  const localInvoiceIds = new Set()
  for (const [table, col, sink] of [
    ['service_requests', null, null],
    ['quotes', 'jobber_quote_id', localQuoteIds],
    ['jobs', 'jobber_job_id', localJobIds],
    ['invoices', 'jobber_invoice_id', localInvoiceIds],
  ]) {
    const sel = col ? `lead_id,${col}` : 'lead_id'
    const rows = await sbAll(`${table}?select=${sel}&location_id=eq.${slug}`)
    for (const r of rows) {
      if (r.lead_id) withHistory.add(r.lead_id)
      if (col && r[col] != null) sink.add(String(r[col]))
    }
  }
  console.log(`  leads (jobber-linked): ${leads.length}; local quotes/jobs/invoices: ${localQuoteIds.size}/${localJobIds.size}/${localInvoiceIds.size}`)

  // 2. Jobber sweep (read-only)
  const token = await getValidToken(loc)
  const quotes = await fetchAllJobber(token, QUOTES_QUERY, 'quotes')
  const jobs = await fetchAllJobber(token, JOBS_QUERY, 'jobs')
  console.log(`  jobber: ${quotes.length} quotes, ${jobs.length} jobs`)

  // 3. diff — requestless nodes missing locally
  const perLead = new Map()
  const bucket = lead => {
    if (!perLead.has(lead.id)) {
      perLead.set(lead.id, {
        lead_id: lead.id, name: lead.name, stage: lead.stage, is_junk: lead.is_junk,
        jobber_client_id: lead.jobber_client_id,
        had_local_history: withHistory.has(lead.id),   // true = old scan's blind spot
        quote_ids: [], job_ids: [], invoice_count: 0, paid_invoice_count: 0,
        quote_total: 0, invoice_total: 0,
        requestful_anomaly: false,
        quote_nodes: [], job_nodes: [],
        missing: [],   // human-readable per-record lines
      })
    }
    return perLead.get(lead.id)
  }

  let orphanNodes = 0   // requestless nodes whose client has no local lead at all
  for (const q of quotes) {
    if (q.request?.id) continue                       // requestful — webhook path owns it
    const qid = numericId(q.id)
    if (localQuoteIds.has(qid)) continue              // landed fine
    const cid = numericId(q.client?.id)
    const lead = cid && byJobberId.get(cid)
    if (!lead) { orphanNodes++; continue }
    const b = bucket(lead)
    b.quote_ids.push(qid)
    const total = q.amounts?.total ? parseFloat(q.amounts.total) : 0
    b.quote_total += total
    b.quote_nodes.push(q)
    b.missing.push({ type: 'quote', jobber_id: qid, created: q.createdAt, status: q.quoteStatus || null, total })
  }
  for (const j of jobs) {
    if (j.request?.id) continue
    const jid = numericId(j.id)
    const cid = numericId(j.client?.id)
    const lead = cid && byJobberId.get(cid)
    const jobMissing = !localJobIds.has(jid)
    // nested invoices can be missing even when the job row landed
    const missingInvoices = (j.invoices?.nodes || []).filter(inv => !localInvoiceIds.has(numericId(inv.id)))
    if (!jobMissing && missingInvoices.length === 0) continue
    if (!lead) { orphanNodes++; continue }
    const b = bucket(lead)
    if (jobMissing) {
      b.job_ids.push(jid)
      b.job_nodes.push(j)
      b.missing.push({ type: 'job', jobber_id: jid, created: j.createdAt, status: j.jobStatus || null, total: j.total ? parseFloat(j.total) : 0 })
    }
    for (const inv of missingInvoices) {
      b.invoice_count++
      const paid = (inv.invoiceStatus || '').toUpperCase() === 'PAID'
      if (paid) b.paid_invoice_count++
      const total = inv.amounts?.total ? parseFloat(inv.amounts.total) : 0
      b.invoice_total += total
      b.missing.push({ type: 'invoice', jobber_id: numericId(inv.id), created: inv.createdAt, status: inv.invoiceStatus || null, total, under_job: jid, job_landed: !jobMissing })
    }
  }

  const clients = [...perLead.values()].filter(c => c.missing.length)
  const locSummary = {
    name: loc.name,
    location_uuid: loc.id,
    jobber_linked_leads: leads.length,
    clients_with_missing_records: clients.length,
    blind_spot_clients: clients.filter(c => c.had_local_history).length,
    zero_history_clients: clients.filter(c => !c.had_local_history).length,
    missing_quotes: clients.reduce((s, c) => s + c.quote_ids.length, 0),
    missing_jobs: clients.reduce((s, c) => s + c.job_ids.length, 0),
    missing_invoices: clients.reduce((s, c) => s + c.invoice_count, 0),
    missing_paid_invoices: clients.reduce((s, c) => s + c.paid_invoice_count, 0),
    missing_invoice_total: Math.round(clients.reduce((s, c) => s + c.invoice_total, 0) * 100) / 100,
    missing_quote_total: Math.round(clients.reduce((s, c) => s + c.quote_total, 0) * 100) / 100,
    orphan_requestless_nodes: orphanNodes,
    clients,
  }
  report.locations[loc.location_id] = locSummary

  console.log(`  → clients with missing records: ${clients.length} (blind-spot: ${locSummary.blind_spot_clients}, zero-history: ${locSummary.zero_history_clients})`)
  console.log(`  → missing quotes/jobs/invoices: ${locSummary.missing_quotes}/${locSummary.missing_jobs}/${locSummary.missing_invoices} (paid inv: ${locSummary.missing_paid_invoices}, $${locSummary.missing_invoice_total})`)
  for (const c of clients) {
    console.log(`    • ${c.name} [${c.stage}${c.is_junk ? ', junk' : ''}${c.had_local_history ? ', BLIND-SPOT' : ', zero-history'}]`)
    for (const m of c.missing) {
      console.log(`        ${m.type.toUpperCase()} ${m.jobber_id} created=${m.created} status=${m.status} $${m.total}${m.under_job ? ` (under job ${m.under_job}${m.job_landed ? ', job landed' : ''})` : ''}`)
    }
  }
  if (orphanNodes) console.log(`    (${orphanNodes} requestless nodes belong to Jobber clients with no local lead — likely never imported)`)
  console.log()
}

const outPath = process.argv[3] || 'blind-spot-scan.report.json'
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`report written: ${outPath}`)
