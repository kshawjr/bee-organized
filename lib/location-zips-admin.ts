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

// ─── The whole list, paged ─────────────────────────────────────
// Supabase caps EVERY response at 1,000 rows (the project's max-rows setting),
// whatever .range() asks for. The first version of this read asked for
// .range(0, 9999), got 1,000 of 1,546 and the screen said "1,000 zips · 34
// locations · 0 in conflict", so the conflict card (the reason the screen
// exists) was empty. So: pages of ZIP_PAGE until a page comes back short, the
// same short-page loop as app/_hub-page.tsx's leads load. Ordered by
// (zip, id) so pages never overlap or skip: zip alone is not unique.
//
// `total` is the exact count taken on the first page. A read that ends short
// of it (a row deleted mid-read is the only honest cause) is returned as-is
// with the true total, and the screen says so rather than showing a quiet
// subset.
//
// This is ONLY the admin list. Intake's routing lookup filters to one zip in
// the database (lib/zip-routing.ts) and is never near the cap.
export const ZIP_PAGE = 1000
const ZIP_READ_CEILING = 50_000 // runaway guard; the list is ~1.5k today

export async function fetchAllLocationZips(): Promise<
  { rows: any[]; total: number } | { error: string }
> {
  const rows: any[] = []
  let total: number | null = null
  // Advance by what ACTUALLY came back, and stop on the exact count — so a
  // server cap below ZIP_PAGE can't masquerade as the end of the list.
  while (rows.length < ZIP_READ_CEILING) {
    const from = rows.length
    const { data, error, count } = await supabaseService
      .from('location_zips')
      .select('id, zip, location_uuid, updated_at', from === 0 ? { count: 'exact' } : undefined)
      .order('zip', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + ZIP_PAGE - 1)
    if (error) return { error: error.message }
    if (from === 0) total = typeof count === 'number' ? count : null
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length === 0) break
    if (total !== null ? rows.length >= total : page.length < ZIP_PAGE) break
  }
  return { rows, total: total ?? rows.length }
}
