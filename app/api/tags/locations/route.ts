// app/api/tags/locations/route.ts
//
// GET /api/tags/locations — corporate only. Every location-owned tag across
// every location (switched on and off), grouped by the near-match key
// (lib/tags.ts tagKey) so "Organizer" made separately at six locations reads
// as ONE row: "6 locations, 41 people". The signal for which location tags
// should become corporate ones ("Make corporate" is a later, separate step
// with its own dry run). Read-only.

import { NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { TAG_CATEGORIES, tagKey } from '@/lib/tags'

export async function GET() {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser || !isAdmin(hubUser.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

    const { data: tags, error } = await supabaseService
      .from('lookups')
      .select('id, label, icon, is_active, location_id, created_at, attrs, location:locations(name)')
      .in('category', TAG_CATEGORIES)
      .not('location_id', 'is', null)
    if (error) return NextResponse.json({ error: 'read_failed', detail: error.message }, { status: 500 })

    const ids = (tags || []).map((t: any) => t.id)
    const count = new Map<string, number>()
    const userIds = Array.from(new Set((tags || []).map((t: any) => t.attrs?.created_by_user).filter(Boolean)))
    const [leadLinks, partnerLinks, users] = await Promise.all([
      ids.length ? supabaseService.from('lead_tags').select('tag_lookup_id').in('tag_lookup_id', ids) : Promise.resolve({ data: [] as any[] }),
      ids.length ? supabaseService.from('partner_tags').select('tag_lookup_id').in('tag_lookup_id', ids) : Promise.resolve({ data: [] as any[] }),
      userIds.length ? supabaseService.from('hub_users').select('id, full_name, email').in('id', userIds) : Promise.resolve({ data: [] as any[] }),
    ])
    for (const r of [...((leadLinks as any).data || []), ...((partnerLinks as any).data || [])]) {
      count.set(r.tag_lookup_id, (count.get(r.tag_lookup_id) || 0) + 1)
    }
    const nameOf = new Map(((users as any).data || []).map((u: any) => [u.id, u.full_name || u.email || null]))

    const groups = new Map<string, any>()
    for (const t of tags || []) {
      const key = tagKey((t as any).label)
      if (!groups.has(key)) groups.set(key, { key, tags: [] as any[] })
      groups.get(key).tags.push({
        id: (t as any).id,
        label: (t as any).label,
        icon: (t as any).icon || null,
        is_active: (t as any).is_active !== false,
        location_id: (t as any).location_id,
        location_name: (t as any).location?.name || null,
        created_at: (t as any).created_at,
        created_by: nameOf.get((t as any).attrs?.created_by_user) || null,
        people: count.get((t as any).id) || 0,
      })
    }
    const out = Array.from(groups.values()).map((g) => ({
      ...g,
      label: g.tags[0].label,
      locations: new Set(g.tags.map((t: any) => t.location_id)).size,
      people: g.tags.reduce((n: number, t: any) => n + t.people, 0),
    }))
    // Most widespread first — the best candidates for a corporate tag.
    out.sort((a, b) => b.locations - a.locations || b.people - a.people || a.label.localeCompare(b.label))

    return NextResponse.json({ groups: out })
  } catch (err: any) {
    console.error('[/api/tags/locations GET] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
