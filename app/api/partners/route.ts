// app/api/partners/route.ts
//
// CRUD for the partners table (partners AND contacts — `type` discriminator).
// Backs BeeHub's "Contacts" tab (PartnersScreen) + the lead referral pickers.
//
// Auth model mirrors /api/seats: app-layer checks on top of RLS so failures
// surface as clean 401/403/400 instead of opaque RLS errors.
//   GET  ?location_id=<uuid>  — any hub_user with access to the location
//   POST                       — elevated OR a hub_user at the target location

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import {
  PARTNER_COLS,
  mapPartnerRow,
  partnerPatchToRow,
  loadCaller,
  canReadLocation,
  canWriteLocation,
} from '@/lib/crm'

export const runtime = 'nodejs'

// Pagination bounds for GET. The route used to run with NO .limit(), which
// does not mean "unlimited" — PostgREST's invisible 1,000-row default was the
// ceiling, so past 1,000 partners this list quietly shrank BELOW what the
// Network tab (SSR, paginated) shows, and the two surfaces disagreed with no
// signal. Now: short-page loop to MAX_ROWS, plus an exact count so the
// response can state a truthful total even when it truncates.
const PAGE = 1000
const MAX_ROWS = 5000

// GET /api/partners?location_id=<uuid> — non-deleted partners+contacts, by name.
// Response: { rows, total, truncated } — total is the exact DB count, so a
// truncated response says how many rows exist rather than pretending
// rows.length is all of them. (Shape changed from a bare array 2026-07-23;
// ReferrerPicker, the one GET consumer, reads both.)
//
// GET /api/partners?customer_lead_id=<uuid> — the REVERSE of the client link.
// partners.customer_lead_id points partner → lead and there is no
// leads.partner_id going back, so "does this client also live in my Network?"
// is a query rather than a column read. Deliberately no migration: one link
// column with one owner cannot drift out of sync with itself, where a mirrored
// column on leads would need an invariant nobody maintains. Same response
// shape, and location scoping comes from the ROWS (the caller has a lead id,
// not a location) — a franchise user asking about someone else's client gets
// an empty list, never a 403 that would confirm the row exists.
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const customerLeadId = request.nextUrl.searchParams.get('customer_lead_id')
  if (customerLeadId) {
    const { data, error } = await supabase
      .from('partners')
      .select(PARTNER_COLS)
      .eq('customer_lead_id', customerLeadId)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .range(0, PAGE - 1)
    if (error) {
      console.error('[partners GET by lead]', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const visible = (data || []).filter((r: any) => canReadLocation(caller, r.location_id))
    return NextResponse.json({ rows: visible.map(mapPartnerRow), total: visible.length, truncated: false })
  }

  const locationId = request.nextUrl.searchParams.get('location_id')
  if (!locationId) {
    return NextResponse.json(
      { error: 'location_id or customer_lead_id query param required' },
      { status: 400 }
    )
  }
  if (!canReadLocation(caller, locationId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const rows: any[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from('partners')
      .select(PARTNER_COLS)
      .eq('location_id', locationId)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .range(from, from + PAGE - 1)

    if (error) {
      console.error('[partners GET]', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    rows.push(...(data || []))
    if ((data || []).length < PAGE) break
  }

  let total = rows.length
  const truncated = rows.length >= MAX_ROWS
  if (truncated) {
    // head:true count is the one aggregate PostgREST allows here — see
    // reference_postgrest_aggregates_disabled.
    const { count } = await supabase
      .from('partners')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .is('deleted_at', null)
    if (typeof count === 'number') total = count
    console.warn(`[partners GET] ${locationId} hit the ${MAX_ROWS}-row ceiling (${total} total) — response flagged truncated`)
  }

  return NextResponse.json({ rows: rows.map(mapPartnerRow), total, truncated })
}

// POST /api/partners — create a partner or contact.
// Body: client-shaped object (camelCase) + location_id (uuid). Returns the
// created row in client shape.
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const locationId = body?.location_id || body?.locationId
  if (typeof locationId !== 'string' || !locationId) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }
  if (typeof body?.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }
  const type = body?.type === 'contact' ? 'contact' : 'partner'

  if (!canWriteLocation(caller, locationId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Read-only guard (868kawwmh) — paused/inactive location (lite_user
  // already excluded by canWriteLocation). past_due keeps full access.
  const roBlock = await readOnlyWriteBlock({ role: caller.role }, locationId)
  if (roBlock) return roBlock

  // Map the client object to a DB row. partnerPatchToRow only copies known
  // fields, so client-only junk (id, isDeleted, etc.) is dropped.
  const row: Record<string, any> = {
    ...partnerPatchToRow(body),
    type,
    name: body.name.trim(),
    location_id: locationId,
    created_by: caller.userId,
  }

  const { data, error } = await supabaseService
    .from('partners')
    .insert(row)
    .select(PARTNER_COLS)
    .single()

  if (error) {
    console.error('[partners POST]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(mapPartnerRow(data), { status: 201 })
}
