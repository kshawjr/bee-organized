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
// Stage classification (see determineStage) — returns canonical Bee Hub
// stage values matching components/BeeHub.jsx STAGES array:
//   'Final Processing' (has invoice)
//   'Job in Progress'  (has job)
//   'Estimate Sent'    (has quote)
//   'Request'          (has assessment, no quote yet — "Request | Assessment")
//   'Nurturing'        (no downstream activity AND createdAt > 30 days ago)
//   'New'              (default — fresh request, no other activity)
//
// The Nurturing bucket exists because the franchise historically used Jobber
// as a parking lot for stale leads — old untouched requests should not show
// up as "fresh and actionable" New rows.
//
// Promotion: after upsertServiceRequest, leads.stage is bumped to match the
// SR's classification — but only if it represents forward progress. Prevents
// older SRs processed later from demoting a lead from Final Processing → New.
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
import {
  CLIENTS_QUERY,
  REQUESTS_QUERY,
  QUOTES_QUERY,
  JOBS_QUERY,
  upsertLead,
  upsertServiceRequest,
  upsertAssessment,
  upsertQuote,
  upsertJob,
  upsertInvoice,
} from '@/lib/jobber-import'

export const runtime = 'nodejs'
export const maxDuration = 300

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const locUuid: string = location.id

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
      requests_by_stage: {} as Record<string, number>,
      assessments_created: 0, assessments_updated: 0,
      quotes_created: 0, quotes_updated: 0,
      jobs_created: 0, jobs_updated: 0,
      invoices_created: 0, invoices_updated: 0,
      errors: [] as string[],
    }

    let processed = 0
    for (const client of clients) {
      try {
        const { id: leadId, created } = await upsertLead(client, locSlug, locUuid)
        created ? stats.leads_created++ : stats.leads_updated++

        for (const request of (reqByClient[client.id] || [])) {
          const reqResult = await upsertServiceRequest(request, leadId, locSlug)
          reqResult.created ? stats.requests_created++ : stats.requests_updated++
          stats.requests_by_stage[reqResult.stage] = (stats.requests_by_stage[reqResult.stage] || 0) + 1
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
