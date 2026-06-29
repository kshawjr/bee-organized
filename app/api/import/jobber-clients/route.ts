// app/api/import/jobber-clients/route.ts
//
// POST endpoint to import a location's Jobber data into Supabase.
// Flat per-entity GraphQL queries (avoids Jobber complexity limits), joined
// in-memory, then upserted via service-role writes.
// Order: clients → requests → assessments → quotes → jobs → invoices
//
// Response shape: NDJSON stream so the client can see the job_id within
// milliseconds of clicking Import (and start polling /api/import/status/[id]
// to drive the live "Importing X of Y" UI + bee animation), even though the
// actual upsert phase can take minutes. The stream emits exactly two lines:
//   1. {"job_id":"<uuid>","started":true}
//   2. {"done":true, ...summary}   OR   {"error":"...", "job_id":"<uuid>"}
// import_jobs is still written progressively, so the polling endpoint sees
// processed/total updates throughout. Each request continues to be served
// by a single serverless function — the stream just defers the response so
// the function stays alive for the full import without blocking the client
// on the job_id.
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
// On successful completion, sets locations.jobber_initial_import_completed_at
// (even when some rows error — Jobber webhooks heal missed records later).
// Settings → Locations uses this flag to hide the manual import button.
//
// KNOWN: leads/assessments/payments/notes lack UNIQUE on jobber_*_id.
// Re-running this import concurrently could create dup rows in those tables.
// Hardening pass: add UNIQUE constraints + switch to ON CONFLICT upserts.

import { NextRequest, NextResponse } from 'next/server'
import { getValidJobberToken, jobberQueryThrottled } from '@/lib/jobber'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { canRunImport } from '@/lib/auth'
import { writeSyncLog } from '@/lib/sync-log'
import {
  CLIENTS_QUERY,
  INCREMENTAL_CLIENTS_QUERY,
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
  onThrottlePause?: (waitMs: number) => void,
  extraVars: Record<string, any> = {},
): Promise<any[]> {
  const all: any[] = []
  let cursor: string | null = null
  let hasMore = true
  let pages = 0

  while (hasMore) {
    const vars = cursor ? { after: cursor, ...extraVars } : { ...extraVars }
    const res = await jobberQueryThrottled(token, query, vars, { onThrottlePause })
    // Non-throttle errors (auth, syntax, etc.) — throw immediately
    if (res.errors?.some((e: any) => e.extensions?.code !== 'THROTTLED')) {
      throw new Error(`${key} error: ${JSON.stringify(res.errors)}`)
    }
    const page = res.data?.[key]
    if (!page) break
    all.push(...page.nodes)
    hasMore = page.pageInfo.hasNextPage
    cursor = page.pageInfo.endCursor
    pages++
    if (devMode && limitToFirstPage && pages >= 1) break
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

  const jobId = importJob.id

  // ─── stream the response so the client gets job_id immediately ──
  // The heavy import work runs inside the stream's start() callback. The
  // first chunk hands the job_id to the client (which kicks off polling for
  // the live "Importing X of Y" UI). The final chunk carries the summary
  // (or an error) so the client doesn't need a second round-trip.
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: any) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))

      // 1️⃣ first chunk: job_id (lets the client start polling within ms)
      emit({ job_id: jobId, started: true })

      try {
        const jobberToken = await getValidJobberToken(location)
        const devMode = mode === 'dev'

        // Surfaced to the client when Jobber's rate limit requires a pause.
        const onThrottlePause = async (waitMs: number) => {
          const secs = Math.ceil(waitMs / 1000)
          const msg = `Pausing ${secs}s for Jobber API rate limit...`
          emit({ throttle_pause: true, wait_ms: waitMs, message: msg })
          await updateProgress(jobId, { phase: msg })
        }

        // ─── fetch all entities (flat queries with pacing) ──
        await updateProgress(jobId, { phase: 'clients' })
        const clients = await fetchAll(jobberToken, CLIENTS_QUERY, 'clients', devMode, true, onThrottlePause)

        // Sort newest-first so that if Vercel kills the function before the write loop
        // finishes, recent clients are written before stale ones (Bug B: new leads missing).
        clients.sort((a: any, b: any) =>
          new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
        )
        console.log(`[jobber-import] fetched ${clients.length} clients; newest: ${clients[0]?.createdAt ?? 'n/a'}, oldest: ${clients[clients.length - 1]?.createdAt ?? 'n/a'}`)

        // Set total immediately so the UI shows "0 of N" within seconds of the fetch completing.
        await updateProgress(jobId, {
          phase: 'requests',
          total_records: clients.length,
        })
        const requests = await fetchAll(jobberToken, REQUESTS_QUERY, 'requests', false, false, onThrottlePause)

        await updateProgress(jobId, { phase: 'quotes' })
        const quotes = await fetchAll(jobberToken, QUOTES_QUERY, 'quotes', false, false, onThrottlePause)

        await updateProgress(jobId, { phase: 'jobs' })
        const jobs = await fetchAll(jobberToken, JOBS_QUERY, 'jobs', false, false, onThrottlePause)

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
        // Write total before the loop so the UI shows "0 of N" immediately.
        await updateProgress(jobId, {
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

        // ─── RESUME SUPPORT ──────────────────────────────────────────
        // Load jobber_client_ids already written for this location so a
        // re-run skips them (idempotent; upsert already dedupes, this just
        // saves the write cost). Lets a timed-out import continue cheaply.
        const { data: existingRows } = await supabaseService
          .from('leads')
          .select('jobber_client_id')
          .eq('location_uuid', locUuid)
          .not('jobber_client_id', 'is', null)
        const alreadyWritten = new Set((existingRows || []).map(r => r.jobber_client_id))

        // Cap writes per invocation so we never hit the 300s wall mid-record.
        const WRITE_BATCH_CAP = 400
        let wroteThisRun = 0
        let hitCap = false

        let processed = alreadyWritten.size  // count already-done toward progress
        for (const client of clients) {
          // Skip clients already written in a previous (timed-out) run.
          if (alreadyWritten.has(client.id)) continue

          // Stop this invocation once we've written a full batch — the client
          // will re-POST to continue. Prevents mid-record Vercel kill.
          if (wroteThisRun >= WRITE_BATCH_CAP) { hitCap = true; break }

          try {
            const { id: leadId, created } = await upsertLead(client, locSlug, locUuid, {
              importSource: 'jobber_initial',
            })
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
          wroteThisRun++
          if (processed % 50 === 0 || processed === clients.length) {
            await updateProgress(jobId, { processed_records: processed })
          }
        }

        if (hitCap) {
          // More clients remain — mark job resumable and signal client to continue.
          await updateProgress(jobId, {
            status: 'running',
            phase: `batched — ${processed}/${clients.length}, continuing`,
            processed_records: processed,
            total_records: clients.length,
          })
          emit({ continue: true, processed, total: clients.length, job_id: jobId })
          controller.close()
          return
        }

        // ─── incremental pass ─────────────────────────────────────────
        // Fetch clients updated since the last import timestamp to catch records that
        // Jobber may not surface when sorting by CREATED_AT (e.g. re-activated clients,
        // or records beyond a server-side cursor boundary).  This is a best-effort catch-up
        // — if Jobber doesn't support the filter, we log and move on without failing.
        const lastImportAt = location.jobber_initial_import_completed_at
        if (lastImportAt) {
          await updateProgress(jobId, { phase: 'incremental' })
          try {
            const recentClients = await fetchAll(
              jobberToken,
              INCREMENTAL_CLIENTS_QUERY,
              'clients',
              false,
              false,
              onThrottlePause,
              { since: lastImportAt },
            )
            console.log(`[jobber-import] incremental pass: ${recentClients.length} clients updated since ${lastImportAt}`)
            for (const client of recentClients) {
              try {
                const { created } = await upsertLead(client, locSlug, locUuid, { importSource: 'jobber_initial' })
                created ? stats.leads_created++ : stats.leads_updated++
              } catch (err: any) {
                stats.errors.push(`[incremental] ${client.firstName} ${client.lastName}: ${err.message}`)
              }
            }
          } catch (err: any) {
            // Non-fatal — log and continue so the import still completes.
            console.warn('[jobber-import] incremental pass failed (filter may be unsupported):', err.message)
          }
        }

        await writeSyncLog({
          location_id: locSlug,
          entity_id: locSlug,
          status: stats.errors.length > 0 ? 'error' : 'success',
          message:
            `Leads: ${stats.leads_created} created, ${stats.leads_updated} updated; ` +
            `Requests: ${stats.requests_created} created, ${stats.requests_updated} updated; ` +
            `Quotes: ${stats.quotes_created} created, ${stats.quotes_updated} updated; ` +
            `Jobs: ${stats.jobs_created} created, ${stats.jobs_updated} updated; ` +
            `Invoices: ${stats.invoices_created} created, ${stats.invoices_updated} updated; ` +
            `Errors: ${stats.errors.length}`,
        })

        await updateProgress(jobId, {
          status: 'completed',
          phase: 'done',
          processed_records: clients.length,
          completed_at: new Date().toISOString(),
          ...(stats.errors.length > 0
            ? { error_message: stats.errors.slice(0, 5).join(' | ') }
            : {}),
        })

        // One-time gate: mark initial import done. Set even when some rows
        // errored — webhook sync handles missed records going forward, and
        // re-running the bulk import would create duplicates in tables that
        // don't yet have UNIQUE constraints on jobber_*_id.
        try {
          await supabaseService
            .from('locations')
            .update({ jobber_initial_import_completed_at: new Date().toISOString() })
            .eq('id', locUuid)
        } catch (err) {
          console.error('[jobber-initial-import flag write failed]', err)
        }

        // 2️⃣ final chunk: summary
        emit({
          done: true,
          success: true,
          job_id: jobId,
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
        await updateProgress(jobId, {
          status: 'failed',
          error_message: String(err?.message || err),
          completed_at: new Date().toISOString(),
        })
        emit({ error: String(err?.message || err), job_id: jobId })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
