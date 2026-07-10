// ═══════════════════════════════════════════════════════════════════════════
// Invoice-cap truncation — TARGETED BACKFILL
//
// Usage:
//   node scripts/backfill-truncated-invoices.mjs [envfile] [--report path] [--execute] [--out path]
//
// DRY-RUN BY DEFAULT — zero writes unless --execute is passed. Dry run
// projects entirely from the truncation-check report (no Jobber calls);
// --execute re-fetches each affected job's FULL invoice set live (paginated,
// post-42474fc drain) before writing.
//
// SCOPE: only the jobs the truncation check PROVED have invoices in Jobber
// that are missing from our DB (report.truncated[] from
// jobber-truncation-check.report.json). Nothing else is touched.
//
// Per affected job (mirrors the import route's invoice block exactly):
//   * each missing invoice writes through the idempotent
//     location_id+jobber_invoice_id upsert (byte-compatible payload with
//     lib/jobber-import.ts upsertInvoice, incl. paid_amount/balance_owing/
//     paid_at denorm for PAID)
//   * attaches to the job's engagement (engagement_id set only where null —
//     attachToEngagement's conflict guard)
//   * engagement money rollups re-derived from ALL linked invoices
//     (total_invoiced / total_paid / balance_owing — the patch
//     maybeAdvanceEngagementStage always writes); stage advances only if
//     rank-forward in backfill mode (an unfinished job pins Job in Progress,
//     so an open engagement can never be auto-closed here)
//   * lead roll-up mirrors the INVOICE_PAID denorm (paid_amount /
//     balance_owing / invoice_paid_at), forward-only on invoice_paid_at;
//     leads.stage is re-derived from the full bundle and written only on
//     change — deliberately no drips, no touchpoints, no pause changes
//
// Strictly additive + re-runnable: a re-run finds nothing missing and
// writes nothing.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs'

// ── args / env ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const reportIdx = args.indexOf('--report')
const outIdx = args.indexOf('--out')
const positional = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--report' && args[i - 1] !== '--out')
const envPath = positional[0] || '.env.local'
const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : 'jobber-truncation-check.report.json'
const outPath = outIdx >= 0
  ? args[outIdx + 1]
  : `backfill-truncated-invoices-report.${EXECUTE ? 'run' : 'dryrun'}.json`

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

const check = JSON.parse(readFileSync(reportPath, 'utf8'))
if (!Array.isArray(check.truncated)) { console.error(`no truncated[] in ${reportPath}`); process.exit(1) }

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

// ── Jobber helpers (ports of lib/jobber.ts, execute-mode only) ──────────────

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
    await sleep(Math.ceil(((estimatedCost - lastThrottle.currentlyAvailable) / lastThrottle.restoreRate + 0.5) * 1000))
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

const encodeJobberId = (type, numeric) =>
  Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')
const numericId = gid => {
  if (!gid) return null
  if (/^\d+$/.test(gid)) return gid
  try {
    const m = Buffer.from(gid, 'base64').toString('utf8').match(/\/(\d+)$/)
    return m ? m[1] : null
  } catch { return null }
}

// Full invoice shape matching lib/jobber-import.ts JOB_INVOICES_QUERY so the
// upsert payload is byte-compatible with the import's.
const JOB_INVOICES_QUERY = `
  query GetJobInvoices($id: EncodedId!, $after: String) {
    job(id: $id) {
      invoices(first: 50, after: $after) {
        nodes {
          id createdAt jobberWebUri invoiceStatus
          amounts { subtotal taxAmount discountAmount total }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

async function fetchAllJobInvoices(token, jobberJobId) {
  const gid = encodeJobberId('Job', jobberJobId)
  const all = []
  let after = null
  for (;;) {
    const res = await jobberQueryThrottled(token, JOB_INVOICES_QUERY, after ? { id: gid, after } : { id: gid })
    if (res.errors?.length) throw new Error(`job ${jobberJobId}: ${JSON.stringify(res.errors).slice(0, 300)}`)
    if (!res.data?.job) throw new Error(`job ${jobberJobId} not found in Jobber`)
    const conn = res.data.job.invoices
    all.push(...(conn?.nodes || []))
    if (!conn?.pageInfo?.hasNextPage) break
    after = conn.pageInfo.endCursor
  }
  return all
}

// ── ports of lib/jobber-import.ts / lib/engagements.ts pieces ───────────────

// Port of upsertInvoice's payload (idempotent location+jobber_invoice_id upsert).
function invoicePayload(inv, job) {
  const status = (inv.invoiceStatus || '').toUpperCase()
  const isPaid = status === 'PAID'
  const totalNum = inv.amounts?.total != null ? parseFloat(inv.amounts.total) : null
  return {
    job_id: job.id,
    service_request_id: job.service_request_id,
    lead_id: job.lead_id,
    location_id: job.location_id,
    jobber_invoice_id: numericId(inv.id),
    invoice_url: inv.jobberWebUri || null,
    status: isPaid ? 'paid'
          : status === 'PARTIAL' ? 'partial'
          : status === 'BAD_DEBT' ? 'bad_debt'
          : 'sent',
    subtotal:        inv.amounts?.subtotal       != null ? parseFloat(inv.amounts.subtotal)       : null,
    tax_amount:      inv.amounts?.taxAmount      != null ? parseFloat(inv.amounts.taxAmount)      : null,
    discount_amount: inv.amounts?.discountAmount != null ? parseFloat(inv.amounts.discountAmount) : null,
    total:           totalNum,
    paid_amount:   isPaid ? totalNum : null,
    balance_owing: isPaid ? 0 : totalNum,
    paid_at:       isPaid ? (inv.createdAt || null) : null,
    issued_at: inv.createdAt || null,
    created_at: inv.createdAt || nowIso(),
    jobber_synced_at: nowIso(),
    updated_at: nowIso(),
  }
}

// Port of deriveEngagementStage's job branch + maybeAdvanceEngagementStage's
// money patch. Only the pieces reachable for a job-founded engagement.
const ENGAGEMENT_STAGE_RANK = {
  Request: 1, Estimate: 2, 'Job in Progress': 3, 'Final Processing': 4,
  'Closed Won': 5, 'Closed Lost': 5,
}
const jobDone = j => !!j.completed_at ||
  ['completed', 'archived'].includes((j.status || '').toLowerCase())
const invoicePaid = i => (i.status || '').toLowerCase() === 'paid'

function deriveEngagementPatch(eng, jobs, invoices) {
  const num = v => (v == null ? 0 : Number(v) || 0)
  const patch = {
    total_invoiced: invoices.reduce((s, i) => s + num(i.total), 0),
    total_paid: invoices.reduce((s, i) => s + num(i.paid_amount), 0),
    balance_owing: invoices.reduce(
      (s, i) => s + (i.balance_owing != null ? num(i.balance_owing) : num(i.total) - num(i.paid_amount)), 0),
    updated_at: nowIso(),
  }
  let derivedStage = null
  if (jobs.length > 0) {
    if (jobs.some(j => !jobDone(j))) derivedStage = { stage: 'Job in Progress' }
    else if (invoices.length > 0 && invoices.every(invoicePaid)) {
      const lastPaidAt = Math.max(0, ...invoices.map(i => (i.paid_at ? new Date(i.paid_at).getTime() : 0)))
      derivedStage = { stage: 'Closed Won', closed_reason: 'won', closed_at: new Date(lastPaidAt || Date.now()).toISOString() }
    } else derivedStage = { stage: 'Final Processing' }
  }
  const currentRank = ENGAGEMENT_STAGE_RANK[eng.stage] ?? 0
  const newRank = derivedStage ? (ENGAGEMENT_STAGE_RANK[derivedStage.stage] ?? 0) : 0
  const staleLostOverride =
    derivedStage?.stage === 'Closed Won' &&
    eng.stage === 'Closed Lost' &&
    eng.closed_reason === 'stale_on_import'
  if (derivedStage && (newRank > currentRank || staleLostOverride)) {
    patch.stage = derivedStage.stage
    patch.stage_entered_at = nowIso()
    if (derivedStage.closed_reason) patch.closed_reason = derivedStage.closed_reason
    if (derivedStage.closed_at) patch.closed_at = derivedStage.closed_at
    if (staleLostOverride) patch.closed_note = null
  }
  return patch
}

// ── main ────────────────────────────────────────────────────────────────────

console.log(`${EXECUTE ? '── EXECUTE ──' : '── DRY RUN (zero writes) ──'}`)
console.log(`affected jobs from ${reportPath}: ${check.truncated.length}\n`)

const report = { mode: EXECUTE ? 'execute' : 'dry-run', jobs: [], totals: { invoices_written: 0, dollars: 0 }, errors: [] }
const tokenCache = new Map()

for (const t of check.truncated) {
  try {
    const job = one(await sb(`jobs?id=eq.${t.db_job_id}&select=id,jobber_job_id,lead_id,service_request_id,engagement_id,location_id,status,completed_at,title`))
    if (!job) throw new Error(`job row ${t.db_job_id} not found`)
    if (String(job.jobber_job_id) !== String(t.jobber_job_id)) {
      throw new Error(`jobber_job_id mismatch: row=${job.jobber_job_id} report=${t.jobber_job_id}`)
    }

    // The invoice set to write: live re-fetch on execute, report projection on dry-run.
    let jobberInvoices
    if (EXECUTE) {
      const loc = one(await sb(`locations?location_id=eq.${encodeURIComponent(job.location_id)}&select=id,location_id,jobber_access_token,jobber_refresh_token,token_expiry`))
      if (!tokenCache.has(loc.location_id)) tokenCache.set(loc.location_id, await getValidToken(loc))
      jobberInvoices = await fetchAllJobInvoices(tokenCache.get(loc.location_id), job.jobber_job_id)
    } else {
      // Dry-run: the check report's missing[] carries the minimal shape;
      // enough to project counts/$ (execute uses the full live shape).
      jobberInvoices = t.missing.map(m => ({
        id: m.jobber_invoice_id, createdAt: m.createdAt,
        invoiceStatus: m.status, amounts: { total: m.total },
      }))
    }

    // Missing = in Jobber, absent from this location's invoices.
    const existing = await sb(`invoices?location_id=eq.${encodeURIComponent(job.location_id)}&select=jobber_invoice_id`)
    const haveIds = new Set(existing.map(r => String(r.jobber_invoice_id)))
    const missing = jobberInvoices.filter(i => !haveIds.has(String(numericId(i.id))))

    const jobReport = {
      db_job_id: job.id, jobber_job_id: job.jobber_job_id, location: job.location_id,
      title: job.title, engagement_id: job.engagement_id, lead_id: job.lead_id,
      invoices_to_write: missing.length,
      dollars: missing.reduce((s, i) => s + (parseFloat(i.amounts?.total) || 0), 0),
      written: [], engagement_patch: null, lead_patch: null, lead_stage: 'unchanged',
    }

    // 1. invoice upserts + engagement attach
    for (const inv of missing.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
      const payload = invoicePayload(inv, job)
      jobReport.written.push({ jobber_invoice_id: payload.jobber_invoice_id, status: payload.status, total: payload.total, issued_at: payload.issued_at })
      if (EXECUTE) {
        await sb('invoices?on_conflict=location_id,jobber_invoice_id', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        })
        if (job.engagement_id) {
          // attachToEngagement semantics: set only where currently null.
          await sb(`invoices?location_id=eq.${encodeURIComponent(job.location_id)}&jobber_invoice_id=eq.${payload.jobber_invoice_id}&engagement_id=is.null`, {
            method: 'PATCH',
            body: JSON.stringify({ engagement_id: job.engagement_id }),
            headers: { Prefer: 'return=minimal' },
          })
        }
      }
    }

    // 2. engagement money rollups + forward-only stage (maybeAdvanceEngagementStage port)
    if (job.engagement_id) {
      const eng = one(await sb(`engagements?id=eq.${job.engagement_id}&select=id,stage,closed_reason,total_invoiced,total_paid,balance_owing`))
      const engJobs = await sb(`jobs?engagement_id=eq.${job.engagement_id}&select=status,completed_at`)
      let engInvoices = await sb(`invoices?engagement_id=eq.${job.engagement_id}&select=status,total,paid_amount,balance_owing,paid_at`)
      if (!EXECUTE) {
        // Dry-run: project the post-write linked set.
        engInvoices = engInvoices.concat(missing.map(i => {
          const p = invoicePayload(i, job)
          return { status: p.status, total: p.total, paid_amount: p.paid_amount, balance_owing: p.balance_owing, paid_at: p.paid_at }
        }))
      }
      const patch = deriveEngagementPatch(eng, engJobs, engInvoices)
      jobReport.engagement_patch = {
        before: { stage: eng.stage, total_invoiced: eng.total_invoiced, total_paid: eng.total_paid, balance_owing: eng.balance_owing },
        after: { stage: patch.stage || eng.stage, total_invoiced: patch.total_invoiced, total_paid: patch.total_paid, balance_owing: patch.balance_owing },
      }
      if (EXECUTE) {
        await sb(`engagements?id=eq.${job.engagement_id}`, {
          method: 'PATCH', body: JSON.stringify(patch), headers: { Prefer: 'return=minimal' },
        })
      }
    }

    // 3. lead roll-up — INVOICE_PAID denorm mirror, forward-only on invoice_paid_at
    const lead = one(await sb(`leads?id=eq.${job.lead_id}&select=id,stage,paid_amount,balance_owing,invoice_paid_at`))
    const paidMissing = missing
      .filter(i => (i.invoiceStatus || '').toUpperCase() === 'PAID')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    const newest = paidMissing[paidMissing.length - 1]
    if (newest && (!lead.invoice_paid_at || new Date(newest.createdAt) > new Date(lead.invoice_paid_at))) {
      const leadPatch = {
        paid_amount: parseFloat(newest.amounts?.total) || null,
        balance_owing: 0,
        invoice_paid_at: newest.createdAt,
        updated_at: nowIso(),
      }
      jobReport.lead_patch = {
        before: { paid_amount: lead.paid_amount, balance_owing: lead.balance_owing, invoice_paid_at: lead.invoice_paid_at },
        after: { paid_amount: leadPatch.paid_amount, balance_owing: leadPatch.balance_owing, invoice_paid_at: leadPatch.invoice_paid_at },
      }
      if (EXECUTE) {
        await sb(`leads?id=eq.${job.lead_id}`, {
          method: 'PATCH', body: JSON.stringify(leadPatch), headers: { Prefer: 'return=minimal' },
        })
      }
    }
    // leads.stage: an unfinished job pins 'Job in Progress' in determineLeadStage,
    // and paid invoices never move stage on this path (import-parity: the bulk
    // import's roll-up deliberately does not promote). Left untouched.

    report.jobs.push(jobReport)
    report.totals.invoices_written += jobReport.invoices_to_write
    report.totals.dollars += jobReport.dollars
    console.log(`${job.location_id} job ${job.jobber_job_id} "${job.title}": ${jobReport.invoices_to_write} invoices, $${jobReport.dollars.toFixed(2)}`)
    if (jobReport.engagement_patch) {
      const { before, after } = jobReport.engagement_patch
      console.log(`  engagement: stage ${before.stage} → ${after.stage}; invoiced $${before.total_invoiced ?? 0} → $${after.total_invoiced.toFixed(2)}; paid $${before.total_paid ?? 0} → $${after.total_paid.toFixed(2)}`)
    }
    if (jobReport.lead_patch) {
      const { before, after } = jobReport.lead_patch
      console.log(`  lead: paid_amount ${before.paid_amount} → ${after.paid_amount}; invoice_paid_at ${before.invoice_paid_at} → ${after.invoice_paid_at}`)
    }
  } catch (err) {
    report.errors.push({ job: t.db_job_id, error: String(err?.message || err) })
    console.error(`ERROR ${t.db_job_id}: ${err?.message || err}`)
  }
}

console.log(`\nTOTAL: ${report.totals.invoices_written} invoices, $${report.totals.dollars.toFixed(2)} across ${report.jobs.length} jobs (${report.errors.length} errors)`)
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`report → ${outPath}`)
