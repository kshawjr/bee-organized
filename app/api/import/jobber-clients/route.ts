// app/api/import/jobber-clients/route.ts
// Stage 1: leads + service_requests

import { NextRequest, NextResponse } from 'next/server'
import { getValidJobberToken, jobberQuery } from '@/lib/jobber'
import { getZohoLocation, getZohoToken } from '@/lib/zoho'
import { supabaseService } from '@/lib/supabase-service'
import { writeSyncLog } from '@/lib/sync-log'

const CLIENTS_QUERY = `
  query GetClients($after: String) {
    clients(first: 50, after: $after) {
      nodes {
        id
        firstName
        lastName
        companyName
        emails { address primary }
        phones  { number  primary }
        billingAddress { street city province postalCode }
        createdAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const REQUESTS_QUERY = `
  query GetRequests($after: String) {
    requests(first: 50, after: $after) {
      nodes {
        id
        createdAt
        jobberWebUri
        client { id }
        assessment { startAt }
        quotes(first: 5) {
          nodes {
            id
            createdAt
            jobberWebUri
            amounts { 
              subtotal
              taxAmount
              discountAmount
              total 
            }
          }
        }
        jobs(first: 1) {
          nodes {
            id
            createdAt
            jobStatus
            startAt
            invoices(first: 1) {
              nodes {
                id
                createdAt
                amounts { total }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

function determineStage(request: any): string {
  const job     = request.jobs?.nodes?.[0]
  const quote   = request.quotes?.nodes?.[0]
  const invoice = job?.invoices?.nodes?.[0]
  if (invoice)            return 'Final Processing'
  if (job)                return 'Job in Progress'
  if (quote)              return 'Estimate Sent'
  if (request.assessment) return 'Assessment Scheduled'
  return 'New Request'
}

async function fetchAllPages(token: string, query: string, key: string, devMode = false): Promise<any[]> {
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
    if (devMode && key === 'clients' && pages >= 1) break
    if (hasMore) await new Promise(r => setTimeout(r, 300))
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

    const clients  = await fetchAllPages(jobberToken, CLIENTS_QUERY,  'clients',  devMode)
    await new Promise(r => setTimeout(r, 1000))
    const requests = await fetchAllPages(jobberToken, REQUESTS_QUERY, 'requests', false)

    const clientIds = new Set(clients.map((c: any) => c.id))
    const requestsByClient: Record<string, any[]> = {}
    for (const r of requests) {
      const cid = r.client?.id
      if (cid && clientIds.has(cid)) {
        if (!requestsByClient[cid]) requestsByClient[cid] = []
        requestsByClient[cid].push(r)
      }
    }

    const stats = {
      leads_created:        0,
      leads_updated:        0,
      requests_created:     0,
      requests_updated:     0,
      assessments_created:  0,
      assessments_updated:  0,
      quotes_created:       0,
      quotes_updated:       0,
      errors:               [] as string[],
    }

    for (const client of clients) {
      try {
        const { id: leadId, created } = await upsertLead(client, location_id)
        created ? stats.leads_created++ : stats.leads_updated++

        for (const request of (requestsByClient[client.id] || [])) {
          const result = await upsertServiceRequest(request, leadId, location_id)
          result.created ? stats.requests_created++ : stats.requests_updated++

          // Assessment
          if (request.assessment?.startAt) {
            const aResult = await upsertAssessment(request, result.id, leadId, location_id)
            aResult.created ? stats.assessments_created++ : stats.assessments_updated++
          }

          // Quotes (all of them)
          for (const quote of (request.quotes?.nodes || [])) {
            const qResult = await upsertQuote(quote, result.id, leadId, location_id)
            qResult.created ? stats.quotes_created++ : stats.quotes_updated++
          }
        }
      } catch (err: any) {
        stats.errors.push(`${client.firstName} ${client.lastName}: ${err.message}`)
      }
    }

    await writeSyncLog({
      location_id, entity_id: location_id,
      status: stats.errors.length > 0 ? 'error' : 'success',
      message: `Leads: +${stats.leads_created}/~${stats.leads_updated}. Requests: +${stats.requests_created}/~${stats.requests_updated}. Errors: ${stats.errors.length}`,
    })

    return NextResponse.json({
      success: true, location: location.Name,
      total_clients: clients.length,
      total_requests: requests.length,
      mode, ...stats,
    })
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
    name: `${client.firstName || ''} ${client.lastName || ''}`.trim() || client.companyName || 'Unknown',
    first_name: client.firstName || null, last_name: client.lastName || null,
    company: client.companyName || null, email, phone, address: addr,
    city: client.billingAddress?.city || null, state: client.billingAddress?.province || null,
    zip: client.billingAddress?.postalCode || null,
    jobber_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('leads').select('id')
    .eq('jobber_client_id', client.id).eq('location_id', location_id).maybeSingle()

  if (existing) {
    await supabaseService.from('leads').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService.from('leads')
    .insert({ ...payload, created_at: client.createdAt || new Date().toISOString() })
    .select('id').single()
  if (error) throw new Error(error.message)
  return { id: data.id, created: true }
}

async function upsertServiceRequest(request: any, lead_id: string, location_id: string) {
  const job     = request.jobs?.nodes?.[0]   || null
  const quote   = request.quotes?.nodes?.[0] || null
  const invoice = job?.invoices?.nodes?.[0]  || null

  const payload = {
    lead_id,
    location_id,
    jobber_request_id: request.id,
    request_url:       request.jobberWebUri || null,
    stage:             determineStage(request),
    status:            'active',
    source:            'jobber',
    jobber_synced_at:  new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('service_requests').select('id')
    .eq('jobber_request_id', request.id).maybeSingle()

  if (existing) {
    await supabaseService.from('service_requests').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService.from('service_requests')
    .insert({ ...payload, created_at: request.createdAt || new Date().toISOString() })
    .select('id').single()
  if (error) throw new Error(error.message)
  return { id: data.id, created: true }
}

async function upsertAssessment(request: any, service_request_id: string, lead_id: string, location_id: string) {
  const assessment = request.assessment

  const payload = {
    service_request_id,
    lead_id,
    location_id,
    jobber_request_id: request.id,
    scheduled_at:      assessment.startAt || null,
    status:            'scheduled',
    source:            'jobber',
    jobber_synced_at:  new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  }

  // Dedup by service_request_id — one assessment per request
  const { data: existing } = await supabaseService.from('assessments').select('id')
    .eq('service_request_id', service_request_id).maybeSingle()

  if (existing) {
    await supabaseService.from('assessments').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService.from('assessments')
    .insert({ ...payload, created_at: assessment.startAt || new Date().toISOString() })
    .select('id').single()
  if (error) throw new Error(`Assessment: ${error.message}`)
  return { id: data.id, created: true }
}

async function upsertQuote(quote: any, service_request_id: string, lead_id: string, location_id: string) {
  const payload = {
    service_request_id,
    lead_id,
    location_id,
    jobber_quote_id:  quote.id,
    quote_url:        quote.jobberWebUri || null,
    status:           'sent',
    subtotal:         quote.amounts?.subtotal      ? parseFloat(quote.amounts.subtotal)      : null,
    tax_amount:       quote.amounts?.taxAmount     ? parseFloat(quote.amounts.taxAmount)     : null,
    discount_amount:  quote.amounts?.discountAmount ? parseFloat(quote.amounts.discountAmount) : null,
    total:            quote.amounts?.total         ? parseFloat(quote.amounts.total)         : null,
    sent_at:          quote.createdAt || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('quotes').select('id')
    .eq('jobber_quote_id', quote.id).maybeSingle()

  if (existing) {
    await supabaseService.from('quotes').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }
  const { data, error } = await supabaseService.from('quotes')
    .insert({ ...payload, created_at: quote.createdAt || new Date().toISOString() })
    .select('id').single()
  if (error) throw new Error(`Quote: ${error.message}`)
  return { id: data.id, created: true }
}