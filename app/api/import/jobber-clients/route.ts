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
import { waitUntil } from '@vercel/functions'
import { getValidJobberToken, jobberQueryThrottled } from '@/lib/jobber'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { canRunImport } from '@/lib/auth'
import { writeSyncLog } from '@/lib/sync-log'
import { resolveInternalOrigin } from '@/lib/internal-origin'
import {
  CLIENTS_QUERY,
  INCREMENTAL_CLIENTS_QUERY,
  REQUESTS_QUERY,
  QUOTES_QUERY,
  JOBS_QUERY,
  drainJobInvoices,
  upsertLead,
  upsertServiceRequest,
  determineLeadStage,
  upsertAssessment,
  upsertQuote,
  upsertJob,
  upsertInvoice,
  extractJobberId,
  selectUnwrittenClients,
  writeLoopShouldYield,
  writeImportCompletionStamp,
} from '@/lib/jobber-import'
import {
  ensureEngagementForServiceRequest,
  resolveEngagementForChild,
  attachToEngagement,
  maybeAdvanceEngagementStage,
} from '@/lib/engagements'

export const runtime = 'nodejs'
export const maxDuration = 800

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
  // ─── internal continuation: skip user-auth for self-chain / cron sweeper ──
  // The waitUntil self-chain (see selfContinue below) and the cron sweeper
  // (/api/cron/import-sweeper) re-POST here with no user session. They
  // authenticate via x-import-continue-secret == CRON_SECRET. Only auth is
  // bypassed — the location lookup and the atomic location claim still run,
  // so two continuations can't double-drive a segment.
  const isInternalContinue =
    !!process.env.CRON_SECRET &&
    req.headers.get('x-import-continue-secret') === process.env.CRON_SECRET

  // ─── auth (user-session path) ──
  let hubUser: any = null
  if (!isInternalContinue) {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const { data: hu } = await supabase
      .from('hub_users')
      .select('*')
      .eq('id', user.id)
      .single()
    if (!hu) return NextResponse.json({ error: 'no_profile' }, { status: 403 })
    if (!canRunImport(hu.role)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    hubUser = hu
  }

  // ─── input (query param wins, fall back to JSON body) ──
  const url = new URL(req.url)
  const queryLocId = url.searchParams.get('location_id')
  const queryMode  = url.searchParams.get('mode')
  // Use a stable, non-SSO-gated origin for self-chain POSTs. The deployment
  // URL (url.origin) is Vercel-SSO-gated and silently redirects internal
  // fetches to a login page — the same trap that stranded the sweeper. Route
  // through the public custom domain (NEXT_PUBLIC_APP_URL) so the re-poke
  // actually reaches this route. See lib/internal-origin.ts.
  const selfOrigin = resolveInternalOrigin(url.origin)

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
  // Skipped for internal continuations (trusted caller — cron / self-chain).
  if (!isInternalContinue && hubUser?.role === 'owner' && hubUser.location_id !== location.id) {
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

  // ─── atomic location-level claim ─────────────────────────────
  // Find-or-create the running job for this location, then acquire the claim
  // via conditional UPDATE (compare-and-swap) so only ONE concurrent caller
  // wins the right to drive the next segment. Losers get the job id back and
  // return already_active. The partial UNIQUE index on import_jobs
  // (idx_import_jobs_one_running) enforces at most one running job per
  // location — if two callers race the else-branch INSERT, one hits 23505
  // and falls back to SELECT + claim.
  const CLAIM_TTL_MS = 90_000
  const startedAtIso = new Date().toISOString()
  const claimNowIso = startedAtIso
  const claimCutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString()

  const tryClaim = async (id: string): Promise<boolean> => {
    const { data: claimed } = await supabaseService
      .from('import_jobs')
      .update({ location_claim_at: claimNowIso })
      .eq('id', id)
      .or(`location_claim_at.is.null,location_claim_at.lt.${claimCutoff}`)
      .select('id')
    return !!claimed && claimed.length > 0
  }

  const findRunning = async () =>
    supabaseService
      .from('import_jobs')
      .select('id, location_claim_at')
      .eq('location_id', locSlug)
      .eq('type', 'jobber_clients')
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

  const { data: existing } = await findRunning()

  let jobId: string
  if (existing) {
    jobId = existing.id
    if (!(await tryClaim(jobId))) {
      // Another caller holds a fresh claim — a segment is genuinely active.
      return NextResponse.json({ job_id: jobId, started: true, already_active: true })
    }
    // We won the claim → drive the next segment (resume from location staging).
  } else {
    // No running job — try to create one, claimed atomically in the same insert.
    const { data: created, error: jobErr } = await supabaseService
      .from('import_jobs')
      .insert({
        location_id: locSlug,
        type: 'jobber_clients',
        status: 'running',
        phase: 'starting',
        total_records: 0,
        processed_records: 0,
        started_at: startedAtIso,
        location_claim_at: claimNowIso,
      })
      .select('id')
      .single()

    if (jobErr) {
      // 23505 = the partial UNIQUE index rejected our INSERT because another
      // POST won the race and inserted first. Fall back to SELECT + claim.
      if ((jobErr as any).code === '23505') {
        const { data: rival } = await findRunning()
        if (!rival) {
          return NextResponse.json({ error: 'failed_to_create_import_job', detail: 'race_lost_and_missing' }, { status: 500 })
        }
        jobId = rival.id
        if (!(await tryClaim(jobId))) {
          return NextResponse.json({ job_id: jobId, started: true, already_active: true })
        }
      } else {
        return NextResponse.json({ error: 'failed_to_create_import_job', detail: jobErr.message }, { status: 500 })
      }
    } else if (!created) {
      return NextResponse.json({ error: 'failed_to_create_import_job', detail: 'no_row_returned' }, { status: 500 })
    } else {
      jobId = created.id
    }
  }

  // Fire the next segment server-side so the import continues without a
  // browser. Uses this deployment's own origin + the internal-continue
  // secret (matches x-import-continue-secret gate at top of POST) to pass
  // auth without a user session. Best-effort — cron sweeper is the backstop
  // if the fetch fails or the chain otherwise breaks.
  const selfContinue = () => {
    waitUntil(
      fetch(`${selfOrigin}/api/import/jobber-clients?location_id=${encodeURIComponent(locSlug)}&_continue=1`, {
        method: 'POST',
        headers: { 'x-import-continue-secret': process.env.CRON_SECRET || '' },
      }).catch(() => {})
    )
  }

  // Run the import detached from the request via waitUntil so it survives
  // after we return the response. All progress is written to import_jobs
  // (read by /api/import/status/[id] polling), so no stream is needed.
  const emit = (_obj: any) => {}  // no-op: progress goes to DB, not a stream
  const runImport = async () => {
      // Wall-clock guard: stop fetching before the 800s Vercel wall and let the
      // frontend re-POST to resume from the persisted cursor. 600s leaves ample
      // headroom for the write phase (or a mid-page throttle pause) to finish.
      const RUN_START = Date.now()
      const TIME_BUDGET_MS = 600_000
      const timeLow = () => Date.now() - RUN_START > TIME_BUDGET_MS

      // Per-job mutex: because the frontend re-POSTs to auto-continue and the
      // POST returns immediately (waitUntil is fire-and-forget), the poller
      // can't tell if the prior segment is still running server-side. Claim
      // segment_started_at atomically — only proceed if the row is null or
      // stale (>90s old). Stale reclaim covers crashed segments.
      const MUTEX_TTL_MS = 90_000
      const nowIso = new Date().toISOString()
      const cutoffIso = new Date(Date.now() - MUTEX_TTL_MS).toISOString()
      const { data: claimed } = await supabaseService
        .from('import_jobs')
        .update({ segment_started_at: nowIso })
        .eq('id', jobId)
        .or(`segment_started_at.is.null,segment_started_at.lt.${cutoffIso}`)
        .select('id')
      if (!claimed || claimed.length === 0) {
        console.log(`[jobber-import] segment already running for job ${jobId} — exiting without spawning rival`)
        return
      }

      // Clear the mutex from any exit path. Idempotent — safe to call more
      // than once. Every return below must call this before returning.
      const releaseMutex = async () => {
        // Release both the in-run segment mutex AND the atomic location
        // claim so the next re-POST can acquire and drive the next segment.
        try {
          await supabaseService
            .from('import_jobs')
            .update({ segment_started_at: null, location_claim_at: null })
            .eq('id', jobId)
        } catch (err) {
          console.error('[import_jobs mutex release failed]', err)
        }
      }

      try {
        const devMode = mode === 'dev'

        // Surfaced to the client when Jobber's rate limit requires a pause.
        const onThrottlePause = async (waitMs: number) => {
          const secs = Math.ceil(waitMs / 1000)
          const msg = `Pausing ${secs}s for Jobber API rate limit...`
          emit({ throttle_pause: true, wait_ms: waitMs, message: msg })
          await updateProgress(jobId, { phase: msg })
        }

        // ─── resumable segmented fetch (location-keyed) ───────────────
        // Fetch state lives in import_location_fetch keyed by location, not
        // by job — so a fresh job for a location inherits whatever entities
        // a prior job already completed, and stages into the shared
        // (location_id, entity, node_id) namespace via the unique dedup index.
        await supabaseService
          .from('import_location_fetch')
          .upsert({ location_id: locSlug }, { onConflict: 'location_id', ignoreDuplicates: true })
        const { data: fetchRow } = await supabaseService
          .from('import_location_fetch')
          .select('fetch_cursors, fetch_complete')
          .eq('location_id', locSlug)
          .single()
        const cursors: Record<string, string | null> = fetchRow?.fetch_cursors || {}
        const complete: Record<string, boolean> = fetchRow?.fetch_complete || {}
        const allFetchedUpfront = ['clients', 'requests', 'quotes', 'jobs'].every(e => complete[e])

        // Only refresh the Jobber token if we actually have fetching to do.
        // Write-only resume segments need zero Jobber calls (data is already
        // in staging), so we skip the token-refresh path entirely for them.
        // An expired refresh token — the KC-style crash — now only blocks
        // fetch-phase segments; the write phase can still finish on staged
        // data. Wrapped in try/catch so a token error surfaces as a clean
        // "failed" job with a readable error_message, not an uncaught throw.
        let jobberToken: string | null = null
        if (!allFetchedUpfront) {
          try {
            jobberToken = await getValidJobberToken(location)
          } catch (err: any) {
            await updateProgress(jobId, {
              status: 'failed',
              error_message: `Token: ${String(err?.message || err)}`,
              completed_at: new Date().toISOString(),
            })
            await releaseMutex()
            emit({ error: String(err?.message || err), job_id: jobId })
            return
          }
        }

        const persistCursors = async () => {
          const nowIso = new Date().toISOString()
          // Refresh the location_claim_at mutex alongside the cursor write so
          // the cron sweeper doesn't classify a Jobber-throttled fetch segment
          // as stale. Every page write bumps both.
          await supabaseService
            .from('import_location_fetch')
            .update({ fetch_cursors: cursors, updated_at: nowIso })
            .eq('location_id', locSlug)
          await supabaseService
            .from('import_jobs')
            .update({ location_claim_at: nowIso })
            .eq('id', jobId)
        }
        const persistComplete = async () =>
          supabaseService
            .from('import_location_fetch')
            .update({ fetch_complete: complete, updated_at: new Date().toISOString() })
            .eq('location_id', locSlug)

        const fetchEntityResumable = async (entity: string, query: string) => {
          // Location-keyed skip: if a prior job already finished this entity
          // for this location, don't re-fetch — reuse the staged rows.
          if (complete[entity]) return
          // Defence-in-depth: allFetchedUpfront gates the token fetch; if
          // control reaches here without a token, something's wrong.
          if (!jobberToken) throw new Error(`internal: jobberToken not initialized (entity=${entity})`)
          const token = jobberToken   // narrowed const — closures below keep the non-null type
          let cursor: string | null = cursors[entity] || null
          for (;;) {
            const vars = cursor ? { after: cursor } : {}
            const res = await jobberQueryThrottled(jobberToken, query, vars, { onThrottlePause })
            if (res.errors?.some((e: any) => e.extensions?.code !== 'THROTTLED')) {
              throw new Error(`${entity} error: ${JSON.stringify(res.errors)}`)
            }
            const page = res.data?.[entity]
            if (!page) break
            // Jobs can out-page their nested invoices connection (first: 10
            // in JOBS_QUERY) — drain the remainder before the node is staged,
            // so everything downstream (upserts, stage classification) sees
            // the full invoice set.
            if (entity === 'jobs') {
              for (const j of page.nodes) {
                if (j.invoices?.pageInfo?.hasNextPage) {
                  await drainJobInvoices(
                    (q, v) => jobberQueryThrottled(token, q, v, { onThrottlePause }),
                    j,
                  )
                }
              }
            }
            if (page.nodes.length) {
              // Upsert with dedup: crash-in-window recovery, a resuming job,
              // or a rival segment that briefly overlapped can safely re-stage
              // the same page — onConflict on (location_id, entity, node_id)
              // makes duplicates no-ops.
              await supabaseService
                .from('import_staging')
                .upsert(
                  page.nodes.map((n: any) => ({ job_id: jobId, location_id: locSlug, entity, node: n })),
                  { onConflict: 'location_id,entity,node_id', ignoreDuplicates: true },
                )
            }
            cursor = page.pageInfo.endCursor
            cursors[entity] = cursor
            await persistCursors()
            if (!page.pageInfo.hasNextPage) { complete[entity] = true; break }
            if (timeLow()) break   // checkpoint: resume this entity next segment
            if (devMode && entity === 'clients') { complete[entity] = true; break }  // dev-mode first-page cap
          }
          await persistComplete()
        }

        await updateProgress(jobId, { phase: 'fetching clients' })
        await fetchEntityResumable('clients', CLIENTS_QUERY)
        if (!timeLow()) { await updateProgress(jobId, { phase: 'fetching requests' }); await fetchEntityResumable('requests', REQUESTS_QUERY) }
        if (!timeLow()) { await updateProgress(jobId, { phase: 'fetching quotes' });   await fetchEntityResumable('quotes',   QUOTES_QUERY) }
        if (!timeLow()) { await updateProgress(jobId, { phase: 'fetching jobs' });     await fetchEntityResumable('jobs',     JOBS_QUERY) }

        const allFetched = ['clients', 'requests', 'quotes', 'jobs'].every(e => complete[e])
        if (!allFetched) {
          const doneCount = ['clients', 'requests', 'quotes', 'jobs'].filter(e => complete[e]).length
          await updateProgress(jobId, {
            status: 'running',
            phase: `fetching — continuing (${doneCount}/4 entities)`,
          })
          await releaseMutex()
          emit({ continue: true, job_id: jobId })
          selfContinue()
          return
        }

        // ─── load staged nodes back into memory for the write loop ────
        // Query by LOCATION, not job — the unique index on
        // (location_id, entity, node_id) guarantees no duplicates across
        // however many prior jobs contributed to the staging pool.
        const loadStaged = async (entity: string): Promise<any[]> => {
          const out: any[] = []
          let from = 0
          for (;;) {
            const { data } = await supabaseService
              .from('import_staging')
              .select('node')
              .eq('location_id', locSlug)
              .eq('entity', entity)
              .range(from, from + 999)
            if (!data?.length) break
            out.push(...data.map((r: any) => r.node))
            if (data.length < 1000) break
            from += 1000
          }
          return out
        }
        const clients  = await loadStaged('clients')
        const requests = await loadStaged('requests')
        const quotes   = await loadStaged('quotes')
        const jobs     = await loadStaged('jobs')

        // Sort newest-first so that if Vercel kills the function before the write loop
        // finishes, recent clients are written before stale ones (Bug B: new leads missing).
        clients.sort((a: any, b: any) =>
          new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
        )
        console.log(`[jobber-import] fetched ${clients.length} clients; newest: ${clients[0]?.createdAt ?? 'n/a'}, oldest: ${clients[clients.length - 1]?.createdAt ?? 'n/a'}`)

        // ─── RESUME SUPPORT ──────────────────────────────────────────
        // Load jobber_client_ids already written for this location BEFORE
        // building lookup maps. Filtering to `unwritten` up front means:
        //   * the map-building loop only indexes children of unwritten clients
        //     (cheaper on resumes: 216 unwritten out of 1616 → 1400 skipped rows
        //     don't get iterated during map construction)
        //   * the write loop iterates only unwritten (no more wasted budget
        //     scanning-and-skipping the already-done prefix)
        // Paginate in 1000-row chunks — Supabase's default range cap is 1000,
        // so a single query silently truncates when leads > 1000 (root cause of
        // Portland stuck-at-1400: alreadyWritten.size capped at 1000, making
        // 400 already-written leads look unwritten every segment → infinite loop).
        const alreadyWritten = new Set<string>()
        {
          const PAGE = 1000
          let from = 0
          while (true) {
            const { data: page, error: pageErr } = await supabaseService
              .from('leads')
              .select('jobber_client_id')
              .eq('location_uuid', locUuid)
              .not('jobber_client_id', 'is', null)
              .range(from, from + PAGE - 1)
            if (pageErr) throw new Error(`alreadyWritten load failed: ${pageErr.message}`)
            for (const r of page ?? []) if (r.jobber_client_id) alreadyWritten.add(String(r.jobber_client_id))
            if (!page || page.length < PAGE) break
            from += PAGE
          }
        }
        const unwritten = selectUnwrittenClients(clients, alreadyWritten)
        console.log(`[jobber-import] ${alreadyWritten.size} already written, ${unwritten.length} unwritten this segment`)
        // TEMP DIAGNOSTIC — remove after Portland stuck-at-1400 investigation.
        console.log(`[import-debug] clients loaded: ${clients.length}, alreadyWritten: ${alreadyWritten.size}, unwritten: ${unwritten.length}`)
        console.log(`[import-debug] sample client.id: ${JSON.stringify(clients[0]?.id)}, extractJobberId: ${extractJobberId(clients[0]?.id)}`)
        console.log(`[import-debug] sample alreadyWritten values: ${JSON.stringify(Array.from(alreadyWritten).slice(0, 3))}`)
        { const _sampleId = extractJobberId(clients[0]?.id); console.log('[import-debug] is sample client in alreadyWritten?', _sampleId !== null && alreadyWritten.has(_sampleId)) }

        // Set total_records to the FULL staged count so the "X of Y" UI still
        // shows overall progress. processed starts at alreadyWritten.size below.
        await updateProgress(jobId, {
          phase: 'writing',
          total_records: clients.length,
        })

        // ─── build lookup maps (unwritten-only) ────────────────────
        // Keying by unwritten client ids means requests/quotes/jobs for
        // already-imported clients aren't indexed — saves memory and speeds
        // up the map-building sweep on resume segments.
        const unwrittenClientIds = new Set(unwritten.map((c: any) => c.id))
        const reqByClient: Record<string, any[]> = {}
        const quotesByReq: Record<string, any[]> = {}
        const jobsByReq:   Record<string, any[]> = {}
        // Requestless quotes/jobs (created directly on a client in Jobber,
        // no service request) join by client{id} instead — they used to be
        // fetched, staged, then silently dropped here, leaving the client
        // with zero history (the requestless-import gap).
        const reqlessQuotesByClient: Record<string, any[]> = {}
        const reqlessJobsByClient:   Record<string, any[]> = {}

        for (const r of requests) {
          const cid = r.client?.id
          if (cid && unwrittenClientIds.has(cid)) (reqByClient[cid] ||= []).push(r)
        }
        const reqIds = new Set<string>()
        for (const arr of Object.values(reqByClient)) {
          for (const r of arr) reqIds.add(r.id)
        }
        for (const q of quotes) {
          const rid = q.request?.id
          if (rid) {
            if (reqIds.has(rid)) (quotesByReq[rid] ||= []).push(q)
          } else {
            const cid = q.client?.id
            if (cid && unwrittenClientIds.has(cid)) (reqlessQuotesByClient[cid] ||= []).push(q)
          }
        }
        for (const j of jobs) {
          const rid = j.request?.id
          if (rid) {
            if (reqIds.has(rid)) (jobsByReq[rid] ||= []).push(j)
          } else {
            const cid = j.client?.id
            if (cid && unwrittenClientIds.has(cid)) (reqlessJobsByClient[cid] ||= []).push(j)
          }
        }

        // ─── set _has* flags so determineStage works on flat queries ──
        // Decorate only requests we'll actually process (belonging to unwritten
        // clients). Same output as decorating everything, but skips dead work.
        for (const arr of Object.values(reqByClient)) {
          for (const r of arr) {
            const reqJobs = jobsByReq[r.id] || []
            r._hasQuote      = (quotesByReq[r.id] || []).length > 0
            r._hasJob        = reqJobs.length > 0
            r._hasInvoice    = reqJobs.some((j: any) => (j.invoices?.nodes || []).length > 0)
            r._hasAssessment = !!r.assessment
          }
        }

        const stats = {
          leads_created: 0, leads_updated: 0,
          requests_created: 0, requests_updated: 0,
          requests_by_stage: {} as Record<string, number>,
          assessments_created: 0, assessments_updated: 0,
          quotes_created: 0, quotes_updated: 0,
          jobs_created: 0, jobs_updated: 0,
          invoices_created: 0, invoices_updated: 0,
          marked_junk: 0,      // no contact info + no history → is_junk
          auto_closed_won: 0,  // paid + complete, nothing pending after
          engagements_founded: 0,  // step-3 dual-write (additive)
          engagement_errors: 0,
          errors: [] as string[],
        }

        // Two brakes so a heavy chunk never gets hard-killed mid-record at the
        // 800s Vercel wall (which skips the finally/releaseMutex and strands
        // the job — the stalled-Scottsdale bug):
        //   - WRITE_BATCH_CAP: fixed ceiling on records per invocation.
        //   - timeLow(): the SAME wall-clock guard the fetch phase uses. 400
        //     nested client-writes (each = lead + requests/quotes/jobs/invoices
        //     + engagement founding) can outrun the budget on their own, so we
        //     also yield on elapsed time, not just count. On a fresh 1616-client
        //     run this batches; a resume with 216 unwritten finishes in one go.
        const WRITE_BATCH_CAP = 400
        let wroteThisRun = 0
        let hitCap = false
        let yieldReason = ''

        // processed counts against clients.length (not unwritten.length) so
        // the UI's X-of-Y bee animation reflects overall progress including
        // prior segments' work.
        let processed = alreadyWritten.size
        for (const client of unwritten) {
          // Stop this invocation on batch-cap OR low wall-clock time — the
          // sweeper + selfContinue re-poke to continue from the persisted
          // cursor. Checked BEFORE each record so we never die mid-write.
          const yieldNow = writeLoopShouldYield(wroteThisRun, WRITE_BATCH_CAP, timeLow())
          if (yieldNow.stop) { hitCap = true; yieldReason = yieldNow.reason; break }

          try {
            const { id: leadId, created } = await upsertLead(client, locSlug, locUuid, {
              importSource: 'jobber_initial',
            })
            created ? stats.leads_created++ : stats.leads_updated++

            for (const request of (reqByClient[client.id] || [])) {
              // promoteLead:false — lead.stage is now set explicitly by
              // determineLeadStage after all sub-records are written (below),
              // so the per-SR forward-only promotion would just churn writes.
              // The SR row's own stage still comes from determineStage.
              const reqResult = await upsertServiceRequest(request, leadId, locSlug, { promoteLead: false })
              reqResult.created ? stats.requests_created++ : stats.requests_updated++
              stats.requests_by_stage[reqResult.stage] = (stats.requests_by_stage[reqResult.stage] || 0) + 1
              const reqDbId = reqResult.id

              // Child DB ids for the engagement pass below (step-3 dual-write).
              const engAssessmentIds: string[] = []
              if (request.assessment?.startAt) {
                const aRes = await upsertAssessment(request, reqDbId, leadId, locSlug)
                aRes.created ? stats.assessments_created++ : stats.assessments_updated++
                engAssessmentIds.push(aRes.id)
              }
              const engQuoteIds: string[] = []
              const engJobIds: string[] = []
              const engInvoiceIds: string[] = []
              let engJobTitle: string | null = null
              for (const quote of (quotesByReq[request.id] || [])) {
                const qRes = await upsertQuote(quote, reqDbId, leadId, locSlug)
                qRes.created ? stats.quotes_created++ : stats.quotes_updated++
                engQuoteIds.push(qRes.id)
              }
              for (const job of (jobsByReq[request.id] || [])) {
                const jRes = await upsertJob(job, reqDbId, leadId, locSlug)
                jRes.created ? stats.jobs_created++ : stats.jobs_updated++
                engJobIds.push(jRes.id)
                if (!engJobTitle && job.title?.trim()) engJobTitle = job.title.trim()
                for (const inv of (job.invoices?.nodes || [])) {
                  const iRes = await upsertInvoice(inv, jRes.id, reqDbId, leadId, locSlug)
                  iRes.created ? stats.invoices_created++ : stats.invoices_updated++
                  engInvoiceIds.push(iRes.id)
                  // Lead roll-up for historical paid invoices — mirrors the
                  // INVOICE_PAID webhook denorm (paid_amount / balance_owing /
                  // invoice_paid_at) but deliberately does NOT promote stage
                  // to Closed Won or touch drips: stage was already inferred
                  // by determineStage and imported leads are paused. Paid
                  // invoices predating the import never emit a webhook, so
                  // this is the only place they can populate the roll-up.
                  if (iRes.status === 'paid') {
                    const paidTotal = inv.amounts?.total ? parseFloat(inv.amounts.total) : null
                    await supabaseService
                      .from('leads')
                      .update({
                        paid_amount: paidTotal,
                        balance_owing: 0,
                        invoice_paid_at: inv.createdAt || new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      })
                      .eq('id', leadId)
                  }
                }
              }

              // ─── dual-write: engagements (step 3, additive) ──
              // Every SR founds one engagement (rule 1); this request's
              // children attach to it; stage derives in backfill mode (§5
              // stale rules, silent). Failures are counted and logged but
              // never break the import — leads.stage below stays the
              // board's authority until the step-4 read flip.
              try {
                const ens = await ensureEngagementForServiceRequest(reqDbId, leadId, { title: engJobTitle })
                if (ens) {
                  if (ens.created) stats.engagements_founded++
                  for (const aid of engAssessmentIds) await attachToEngagement('assessments', aid, ens.id)
                  for (const qid of engQuoteIds) await attachToEngagement('quotes', qid, ens.id)
                  for (const jid of engJobIds) await attachToEngagement('jobs', jid, ens.id)
                  for (const iid of engInvoiceIds) await attachToEngagement('invoices', iid, ens.id)
                  await maybeAdvanceEngagementStage(ens.id, { mode: 'backfill' })
                } else {
                  stats.engagement_errors++
                }
              } catch (err: any) {
                stats.engagement_errors++
                console.error('[engagements] import dual-write failed', err?.message || err)
              }
            }

            // ─── requestless quotes/jobs (no service request in Jobber) ──
            // Written with service_request_id null; engagements resolve via
            // resolveEngagementForChild (rule 5 founds when no open
            // engagement exists — never the SR-founding path). Quotes first
            // so a requestless job's Job.quote link (resolved inside
            // upsertJob) can find its quote row.
            for (const quote of (reqlessQuotesByClient[client.id] || [])) {
              const qRes = await upsertQuote(quote, null, leadId, locSlug)
              qRes.created ? stats.quotes_created++ : stats.quotes_updated++
              try {
                const engId = await resolveEngagementForChild({
                  childTable: 'quotes',
                  childId: qRes.id,
                  leadId,
                  locationSlug: locSlug,
                })
                if (engId) {
                  await attachToEngagement('quotes', qRes.id, engId)
                  await maybeAdvanceEngagementStage(engId, { mode: 'backfill' })
                }
              } catch (err: any) {
                stats.engagement_errors++
                console.error('[engagements] requestless quote dual-write failed', err?.message || err)
              }
            }
            for (const job of (reqlessJobsByClient[client.id] || [])) {
              const jRes = await upsertJob(job, null, leadId, locSlug)
              jRes.created ? stats.jobs_created++ : stats.jobs_updated++
              const rlInvoiceIds: string[] = []
              for (const inv of (job.invoices?.nodes || [])) {
                const iRes = await upsertInvoice(inv, jRes.id, null, leadId, locSlug)
                iRes.created ? stats.invoices_created++ : stats.invoices_updated++
                rlInvoiceIds.push(iRes.id)
                // Same historical-paid roll-up as the request-joined path.
                if (iRes.status === 'paid') {
                  const paidTotal = inv.amounts?.total ? parseFloat(inv.amounts.total) : null
                  await supabaseService
                    .from('leads')
                    .update({
                      paid_amount: paidTotal,
                      balance_owing: 0,
                      invoice_paid_at: inv.createdAt || new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    })
                    .eq('id', leadId)
                }
              }
              try {
                const engId = await resolveEngagementForChild({
                  childTable: 'jobs',
                  childId: jRes.id,
                  leadId,
                  quoteDbId: jRes.quote_db_id ?? null,
                  title: job.title || null,
                  locationSlug: locSlug,
                })
                if (engId) {
                  await attachToEngagement('jobs', jRes.id, engId)
                  for (const iid of rlInvoiceIds) await attachToEngagement('invoices', iid, engId)
                  await maybeAdvanceEngagementStage(engId, { mode: 'backfill' })
                }
              } catch (err: any) {
                stats.engagement_errors++
                console.error('[engagements] requestless job dual-write failed', err?.message || err)
              }
            }

            // ─── lead-level stage classification ──
            // Now that every sub-record is written, classify the lead from
            // its full history (latest engagement wins) and write the stage
            // explicitly. Junk flag is one-way: set when unreachable+empty,
            // never cleared here (an owner-junked lead stays junked).
            // Deliberately NOT touched: paused, drips, webhook stage logic.
            const clientReqs     = reqByClient[client.id] || []
            // Requestless quotes/jobs count toward the stage derivation too —
            // clientInvoices derives from clientJobs, so requestless jobs'
            // nested invoices ride along automatically.
            const clientQuotes   = [
              ...clientReqs.flatMap((r: any) => quotesByReq[r.id] || []),
              ...(reqlessQuotesByClient[client.id] || []),
            ]
            const clientJobs     = [
              ...clientReqs.flatMap((r: any) => jobsByReq[r.id] || []),
              ...(reqlessJobsByClient[client.id] || []),
            ]
            const clientInvoices = clientJobs.flatMap((j: any) => j.invoices?.nodes || [])
            const leadEmail = client.emails?.find((e: any) => e.primary)?.address ?? client.emails?.[0]?.address ?? null
            const leadPhone = client.phones?.find((p: any) => p.primary)?.number  ?? client.phones?.[0]?.number  ?? null
            const { stage: leadStage, isJunk } = determineLeadStage({
              email: leadEmail,
              phone: leadPhone,
              clientCreatedAt: client.createdAt || null,
              requests: clientReqs,
              quotes: clientQuotes,
              jobs: clientJobs,
              invoices: clientInvoices,
            })
            const stagePatch: Record<string, any> = {
              stage: leadStage,
              updated_at: new Date().toISOString(),
            }
            if (isJunk) stagePatch.is_junk = true
            await supabaseService.from('leads').update(stagePatch).eq('id', leadId)
            if (isJunk) stats.marked_junk++
            if (leadStage === 'Closed Won') stats.auto_closed_won++
          } catch (err: any) {
            stats.errors.push(`${client.firstName} ${client.lastName}: ${err.message}`)
          }
          processed++
          wroteThisRun++
          if (processed % 50 === 0 || processed === clients.length) {
            // Refresh location_claim_at alongside the progress write so the
            // cron sweeper doesn't classify this segment as stale mid-loop
            // (a long segment that takes >2 min would otherwise get a rival
            // POST from the sweeper — the atomic claim rejects it, but this
            // avoids the wasted invocation entirely).
            await supabaseService
              .from('import_jobs')
              .update({
                processed_records: processed,
                location_claim_at: new Date().toISOString(),
              })
              .eq('id', jobId)
          }
        }

        if (hitCap) {
          // More clients remain — persist progress, RELEASE THE MUTEX (nulls
          // segment_started_at + location_claim_at so the next segment can
          // claim immediately), then self-continue. Same graceful hand-off
          // whether we stopped on the batch cap or the time budget.
          await updateProgress(jobId, {
            status: 'running',
            phase: `batched — ${processed}/${clients.length}, continuing (${yieldReason})`,
            processed_records: processed,
            total_records: clients.length,
          })
          await releaseMutex()
          emit({ continue: true, processed, total: clients.length, reason: yieldReason, job_id: jobId })
          selfContinue()
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
            // Lazy-fetch the token here: if the segment was write-only
            // (allFetchedUpfront=true), we skipped the initial token refresh.
            // The incremental pass needs Jobber, so grab it now — throw
            // falls into the existing non-fatal catch below.
            if (!jobberToken) {
              jobberToken = await getValidJobberToken(location)
            }
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
            `Marked junk (no contact info): ${stats.marked_junk}; ` +
            `Auto-closed Won (paid + complete): ${stats.auto_closed_won}; ` +
            `Engagements founded: ${stats.engagements_founded} (${stats.engagement_errors} errors); ` +
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

        // Staging + per-location fetch state are only useful while an import
        // is running — drop everything for this LOCATION once we finish so
        // the next full import starts fresh (Jobber webhooks handle deltas
        // between imports; this table is a one-shot bulk staging area).
        try {
          await supabaseService.from('import_staging').delete().eq('location_id', locSlug)
        } catch (err) {
          console.error('[import_staging cleanup failed]', err)
        }
        try {
          await supabaseService.from('import_location_fetch').delete().eq('location_id', locSlug)
        } catch (err) {
          console.error('[import_location_fetch cleanup failed]', err)
        }
        await releaseMutex()

        // One-time gate: mark initial import done. Set even when some rows
        // errored — webhook sync handles missed records going forward, and
        // re-running the bulk import is idempotent (upserts dedupe on
        // jobber_*_id). This write FAILS LOUD (writeImportCompletionStamp
        // inspects the returned error + retries) so a completed-but-unstamped
        // import can never silently keep the "Start Import" CTA up again.
        const stamp = await writeImportCompletionStamp(locUuid, {
          label: `${location.name} (${locSlug}) job=${jobId}`,
        })
        if (!stamp.ok) {
          // Every record landed but the gate never set — the location still
          // shows "Start Import" over finished data. Surface it on the job so
          // it reads as needing attention, not clean success (mirrors the
          // completed + error_message convention used for row errors above).
          await updateProgress(jobId, {
            error_message:
              `Import completed but the completion-stamp write FAILED — ` +
              `${location.name} (${locSlug}) is unstamped and will still show "Start Import". ` +
              `Set locations.jobber_initial_import_completed_at manually. Cause: ${stamp.error}`,
          })
        }

        // 2️⃣ final chunk: summary
        emit({
          done: true,
          success: stamp.ok,
          ...(stamp.ok ? {} : { stamp_failed: true, stamp_error: stamp.error }),
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
        await releaseMutex()
        emit({ error: String(err?.message || err), job_id: jobId })
      }
      // no finally/controller.close needed — nothing is streaming
  }

  // Launch detached; return job_id immediately so the connection closes fast.
  waitUntil(runImport())
  return NextResponse.json({ job_id: jobId, started: true })
}
