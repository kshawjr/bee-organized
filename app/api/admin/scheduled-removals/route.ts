// app/api/admin/scheduled-removals/route.ts
//
// GET /api/admin/scheduled-removals
// super_admin only — returns a preview list of seats scheduled for
// removal on or before today. Used by the admin UI to show a count
// and item list before the operator confirms processing.
//
// Response: { items: [...], count: number }

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (hubUser?.role !== 'super_admin') {
    return NextResponse.json({ error: 'forbidden — super_admin only' }, { status: 403 })
  }

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD UTC

  // Supabase JS doesn't support joins with aliases in select(), so we run
  // two queries: seats scheduled for removal today or earlier, then enrich
  // with location name and user email from separate lookups.
  const { data: seats, error } = await supabaseService
    .from('subscription_seats')
    .select('id, location_id, tier, scheduled_removal_at, user_id, status')
    .lte('scheduled_removal_at', today)
    .eq('status', 'active')
    .order('scheduled_removal_at', { ascending: true })

  if (error) {
    console.error('[scheduled-removals GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!seats || seats.length === 0) {
    return NextResponse.json({ items: [], count: 0 })
  }

  // Batch-fetch location names
  const locationIds = Array.from(new Set(seats.map((s: any) => s.location_id)))
  const { data: locations } = await supabaseService
    .from('locations')
    .select('id, name')
    .in('id', locationIds)
  const locMap: Record<string, string> = {}
  ;(locations || []).forEach((l: any) => { locMap[l.id] = l.name })

  // Batch-fetch user emails for assigned seats
  const userIds = seats.filter((s: any) => s.user_id).map((s: any) => s.user_id)
  const emailMap: Record<string, string> = {}
  if (userIds.length > 0) {
    const { data: hubUsers } = await supabaseService
      .from('hub_users')
      .select('id, email')
      .in('id', userIds)
    ;(hubUsers || []).forEach((u: any) => { emailMap[u.id] = u.email })
  }

  const items = seats.map((s: any) => ({
    seat_id: s.id,
    location_id: s.location_id,
    location_name: locMap[s.location_id] || s.location_id,
    tier: s.tier,
    scheduled_removal_at: s.scheduled_removal_at,
    user_id: s.user_id || null,
    user_email: s.user_id ? (emailMap[s.user_id] || null) : null,
  }))

  return NextResponse.json({ items, count: items.length })
}
