import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { isTagCategory } from '@/lib/tags'
import { canManageLocationTag, checkNearTag, nearMatchBody } from '@/lib/tag-guard'

// PATCH /api/lookups/[id]
// Body: any subset of { label, color, bg_color, icon, description, attrs, sort_order, is_active }
//
// Soft-delete is exposed here too via PATCH { is_active: false }. We don't
// hard-delete because existing client/partner records may carry references
// to a deprecated tag/specialty/stage via label match — keeping the row
// inactive preserves historical readability without polluting active lists.
//
// Write permission: super_admin or admin (corporate) — anything. Since
// 2026-10-16 an owner or manager may also rename or switch off/on their OWN
// location's tags (label + is_active only). Every tag rename passes the
// near-match guard (lib/tag-guard), excluding the tag itself.

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }
    const id = params?.id
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const { data: row } = await supabaseService
      .from('lookups').select('id, category, label, location_id').eq('id', id).maybeSingle()
    if (!row) return NextResponse.json({ error: 'Lookup not found' }, { status: 404 })

    const corporate = hubUser.role === 'super_admin' || hubUser.role === 'admin'
    const locationTagEditor = !corporate && canManageLocationTag(hubUser as any, row as any)
    if (!corporate && !locationTagEditor) {
      return NextResponse.json({ error: 'Only super_admin or admin can manage lookups' }, { status: 403 })
    }
    if (locationTagEditor) {
      const roBlock = await readOnlyWriteBlock(hubUser as any, (row as any).location_id)
      if (roBlock) return roBlock
    }

    const body = await req.json().catch(() => ({}))
    const update: Record<string, any> = {}

    if (typeof body.label === 'string' && body.label.trim()) {
      update.label = body.label.trim()
    }
    // A location editor may change the name and switch it off/on — nothing
    // else (colour, icon, section and order stay corporate's call).
    if (locationTagEditor) {
      for (const k of Object.keys(body || {})) {
        if (k !== 'label' && k !== 'is_active') return NextResponse.json({ error: 'field_not_editable', field: k }, { status: 403 })
      }
    }
    // A copy collapsed into a corporate tag stays off until the promotion is
    // undone — switching it back on would duplicate the corporate tag.
    if (locationTagEditor && body?.is_active === true) {
      const { data: promo } = await supabaseService
        .from('tag_promotion_copies').select('tag_id, tag_promotions!inner(undone_at)')
        .eq('tag_id', id).is('tag_promotions.undone_at', null).limit(1)
      if ((promo || []).length) return NextResponse.json({ error: 'promoted_to_corporate' }, { status: 409 })
    }
    // Every tag rename passes the near-match guard (not against itself).
    if (update.label && isTagCategory((row as any).category) && update.label !== (row as any).label) {
      const v = await checkNearTag(update.label, (row as any).location_id || null, id)
      const corp = !(row as any).location_id && v.kind === 'retired' ? { kind: 'restore' as const, tag: v.tag } : v
      const blocked = nearMatchBody(corp)
      if (blocked) return NextResponse.json(blocked, { status: 409 })
    }
    if (typeof body.color === 'string') {
      update.color = body.color.trim() || null
    }
    if (typeof body.bg_color === 'string') {
      update.bg_color = body.bg_color.trim() || null
    }
    if (typeof body.icon === 'string') {
      update.icon = body.icon.trim() || null
    }
    if (typeof body.description === 'string') {
      update.description = body.description.trim() || null
    }
    if (body.attrs && typeof body.attrs === 'object' && !Array.isArray(body.attrs)) {
      update.attrs = body.attrs
    }
    if (typeof body.sort_order === 'number') {
      update.sort_order = body.sort_order
    }
    if (typeof body.is_active === 'boolean') {
      update.is_active = body.is_active
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    update.updated_at = new Date().toISOString()

    const { data, error } = await supabaseService
      .from('lookups')
      .update(update)
      .eq('id', id)
      .select('id, category, label, sort_order, color, bg_color, icon, description, attrs, is_active')
      .single()

    if (error) {
      console.error('[/api/lookups/[id] PATCH] error:', error.message)
      return NextResponse.json({ error: 'Failed to update lookup' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Lookup not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true, lookup: data })
  } catch (err: any) {
    console.error('[/api/lookups/[id] PATCH] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

// DELETE /api/lookups/[id]
// Soft-delete shortcut — equivalent to PATCH { is_active: false }.
// Returns the deactivated row so the client can immediately remove it
// from the active list without a refetch.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }
    const id = params?.id
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
    if (hubUser.role !== 'super_admin' && hubUser.role !== 'admin') {
      // Same rule as PATCH: a location editor may switch off its own tag.
      const { data: row } = await supabaseService
        .from('lookups').select('id, category, location_id').eq('id', id).maybeSingle()
      if (!row || !canManageLocationTag(hubUser as any, row as any)) {
        return NextResponse.json({ error: 'Only super_admin or admin can manage lookups' }, { status: 403 })
      }
      const roBlock = await readOnlyWriteBlock(hubUser as any, (row as any).location_id)
      if (roBlock) return roBlock
    }

    const { data, error } = await supabaseService
      .from('lookups')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, category, label, is_active')
      .single()

    if (error) {
      console.error('[/api/lookups/[id] DELETE] error:', error.message)
      return NextResponse.json({ error: 'Failed to delete lookup' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Lookup not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true, lookup: data })
  } catch (err: any) {
    console.error('[/api/lookups/[id] DELETE] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
