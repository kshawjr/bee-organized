// ═══════════════════════════════════════════════════════════════════════════
// Requestless-import gap — Part 2a: READ-ONLY Jobber scan (2026-07-09)
//
// Usage:  node scripts/scan-requestless-gap.mjs [envfile]
//
// For each Jobber-imported location:
//   1. Load its leads + child-table lead_ids from Supabase; compute the
//      ZERO-HISTORY set (jobber-linked leads with no service_requests, no
//      quotes, no jobs, no invoices).
//   2. Paginated read-only Jobber scan: all quotes + all jobs (with nested
//      invoices), both fetching client{id} (post-bc8e310 query shapes).
//   3. Join locally: requestless nodes whose client.id lands on a
//      zero-history lead = DROPPED BUSINESS. Zero-history leads with no
//      Jobber work at all = genuinely stale (correctly Nurturing).
//
// ZERO writes to Supabase data and ZERO writes to Jobber. The ONE side
// effect (authorized): getValidJobberToken may refresh an expired access
// token, which rotates the locations-row token columns.
//
// Writes a JSON report (scan-requestless-gap.report.json) with per-lead
// detail so the 2b backfill can be scoped without re-scanning Jobber.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'

const envPath = process.argv[2] || '.env.local'
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

// ── PostgREST helpers ───────────────────────────────────────────────────────

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

// Paginate a select fully (PostgREST caps at 1000/page).
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

// ── Jobber helpers (ports of lib/jobber.ts — token + throttle) ──────────────

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
    process.stdout.write(`  [throttle] pausing ${waitMs}ms\n`)
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

// Port of getValidJobberToken (lib/jobber.ts). May ROTATE the row token —
// authorized for this scan.
async function getValidToken(location) {
  const expiry = location.token_expiry ? parseInt(location.token_expiry) : 0
  const now = Date.now()
  if (expiry && now < expiry - 5 * 60 * 1000) return location.jobber_access_token
  const test = await jobberQuery(location.jobber_access_token, '{ account { id } }')
  if (test?.data?.account?.id) return location.jobber_access_token
  // refresh
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
  }) // MUST NOT be swallowed: Jobber rotates refresh tokens — losing this
     // write would orphan the new refresh token and break the connection.
  console.log(`  [token] refreshed + rotated for ${location.location_id}`)
  return tokens.access_token
}

// ── GraphQL queries (mirror bc8e310 shapes) ─────────────────────────────────

const QUOTES_QUERY = `
  query GetQuotes($after: String) {
    quotes(first: 50, after: $after) {
      nodes {
        id createdAt
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

// Continuation pages for one job's invoices — mirrors lib/jobber-import.ts
// JOB_INVOICES_QUERY/drainJobInvoices (42474fc): a job can out-page its
// nested invoices(first: 10); without the drain, invoice 11+ is invisible
// to the scan's counts.
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
    if (!res.data?.job) break   // job deleted mid-drain — nothing to keep
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

const report = { generated_note: 'scan-requestless-gap 2a report', locations: {} }

for (const loc of locations) {
  console.log(`═══ ${loc.name} (${loc.location_id}) ═══`)
  const slug = encodeURIComponent(loc.location_id)

  // 1. zero-history set
  const leads = await sbAll(`leads?select=id,name,jobber_client_id,stage,is_junk&location_uuid=eq.${loc.id}&jobber_client_id=not.is.null`)
  const withHistory = new Set()
  for (const table of ['service_requests', 'quotes', 'jobs', 'invoices']) {
    const rows = await sbAll(`${table}?select=lead_id&location_id=eq.${slug}`)
    for (const r of rows) if (r.lead_id) withHistory.add(r.lead_id)
  }
  const zeroHistory = leads.filter(l => !withHistory.has(l.id))
  const zeroByJobberId = new Map(zeroHistory.map(l => [String(l.jobber_client_id), l]))
  console.log(`  leads (jobber-linked): ${leads.length}; zero-history: ${zeroHistory.length}`)

  // 2. Jobber scan (read-only)
  const token = await getValidToken(loc)
  const quotes = await fetchAllJobber(token, QUOTES_QUERY, 'quotes')
  const jobs = await fetchAllJobber(token, JOBS_QUERY, 'jobs')
  console.log(`  jobber: ${quotes.length} quotes, ${jobs.length} jobs`)

  // 3. local join
  const perLead = new Map() // lead_id -> { quotes: [], jobs: [], invoices: n, ... }
  const bucket = lead => {
    if (!perLead.has(lead.id)) {
      perLead.set(lead.id, {
        lead_id: lead.id, name: lead.name, stage: lead.stage, is_junk: lead.is_junk,
        jobber_client_id: lead.jobber_client_id,
        quote_ids: [], job_ids: [], invoice_count: 0, paid_invoice_count: 0,
        quote_total: 0, invoice_total: 0,
        requestful_anomaly: false,
        // raw nodes so 2b projections (determineLeadStage inputs) are
        // computable offline without another Jobber sweep
        quote_nodes: [], job_nodes: [],
      })
    }
    return perLead.get(lead.id)
  }

  for (const q of quotes) {
    const cid = numericId(q.client?.id)
    const lead = cid && zeroByJobberId.get(cid)
    if (!lead) continue
    const b = bucket(lead)
    b.quote_ids.push(numericId(q.id))
    b.quote_total += q.amounts?.total ? parseFloat(q.amounts.total) : 0
    if (q.request?.id) b.requestful_anomaly = true
    b.quote_nodes.push(q)
  }
  for (const j of jobs) {
    const cid = numericId(j.client?.id)
    const lead = cid && zeroByJobberId.get(cid)
    if (!lead) continue
    const b = bucket(lead)
    b.job_ids.push(numericId(j.id))
    if (j.request?.id) b.requestful_anomaly = true
    b.job_nodes.push(j)
    for (const inv of j.invoices?.nodes || []) {
      b.invoice_count++
      if ((inv.invoiceStatus || '').toUpperCase() === 'PAID') b.paid_invoice_count++
      b.invoice_total += inv.amounts?.total ? parseFloat(inv.amounts.total) : 0
    }
  }

  const dropped = [...perLead.values()]
  const anomalies = dropped.filter(d => d.requestful_anomaly)
  const stale = zeroHistory.length - dropped.length
  const sumQ = dropped.reduce((s, d) => s + d.quote_ids.length, 0)
  const sumJ = dropped.reduce((s, d) => s + d.job_ids.length, 0)
  const sumI = dropped.reduce((s, d) => s + d.invoice_count, 0)
  const sumPaid = dropped.reduce((s, d) => s + d.paid_invoice_count, 0)
  const sumInvTotal = dropped.reduce((s, d) => s + d.invoice_total, 0)

  console.log(`  → DROPPED BUSINESS: ${dropped.length} clients (${sumQ} quotes, ${sumJ} jobs, ${sumI} invoices of which ${sumPaid} paid, $${sumInvTotal.toFixed(2)} invoiced)`)
  console.log(`  → GENUINELY STALE:  ${stale} clients (no Jobber work — correctly Nurturing)`)
  if (anomalies.length) console.log(`  ⚠ ${anomalies.length} zero-history clients have REQUEST-keyed Jobber work (unexpected — inspect)`)

  report.locations[loc.location_id] = {
    name: loc.name,
    location_uuid: loc.id,
    jobber_linked_leads: leads.length,
    zero_history: zeroHistory.length,
    dropped_business_clients: dropped.length,
    genuinely_stale_clients: stale,
    dropped_quotes: sumQ, dropped_jobs: sumJ,
    dropped_invoices: sumI, dropped_paid_invoices: sumPaid,
    dropped_invoice_total: Math.round(sumInvTotal * 100) / 100,
    requestful_anomalies: anomalies.length,
    clients: dropped.sort((a, b) => b.invoice_total - a.invoice_total),
  }
  console.log('')
}

const out = 'scan-requestless-gap.report.json'
writeFileSync(out, JSON.stringify(report, null, 2))
console.log(`report written: ${out}`)
