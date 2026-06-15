// app/api/companies/route.ts
//
// CRUD for the companies table — organizations partners/contacts link to via
// partners.company_id. Backs the "Companies" sub-tab of BeeHub's Contacts view.
// Auth mirrors /api/partners.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  COMPANY_COLS,
  mapCompanyRow,
  companyPatchToRow,
  loadCaller,
  canReadLocation,
  canWriteLocation,
} from '@/lib/crm'

export const runtime = 'nodejs'

// GET /api/companies?location_id=<uuid> — non-deleted companies, by name.
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
    .from('companies')
    .select(COMPANY_COLS)
    .eq('location_id', locationId)
    .is('deleted_at', null)
    .order('name', { ascending: true })

  if (error) {
    console.error('[companies GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json((data || []).map(mapCompanyRow))
}

// POST /api/companies — create a company. Returns the created row (client shape).
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

  if (!canWriteLocation(caller, locationId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const row: Record<string, any> = {
    ...companyPatchToRow(body),
    name: body.name.trim(),
    location_id: locationId,
    created_by: caller.userId,
  }

  const { data, error } = await supabaseService
    .from('companies')
    .insert(row)
    .select(COMPANY_COLS)
    .single()

  if (error) {
    console.error('[companies POST]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(mapCompanyRow(data), { status: 201 })
}
