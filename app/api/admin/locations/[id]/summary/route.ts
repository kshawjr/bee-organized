// app/api/admin/locations/[id]/summary/route.ts
//
// GET /api/admin/locations/:id/summary — corp/admin only.
//
// Backs LocationDrilldown (components/BeeHub.jsx), which reached into the
// loaded people graph and did `people.filter(p => p.locationId === loc.id)` for
// an ARBITRARY location — the Active/Closed KPIs and the per-stage pipeline
// bars. That only ever worked because 'All Locations' loaded every lead in the
// tenant. Fix 2 Phase 4 stops loading them, so the drilldown reads counts from
// here instead.
//
// Everything is head:true — no rows cross the wire, only numbers. That is the
// whole point: the drilldown needs five integers and a histogram, and used to
// pay 28.57 MB for them.
//
// ⚠️ The drilldown's "Revenue Trend" chart is seedRevByLoc() — DETERMINISTIC
// FAKE DATA keyed off the location id, and has been since long before this
// change. It is deliberately NOT implemented here: building a real revenue
// series to feed a chart nobody has specified would be inventing a number, and
// silently swapping real data under a fake chart is worse than leaving the fake
// one visibly fake. Flagged separately for Kevin.
//
// Counts are derived the same way the board is: ENGAGEMENT stage, not the
// legacy person-level `stage` string the old drilldown filtered on. That is a
// deliberate correction — engagements are the system of record for stage since
// HIVE Phase 1, and the scoped board already reads them.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { ENGAGEMENT_STAGES, CLOSED_STAGE_FILTERS } from '@/components/hive/shared/stageConfig'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The open (non-terminal) stages the pipeline bars render, in board order.
// DERIVED from the stage machine rather than re-typed: a hand-written list here
// would silently omit a stage the board later gains, and the bars would just...
// not show it. stageConfig is the authority.
const OPEN_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal).map(s => s.key)
// `CLOSED_STAGE_FILTERS.closed` is an OBJECT KEY holding the terminal pair —
// not an array of filters. Reading it wrong yields a malformed PostgREST `in`
// list, which matches nothing and reports success.
const TERMINAL_IN = `("${CLOSED_STAGE_FILTERS.closed.join('","')}")`

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_location_id' }, { status: 400 })
  }

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users').select('id, role, location_id').eq('id', user.id).single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }
  // Elevated only — this reads ANY location by id, which is exactly what a
  // franchise user must not be able to do. Same gate as the sibling admin
  // routes (transfer-targets, invite-owner).
  if (!isAdmin(hubUser.role)) {
    return NextResponse.json({ error: 'forbidden_admin_only' }, { status: 403 })
  }

  const { data: loc, error: locErr } = await supabaseService
    .from('locations').select('id, name, location_id').eq('id', id).maybeSingle()
  if (locErr) {
    return NextResponse.json({ error: 'location_lookup_failed', detail: locErr.message }, { status: 500 })
  }
  if (!loc) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  const countEng = (build: (q: any) => any) =>
    build(supabaseService.from('engagements').select('id', { count: 'exact', head: true })
      .eq('location_uuid', id))

  const [leadsRes, activeRes, wonRes, lostRes, ...stageRes] = await Promise.all([
    supabaseService.from('leads').select('id', { count: 'exact', head: true })
      .eq('location_uuid', id).not('is_junk', 'is', true),
    // Active = OPEN engagements, matching the board's own definition.
    countEng((q: any) => q.not('stage', 'in', TERMINAL_IN)),
    countEng((q: any) => q.eq('stage', 'Closed Won')),
    countEng((q: any) => q.eq('stage', 'Closed Lost')),
    ...OPEN_STAGES.map(stage => countEng((q: any) => q.eq('stage', stage))),
  ])

  const stageCounts: Record<string, number> = {}
  OPEN_STAGES.forEach((stage, i) => { stageCounts[stage] = stageRes[i]?.count ?? 0 })

  const err = [leadsRes, activeRes, wonRes, lostRes, ...stageRes].find((r: any) => r?.error)
  if (err) {
    console.error('[location-summary] count failed:', (err as any).error.message)
    return NextResponse.json({ error: 'count_failed', detail: (err as any).error.message }, { status: 500 })
  }

  return NextResponse.json({
    location: { id: loc.id, name: loc.name, slug: loc.location_id },
    leads: leadsRes.count ?? 0,
    active: activeRes.count ?? 0,
    closedWon: wonRes.count ?? 0,
    closedLost: lostRes.count ?? 0,
    stageCounts,
  })
}
