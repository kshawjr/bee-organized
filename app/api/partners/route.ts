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

// GET /api/partners?location_id=<uuid> — non-deleted partners+contacts, by name.
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const locationId = request.nextUrl.searchParams.get('location_id')
  if (!locationId) {
    return NextResponse.json({ error: 'location_id query param required' }, { status: 400 })
  }
  if (!canReadLocation(caller, locationId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data, error } = await supabase
    .from('partners')
    .select(PARTNER_COLS)
    .eq('location_id', locationId)
    .is('deleted_at', null)
    .order('name', { ascending: true })

  if (error) {
    console.error('[partners GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json((data || []).map(mapPartnerRow))
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
