// app/api/partners/[id]/route.ts
//
//   GET    — single partner/contact
//   PATCH  — update fields (partial; client camelCase). `restore: true` un-deletes.
//   DELETE — soft-delete (deleted_at = now). `?purge=1` hard-deletes (recycle bin).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  PARTNER_COLS,
  mapPartnerRow,
  partnerPatchToRow,
  loadCaller,
  canReadLocation,
  canWriteLocation,
} from '@/lib/crm'

export const runtime = 'nodejs'

async function loadRow(id: string) {
  const { data } = await supabaseService
    .from('partners')
    .select('id, location_id')
    .eq('id', id)
    .single()
  return data
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabaseService
    .from('partners')
    .select(PARTNER_COLS)
    .eq('id', id)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
  }
  if (!canReadLocation(caller, (data as any).location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  return NextResponse.json(mapPartnerRow(data))
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const existing = await loadRow(id)
  if (!existing) {
    return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
  }
  if (!canWriteLocation(caller, existing.location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const update: Record<string, any> = {
    ...partnerPatchToRow(body),
    updated_at: new Date().toISOString(),
  }
  if (body?.restore === true) update.deleted_at = null

  const { data, error } = await supabaseService
    .from('partners')
    .update(update)
    .eq('id', id)
    .select(PARTNER_COLS)
    .single()

  if (error) {
    console.error('[partners PATCH]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(mapPartnerRow(data))
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const existing = await loadRow(id)
  if (!existing) {
    return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
  }
  if (!canWriteLocation(caller, existing.location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const purge = request.nextUrl.searchParams.get('purge')
  if (purge === '1' || purge === 'true') {
    const { error } = await supabaseService.from('partners').delete().eq('id', id)
    if (error) {
      console.error('[partners DELETE purge]', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, purged: true })
  }

  const { data, error } = await supabaseService
    .from('partners')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(PARTNER_COLS)
    .single()

  if (error) {
    console.error('[partners DELETE]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(mapPartnerRow(data))
}
