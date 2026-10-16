// app/api/tags/delete/route.ts
//
// POST { id } — PERMANENTLY delete a tag nobody needs (2026-10-16).
//   · a location's own tag: its owner or manager (or corporate)
//   · a switched-off corporate tag that was never part of the merge:
//     corporate only
// The database decides and deletes in one step (delete_tag_if_unused,
// migrations/tag_delete.sql): if anyone carries it or any undo log names it,
// nothing is deleted and the answer says why (409 + blockers).

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { isTagCategory, describeTagBlockers } from '@/lib/tags'
import { canManageLocationTag } from '@/lib/tag-guard'

export async function POST(req: NextRequest) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    const body = await req.json().catch(() => ({}))
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

    const { data: row } = await supabaseService
      .from('lookups').select('id, category, label, location_id').eq('id', id).maybeSingle()
    if (!row || !isTagCategory((row as any).category)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const corporate = isAdmin(hubUser.role)
    if ((row as any).location_id) {
      if (!corporate && !canManageLocationTag(hubUser as any, row as any)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      if (!corporate) {
        const roBlock = await readOnlyWriteBlock(hubUser as any, (row as any).location_id)
        if (roBlock) return roBlock
      }
    } else if (!corporate) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const { data: blockers, error } = await supabaseService.rpc('delete_tag_if_unused', { p_id: id, p_by: hubUser.id })
    if (error) return NextResponse.json({ error: 'delete_failed', detail: error.message }, { status: 500 })
    const b: string[] = Array.isArray(blockers) ? blockers : []
    if (b.length) return NextResponse.json({ deleted: false, blockers: b, reason: describeTagBlockers(b) }, { status: 409 })
    return NextResponse.json({ deleted: true, label: (row as any).label })
  } catch (err: any) {
    console.error('[/api/tags/delete POST] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
