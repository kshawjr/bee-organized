// app/api/cron/job-channels/route.ts
// ─────────────────────────────────────────────────────────────
// GET /api/cron/job-channels — every 15 minutes (vercel.json). Keeps each
// job's Slack channel in step with the job (lib/engagement-bees
// sweepJobChannels):
//   · channel, job closed, not archived   → conversations.archive, stamp it
//   · channel, job open, archived         → conversations.unarchive, clear it,
//     then reconcile BOTH ways (Slack restores the old members on unarchive):
//     invite bees on the job, remove bees taken off it. Misses are stored on
//     the job (slack_channel_problems) and shown under its Bees cell.
// Sweeping instead of hooking the close: engagements close from at least
// five paths, and this catches every one, including ones added later. Safe
// to run twice — a stamped row no longer matches. A job with no channel is
// never read.
//
// Then the CREW sweep (lib/jobber-crew-mirror sweepJobCrews): re-reads who is
// on each open job's unfinished visits in Jobber and makes the job's bees and
// Slack channel match. The visit notices do this within seconds when they
// fire; this is the backstop for the ones that do not, or whose Jobber read
// failed. Read-only towards Jobber. It runs AFTER the archive sweep and its
// failure never fails that one.
//
// Auth: same convention as the other crons — Vercel sends
// `Authorization: Bearer <CRON_SECRET>`; manual testing also accepts
// `?secret=<value>`. Missing CRON_SECRET is fail-closed (500).
//
// CRON REGISTRATION CAVEAT: Vercel crons pin to the deployment that
// registered them — after vercel.json changes land, check the Cron tab and
// Redeploy if the new schedule didn't take.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { sweepJobChannels } from '@/lib/engagement-bees'
import { sweepJobCrews } from '@/lib/jobber-crew-mirror'
import { jobChannelsLine, jobCrewsLine } from '@/lib/cron-log-lines'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron job-channels] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== `Bearer ${secret}` && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await sweepJobChannels(supabaseService)
    // EVERY run logs one line, even all zeros (Kevin, 20 Oct 2026).
    console.log(jobChannelsLine(result))
    // The crew sweep is its own step with its own line: a Jobber outage must
    // not stop channels being archived, and must be visible when it happens.
    let crews = null
    try {
      crews = await sweepJobCrews(supabaseService)
      console.log(jobCrewsLine(crews))
    } catch (err: any) {
      console.error('[cron job-channels] crew sweep failed —', err?.message || err)
    }
    return NextResponse.json({ ...result, crews }, { status: result.ok ? 200 : 500 })
  } catch (err: any) {
    console.error('[cron job-channels] sweep failed —', err?.message || err)
    return NextResponse.json({ ok: false, error: 'sweep_failed' }, { status: 500 })
  }
}
