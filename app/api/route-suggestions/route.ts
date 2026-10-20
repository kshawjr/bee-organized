// app/api/route-suggestions/route.ts
// ─────────────────────────────────────────────────────────────
// GET /api/route-suggestions?ids=<lead id>,<lead id>,… — corp/admin only.
//
// What Other's Slack card would suggest, for the leads on the Inbox's
// Needs-transfer page — read through the SAME lib/route-suggestion
// suggestRoutesForLeads the card uses, so the row and the card can never
// disagree (Kevin, 20 Oct 2026). Reads only.
//
// Returns { suggestions: { <lead id>: RouteSuggestion | null }, locations:
// { <slug>: <location id> } }. null = not in Other (moved meanwhile) or not
// found. `locations` carries the id each suggested hive's one-press move needs
// (the suggestion names hives by slug).
//
// At most 50 ids a call — the queue shows ten at a time.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { suggestRoutesForLeads } from '@/lib/route-suggestion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_IDS = 50

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  if (!isAdmin(hubUser.role)) return NextResponse.json({ error: 'forbidden_admin_only' }, { status: 403 })

  const ids = Array.from(new Set((req.nextUrl.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean)))
  if (ids.length === 0) return NextResponse.json({ suggestions: {}, locations: {} })
  if (ids.length > MAX_IDS) return NextResponse.json({ error: 'too_many_ids', max: MAX_IDS }, { status: 400 })

  let map
  try {
    map = await suggestRoutesForLeads(ids)
  } catch (err: any) {
    return NextResponse.json({ error: 'suggestion_failed', detail: String(err?.message || err) }, { status: 503 })
  }

  const suggestions: Record<string, any> = {}
  const slugs = new Set<string>()
  for (const [id, s] of Array.from(map.entries())) {
    suggestions[id] = s
    for (const o of s?.options ?? []) slugs.add(o.slug)
  }
  const locations: Record<string, string> = {}
  if (slugs.size) {
    const { data: locs } = await supabaseService.from('locations').select('id, location_id').in('location_id', Array.from(slugs))
    for (const l of (locs as any[]) || []) locations[l.location_id] = l.id
  }
  return NextResponse.json({ suggestions, locations })
}
