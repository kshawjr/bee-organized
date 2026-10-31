// app/api/locations/[id]/email-settings/route.ts
//
// The location's Settings → Emails choices added 2026-10-30
// (lib/email-send-options.ts holds the rules they drive):
//
//   email_style              'soft' | 'outline' | 'bold' | 'rounded' | 'classic'
//   discovery_booking_link   {{discovery_booking_link}}
//   virtual_booking_link     {{virtual_booking_link}}
//
// GET   → { settings: LocationEmailOptions, ready: { style, links } }
//         `ready` says which migrations have run, so the screen can say "not
//         set up yet" instead of failing a save.
// PATCH any subset of the three → { ok, settings }
//         A field whose column doesn't exist yet → 409 not_set_up_yet,
//         nothing written. Links must be real web addresses; blank clears.
//
// The hourly rate, the in-home link (calendar_link) and the reviews link keep
// saving through PATCH /api/locations/[id], exactly as before. Whether the
// location quotes its rate / uses a booking link is its sequence variant
// (PATCH /api/locations/[id]/drip-paths), not a column here.
//
// Auth: same as the other drip-config routes — signed in; lite_user and
// manager refused for writes; an owner only for their own location, admins any.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { safeHttpUrl } from '@/lib/email-signature'
import { locationEmailOptionsFromRow } from '@/lib/email-send-options'
import { EMAIL_STYLES } from '@/lib/drip-email-layout'

export const runtime = 'nodejs'

const LINK_FIELDS = ['discovery_booking_link', 'virtual_booking_link'] as const
const LINK_NOUNS: Record<(typeof LINK_FIELDS)[number], string> = {
  discovery_booking_link: 'Discovery call link',
  virtual_booking_link: 'Video assessment link',
}

async function authorise(locId: string, write: boolean) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  if (write && (hubUser.role === 'lite_user' || hubUser.role === 'manager')) {
    return NextResponse.json({ error: 'forbidden_read_only' }, { status: 403 })
  }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== locId) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }
  return null
}

// '*' — a missing column is simply absent, never an error.
async function readRow(locId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseService.from('locations').select('*').eq('id', locId).maybeSingle()
  if (error || !data) return null
  return data as Record<string, unknown>
}

function readiness(row: Record<string, unknown>) {
  return {
    style: 'email_style' in row,
    links: 'discovery_booking_link' in row && 'virtual_booking_link' in row,
  }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await authorise(params.id, false)
  if (denied) return denied
  const row = await readRow(params.id)
  if (!row) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  return NextResponse.json({ settings: locationEmailOptionsFromRow(row), ready: readiness(row) })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await authorise(params.id, true)
  if (denied) return denied

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if ('email_style' in body) {
    const v = body.email_style
    if (!EMAIL_STYLES.some((s) => s.id === v)) {
      return NextResponse.json({ error: 'invalid_email_style' }, { status: 400 })
    }
    patch.email_style = v
  }
  for (const f of LINK_FIELDS) {
    if (!(f in body)) continue
    const v = body[f]
    if (v === null || (typeof v === 'string' && !v.trim())) { patch[f] = null; continue }
    const url = typeof v === 'string' ? safeHttpUrl(v) : null
    if (!url) {
      return NextResponse.json({ error: `${LINK_NOUNS[f]} must be a web address, like https://calendly.com/you` }, { status: 400 })
    }
    patch[f] = url
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'no_fields' }, { status: 400 })

  const row = await readRow(params.id)
  if (!row) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  const missing = Object.keys(patch).filter((k) => !(k in row))
  if (missing.length) {
    return NextResponse.json({ error: 'not_set_up_yet', columns: missing }, { status: 409 })
  }

  const { data, error } = await supabaseService
    .from('locations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select('*')
    .single()
  if (error || !data) {
    console.error('[/api/locations/[id]/email-settings PATCH] error:', error?.message)
    return NextResponse.json({ error: 'update_failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, settings: locationEmailOptionsFromRow(data as Record<string, unknown>) })
}
