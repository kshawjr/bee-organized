// app/api/lead-contacts/[id]/route.ts
//
// PATCH  /api/lead-contacts/:id — update a contact
// DELETE /api/lead-contacts/:id — remove a contact

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

const PATCHABLE_FIELDS = new Set(['name', 'role', 'phone', 'email'])

async function authorize(id: string) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (!hubUser) {
    return { error: NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 }) }
  }

  if (hubUser.role === 'lite_user') {
    return { error: NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 }) }
  }

  const { data: contact, error: loadError } = await supabaseService
    .from('lead_contacts')
    .select('id, lead_id, location_uuid')
    .eq('id', id)
    .single()

  if (loadError || !contact) {
    return { error: NextResponse.json({ error: 'contact_not_found' }, { status: 404 }) }
  }

  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== contact.location_uuid) {
      return {
        error: NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 }),
      }
    }
  }

  return { hubUser, contact }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const auth = await authorize(id)
  if (auth.error) return auth.error

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!PATCHABLE_FIELDS.has(key)) continue
    if (typeof value === 'string') {
      patch[key] = value.trim() || null
    } else if (value === null) {
      patch[key] = null
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_valid_fields_in_body' }, { status: 400 })
  }

  // Block setting name to empty
  if ('name' in patch && (patch.name === null || patch.name === '')) {
    return NextResponse.json({ error: 'name_cannot_be_empty' }, { status: 400 })
  }

  const { data: updated, error: updateError } = await supabaseService
    .from('lead_contacts')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (updateError) {
    return NextResponse.json(
      { error: 'update_failed', detail: updateError.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ contact: updated }, { status: 200 })
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const auth = await authorize(id)
  if (auth.error) return auth.error

  const { error: deleteError } = await supabaseService
    .from('lead_contacts')
    .delete()
    .eq('id', id)

  if (deleteError) {
    return NextResponse.json(
      { error: 'delete_failed', detail: deleteError.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ deleted: true, id }, { status: 200 })
}