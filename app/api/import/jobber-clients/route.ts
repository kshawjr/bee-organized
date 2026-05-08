// app/api/import/jobber-clients/route.ts
// Separate flat queries per entity — avoids Jobber complexity limits
// clients → requests → assessments → quotes → jobs → invoices

import { NextRequest, NextResponse } from 'next/server'
import { getValidJobberToken, jobberQuery } from '@/lib/jobber'
import { getZohoLocation, getZohoToken } from '@/lib/zoho'
import { supabaseService } from '@/lib/supabase-service'
import { writeSyncLog } from '@/lib/sync-log'

// ── Flat queries — no nesting beyond one level ────────────────

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

async function fetchAll(token: string, query: string, key: string, devMode = false, limitToClients = false): Promise<any[]> {
  const all: any[] = []
  let cursor:  string | null = null
  let hasMore: boolean       = true
  let pages:   number        = 0

  while (hasMore) {
    const res = await jobberQuery(token, query, cursor ? { after: cursor } : {})
    if (res.errors) throw new Error(`${key} error: ${JSON.stringify(res.errors)}`)
    const page = res.data?.[key]
    if (!page) break
    all.push(...page.nodes)
    hasMore = page.pageInfo.hasNextPage
    cursor  = page.pageInfo.endCursor
    pages++
    if (devMode && limitToClients && pages >= 1) break
    if (hasMore) await new Promise(r => setTimeout(r, 400))
  }
  return all
}

export async function POST(req: NextRequest) {
  try {
    const { location_id, mode = 'full' } = await req.json()
    if (!location_id) return NextResponse.json({ error: 'location_id required' }, { status: 400 })

    const location = await getZohoLocation(location_id)
    if (!location) return NextResponse.json({ error: `Location ${location_id} not found` }, { status: 404 })
    if (!location.Jobber_Access_Token) return NextResponse.json({ error: 'Location not connected to Jobber' }, { status: 400 })

    const zohoToken   = await getZohoToken()
    const jobberToken = await getValidJobberToken(location, zohoToken)
    const devMode     = mode === 'dev'

    // Fetch all entities with delay between queries
    const clients  = await fetchAll(jobberToken, CLIENTS_QUERY,  'clients',  devMode, true)
    await new Promise(r => setTimeout(r, 800))
    const requests = await fetchAll(jobberToken, REQUESTS_QUERY, 'requests', false)
    await new Promise(r => setTimeout(r, 800))
    const quotes   = await fetchAll(jobberToken, QUOTES_QUERY,   'quotes',   false)
    await new Promise(r => setTimeout(r, 800))
    const jobs     = await fetchAll(jobberToken, JOBS_QUERY,     'jobs',     false)
    // Build lookup maps
    const clientIds    = new Set(clients.map((c: any) => c.id))
    const reqByClient: Record<string, any[]> = {}
    const quotesByReq: Record<string, any[]> = {}
    const jobsByReq:   Record<string, any[]> = {}
    for (const r of requests) {
      const cid = r.client?.id
      if (cid && clientIds.has(cid)) {
        if (!reqByClient[cid]) reqByClient[cid] = []
        reqByClient[cid].push(r)
      }
    }

    const reqIds = new Set(requests.map((r: any) => r.id))
    for (const q of quotes) {
      const rid = q.request?.id
      if (rid && reqIds.has(rid)) {
        if (!quotesByReq[rid]) quotesByReq[rid] = []
        quotesByReq[rid].push(q)
      }
    }
    for (const j of jobs) {
      const rid = j.request?.id
      if (rid && reqIds.has(rid)) {
        if (!jobsByReq[rid]) jobsByReq[rid] = []
        jobsByReq[rid].push(j)
      }
    }
    const stats = {
      leads_created: 0, leads_updated: 0,
      requests_created: 0, requests_updated: 0,
      assessments_created: 0, assessments_updated: 0,
      quotes_created: 0, quotes_updated: 0,
      jobs_created: 0, jobs_updated: 0,
      invoices_created: 0, invoices_updated: 0,
      errors: [] as string[],
    }

    for (const client of clients) {
      try {
        const { id: leadId, created } = await upsertLead(client, location_id)
        created ? stats.leads_created++ : stats.leads_updated++

        for (const request of (reqByClient[client.id] || [])) {
          const reqResult = await upsertServiceRequest(request, leadId, location_id)
          reqResult.created ? stats.requests_created++ : stats.requests_updated++
          const reqDbId = reqResult.id

          if (request.assessment?.startAt) {
            const aRes = await upsertAssessment(request, reqDbId, leadId, location_id)
            aRes.created ? stats.assessments_created++ : stats.assessments_updated++
          }

          for (const quote of (quotesByReq[request.id] || [])) {
            const qRes = await upsertQuote(quote, reqDbId, leadId, location_id)
            qRes.created ? stats.quotes_created++ : stats.quotes_updated++
          }

          for (const job of (jobsByReq[request.id] || [])) {
            const jRes = await upsertJob(job, reqDbId, leadId, location_id)
            jRes.created ? stats.jobs_created++ : stats.jobs_updated++

            // Invoices nested inside jobs
            for (const inv of (job.invoices?.nodes || [])) {
              const iRes = await upsertInvoice(inv, jRes.id, reqDbId, leadId, location_id)
              iRes.created ? stats.invoices_created++ : stats.invoices_updated++
            }
          }
        }
      } catch (err: any) {
        stats.errors.push(`${client.firstName} ${client.lastName}: ${err.message}`)
      }
    }

    await writeSyncLog({
      location_id, entity_id: location_id,
      status: stats.errors.length > 0 ? 'error' : 'success',
      message: `Leads:${stats.leads_created}+${stats.leads_updated} Requests:${stats.requests_created}+${stats.requests_updated} Jobs:${stats.jobs_created}+${stats.jobs_updated} Invoices:${stats.invoices_created}+${stats.invoices_updated} Errors:${stats.errors.length}`,
    })

    return NextResponse.json({ success: true, location: location.Name, mode,
      total_clients: clients.length, total_requests: requests.length,
      total_quotes: quotes.length, total_jobs: jobs.length,
      ...stats })
  } catch (err: any) {
    console.error('[jobber-import]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function upsertLead(client: any, location_id: string) {
  const email = client.emails?.find((e: any) => e.primary)?.address ?? client.emails?.[0]?.address ?? null
  const phone = client.phones?.find((p: any) => p.primary)?.number  ?? client.phones?.[0]?.number  ?? null
  const addr  = client.billingAddress
    ? [client.billingAddress.street, client.billingAddress.city, client.billingAddress.province, client.billingAddress.postalCode].filter(Boolean).join(', ')
    : null
  const payload = {
    location_id, jobber_client_id: client.id,
    name: `${client.firstName||''} ${client.lastName||''}`.trim() || client.companyName || 'Unknown',
    first_name: client.firstName||null, last_name: client.lastName||null,
    company: client.companyName||null, email, phone, address: addr,
    city: client.billingAddress?.city||null, state: client.billingAddress?.province||null,
    zip: client.billingAddress?.postalCode||null,
    jobber_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService.from('leads').select('id')
    .eq('jobber_client_id', client.id).eq('location_id', location_id).maybeSingle()
  if (existing) { await supabaseService.from('leads').update(payload).eq('id', existing.id); return { id: existing.id, created: false } }
  const { data, error } = await supabaseService.from('leads').insert({ ...payload, created_at: client.createdAt||new Date().toISOString() }).select('id').single()
  if (error) throw new Error(error.message)
  return { id: data.id, created: true }
}

async function upsertServiceRequest(request: any, lead_id: string, location_id: string) {
  const payload = {
    lead_id, location_id, jobber_request_id: request.id, request_url: request.jobberWebUri||null,
    stage: determineStage(request), status: 'active', source: 'jobber',
    jobber_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService.from('service_requests').select('id').eq('jobber_request_id', request.id).maybeSingle()
  if (existing) { await supabaseService.from('service_requests').update(payload).eq('id', existing.id); return { id: existing.id, created: false } }
  const { data, error } = await supabaseService.from('service_requests').insert({ ...payload, created_at: request.createdAt||new Date().toISOString() }).select('id').single()
  if (error) throw new Error(error.message)
  return { id: data.id, created: true }
}

function determineStage(request: any): string {
  if (request._hasInvoice)    return 'Final Processing'
  if (request._hasJob)        return 'Job in Progress'
  if (request._hasQuote)      return 'Estimate Sent'
  if (request.assessment)     return 'Assessment Scheduled'
  return 'New Request'
}

async function upsertAssessment(request: any, service_request_id: string, lead_id: string, location_id: string) {
  const payload = {
    service_request_id, lead_id, location_id,
    jobber_request_id: request.id, scheduled_at: request.assessment.startAt||null,
    status: 'scheduled', source: 'jobber',
    jobber_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService.from('assessments').select('id').eq('service_request_id', service_request_id).maybeSingle()
  if (existing) { await supabaseService.from('assessments').update(payload).eq('id', existing.id); return { id: existing.id, created: false } }
  const { data, error } = await supabaseService.from('assessments').insert({ ...payload, created_at: request.assessment.startAt||new Date().toISOString() }).select('id').single()
  if (error) throw new Error(`Assessment: ${error.message}`)
  return { id: data.id, created: true }
}

async function upsertQuote(quote: any, service_request_id: string, lead_id: string, location_id: string) {
  const payload = {
    service_request_id, lead_id, location_id,
    jobber_quote_id: quote.id, quote_url: quote.jobberWebUri||null, status: 'sent',
    subtotal:        quote.amounts?.subtotal      ? parseFloat(quote.amounts.subtotal)       : null,
    tax_amount:      quote.amounts?.taxAmount     ? parseFloat(quote.amounts.taxAmount)      : null,
    discount_amount: quote.amounts?.discountAmount ? parseFloat(quote.amounts.discountAmount) : null,
    total:           quote.amounts?.total         ? parseFloat(quote.amounts.total)          : null,
    sent_at:         quote.createdAt||null,
    jobber_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService.from('quotes').select('id').eq('jobber_quote_id', quote.id).maybeSingle()
  if (existing) { await supabaseService.from('quotes').update(payload).eq('id', existing.id); return { id: existing.id, created: false } }
  const { data, error } = await supabaseService.from('quotes').insert({ ...payload, created_at: quote.createdAt||new Date().toISOString() }).select('id').single()
  if (error) throw new Error(`Quote: ${error.message}`)
  return { id: data.id, created: true }
}

async function upsertJob(job: any, service_request_id: string, lead_id: string, location_id: string) {
  const payload = {
    service_request_id, lead_id, location_id,
    jobber_job_id: job.id, job_url: job.jobberWebUri||null, title: job.title||null,
    status: JOB_STATUS[job.jobStatus?.toUpperCase()] ?? 'unknown',
    scheduled_start: job.startAt||null, completed_at: job.completedAt||null,
    total: job.total ? parseFloat(job.total) : null,
    jobber_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService.from('jobs').select('id').eq('jobber_job_id', job.id).maybeSingle()
  if (existing) { await supabaseService.from('jobs').update(payload).eq('id', existing.id); return { id: existing.id, created: false } }
  const { data, error } = await supabaseService.from('jobs').insert({ ...payload, created_at: job.createdAt||new Date().toISOString() }).select('id').single()
  if (error) throw new Error(`Job: ${error.message}`)
  return { id: data.id, created: true }
}

async function upsertInvoice(invoice: any, job_id: string, service_request_id: string, lead_id: string, location_id: string) {
  const payload = {
    job_id, service_request_id, lead_id, location_id,
    jobber_invoice_id: invoice.id, invoice_url: invoice.jobberWebUri||null,
    status: 'sent',
    subtotal:        invoice.amounts?.subtotal       ? parseFloat(invoice.amounts.subtotal)        : null,
    tax_amount:      invoice.amounts?.taxAmount      ? parseFloat(invoice.amounts.taxAmount)       : null,
    discount_amount: invoice.amounts?.discountAmount ? parseFloat(invoice.amounts.discountAmount)  : null,
    total:           invoice.amounts?.total          ? parseFloat(invoice.amounts.total)           : null,
    issued_at:       invoice.createdAt||null,
    jobber_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseService.from('invoices').select('id').eq('jobber_invoice_id', invoice.id).maybeSingle()
  if (existing) { await supabaseService.from('invoices').update(payload).eq('id', existing.id); return { id: existing.id, created: false } }
  const { data, error } = await supabaseService.from('invoices').insert({ ...payload, created_at: invoice.createdAt||new Date().toISOString() }).select('id').single()
  if (error) throw new Error(`Invoice: ${error.message}`)
  return { id: data.id, created: true }
}