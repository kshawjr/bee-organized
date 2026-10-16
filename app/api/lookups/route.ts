import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { TAG_CATEGORY, TAG_CATEGORIES, TAG_SECTIONS } from '@/lib/tags'
import { checkNearTag, nearMatchBody, fileRetiredTagRequest, LOCATION_TAG_ROLES } from '@/lib/tag-guard'

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
// ?category=tags is THE one tag list (lib/tags.ts): it matches the merged
// 'tags' rows AND the three pre-merge categories, so the picker shows the
// whole list on either side of migrations/tag_merge_2_one_list.sql.
//
// Callers typically group client-side by category.

export async function GET(req: NextRequest) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()

    const url = new URL(req.url)
    const category = url.searchParams.get('category')
    const requestedLocation = url.searchParams.get('location_id')
    // ?include_inactive=1, tags only: switched-off rows too, flagged
    // is_active:false — the picker needs them to warn ("corporate retired
    // Housekeeper", "you removed Snowbird") but never offers them as options.
    const includeInactive = category === TAG_CATEGORY && url.searchParams.get('include_inactive') === '1'

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
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })

    if (!includeInactive) query = query.eq('is_active', true)
    query = ownLocation
      ? query.or(`location_id.is.null,location_id.eq.${ownLocation}`)
      : query.is('location_id', null)

    if (category === TAG_CATEGORY) query = query.in('category', TAG_CATEGORIES)
    else if (category) query = query.eq('category', category)

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

// The three pre-merge tag categories (client_tags, partner_specialties,
// partner_tags) are NOT creatable any more — a new tag goes to the one
// list, 'tags' (lib/tags.ts).
const ALLOWED_CATEGORIES = new Set([
  'closed_lost_reasons',
  'project_types',
  'partner_tiers',
  'client_stages',
  'partner_stages',
  'lead_sources',
  'touchpoint_types',
  TAG_CATEGORY,
])

// The categories a LOCATION may own rows in: tags (2026-10-16, Kevin). After
// the merge they were corporate-only for a day; owners and managers may now
// create their location's own again — behind the near-match guard
// (lib/tags.ts tagKey): no tag that normalises to the same name as a
// corporate tag (on or off) or one of the location's own. A switched-off
// CORPORATE match does not block: the location gets its tag and corporate
// gets a request to bring theirs back (lib/tag-guard).
const LOCATION_SCOPED_CATEGORIES = new Set<string>([TAG_CATEGORY])

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

    let nearVerdict: Awaited<ReturnType<typeof checkNearTag>> = { kind: 'none' }
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
      // Read-only staff apply nothing and create nothing.
      if (!isAdmin(hubUser.role) && !LOCATION_TAG_ROLES.has(String(hubUser.role))) {
        return NextResponse.json({ error: 'forbidden_role' }, { status: 403 })
      }
      const roBlock = await readOnlyWriteBlock(hubUser, location_id)
      if (roBlock) return roBlock

      // The near-match guard (lib/tags.ts tagKey — case, spacing,
      // punctuation, plurals): blocked when it matches an ACTIVE tag (use
      // that) or one of the location's own switched-off tags (restore it).
      // A switched-off corporate tag does not block — see after the insert.
      nearVerdict = await checkNearTag(label, location_id)
      const blocked = nearMatchBody(nearVerdict)
      if (blocked) return NextResponse.json(blocked, { status: 409 })
    } else if (hubUser.role !== 'super_admin' && hubUser.role !== 'admin') {
      // ── corporate create — unchanged: admins only ─────────────────
      return NextResponse.json({ error: 'Only super_admin or admin can manage lookups' }, { status: 403 })
    } else if (category === TAG_CATEGORY) {
      // A corporate tag must not near-match an existing corporate one,
      // switched on (use it) or off (switch it back on instead).
      const v = await checkNearTag(label, null)
      const corp = v.kind === 'retired' ? { kind: 'restore' as const, tag: v.tag } : v
      const blocked = nearMatchBody(corp)
      if (blocked) return NextResponse.json(blocked, { status: 409 })
    }

    // Compute sort_order if not provided: max existing in this category + 10.
    let nextSortOrder = typeof sort_order === 'number' ? sort_order : 0
    if (typeof sort_order !== 'number') {
      let maxQuery = supabaseService
        .from('lookups')
        .select('sort_order')
        .eq('is_active', true)
      // The one tag list spans the pre-merge categories until step 2 runs;
      // a new tag sorts after all of them, and after the 1000/2000/3000
      // bands tag_merge_2_one_list.sql re-bases them into.
      maxQuery = category === TAG_CATEGORY ? maxQuery.in('category', TAG_CATEGORIES) : maxQuery.eq('category', category)
      const { data: maxRow } = await maxQuery
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle()
      const floor = category === TAG_CATEGORY ? 3990 : 0
      nextSortOrder = Math.max((maxRow?.sort_order as number) ?? 0, floor) + 10
    }

    const insert: Record<string, any> = {
      category,
      label: label.trim(),
      sort_order: nextSortOrder,
      attrs: attrs && typeof attrs === 'object' ? attrs : {},
    }
    // A tag always carries a valid section (lib/tags.ts). The Configure tab
    // makes corporate choose; anything else reaching here lands in Trade —
    // the same place a section-less tag shows.
    if (category === TAG_CATEGORY && !TAG_SECTIONS.some((s) => s.key === insert.attrs.section)) {
      insert.attrs = { ...insert.attrs, section: 'trade' }
    }
    if (location_id != null) {
      insert.location_id = location_id
      // Who made it — lookups has no creator column; corporate's Location
      // tags panel reads this (no schema change).
      insert.attrs = { ...insert.attrs, created_by_user: hubUser.id }
    }
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

    // A location made its own copy of a tag corporate retired: corporate
    // hears about it (feedback queue), the location keeps its tag.
    if (location_id != null && nearVerdict.kind === 'retired') {
      await fileRetiredTagRequest({ userId: hubUser.id, locationId: location_id, retiredLabel: nearVerdict.tag.label, newLabel: label.trim() })
    }

    return NextResponse.json({ ok: true, lookup: data, ...(nearVerdict.kind === 'retired' ? { retired: { id: nearVerdict.tag.id, label: nearVerdict.tag.label } } : {}) })
  } catch (err: any) {
    console.error('[/api/lookups POST] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
