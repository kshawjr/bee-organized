// app/api/locations/[id]/notification-recipients/externals/[extId]/route.ts
//
// Edit / remove one EXTERNAL (non-user) lead-notification recipient.
//
// PATCH  /api/locations/:id/notification-recipients/externals/:extId
//   Body: { first_name?, last_name?, email?, phone?, category? } — partial.
// DELETE /api/locations/:id/notification-recipients/externals/:extId
//
// Auth: identical to the parent route — super_admin/admin (any location) or
// the franchise OWNER of THIS location ONLY, enforced server-side. Managers
// and lite_users are rejected. The external is additionally verified to belong
// to :id so one location can't edit another's rows.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { notificationRecipientsManageableServer } from '@/lib/notification-access'
import { isRecipientCategory } from '@/lib/notification-recipients'

export const runtime = 'nodejs'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function authForLocation(locId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized', status: 401 as const }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return { error: 'no_hub_user_profile', status: 403 as const }

  if (
    !notificationRecipientsManageableServer(hubUser.role, hubUser.location_id, locId)
  ) {
    return { error: 'forbidden', status: 403 as const }
  }
  return { hubUser }
}

async function loadExternalAtLocation(extId: string, locId: string) {
  const { data } = await supabaseService
    .from('lead_notification_externals')
    .select('id, location_id')
    .eq('id', extId)
    .single()
  if (!data || data.location_id !== locId) return null
  return data
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; extId: string } },
) {
  const auth = await authForLocation(params.id)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const existing = await loadExternalAtLocation(params.extId, params.id)
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'body required' }, { status: 400 })
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.email !== undefined) {
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'valid email required' }, { status: 400 })
    }
    patch.email = email
  }
  if (body.category !== undefined) {
    if (!isRecipientCategory(body.category)) {
      return NextResponse.json({ error: 'invalid category' }, { status: 400 })
    }
    patch.category = body.category
  }
  if (body.first_name !== undefined) {
    patch.first_name = typeof body.first_name === 'string' ? body.first_name.trim() || null : null
  }
  if (body.last_name !== undefined) {
    patch.last_name = typeof body.last_name === 'string' ? body.last_name.trim() || null : null
  }
  if (body.phone !== undefined) {
    patch.phone = typeof body.phone === 'string' ? body.phone.trim() || null : null
  }

  const { data, error } = await supabaseService
    .from('lead_notification_externals')
    .update(patch)
    .eq('id', params.extId)
    .select('id, first_name, last_name, email, phone, category')
    .single()
  if (error) {
    console.error('[notification-recipients external PATCH]', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, external: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; extId: string } },
) {
  const auth = await authForLocation(params.id)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const existing = await loadExternalAtLocation(params.extId, params.id)
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const { error } = await supabaseService
    .from('lead_notification_externals')
    .delete()
    .eq('id', params.extId)
  if (error) {
    console.error('[notification-recipients external DELETE]', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
