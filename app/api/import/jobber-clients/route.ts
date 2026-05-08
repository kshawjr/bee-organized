// app/api/import/jobber-clients/route.ts

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

// Fetch requests for a specific client — guarantees history matches our clients
const CLIENT_REQUESTS_QUERY = `
  query GetClientRequests($clientId: ID!) {
    client(id: $clientId) {
      requests(first: 50) {
        nodes {
          id
          createdAt
          jobberWebUri
          assessment { startAt }
          quotes(first: 1) {
            nodes {
              id
              createdAt
              jobberWebUri
              amounts { total }
            }
          }
          jobs(first: 1) {
            nodes {
              id
              createdAt
              jobStatus
              startAt
              jobberWebUri
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
      }
    }
  }
`

function determineStage(request: any): string {
  const job     = request.jobs?.nodes?.[0]
  const quote   = request.quotes?.nodes?.[0]
  const invoice = job?.invoices?.nodes?.[0]
  if (invoice)              return 'Final Processing'
  if (job)                  return 'Job in Progress'
  if (quote)                return 'Estimate Sent'
  if (request.assessment)   return 'Assessment Scheduled'
  return 'New Request'
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

    // ── Fetch clients ─────────────────────────────────────────
    const clients: any[] = []
    let cursor:  string | null = null
    let hasMore: boolean       = true
    let pages:   number        = 0

    while (hasMore) {
      const res = await jobberQuery(jobberToken, CLIENTS_QUERY, cursor ? { after: cursor } : {})
      if (res.errors) throw new Error(`Clients error: ${JSON.stringify(res.errors)}`)
      const page = res.data?.clients
      if (!page) break
      clients.push(...page.nodes)
      hasMore = page.pageInfo.hasNextPage
      cursor  = page.pageInfo.endCursor
      pages++
      if (mode === 'dev' && pages >= 1) break
      if (hasMore) await new Promise(r => setTimeout(r, 300))
    }

    // ── Process each client: upsert lead + fetch their requests ──
    const stats = {
      leads_created:   0,
      leads_updated:   0,
      history_created: 0,
      history_updated: 0,
      errors:          [] as string[],
    }

    for (const client of clients) {
      try {
        // 1. Upsert lead
        const { id: leadId, created } = await upsertLead(client, location_id)
        created ? stats.leads_created++ : stats.leads_updated++

        // 2. Fetch this client's requests directly — no pagination mismatch
        await new Promise(r => setTimeout(r, 250))
        const reqRes = await jobberQuery(jobberToken, CLIENT_REQUESTS_QUERY, { clientId: client.id })

        if (reqRes.errors) {
          console.warn('Requests error for client', client.id, reqRes.errors)
          continue
        }

        const requests = reqRes.data?.client?.requests?.nodes || []

        // 3. Upsert service history for each request
        for (const request of requests) {
          const result = await upsertServiceHistory(request, leadId, location_id)
          result.created ? stats.history_created++ : stats.history_updated++
        }
      } catch (err: any) {
        const name = `${client.firstName} ${client.lastName}`.trim()
        stats.errors.push(`${name}: ${err.message}`)
      }
    }

    await writeSyncLog({
      location_id,
      entity_id: location_id,
      status: stats.errors.length > 0 ? 'error' : 'success',
      message: `Imported ${clients.length} clients. Leads: +${stats.leads_created}/~${stats.leads_updated}. History: +${stats.history_created}/~${stats.history_updated}. Errors: ${stats.errors.length}`,
    })

    return NextResponse.json({
      success: true, location: location.Name,
      total_clients: clients.length, mode, ...stats,
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

async function upsertServiceHistory(request: any, lead_id: string, location_id: string) {
  const quote   = request.quotes?.nodes?.[0] || null
  const job     = request.jobs?.nodes?.[0]   || null
  const invoice = job?.invoices?.nodes?.[0]  || null

  const payload = {
    lead_id, location_id,
    jobber_request_id:  request.id,
    jobber_quote_id:    quote?.id    || null,
    jobber_job_id:      job?.id      || null,
    jobber_invoice_id:  invoice?.id  || null,
    request_url:        request.jobberWebUri || null,
    quote_url:          quote?.jobberWebUri  || null,
    job_url:            job?.jobberWebUri    || null,
    stage:              determineStage(request),
    assessment_date:    request.assessment?.startAt || null,
    estimate_sent_date: quote?.createdAt || null,
    estimate_amount:    quote?.amounts?.total ? parseFloat(quote.amounts.total) : null,
    job_created_date:   job?.createdAt || job?.startAt || null,
    job_completed_date: job?.jobStatus === 'COMPLETED' ? (job?.startAt || null) : null,
    invoice_date:       invoice?.createdAt || null,
    invoice_amount:     invoice?.amounts?.total ? parseFloat(invoice.amounts.total) : null,
    jobber_synced_at:   new Date().toISOString(),
    updated_at:         new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('service_history').select('id')
    .eq('jobber_request_id', request.id).maybeSingle()

  if (existing) {
    await supabaseService.from('service_history').update(payload).eq('id', existing.id)
    return { created: false }
  }
  await supabaseService.from('service_history')
    .insert({ ...payload, created_at: request.createdAt || new Date().toISOString() })
  return { created: true }
}