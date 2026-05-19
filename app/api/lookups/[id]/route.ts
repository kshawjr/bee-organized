import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

// PATCH /api/lookups/[id]
// Body: any subset of { label, color, bg_color, icon, description, attrs, sort_order, is_active }
//
// Soft-delete is exposed here too via PATCH { is_active: false }. We don't
// hard-delete because existing client/partner records may carry references
// to a deprecated tag/specialty/stage via label match — keeping the row
// inactive preserves historical readability without polluting active lists.
//
// Write permission: super_admin or admin (corporate) only. Same shape as
// POST /api/lookups.

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
    if (hubUser.role !== 'super_admin' && hubUser.role !== 'admin') {
      return NextResponse.json({ error: 'Only super_admin or admin can manage lookups' }, { status: 403 })
    }

    const id = params?.id
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const body = await req.json().catch(() => ({}))
    const update: Record<string, any> = {}

    if (typeof body.label === 'string' && body.label.trim()) {
      update.label = body.label.trim()
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
    if (hubUser.role !== 'super_admin' && hubUser.role !== 'admin') {
      return NextResponse.json({ error: 'Only super_admin or admin can manage lookups' }, { status: 403 })
    }

    const id = params?.id
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

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
