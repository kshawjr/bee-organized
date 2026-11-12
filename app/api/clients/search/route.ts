// app/api/clients/search/route.ts
//
// GET /api/clients/search?q=<term>&location=<uuid>[&olderThan=<iso>]
//
// The Client List's search, answered by the database instead of by the 5,000
// clients the page happened to load. Read-only. All of the matching, the
// fence and the cap live in lib/client-search.ts — this file is who-is-asking
// and nothing else.
//
// WHY ITS OWN ROUTE, next to /api/clients/[id]/profile:
//   · /api/leads is the create door (POST, write-blocked for lite_user). A
//     read on the same path would put a read-only role's allow and deny rules
//     in one file.
//   · /api/search is ⌘K: every location for an elevated user, archived
//     clients INCLUDED, 20 slim rows. The Client List is one location,
//     archived EXCLUDED, full records. Two different rules — sharing a route
//     is how one would leak into the other.
//
// WHO: any signed-in hub user. owner / manager / lite_user search their own
// location only (a `location` naming another is a 403, not a silent
// correction). super_admin / admin search the location they name.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { resolveClientSearchScope, searchClients, cleanClientSearchTerm } from '@/lib/client-search'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

  const term = cleanClientSearchTerm(url.searchParams.get('q'))
  if (!term) return NextResponse.json({ term, people: [], total: 0, capped: false })

  try {
    const result = await searchClients(supabaseService, {
      locationUuid: scope.locationUuid,
      term,
      olderThan: url.searchParams.get('olderThan'),
    })
    return NextResponse.json({ term, location: scope.locationUuid, ...result })
  } catch (err: any) {
    console.error('[clients/search] failed:', err?.message || err)
    return NextResponse.json({ error: 'search_failed' }, { status: 500 })
  }
}
