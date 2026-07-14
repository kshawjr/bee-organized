// app/api/hub_users/[id]/access/route.ts
//
// Reversible "Remove access" — full offboard of a hub_user in ONE call.
//
//   POST   /api/hub_users/:id/access   → REMOVE access (offboard)
//     In a single call: (1) sets disabled_at/disabled_by [Layer 1, PRIMARY],
//     (2) bans the user's Supabase auth [Layer 2, belt-and-suspenders,
//     NON-FATAL], (3) frees their seat back to the pool, (4) unsubscribes
//     them from lead notifications. Only step 1 is fatal — the flag is what
//     locks them out (middleware.ts), so it must be recorded; every other
//     step is best-effort and logged loudly on failure.
//
//   PATCH  /api/hub_users/:id/access   → REACTIVATE (restore LOGIN only)
//     Clears disabled_at/disabled_by and unbans auth. Deliberately does NOT
//     re-add a paid seat (that would silently incur billing) and does NOT
//     re-subscribe to notifications — re-seating is a separate explicit step.
//
// Permission is enforced SERVER-SIDE on every verb via lib/access-removal:
// super_admin/admin (any location) or the OWNER of the target's location.
// A manager / lite_user is rejected even on a direct API hit. Plus the
// self-removal and last-owner guards.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  checkAccessGuards,
  BAN_DURATION,
  UNBAN_DURATION,
} from '@/lib/access-removal'
import { DEFAULT_CATEGORY } from '@/lib/notification-recipients'

export const runtime = 'nodejs'

type Caller = { userId: string; role: string; locationId: string | null }
type Target = {
  id: string
  role: string
  location_id: string | null
  email: string | null
}

async function loadCaller(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
): Promise<Caller | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return null
  return {
    userId: user.id,
    role: hubUser.role as string,
    locationId: (hubUser.location_id as string | null) ?? null,
  }
}

async function loadTarget(id: string): Promise<Target | null> {
  const { data } = await supabaseService
    .from('hub_users')
    .select('id, role, location_id, email, disabled_at')
    .eq('id', id)
    .single()
  if (!data) return null
  return {
    id: data.id,
    role: data.role as string,
    location_id: (data.location_id as string | null) ?? null,
    email: (data.email as string | null) ?? null,
  }
}

// Count enabled (disabled_at IS NULL) owners at a location, INCLUDING the
// target. Used only for the last-owner guard on a remove.
async function countEnabledOwners(locationId: string): Promise<number> {
  const { count } = await supabaseService
    .from('hub_users')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .eq('role', 'owner')
    .is('disabled_at', null)
  return count ?? 0
}

// Layer 2 — ban/unban Supabase auth. NON-FATAL: logs loudly and returns a
// boolean so the caller can report it, but never throws / fails the op.
async function setAuthBan(userId: string, banned: boolean): Promise<boolean> {
  try {
    const { error } = await supabaseService.auth.admin.updateUserById(userId, {
      ban_duration: banned ? BAN_DURATION : UNBAN_DURATION,
    })
    if (error) {
      console.error(
        `[hub_users/access] auth_ban_failed (banned=${banned}) for ${userId}: ${error.message}`,
      )
      return false
    }
    return true
  } catch (e: any) {
    console.error(
      `[hub_users/access] auth_ban_failed (banned=${banned}) for ${userId}: ${e?.message || e}`,
    )
    return false
  }
}

// POST — remove access (full offboard).
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const targetId = params.id
  if (!targetId) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const target = await loadTarget(targetId)
  if (!target) {
    return NextResponse.json({ error: 'user not found' }, { status: 404 })
  }

  // Last-owner guard needs the enabled-owner count, but only when the target
  // is an owner — skip the query otherwise.
  const enabledOwnerCount =
    target.role === 'owner' && target.location_id
      ? await countEnabledOwners(target.location_id)
      : 0

  const rejection = checkAccessGuards(
    {
      callerRole: caller.role,
      callerUserId: caller.userId,
      callerLocationId: caller.locationId,
      targetUserId: target.id,
      targetRole: target.role,
      targetLocationId: target.location_id,
      enabledOwnerCount,
    },
    'remove',
  )
  if (rejection) {
    return NextResponse.json(
      { error: rejection.error, code: rejection.code },
      { status: rejection.status },
    )
  }

  // ── Layer 1 (PRIMARY, must succeed): set the disabled flag. This is the
  // lockout — if it fails we abort so we never report a "removed" user who
  // can still load the app.
  const { error: flagErr } = await supabaseService
    .from('hub_users')
    .update({ disabled_at: new Date().toISOString(), disabled_by: caller.userId })
    .eq('id', target.id)
  if (flagErr) {
    console.error('[hub_users/access] disable flag write failed:', flagErr.message)
    return NextResponse.json({ error: flagErr.message }, { status: 500 })
  }

  // ── Layer 2 (belt-and-suspenders, NON-FATAL): ban Supabase auth.
  const authBanned = await setAuthBan(target.id, true)

  // ── Free the seat: return the active seat to the pool (user_id=null). Same
  // effect as TeamSection.removeMember's PATCH /api/seats — NOT a soft-delete.
  // Best-effort; logged on failure. There is at most one active seat per user.
  let seatFreed = false
  {
    const { data: seat } = await supabaseService
      .from('subscription_seats')
      .select('id')
      .eq('user_id', target.id)
      .eq('status', 'active')
      .maybeSingle()
    if (seat?.id) {
      const { error: seatErr } = await supabaseService
        .from('subscription_seats')
        .update({ user_id: null, updated_at: new Date().toISOString() })
        .eq('id', seat.id)
      if (seatErr) {
        console.error('[hub_users/access] seat free failed:', seatErr.message)
      } else {
        seatFreed = true
      }
    }
  }

  // ── Unsubscribe from lead notifications (B1). Best-effort / non-fatal:
  // preserve any category they had, just flip subscribed=false. If the pref
  // row (or table) is absent the upsert creates it; a genuine failure logs
  // notif_unsubscribe_failed but does not fail the offboard.
  let unsubscribed = false
  if (target.location_id) {
    try {
      const { data: existing } = await supabaseService
        .from('lead_notification_prefs')
        .select('category')
        .eq('location_id', target.location_id)
        .eq('hub_user_id', target.id)
        .maybeSingle()
      const { error: prefErr } = await supabaseService
        .from('lead_notification_prefs')
        .upsert(
          {
            location_id: target.location_id,
            hub_user_id: target.id,
            category: existing?.category ?? DEFAULT_CATEGORY,
            subscribed: false,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'location_id,hub_user_id' },
        )
      if (prefErr) {
        console.warn('[hub_users/access] notif_unsubscribe_failed:', prefErr.message)
      } else {
        unsubscribed = true
      }
    } catch (e: any) {
      console.warn('[hub_users/access] notif_unsubscribe_failed:', e?.message || e)
    }
  }

  return NextResponse.json({
    ok: true,
    disabled: true,
    authBanned,
    seatFreed,
    unsubscribed,
  })
}

// PATCH — reactivate (restore LOGIN only; no seat re-add).
export async function PATCH(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const targetId = params.id
  if (!targetId) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const target = await loadTarget(targetId)
  if (!target) {
    return NextResponse.json({ error: 'user not found' }, { status: 404 })
  }

  const rejection = checkAccessGuards(
    {
      callerRole: caller.role,
      callerUserId: caller.userId,
      callerLocationId: caller.locationId,
      targetUserId: target.id,
      targetRole: target.role,
      targetLocationId: target.location_id,
      enabledOwnerCount: 0,
    },
    'restore',
  )
  if (rejection) {
    return NextResponse.json(
      { error: rejection.error, code: rejection.code },
      { status: rejection.status },
    )
  }

  // Clear the disabled flag (Layer 1) — restores app access.
  const { error: flagErr } = await supabaseService
    .from('hub_users')
    .update({ disabled_at: null, disabled_by: null })
    .eq('id', target.id)
  if (flagErr) {
    console.error('[hub_users/access] reactivate flag clear failed:', flagErr.message)
    return NextResponse.json({ error: flagErr.message }, { status: 500 })
  }

  // Unban Supabase auth (Layer 2) — non-fatal.
  const authUnbanned = await setAuthBan(target.id, false)

  // Deliberately NO seat re-add and NO re-subscribe: reactivation restores
  // login only. Re-seating is a separate, deliberate billing step.
  return NextResponse.json({ ok: true, disabled: false, authUnbanned, seatReadded: false })
}
