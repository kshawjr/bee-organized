// app/api/admin/system-health/route.ts
//
// GET /api/admin/system-health — one read for the Admin → System Health
// summary (components/admin/SystemHealthScreen). Verdict first, then the
// panels: connections, imports, webhooks, emails, "needs a look", and the
// business-activity window.
//
// SURFACING, NOT INSTRUMENTATION. Every number here comes from tables and
// helpers that already exist — the digest's own fetch* helpers, the
// jobber-status derivation, and head:true counts. The one exception is the
// digest heartbeat, which reads digest_runs (migrations/digest_runs.sql) and
// degrades to tracked:false until that table is applied.
//
// COST. PostgREST aggregates are disabled project-wide, so this route is
// built from bounded reads only: one locations read, one skinny 7d leads
// fetch (~tens of rows at ~7 leads/day tenant-wide), a handful of parallel
// head:true counts, and the digest's fail-soft helpers. No RPC, no row
// floods — the same posture as lib/hub-all-overview (Phase 4b).
//
// Gate: super_admin / admin (raw DB roles — DB 'admin' is the UI's
// 'corporate'), copied verbatim from notification-log. THIS ROUTE IS THE
// GATE: reads use supabaseService, which bypasses RLS.
//
// ?window=24h|7d — bounds the ACTIVITY panel only (default 24h). Health
// signals keep their own windows (webhooks/emails 24h, import failures 7d,
// quiet-location rule always 7d) so toggling the activity window can't
// quietly change what "healthy" means.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { jobberStatusView } from '@/lib/jobber-status'
import { fetchImportHealth } from '@/lib/import-health'
import { fetchRateHealth } from '@/lib/rate-health'
import { fetchBookingLinkHealth } from '@/lib/booking-link-health'
import { fetchLatestDigestRun, DIGEST_STALE_MS } from '@/lib/digest-runs'
import { isJobParked } from '@/lib/import-phase'
import { getManageableRecipients } from '@/lib/notification-recipients'
import { isSpecificSelection } from '@/lib/notification-project-types'
import { LOC_OTHER_SLUG } from '@/lib/hub-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ELEVATED_ROLES = ['super_admin', 'admin']

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

type ActivityWindow = '24h' | '7d'

// Every block degrades independently — a hiccup in one read must not blank
// the whole screen. null = "couldn't read", rendered as an honest gap.
async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err: any) {
    console.error(`[system-health] ${label} failed (non-fatal)`, err?.message || err)
    return null
  }
}

const headCount = async (build: () => any): Promise<number | null> => {
  const { count, error } = await build()
  if (error) throw new Error(error.message)
  return typeof count === 'number' ? count : null
}

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller || !ELEVATED_ROLES.includes(caller.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const windowParam = req.nextUrl.searchParams.get('window')
  const window: ActivityWindow = windowParam === '7d' ? '7d' : '24h'

  const nowMs = Date.now()
  const since24h = new Date(nowMs - DAY_MS).toISOString()
  const since7d = new Date(nowMs - WEEK_MS).toISOString()
  const sinceWindow = window === '7d' ? since7d : since24h

  // ── one locations read feeds jobber status, name maps, and config checks ──
  // Token columns are selected ONLY to compute presence booleans (the
  // jobber-health pattern) — they never leave this function.
  const locations = await safe('locations read', async () => {
    const { data, error } = await supabaseService
      .from('locations')
      .select(
        'id, location_id, slug, name, jobber_connected, jobber_access_token, ' +
          'jobber_refresh_token, token_expiry, last_sync_status, lifecycle_status, ' +
          'split_notifications_enabled',
      )
      .order('name', { ascending: true })
    if (error) throw new Error(error.message)
    return (data || []) as any[]
  })

  const nameBySlug = new Map<string, string>()
  const nameByUuid = new Map<string, string>()
  for (const l of locations || []) {
    if (l.location_id) nameBySlug.set(l.location_id, l.name || l.location_id)
    if (l.id) nameByUuid.set(l.id, l.name || l.id)
  }
  const activeLocations = (locations || []).filter(
    (l: any) => l.lifecycle_status === 'active' && l.location_id !== LOC_OTHER_SLUG,
  )

  // ── jobber connection summary — the shared derivation, never a re-read of
  // token expiry (lib/jobber-status is authoritative) ──
  const jobber = (() => {
    if (!locations) return null
    const views = locations.map((l: any) => ({
      name: l.name || l.location_id || '—',
      lifecycleStatus: l.lifecycle_status || null,
      view: jobberStatusView({
        connected: !!l.jobber_connected,
        tokenExpiry: l.token_expiry ?? null,
        lastSyncStatus: l.last_sync_status ?? null,
        hasAccessToken: !!l.jobber_access_token,
        hasRefreshToken: !!l.jobber_refresh_token,
      }),
    }))
    return {
      total: views.length,
      connected: views.filter(v => v.view.status === 'connected').length,
      autoRefreshing: views.filter(v => v.view.autoRefreshing).length,
      reconnectRequired: views.filter(v => v.view.status === 'reconnect_required').length,
      disconnected: views.filter(v => v.view.status === 'disconnected').length,
      // Named problem rows: every reconnect_required, plus disconnected ONLY
      // for active locations (a never-connected onboarding location is
      // expected, not a problem).
      problems: views
        .filter(
          v =>
            v.view.status === 'reconnect_required' ||
            (v.view.status === 'disconnected' && v.lifecycleStatus === 'active'),
        )
        .map(v => ({ name: v.name, status: v.view.status, label: v.view.label })),
    }
  })()

  const [
    importHealth,
    runningImports,
    webhooks,
    emails,
    rateHealth,
    bookingHealth,
    unroutedCount,
    leads7d,
    activityCounts,
    won,
    expiredInvites,
    digest,
    feedback,
  ] = await Promise.all([
    // Failed imports over 7d (panel) — the verdict filters to 24h below.
    // stalled is a now-state; parked jobs are already excluded by the helper.
    safe('import health', () => fetchImportHealth({ nowMs, windowMs: WEEK_MS })),

    // In-flight jobs, classified parked/active via the shared predicates.
    safe('running imports', async () => {
      const { data, error } = await supabaseService
        .from('import_jobs')
        .select('location_id, phase, processed_records, total_records, resume_after, started_at')
        .eq('type', 'jobber_clients')
        .eq('status', 'running')
      if (error) throw new Error(error.message)
      return ((data || []) as any[]).map((j: any) => ({
        name: nameBySlug.get(j.location_id) || j.location_id || '—',
        parked: isJobParked(j.resume_after, nowMs),
        resumeAfter: j.resume_after || null,
        processed: j.processed_records ?? null,
        total: j.total_records ?? null,
      }))
    }),

    // Webhook counts (24h) — real columns, head:true, index-friendly
    // (sync_log_inbound_created_idx / sync_log_attention_idx).
    safe('webhook counts', async () => {
      const base = () =>
        supabaseService
          .from('sync_log')
          .select('id', { count: 'exact', head: true })
          .eq('direction', 'inbound')
          .gte('created_at', since24h)
      const [total, failed, notLanded] = await Promise.all([
        headCount(() => base()),
        headCount(() => base().eq('status', 'error')),
        headCount(() => base().eq('landed_status', 'not_landed')),
      ])
      return { total, failed, notLanded }
    }),

    // Email sends (24h). Pre-migration the table may not exist — tracked:false
    // renders "not tracked yet", never a fake zero.
    safe('email counts', async () => {
      const base = () =>
        supabaseService
          .from('notification_log')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since24h)
      try {
        const [total, failed] = await Promise.all([
          headCount(() => base()),
          headCount(() => base().eq('send_status', 'failed')),
        ])
        return { tracked: true, total, failed }
      } catch (err: any) {
        if (/does not exist/i.test(err?.message || '')) {
          return { tracked: false, total: null, failed: null }
        }
        throw err
      }
    }),

    safe('rate health', () => fetchRateHealth()),
    safe('booking-link health', () => fetchBookingLinkHealth()),

    // The corporate routing queue — same filters as the Inbox queue read
    // (app/_hub-page.tsx): leads.location_id holds the SLUG here.
    safe('unrouted count', () =>
      headCount(() =>
        supabaseService
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('location_id', LOC_OTHER_SLUG)
          .not('is_junk', 'is', true),
      ),
    ),

    // ONE skinny 7d fetch covers leads-in (both windows), sources, busiest
    // locations, the per-day series, AND quiet-location detection — strictly
    // cheaper than per-combination head counts at ~7 leads/day tenant-wide.
    safe('leads 7d', async () => {
      const { data, error } = await supabaseService
        .from('leads')
        .select('location_uuid, location_id, source, created_at')
        .not('is_junk', 'is', true)
        .gte('created_at', since7d)
        .limit(2000)
      if (error) throw new Error(error.message)
      return (data || []) as any[]
    }),

    // Jobber-flow counts for the selected window, off the per-event
    // timestamp columns the webhook handlers already stamp on leads
    // (migrations/jobber_session_c.sql). Latest-occurrence semantics —
    // exactly what "did X happen in the window" needs.
    safe('activity counts', async () => {
      const count = (col: string) =>
        headCount(() =>
          supabaseService
            .from('leads')
            .select('id', { count: 'exact', head: true })
            .not('is_junk', 'is', true)
            .gte(col, sinceWindow),
        )
      const [requests, quotesSent, jobsBooked, invoicesPaid] = await Promise.all([
        count('request_created_at'),
        count('quote_sent_at'),
        count('scheduled_at'),
        count('invoice_paid_at'),
      ])
      return { requests, quotesSent, jobsBooked, invoicesPaid }
    }),

    // Won in window: count + value. Aggregates are disabled, so the value is
    // a tiny row fetch reduced here with the established rule
    // (total_paid, falling back to total_invoiced — app/_hub-page.tsx).
    safe('won in window', async () => {
      const { data, error } = await supabaseService
        .from('engagements')
        .select('total_paid, total_invoiced')
        .eq('stage', 'Closed Won')
        .gte('closed_at', sinceWindow)
        .limit(1000)
      if (error) throw new Error(error.message)
      const rows = (data || []) as any[]
      const value = rows.reduce(
        (sum: number, r: any) => sum + (Number(r.total_paid) || Number(r.total_invoiced) || 0),
        0,
      )
      return { count: rows.length, value }
    }),

    // Expired, never-accepted invites. Seats aren't pre-claimed rows — the
    // pool is counted against pending_invites client-side — so an expired
    // invite left in place keeps a seat looking taken (the 18ac387 class).
    safe('expired invites', () =>
      headCount(() =>
        supabaseService
          .from('pending_invites')
          .select('id', { count: 'exact', head: true })
          .is('accepted_at', null)
          .lt('invite_expires_at', new Date(nowMs).toISOString()),
      ),
    ),

    safe('digest run', () => fetchLatestDigestRun()),

    safe('feedback', async () => {
      const [count, newest] = await Promise.all([
        headCount(() =>
          supabaseService
            .from('feedback_items')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'submitted'),
        ),
        (async () => {
          const { data, error } = await supabaseService
            .from('feedback_items')
            .select('id, type, title, created_at, location_id')
            .eq('status', 'submitted')
            .order('created_at', { ascending: false })
            .limit(3)
          if (error) throw new Error(error.message)
          return (data || []) as any[]
        })(),
      ])
      return {
        open: count,
        newest: newest.map((r: any) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          createdAt: r.created_at,
          locationName: r.location_id ? nameByUuid.get(r.location_id) || null : null,
        })),
      }
    }),
  ])

  // ── split-notifications ON with no project types claimed. Split-enabled
  // locations are rare (one today), so a per-location recipients read is a
  // couple of tiny queries, not a fan-out. location arg is the UUID. ──
  const splitUnclaimed = await safe('split unclaimed', async () => {
    const enabled = activeLocations.filter((l: any) => l.split_notifications_enabled === true)
    const out: { name: string }[] = []
    for (const loc of enabled) {
      const { users, externals } = await getManageableRecipients(loc.id)
      const claimed = [...users, ...externals].some(r => isSpecificSelection(r.category))
      if (!claimed) out.push({ name: loc.name || loc.location_id })
    }
    return out
  })

  // ── quiet locations: active, non-corporate, zero leads in 7d. Absence is
  // the one signal only this cross-location view can see. ──
  const quietLocations = (() => {
    if (!locations || !leads7d) return null
    const seen = new Set<string>()
    for (const r of leads7d as any[]) {
      if (r.location_uuid) seen.add(r.location_uuid)
      if (r.location_id) seen.add(r.location_id)
    }
    return activeLocations
      .filter((l: any) => !seen.has(l.id) && !seen.has(l.location_id))
      .map((l: any) => ({ name: l.name || l.location_id }))
  })()

  // ── activity rollups from the one skinny fetch ──
  const activity = (() => {
    if (!leads7d) return null
    const windowCutoff = window === '7d' ? nowMs - WEEK_MS : nowMs - DAY_MS
    const inWindow = (leads7d as any[]).filter(r => Date.parse(r.created_at) >= windowCutoff)

    const bySourceMap = new Map<string, number>()
    const byLocationMap = new Map<string, number>()
    for (const r of inWindow) {
      const src = (r.source || '').trim() || 'Unknown'
      bySourceMap.set(src, (bySourceMap.get(src) || 0) + 1)
      const locName =
        (r.location_uuid && nameByUuid.get(r.location_uuid)) ||
        (r.location_id && nameBySlug.get(r.location_id)) ||
        r.location_id ||
        'Unknown'
      byLocationMap.set(locName, (byLocationMap.get(locName) || 0) + 1)
    }
    const toSorted = (m: Map<string, number>) =>
      Array.from(m.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)

    // Per-day series over the FULL 7d regardless of the window toggle — the
    // sparkline is a week's pulse, not a re-bucketing of the toggle. Bucketed
    // by UTC date; a row on the partial 8th calendar day at the window's far
    // edge simply misses the seven slots.
    const perDay: { day: string; count: number }[] = []
    for (let i = 6; i >= 0; i--) {
      perDay.push({ day: new Date(nowMs - i * DAY_MS).toISOString().slice(0, 10), count: 0 })
    }
    const slotByDay = new Map(perDay.map(d => [d.day, d]))
    for (const r of leads7d as any[]) {
      const slot = slotByDay.get(String(r.created_at || '').slice(0, 10))
      if (slot) slot.count += 1
    }

    return {
      leadsIn: inWindow.length,
      bySource: toSorted(bySourceMap),
      byLocation: toSorted(byLocationMap),
      perDay,
    }
  })()

  // ── "needs a look" — self-clearing conditions, one row each ──
  const needsALook: { key: string; label: string }[] = []
  if (unroutedCount && unroutedCount > 0) {
    needsALook.push({
      key: 'unrouted',
      label: `${unroutedCount} unrouted lead${unroutedCount === 1 ? '' : 's'} waiting at Corporate`,
    })
  }
  for (const r of rateHealth?.missingRate || []) {
    needsALook.push({
      key: 'rate',
      label: `${r.name || r.location_id} — emails held: path quotes an hourly rate but no rate is set`,
    })
  }
  for (const r of bookingHealth?.missingLink || []) {
    needsALook.push({
      key: 'booking',
      label: `${r.name || r.location_id} — emails held: booking path but no calendar link is set`,
    })
  }
  for (const q of quietLocations || []) {
    needsALook.push({ key: 'quiet', label: `${q.name} — no new leads in the last 7 days` })
  }
  for (const s of splitUnclaimed || []) {
    needsALook.push({
      key: 'split',
      label: `${s.name} — split notifications are on, but no project types are claimed`,
    })
  }
  if (expiredInvites && expiredInvites > 0) {
    needsALook.push({
      key: 'invites',
      label: `${expiredInvites} expired invite${expiredInvites === 1 ? '' : 's'} still counting against seats`,
    })
  }

  // ── verdict. Red = something is broken; amber = nothing broken but the
  // look-list has items or the digest heartbeat is stale; green otherwise. ──
  const failed24h = (importHealth?.failed || []).filter(
    (j: any) => j.completed_at && Date.parse(j.completed_at) >= nowMs - DAY_MS,
  ).length
  const digestStale =
    !!digest?.tracked && !!digest.run && nowMs - Date.parse(digest.run.ran_at) > DIGEST_STALE_MS

  const problems: string[] = []
  if (jobber && jobber.problems.length > 0) {
    problems.push(
      jobber.problems.length === 1
        ? `${jobber.problems[0].name} needs a Jobber reconnect`
        : `${jobber.problems.length} locations need a Jobber reconnect`,
    )
  }
  if (failed24h > 0) problems.push(`${failed24h} import${failed24h === 1 ? '' : 's'} failed in the last 24 hours`)
  if ((importHealth?.stalled || []).length > 0) problems.push('an import looks stalled')
  if ((webhooks?.failed || 0) > 0 || (webhooks?.notLanded || 0) > 0) {
    const n = (webhooks?.failed || 0) + (webhooks?.notLanded || 0)
    problems.push(`${n} webhook event${n === 1 ? '' : 's'} didn't land in the last 24 hours`)
  }
  const cautions: string[] = []
  if ((emails?.failed || 0) > 0) cautions.push(`${emails?.failed} email${emails?.failed === 1 ? '' : 's'} failed to send`)
  if (digestStale && digest?.run) {
    const hours = Math.round((nowMs - Date.parse(digest.run.ran_at)) / (60 * 60 * 1000))
    cautions.push(`the Slack digest hasn't run in ${hours}h — likely a stale-deployment cron`)
  }

  const level: 'green' | 'amber' | 'red' =
    problems.length > 0 ? 'red' : needsALook.length > 0 || cautions.length > 0 ? 'amber' : 'green'

  return NextResponse.json({
    generatedAt: new Date(nowMs).toISOString(),
    window,
    verdict: { level, problems, cautions, attention: needsALook.length },
    digest: digest
      ? {
          tracked: digest.tracked,
          lastRunAt: digest.run?.ran_at || null,
          suppressed: digest.run?.suppressed ?? null,
          posted: digest.run?.posted ?? null,
          allClear: digest.run?.all_clear ?? null,
          stale: digestStale,
        }
      : null,
    jobber,
    webhooks,
    imports: importHealth
      ? {
          running: runningImports || [],
          failed7d: (importHealth.failed || []).length,
          failed24h,
          stalled: (importHealth.stalled || []).length,
        }
      : null,
    emails,
    needsALook,
    activity: activity
      ? {
          ...activity,
          requests: activityCounts?.requests ?? null,
          quotesSent: activityCounts?.quotesSent ?? null,
          jobsBooked: activityCounts?.jobsBooked ?? null,
          invoicesPaid: activityCounts?.invoicesPaid ?? null,
          wonCount: won?.count ?? null,
          wonValue: won?.value ?? null,
        }
      : null,
    feedback,
  })
}
