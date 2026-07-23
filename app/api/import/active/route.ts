// app/api/import/active/route.ts
//
// GET endpoint to find an in-flight import for a location, so the UI can
// resume polling after a page reload (the job runs server-side via waitUntil
// and survives the client losing its jobId state).
//
// ?location_id= accepts UUID (locations.id) or slug (locations.location_id),
// same flex lookup as /api/import/jobber-clients. Returns { job: row | null }
// where row has the same fields the status route returns.
//
// When no job is running, the response also carries client_count — a cheap
// { clients { totalCount } } Jobber query — so the import prompts can show
// a pre-flight time estimate before the user clicks Start. Best-effort:
// any failure (no token, throttle, schema without totalCount) yields
// client_count: null and the UI falls back to a static line. A failed
// count must never block importing.
//
// Auth pattern mirrors /api/import/status/[jobId]:
//   - must be signed in (401 otherwise)
//   - must have a hub_users profile (403 otherwise)
//   - if role==='owner', the requested location must be the owner's location

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getValidJobberToken, jobberQuery } from '@/lib/jobber'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
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

  const input = req.nextUrl.searchParams.get('location_id')
  if (!input) return NextResponse.json({ error: 'location_id required' }, { status: 400 })

  // ─── resolve location (UUID or slug → row) ──
  // Full row: getValidJobberToken (count fetch below) needs the token +
  // expiry columns, same as the import route's lookupLocation.
  const field = UUID_RE.test(input) ? 'id' : 'location_id'
  const { data: location } = await supabaseService
    .from('locations')
    .select('*')
    .eq(field, input)
    .maybeSingle()
  if (!location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  // ─── owner ownership check ──
  if (hubUser.role === 'owner' && hubUser.location_id !== location.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // ─── most recent running job for this location ──
  // import_jobs.location_id stores the slug. A PARKED sample-now/bulk-later
  // job is still status='running' (resume_after in the future), so it comes
  // back here too — that's what feeds the gap-state UI (onboarding step,
  // Settings card, and the ImportGapBanner on Home/Clients).
  const { data: job } = await supabaseService
    .from('import_jobs')
    .select(
      'id, status, phase, processed_records, total_records, error_message, started_at, completed_at, resume_after, location_id',
    )
    .eq('location_id', location.location_id)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!job) {
    // Overnight-completion signal for the gap banner's success state: the
    // most recent completed job that had been parked (resume_after non-null),
    // finished within the last 36h. The banner shows "All N clients imported
    // overnight" on next login, dismissible client-side.
    let recentDeferred: any = null
    {
      const sinceIso = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
      const { data: rd } = await supabaseService
        .from('import_jobs')
        .select('id, processed_records, total_records, completed_at')
        .eq('location_id', location.location_id)
        .eq('type', 'jobber_clients')
        .eq('status', 'completed')
        .not('resume_after', 'is', null)
        .gte('completed_at', sinceIso)
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      recentDeferred = rd ?? null
    }

    // Pre-flight count for the import prompt's time estimate. One cheap
    // GraphQL request (no nodes selected — trivial complexity cost).
    // NOTE: not yet verified that our Jobber API version exposes
    // clients.totalCount — hence the blanket try/catch: any error or
    // unexpected shape degrades to null, never a failed response.
    // ?skip_count=1 (the gap banner's periodic poll) skips the Jobber
    // round-trip entirely — the banner never needs the estimate, and a
    // background poll must not burn Jobber rate budget.
    let clientCount: number | null = null
    const skipCount = req.nextUrl.searchParams.get('skip_count') === '1'
    if (!skipCount && location.jobber_access_token) {
      try {
        const token = await getValidJobberToken(location)
        const res = await jobberQuery(token, '{ clients { totalCount } }')
        const n = res?.data?.clients?.totalCount
        if (typeof n === 'number' && Number.isFinite(n)) clientCount = n
      } catch (err: any) {
        console.warn('[import-active] client count fetch failed (non-fatal):', err?.message || err)
      }
    }
    return NextResponse.json({ job: null, client_count: clientCount, recent_deferred: recentDeferred })
  }

  // Strip location_id from response — internal field, not for the UI.
  const { location_id: _omit, ...rest } = job
  return NextResponse.json({ job: rest })
}
