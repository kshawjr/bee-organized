// lib/location-zips-admin.ts
// Shared by app/api/admin/location-zips (+ ./resolve): the corporate gate and
// the "may a zip point here" check. Route files may only export handlers, so
// these live here.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { ZIP_FALLBACK_SLUG } from '@/lib/zip-routing'

const ALLOWED_ROLES = ['super_admin', 'admin']

export async function requireCorporate(): Promise<
  { ok: true; userId: string } | { ok: false; res: NextResponse }
> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  }
  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller || !ALLOWED_ROLES.includes(caller.role)) {
    return { ok: false, res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  }
  return { ok: true, userId: user.id }
}

// A location a zip may point at: real, and never the loc_other holding pen.
export async function loadTargetLocation(locationUuid: unknown) {
  if (typeof locationUuid !== 'string' || !locationUuid) return { error: 'location_uuid required' as const }
  const { data, error } = await supabaseService
    .from('locations')
    .select('id, name, location_id, lifecycle_status')
    .eq('id', locationUuid)
    .maybeSingle()
  if (error) return { error: 'location_lookup_failed' as const, detail: error.message }
  if (!data) return { error: 'location_not_found' as const }
  if (data.location_id === ZIP_FALLBACK_SLUG) return { error: 'cannot_assign_to_loc_other' as const }
  return { location: data }
}
