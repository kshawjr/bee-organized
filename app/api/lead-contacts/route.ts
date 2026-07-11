// app/api/lead-contacts/route.ts
//
// POST /api/lead-contacts — create a contact on a lead
//   Used for spouses, co-decision-makers, secondary points of contact.
//
// Auth: must be a logged-in hub_user.
// Scope: super_admin/admin can write to any lead. owner can only write
//        to leads in their location. lite_user blocked.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'

export async function POST(req: Request) {
  // Auth
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  if (hubUser.role === 'lite_user') {
    return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
  }

  // Parse body
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const lead_id = body.lead_id as string | undefined
  const name = body.name as string | undefined
  const role = body.role as string | null | undefined
  const phone = body.phone as string | null | undefined
  const email = body.email as string | null | undefined

  // Validate
  if (!lead_id || typeof lead_id !== 'string') {
    return NextResponse.json({ error: 'lead_id_required' }, { status: 400 })
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name_required' }, { status: 400 })
  }

  // Load lead for scoping
  const { data: lead, error: leadError } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', lead_id)
    .single()

  if (leadError || !lead) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // Location scoping
  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== lead.location_uuid) {
      return NextResponse.json(
        { error: 'forbidden_wrong_location' },
        { status: 403 }
      )
    }
  }

  // ─── Read-only guard (868kawwmh) ──────────────────────────────
  const roBlock = await readOnlyWriteBlock(hubUser, lead.location_uuid)
  if (roBlock) return roBlock

  // Insert
  const { data: inserted, error: insertError } = await supabaseService
    .from('lead_contacts')
    .insert({
      lead_id,
      location_uuid: lead.location_uuid,
      name: name.trim(),
      role: role?.trim() || null,
      phone: phone?.trim() || null,
      email: email?.trim() || null,
    })
    .select('*')
    .single()

  if (insertError) {
    return NextResponse.json(
      { error: 'insert_failed', detail: insertError.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ contact: inserted }, { status: 201 })
}