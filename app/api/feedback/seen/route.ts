// app/api/feedback/seen/route.ts
//
// POST /api/feedback/seen — "I have now seen the replies on these items."
// Body: { ids: string[] }. Stamps feedback_items.reply_seen_at = now().
//
// Issue 235. The owner screen shows a "N new replies" banner; this is what
// turns it off. It is the ONLY writer of that column.
//
// SCOPED TO THE CALLER'S OWN ROWS, always. reply_seen_at means "the SUBMITTER
// has seen it" — so the update filters on user_id = the session user, with no
// elevated override of any kind. An owner reads their colleagues' items on the
// same screen (a location may have more than one submitter, even though none
// does today), and clearing someone else's unread marker would take away the
// one signal telling THEM we wrote back.
//
// FAILS SOFT WHEN THE COLUMN IS ABSENT. migrations/feedback_reply_seen.sql is a
// review artifact Kevin runs; until then this returns { supported: false }
// rather than a 500, and the screen simply never shows the banner. Nothing the
// user can see depends on this succeeding — the reply text itself renders from
// admin_response, which has always existed.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

// Postgres "column does not exist". The one error we translate into a calm
// "not supported yet" instead of a failure.
const UNDEFINED_COLUMN = '42703'

const MAX_IDS = 200

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { ids?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const rawIds = Array.isArray(body.ids) ? body.ids : null
  if (!rawIds) return NextResponse.json({ error: 'ids_must_be_array' }, { status: 400 })

  const ids = rawIds
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, MAX_IDS)
  if (ids.length === 0) return NextResponse.json({ marked: 0, supported: true })

  const { data, error } = await supabaseService
    .from('feedback_items')
    .update({ reply_seen_at: new Date().toISOString() })
    .in('id', ids)
    // The scope guard. Not a convenience filter — see the header note.
    .eq('user_id', user.id)
    .select('id')

  if (error) {
    if ((error as { code?: string }).code === UNDEFINED_COLUMN) {
      console.warn('[feedback seen] reply_seen_at column missing — migration pending')
      return NextResponse.json({ marked: 0, supported: false })
    }
    console.error('[feedback seen]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ marked: (data || []).length, supported: true })
}
