// app/api/import/jobber-clients/route.ts
// ─────────────────────────────────────────────────────────────
// Pulls Jobber clients + jobs → writes to Supabase only.
// Completely separate from /api/jobber/import (Zoho pipeline).
// One lead per Jobber client. Jobs as child records.
// Dedup key: jobber_client_id (unique index per location).
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { getValidJobberToken, jobberQuery } from '@/lib/jobber'
import { getZohoLocation, getZohoToken } from '@/lib/zoho'
import { supabaseService } from '@/lib/supabase-service'
import { writeSyncLog } from '@/lib/sync-log'

// ─── Jobber GraphQL ───────────────────────────────────────────
// Pulls clients with their jobs embedded in one query
const CLIENTS_QUERY = `
  query GetClientsWithJobs($after: String) {
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
        jobs {
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
      pageInfo { hasNextPage endCursor }
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

// ─── Route Handler ────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { location_id, mode = 'full' } = await req.json()

    if (!location_id) {
      return NextResponse.json({ error: 'location_id required' }, { status: 400 })
    }

    // 1. Get Zoho location record (has Jobber tokens embedded)
    const location = await getZohoLocation(location_id)
    if (!location) {
      return NextResponse.json({ error: `Location ${location_id} not found` }, { status: 404 })
    }
    if (!location.Jobber_Access_Token) {
      return NextResponse.json({ error: 'Location not connected to Jobber' }, { status: 400 })
    }

    // 2. Validate/refresh Jobber token
    const zohoToken  = await getZohoToken()
    const jobberToken = await getValidJobberToken(location, zohoToken)

    // 3. Paginate through all Jobber clients
    const clients: any[] = []
    let cursor:  string | null = null
    let hasMore: boolean       = true
    let pages:   number        = 0

    while (hasMore) {
      const res = await jobberQuery(
        jobberToken,
        CLIENTS_QUERY,
        cursor ? { after: cursor } : {}
      )

      if (res.errors) {
        throw new Error(`Jobber GraphQL error: ${JSON.stringify(res.errors)}`)
      }

      const page = res.data?.clients
      if (!page) break

      clients.push(...page.nodes)
      hasMore = page.pageInfo.hasNextPage
      cursor  = page.pageInfo.endCursor
      pages++

      // dev mode: one page only (~50 clients)
      if (mode === 'dev' && pages >= 1) break

      // rate limit buffer
      if (hasMore) await new Promise(r => setTimeout(r, 500))
    }

    // 4. Upsert each client → lead + jobs
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

        const jobStats = await upsertJobs(client.jobs?.nodes || [], leadId, location_id)
        stats.jobs_created += jobStats.created
        stats.jobs_updated += jobStats.updated
      } catch (err: any) {
        const name = `${client.firstName} ${client.lastName}`.trim()
        stats.errors.push(`${name} (${client.id}): ${err.message}`)
      }
    }

    // 5. Write to sync log
    await writeSyncLog({
      location_id,
      entity_id:  location_id,
      status:     stats.errors.length > 0 ? 'error' : 'success',
      message:    `Jobber → Supabase import. ` +
                  `Leads: +${stats.leads_created} / ~${stats.leads_updated}. ` +
                  `Jobs: +${stats.jobs_created} / ~${stats.jobs_updated}. ` +
                  `Errors: ${stats.errors.length}`,
    })

    return NextResponse.json({
      success: true,
      location: location.Name,
      total_clients: clients.length,
      mode,
      ...stats,
    })
  } catch (err: any) {
    console.error('[jobber-clients import]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// ─── Upsert Lead ──────────────────────────────────────────────
async function upsertLead(client: any, location_id: string) {
  const email = client.emails?.find((e: any) => e.primary)?.address
             ?? client.emails?.[0]?.address
             ?? null

  const phone = client.phones?.find((p: any) => p.primary)?.number
             ?? client.phones?.[0]?.number
             ?? null

  const addr = client.billingAddress
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
    name:       `${client.firstName || ''} ${client.lastName || ''}`.trim() || client.companyName || 'Unknown',
    first_name: client.firstName   || null,
    last_name:  client.lastName    || null,
    company:    client.companyName || null,
    email,
    phone,
    address: addr,
    city:    client.billingAddress?.city        || null,
    state:   client.billingAddress?.province    || null,
    zip:     client.billingAddress?.postalCode  || null,
    jobber_synced_at: new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  }

  // Check by jobber_client_id — one lead per client, never duplicates
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

// ─── Upsert Jobs ──────────────────────────────────────────────
async function upsertJobs(jobs: any[], lead_id: string, location_id: string) {
  const stats = { created: 0, updated: 0 }

  for (const job of jobs) {
    const payload = {
      lead_id,
      location_id,
      jobber_job_id:   job.id,
      title:           job.title || 'Untitled Job',
      status:          JOB_STATUS[job.jobStatus?.toUpperCase()] ?? job.jobStatus ?? 'Unknown',
      scheduled_date:  job.startAt     ? job.startAt.split('T')[0]     : null,
      completed_date:  job.completedAt ? job.completedAt.split('T')[0] : null,
      amount:          job.total ? parseFloat(job.total) : null,
      assigned_team:   [],
      jobber_synced_at: new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    }

    const { data: existing } = await supabaseService
      .from('jobs')
      .select('id')
      .eq('jobber_job_id', job.id)
      .maybeSingle()

    if (existing) {
      await supabaseService.from('jobs').update(payload).eq('id', existing.id)
      stats.updated++
    } else {
      await supabaseService
        .from('jobs')
        .insert({ ...payload, created_at: job.createdAt || new Date().toISOString() })
      stats.created++
    }
  }

  return stats
}