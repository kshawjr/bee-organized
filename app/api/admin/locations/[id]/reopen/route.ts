// app/api/admin/locations/[id]/reopen/route.ts
//
// POST /api/admin/locations/:id/reopen — super_admin only.
//
// Body: { mode?: 'dry_run' | 'reopen', confirm_name?: string }
//
// A dry run unless mode === 'reopen'. Restores the status and the people the
// close disabled — and nothing else (lib/location-close reopenLocation says
// what it leaves for a person to do).

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { reopenLocation } from '@/lib/location-close'
import { liveCloseDeps } from '@/lib/location-close-deps'

export const runtime = 'nodejs'

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
    const out = await reopenLocation(
      supabaseService,
      {
        locationId: id,
        actor: { hubUserId: caller.id, role: caller.role },
        confirmName: body?.confirm_name,
        dryRun: body?.mode !== 'reopen',
      },
      liveCloseDeps,
    )
    return NextResponse.json(out.body, { status: out.status })
  } catch (err: any) {
    console.error('[location-reopen] threw', err)
    return NextResponse.json({ error: 'reopen_threw', detail: err?.message || String(err) }, { status: 500 })
  }
}
