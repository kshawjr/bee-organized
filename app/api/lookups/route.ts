import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

// GET /api/lookups
// Optional query: ?category=client_stages
// Returns all active lookups (or category-filtered), ordered by sort_order.
// Open to any signed-in user — reads are needed across every screen.
//
// Response shape:
//   { lookups: [{ id, category, label, sort_order, color, bg_color, icon,
//                  description, attrs, is_active, ... }, ...] }
//
// Callers typically group client-side by category. page.tsx does a single
// GET with no filter and groups into a Record<category, Lookup[]> for the
// LookupsContext provider.

export async function GET(req: NextRequest) {
  try {
    await requireAuth()

    const url = new URL(req.url)
    const category = url.searchParams.get('category')

    let query = supabaseService
      .from('lookups')
      .select('id, category, label, sort_order, color, bg_color, icon, description, attrs, is_active, created_at, updated_at')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })

    if (category) query = query.eq('category', category)

    const { data, error } = await query

    if (error) {
      console.error('[/api/lookups GET] error:', error.message)
      return NextResponse.json({ error: 'Failed to fetch lookups' }, { status: 500 })
    }

    return NextResponse.json({ lookups: data || [] })
  } catch (err: any) {
    console.error('[/api/lookups GET] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

// POST /api/lookups
// Body: { category, label, color?, bg_color?, icon?, description?, attrs?, sort_order? }
//
// Creates a new lookup row. Org-level write — only super_admin and admin
// (corporate) can create; franchise owners and lite_users get 403. Lookups
// are global across all 50 franchise locations.
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
])

export async function POST(req: NextRequest) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }
    if (hubUser.role !== 'super_admin' && hubUser.role !== 'admin') {
      return NextResponse.json({ error: 'Only super_admin or admin can manage lookups' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const { category, label, color, bg_color, icon, description, attrs, sort_order } =
      (body || {}) as Record<string, any>

    if (!category || typeof category !== 'string' || !ALLOWED_CATEGORIES.has(category)) {
      return NextResponse.json({ error: 'Invalid or missing category' }, { status: 400 })
    }
    if (!label || typeof label !== 'string' || !label.trim()) {
      return NextResponse.json({ error: 'label is required' }, { status: 400 })
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
    if (typeof color       === 'string') insert.color       = color.trim()       || null
    if (typeof bg_color    === 'string') insert.bg_color    = bg_color.trim()    || null
    if (typeof icon        === 'string') insert.icon        = icon.trim()        || null
    if (typeof description === 'string') insert.description = description.trim() || null

    const { data, error } = await supabaseService
      .from('lookups')
      .insert(insert)
      .select('id, category, label, sort_order, color, bg_color, icon, description, attrs, is_active')
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
