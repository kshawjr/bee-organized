// app/api/tags/own/route.ts
//
// GET /api/tags/own?location_id=<uuid> — a location's OWN tags (switched on
// and off), each with how many people carry it (clients + Network), for
// Settings › Tags (2026-10-16). Renames and switch-off/restore go through
// PATCH /api/lookups/[id], which carries the permission + near-match rules.
//
// Who: an owner or manager of that location (the param must be their own),
// or corporate for any location.

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { TAG_CATEGORIES } from '@/lib/tags'
import { LOCATION_TAG_ROLES } from '@/lib/tag-guard'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })

    const locationId = new URL(req.url).searchParams.get('location_id') || ''
    if (!UUID_RE.test(locationId)) return NextResponse.json({ error: 'invalid_location_id' }, { status: 400 })
    if (!isAdmin(hubUser.role)) {
      if (!LOCATION_TAG_ROLES.has(String(hubUser.role))) return NextResponse.json({ error: 'forbidden_role' }, { status: 403 })
      if (hubUser.location_id !== locationId) return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
    }

    const { data: tags, error } = await supabaseService
      .from('lookups')
      .select('id, label, icon, is_active, created_at, updated_at')
      .in('category', TAG_CATEGORIES)
      .eq('location_id', locationId)
      .order('label', { ascending: true })
    if (error) return NextResponse.json({ error: 'read_failed', detail: error.message }, { status: 500 })

    const ids = (tags || []).map((t: any) => t.id)
    const count = new Map<string, number>()
    if (ids.length) {
      const [leadLinks, partnerLinks] = await Promise.all([
        supabaseService.from('lead_tags').select('tag_lookup_id').in('tag_lookup_id', ids),
        supabaseService.from('partner_tags').select('tag_lookup_id').in('tag_lookup_id', ids),
      ])
      for (const r of [...(leadLinks.data || []), ...(partnerLinks.data || [])]) {
        count.set((r as any).tag_lookup_id, (count.get((r as any).tag_lookup_id) || 0) + 1)
      }
    }

    // Copies collapsed into a corporate tag ("Make corporate", not undone)
    // are switched off but are NOT the location's to restore — restoring one
    // would put a duplicate next to the corporate tag. Best effort: before
    // migrations/tag_make_corporate.sql runs the table doesn't exist.
    const promoted = new Set<string>()
    if (ids.length) {
      const { data: copies } = await supabaseService
        .from('tag_promotion_copies').select('tag_id, tag_promotions!inner(undone_at)')
        .in('tag_id', ids).is('tag_promotions.undone_at', null)
      for (const c of (copies || []) as any[]) promoted.add(c.tag_id)
    }

    return NextResponse.json({
      tags: (tags || []).map((t: any) => ({ ...t, people: count.get(t.id) || 0, ...(promoted.has(t.id) ? { promoted: true } : {}) })),
    })
  } catch (err: any) {
    console.error('[/api/tags/own GET] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
