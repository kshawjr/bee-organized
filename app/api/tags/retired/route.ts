// app/api/tags/retired/route.ts
//
// GET — corporate only. Every switched-off corporate tag, each with why it
// can't be deleted (or nothing, when it can): Configure › Tags › Retired.
// The retired tags from the merge always say why they're kept.

import { NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { TAG_CATEGORIES, describeTagBlockers } from '@/lib/tags'

export async function GET() {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser || !isAdmin(hubUser.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    const { data: tags, error } = await supabaseService
      .from('lookups').select('id, label, icon, attrs, updated_at')
      .in('category', TAG_CATEGORIES).is('location_id', null).eq('is_active', false)
      .order('label', { ascending: true })
    if (error) return NextResponse.json({ error: 'read_failed', detail: error.message }, { status: 500 })
    const out = await Promise.all((tags || []).map(async (t: any) => {
      const { data: b } = await supabaseService.rpc('tag_delete_blockers', { p_id: t.id })
      const blockers: string[] = Array.isArray(b) ? b : ['unknown']
      return { id: t.id, label: t.label, icon: t.icon || null, blockers, reason: describeTagBlockers(blockers) }
    }))
    return NextResponse.json({ tags: out })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
