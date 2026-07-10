// app/api/admin/webhook-log/route.ts
//
// GET /api/admin/webhook-log — enriched webhook sync-log for the admin
// Webhooks dashboard tab.
//
//   - super_admin / admin ONLY (operational/sensitive; unlike feedback
//     there is no owner/manager mount — 403 for everyone else).
//   - ?window=24h|7d|30d|all   (default 7d; bounds the sync_log read)
//   - ?location_id=<slug>      (optional; elevated callers only exist here)
//
// Search + the failure/didn't-land pills filter client-side over the
// returned window — the enriched payload already carries client_name,
// topic, and jobber_item, so name search needs no extra round-trips.
//
// Reads go through supabaseService via fetchWebhookLogEvents; role
// gating happens here (same pattern as the other /api/admin routes).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import {
  fetchWebhookLogEvents,
  type FetchWindow,
} from '@/lib/webhook-observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ELEVATED_ROLES = ['super_admin', 'admin']
const VALID_WINDOWS = new Set<FetchWindow>(['24h', '7d', '30d', 'all'])

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller || !ELEVATED_ROLES.includes(caller.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const windowParam = req.nextUrl.searchParams.get('window') as FetchWindow | null
  const window = windowParam && VALID_WINDOWS.has(windowParam) ? windowParam : '7d'
  const locationId = req.nextUrl.searchParams.get('location_id') || null

  try {
    const { events, truncated } = await fetchWebhookLogEvents({ window, locationId })
    return NextResponse.json({ events, truncated, window })
  } catch (err: any) {
    console.error('[admin webhook-log GET]', err?.message || err)
    return NextResponse.json({ error: 'webhook_log_read_failed' }, { status: 500 })
  }
}
