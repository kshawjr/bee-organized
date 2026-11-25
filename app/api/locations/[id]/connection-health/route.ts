// app/api/locations/[id]/connection-health/route.ts
//
// GET only. What the Slack and Jobber connection screens show beyond
// connected / not connected: did the last Slack lead alert arrive, when did
// Jobber last send an update, how did the last client import end.
// lib/connection-health.ts holds the reads and the rules; this is the door.
//
// READS ONLY — three small look-ups in tables Bee Hub already writes
// (notification_log, sync_log, import_jobs). It calls neither Slack nor
// Jobber, changes nothing, and no token is read.
//
// WHO: the same people who can open the location's Settings — super_admin,
// admin, and anyone signed in to this location. Anyone else gets exactly what
// a location that does not exist gets ("not found, never forbidden").

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { readJobberHealth, readSlackLastPost } from '@/lib/connection-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// The reads have the same web address every time for a given location, so
// without this Next can hand back a saved copy of an old answer.
export const fetchCache = 'force-no-store'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isElevated = (role: unknown) => role === 'super_admin' || role === 'admin'
const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 })

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    if (!UUID_RE.test(params.id)) return notFound()
    if (!isElevated(hubUser.role) && hubUser.location_id !== params.id) return notFound()

    const { data: loc } = await supabaseService.from('locations').select('id, location_id').eq('id', params.id).maybeSingle()
    if (!loc) return notFound()

    const [lastPost, jobber] = await Promise.all([
      readSlackLastPost(supabaseService, loc.id),
      readJobberHealth(supabaseService, loc.location_id),
    ])
    return NextResponse.json({ slack: { lastPost }, jobber })
  } catch (err: any) {
    console.error('[/api/locations/[id]/connection-health GET] error:', err?.message || err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
