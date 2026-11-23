// app/api/cron/send-partner-emails/route.ts
//
// GET /api/cron/send-partner-emails — Vercel cron, every hour at :30
// (vercel.json). Partner emails, slice 4 (2026-11-22).
//
// Sends every PARTNER sequence email that is due (partner_drip_progress,
// lib/network/partner-drip-send.ts), up to PARTNER_BATCH_LIMIT a run. Its own
// route, not a fourth queue in /api/cron/send-drips, so nothing here can slow,
// break or change a client email: that route is untouched.
//
// Nothing is due until an owner starts a partner on a sequence (slice 5).
//
// Auth: exactly as send-drips — `Authorization: Bearer <CRON_SECRET>`, or
// `?secret=` for a manual run. No CRON_SECRET → 500, fail closed.

import { NextRequest, NextResponse } from 'next/server'
import { runPartnerDripBatch } from '@/lib/network/partner-drip-send'
import { sendPartnerEmailsLine } from '@/lib/cron-log-lines'

export const dynamic = 'force-dynamic'
// Same reason as send-drips (#95/#96): supabase-js reads must never be
// answered from Next's Data Cache, or a stale "not unsubscribed" could be read.
export const fetchCache = 'force-no-store'

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron send-partner-emails] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== `Bearer ${secret}` && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const r = await runPartnerDripBatch()
  if (r.queryError) {
    console.error('[cron send-partner-emails] due-rows query failed', r.queryError)
    console.log(sendPartnerEmailsLine(r))
    return NextResponse.json({ error: 'due_query_failed', detail: r.queryError }, { status: 500 })
  }
  // One line on EVERY run, even all zeros (lib/cron-log-lines).
  console.log(sendPartnerEmailsLine(r))
  return NextResponse.json({
    partners: { sent: r.sent, skipped: r.skipped, held: r.held, failed: r.failed, considered: r.considered },
    errors: r.errors.slice(0, 20),
  })
}
