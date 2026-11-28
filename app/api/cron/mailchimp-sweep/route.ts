// app/api/cron/mailchimp-sweep/route.ts
//
// FL-131: the hourly sweep — the real safety net behind Mailchimp's
// notifications, which can be lost (Mailchimp retries for 75 minutes, then
// may give up). For every location the roll-out list opens (today: Test
// Location only), runs the same ongoing sync the notification runs
// (lib/mailchimp-ongoing.ts). A location whose set-up is not finished does
// nothing. Answers with counts only, never a name or an address.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`; manual runs
// may pass `?secret=<value>`, as send-drips does. No CRON_SECRET → refused.

import { NextRequest, NextResponse } from 'next/server'
import { runOngoing, ONGOING_LOCATIONS } from '@/lib/mailchimp-ongoing'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  const header = req.headers.get('authorization')
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== `Bearer ${secret}` && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const results: Record<string, unknown> = {}
  for (const [id, name] of Object.entries(ONGOING_LOCATIONS)) {
    try {
      const r = await runOngoing(id, { trigger: 'sweep' })
      results[name] = r
      if (!r.ok && r.reason !== 'setup_not_finished') console.error('[mailchimp-sweep] not run', { location: name, reason: r.reason })
      else if (r.ok && (r.created || r.failed || r.sourceUnreadable)) console.log('[mailchimp-sweep]', { location: name, created: r.created, greeted: r.greeted, failed: r.failed, sourceUnreadable: r.sourceUnreadable })
    } catch (e: any) {
      console.error('[mailchimp-sweep] failed', { location: name, error: String(e?.message || e).slice(0, 200) })
      results[name] = { ok: false, reason: 'crashed' }
    }
  }
  return NextResponse.json({ ok: true, results })
}
