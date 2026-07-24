// app/api/cron/send-drips/route.ts
//
// GET /api/cron/send-drips — Vercel cron entrypoint, fires every hour.
//
// Three queues processed per run:
//
//   1. lead_drip_progress     — normal multi-step drip path emails
//      (sendDripStepForRow advances current_step and schedules next)
//
//   2. leads.welcome_email_*  — single Welcome Email fired 24h after Email 1
//      of any new lead drip (sendWelcomeEmail sets welcome_email_sent_at)
//
//   3. scheduled_stage_emails — Opportunity Stages drip emails fired on
//      lead stage transitions (sendStageEmail sets sent_at)
//
// The same per-drip-step logic is reused inline by /api/leads on lead
// create so step 1 fires within seconds; this cron is the hourly catch-up
// for paused/resumed leads, future scheduled steps, and any inline failures.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. For
// manual testing in dev, also accepts `?secret=<value>`.
//
// Channel scope: email only for now. SMS/call steps auto-advance without
// sending (placeholder until those channels are wired up).

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { sendDripStepForRow } from '@/lib/drip-send'
import { sendWelcomeEmail } from '@/lib/welcome-email'
import { sendStageEmail } from '@/lib/stage-emails'

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
  // Sends HELD because the template quotes {{rate_per_hour}} and the
  // location's rate is blank. Counted apart from `skipped` so the gap is
  // countable in cron logs; the digest carries the per-location rollup.
  let heldMissingRate = 0
  const errors: Array<{ kind: string; id: string; reason: string }> = []

  for (const row of dueRows ?? []) {
    const result = await sendDripStepForRow(row as any)
    if (result.sent) {
      sent++
    } else if (result.error === 'missing_rate') {
      heldMissingRate++
    } else if (
      result.error === 'no_email' ||
      result.error === 'non_email_channel' ||
      result.error === 'opted_out' ||
      result.error === 'location_not_active'
    ) {
      // Expected skips: drip auto-stopped (no_email / opted_out),
      // auto-advanced past a non-email step, or HELD because the location
      // isn't active on the interface (location_not_active — row untouched,
      // retried automatically once the location reactivates). Bookkeeping
      // already happened / is intentionally deferred.
      skipped++
    } else if (result.error) {
      failed++
      errors.push({ kind: 'drip', id: row.id, reason: result.error })
    } else {
      // No-op (state changed between the batch query and the per-row call).
      skipped++
    }
  }

  // ─── Queue 2: Welcome emails ─────────────────────────────────────
  let welcomeSent = 0
  let welcomeSkipped = 0
  let welcomeFailed = 0

  // paused=true rows are HELD, not cancelled — excluded here so they
  // don't burn batch slots, and released automatically on the first
  // tick after resume. sendWelcomeEmail re-checks paused/junk/opt-out
  // at send time (authoritative gate).
  const { data: welcomeDue, error: welcomeErr } = await supabaseService
    .from('leads')
    .select('id')
    .lte('welcome_email_scheduled_at', nowIso)
    .is('welcome_email_sent_at', null)
    .eq('paused', false)
    .limit(BATCH_LIMIT)

  if (welcomeErr) {
    console.error('[cron] welcome-due query failed', welcomeErr)
  } else {
    for (const lead of welcomeDue ?? []) {
      const result = await sendWelcomeEmail(lead.id)
      if (result.sent) {
        welcomeSent++
      } else if (result.error === 'missing_rate') {
        heldMissingRate++
      } else if (
        result.error === 'no_email' ||
        result.error === 'already_sent' ||
        result.error === 'junk' ||        // cancelled at send time
        result.error === 'opted_out' ||   // cancelled at send time
        result.error === 'paused'         // HELD — retried after resume
      ) {
        welcomeSkipped++
      } else if (result.error) {
        welcomeFailed++
        errors.push({ kind: 'welcome', id: lead.id, reason: result.error })
      } else {
        welcomeSkipped++
      }
    }
  }

  // ─── Queue 3: Stage emails (opportunity stage scheduled queue) ────
  let stageSent = 0
  let stageSkipped = 0
  let stageFailed = 0

  const { data: stageDue, error: stageErr } = await supabaseService
    .from('scheduled_stage_emails')
    .select('id')
    .lte('send_at', nowIso)
    .is('sent_at', null)
    .is('cancelled_at', null)
    .limit(BATCH_LIMIT)

  if (stageErr) {
    console.error('[cron] stage-due query failed', stageErr)
  } else {
    for (const row of stageDue ?? []) {
      const result = await sendStageEmail(row.id)
      if (result.sent) {
        stageSent++
      } else if (result.error === 'missing_rate') {
        heldMissingRate++
      } else if (
        result.error === 'no_email' ||
        result.error === 'already_sent' ||
        result.error === 'cancelled' ||
        result.error === 'opted_out'
      ) {
        stageSkipped++
      } else if (result.error) {
        stageFailed++
        errors.push({ kind: 'stage', id: row.id, reason: result.error })
      } else {
        stageSkipped++
      }
    }
  }

  if (heldMissingRate > 0) {
    console.warn(`[cron] ${heldMissingRate} send(s) held: template quotes {{rate_per_hour}} but the location rate is blank`)
  }

  return NextResponse.json({
    held_missing_rate: heldMissingRate,
    drips:   { sent, skipped, failed, considered: dueRows?.length ?? 0 },
    welcome: { sent: welcomeSent, skipped: welcomeSkipped, failed: welcomeFailed, considered: welcomeDue?.length ?? 0 },
    stage:   { sent: stageSent,   skipped: stageSkipped,   failed: stageFailed,   considered: stageDue?.length ?? 0 },
    errors:  errors.slice(0, 20),
  })
}
