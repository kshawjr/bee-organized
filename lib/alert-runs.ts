// lib/alert-runs.ts
// ─────────────────────────────────────────────────────────────
// The failure-alert cron's durable watermark (migrations/alert_runs.sql).
// The cron (app/api/cron/failure-alerts, issue 159) alerts on an allowlist
// of hard failures instantly, and dedupes on a stored high-water mark so
// each failure is posted EXACTLY ONCE: every run reads the last watermark,
// considers only rows created after it, then writes a new row advancing it.
//
// Same fail-soft posture as lib/digest-runs: the app ships BEFORE the table
// exists. fetchLastAlertWatermark returns tracked:false on "relation does
// not exist" (the caller then seeds the window at ~now and posts nothing),
// and recordAlertRun NEVER throws — a dedup cursor that could take down the
// cron it serves would be worse than none.

import { supabaseService } from './supabase-service'

const isMissingTable = (message: string | undefined) =>
  /does not exist/i.test(message || '')

// tracked:false = the table isn't there yet (pre-migration) OR the read
// errored — either way the caller treats it as "no prior watermark" and
// seeds from ~now, which is fail-safe (never replays history as alerts).
export async function fetchLastAlertWatermark(): Promise<{
  tracked: boolean
  watermark: string | null
}> {
  try {
    const { data, error } = await supabaseService
      .from('alert_runs')
      .select('watermark')
      .order('ran_at', { ascending: false })
      .limit(1)
    if (error) {
      if (isMissingTable(error.message)) return { tracked: false, watermark: null }
      console.error('[alert-runs] read failed (non-fatal)', error.message)
      return { tracked: false, watermark: null }
    }
    const row = (data && data[0]) || null
    return { tracked: true, watermark: (row?.watermark as string) ?? null }
  } catch (err: any) {
    console.error('[alert-runs] unexpected read error (non-fatal)', err?.message || err)
    return { tracked: false, watermark: null }
  }
}

export async function recordAlertRun(run: {
  watermark: string        // ISO — the new high-water mark
  alerted: number          // alert lines posted this run
  posted: boolean          // Slack accepted the message
  skipped?: string | null  // e.g. 'no_webhook_url'
}): Promise<void> {
  try {
    const { error } = await supabaseService.from('alert_runs').insert({
      watermark: run.watermark,
      alerted: run.alerted,
      posted: run.posted,
      skipped: run.skipped ?? null,
    })
    if (error && !isMissingTable(error.message)) {
      console.error('[alert-runs] insert failed (non-fatal)', error.message)
    }
  } catch (err: any) {
    console.error('[alert-runs] unexpected insert error (non-fatal)', err?.message || err)
  }
}
