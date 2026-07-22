// app/api/import/cancel/route.ts
//
// POST endpoint to CANCEL a running import. Before this existed, a stuck
// job spun forever with no UI exit — the Scottsdale/Leslie trap. Cancelling
// marks the job 'failed' and releases BOTH mutexes (segment_started_at +
// location_claim_at), so the UI falls to the existing "Try again" path and
// the job is immediately resumable.
//
// Safe mid-run: cancelling a LIVE segment does not corrupt data. Already-
// written rows stay (all child writes are idempotent onConflict upserts), and
// the running segment stops cooperatively — its next progress checkpoint runs
// a status='running'-guarded update, sees zero rows once we've flipped status,
// releases its mutex, and returns without marking the job completed.
//
// Auth mirrors /api/import/status/[jobId]:
//   - must be signed in (401 otherwise)
//   - must have a hub_users profile (403 otherwise)
//   - if role==='owner', the job's location must match the owner's location
//
// Body/query: { job_id }  (query param wins, same convention as the import
// route). We resolve the job first so the owner ownership check has a
// location to compare against.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

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

  // ─── input (query wins, fall back to JSON body) ──
  const url = new URL(req.url)
  let body: any = {}
  try { body = await req.json() } catch { /* no body is fine */ }
  const jobId = url.searchParams.get('job_id') || body.job_id
  if (!jobId) return NextResponse.json({ error: 'job_id required' }, { status: 400 })

  // ─── resolve job ──
  const { data: job } = await supabaseService
    .from('import_jobs')
    .select('id, status, location_id')
    .eq('id', jobId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // ─── owner ownership check ──
  // hub_users.location_id is UUID; import_jobs.location_id is slug.
  if (hubUser.role === 'owner') {
    const { data: ownerLoc } = await supabaseService
      .from('locations')
      .select('location_id')
      .eq('id', hubUser.location_id)
      .maybeSingle()
    if (!ownerLoc || ownerLoc.location_id !== job.location_id) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  // Already terminal — nothing to cancel. Idempotent: return ok so a
  // double-click (or a race with natural completion) isn't an error.
  if (job.status !== 'running') {
    return NextResponse.json({ ok: true, job_id: jobId, status: job.status, already_terminal: true })
  }

  // ─── cancel: mark failed + release BOTH mutexes ──
  // Guarded on status='running' so we never clobber a job that completed
  // between the read above and this write. Nulling segment_started_at +
  // location_claim_at is what makes the job resumable (the next POST's claim
  // can acquire immediately). No data is deleted — staging + already-written
  // rows remain, so a resume continues from where it stopped.
  const { data: cancelled } = await supabaseService
    .from('import_jobs')
    .update({
      status: 'failed',
      error_message: 'Cancelled by user',
      completed_at: new Date().toISOString(),
      segment_started_at: null,
      location_claim_at: null,
    })
    .eq('id', jobId)
    .eq('status', 'running')
    .select('id')

  if (!cancelled || cancelled.length === 0) {
    // Lost the race to a natural terminal transition — report the current state.
    const { data: now } = await supabaseService
      .from('import_jobs')
      .select('status')
      .eq('id', jobId)
      .maybeSingle()
    return NextResponse.json({ ok: true, job_id: jobId, status: now?.status ?? 'unknown', already_terminal: true })
  }

  return NextResponse.json({ ok: true, job_id: jobId, status: 'failed', cancelled: true })
}
