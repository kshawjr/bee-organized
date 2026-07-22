// app/api/locations/[id]/notification-recipients/route.ts
//
// Lead Notification Recipients management for one location.
//
// GET   /api/locations/:id/notification-recipients
//   Returns { users: [...interface users with effective category+subscribed],
//             externals: [...external recipients] }. Interface users are read
//             LIVE from hub_users (name/email not copied) and default to
//             subscribed/'all' when they have no pref row.
//
// PATCH /api/locations/:id/notification-recipients
//   Body: { hub_user_id, category?, subscribed? }
//   Upserts an interface user's override (their category and/or subscribe
//   state). This is how an owner cuts a terminated manager off lead emails.
//
// POST  /api/locations/:id/notification-recipients
//   Body: { first_name?, last_name?, email(required), phone?, category? }
//   Adds an external (non-user) recipient.
//
// Auth: super_admin/admin (any location) or the franchise OWNER of THIS
// location ONLY — enforced server-side on EVERY verb (incl. GET). A MANAGER
// (Hive Manager) or lite_user is rejected even on a direct API hit: they
// receive lead emails but must not see or manage who is on the list.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { notificationRecipientsManageableServer } from '@/lib/notification-access'
import {
  getNotificationConfig,
  setSplitNotificationsEnabled,
  DEFAULT_CATEGORY,
} from '@/lib/notification-recipients'

export const runtime = 'nodejs'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// The category field is now a project-type ROUTING string: 'all' (all leads),
// a JSON array of project-type labels, or a legacy 'moving'/'organizing' value
// (kept working). Accept those shapes; reject anything else so a malformed
// write can't land. The UI serializes selections via serializeCategory().
function isValidCategoryField(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s === 'all' || s === 'moving' || s === 'organizing') return true
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      return Array.isArray(arr) && arr.every((x) => typeof x === 'string')
    } catch {
      return false
    }
  }
  return false
}

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
    // Managers + lite_users + owners of other locations all land here.
    return { error: 'forbidden', status: 403 as const }
  }
  return { hubUser }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authForLocation(params.id)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  try {
    // Returns { users, externals, project_types, split_enabled } — the full
    // PART 1 config the unified section renders.
    const data = await getNotificationConfig(params.id)
    return NextResponse.json(data)
  } catch (e: any) {
    console.error('[notification-recipients GET]', e?.message || e)
    return NextResponse.json({ error: 'load_failed' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authForLocation(params.id)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const body = await req.json().catch(() => null)

  // Split-toggle flip: { split_enabled: boolean }, no hub_user_id. This is the
  // PART 1 Advanced toggle ("Notify different people by project type").
  if (body && typeof body.split_enabled === 'boolean') {
    try {
      await setSplitNotificationsEnabled(params.id, body.split_enabled)
      return NextResponse.json({ ok: true, split_enabled: body.split_enabled })
    } catch (e: any) {
      console.error('[notification-recipients PATCH split]', e?.message || e)
      return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    }
  }

  const hubUserId = body?.hub_user_id
  if (!hubUserId || typeof hubUserId !== 'string') {
    return NextResponse.json({ error: 'hub_user_id required' }, { status: 400 })
  }
  if (body.category !== undefined && !isValidCategoryField(body.category)) {
    return NextResponse.json({ error: 'invalid category' }, { status: 400 })
  }
  if (body.subscribed !== undefined && typeof body.subscribed !== 'boolean') {
    return NextResponse.json({ error: 'invalid subscribed' }, { status: 400 })
  }

  // Target user must belong to THIS location — never let one location write a
  // pref keyed to another location's user.
  const { data: target } = await supabaseService
    .from('hub_users')
    .select('id, location_id')
    .eq('id', hubUserId)
    .single()
  if (!target || target.location_id !== params.id) {
    return NextResponse.json({ error: 'user not at this location' }, { status: 404 })
  }

  // Read the current row so we can honor defaults for the field NOT supplied
  // (absence-of-row == subscribed/'all'); we only upsert an explicit override.
  const { data: existing } = await supabaseService
    .from('lead_notification_prefs')
    .select('category, subscribed')
    .eq('location_id', params.id)
    .eq('hub_user_id', hubUserId)
    .maybeSingle()

  const row = {
    location_id: params.id,
    hub_user_id: hubUserId,
    category:
      body.category !== undefined
        ? body.category
        : existing?.category ?? DEFAULT_CATEGORY,
    subscribed:
      body.subscribed !== undefined
        ? body.subscribed
        : existing?.subscribed ?? true,
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabaseService
    .from('lead_notification_prefs')
    .upsert(row, { onConflict: 'location_id,hub_user_id' })
  if (error) {
    console.error('[notification-recipients PATCH]', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authForLocation(params.id)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const body = await req.json().catch(() => null)
  // Normalized (trimmed + lowercased) so one address can't land twice under
  // different casing — the stored value equals the (location_id, email) uniqueness
  // key and the case-insensitive dedup the resolver/send path use.
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 })
  }
  if (body.category !== undefined && !isValidCategoryField(body.category)) {
    return NextResponse.json({ error: 'invalid category' }, { status: 400 })
  }

  const SELECT_COLS = 'id, first_name, last_name, email, phone, category'

  // Idempotent add — the PRIMARY dedup guard, and the one that works BEFORE the
  // (location_id, email) unique index exists (this route ships ahead of the
  // migration). If this location already has this address, return that row
  // instead of inserting a duplicate.
  const { data: existing } = await supabaseService
    .from('lead_notification_externals')
    .select(SELECT_COLS)
    .eq('location_id', params.id)
    .eq('email', email)
    .maybeSingle()
  if (existing) {
    return NextResponse.json({ ok: true, external: existing, duplicate: true })
  }

  const row = {
    location_id: params.id,
    first_name: typeof body.first_name === 'string' ? body.first_name.trim() || null : null,
    last_name: typeof body.last_name === 'string' ? body.last_name.trim() || null : null,
    email,
    phone: typeof body.phone === 'string' ? body.phone.trim() || null : null,
    category: body.category !== undefined ? body.category : DEFAULT_CATEGORY,
  }

  const { data, error } = await supabaseService
    .from('lead_notification_externals')
    .insert(row)
    .select(SELECT_COLS)
    .single()
  if (error) {
    // 23505 = the unique backstop caught a concurrent add of the same
    // (location, email) between the check above and this insert. Not a failure —
    // re-read and return the winning row so the add still reads as idempotent.
    if ((error as any).code === '23505') {
      const { data: raced } = await supabaseService
        .from('lead_notification_externals')
        .select(SELECT_COLS)
        .eq('location_id', params.id)
        .eq('email', email)
        .maybeSingle()
      return NextResponse.json({ ok: true, external: raced ?? null, duplicate: true })
    }
    console.error('[notification-recipients POST]', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, external: data })
}
