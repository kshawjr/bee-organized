// app/api/cron/gmail-sync/route.ts
//
// GET /api/cron/gmail-sync — Vercel cron entrypoint, fires every 5 minutes.
// Thin caller around runScheduledGmailSync (lib/gmail-cron.ts); the engine
// and its gates live in lib/gmail-sync.ts and are not duplicated here.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. For
// manual testing in dev, also accepts `?secret=<value>`. Fail-closed 500
// when CRON_SECRET is unset — same pattern as send-drips.
//
// Response: counts and account ids only. Never email addresses,
// subjects, or bodies.

import { NextRequest, NextResponse } from 'next/server'
import { runScheduledGmailSync } from '@/lib/gmail-cron'

// Prevent Next.js from trying to prerender this route at build time.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const expected = `Bearer ${secret}`
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== expected && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const report = await runScheduledGmailSync()
    return NextResponse.json(report)
  } catch (err: any) {
    console.error('[cron gmail-sync]', err?.message || err)
    return NextResponse.json({ error: err?.message || 'gmail cron failed' }, { status: 500 })
  }
}
