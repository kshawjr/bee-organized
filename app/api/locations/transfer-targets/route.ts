// app/api/locations/transfer-targets/route.ts
//
// GET /api/locations/transfer-targets — corp/admin only.
//
// Feeds the TransferLeadModal's destination picker. Returns every real
// location (loc_other, the global-form holding pen, is excluded — it can
// never be a transfer target) with the two facts the modal must reflect:
//   • lifecycle_status — drives the confirm note. 'active' → "starts the
//     drip"; anything else → the amber "isn't live yet" warning.
//   • owner_name — the friendly "{owner} will be notified" label. Cosmetic;
//     the actual transfer resolves recipients server-side by UUID.
//
// Same isAdmin gate as the transfer endpoint itself: franchise users never
// see loc_other leads, so they never open this picker, but the read is
// gated regardless.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

export const runtime = 'nodejs'

export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }
  if (!isAdmin(hubUser.role)) {
    return NextResponse.json({ error: 'forbidden_admin_only' }, { status: 403 })
  }

  const { data: locations, error: locError } = await supabaseService
    .from('locations')
    .select('id, name, location_id, lifecycle_status')
    .neq('location_id', 'loc_other')
    .order('name', { ascending: true })
  if (locError) {
    return NextResponse.json(
      { error: 'locations_lookup_failed', detail: locError.message },
      { status: 500 },
    )
  }

  const rows = locations ?? []

  // Batch the owner-name lookup rather than N per-location resolver calls —
  // this is a cosmetic label, so the earliest role='owner' hub_users row per
  // location (the resolver's legacy tier) is the right, cheap source.
  // hub_users.location_id holds the location UUID.
  const ownerByLoc = new Map<string, string>()
  const ids = rows.map((l) => l.id)
  if (ids.length > 0) {
    const { data: owners } = await supabaseService
      .from('hub_users')
      .select('location_id, full_name, email, role, created_at')
      .in('location_id', ids)
      .eq('role', 'owner')
      .order('created_at', { ascending: true })
    for (const o of owners ?? []) {
      if (o.location_id && !ownerByLoc.has(o.location_id)) {
        ownerByLoc.set(o.location_id, o.full_name || o.email || '')
      }
    }
  }

  const targets = rows.map((l) => ({
    id:               l.id,
    name:             l.name,
    slug:             l.location_id,
    lifecycle_status: l.lifecycle_status ?? null,
    owner_name:       ownerByLoc.get(l.id) || null,
  }))

  return NextResponse.json({ targets })
}
