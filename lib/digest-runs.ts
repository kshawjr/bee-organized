// lib/digest-runs.ts
// ─────────────────────────────────────────────────────────────
// The webhook digest's durable heartbeat (migrations/digest_runs.sql).
// One row per cron run — INCLUDING suppressed runs and no_webhook_url
// skips, because the row's job is liveness first, content second: a
// digest that hasn't written a row in 6+ hours means a stale-deployment
// cron (Vercel crons pin to the deployment that registered them), and
// Slack silence looks identical to a quiet period.
//
// Both functions are fail-soft on "relation does not exist" — the app
// ships before the table (the notification_log posture). recordDigestRun
// must NEVER throw: a heartbeat that can take down the digest it
// monitors would be worse than no heartbeat.

import { supabaseService } from './supabase-service'
import type { WebhookDigest } from './webhook-digest'

// The digest fires every 3h (vercel.json). Twice-missed = stale: one
// missed beat could be a transient function failure; two is the pin.
export const DIGEST_STALE_MS = 6 * 60 * 60 * 1000

export type DigestRunRow = {
  ran_at: string
  window_label: string | null
  suppressed: boolean
  posted: boolean
  skipped: string | null
  all_clear: boolean | null
  leads_landed: number | null
  leads_failed: number | null
  jobber_landed: number | null
  jobber_didnt_land: number | null
  self_heals: number | null
  loc_other_leads: number | null
  import_failed: number | null
  import_stalled: number | null
  import_origin_gated: boolean | null
  rate_missing: number | null
  booking_link_missing: number | null
}

const isMissingTable = (message: string | undefined) =>
  /does not exist/i.test(message || '')

export async function recordDigestRun(
  digest: WebhookDigest,
  post: { ok: boolean; skipped?: string } | null,
): Promise<void> {
  try {
    const { error } = await supabaseService.from('digest_runs').insert({
      window_label: 'last 3h',
      suppressed: digest.suppressed,
      posted: post?.ok ?? false,
      skipped: post?.skipped ?? null,
      all_clear: digest.allClear,
      leads_landed: digest.leadsLanded,
      leads_failed: digest.leadsFailed,
      jobber_landed: digest.jobberLanded,
      jobber_didnt_land: digest.jobberDidntLand,
      self_heals: digest.selfHeals,
      loc_other_leads: digest.locOtherLeads,
      import_failed: digest.importFailed,
      import_stalled: digest.importStalled,
      import_origin_gated: digest.importOriginGated,
      rate_missing: digest.rateMissing,
      booking_link_missing: digest.bookingLinkMissing,
      message_text: digest.suppressed ? null : digest.text,
    })
    if (error && !isMissingTable(error.message)) {
      console.error('[digest-runs] insert failed (non-fatal)', error.message)
    }
  } catch (err: any) {
    console.error('[digest-runs] unexpected insert error (non-fatal)', err?.message || err)
  }
}

// tracked:false = the table isn't there yet (pre-migration) — callers
// render "run tracking not wired yet", never a fake "no runs".
export async function fetchLatestDigestRun(): Promise<{
  tracked: boolean
  run: DigestRunRow | null
}> {
  try {
    const { data, error } = await supabaseService
      .from('digest_runs')
      .select(
        'ran_at, window_label, suppressed, posted, skipped, all_clear, ' +
          'leads_landed, leads_failed, jobber_landed, jobber_didnt_land, self_heals, ' +
          'loc_other_leads, import_failed, import_stalled, import_origin_gated, ' +
          'rate_missing, booking_link_missing',
      )
      .order('ran_at', { ascending: false })
      .limit(1)
    if (error) {
      if (isMissingTable(error.message)) return { tracked: false, run: null }
      console.error('[digest-runs] read failed (non-fatal)', error.message)
      return { tracked: false, run: null }
    }
    const run = (data && data[0]) || null
    return { tracked: true, run: run as unknown as DigestRunRow | null }
  } catch (err: any) {
    console.error('[digest-runs] unexpected read error (non-fatal)', err?.message || err)
    return { tracked: false, run: null }
  }
}
