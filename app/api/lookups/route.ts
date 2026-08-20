import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/lookups
// Optional query: ?category=client_stages&location_id=<uuid>
// Returns active lookups scoped to CORPORATE (location_id null) plus AT
// MOST ONE location's own rows — never another location's:
//   · owner / manager / lite_user — corporate + their own hub_users
//     location, always; a location_id param is IGNORED (it could name
//     someone else's location).
//   · super_admin / admin — corporate + the location named by the
//     location_id param (how "viewing a location" reaches a route that
//     only has the session: view-as is client-side). No param →
//     corporate only, which is exactly what the Configure tab manages.
//
// Response shape:
//   { lookups: [{ id, category, label, location_id, sort_order, color,
//                  bg_color, icon, description, attrs, is_active, ... }],
//     location: { id, name } | null }   ← the resolved own-location, so
//                  pickers can title their "<Location name>'s own" group.
//
// Callers typically group client-side by category.

export async function GET(req: NextRequest) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()

    const url = new URL(req.url)
    const category = url.searchParams.get('category')
    const requestedLocation = url.searchParams.get('location_id')

    // Resolve the ONE location whose own rows may accompany corporate.
    let ownLocation: string | null = null
    if (hubUser && isAdmin(hubUser.role)) {
      ownLocation = requestedLocation && UUID_RE.test(requestedLocation) ? requestedLocation : null
    } else {
      ownLocation = hubUser?.location_id || null
    }
    // hub_users.location_id is TEXT — if it doesn't hold a uuid, fall
    // back to corporate-only rather than feeding junk into the filter.
    if (ownLocation && !UUID_RE.test(ownLocation)) ownLocation = null

    let query = supabaseService
      .from('lookups')
      .select('id, category, label, location_id, sort_order, color, bg_color, icon, description, attrs, is_active, created_at, updated_at')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })

    query = ownLocation
      ? query.or(`location_id.is.null,location_id.eq.${ownLocation}`)
      : query.is('location_id', null)

    if (category) query = query.eq('category', category)

    const { data, error } = await query

    if (error) {
      console.error('[/api/lookups GET] error:', error.message)
      return NextResponse.json({ error: 'Failed to fetch lookups' }, { status: 500 })
    }

    // Hand pickers the location name for their own-group header.
    let location: { id: string; name: string } | null = null
    if (ownLocation) {
      const { data: locRow } = await supabaseService
        .from('locations')
        .select('id, name')
        .eq('id', ownLocation)
        .maybeSingle()
      if (locRow) location = locRow as any
    }

    return NextResponse.json({ lookups: data || [], location })
  } catch (err: any) {
    console.error('[/api/lookups GET] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

// POST /api/lookups
// Body: { category, label, location_id?, color?, bg_color?, icon?,
//         description?, attrs?, sort_order? }
//
// Creates a new lookup row, in one of two scopes:
//   · CORPORATE (no location_id in the body) — the original path: only
//     super_admin and admin can create; these rows are global across all
//     franchise locations (the Configure tab).
//   · LOCATION-OWNED (location_id present) — tag system step 2A, the
//     PickerModal's allowCreate. Owners/managers may create for THEIR OWN
//     location only; admins for any location. Restricted to the
//     location-scoped categories, duplicate labels (against corporate +
//     that location, case-insensitive) are rejected, and paused/inactive
//     locations are write-blocked like every other franchise write.
//
// sort_order defaults to (max + 10) within the category so new items append
// to the end of their list naturally. Admins can drag-reorder via the
// /reorder endpoint afterward.

const ALLOWED_CATEGORIES = new Set([
  'closed_lost_reasons',
  'client_tags',
  'project_types',
  'partner_specialties',
  'partner_tiers',
  'client_stages',
  'partner_stages',
  'lead_sources',
  'touchpoint_types',
  'partner_tags',
])

// The categories a LOCATION may own rows in (step 2A: tags only — widen
// deliberately in 2B, not by default: the project_types readers resolve
// by bare label and must never collide with a location's homonym).
const LOCATION_SCOPED_CATEGORIES = new Set(['client_tags', 'partner_tags'])

export async function POST(req: NextRequest) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const { category, label, location_id, color, bg_color, icon, description, attrs, sort_order } =
      (body || {}) as Record<string, any>

    if (!category || typeof category !== 'string' || !ALLOWED_CATEGORIES.has(category)) {
      return NextResponse.json({ error: 'Invalid or missing category' }, { status: 400 })
    }
    if (!label || typeof label !== 'string' || !label.trim()) {
      return NextResponse.json({ error: 'label is required' }, { status: 400 })
    }

    if (location_id != null) {
      // ── location-owned create (PickerModal allowCreate) ──────────
      if (typeof location_id !== 'string' || !UUID_RE.test(location_id)) {
        return NextResponse.json({ error: 'invalid_location_id' }, { status: 400 })
      }
      if (!LOCATION_SCOPED_CATEGORIES.has(category)) {
        return NextResponse.json({ error: 'category_not_location_scoped' }, { status: 400 })
      }
      if (!isAdmin(hubUser.role) && hubUser.location_id !== location_id) {
        return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
      }
      const roBlock = await readOnlyWriteBlock(hubUser, location_id)
      if (roBlock) return roBlock

      // Duplicate guard: one vocabulary per location = corporate + its own.
      // Escape ilike wildcards so a literal % or _ in a label can't widen
      // the match.
      const escaped = label.trim().replace(/[\\%_]/g, (m: string) => `\\${m}`)
      const { data: dup } = await supabaseService
        .from('lookups')
        .select('id')
        .eq('category', category)
        .eq('is_active', true)
        .ilike('label', escaped)
        .or(`location_id.is.null,location_id.eq.${location_id}`)
        .limit(1)
        .maybeSingle()
      if (dup) {
        return NextResponse.json({ error: 'label_already_exists' }, { status: 409 })
      }
    } else if (hubUser.role !== 'super_admin' && hubUser.role !== 'admin') {
      // ── corporate create — unchanged: admins only ─────────────────
      return NextResponse.json({ error: 'Only super_admin or admin can manage lookups' }, { status: 403 })
    }

    // Compute sort_order if not provided: max existing in this category + 10.
    let nextSortOrder = typeof sort_order === 'number' ? sort_order : 0
    if (typeof sort_order !== 'number') {
      const { data: maxRow } = await supabaseService
        .from('lookups')
        .select('sort_order')
        .eq('category', category)
        .eq('is_active', true)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle()
      nextSortOrder = ((maxRow?.sort_order as number) ?? 0) + 10
    }

    const insert: Record<string, any> = {
      category,
      label: label.trim(),
      sort_order: nextSortOrder,
      attrs: attrs && typeof attrs === 'object' ? attrs : {},
    }
    if (location_id != null) insert.location_id = location_id
    if (typeof color       === 'string') insert.color       = color.trim()       || null
    if (typeof bg_color    === 'string') insert.bg_color    = bg_color.trim()    || null
    if (typeof icon        === 'string') insert.icon        = icon.trim()        || null
    if (typeof description === 'string') insert.description = description.trim() || null

    const { data, error } = await supabaseService
      .from('lookups')
      .insert(insert)
      .select('id, category, label, location_id, sort_order, color, bg_color, icon, description, attrs, is_active')
      .single()

    if (error) {
      console.error('[/api/lookups POST] error:', error.message)
      return NextResponse.json({ error: 'Failed to create lookup' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, lookup: data })
  } catch (err: any) {
    console.error('[/api/lookups POST] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
