// app/api/gmail/sync/route.ts
//
// POST /api/gmail/sync  { accountId, days? }
// super_admin only — manual trigger for the Gmail ingest engine. No cron
// calls this; Kevin runs it by hand and inspects the rows.
//
// Response is COUNTS ONLY: no subjects, addresses, bodies, or ids. The
// engine's report includes the mailbox address — it is stripped here.
// The sync_enabled gate lives in the engine (lib/gmail-sync.ts), not here.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { syncMailbox, SYNC_DAYS_DEFAULT, SYNC_DAYS_MAX } from '@/lib/gmail-sync'

export const runtime = 'nodejs'
export const maxDuration = 60

// Headroom under maxDuration for auth, body parsing, and the final writes.
const TIME_BUDGET_MS = 45_000

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

  if (hubUser?.role !== 'super_admin') {
    return NextResponse.json({ error: 'forbidden — super_admin only' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
  if (!accountId) {
    return NextResponse.json({ error: 'accountId is required' }, { status: 400 })
  }
  let days = SYNC_DAYS_DEFAULT
  if (body?.days !== undefined) {
    const n = Number.parseInt(String(body.days), 10)
    if (Number.isNaN(n) || n < 1 || n > SYNC_DAYS_MAX) {
      return NextResponse.json({ error: `days must be 1-${SYNC_DAYS_MAX}` }, { status: 400 })
    }
    days = n
  }

  try {
    const report = await syncMailbox(accountId, { days, timeBudgetMs: TIME_BUDGET_MS })
    // Counts only — drop the mailbox address from the wire.
    const { mailbox: _mailbox, ...counts } = report
    return NextResponse.json(counts)
  } catch (err: any) {
    // Diagnostics only — engine errors name tables and HTTP statuses,
    // never subjects, participant addresses, or lead ids.
    console.error('[gmail/sync]', err?.message || err)
    return NextResponse.json({ error: err?.message || 'sync failed' }, { status: 502 })
  }
}
