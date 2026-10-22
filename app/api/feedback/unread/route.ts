// app/api/feedback/unread/route.ts
//
// GET /api/feedback/unread → { count, supported }. The Help nav badge
// (ClickUp 868mm1h81): how many replies to the CALLER'S OWN reports they have
// not opened. The rule lives in lib/feedback-unread; this route only decides
// which rows it may look at.
//
// THE ROWS ARE EXACTLY THE ONES MY REQUESTS CAN SHOW AND CLEAR. A badge that
// counts an item the screen never renders can never be cleared. So:
//   · always user_id = the session user — no override, not even for elevated
//     callers (view-as shows someone else's list, which this badge is not about)
//   · owner/manager with a location: ALSO location_id = their location, because
//     their My requests is the location-scoped list (GET /api/admin/feedback),
//     and an own item filed from elsewhere is not on it
//   · is_internal = false, on the query
//
// FAILS SOFT. reply_seen_at absent (migration not run) → { count: 0,
// supported: false }: no badge, rather than every old reply declared unread.
//
// fetchCache: this read has a constant predicate per user, and supabase-js
// reads go through Next 14.2.3's patched fetch. A frozen read here would pin
// the badge at whatever it first said — the send-drips fault (2c1f000).

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { withInternalFallback } from '@/lib/feedback-internal'
import { countUnreadReplies } from '@/lib/feedback-unread'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const LOCATION_SCOPED_ROLES = ['owner', 'manager']
const UNDEFINED_COLUMN = '42703'

export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: caller } = await supabase
    .from('hub_users')
    .select('role, location_id')
    .eq('id', user.id)
    .single()
  const scopedLocation =
    caller && LOCATION_SCOPED_ROLES.includes(caller.role) && caller.location_id ? caller.location_id : null

  const { data, error } = await withInternalFallback<any[]>(async (filterInternal) => {
    let query = supabaseService
      .from('feedback_items')
      .select(filterInternal
        ? 'id, user_id, is_internal, admin_response, admin_response_at, reply_seen_at'
        : 'id, user_id, admin_response, admin_response_at, reply_seen_at')
      .eq('user_id', user.id)
      .not('admin_response', 'is', null)
    if (scopedLocation) query = query.eq('location_id', scopedLocation)
    if (filterInternal) query = query.eq('is_internal', false)
    return await query
  })

  if (error) {
    if ((error as { code?: string }).code === UNDEFINED_COLUMN) {
      return NextResponse.json({ count: 0, supported: false })
    }
    console.error('[feedback unread]', error)
    return NextResponse.json({ error: (error as { message?: string }).message }, { status: 500 })
  }

  return NextResponse.json({ count: countUnreadReplies(data || [], user.id), supported: true })
}
