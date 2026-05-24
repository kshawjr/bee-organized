// app/api/locations/[id]/jobber-test/route.ts
//
// GET /api/locations/[id]/jobber-test
// Diagnostic endpoint: runs `{ account { id name } }` against Jobber for a
// specific location. Confirms token refresh + GraphQL wrapper works end-to-end.
//
// [id] accepts either UUID (locations.id) or slug (locations.location_id).
// Auth: super_admin OR the owner of this specific location.

import { NextRequest, NextResponse } from 'next/server'
import { getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { jobberGraphQL } from '@/lib/jobber'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const hubUser = await getHubUser()
  if (!hubUser) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const input = params.id
  const field = UUID_RE.test(input) ? 'id' : 'location_id'
  const { data: location, error: locErr } = await supabaseService
    .from('locations')
    .select('id, location_id, name, jobber_connected, jobber_access_token')
    .eq(field, input)
    .maybeSingle()

  if (locErr || !location) {
    return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  }

  // hub_users.location_id stores the UUID, matching locations.id
  const isOwner = hubUser.location_id === location.id
  if (hubUser.role !== 'super_admin' && !isOwner) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (!location.jobber_access_token) {
    return NextResponse.json(
      {
        location_id: location.location_id,
        location_name: location.name,
        jobber_connected: location.jobber_connected,
        error: 'location_not_connected_to_jobber',
      },
      { status: 400 },
    )
  }

  try {
    const { data, errors } = await jobberGraphQL(
      location.location_id,
      '{ account { id name } }',
    )
    return NextResponse.json({
      location_id: location.location_id,
      location_name: location.name,
      jobber_connected: location.jobber_connected,
      data,
      errors: errors ?? null,
    })
  } catch (err: any) {
    return NextResponse.json(
      {
        location_id: location.location_id,
        location_name: location.name,
        error: 'graphql_failed',
        message: err?.message || String(err),
      },
      { status: 502 },
    )
  }
}
