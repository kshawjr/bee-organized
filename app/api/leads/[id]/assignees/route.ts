// app/api/leads/[id]/assignees/route.ts
//
// Lead-level Assigned To — the plural junction write path behind the
// PersonPanel's "+ Assign" picker.
//
//   GET  /api/leads/:id/assignees        → { assignees: [...] }
//   PUT  /api/leads/:id/assignees        → body { hub_user_ids: string[] }
//                                          the given set becomes the exact set
//
// PUT, not POST/DELETE, on purpose: the picker is a multi-select that hands
// back a complete selection, so the natural verb is "make it be this". That
// also makes an unassign-everyone (empty array) expressible, which the
// engagement-level route needs two calls to say.
//
// Assignment decided HERE is 'manual' — a human chose it. The intake path's
// automatic resolution writes 'project_type' / 'location_owner' instead (see
// lib/lead-assignment.ts); the distinction is diagnostic only.
//
// leads.assigned_to is kept in step with the FIRST id in the set so nothing
// that still reads the legacy singular column regresses. Clearing the set
// nulls it.
//
// Auth mirrors the engagement-level sibling: logged-in hub_user; super_admin/
// admin any location, everyone else scoped to their own
// (hub_users.location_id === lead.location_uuid). Assignees must belong to the
// lead's location too (or the caller is admin) — no cross-franchise assignment.
//
// Deliberately does NOT push to Jobber. Jobber's TEAM/CREW lives on work
// records (appointments, visits) that a pre-work lead does not have yet; the
// push happens at the engagement level once work exists, from the set this
// route's decision is carried into (lib/engagements seedEngagementAssignees-
// FromLead → lib/engagement-assignee-sync).

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'

export const runtime = 'nodejs'

async function authAndLoad(id: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) {
    return { error: NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 }) }
  }

  const { data: lead, error: leadErr } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', id)
    .maybeSingle()
  if (leadErr || !lead) {
    return { error: NextResponse.json({ error: 'lead_not_found' }, { status: 404 }) }
  }

  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return { error: NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 }) }
  }

  return { hubUser, lead }
}

// Junction → hub_users, oldest first so "primary" is stable = first assigned.
// A missing lead_assignees table (migration not applied yet) reads as an empty
// list rather than a 500 — same forward-safety the write path has.
async function readAssignees(leadId: string) {
  try {
    const { data, error } = await supabaseService
      .from('lead_assignees')
      .select('hub_user_id, assigned_via, created_at, hub_users(id, full_name, first_name, last_name, email, jobber_user_id)')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: true })
    if (error) return []
    return (data || []).map((row: any) => {
      const u = Array.isArray(row.hub_users) ? row.hub_users[0] : row.hub_users
      const name =
        u?.full_name ||
        [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() ||
        u?.email ||
        null
      return {
        hub_user_id: row.hub_user_id,
        name,
        email: u?.email ?? null,
        jobber_user_id: u?.jobber_user_id ?? null,
        assigned_via: row.assigned_via ?? 'manual',
      }
    })
  } catch {
    return []
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await authAndLoad(id)
  if ('error' in auth) return auth.error
  return NextResponse.json({ assignees: await readAssignees(id) })
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await authAndLoad(id)
  if ('error' in auth) return auth.error
  const { hubUser, lead } = auth

  // Read-only guard (868kawwmh) — block lite_user + paused locations.
  const roBlock = await readOnlyWriteBlock(hubUser, lead.location_uuid)
  if (roBlock) return roBlock

  let body: any = {}
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const raw = body?.hub_user_ids
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    return NextResponse.json({ error: 'hub_user_ids_required' }, { status: 400 })
  }
  // De-dupe while preserving the caller's order — order decides which id lands
  // in leads.assigned_to.
  const ids = Array.from(new Set(raw.map((s) => s.trim()).filter(Boolean)))

  // Every assignee must be a real hub_user AND (unless the caller is admin)
  // belong to the lead's location. One bad id rejects the whole set rather
  // than silently assigning a subset.
  if (ids.length > 0) {
    const { data: found } = await supabaseService
      .from('hub_users')
      .select('id, location_id')
      .in('id', ids)
    const byId = new Map((found || []).map((u: any) => [u.id, u]))
    for (const uid of ids) {
      const u = byId.get(uid)
      if (!u) {
        return NextResponse.json({ error: 'assignee_not_found', hub_user_id: uid }, { status: 404 })
      }
      if (!isAdmin(hubUser.role) && u.location_id !== lead.location_uuid) {
        return NextResponse.json({ error: 'assignee_wrong_location', hub_user_id: uid }, { status: 400 })
      }
    }
  }

  // Replace the set. Delete-then-insert rather than a diff: the set is tiny,
  // and this is the only shape that makes "assign nobody" work.
  const { error: delErr } = await supabaseService
    .from('lead_assignees')
    .delete()
    .eq('lead_id', id)
  if (delErr) {
    // Almost certainly the migration not being applied yet — say so rather
    // than returning a bare Postgres string.
    return NextResponse.json(
      { error: 'lead_assignees_unavailable', detail: delErr.message },
      { status: 500 },
    )
  }

  if (ids.length > 0) {
    const { error: insErr } = await supabaseService.from('lead_assignees').insert(
      ids.map((hub_user_id) => ({ lead_id: id, hub_user_id, assigned_via: 'manual' })),
    )
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 })
    }
  }

  // Keep the legacy singular column in step. Not a second source of truth —
  // just compat for readers that predate the junction.
  const { error: leadErr } = await supabaseService
    .from('leads')
    .update({ assigned_to: ids[0] ?? null })
    .eq('id', id)
  if (leadErr) {
    console.error(`[lead-assignees] leads.assigned_to sync failed for ${id}: ${leadErr.message}`)
  }

  return NextResponse.json({ assignees: await readAssignees(id) })
}
