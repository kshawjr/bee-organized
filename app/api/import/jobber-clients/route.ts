// app/api/import/jobber-clients/route.ts
//
// POST endpoint to import a location's Jobber data into Supabase.
// Flat per-entity GraphQL queries (avoids Jobber complexity limits), joined
// in-memory, then upserted via service-role writes.
// Order: clients → requests → assessments → quotes → jobs → invoices
//
// Accepts location_id via query string or JSON body (query wins).
// Flex lookup: UUID → locations.id; otherwise → locations.location_id (slug).
// All child writes use the slug for consistency with hub_users.location_id
// and the rest of the codebase.
//
// Stage classification (see determineStage):
//   Final Processing → Job in Progress → Estimate Sent → Assessment Scheduled
//   → Nurturing (no downstream activity AND createdAt > 30 days ago)
//   → New Request (default)
// The Nurturing bucket exists because the franchise historically used Jobber
// as a parking lot for stale leads — old untouched requests should not show
// up as "fresh and actionable" New Request rows.
//
// KNOWN: leads/assessments/payments/notes lack UNIQUE on jobber_*_id.
// Re-running this import concurrently could create dup rows in those tables.
// Hardening pass: add UNIQUE constraints + switch to ON CONFLICT upserts.

import { NextRequest, NextResponse } from 'next/server'
import { getValidJobberToken, jobberQuery } from '@/lib/jobber'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { canRunImport } from '@/lib/auth'
import { writeSyncLog } from '@/lib/sync-log'

export const runtime = 'nodejs'
export const maxDuration = 300

// ── flat queries ──────────────────────────────────────────────

const CLIENTS_QUERY = `
  query GetClients($after: String) {
    clients(first: 50, after: $after) {
      nodes {
        id firstName lastName companyName createdAt
        emails { address primary }
        phones  { number  primary }
        billingAddress { street city province postalCode }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const REQUESTS_QUERY = `
  query GetRequests($after: String) {
    requests(first: 50, after: $after) {
      nodes {
        id createdAt jobberWebUri
        client { id }
        assessment { startAt }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const QUOTES_QUERY = `
  query GetQuotes($after: String) {
    quotes(first: 50, after: $after) {
      nodes {
        id createdAt jobberWebUri
        request { id }
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
        invoices(first: 10) {
          nodes {
            id createdAt jobberWebUri
            amounts { subtotal taxAmount discountAmount total }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const JOB_STATUS: Record<string, string> = {
  ACTIVE: 'in_progress', COMPLETED: 'completed',
  REQUIRES_INVOICING: 'completed', LATE: 'late',
  TODAY: 'today', UPCOMING: 'upcoming', ARCHIVED: 'archived',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NURTURING_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

// ── helpers ───────────────────────────────────────────────────

async function lookupLocation(input: string) {
  const field = UUID_RE.test(input) ? 'id' : 'location_id'
  const { data, error } = await supabaseService
    .from('locations')
    .select('*')
    .eq(field, input)
    .maybeSingle()
  if (error) throw new Error(`Location lookup failed: ${error.message}`)
  return data
}

async function updateProgress(jobId: string, fields: Record<string, any>) {
  try {
    await supabaseService.from('import_jobs').update(fields).eq('id', jobId)
  } catch (err) {
    console.error('[import_jobs progress write failed]', err)
  }
}

async function fetchAll(
  token: string,
  query: string,
  key: string,
  devMode = false,
  limitToFirstPage = false,
): Promise<any[]> {
  const all: any[] = []
  let cursor: string | null = null
  let hasMore = true
  let pages = 0

  while (hasMore) {
    const res = await jobberQuery(token, query, cursor ? { after: cursor } : {})
    if (res.errors) throw new Error(`${key} error: ${JSON.stringify(res.errors)}`)
    const page = res.data?.[key]
    if (!page) break
    all.push(...page.nodes)
    hasMore = page.pageInfo.hasNextPage
    cursor = page.pageInfo.endCursor
    pages++
    if (devMode && limitToFirstPage && pages >= 1) break
    if (hasMore) await new Promise(r => setTimeout(r, 400))
  }
  return all
}

function determineStage(request: any): string {
  if (request._hasInvoice)    return 'Final Processing'
  if (request._hasJob)        return 'Job in Progress'
  if (request._hasQuote)      return 'Estimate Sent'
  if (request._hasAssessment) return 'Assessment Scheduled'
  // No downstream activity. If the request was created > 30 days ago it's
  // a stale parked lead, not a fresh actionable request.
  if (request.createdAt) {
    const ageMs = Date.now() - new Date(request.createdAt).getTime()
    if (ageMs > NURTURING_AGE_MS) return 'Nurturing'
  }
  return 'New Request'
}

// ── handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ─── auth ──
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('*')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_profile' }, { status: 403 })

  if (!canRunImport(hubUser.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // ─── input (query param wins, fall back to JSON body) ──
  const url = new URL(req.url)
  const queryLocId = url.searchParams.get('location_id')
  const queryMode  = url.searchParams.get('mode')

  let body: any = {}
  try { body = await req.json() } catch { /* no body is fine */ }

  const input = queryLocId || body.location_id
  const mode  = (queryMode || body.mode || 'full') as 'full' | 'dev'
  if (!input) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }

  // ─── location lookup (flex: UUID or slug) ──
  const location = await lookupLocation(input)
  if (!location) {
    return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  }

  // Owner can only import their own location. super_admin can import any.
  // hub_users.location_id stores the UUID, matching locations.id.
  if (hubUser.role === 'owner' && hubUser.location_id !== location.id) {
    return NextResponse.json({ error: 'forbidden_location' }, { status: 403 })
  }

  if (!location.jobber_access_token) {
    return NextResponse.json(
      { error: 'location_not_connected_to_jobber' },
      { status: 400 },
    )
  }

  const locSlug: string = location.location_id

  // ─── create import_jobs row ──
  const { data: importJob, error: jobErr } = await supabaseService
    .from('import_jobs')
    .insert({
      location_id: locSlug,
      type: 'jobber_clients',
      status: 'running',
      phase: 'starting',
      total_records: 0,
      processed_records: 0,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (jobErr || !importJob) {
    return NextResponse.json(
      { error: 'failed_to_create_import_job', detail: jobErr?.message },
      { status: 500 },
    )
  }

  try {
    const jobberToken = await getValidJobberToken(location)
    const devMode = mode === 'dev'

    // ─── fetch all entities (flat queries with pacing) ──
    await updateProgress(importJob.id, { phase: 'clients' })
    const clients = await fetchAll(jobberToken, CLIENTS_QUERY, 'clients', devMode, true)
    await new Promise(r => setTimeout(r, 800))

    await updateProgress(importJob.id, {
      phase: 'requests',
      total_records: clients.length,
    })
    const requests = await fetchAll(jobberToken, REQUESTS_QUERY, 'requests', false)
    await new Promise(r => setTimeout(r, 800))

    await updateProgress(importJob.id, { phase: 'quotes' })
    const quotes = await fetchAll(jobberToken, QUOTES_QUERY, 'quotes', false)
    await new Promise(r => setTimeout(r, 800))

    await updateProgress(importJob.id, { phase: 'jobs' })
    const jobs = await fetchAll(jobberToken, JOBS_QUERY, 'jobs', false)

    // ─── build lookup maps ──
    const clientIds = new Set(clients.map((c: any) => c.id))
    const reqByClient: Record<string, any[]> = {}
    const quotesByReq: Record<string, any[]> = {}
    const jobsByReq:   Record<string, any[]> = {}

    for (const r of requests) {
      const cid = r.client?.id
      if (cid && clientIds.has(cid)) (reqByClient[cid] ||= []).push(r)
    }
    const reqIds = new Set(requests.map((r: any) => r.id))
    for (const q of quotes) {
      const rid = q.request?.id
      if (rid && reqIds.has(rid)) (quotesByReq[rid] ||= []).push(q)
    }
    for (const j of jobs) {
      const rid = j.request?.id
      if (rid && reqIds.has(rid)) (jobsByReq[rid] ||= []).push(j)
    }

    // ─── set _has* flags so determineStage works on flat queries ──
    for (const r of requests) {
      const reqJobs = jobsByReq[r.id] || []
      r._hasQuote      = (quotesByReq[r.id] || []).length > 0
      r._hasJob        = reqJobs.length > 0
      r._hasInvoice    = reqJobs.some((j: any) => (j.invoices?.nodes || []).length > 0)
      r._hasAssessment = !!r.assessment
    }

    // ─── upsert phase ──
    await updateProgress(importJob.id, {
      phase: 'writing',
      total_records: clients.length,
    })

    const stats = {
      leads_created: 0, leads_updated: 0,
      requests_created: 0, requests_updated: 0,
      assessments_created: 0, assessments_updated: 0,
      quotes_created: 0, quotes_updated: 0,
      jobs_created: 0, jobs_updated: 0,
      invoices_created: 0, invoices_updated: 0,
      errors: [] as string[],
    }

    let processed = 0
    for (const client of clients) {
      try {
        const { id: leadId, created } = await upsertLead(client, locSlug)
        created ? stats.leads_created++ : stats.leads_updated++

        for (const request of (reqByClient[client.id] || [])) {
          const reqResult = await upsertServiceRequest(request, leadId, locSlug)
          reqResult.created ? stats.requests_created++ : stats.requests_updated++
          const reqDbId = reqResult.id

          if (request.assessment?.startAt) {
            const aRes = await upsertAssessment(request, reqDbId, leadId, locSlug)
            aRes.created ? stats.assessments_created++ : stats.assessments_updated++
          }

          for (const quote of (quotesByReq[request.id] || [])) {
            const qRes = await upsertQuote(quote, reqDbId, leadId, locSlug)
            qRes.created ? stats.quotes_created++ : stats.quotes_updated++
          }

          for (const job of (jobsByReq[request.id] || [])) {
            const jRes = await upsertJob(job, reqDbId, leadId, locSlug)
            jRes.created ? stats.jobs_created++ : stats.jobs_updated++

            for (const inv of (job.invoices?.nodes || [])) {
              const iRes = await upsertInvoice(inv, jRes.id, reqDbId, leadId, locSlug)
              iRes.created ? stats.invoices_created++ : stats.invoices_updated++
            }
          }
        }
      } catch (err: any) {
        stats.errors.push(`${client.firstName} ${client.lastName}: ${err.message}`)
      }
      processed++
      if (processed % 5 === 0 || processed === clients.length) {
        await updateProgress(importJob.id, { processed_records: processed })
      }
    }

    await writeSyncLog({
      location_id: locSlug,
      entity_id: locSlug,
      status: stats.errors.length > 0 ? 'error' : 'success',
      message:
        `Leads: ${stats.leads_created} created, ${stats.leads_updated} updated; ` +
        `Requests: ${stats.requests_created} created, ${stats.requests_updated} updated; ` +
        `Jobs: ${stats.jobs_created} created, ${stats.jobs_updated} updated; ` +
        `Invoices: ${stats.invoices_created} created, ${stats.invoices_updated} updated; ` +
        `Errors: ${stats.errors.length}`,
    })

    await updateProgress(importJob.id, {
      status: 'completed',
      phase: 'done',
      processed_records: clients.length,
      completed_at: new Date().toISOString(),
      ...(stats.errors.length > 0
        ? { error_message: stats.errors.slice(0, 5).join(' | ') }
        : {}),
    })

    return NextResponse.json({
      success: true,
      job_id: importJob.id,
      location: location.name,
      location_slug: locSlug,
      mode,
      total_clients: clients.length,
      total_requests: requests.length,
      total_quotes: quotes.length,
      total_jobs: jobs.length,
      ...stats,
    })
  } catch (err: any) {
    console.error('[jobber-clients-import]', err)
    await updateProgress(importJob.id, {
      status: 'failed',
      error_message: String(err?.message || err),
      completed_at: new Date().toISOString(),
    })
    return NextResponse.json(
      { error: err.message, job_id: importJob.id },
      { status: 500 },
    )
  }
}

// ── upserts ───────────────────────────────────────────────────

async function upsertLead(client: any, location_id: string) {
  const email = client.emails?.find((e: any) => e.primary)?.address ?? client.emails?.[0]?.address ?? null
  const phone = client.phones?.find((p: any) => p.primary)?.number  ?? client.phones?.[0]?.number  ?? null
  const addr  = client.billingAddress
    ? [
        client.billingAddress.street,
        client.billingAddress.city,
        client.billingAddress.province,
        client.billingAddress.postalCode,
      ].filter(Boolean).join(', ')
    : null

  const payload = {
    location_id,
    jobber_client_id: client.id,
    name: `${client.firstName || ''} ${client.lastName || ''}`.trim() || client.companyName || 'Unknown',
    first_name: client.firstName || null,
    last_name:  client.lastName  || null,
    company:    client.companyName || null,
    email, phone, address: addr,
    city:  client.billingAddress?.city       || null,
    state: client.billingAddress?.province   || null,
    zip:   client.billingAddress?.postalCode || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  const { data: existing } = await supabaseService
    .from('leads')
    .select('id')
    .eq('jobber_client_id', client.id)
    .eq('location_id', location_id)
    .maybeSingle()

  if (existing) {
    await supabaseService.from('leads').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService
    .from('leads')
    .insert({ ...payload, created_at: client.createdAt || new Date().toISOString() })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return { id: data.id, created: true }
}

async function upsertServiceRequest(request: any, lead_id: string, location_id: string) {
  const payload = {
    lead_id, location_id,
    jobber_request_id: request.id,
    request_url: request.jobberWebUri || null,
    stage: determineStage(request),
    status: 'active',
    source: 'jobber',
    requested_at: request.createdAt || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService
    .from('service_requests')
    .select('id')
    .eq('jobber_request_id', request.id)
    .maybeSingle()
  if (existing) {
    await supabaseService.from('service_requests').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService
    .from('service_requests')
    .insert({ ...payload, created_at: request.createdAt || new Date().toISOString() })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return { id: data.id, created: true }
}

async function upsertAssessment(
  request: any,
  service_request_id: string,
  lead_id: string,
  location_id: string,
) {
  const payload = {
    service_request_id, lead_id, location_id,
    jobber_request_id: request.id,
    scheduled_at: request.assessment.startAt || null,
    status: 'scheduled',
    source: 'jobber',
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService
    .from('assessments')
    .select('id')
    .eq('service_request_id', service_request_id)
    .maybeSingle()
  if (existing) {
    await supabaseService.from('assessments').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService
    .from('assessments')
    .insert({
      ...payload,
      created_at: request.assessment.startAt || new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) throw new Error(`Assessment: ${error.message}`)
  return { id: data.id, created: true }
}

async function upsertQuote(
  quote: any,
  service_request_id: string,
  lead_id: string,
  location_id: string,
) {
  const payload = {
    service_request_id, lead_id, location_id,
    jobber_quote_id: quote.id,
    quote_url: quote.jobberWebUri || null,
    status: 'sent',
    subtotal:        quote.amounts?.subtotal       ? parseFloat(quote.amounts.subtotal)       : null,
    tax_amount:      quote.amounts?.taxAmount      ? parseFloat(quote.amounts.taxAmount)      : null,
    discount_amount: quote.amounts?.discountAmount ? parseFloat(quote.amounts.discountAmount) : null,
    total:           quote.amounts?.total          ? parseFloat(quote.amounts.total)          : null,
    sent_at: quote.createdAt || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService
    .from('quotes')
    .select('id')
    .eq('jobber_quote_id', quote.id)
    .maybeSingle()
  if (existing) {
    await supabaseService.from('quotes').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService
    .from('quotes')
    .insert({ ...payload, created_at: quote.createdAt || new Date().toISOString() })
    .select('id')
    .single()
  if (error) throw new Error(`Quote: ${error.message}`)
  return { id: data.id, created: true }
}

async function upsertJob(
  job: any,
  service_request_id: string,
  lead_id: string,
  location_id: string,
) {
  const payload = {
    service_request_id, lead_id, location_id,
    jobber_job_id: job.id,
    job_url: job.jobberWebUri || null,
    title: job.title || null,
    status: JOB_STATUS[job.jobStatus?.toUpperCase()] ?? 'unknown',
    scheduled_start: job.startAt || null,
    completed_at:    job.completedAt || null,
    total: job.total ? parseFloat(job.total) : null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService
    .from('jobs')
    .select('id')
    .eq('jobber_job_id', job.id)
    .maybeSingle()
  if (existing) {
    await supabaseService.from('jobs').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService
    .from('jobs')
    .insert({ ...payload, created_at: job.createdAt || new Date().toISOString() })
    .select('id')
    .single()
  if (error) throw new Error(`Job: ${error.message}`)
  return { id: data.id, created: true }
}

async function upsertInvoice(
  invoice: any,
  job_id: string,
  service_request_id: string,
  lead_id: string,
  location_id: string,
) {
  const payload = {
    job_id, service_request_id, lead_id, location_id,
    jobber_invoice_id: invoice.id,
    invoice_url: invoice.jobberWebUri || null,
    status: 'sent',
    subtotal:        invoice.amounts?.subtotal       ? parseFloat(invoice.amounts.subtotal)       : null,
    tax_amount:      invoice.amounts?.taxAmount      ? parseFloat(invoice.amounts.taxAmount)      : null,
    discount_amount: invoice.amounts?.discountAmount ? parseFloat(invoice.amounts.discountAmount) : null,
    total:           invoice.amounts?.total          ? parseFloat(invoice.amounts.total)          : null,
    issued_at: invoice.createdAt || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService
    .from('invoices')
    .select('id')
    .eq('jobber_invoice_id', invoice.id)
    .maybeSingle()
  if (existing) {
    await supabaseService.from('invoices').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService
    .from('invoices')
    .insert({ ...payload, created_at: invoice.createdAt || new Date().toISOString() })
    .select('id')
    .single()
  if (error) throw new Error(`Invoice: ${error.message}`)
  return { id: data.id, created: true }
}
