// app/api/admin/conversions-due/route.ts
//
// Returns corporate-funded locations whose sponsorship is ending soon (or is
// already past due). Used by the Admin → Conversions Due dashboard view.
//
// Query params:
//   days_ahead      — look-ahead window in days (default 30, max 365)
//   include_undated — if 'true', also return corporate_sponsored rows with
//                     NULL ends_at (no fixed end date)
//
// Auth: super_admin / admin only (403 otherwise).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller || !isElevated(caller.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const rawDays = parseInt(searchParams.get('days_ahead') ?? '30', 10)
  const daysAhead = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 0), 365) : 30
  const includeUndated = searchParams.get('include_undated') === 'true'

  const cutoff = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString()

  // Locations where sponsorship ends within the window (including past due)
  const { data: dated, error: datedErr } = await supabaseService
    .from('locations')
    .select('id, name, slug, payment_source, corporate_sponsorship_started_at, corporate_sponsorship_ends_at')
    .in('payment_source', ['prepaid_corporate', 'corporate_sponsored'])
    .not('corporate_sponsorship_ends_at', 'is', null)
    .lte('corporate_sponsorship_ends_at', cutoff)
    .order('corporate_sponsorship_ends_at', { ascending: true })

  if (datedErr) {
    console.error('[conversions-due] dated query error', datedErr)
    return NextResponse.json({ error: datedErr.message }, { status: 500 })
  }

  // Optionally include corporate_sponsored rows with no end date
  let undated: any[] = []
  if (includeUndated) {
    const { data: undatedRows, error: undatedErr } = await supabaseService
      .from('locations')
      .select('id, name, slug, payment_source, corporate_sponsorship_started_at, corporate_sponsorship_ends_at')
      .eq('payment_source', 'corporate_sponsored')
      .is('corporate_sponsorship_ends_at', null)
      .order('name', { ascending: true })

    if (undatedErr) {
      console.error('[conversions-due] undated query error', undatedErr)
      return NextResponse.json({ error: undatedErr.message }, { status: 500 })
    }
    undated = undatedRows ?? []
  }

  const allLocs = [...(dated ?? []), ...undated]

  if (allLocs.length === 0) {
    return NextResponse.json({ items: [], count: 0 })
  }

  // Resolve primary owner for each location
  const locationIds = allLocs.map((l: any) => l.id)
  const { data: ownerRows } = await supabaseService
    .from('hub_users')
    .select('location_id, full_name, email, is_primary_owner')
    .in('location_id', locationIds)
    .eq('role', 'owner')

  // Build a map: location_id → primary owner (or first owner found)
  const ownerMap: Record<string, { name: string; email: string }> = {}
  for (const row of ownerRows ?? []) {
    const loc = row.location_id
    if (!ownerMap[loc] || row.is_primary_owner) {
      ownerMap[loc] = { name: row.full_name || '', email: row.email || '' }
    }
  }

  const now = Date.now()
  const items = allLocs.map((loc: any) => {
    const endsAt = loc.corporate_sponsorship_ends_at
    const daysUntilEnd = endsAt
      ? Math.round((new Date(endsAt).getTime() - now) / (1000 * 60 * 60 * 24))
      : null
    const owner = ownerMap[loc.id]
    return {
      location_id: loc.id,
      name: loc.name,
      slug: loc.slug,
      payment_source: loc.payment_source,
      sponsorship_started_at: loc.corporate_sponsorship_started_at,
      sponsorship_ends_at: endsAt,
      days_until_end: daysUntilEnd,
      owner_name: owner?.name ?? null,
      owner_email: owner?.email ?? null,
    }
  })

  // Undated rows have null days_until_end; keep them after the dated ones
  // (dated rows are already sorted by ends_at ASC from the query).

  return NextResponse.json({ items, count: items.length })
}
