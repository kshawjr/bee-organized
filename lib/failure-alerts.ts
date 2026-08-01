// lib/failure-alerts.ts
// ─────────────────────────────────────────────────────────────
// Instant failure alerts (issue 159). The webhook digest is now once daily;
// this is the real-time channel. app/api/cron/failure-alerts runs every
// ~5 min, and this module decides what — if anything — to post to Slack.
//
// ALLOWLIST, not a denylist. We alert on exactly four hard, actionable
// failures and NOTHING else. This is the whole difference between a channel
// Kevin reads and one he mutes:
//   1. sync_log landed_status='not_landed' — a webhook processed without
//      error but the record never reached its intended state.
//   2. import_jobs that transitioned to 'failed', EXCLUDING user cancels
//      ('Cancelled by user' — a deliberate stop, not a failure).
//   3. a GENUINE Jobber token expiry — a reauth failure with NO following
//      self-heal. Detection reuses the digest's classifyDigestEvents /
//      SELF_HEAL_WINDOW_MS verbatim; we do not re-derive the token logic.
//   4. ASSESSMENT_TEAM_MISMATCH breadcrumbs (issue 144/147) — the send
//      succeeded but the assessment team didn't fully apply.
//
// DELIBERATELY EXCLUDED (would drown the useful signal):
//   • raw sync_log status='error' — overwhelmingly self-healing webhook
//     token-race transients (135/30d). Only a genuine, un-healed expiry (3)
//     or a recorded not_landed (1) gets through.
//   • notification_log send_status='failed' — 100% two fake test leads
//     (294/7d). This module never reads notification_log at all.
//   • status='partial' — never written in prod (all-time 0). Add once seen.
//
// DEDUPE = a stored watermark (lib/alert-runs). Each run considers only rows
// created after the last watermark and at-or-before a settle cutoff of
// now-SELF_HEAL_WINDOW_MS, so:
//   • every failure is evaluated in exactly one window → alerted once, and
//   • a reauth failure has its full 5-min self-heal window to resolve before
//     we call it a genuine expiry — a token race that heals at minute 2 is
//     never alerted.
// The formatter (selectNewAlerts / buildAlertMessage) is pure so the
// windowing + allowlist are unit-testable without Slack or Supabase.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { fetchWebhookLogEvents, type WebhookLogEvent } from './webhook-observability'
import { classifyDigestEvents, SELF_HEAL_WINDOW_MS } from './webhook-digest'

// The watermark trails now() by this settle window so token-race self-heals
// resolve before we alert. Reuse the digest's window verbatim — same 5 min.
export const ALERT_SETTLE_MS = SELF_HEAL_WINDOW_MS

// Cap the lines in a single Slack post; overflow is summarised. A run that
// surfaces more than this is an incident, and the count still tells the story.
export const MAX_ALERT_LINES = 12

export type AlertKind = 'not_landed' | 'import_failed' | 'token_expired' | 'assessment_mismatch'

export type AlertItem = {
  kind: AlertKind
  ts: number       // ms — used for ordering + the once-only window boundary
  text: string     // one phone-readable line, no emoji bullet (added at render)
}

// Raw import_jobs failure row (fetchImportFailures).
export type ImportFailedRow = {
  location_id?: string | null
  phase?: string | null
  error_message?: string | null
  processed_records?: number | null
  total_records?: number | null
  completed_at?: string | null
}

// Raw sync_log ASSESSMENT_TEAM_MISMATCH breadcrumb (fetchAssessmentMismatches).
export type MismatchRow = {
  location_id?: string | null
  message?: string | null
  created_at?: string | null
}

// ── line helpers (phone copy: what broke and where, one line) ──────

const clean = (s: string, max = 140) => s.replace(/\s+/g, ' ').trim().slice(0, max)

const locLabel = (slug: string | null | undefined, locName: Map<string, string>) =>
  (slug && locName.get(slug)) || slug || 'Unknown account'

const whoLabel = (e: WebhookLogEvent) =>
  e.client_name || (e.jobber_item ? `Jobber #${e.jobber_item}` : 'record')

const progressOf = (j: ImportFailedRow) =>
  j.total_records ? ` (${j.processed_records || 0}/${j.total_records})` : ''

const inWindow = (t: number, sinceMs: number, cutoffMs: number) =>
  Number.isFinite(t) && t > sinceMs && t <= cutoffMs

// ── the pure selector ──────────────────────────────────────────────
// Given the raw sources already fetched for the run, return the alert lines
// that are BOTH allowlisted AND newly-committed in (sinceMs, cutoffMs]. Pure:
// no Supabase, no Slack — the unit-test surface for windowing + allowlist.
export function selectNewAlerts(input: {
  events: WebhookLogEvent[]        // enriched inbound webhook events
  importFailed: ImportFailedRow[]  // import_jobs status='failed' rows
  mismatches: MismatchRow[]        // sync_log ASSESSMENT_TEAM_MISMATCH rows
  locName: Map<string, string>     // slug → display name
  sinceMs: number
  cutoffMs: number                 // = nowMs - ALERT_SETTLE_MS
  nowMs: number
}): AlertItem[] {
  const { events, importFailed, mismatches, locName, sinceMs, cutoffMs, nowMs } = input
  const items: AlertItem[] = []

  // (1) not_landed — a webhook that processed but never reached its state.
  for (const e of events) {
    if (e.landed !== 'stuck') continue
    const t = Date.parse(e.created_at)
    if (!inWindow(t, sinceMs, cutoffMs)) continue
    items.push({
      kind: 'not_landed',
      ts: t,
      text: `Didn't land — ${locLabel(e.location_id, locName)}: ${whoLabel(e)} · ${e.friendly}`,
    })
  }

  // (3) genuine Jobber token expiry — reuse the digest's token/self-heal
  // logic verbatim. Feed classifyDigestEvents a settle-bounded slice:
  //   • FAILURES only if settled (created_at ≤ cutoff) — a not-yet-settled
  //     reauth failure might still heal, so it waits for the next window.
  //   • SUCCESSES up to now — a heal for an in-window failure lands within
  //     5 min after it, i.e. ≤ cutoff + 5min = now.
  // Every tokenExpired problem it returns is therefore in-window, settled,
  // and un-healed — a genuine expiry, counted exactly once.
  const settleSlice = events.filter(e => {
    const t = Date.parse(e.created_at)
    if (!(t > sinceMs && t <= nowMs)) return false
    return e.processed ? true : t <= cutoffMs
  })
  const { jobberProblems } = classifyDigestEvents(settleSlice)
  for (const p of jobberProblems) {
    if (!p.tokenExpired) continue
    items.push({
      kind: 'token_expired',
      ts: cutoffMs, // classify drops the source ts; the window filter above already fixed uniqueness
      text: `Jobber token expired — ${p.location} — reconnect Jobber`,
    })
  }

  // (2) import failed, excluding deliberate user cancels.
  for (const j of importFailed) {
    if (/cancelled by user/i.test(j.error_message || '')) continue
    const t = Date.parse(j.completed_at || '')
    if (j.completed_at && !inWindow(t, sinceMs, cutoffMs)) continue
    items.push({
      kind: 'import_failed',
      ts: Number.isFinite(t) ? t : cutoffMs,
      text: `Import failed — ${locLabel(j.location_id, locName)}${progressOf(j)}: ${clean(j.error_message || 'unknown error')}`,
    })
  }

  // (4) ASSESSMENT_TEAM_MISMATCH — the send landed but the team didn't apply.
  for (const r of mismatches) {
    const t = Date.parse(r.created_at || '')
    if (r.created_at && !inWindow(t, sinceMs, cutoffMs)) continue
    const missingRaw = (r.message || '').match(/missing=\[([^\]]*)\]/)?.[1] || ''
    const nMissing = missingRaw.split(',').map(s => s.trim()).filter(Boolean).length
    const tail = nMissing ? ` (${nMissing} assignee${nMissing > 1 ? 's' : ''} missing)` : ''
    items.push({
      kind: 'assessment_mismatch',
      ts: Number.isFinite(t) ? t : cutoffMs,
      text: `Assessment team didn't apply — ${locLabel(r.location_id, locName)}${tail}`,
    })
  }

  return items.sort((a, b) => a.ts - b.ts)
}

// ── the pure message builder ────────────────────────────────────────
// Zero items → null (a quiet window posts NOTHING). Otherwise one compact
// Slack message: a header count + one line per failure, capped.
const EMOJI: Record<AlertKind, string> = {
  not_landed: ':warning:',
  import_failed: ':x:',
  token_expired: ':key:',
  assessment_mismatch: ':busts_in_silhouette:',
}

export function buildAlertMessage(items: AlertItem[]): { text: string; count: number } | null {
  if (items.length === 0) return null
  const header = `:rotating_light: ${items.length} failure${items.length > 1 ? 's' : ''} to check`
  const lines = items.slice(0, MAX_ALERT_LINES).map(i => `• ${EMOJI[i.kind]} ${i.text}`)
  const more = items.length - MAX_ALERT_LINES
  if (more > 0) lines.push(`_…plus ${more} more_`)
  return { text: `${header}\n${lines.join('\n')}`, count: items.length }
}

// ── fetch helpers (mirrors lib/import-health: injectable supabase) ──

export async function fetchImportFailures(
  supabase: typeof supabaseService,
  sinceIso: string,
  cutoffIso: string,
): Promise<ImportFailedRow[]> {
  const { data } = await supabase
    .from('import_jobs')
    .select('location_id, phase, error_message, processed_records, total_records, completed_at')
    .eq('type', 'jobber_clients')
    .eq('status', 'failed')
    .gt('completed_at', sinceIso)
    .lte('completed_at', cutoffIso)
    .order('completed_at', { ascending: true })
    .limit(50)
  return (data as ImportFailedRow[]) ?? []
}

export async function fetchAssessmentMismatches(
  supabase: typeof supabaseService,
  sinceIso: string,
  cutoffIso: string,
): Promise<MismatchRow[]> {
  // Both directions: the send-to-jobber breadcrumb (issue 144) writes inbound,
  // the engagement assignee-sync one (issue 147) writes outbound — so scope on
  // the message token, not on direction.
  const { data } = await supabase
    .from('sync_log')
    .select('location_id, message, created_at')
    .ilike('message', '%ASSESSMENT_TEAM_MISMATCH%')
    .gt('created_at', sinceIso)
    .lte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(50)
  return (data as MismatchRow[]) ?? []
}

async function fetchLocationNames(supabase: typeof supabaseService): Promise<Map<string, string>> {
  const { data } = await supabase.from('locations').select('location_id, name')
  const map = new Map<string, string>()
  for (const l of (data as any[]) || []) map.set(l.location_id, l.name || l.location_id)
  return map
}

// ── the run collector (route entrypoint) ────────────────────────────
// Fetches the three raw sources + the location-name map for the window, then
// runs the pure selector. cutoff trails now() by ALERT_SETTLE_MS; sinceMs is
// the prior watermark. An empty (settled) window short-circuits to no work.
export async function collectFailureAlerts(opts: {
  nowMs: number
  sinceMs: number
  supabase?: typeof supabaseService
  fetchEvents?: typeof fetchWebhookLogEvents
}): Promise<{ items: AlertItem[]; cutoffMs: number }> {
  const supabase = opts.supabase ?? supabaseService
  const fetchEvents = opts.fetchEvents ?? fetchWebhookLogEvents
  const cutoffMs = opts.nowMs - ALERT_SETTLE_MS
  if (opts.sinceMs >= cutoffMs) return { items: [], cutoffMs }

  const sinceIso = new Date(opts.sinceMs).toISOString()
  const cutoffIso = new Date(cutoffMs).toISOString()

  // '24h' bounds the enriched read while comfortably covering (since, now];
  // the (sinceMs, cutoffMs] filter — not the fetch window — is the real dedup
  // boundary. A cron outage longer than 24h would drop older not_landed /
  // token detail here; the daily digest is the backstop for that tail.
  const [{ events }, importFailed, mismatches, locName] = await Promise.all([
    fetchEvents({ window: '24h' }),
    fetchImportFailures(supabase, sinceIso, cutoffIso),
    fetchAssessmentMismatches(supabase, sinceIso, cutoffIso),
    fetchLocationNames(supabase),
  ])

  const items = selectNewAlerts({
    events,
    importFailed,
    mismatches,
    locName,
    sinceMs: opts.sinceMs,
    cutoffMs,
    nowMs: opts.nowMs,
  })
  return { items, cutoffMs }
}
