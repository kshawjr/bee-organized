// app/api/engagements/route.ts
//
// GET /api/engagements?closed=1[&stage=won|lost][&location_uuid=][&offset=][&limit=]
//
// Collection endpoint for the EngagementList's lazy 'Closed' page — the
// initial page load deliberately ships only OPEN engagements plus a
// closed COUNT, so ~1,400 terminal rows never ride in the page payload.
// Returns { rows, total, offset, limit } ordered closed_at desc; rows
// carry client_name (joined) in the same shape the list renders.
//
// Only closed=1 is supported — open engagements ship server-rendered via
// _hub-page. Auth: logged-in hub_user; elevated may scope with
// location_uuid; everyone else is forced to their own location.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
// PURE zero-import module (§8.5) — safe from the server route; ONE
// source for the terminal stage strings ('Closed Won' / 'Closed Lost').
import { CLOSED_STAGE_FILTERS } from '@/components/hive/shared/stageConfig'

export async function GET(req: Request) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  const url = new URL(req.url)
  if (url.searchParams.get('closed') !== '1') {
    return NextResponse.json({ error: 'unsupported_query', hint: 'only closed=1 is served here' }, { status: 400 })
  }
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0)
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200))

  // Optional won/lost narrowing — vocabulary lives in stageConfig, the
  // audited stage strings, never inline literals.
  const stageParam = url.searchParams.get('stage') || 'closed'
  const stages = (CLOSED_STAGE_FILTERS as Record<string, string[]>)[stageParam]
  if (!stages) {
    return NextResponse.json({ error: 'unsupported_stage', hint: 'stage must be won or lost' }, { status: 400 })
  }

  // Scope: owners locked to their location; elevated may pass one.
  const requestedLoc = url.searchParams.get('location_uuid')
  const scopeLoc = isAdmin(hubUser.role)
    ? (requestedLoc || null)
    : hubUser.location_id

  let q = supabaseService
    .from('engagements')
    .select('*', { count: 'exact' })
    .in('stage', stages)
    .order('closed_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (scopeLoc) q = q.eq('location_uuid', scopeLoc)

  const { data: rows, count, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Join client name + contact for this page in one query.
  const clientIds = Array.from(new Set((rows ?? []).map(r => r.client_id).filter(Boolean)))
  const infoById: Record<string, { name: string; phone: string | null; email: string | null }> = {}
  if (clientIds.length > 0) {
    const { data: leads } = await supabaseService
      .from('leads')
      .select('id, name, phone, email')
      .in('id', clientIds)
    for (const l of leads ?? []) infoById[l.id] = { name: l.name || 'Unknown', phone: l.phone || null, email: l.email || null }
  }

  return NextResponse.json({
    rows: (rows ?? []).map(r => ({
      ...r,
      client_name: infoById[r.client_id]?.name || 'Unknown',
      client_phone: infoById[r.client_id]?.phone ?? null,
      client_email: infoById[r.client_id]?.email ?? null,
    })),
    total: count ?? 0,
    offset,
    limit,
  })
}
