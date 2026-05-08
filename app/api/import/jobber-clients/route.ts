// app/api/import/jobber-clients/route.ts
// ─────────────────────────────────────────────────────────────
// Pulls Jobber clients → writes leads to Supabase.
// Jobs are fetched in a separate lightweight query.
// Keeps query complexity low to avoid Jobber rate limits.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { getValidJobberToken, jobberQuery } from '@/lib/jobber'
import { getZohoLocation, getZohoToken } from '@/lib/zoho'
import { supabaseService } from '@/lib/supabase-service'
import { writeSyncLog } from '@/lib/sync-log'

// ─── Simple client query — no nested jobs (keeps complexity low) ──
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

// ─── Separate jobs query per client ──────────────────────────────
const CLIENT_JOBS_QUERY = `
  query GetClientJobs($clientId: ID!) {
    client(id: $clientId) {
      jobs(first: 50) {
        nodes {
          id
          title
          jobStatus
          startAt
          completedAt
          createdAt
          total
        }
      }
    }
  }
`

const JOB_STATUS: Record<string, string> = {
  ACTIVE:             'In Progress',
  COMPLETED:          'Completed',
  REQUIRES_INVOICING: 'Needs Invoice',
  LATE:               'Late',
  TODAY:              'Today',
  UPCOMING:           'Upcoming',
  ARCHIVED:           'Archived',
}

export async function POST(req: NextRequest) {
  try {
    const { location_id, mode = 'full' } = await req.json()
    if (!location_id) return NextResponse.json({ error: 'location_id required' }, { status: 400 })

    const location = await getZohoLocation(location_id)
    if (!location) return NextResponse.json({ error: `Location ${location_id} not found` }, { status: 404 })
    if (!location.Jobber_Access_Token) return NextResponse.json({ error: 'Location not connected to Jobber' }, { status: 400 })

    const zohoToken  = await getZohoToken()
    const jobberToken = await getValidJobberToken(location, zohoToken)

    // ── Step 1: Fetch all clients (simple query) ──────────────────
    const clients: any[] = []
    let cursor:  string | null = null
    let hasMore: boolean       = true
    let pages:   number        = 0

    while (hasMore) {
      const res = await jobberQuery(jobberToken, CLIENTS_QUERY, cursor ? { after: cursor } : {})
      if (res.errors) throw new Error(`Jobber clients error: ${JSON.stringify(res.errors)}`)

      const page = res.data?.clients
      if (!page) break

      clients.push(...page.nodes)
      hasMore = page.pageInfo.hasNextPage
      cursor  = page.pageInfo.endCursor
      pages++

      if (mode === 'dev' && pages >= 1) break
      if (hasMore) await new Promise(r => setTimeout(r, 300))
    }

    // ── Step 2: Upsert each client as a lead ──────────────────────
    const stats = {
      leads_created: 0,
      leads_updated: 0,
      jobs_created:  0,
      jobs_updated:  0,
      errors:        [] as string[],
    }

    for (const client of clients) {
      try {
        const { id: leadId, created } = await upsertLead(client, location_id)
        created ? stats.leads_created++ : stats.leads_updated++

        // Step 3: Fetch and upsert jobs for this client
        await new Promise(r => setTimeout(r, 200)) // small delay between requests
        const jobStats = await syncClientJobs(jobberToken, client.id, leadId, location_id)
        stats.jobs_created += jobStats.created
        stats.jobs_updated += jobStats.updated
      } catch (err: any) {
        const name = `${client.firstName} ${client.lastName}`.trim()
        stats.errors.push(`${name} (${client.id}): ${err.message}`)
      }
    }

    await writeSyncLog({
      location_id,
      entity_id:  location_id,
      status:     stats.errors.length > 0 ? 'error' : 'success',
      message:    `Jobber → Supabase. Leads: +${stats.leads_created}/~${stats.leads_updated}. Jobs: +${stats.jobs_created}/~${stats.jobs_updated}. Errors: ${stats.errors.length}`,
    })

    return NextResponse.json({ success: true, location: location.Name, total_clients: clients.length, mode, ...stats })
  } catch (err: any) {
    console.error('[jobber-clients import]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function syncClientJobs(jobberToken: string, clientId: string, leadId: string, location_id: string) {
  const stats = { created: 0, updated: 0 }
  try {
    const res = await jobberQuery(jobberToken, CLIENT_JOBS_QUERY, { clientId })
    if (res.errors || !res.data?.client?.jobs?.nodes) return stats

    for (const job of res.data.client.jobs.nodes) {
      const payload = {
        lead_id:          leadId,
        location_id,
        jobber_job_id:    job.id,
        title:            job.title || 'Untitled Job',
        status:           JOB_STATUS[job.jobStatus?.toUpperCase()] ?? job.jobStatus ?? 'Unknown',
        scheduled_date:   job.startAt     ? job.startAt.split('T')[0]     : null,
        completed_date:   job.completedAt ? job.completedAt.split('T')[0] : null,
        amount:           job.total ? parseFloat(job.total) : null,
        jobber_synced_at: new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      }

      const { data: existing } = await supabaseService.from('jobs').select('id').eq('jobber_job_id', job.id).maybeSingle()
      if (existing) {
        await supabaseService.from('jobs').update(payload).eq('id', existing.id)
        stats.updated++
      } else {
        await supabaseService.from('jobs').insert({ ...payload, created_at: job.createdAt || new Date().toISOString() })
        stats.created++
      }
    }
  } catch (err: any) {
    console.error('[syncClientJobs] error for client', clientId, err.message)
  }
  return stats
}

async function upsertLead(client: any, location_id: string) {
  const email = client.emails?.find((e: any) => e.primary)?.address ?? client.emails?.[0]?.address ?? null
  const phone = client.phones?.find((p: any) => p.primary)?.number  ?? client.phones?.[0]?.number  ?? null
  const addr  = client.billingAddress
    ? [client.billingAddress.street, client.billingAddress.city, client.billingAddress.province, client.billingAddress.postalCode].filter(Boolean).join(', ')
    : null

  const payload = {
    location_id,
    jobber_client_id: client.id,
    name:       `${client.firstName || ''} ${client.lastName || ''}`.trim() || client.companyName || 'Unknown',
    first_name: client.firstName   || null,
    last_name:  client.lastName    || null,
    company:    client.companyName || null,
    email, phone, address: addr,
    city:  client.billingAddress?.city       || null,
    state: client.billingAddress?.province   || null,
    zip:   client.billingAddress?.postalCode || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  }

  const { data: existing } = await supabaseService.from('leads').select('id').eq('jobber_client_id', client.id).eq('location_id', location_id).maybeSingle()
  if (existing) {
    await supabaseService.from('leads').update(payload).eq('id', existing.id)
    return { id: existing.id, created: false }
  }

  const { data, error } = await supabaseService.from('leads').insert({ ...payload, created_at: client.createdAt || new Date().toISOString() }).select('id').single()
  if (error) throw new Error(error.message)
  return { id: data.id, created: true }
}