// app/api/clients/browse/route.ts
//
// GET /api/clients/browse?olderThan=<iso>[&location=<uuid>][&afterId=<uuid>&afterName=<name>]
//
// The Client List's "Show more" on a location too big for one page load: the
// next page of the clients the page did NOT load, A to Z. Read-only. The
// query, the fence and the page size live in lib/client-search.ts
// (browseClients); this file is who-is-asking and nothing else — the same
// scope rule as /api/clients/search, by the same function.
//
// `olderThan` is required: it is the date the ordinary page load reaches back
// to, which only a cut-off location has. A location that loaded in full never
// calls this.
//
// The cursor is the last row of the previous page. A row with no name sends
// afterId without afterName.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { resolveClientSearchScope, browseClients } from '@/lib/client-search'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function GET(req: Request) {
  const url = new URL(req.url)

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users').select('id, role, location_id').eq('id', user.id).single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  const scope = resolveClientSearchScope(
    { elevated: isAdmin(hubUser.role), location_id: hubUser.location_id },
    url.searchParams.get('location'),
  )
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const olderThan = url.searchParams.get('olderThan') || ''
  if (!olderThan || isNaN(Date.parse(olderThan))) {
    return NextResponse.json({ error: 'older_than_required' }, { status: 400 })
  }
  const afterId = url.searchParams.get('afterId')
  if (afterId && !UUID_RE.test(afterId)) return NextResponse.json({ error: 'invalid_cursor' }, { status: 400 })
  const after = afterId
    ? { id: afterId, name: url.searchParams.has('afterName') ? (url.searchParams.get('afterName') as string) : null }
    : null

  try {
    const result = await browseClients(supabaseService, { locationUuid: scope.locationUuid, olderThan, after })
    return NextResponse.json({ location: scope.locationUuid, ...result })
  } catch (err: any) {
    console.error('[clients/browse] failed:', err?.message || err)
    return NextResponse.json({ error: 'browse_failed' }, { status: 500 })
  }
}
