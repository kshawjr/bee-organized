import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

// PATCH /api/locations/[id] — update top-level location fields. Super_admin only.
// For subscription-specific fields, use /api/locations/[id]/subscription
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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

  if (!hubUser || hubUser.role !== 'super_admin') {
    return NextResponse.json(
      { error: 'forbidden — super_admin only' },
      { status: 403 }
    )
  }

  const body = await request.json().catch(() => ({}))

  const allowedLifecycle = ['onboarding', 'active', 'paused', 'inactive']
  const update: Record<string, any> = {}

  if (typeof body.lifecycle_status === 'string') {
    if (!allowedLifecycle.includes(body.lifecycle_status)) {
      return NextResponse.json(
        {
          error: `invalid lifecycle_status — must be one of: ${allowedLifecycle.join(', ')}`,
        },
        { status: 400 }
      )
    }
    update.lifecycle_status = body.lifecycle_status
  }

  if (typeof body.name === 'string' && body.name.trim()) {
    update.name = body.name.trim()
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('locations')
    .update(update)
    .eq('id', params.id)
    .select('id, name, lifecycle_status')
    .single()

  if (error) {
    console.error('[locations PATCH]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, location: data })
}
