// app/api/admin/locations/route.ts
//
// POST /api/admin/locations — create a brand-new location row. This is the
// "+ Add Location" entry point in the Admin → Locations view, replacing the
// hand-run SQL Kevin used to seed a franchise before inviting its owner.
//
// The row is created in its pre-owner state: only the fields the operator
// supplies (name, slug, optional timezone/address/contact) are written. Every
// downstream concern is left to its own flow:
//   - billing / owner seat / invite  → /api/admin/invite-owner
//   - sender config / drip paths      → onboarding wizard (PATCH /api/locations/[id])
//   - jobber tokens                   → /api/jobber/callback
//
// DB defaults handle the rest (lifecycle_status, subscription_status='deferred',
// payment_source='none', onboarding_state='{}', timezone='America/New_York',
// is_active, jobber_connected, created_at/updated_at, id). We pass
// lifecycle_status='onboarding' explicitly — it's also the DB default, but being
// defensive keeps the new row out of the 'active' drip-enrollment gate even if
// the column default ever changes.
//
// The schema has BOTH location_id and slug as NOT NULL UNIQUE; we write the same
// operator-supplied slug to both.
//
// Auth: super_admin OR admin (the "corporate" tier) — same fail-closed pattern
// as /api/admin/feedback and /api/admin/invite-owner.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const ALLOWED_ROLES = ['super_admin', 'admin']

// kebab-case: lowercase letters/digits in hyphen-separated groups. No leading/
// trailing/double hyphens, no uppercase, underscores, spaces, or punctuation.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// Timezones the Create Location form offers — the same friendly-label list the
// Settings → Location step uses. locations.timezone is stored as these labels
// app-wide (lib/drip-time.ts normalizes them to IANA for scheduling), so we
// validate against the labels and also accept the IANA equivalents defensively
// (e.g. the DB default 'America/New_York').
const VALID_TIMEZONES = new Set([
  'Eastern Time (ET)',
  'Central Time (CT)',
  'Mountain Time (MT)',
  'Pacific Time (PT)',
  'Alaska Time (AKT)',
  'Hawaii Time (HT)',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
])

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller || !ALLOWED_ROLES.includes(caller.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const {
    name,
    slug,
    timezone,
    address,
    city,
    state,
    zip,
    phone,
    email,
  } = body || {}

  // ─── Validation ───
  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }
  const trimmedName = name.trim()
  if (trimmedName.length > 100) {
    return NextResponse.json(
      { error: 'name must be 1-100 characters' },
      { status: 400 }
    )
  }

  if (typeof slug !== 'string' || !slug.trim()) {
    return NextResponse.json({ error: 'slug required' }, { status: 400 })
  }
  const trimmedSlug = slug.trim()
  if (trimmedSlug.length > 50) {
    return NextResponse.json(
      { error: 'slug must be 1-50 characters' },
      { status: 400 }
    )
  }
  if (!SLUG_RE.test(trimmedSlug)) {
    return NextResponse.json(
      {
        error:
          'slug must be lowercase letters, digits, and single hyphens only (e.g. "palm-beach")',
      },
      { status: 400 }
    )
  }

  if (timezone !== undefined && timezone !== null && timezone !== '') {
    if (typeof timezone !== 'string' || !VALID_TIMEZONES.has(timezone)) {
      return NextResponse.json(
        { error: 'invalid timezone' },
        { status: 400 }
      )
    }
  }

  if (email !== undefined && email !== null && email !== '') {
    if (typeof email !== 'string' || !isValidEmail(email)) {
      return NextResponse.json(
        { error: 'email must be a valid address' },
        { status: 400 }
      )
    }
  }

  if (state !== undefined && state !== null && state !== '') {
    if (typeof state !== 'string' || state.trim().length !== 2) {
      return NextResponse.json(
        { error: 'state must be a 2-letter abbreviation' },
        { status: 400 }
      )
    }
  }

  // Optional free-text fields: coerce to trimmed string or skip.
  const optionalText = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined

  // ─── Uniqueness pre-check (cheaper, clearer than catching 23505) ───
  // Both location_id and slug must be unique; the same value goes to both, so a
  // collision on either means the slug is taken.
  const { data: existing, error: existErr } = await supabaseService
    .from('locations')
    .select('name')
    .or(`location_id.eq.${trimmedSlug},slug.eq.${trimmedSlug}`)
    .limit(1)
    .maybeSingle()
  if (existErr) {
    console.error('[admin/locations uniqueness check]', existErr)
    return NextResponse.json({ error: existErr.message }, { status: 500 })
  }
  if (existing) {
    return NextResponse.json(
      {
        error: 'slug_already_exists',
        existing_location_name: existing.name,
      },
      { status: 409 }
    )
  }

  // ─── Insert ───
  const insertRow: Record<string, any> = {
    name: trimmedName,
    location_id: trimmedSlug,
    slug: trimmedSlug,
    lifecycle_status: 'onboarding',
  }
  if (timezone) insertRow.timezone = timezone
  const addr = optionalText(address)
  if (addr) insertRow.address = addr
  const cityVal = optionalText(city)
  if (cityVal) insertRow.city = cityVal
  if (typeof state === 'string' && state.trim())
    insertRow.state = state.trim().toUpperCase()
  const zipVal = optionalText(zip)
  if (zipVal) insertRow.zip = zipVal
  const phoneVal = optionalText(phone)
  if (phoneVal) insertRow.phone = phoneVal
  const emailVal = optionalText(email)
  if (emailVal) insertRow.email = emailVal.toLowerCase()

  const { data: created, error: insertErr } = await supabaseService
    .from('locations')
    .insert(insertRow)
    .select('id, name, slug, location_id, state, timezone, lifecycle_status, subscription_status, payment_source, created_at')
    .single()

  if (insertErr) {
    // 23505 = unique_violation — backstop for a race between the pre-check and
    // the insert. Surface the same 409 shape the client already handles.
    if ((insertErr as any).code === '23505') {
      return NextResponse.json(
        { error: 'slug_already_exists', existing_location_name: null },
        { status: 409 }
      )
    }
    console.error('[admin/locations insert]', insertErr)
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, location: created }, { status: 201 })
}
