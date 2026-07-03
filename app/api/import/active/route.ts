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
// Auth pattern mirrors /api/import/status/[jobId]:
//   - must be signed in (401 otherwise)
//   - must have a hub_users profile (403 otherwise)
//   - if role==='owner', the requested location must be the owner's location

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'

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
  const field = UUID_RE.test(input) ? 'id' : 'location_id'
  const { data: location } = await supabaseService
    .from('locations')
    .select('id, location_id')
    .eq(field, input)
    .maybeSingle()
  if (!location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  // ─── owner ownership check ──
  if (hubUser.role === 'owner' && hubUser.location_id !== location.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // ─── most recent running job for this location ──
  // import_jobs.location_id stores the slug.
  const { data: job } = await supabaseService
    .from('import_jobs')
    .select(
      'id, status, phase, processed_records, total_records, error_message, started_at, completed_at, location_id',
    )
    .eq('location_id', location.location_id)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!job) return NextResponse.json({ job: null })

  // Strip location_id from response — internal field, not for the UI.
  const { location_id: _omit, ...rest } = job
  return NextResponse.json({ job: rest })
}
