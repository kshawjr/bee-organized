import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

// GET — fetch all slides, ordered by slot
export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase
    .from('guide_slides')
    .select('*')
    .order('slot', { ascending: true })

  if (error) {
    console.error('[guide_slides GET]', error)
    return NextResponse.json({ slides: [], error: error.message }, { status: 500 })
  }

  // Map DB rows → shape BeeHub expects
  const slides = (data || []).map((row) => ({
    icon: row.icon,
    chapter: row.chapter,
    color: row.color,
    title: row.title,
    body: row.body || '',
    bullets: row.bullets || [],
    screenshot: row.screenshot_url || null,
  }))

  return NextResponse.json({ slides })
}

// POST — replace all slides. Super_admin only.
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()

  // Auth gate
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Role gate (RLS also enforces, but explicit check gives a cleaner error)
  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!hubUser || hubUser.role !== 'super_admin') {
    return NextResponse.json({ error: 'forbidden — super_admin only' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const slides = body.slides

  if (!Array.isArray(slides)) {
    return NextResponse.json({ error: 'invalid payload — slides must be an array' }, { status: 400 })
  }

  // Replace all slides: delete then insert. (Supabase REST doesn't expose
  // transactions; brief inconsistency window is acceptable for an admin
  // editor used by one user at a time.)
  const { error: delErr } = await supabase
    .from('guide_slides')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000') // delete-all idiom

  if (delErr) {
    console.error('[guide_slides DELETE]', delErr)
    return NextResponse.json({ error: 'delete failed: ' + delErr.message }, { status: 500 })
  }

  if (slides.length > 0) {
    const rows = slides.map((s: any, i: number) => ({
      slot: i,
      icon: s.icon || null,
      chapter: s.chapter || null,
      color: s.color || '#1a2e2b',
      title: s.title || '',
      body: s.body || null,
      bullets: Array.isArray(s.bullets) ? s.bullets : [],
      screenshot_url: s.screenshot || null,
      updated_by: user.id,
    }))

    const { error: insErr } = await supabase.from('guide_slides').insert(rows)
    if (insErr) {
      console.error('[guide_slides INSERT]', insErr)
      return NextResponse.json({ error: 'insert failed: ' + insErr.message }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true, count: slides.length })
}
