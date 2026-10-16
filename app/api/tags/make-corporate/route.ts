// app/api/tags/make-corporate/route.ts
//
// "Make corporate" (Configure › Location tags) — corporate only.
//
// POST { tagIds, label, icon, section, dryRun }
//   Collapse these location tags into one corporate tag. If a corporate tag
//   already near-matches the name (lib/tags.ts tagKey), THAT is the target
//   (switched back on if it was off) instead of a new one.
//   dryRun: true → the preview only: what would be created / used, how many
//   clients and Network people move onto it, which copies switch off. Nothing
//   is written.
//   dryRun: false → runs make_tag_corporate() (migrations/
//   tag_make_corporate.sql) — one transaction, fully logged — and returns the
//   promotion id for Undo.
// GET → the recent promotions (for Undo).
//
// Moving people ADDS a link to the corporate tag and keeps their link to the
// switched-off copy, so undo_tag_promotion() puts everything back exactly.

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { TAG_CATEGORIES, tagKey } from '@/lib/tags'

const SECTIONS = new Set(['relationship', 'trade'])

async function corporateOnly() {
  await requireAuth()
  const hubUser = await getHubUser()
  if (!hubUser || !isAdmin(hubUser.role)) return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  return { hubUser }
}

export async function GET() {
  try {
    const auth = await corporateOnly()
    if (auth.error) return auth.error
    const { data, error } = await supabaseService
      .from('tag_promotions')
      .select('id, created_at, note, corporate_tag_id, corporate_tag_created, undone_at')
      .order('created_at', { ascending: false })
      .limit(10)
    if (error) return NextResponse.json({ promotions: [], unavailable: error.message })
    const tagIds = Array.from(new Set((data || []).map((p: any) => p.corporate_tag_id)))
    const { data: tags } = tagIds.length
      ? await supabaseService.from('lookups').select('id, label, icon').in('id', tagIds)
      : { data: [] as any[] }
    const byId = new Map((tags || []).map((t: any) => [t.id, t]))
    return NextResponse.json({ promotions: (data || []).map((p: any) => ({ ...p, tag: byId.get(p.corporate_tag_id) || null })) })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await corporateOnly()
    if (auth.error) return auth.error
    const body = await req.json().catch(() => ({}))
    const tagIds: string[] = Array.isArray(body?.tagIds) ? Array.from(new Set(body.tagIds.filter((x: any) => typeof x === 'string'))) : []
    const label = typeof body?.label === 'string' ? body.label.trim() : ''
    const icon = typeof body?.icon === 'string' ? body.icon.trim() : ''
    const section = String(body?.section || '')
    const dryRun = body?.dryRun !== false
    if (!tagIds.length) return NextResponse.json({ error: 'no_tags' }, { status: 400 })
    if (!label) return NextResponse.json({ error: 'label_required' }, { status: 400 })

    // The copies — every one must be a location-owned tag.
    const { data: copies, error: copyErr } = await supabaseService
      .from('lookups')
      .select('id, label, icon, is_active, location_id, sort_order, location:locations(name)')
      .in('id', tagIds)
      .in('category', TAG_CATEGORIES)
      .not('location_id', 'is', null)
    if (copyErr) return NextResponse.json({ error: 'read_failed', detail: copyErr.message }, { status: 500 })
    if ((copies || []).length !== tagIds.length) return NextResponse.json({ error: 'not_all_location_tags' }, { status: 400 })

    // An existing corporate tag with the same name (on or off) is the target.
    const { data: corp } = await supabaseService
      .from('lookups')
      .select('id, label, icon, is_active, attrs')
      .in('category', TAG_CATEGORIES)
      .is('location_id', null)
    const target = (corp || []).find((t: any) => tagKey(t.label) === tagKey(label)) || null
    if (!target && !SECTIONS.has(section)) return NextResponse.json({ error: 'section_required' }, { status: 400 })

    // Who moves: distinct people carrying any copy; who already has the target.
    const [leadLinks, partnerLinks] = await Promise.all([
      supabaseService.from('lead_tags').select('lead_id, tag_lookup_id').in('tag_lookup_id', [...tagIds, ...(target ? [target.id] : [])]),
      supabaseService.from('partner_tags').select('partner_id, tag_lookup_id').in('tag_lookup_id', [...tagIds, ...(target ? [target.id] : [])]),
    ])
    const count = (rows: any[], col: string) => {
      const carriers = new Set(rows.filter(r => tagIds.includes(r.tag_lookup_id)).map(r => r[col]))
      const already = new Set(rows.filter(r => target && r.tag_lookup_id === target.id).map(r => r[col]))
      return { carriers: carriers.size, alreadyOnTarget: Array.from(carriers).filter(id => already.has(id)).length }
    }
    const clients = count((leadLinks as any).data || [], 'lead_id')
    const network = count((partnerLinks as any).data || [], 'partner_id')
    const sortOrder = (copies || []).length === 1 ? (copies as any[])[0].sort_order : null

    const plan = {
      target: target
        ? { kind: 'existing', id: target.id, label: target.label, icon: target.icon || null, wasActive: target.is_active !== false }
        : { kind: 'new', label, icon: icon || null, section, sortOrder },
      clients: { ...clients, linksAdded: clients.carriers - clients.alreadyOnTarget },
      network: { ...network, linksAdded: network.carriers - network.alreadyOnTarget },
      copies: (copies || []).map((c: any) => ({ id: c.id, label: c.label, location: c.location?.name || null, isActive: c.is_active !== false })),
    }
    if (dryRun) return NextResponse.json({ dryRun: true, plan })

    const { data: promotionId, error: rpcErr } = await supabaseService.rpc('make_tag_corporate', {
      p_copy_ids: tagIds,
      p_label: target ? null : label,
      p_icon: target ? null : (icon || null),
      p_section: target ? null : section,
      p_target_id: target ? target.id : null,
      p_sort_order: target ? null : sortOrder,
      p_by: auth.hubUser!.id,
      p_note: `Configure › Location tags: "${label}" from ${plan.copies.map(c => c.location).filter(Boolean).join(', ')}`,
    })
    if (rpcErr) return NextResponse.json({ error: 'promotion_failed', detail: rpcErr.message, plan }, { status: 500 })
    return NextResponse.json({ ok: true, promotionId, plan })
  } catch (err: any) {
    console.error('[/api/tags/make-corporate POST] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
