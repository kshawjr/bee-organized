import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

// PATCH /api/hub_users/me
// Body: { first_name?, last_name?, phone?, booking_link? }
//
// Updates the caller's own hub_users row. email is intentionally not editable
// here — it comes from the auth provider (Supabase Auth via Google OAuth)
// and changing it would orphan the row from the auth identity.
//
// booking_link is the user's OWN scheduling link, rendered into client emails
// by {{owner_booking_link}} when a lead is assigned to them (lib/booking-link).
// It is a self-edit by design — an owner sets their own calendar, not an
// admin's. Requires migrations/hub_users_booking_link.sql; until that runs the
// update fails LOUDLY with a diagnosable message rather than pretending to
// save (a silent no-op is the exact bug the onboarding-progress fix chased).
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
    const { first_name, last_name, phone, booking_link } = (body || {}) as {
      first_name?: string
      last_name?: string
      phone?: string
      booking_link?: string
    }

    // Build sparse patch. Only update fields explicitly provided in the body.
    // Empty strings clear the field (set to null); undefined leaves it alone.
    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (typeof first_name === 'string') patch.first_name = first_name.trim() || null
    if (typeof last_name  === 'string') patch.last_name  = last_name.trim()  || null
    if (typeof phone      === 'string') patch.phone      = phone.trim()      || null
    // Blank clears it to null, which means "fall back to the location owner's
    // link, then locations.calendar_link" — never "no link".
    if (typeof booking_link === 'string') patch.booking_link = booking_link.trim() || null

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

    // The returning select is widened ONLY when booking_link was part of the
    // patch. A name/phone save must keep working before
    // migrations/hub_users_booking_link.sql runs, and naming a non-existent
    // column in the select would error the whole statement.
    const returning =
      'id, email, full_name, first_name, last_name, phone, role, location_id' +
      ('booking_link' in patch ? ', booking_link' : '')

    const { error, data } = await supabaseService
      .from('hub_users')
      .update(patch)
      .eq('id', authUser.id)
      .select(returning)
      .single()

    if (error) {
      console.error('[/api/hub_users/me PATCH] error:', error.message)
      // Pre-migration booking_link save. Say so plainly instead of a generic
      // 500 the owner can't act on.
      if (/booking_link/.test(error.message) && /does not exist/i.test(error.message)) {
        return NextResponse.json(
          { error: 'Booking link storage is not enabled yet — migrations/hub_users_booking_link.sql has not been run.' },
          { status: 503 },
        )
      }
      return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, hub_user: data })
  } catch (err: any) {
    console.error('[/api/hub_users/me PATCH] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
