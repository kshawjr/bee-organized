import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

// PATCH /api/hub_users/me
// Body: { first_name?, last_name?, phone? }
//
// Updates the caller's own hub_users row. email is intentionally not editable
// here — it comes from the auth provider (Supabase Auth via Google OAuth)
// and changing it would orphan the row from the auth identity.
//
// full_name is auto-recomputed as "first last" whenever first_name or
// last_name changes, so the existing UI / page.tsx reads of full_name stay
// in sync without us having to retrofit every caller.

export async function PATCH(req: NextRequest) {
  try {
    const authUser = await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const { first_name, last_name, phone } = (body || {}) as {
      first_name?: string
      last_name?: string
      phone?: string
    }

    // Build sparse patch. Only update fields explicitly provided in the body.
    // Empty strings clear the field (set to null); undefined leaves it alone.
    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (typeof first_name === 'string') patch.first_name = first_name.trim() || null
    if (typeof last_name  === 'string') patch.last_name  = last_name.trim()  || null
    if (typeof phone      === 'string') patch.phone      = phone.trim()      || null

    // Recompute full_name when either name field changed. Fetch the current
    // row so partial updates (e.g. only first_name) preserve the other half.
    if ('first_name' in patch || 'last_name' in patch) {
      const { data: current } = await supabaseService
        .from('hub_users')
        .select('first_name, last_name')
        .eq('id', authUser.id)
        .single()
      const fn = ('first_name' in patch ? patch.first_name : (current as any)?.first_name) || ''
      const ln = ('last_name'  in patch ? patch.last_name  : (current as any)?.last_name)  || ''
      const full = `${fn} ${ln}`.trim()
      patch.full_name = full || null
    }

    const { error, data } = await supabaseService
      .from('hub_users')
      .update(patch)
      .eq('id', authUser.id)
      .select('id, email, full_name, first_name, last_name, phone, role, location_id')
      .single()

    if (error) {
      console.error('[/api/hub_users/me PATCH] error:', error.message)
      return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, hub_user: data })
  } catch (err: any) {
    console.error('[/api/hub_users/me PATCH] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
