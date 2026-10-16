// app/api/tags/make-corporate/undo/route.ts
//
// POST { promotionId } — corporate only. Reverses one "Make corporate"
// exactly (undo_tag_promotion() in migrations/tag_make_corporate.sql): the
// links it added go, each location copy returns to the on/off state it had,
// and the corporate tag is removed if promotion created it and nobody has
// been given it since (otherwise switched off, keeping those links).

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

export async function POST(req: NextRequest) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser || !isAdmin(hubUser.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    const body = await req.json().catch(() => ({}))
    const id = typeof body?.promotionId === 'string' ? body.promotionId : ''
    if (!id) return NextResponse.json({ error: 'promotion_required' }, { status: 400 })
    const { data, error } = await supabaseService.rpc('undo_tag_promotion', { p_promotion_id: id })
    if (error) return NextResponse.json({ error: 'undo_failed', detail: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, receipt: data })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
