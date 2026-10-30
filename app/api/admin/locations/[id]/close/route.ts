// app/api/admin/locations/[id]/close/route.ts
//
// POST /api/admin/locations/:id/close — super_admin only.
//
// Body: { mode?: 'dry_run' | 'close', confirm_name?: string }
//
// A DRY RUN UNLESS ASKED OTHERWISE. Anything but mode === 'close' — no body,
// a typo, 'Close' — reads and counts and writes nothing. A real close also
// needs confirm_name to be the location's name. The whole close lives in
// lib/location-close (what it touches, in what order, and why); this route
// only proves who is asking.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { closeLocation } from '@/lib/location-close'
import { liveCloseDeps } from '@/lib/location-close-deps'

export const runtime = 'nodejs'
// A big location moves tens of thousands of rows across fourteen tables.
export const maxDuration = 300

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const id = params.id
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid_location_id' }, { status: 400 })

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: caller } = await supabase.from('hub_users').select('id, role').eq('id', user.id).single()
  if (!caller) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: any = {}
  try { body = await req.json() } catch { body = {} }

  try {
    const out = await closeLocation(
      supabaseService,
      {
        locationId: id,
        actor: { hubUserId: caller.id, role: caller.role },
        confirmName: body?.confirm_name,
        dryRun: body?.mode !== 'close',
      },
      liveCloseDeps,
    )
    return NextResponse.json(out.body, { status: out.status })
  } catch (err: any) {
    console.error('[location-close] threw', err)
    return NextResponse.json({ error: 'close_threw', detail: err?.message || String(err) }, { status: 500 })
  }
}
