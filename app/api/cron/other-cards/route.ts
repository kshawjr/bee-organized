// app/api/cron/other-cards/route.ts
// ─────────────────────────────────────────────────────────────
// GET /api/cron/other-cards — every 5 minutes (vercel.json). The backstop
// that keeps Other's Slack cards in step with Bee Hub (lib/other-card-sync
// sweepOtherCards):
//   · a card still showing buttons whose lead is no longer open in Other —
//     closed as not interested, in Jobber, archived, or an exit whose instant
//     edit failed — is edited to say so, buttons gone
//   · a lead that came BACK into Other (dismiss undone, restored from the bin,
//     snooze over) gets a fresh card, posted through the same
//     notifyNewLeadSlack intake uses, so it is recorded like any other card
// The instant edits happen at the exits themselves; this only catches what
// they missed, so it never names a person it can't see.
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
import { sweepOtherCards } from '@/lib/other-card-sync'
import { notifyNewLeadSlack } from '@/lib/slack-bot'
import { logSlackNotification } from '@/lib/notification-log'
import { OTHER_SLUG } from '@/lib/other-card-backlog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const maxDuration = 60

// A fresh card for a lead that came back into Other.
async function repost(leadId: string): Promise<boolean> {
  const [{ data: other }, { data: l }] = await Promise.all([
    supabaseService.from('locations').select('id, name, location_id').eq('location_id', OTHER_SLUG).maybeSingle(),
    supabaseService
      .from('leads')
      .select('id, name, email, phone, project_type, request_details, preferred_contact, source, address, city, state, zip')
      .eq('id', leadId)
      .maybeSingle(),
  ])
  if (!other || !l) return false
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://beehive.beeorganized.com').replace(/\/$/, '')
  const res = await notifyNewLeadSlack({ locationId: other.id, locationName: other.name, baseUrl, lead: l as any })
  await logSlackNotification(res, { lead_id: l.id, lead_name: l.name, location_id: other.id, location_slug: other.location_id })
  return res.ok
}

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron other-cards] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== `Bearer ${secret}` && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await sweepOtherCards({ repost: (lead) => repost(lead.id) })
    if (result.retired || result.reposted || result.failed) console.log('[cron other-cards]', JSON.stringify(result))
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    console.error('[cron other-cards] sweep failed —', err?.message || err)
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
