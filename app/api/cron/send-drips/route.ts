// app/api/cron/send-drips/route.ts
//
// GET /api/cron/send-drips — Vercel cron entrypoint, fires every hour.
//
// Pulls every lead_drip_progress row whose next_send_at <= now() (and is
// not paused/stopped/completed), then delegates each row to
// lib/drip-send sendDripStepForRow which renders + sends + advances.
//
// The same per-step logic is reused inline by /api/leads on lead create
// so step 1 fires within seconds; this cron is the hourly catch-up for
// paused/resumed leads, future scheduled steps, and any inline failures.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. For
// manual testing in dev, also accepts `?secret=<value>`.
//
// Channel scope: email only for now. SMS/call steps auto-advance without
// sending (placeholder until those channels are wired up).

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { sendDripStepForRow } from '@/lib/drip-send'

// Prevent Next.js from trying to prerender this route at build time.
export const dynamic = 'force-dynamic'

// Hard cap per cron run — safety against a flood, prevents Vercel
// function timeout. Hourly cron + 100 cap = up to 2400 sends/day,
// plenty for our launch volume.
const BATCH_LIMIT = 100

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

  // ─── Pull due rows ─────────────────────────────────────────────
  const nowIso = new Date().toISOString()
  const { data: dueRows, error: dueErr } = await supabaseService
    .from('lead_drip_progress')
    .select(
      `
      id, lead_id, drip_path_id, current_step, next_send_at,
      drip_paths!inner ( id, path_key, location_uuid )
      `,
    )
    .lte('next_send_at', nowIso)
    .is('paused_at', null)
    .is('stopped_at', null)
    .is('completed_at', null)
    .limit(BATCH_LIMIT)

  if (dueErr) {
    console.error('[cron] due-rows query failed', dueErr)
    return NextResponse.json({ error: 'due_query_failed', detail: dueErr.message }, { status: 500 })
  }

  let sent = 0
  let skipped = 0
  let failed = 0
  const errors: Array<{ progressId: string; reason: string }> = []

  for (const row of dueRows ?? []) {
    const result = await sendDripStepForRow(row as any)
    if (result.sent) {
      sent++
    } else if (result.error === 'no_email' || result.error === 'non_email_channel') {
      // Expected skips: drip auto-stopped (no_email) or auto-advanced past
      // a non-email step. Both bookkeeping mutations already happened.
      skipped++
    } else if (result.error) {
      failed++
      errors.push({ progressId: row.id, reason: result.error })
    } else {
      // No-op (state changed between the batch query and the per-row call).
      skipped++
    }
  }

  return NextResponse.json({
    sent,
    skipped,
    failed,
    considered: dueRows?.length ?? 0,
    errors: errors.slice(0, 20),
  })
}
