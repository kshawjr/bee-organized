import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { isValidTimezoneValue, normalizeTimezoneLabel } from '@/lib/us-timezones'
import { safeHttpUrl } from '@/lib/email-signature'

// PATCH /api/locations/[id]
// Body: { name?, address?, city?, state?, zip?, phone?, email?, timezone?,
//         sender_name?, send_from_email?, reply_to_email?,
//         reviews_link?, calendar_link?,
//         website_url?, facebook_url?, instagram_url?, linkedin_url? }
//
// Updates the location row. Authorization:
//   - super_admin: can edit any location
//   - admin / owner: can edit ONLY their assigned location
//   - lite_user: 403 (read-only)
//
// All fields optional in the body — sparse patch, only provided fields are
// written. Empty strings clear (set to null); undefined leaves alone.

const ALLOWED_FIELDS = [
  // Display label only — every consumer (digest, Slack card, Stripe message,
  // import logs) falls back to location_id/slug, and every lookup keys on
  // id/slug, never on name. Safe to edit post-onboarding. See #93.
  'name',
  'address',
  'city',
  'state',
  'zip',
  'phone',
  'email',
  'timezone',
  'sender_name',
  'send_from_email',
  'reply_to_email',
  'reviews_link',
  'calendar_link',
  // Free-form TEXT ("$95") rendered verbatim into drip emails as
  // {{rate_per_hour}}. Empty string clears to null (standard sparse-patch
  // semantics here — the send guard then HOLDS rate-quoting sends).
  'rate_per_hour',
] as const

// The location's own web presence, shown in every {{signature}} from this
// location (lib/email-signature.ts) — location specific, never corporate.
// Stored normalised ("beeorganized.com/kc" → "https://beeorganized.com/kc");
// anything that isn't an http(s) web address is refused, so nothing but a
// real link can reach an href in a client email. Blank clears.
// Requires migrations/email_signatures.sql.
const SIGNATURE_LINK_FIELDS = ['website_url', 'facebook_url', 'instagram_url', 'linkedin_url'] as const
const SIGNATURE_LINK_NOUNS: Record<(typeof SIGNATURE_LINK_FIELDS)[number], string> = {
  website_url: 'Website',
  facebook_url: 'Facebook',
  instagram_url: 'Instagram',
  linkedin_url: 'LinkedIn',
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }

    const locId = params.id
    const role = hubUser.role

    // Location settings (address, sender email, timezone, links) are owner/
    // elevated config — block lite_user (read-only) and manager (operational
    // lead; no location-settings config).
    if (role === 'lite_user' || role === 'manager') {
      return NextResponse.json({ error: 'Read-only role' }, { status: 403 })
    }
    if (role !== 'super_admin' && hubUser.location_id !== locId) {
      return NextResponse.json(
        { error: 'Cannot edit other locations' },
        { status: 403 }
      )
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const patch: Record<string, any> = { updated_at: new Date().toISOString() }

    for (const field of ALLOWED_FIELDS) {
      const v = body?.[field]
      if (typeof v === 'string') {
        patch[field] = v.trim() || null
      }
    }

    for (const field of SIGNATURE_LINK_FIELDS) {
      const v = body?.[field]
      if (typeof v !== 'string') continue
      if (!v.trim()) { patch[field] = null; continue }
      const url = safeHttpUrl(v)
      if (!url) {
        return NextResponse.json(
          { error: `${SIGNATURE_LINK_NOUNS[field]} must be a web address, like https://www.facebook.com/yourpage` },
          { status: 400 },
        )
      }
      patch[field] = url
    }

    // timezone is the ONE field that is NOT free text and NOT clearable.
    // lib/drip-time.ts's requireIanaTimezone throws on any value outside
    // lib/us-timezones.ts — and Send to Jobber runs that check AFTER the
    // Jobber client + request exist (the 2026-09-01 "Phoenix AZ" duplicate).
    // The Settings row is a dropdown now; this closes the API door too, and
    // stores the canonical label even if a caller sends the IANA alias.
    if ('timezone' in patch) {
      if (!isValidTimezoneValue(patch.timezone)) {
        return NextResponse.json(
          {
            error: 'invalid timezone',
            detail: 'Timezone must be one of the standard US labels (e.g. "Mountain Time (MT)"). It cannot be blank.',
          },
          { status: 400 },
        )
      }
      patch.timezone = normalizeTimezoneLabel(patch.timezone)
    }

    if (Object.keys(patch).length === 1) {
      // Only updated_at — nothing to write
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    const { error, data } = await supabaseService
      .from('locations')
      .update(patch)
      .eq('id', locId)
      .select(
        'id, name, address, city, state, zip, phone, email, timezone, sender_name, send_from_email, reply_to_email, reviews_link, calendar_link, rate_per_hour'
      )
      .single()

    if (error) {
      console.error(`[/api/locations/${locId} PATCH] error:`, error.message)
      if (/(website|facebook|instagram|linkedin)_url/.test(error.message) && /does not exist/i.test(error.message)) {
        return NextResponse.json(
          { error: 'Signature links storage is not enabled yet — migrations/email_signatures.sql has not been run.' },
          { status: 503 },
        )
      }
      return NextResponse.json({ error: 'Failed to update location' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, location: data })
  } catch (err: any) {
    console.error('[/api/locations/[id] PATCH] error:', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'Server error' },
      { status: 500 }
    )
  }
}
