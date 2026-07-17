// app/api/admin/notification-log/route.ts
//
// GET /api/admin/notification-log — the outbound-mail notebook
// (migrations/notification_log.sql) for the admin Notifications tab. One row
// per recipient per send: who/what/when + whether Resend accepted it.
//
//   - super_admin / admin ONLY. Same gate, copied verbatim from
//     app/api/admin/webhook-log/route.ts — this table carries recipient email
//     addresses and subject lines, so it is at least as sensitive as the
//     webhook log. THIS ROUTE IS THE GATE: reads go through supabaseService
//     (service role), which bypasses RLS, and the table has no policies.
//   - ?window=24h|7d|30d|all   (default 7d; bounds the read)
//   - ?location_id=<uuid>      (note: the UUID, not the slug — the column is a
//                               real FK. location_slug is a display copy.)
//   - ?status=accepted|failed|zero_recipients
//   - ?channel=email|slack
//   - ?email_kind=<label>      (free text — the column carries no CHECK)
//   - ?q=<search>              (recipient / subject / lead name, case-insensitive)
//
// Filters are applied SERVER-SIDE, unlike the webhook log's client-side
// filtering: that screen's payload is a bounded enriched window, whereas this
// table grows with every email the product sends and its useful queries
// ("every failure for this location") must not depend on the row happening to
// fall inside a client-side page.
//
// PRE-MIGRATION. Until notification_log.sql is run, this returns an empty list
// with needs_migration: true rather than a 500 — the tab renders an explanatory
// empty state instead of an error, matching the fail-soft posture of the writer.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ELEVATED_ROLES = ['super_admin', 'admin']

type FetchWindow = '24h' | '7d' | '30d' | 'all'
const VALID_WINDOWS = new Set<FetchWindow>(['24h', '7d', '30d', 'all'])
const WINDOW_MS: Record<Exclude<FetchWindow, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

const VALID_STATUSES = new Set(['accepted', 'failed', 'zero_recipients'])
const VALID_CHANNELS = new Set(['email', 'slack'])

// Hard cap on rows returned. The screen is a triage surface, not an export:
// truncated:true tells it to say so out loud rather than silently imply the
// window held nothing more (the no-silent-caps rule).
const ROW_CAP = 500

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

  const sp = req.nextUrl.searchParams
  const windowParam = sp.get('window') as FetchWindow | null
  const window: FetchWindow = windowParam && VALID_WINDOWS.has(windowParam) ? windowParam : '7d'
  const locationId = sp.get('location_id') || null
  const status = sp.get('status')
  const channel = sp.get('channel')
  const emailKind = sp.get('email_kind')
  const q = sp.get('q')?.trim() || null

  try {
    let query = supabaseService
      .from('notification_log')
      .select(
        'id, created_at, lead_id, lead_name, location_id, location_slug, channel, ' +
        'recipient, subject, email_kind, send_status, resend_message_id, ' +
        'delivery_status, delivery_updated_at, error',
      )
      .order('created_at', { ascending: false })
      .limit(ROW_CAP + 1) // +1 sentinel: reveals "there are more" without a count query

    if (window !== 'all') {
      query = query.gte('created_at', new Date(Date.now() - WINDOW_MS[window]).toISOString())
    }
    if (locationId) query = query.eq('location_id', locationId)
    // Unknown values are IGNORED rather than 400'd — a stale bookmark should
    // show the unfiltered window, not an error page.
    if (status && VALID_STATUSES.has(status)) query = query.eq('send_status', status)
    if (channel && VALID_CHANNELS.has(channel)) query = query.eq('channel', channel)
    if (emailKind) query = query.eq('email_kind', emailKind)
    if (q) {
      // Escape PostgREST's or() delimiters — an unescaped comma or paren in the
      // search box would otherwise be parsed as filter syntax.
      const safe = q.replace(/[,()]/g, ' ')
      query = query.or(
        `recipient.ilike.%${safe}%,subject.ilike.%${safe}%,lead_name.ilike.%${safe}%`,
      )
    }

    const { data, error } = await query
    if (error) {
      // Pre-migration: the table isn't there yet. Not an error state for the
      // operator — the tab explains itself and stays quiet.
      if (/does not exist/i.test(error.message)) {
        return NextResponse.json({ events: [], truncated: false, window, needs_migration: true })
      }
      throw new Error(error.message)
    }

    const rows = data || []
    const truncated = rows.length > ROW_CAP
    return NextResponse.json({
      events: truncated ? rows.slice(0, ROW_CAP) : rows,
      truncated,
      window,
      needs_migration: false,
    })
  } catch (err: any) {
    console.error('[admin notification-log GET]', err?.message || err)
    return NextResponse.json({ error: 'notification_log_read_failed' }, { status: 500 })
  }
}
