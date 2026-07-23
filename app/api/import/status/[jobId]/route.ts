// app/api/import/status/[jobId]/route.ts
//
// GET endpoint to poll an in-progress (or completed) import_jobs row.
// The UI polls this every 2s while an import runs.
//
// Auth pattern mirrors /api/import/jobber-clients:
//   - must be signed in (401 otherwise)
//   - must have a hub_users profile (403 otherwise)
//   - if role==='owner', the job's location must match the owner's location

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } },
) {
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

  // ─── read job ──
  // resume_after: non-null + future = a parked sample-now/bulk-later job —
  // the pollers stop auto-continuing and render the parked/gap state.
  const { data: job } = await supabaseService
    .from('import_jobs')
    .select(
      'id, status, phase, processed_records, total_records, error_message, started_at, completed_at, resume_after, location_id',
    )
    .eq('id', params.jobId)
    .maybeSingle()

  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // ─── owner ownership check ──
  // hub_users.location_id is UUID; import_jobs.location_id is slug.
  // Resolve the owner's slug and compare.
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

  // Strip location_id from response — it's an internal field, not for the UI.
  const { location_id: _omit, ...rest } = job
  return NextResponse.json(rest)
}
