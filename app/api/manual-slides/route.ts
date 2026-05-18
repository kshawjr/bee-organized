import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

// GET — fetch all slides, ordered by chapter then slot
export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase
    .from('manual_slides')
    .select('*')
    .order('chapter', { ascending: true })
    .order('slot', { ascending: true })

  if (error) {
    console.error('[manual_slides GET]', error)
    return NextResponse.json({ slides: [], error: error.message }, { status: 500 })
  }

  const slides = (data || []).map((row) => {
    let screenshots: string[] = []
    if (Array.isArray(row.screenshots) && row.screenshots.length > 0) {
      screenshots = row.screenshots
    } else if (row.screenshot_url) {
      screenshots = [row.screenshot_url]
    }

    return {
      icon: row.icon,
      chapter: row.chapter,
      color: row.color,
      title: row.title,
      body: row.body || '',
      bullets: row.bullets || [],
      screenshot: screenshots[0] || null,
      screenshots,
      video_url: row.video_url || null,
    }
  })

  return NextResponse.json({ slides })
}

// POST — replace all slides. Super_admin or admin only.
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('role')
    .eq('id', user.id)
    .single()

  // Allow both super_admin AND admin to edit the manual
  const allowedRoles = ['super_admin', 'admin']
  if (!hubUser || !allowedRoles.includes(hubUser.role)) {
    return NextResponse.json(
      { error: 'forbidden — super_admin or admin only' },
      { status: 403 }
    )
  }

  const body = await request.json().catch(() => ({}))
  const slides = body.slides

  if (!Array.isArray(slides)) {
    return NextResponse.json({ error: 'invalid payload — slides must be an array' }, { status: 400 })
  }

  const { error: delErr } = await supabase
    .from('manual_slides')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000')

  if (delErr) {
    console.error('[manual_slides DELETE]', delErr)
    return NextResponse.json({ error: 'delete failed: ' + delErr.message }, { status: 500 })
  }

  if (slides.length > 0) {
    const rows = slides.map((s: any, i: number) => {
      let screenshots: string[] = []
      if (Array.isArray(s.screenshots)) {
        screenshots = s.screenshots
      } else if (s.screenshot) {
        screenshots = [s.screenshot]
      }

      return {
        slot: i,
        icon: s.icon || null,
        chapter: s.chapter || null,
        color: s.color || '#1a2e2b',
        title: s.title || '',
        body: s.body || null,
        bullets: Array.isArray(s.bullets) ? s.bullets : [],
        screenshot_url: screenshots[0] || null,
        screenshots,
        video_url: typeof s.video_url === 'string' && s.video_url.trim() ? s.video_url.trim() : null,
        updated_by: user.id,
      }
    })

    const { error: insErr } = await supabase.from('manual_slides').insert(rows)
    if (insErr) {
      console.error('[manual_slides INSERT]', insErr)
      return NextResponse.json({ error: 'insert failed: ' + insErr.message }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true, count: slides.length })
}
