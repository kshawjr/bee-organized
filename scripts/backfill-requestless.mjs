// ═══════════════════════════════════════════════════════════════════════════
// Requestless-import gap — Part 2b: TARGETED BACKFILL
//
// Usage:
//   node scripts/backfill-requestless.mjs [envfile] [--location slug] [--execute] [--report path]
//
// DRY-RUN BY DEFAULT — zero writes unless --execute is passed. Dry run
// re-fetches nothing from Jobber either: it projects entirely from the 2a
// report (scan-requestless-gap.report.json). --execute re-fetches the scoped
// clients' requestless nodes live before writing.
//
// SCOPE: only the clients the 2a scan PROVED have dropped requestless
// quotes/jobs in Jobber (report.locations[slug].clients). Zero-history
// clients with no Jobber work are never touched — they correctly derive
// Nurturing.
//
// Per client (mirrors the bc8e310 import-route requestless block exactly):
//   quotes first (so Job.quote links resolve), each written with
//   service_request_id NULL through idempotent jobber_*_id+location upserts;
//   engagements found/attach via the resolveEngagementForChild rules
//   (rule 2 Job.quote → rule 4 most-recent-open → rule 5 implicit founding);
//   stage advances in backfill mode (§5 stale rules, silent, no drips);
//   then determineLeadStage re-derives leads.stage from the full bundle.
//
// PREREQUISITE: the requestless_children_nullable.sql migration must be
// applied first (quotes/jobs.service_request_id NOT NULL otherwise rejects
// every insert). The script preflights this with a cheap null-filter probe.
//
// Strictly additive + re-runnable: upserts key on jobber_*_id + location;
// founding is idempotent via the child's engagement_id; a re-run updates
// in place and founds nothing twice. Deliberately NOT touched: paused,
// drips, is_junk, import_source, touchpoints.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'

// ── args / env ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const locIdx = args.indexOf('--location')
const ONLY_LOCATION = locIdx >= 0 ? args[locIdx + 1] : null
const reportIdx = args.indexOf('--report')
const positional = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--report' && args[i - 1] !== '--location')
const envPath = positional[0] || '.env.local'
const outPath = reportIdx >= 0
  ? args[reportIdx + 1]
  : `backfill-requestless-report.${EXECUTE ? 'run' : 'dryrun'}.json`

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

const scan = JSON.parse(readFileSync('scan-requestless-gap.report.json', 'utf8'))

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
const one = rows => (Array.isArray(rows) && rows.length ? rows[0] : null)
const nowIso = () => new Date().toISOString()

// ── Jobber helpers (ports of lib/jobber.ts) ─────────────────────────────────

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

// Port of getValidJobberToken. Rotates the row token when expired.
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
      updated_at: nowIso(),
    }),
    headers: { Prefer: 'return=minimal' },
  }) // must not be swallowed — Jobber rotates refresh tokens
  return tokens.access_token
}

// Full field shapes matching lib/jobber-import.ts QUOTES_QUERY / JOBS_QUERY
// (bc8e310) so the upsert payloads are byte-compatible with the import's.
const QUOTES_QUERY = `
  query GetQuotes($after: String) {
    quotes(first: 50, after: $after) {
      nodes {
        id createdAt jobberWebUri
        request { id }
        client { id }
        amounts { subtotal taxAmount discountAmount total }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`
const JOBS_QUERY = `
  query GetJobs($after: String) {
    jobs(first: 50, after: $after) {
      nodes {
        id createdAt jobberWebUri title jobStatus startAt completedAt total
        request { id }
        quote { id }
        client { id }
        invoices(first: 10) {
          nodes {
            id createdAt jobberWebUri invoiceStatus
            amounts { subtotal taxAmount discountAmount total }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

async function fetchAllJobber(token, query, key) {
  const all = []
  let cursor = null
  for (;;) {
    const res = await jobberQueryThrottled(token, query, cursor ? { after: cursor } : {})
    if (res.errors?.some(e => e.extensions?.code !== 'THROTTLED')) {
      throw new Error(`${key}: ${JSON.stringify(res.errors).slice(0, 300)}`)
    }
    const page = res.data?.[key]
    if (!page) break
    all.push(...page.nodes)
    if (!page.pageInfo.hasNextPage) break
    cursor = page.pageInfo.endCursor
  }
  return all
}

// ── ports of lib/jobber-import.ts helpers ───────────────────────────────────

const extractJobberId = gid => {
  if (!gid) return null
  if (/^\d+$/.test(gid)) return gid
  try {
    const m = Buffer.from(gid, 'base64').toString('utf8').match(/\/(\d+)$/)
    return m ? m[1] : null
  } catch { return null }
}

const NURTURING_AGE_MS = 30 * 24 * 60 * 60 * 1000
const ts = v => (v ? new Date(v).getTime() : 0)

// Port of determineLeadStage (lib/jobber-import.ts) — full-history lead
// classifier, most recent engagement wins.
function determineLeadStage(bundle, nowMs = Date.now()) {
  const aged = t => nowMs - t > NURTURING_AGE_MS
  const { email, phone, clientCreatedAt, requests, quotes, jobs, invoices } = bundle
  const hasActivity = requests.length > 0 || quotes.length > 0 || jobs.length > 0 || invoices.length > 0
  if (!email && !phone && !hasActivity) return { stage: 'New', isJunk: true }
  const jobDone = j => !!j.completedAt || (j.jobStatus || '').toLowerCase().includes('complet')
  if (jobs.some(j => !jobDone(j))) return { stage: 'Job in Progress', isJunk: false }
  const isPaid = i => (i.invoiceStatus || '').toUpperCase() === 'PAID'
  const lastRequest = Math.max(0, ...requests.map(r => ts(r.createdAt)))
  const lastQuote   = Math.max(0, ...quotes.map(q => ts(q.createdAt)))
  const lastJob     = Math.max(0, ...jobs.map(j => Math.max(ts(j.completedAt), ts(j.startAt), ts(j.createdAt))))
  const lastPaid    = Math.max(0, ...invoices.filter(isPaid).map(i => ts(i.createdAt)))
  const lastUnpaid  = Math.max(0, ...invoices.filter(i => !isPaid(i)).map(i => ts(i.createdAt)))
  const head = Math.max(lastRequest, lastQuote, lastJob, lastPaid, lastUnpaid)
  if (head > 0) {
    if (lastRequest === head && lastRequest > lastQuote && lastRequest > lastJob && lastRequest > lastPaid && lastRequest > lastUnpaid) {
      return { stage: aged(lastRequest) ? 'Nurturing' : 'New', isJunk: false }
    }
    if (lastQuote === head && lastQuote > lastJob && lastQuote > lastPaid && lastQuote > lastUnpaid) {
      return { stage: aged(lastQuote) ? 'Nurturing' : 'Estimate Sent', isJunk: false }
    }
    if (lastPaid === head && lastPaid >= lastUnpaid) {
      return { stage: 'Closed Won', isJunk: false }
    }
    return { stage: 'Final Processing', isJunk: false }
  }
  const created = ts(clientCreatedAt)
  return { stage: created && !aged(created) ? 'New' : 'Nurturing', isJunk: false }
}

const JOB_STATUS = {
  ACTIVE: 'in_progress', COMPLETED: 'completed',
  REQUIRES_INVOICING: 'completed', LATE: 'late',
  TODAY: 'today', UPCOMING: 'upcoming', ARCHIVED: 'archived',
}

// Port of upsertQuote (service_request_id null for requestless).
async function upsertQuote(quote, leadId, locSlug) {
  const jid = extractJobberId(quote.id)
  const payload = {
    service_request_id: null, lead_id: leadId, location_id: locSlug,
    jobber_quote_id: jid,
    quote_url: quote.jobberWebUri || null,
    status: 'sent', // bulk shape carries no quoteStatus — import parity
    subtotal:        quote.amounts?.subtotal       ? parseFloat(quote.amounts.subtotal)       : null,
    tax_amount:      quote.amounts?.taxAmount      ? parseFloat(quote.amounts.taxAmount)      : null,
    discount_amount: quote.amounts?.discountAmount ? parseFloat(quote.amounts.discountAmount) : null,
    total:           quote.amounts?.total          ? parseFloat(quote.amounts.total)          : null,
    sent_at: quote.createdAt || null,
    jobber_synced_at: nowIso(), updated_at: nowIso(),
  }
  const existing = one(await sb(`quotes?select=id&jobber_quote_id=eq.${jid}&location_id=eq.${encodeURIComponent(locSlug)}`))
  if (existing) {
    await sb(`quotes?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify(payload), headers: { Prefer: 'return=minimal' } })
    return { id: existing.id, created: false }
  }
  const ins = await sb('quotes?select=id', {
    method: 'POST',
    body: JSON.stringify({ ...payload, created_at: quote.createdAt || nowIso() }),
    headers: { Prefer: 'return=representation' },
  })
  return { id: one(ins).id, created: true }
}

// Port of upsertJob (service_request_id null; Job.quote → quote_id when the
// quote row exists locally, never nulled).
async function upsertJob(job, leadId, locSlug) {
  const jid = extractJobberId(job.id)
  let quoteDbId = null
  const jq = extractJobberId(job.quote?.id)
  if (jq) {
    const row = one(await sb(`quotes?select=id&jobber_quote_id=eq.${jq}&location_id=eq.${encodeURIComponent(locSlug)}`))
    if (row) quoteDbId = row.id
  }
  const payload = {
    service_request_id: null, lead_id: leadId, location_id: locSlug,
    jobber_job_id: jid,
    job_url: job.jobberWebUri || null,
    title: job.title || null,
    status: JOB_STATUS[job.jobStatus?.toUpperCase()] ?? 'unknown',
    scheduled_start: job.startAt || null,
    completed_at:    job.completedAt || null,
    total: job.total ? parseFloat(job.total) : null,
    jobber_synced_at: nowIso(), updated_at: nowIso(),
  }
  if (quoteDbId) payload.quote_id = quoteDbId
  const existing = one(await sb(`jobs?select=id&jobber_job_id=eq.${jid}&location_id=eq.${encodeURIComponent(locSlug)}`))
  if (existing) {
    await sb(`jobs?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify(payload), headers: { Prefer: 'return=minimal' } })
    return { id: existing.id, created: false, quote_db_id: quoteDbId }
  }
  const ins = await sb('jobs?select=id', {
    method: 'POST',
    body: JSON.stringify({ ...payload, created_at: job.createdAt || nowIso() }),
    headers: { Prefer: 'return=representation' },
  })
  return { id: one(ins).id, created: true, quote_db_id: quoteDbId }
}

// Port of upsertInvoice.
async function upsertInvoice(invoice, jobDbId, leadId, locSlug) {
  const jid = extractJobberId(invoice.id)
  const status = (invoice.invoiceStatus || '').toUpperCase()
  const isPaid = status === 'PAID'
  const totalNum = invoice.amounts?.total ? parseFloat(invoice.amounts.total) : null
  const payload = {
    job_id: jobDbId, service_request_id: null, lead_id: leadId, location_id: locSlug,
    jobber_invoice_id: jid,
    invoice_url: invoice.jobberWebUri || null,
    status: isPaid ? 'paid' : status === 'PARTIAL' ? 'partial' : status === 'BAD_DEBT' ? 'bad_debt' : 'sent',
    subtotal:        invoice.amounts?.subtotal       ? parseFloat(invoice.amounts.subtotal)       : null,
    tax_amount:      invoice.amounts?.taxAmount      ? parseFloat(invoice.amounts.taxAmount)      : null,
    discount_amount: invoice.amounts?.discountAmount ? parseFloat(invoice.amounts.discountAmount) : null,
    total: totalNum,
    paid_amount:   isPaid ? totalNum : null,
    balance_owing: isPaid ? 0 : totalNum,
    paid_at:       isPaid ? (invoice.createdAt || null) : null,
    issued_at: invoice.createdAt || null,
    jobber_synced_at: nowIso(), updated_at: nowIso(),
  }
  const existing = one(await sb(`invoices?select=id&jobber_invoice_id=eq.${jid}&location_id=eq.${encodeURIComponent(locSlug)}`))
  if (existing) {
    await sb(`invoices?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify(payload), headers: { Prefer: 'return=minimal' } })
    return { id: existing.id, created: false, status: payload.status }
  }
  const ins = await sb('invoices?select=id', {
    method: 'POST',
    body: JSON.stringify({ ...payload, created_at: invoice.createdAt || nowIso() }),
    headers: { Prefer: 'return=representation' },
  })
  return { id: one(ins).id, created: true, status: payload.status }
}

// ── ports of lib/engagements.ts (founding / resolution / backfill advance) ──

const OPENING_STAGE = { request: 'Request', quote: 'Estimate', job: 'Job in Progress', manual: 'Request' }
const ENGAGEMENT_STAGE_RANK = { 'Request': 0, 'Estimate': 1, 'Job in Progress': 2, 'Final Processing': 3, 'Closed Won': 4, 'Closed Lost': 4 }
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fallbackTitle = () => { const d = new Date(); return `Engagement – ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` }

async function writeSyncLog(locSlug, engagementId, foundedBy, note) {
  try {
    await sb('sync_log', {
      method: 'POST',
      body: JSON.stringify({
        location_id: locSlug, direction: 'inbound', entity_type: 'engagement',
        entity_id: engagementId, status: 'success',
        message: `[engagement:${foundedBy}] ${note}`,
      }),
      headers: { Prefer: 'return=minimal' },
    })
  } catch (e) { console.error('  sync_log write failed (non-fatal):', e.message) }
}

// Execute-mode founding counter (reset per location; dry-run counts via
// simulation instead).
const runCounters = { founded: 0 }

// Port of foundEngagement (single-writer script → race guard kept anyway).
async function foundEngagement({ clientId, foundedBy, title, foundingChildTable, foundingChildId, note, locSlug }) {
  const childRow = one(await sb(`${foundingChildTable}?select=id,engagement_id&id=eq.${foundingChildId}`))
  if (!childRow) throw new Error(`founding child not found: ${foundingChildTable}/${foundingChildId}`)
  if (childRow.engagement_id) return { id: childRow.engagement_id, created: false }
  const lead = one(await sb(`leads?select=id,location_uuid,location_id,name&id=eq.${clientId}`))
  if (!lead?.location_uuid) throw new Error(`lead ${clientId} missing location_uuid`)
  const now = nowIso()
  const ins = await sb('engagements?select=id', {
    method: 'POST',
    body: JSON.stringify({
      client_id: clientId,
      location_uuid: lead.location_uuid,
      stage: OPENING_STAGE[foundedBy],
      founded_by: foundedBy,
      title: (title || '').trim() || fallbackTitle(),
      stage_entered_at: now, created_at: now, updated_at: now,
    }),
    headers: { Prefer: 'return=representation' },
  })
  const engId = one(ins).id
  const linked = await sb(`${foundingChildTable}?id=eq.${foundingChildId}&engagement_id=is.null&select=id`, {
    method: 'PATCH',
    body: JSON.stringify({ engagement_id: engId }),
    headers: { Prefer: 'return=representation' },
  })
  if (!linked?.length) {
    const reread = one(await sb(`${foundingChildTable}?select=engagement_id&id=eq.${foundingChildId}`))
    if (reread?.engagement_id) {
      await sb(`engagements?id=eq.${engId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
      return { id: reread.engagement_id, created: false }
    }
    throw new Error(`founding child link failed: ${foundingChildTable}/${foundingChildId}`)
  }
  await writeSyncLog(locSlug, engId, foundedBy,
    note || `founded via ${foundingChildTable}/${foundingChildId} for lead "${lead.name || clientId}" at stage ${OPENING_STAGE[foundedBy]}`)
  runCounters.founded++
  return { id: engId, created: true }
}

// Port of attachToEngagement.
async function attachToEngagement(childTable, childRowId, engagementId) {
  const row = one(await sb(`${childTable}?select=engagement_id&id=eq.${childRowId}`))
  if (!row || row.engagement_id === engagementId) return
  if (row.engagement_id) {
    console.warn(`  [attach conflict] ${childTable}/${childRowId} already on ${row.engagement_id} — not overwriting`)
    return
  }
  await sb(`${childTable}?id=eq.${childRowId}&engagement_id=is.null`, {
    method: 'PATCH',
    body: JSON.stringify({ engagement_id: engagementId }),
    headers: { Prefer: 'return=minimal' },
  })
}

// Port of resolveEngagementForChild — quotes/jobs subset (no SR paths: this
// backfill only handles requestless children; rule 1/SR-founding never fires).
async function resolveEngagementForChild({ childTable, childId, leadId, quoteDbId, title, locSlug }) {
  const own = one(await sb(`${childTable}?select=engagement_id&id=eq.${childId}`))
  if (own?.engagement_id) return own.engagement_id
  if (childTable === 'jobs' && quoteDbId) {
    const viaQuote = one(await sb(`quotes?select=engagement_id&id=eq.${quoteDbId}`))
    if (viaQuote?.engagement_id) return viaQuote.engagement_id
  }
  const openEngs = await sb(
    `engagements?select=id,stage,created_at&client_id=eq.${leadId}` +
    `&stage=not.in.("Closed Won","Closed Lost")&order=created_at.desc&limit=1`)
  if (openEngs?.length) {
    const target = openEngs[0]
    await writeSyncLog(locSlug, target.id, childTable === 'quotes' ? 'quote' : 'job',
      `ambiguous ${childTable}/${childId}: no resolvable parent — attached to most-recent-open engagement (rule 5)`)
    return target.id
  }
  const founded = await foundEngagement({
    clientId: leadId,
    foundedBy: childTable === 'quotes' ? 'quote' : 'job',
    title,
    foundingChildTable: childTable,
    foundingChildId: childId,
    note: `implicit founding (requestless backfill): unlinked ${childTable}/${childId} with no open engagement (rule 5)`,
    locSlug,
  })
  return founded.id
}

// Port of deriveEngagementStage — backfill mode (§5 stale rules).
function deriveEngagementStageBackfill(children, nowMs = Date.now()) {
  const { quotes, jobs, invoices } = children
  const jobDone = j => !!j.completed_at || (j.status || '').toLowerCase().includes('complet')
  const invoicePaid = i => i.status === 'paid'
  const quoteActivity = q => Math.max(ts(q.approved_at), ts(q.sent_at), ts(q.created_at))
  if (jobs.length > 0) {
    if (jobs.some(j => !jobDone(j))) return { stage: 'Job in Progress' }
    if (invoices.length > 0 && invoices.every(invoicePaid)) {
      const lastPaidAt = Math.max(0, ...invoices.map(i => ts(i.paid_at)))
      return { stage: 'Closed Won', closed_reason: 'won', closed_at: new Date(lastPaidAt || nowMs).toISOString() }
    }
    return { stage: 'Final Processing' }
  }
  if (quotes.length > 0) {
    const last = Math.max(...quotes.map(quoteActivity))
    if (nowMs - last > NURTURING_AGE_MS) {
      return { stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: new Date(nowMs).toISOString() }
    }
    return { stage: 'Estimate' }
  }
  return { stage: 'Request' }
}

// Port of maybeAdvanceEngagementStage (backfill mode) — forward-only on
// ENGAGEMENT_STAGE_RANK + money roll-ups.
async function maybeAdvanceEngagementStageBackfill(engagementId) {
  const eng = one(await sb(`engagements?select=id,stage&id=eq.${engagementId}`))
  if (!eng) return
  const [quotes, jobs, invoices] = await Promise.all([
    sb(`quotes?select=status,sent_at,approved_at,created_at&engagement_id=eq.${engagementId}`),
    sb(`jobs?select=status,completed_at,scheduled_start,created_at&engagement_id=eq.${engagementId}`),
    sb(`invoices?select=status,total,paid_amount,balance_owing,paid_at,issued_at,created_at&engagement_id=eq.${engagementId}`),
  ])
  const derived = deriveEngagementStageBackfill({ quotes: quotes || [], jobs: jobs || [], invoices: invoices || [] })
  const num = v => (v == null ? 0 : Number(v) || 0)
  const patch = {
    total_invoiced: (invoices || []).reduce((s, i) => s + num(i.total), 0),
    total_paid: (invoices || []).reduce((s, i) => s + num(i.paid_amount), 0),
    balance_owing: (invoices || []).reduce(
      (s, i) => s + (i.balance_owing != null ? num(i.balance_owing) : num(i.total) - num(i.paid_amount)), 0),
    updated_at: nowIso(),
  }
  const advance = (ENGAGEMENT_STAGE_RANK[derived.stage] ?? 0) > (ENGAGEMENT_STAGE_RANK[eng.stage] ?? 0)
  if (advance) {
    patch.stage = derived.stage
    patch.stage_entered_at = nowIso()
    if (derived.closed_reason) patch.closed_reason = derived.closed_reason
    if (derived.closed_at) patch.closed_at = derived.closed_at
    if (derived.closed_reason === 'stale_on_import') {
      patch.closed_note = 'Closed automatically at import: no activity within 30 days (Ruling A for quote-only).'
    }
  }
  await sb(`engagements?id=eq.${engagementId}`, { method: 'PATCH', body: JSON.stringify(patch), headers: { Prefer: 'return=minimal' } })
  return advance ? derived.stage : null
}

// ── dry-run simulation (no Jobber, no DB writes — projects from 2a report) ──

function simulateClient(client, nowMs) {
  // Mirrors execute order: quotes by createdAt, then jobs by createdAt.
  // Engagement state tracked in-memory (zero-history clients have none).
  const engs = [] // { foundedBy, quotes: [], jobs: [], invoices: [], stage }
  const quotes = [...client.quote_nodes].sort((a, b) => ts(a.createdAt) - ts(b.createdAt))
  const jobs = [...client.job_nodes].sort((a, b) => ts(a.createdAt) - ts(b.createdAt))
  const openEng = () => engs.findLast(e => e.stage !== 'Closed Won' && e.stage !== 'Closed Lost')
  const advance = eng => {
    const derived = deriveEngagementStageBackfill({
      quotes: eng.quotes.map(q => ({ status: 'sent', sent_at: q.createdAt, created_at: q.createdAt })),
      jobs: eng.jobs.map(j => ({ status: JOB_STATUS[j.jobStatus?.toUpperCase()] ?? 'unknown', completed_at: j.completedAt })),
      invoices: eng.invoices.map(i => ({
        status: (i.invoiceStatus || '').toUpperCase() === 'PAID' ? 'paid' : 'sent',
        paid_at: (i.invoiceStatus || '').toUpperCase() === 'PAID' ? (i.createdAt || null) : null,
      })),
    }, nowMs)
    if ((ENGAGEMENT_STAGE_RANK[derived.stage] ?? 0) > (ENGAGEMENT_STAGE_RANK[eng.stage] ?? 0)) {
      eng.stage = derived.stage
      eng.closed_reason = derived.closed_reason || eng.closed_reason
    }
  }
  const quoteEngByJobberId = new Map()
  for (const q of quotes) {
    let eng = openEng()
    if (!eng) { eng = { foundedBy: 'quote', stage: 'Estimate', quotes: [], jobs: [], invoices: [], founded: true }; engs.push(eng) }
    eng.quotes.push(q)
    quoteEngByJobberId.set(extractJobberId(q.id), eng)
    advance(eng)
  }
  for (const j of jobs) {
    // scan job_nodes may lack quote{id} (older report shape) — treat as no link
    const viaQuote = j.quote?.id ? quoteEngByJobberId.get(extractJobberId(j.quote.id)) : null
    let eng = viaQuote || openEng()
    if (!eng) { eng = { foundedBy: 'job', stage: 'Job in Progress', quotes: [], jobs: [], invoices: [], founded: true }; engs.push(eng) }
    eng.jobs.push(j)
    for (const inv of j.invoices?.nodes || []) eng.invoices.push(inv)
    advance(eng)
  }
  // lead stage: full requestless bundle
  const allInvoices = jobs.flatMap(j => j.invoices?.nodes || [])
  const { stage: newStage } = determineLeadStage({
    email: 'x', phone: null, clientCreatedAt: null,
    requests: [], quotes, jobs, invoices: allInvoices,
  }, nowMs)
  return { engs, newStage }
}

// ── main ────────────────────────────────────────────────────────────────────

console.log(`mode: ${EXECUTE ? '⚠ EXECUTE (writes)' : 'dry-run (zero writes)'}\n`)
const nowMs = Date.now()
const out = { mode: EXECUTE ? 'execute' : 'dry-run', locations: {} }

// Preflight (execute only): the nullability migration must be applied.
if (EXECUTE) {
  const probe = await fetch(`${SB_URL}/rest/v1/quotes?select=id&service_request_id=is.null&limit=1`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  })
  if (!probe.ok) throw new Error('preflight failed reading quotes')
  // The real gate is the INSERT constraint; probe can't see it — so verify
  // via OpenAPI: service_request_id must NOT be in the required list.
  const spec = await (await fetch(`${SB_URL}/rest/v1/`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } })).json()
  for (const t of ['quotes', 'jobs']) {
    if ((spec.definitions?.[t]?.required || []).includes('service_request_id')) {
      throw new Error(`PREFLIGHT: ${t}.service_request_id is still NOT NULL — apply migrations/requestless_children_nullable.sql first`)
    }
  }
  console.log('preflight ok: service_request_id nullable on quotes + jobs\n')
}

for (const [slug, locReport] of Object.entries(scan.locations)) {
  if (ONLY_LOCATION && slug !== ONLY_LOCATION) continue
  const clients = locReport.clients || []
  console.log(`═══ ${locReport.name} (${slug}) — ${clients.length} clients with proven dropped business ═══`)

  const stats = {
    clients_repaired: 0, quotes_written: 0, jobs_written: 0, invoices_written: 0,
    engagements_founded: 0, engagements_closed_won: 0, engagements_closed_lost_stale: 0,
    engagements_open: 0, stage_changes: {}, stage_change_list: [], errors: [],
  }

  if (!EXECUTE) {
    // ── projection from the 2a report ──
    for (const c of clients) {
      const { engs, newStage } = simulateClient(c, nowMs)
      stats.clients_repaired++
      stats.quotes_written += c.quote_nodes.length
      stats.jobs_written += c.job_nodes.length
      stats.invoices_written += c.job_nodes.reduce((s, j) => s + (j.invoices?.nodes || []).length, 0)
      stats.engagements_founded += engs.length
      for (const e of engs) {
        if (e.stage === 'Closed Won') stats.engagements_closed_won++
        else if (e.stage === 'Closed Lost') stats.engagements_closed_lost_stale++
        else stats.engagements_open++
      }
      if (newStage !== c.stage) {
        const key = `${c.stage} → ${newStage}`
        stats.stage_changes[key] = (stats.stage_changes[key] || 0) + 1
        stats.stage_change_list.push({ lead_id: c.lead_id, name: c.name, from: c.stage, to: newStage })
      }
    }
  } else {
    // ── live execute: re-fetch scoped clients' requestless nodes ──
    runCounters.founded = 0
    const loc = one(await sb(`locations?select=*&location_id=eq.${encodeURIComponent(slug)}`))
    if (!loc?.jobber_access_token) { console.error(`  no token for ${slug} — skipping`); continue }
    const token = await getValidToken(loc)
    const allQuotes = await fetchAllJobber(token, QUOTES_QUERY, 'quotes')
    const allJobs = await fetchAllJobber(token, JOBS_QUERY, 'jobs')
    const scopedByJobberId = new Map(clients.map(c => [String(c.jobber_client_id), c]))
    const isScopedRequestless = n =>
      !n.request?.id && scopedByJobberId.has(String(extractJobberId(n.client?.id) || ''))

    for (const c of clients) {
      try {
        const myQuotes = allQuotes.filter(n => isScopedRequestless(n) && extractJobberId(n.client.id) === String(c.jobber_client_id))
          .sort((a, b) => ts(a.createdAt) - ts(b.createdAt))
        const myJobs = allJobs.filter(n => isScopedRequestless(n) && extractJobberId(n.client.id) === String(c.jobber_client_id))
          .sort((a, b) => ts(a.createdAt) - ts(b.createdAt))
        if (!myQuotes.length && !myJobs.length) continue // vanished since scan

        // quotes first — Job.quote links resolve against written quote rows
        for (const q of myQuotes) {
          const qRes = await upsertQuote(q, c.lead_id, slug)
          stats.quotes_written++
          const engId = await resolveEngagementForChild({
            childTable: 'quotes', childId: qRes.id, leadId: c.lead_id, locSlug: slug,
          })
          if (engId) {
            await attachToEngagement('quotes', qRes.id, engId)
            const adv = await maybeAdvanceEngagementStageBackfill(engId)
            if (qRes.created && adv === 'Closed Lost') stats.engagements_closed_lost_stale++
          }
        }
        for (const j of myJobs) {
          const jRes = await upsertJob(j, c.lead_id, slug)
          stats.jobs_written++
          const invIds = []
          for (const inv of j.invoices?.nodes || []) {
            const iRes = await upsertInvoice(inv, jRes.id, c.lead_id, slug)
            stats.invoices_written++
            invIds.push(iRes.id)
            if (iRes.status === 'paid') {
              const paidTotal = inv.amounts?.total ? parseFloat(inv.amounts.total) : null
              await sb(`leads?id=eq.${c.lead_id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  paid_amount: paidTotal, balance_owing: 0,
                  invoice_paid_at: inv.createdAt || nowIso(), updated_at: nowIso(),
                }),
                headers: { Prefer: 'return=minimal' },
              })
            }
          }
          const engId = await resolveEngagementForChild({
            childTable: 'jobs', childId: jRes.id, leadId: c.lead_id,
            quoteDbId: jRes.quote_db_id, title: j.title || null, locSlug: slug,
          })
          if (engId) {
            await attachToEngagement('jobs', jRes.id, engId)
            for (const iid of invIds) await attachToEngagement('invoices', iid, engId)
            await maybeAdvanceEngagementStageBackfill(engId)
          }
        }

        // lead stage re-derivation from the full requestless bundle
        const allInvoices = myJobs.flatMap(j => j.invoices?.nodes || [])
        const lead = one(await sb(`leads?select=id,stage,email,phone,created_at&id=eq.${c.lead_id}`))
        const { stage: newStage } = determineLeadStage({
          email: lead?.email || null, phone: lead?.phone || null,
          clientCreatedAt: lead?.created_at || null,
          requests: [], quotes: myQuotes, jobs: myJobs, invoices: allInvoices,
        }, nowMs)
        if (lead && newStage !== lead.stage) {
          await sb(`leads?id=eq.${c.lead_id}`, {
            method: 'PATCH',
            body: JSON.stringify({ stage: newStage, updated_at: nowIso() }),
            headers: { Prefer: 'return=minimal' },
          })
          const key = `${lead.stage} → ${newStage}`
          stats.stage_changes[key] = (stats.stage_changes[key] || 0) + 1
          stats.stage_change_list.push({ lead_id: c.lead_id, name: c.name, from: lead.stage, to: newStage })
        }
        stats.clients_repaired++
      } catch (err) {
        stats.errors.push(`${c.name} (${c.lead_id}): ${err.message}`)
        console.error(`  ✗ ${c.name}: ${err.message}`)
      }
    }

    // ── post-run actuals from the DB (not in-process counters): every
    //    quote/job-founded engagement on the scoped leads is ours — these
    //    clients had zero engagements before the backfill. ──
    stats.engagements_founded = runCounters.founded
    stats.engagements_closed_won = 0
    stats.engagements_closed_lost_stale = 0
    stats.engagements_open = 0
    const leadIds = clients.map(c => c.lead_id)
    for (let i = 0; i < leadIds.length; i += 50) {
      const chunk = leadIds.slice(i, i + 50)
      const engs = await sb(
        `engagements?select=id,stage,closed_reason&client_id=in.(${chunk.join(',')})` +
        `&founded_by=in.(quote,job)`)
      for (const e of engs || []) {
        if (e.stage === 'Closed Won') stats.engagements_closed_won++
        else if (e.stage === 'Closed Lost' && e.closed_reason === 'stale_on_import') stats.engagements_closed_lost_stale++
        else if (e.stage === 'Closed Lost') { /* owner-closed — count as neither */ }
        else stats.engagements_open++
      }
    }
  }

  console.log(`  clients repaired:      ${stats.clients_repaired}`)
  console.log(`  quotes/jobs/invoices:  ${stats.quotes_written}/${stats.jobs_written}/${stats.invoices_written}`)
  console.log(`  engagements founded:   ${stats.engagements_founded} (won: ${stats.engagements_closed_won}, stale-lost: ${stats.engagements_closed_lost_stale}, open: ${stats.engagements_open})`)
  console.log(`  stage changes:         ${JSON.stringify(stats.stage_changes)}`)
  if (stats.errors.length) console.log(`  ERRORS: ${stats.errors.length}`)
  out.locations[slug] = { name: locReport.name, ...stats }
  console.log('')
}

writeFileSync(outPath, JSON.stringify(out, null, 2))
console.log(`report written: ${outPath}`)
