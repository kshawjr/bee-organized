// lib/webhook-digest.ts
// ─────────────────────────────────────────────────────────────
// Pure formatter for the once-daily ops digest (app/api/cron/webhook-digest).
// The cron fetches the sources and posts whatever this returns; keeping the
// formatting pure keeps it unit-testable without Slack or Supabase.
//
// THE RULE (Sept 2026 rebuild): the digest carries only what Kevin should
// KNOW ABOUT but that is not an emergency — and it says NOTHING when every
// count is zero. Instant problems (a lead that didn't arrive, an owner's bug,
// a Jobber reconnect, a failed import…) go out on their own the moment they
// happen (lib/failure-alerts) and are not repeated here.
//
// WHAT IT CARRIES, each section only when non-zero:
//   • NEVER LANDED — a Jobber change that failed (or processed but never
//     reached its state) and never came through on a later retry. A record
//     that recovered is not a problem and is not mentioned.
//   • STUCK — imports stalled / bouncing / origin SSO-gated; locations whose
//     sends are held for a missing rate or booking link; locations still
//     waiting on a Jobber reconnect.
//
// WHAT IT NEVER CARRIES:
//   • "healthy" rundowns — leads in, Jobber events landed, loc_other shares.
//     A daily message that says nothing is wrong trains the reader to skip
//     it, and then it is skipped on the day it matters.
//   • token self-heals, or any individual token failure (see lib/failure-
//     alerts — 31 of 33 in a week were back within a second).
//   • "no matching lead" no-ops. Measured 2026-09-26 over 7 days: ~250, of
//     which ~213 were one Portland user deleting ~200 old requests in Jobber
//     in two hours, and 20 were PROPERTY_CREATE arriving seconds before
//     Bee Hub had linked a brand-new client (all 20 clients exist). They are
//     normal activity, so they are not a line.
// ─────────────────────────────────────────────────────────────

import type { WebhookLogEvent } from './webhook-observability'

// How long the instant rail waits for a row to settle before judging it
// (lib/failure-alerts ALERT_SETTLE_MS reuses this).
export const SELF_HEAL_WINDOW_MS = 5 * 60 * 1000

// A Jobber change that failed less than this long ago may still be retried —
// Jobber retries with backoff, and one prod retry took 9m48s. Younger
// failures are left for tomorrow's digest (its 24h window still covers them)
// rather than reported as never-landed while a retry is on its way.
export const RETRY_GRACE_MS = 30 * 60 * 1000

const TOKEN_ERR_RE = /reauth|no_valid_jobber_token|\b401\b/i

const MAX_NEVER_LANDED_LINES = 10

export type WebhookDigest = {
  suppressed: boolean       // true → cron posts nothing (every count is zero)
  allClear: boolean         // same as suppressed: nothing to report
  headline: string
  // heartbeat counters (digest_runs) — recorded, never posted
  leadsLanded: number
  leadsFailed: number
  jobberLanded: number
  jobberDidntLand: number   // = neverLanded (the digest_runs column name predates the rebuild)
  selfHeals: number         // failures that recovered on a later retry
  locOtherLeads: number
  // what the digest reports
  neverLanded: number
  importFailed: number      // heartbeat only — failed imports alert instantly
  importStalled: number
  importOriginGated: boolean
  // active locations on rate-quoting default paths (-a/-b) with a blank
  // rate_per_hour — their rate-quoting sends are HELD by lib/rate-guard
  rateMissing: number
  // active locations on booking default paths (-b/-d) with a blank
  // calendar_link — their booking sends are HELD by lib/booking-link
  bookingLinkMissing: number
  // locations still stamped RECONNECT REQUIRED (lib/jobber-reconnect)
  reconnectRequired: number
  text: string
}

// ── import health section (item 2/3) ─────────────────────────────
// The import pipeline reports into this SAME ops digest (never the per-lead
// notification path). Only PROBLEMS produce output — a healthy import window
// adds nothing (no lines, no un-suppress). A FAILED import is not here: it is
// an instant alert (lib/failure-alerts), and repeating it the next morning
// would be the noise this digest exists to avoid. What stays is what is STUCK:
//   • stalled — jobs still running with a claim staler than the alert window
//   • origin gated — the internal re-poke origin is SSO-gated, so EVERY
//     self-resume bounces (the Scottsdale root cause). This escalates the
//     origin health probe (lib/internal-origin.probeInternalOriginGated)
//     instead of a silent console.warn.
export type ImportHealthInput = {
  failed: Array<{
    location_id?: string | null
    phase?: string | null
    error_message?: string | null
    processed_records?: number | null
    total_records?: number | null
  }>
  stalled: Array<{
    location_id?: string | null
    phase?: string | null
    processed_records?: number | null
    total_records?: number | null
    location_claim_at?: string | null
    started_at?: string | null
  }>
  // Continuation handoffs that failed to land in the window, per location.
  // A bouncing handoff is the leading indicator of a stall — it shows up here
  // BEFORE the job stops progressing and long before it fails out. Optional so
  // a pre-fix caller (or a sync_log read that errored) degrades to no section.
  bounced?: Array<{
    location_id?: string | null
    count: number
    outcomes?: string
    sample?: string
  }>
  originGated: boolean | null   // true = SSO-gated (BAD); false = healthy; null = not probed
  originTarget?: string
  nowMs: number
}

const MAX_IMPORT_LINES = 10

const progressOf = (j: { processed_records?: number | null; total_records?: number | null }) =>
  j.total_records ? ` (${j.processed_records || 0}/${j.total_records})` : ''

const staleMinutes = (j: { location_claim_at?: string | null; started_at?: string | null }, nowMs: number) => {
  const ref = j.location_claim_at || j.started_at
  const refMs = ref ? Date.parse(ref) : NaN
  return Number.isFinite(refMs) ? Math.max(0, Math.round((nowMs - refMs) / 60000)) : null
}

export function buildImportHealthSection(
  input: ImportHealthInput | undefined,
  windowLabel: string,
): { lines: string[]; failedCount: number; stalledCount: number; originGated: boolean; hasProblems: boolean } {
  if (!input) return { lines: [], failedCount: 0, stalledCount: 0, originGated: false, hasProblems: false }

  const failedCount = input.failed.length
  const stalledCount = input.stalled.length
  const bounced = input.bounced ?? []
  const bouncedCount = bounced.reduce((n, b) => n + (b.count || 0), 0)
  const originGated = input.originGated === true
  // failedCount is still counted for the heartbeat row, but it is not a
  // daily problem — the instant rail already said it.
  const hasProblems = stalledCount > 0 || originGated || bouncedCount > 0
  if (!hasProblems) return { lines: [], failedCount, stalledCount, originGated, hasProblems: false }

  const lines: string[] = [`*:package: Imports* (${windowLabel})`]

  if (originGated) {
    lines.push(
      `• :rotating_light: Re-poke origin is SSO-GATED${input.originTarget ? ` (${input.originTarget})` : ''} — ` +
        `imports cannot self-resume; every sweeper re-poke bounces. ` +
        `Set NEXT_PUBLIC_APP_URL to the non-SSO custom domain.`,
    )
  }

  if (stalledCount > 0) {
    lines.push(`• :warning: ${stalledCount} stalled (running, no progress):`)
    for (const j of input.stalled.slice(0, MAX_IMPORT_LINES)) {
      const loc = j.location_id || 'unknown'
      const mins = staleMinutes(j, input.nowMs)
      lines.push(`    • ${loc} — ${j.phase || 'unknown'}${progressOf(j)}${mins != null ? ` — stuck ${mins}m` : ''}`)
    }
    const more = stalledCount - MAX_IMPORT_LINES
    if (more > 0) lines.push(`    _…plus ${more} more_`)
  }

  // Leading indicator: the handoff is failing but the job hasn't died yet.
  // Surfacing this is the whole point — the previous continuation failures
  // were console.warn-only, so a silently broken handoff looked like nothing
  // at all until an import had already stalled for 15 minutes.
  if (bouncedCount > 0) {
    lines.push(`• :arrows_counterclockwise: ${bouncedCount} continuation re-poke(s) did NOT land:`)
    for (const b of bounced.slice(0, MAX_IMPORT_LINES)) {
      const loc = b.location_id || 'unknown'
      const detail = (b.sample || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      lines.push(`    • ${loc} — ${b.outcomes || `${b.count} failed`}${detail ? `: ${detail}` : ''}`)
    }
    const more = bounced.length - MAX_IMPORT_LINES
    if (more > 0) lines.push(`    _…plus ${more} more locations_`)
  }

  return { lines, failedCount, stalledCount, originGated, hasProblems: true }
}

// ── blank-rate section ───────────────────────────────────────────
// Standing condition, not a per-window event: an active location whose
// default path quotes {{rate_per_hour}} with no rate set has its
// rate-quoting sends HELD (lib/rate-guard.ts). It stays in the digest
// every window until the rate is entered or the path changes — that
// pressure is the point; the alternative was a silent hole in client
// emails. Healthy (empty) input produces no lines and no un-suppress.
export type RateHealthDigestInput = {
  missingRate: Array<{
    location_id?: string | null
    name?: string | null
    paths?: string[]
  }>
}

export function buildRateHealthSection(
  input: RateHealthDigestInput | undefined,
): { lines: string[]; missingCount: number; hasProblems: boolean } {
  const rows = input?.missingRate ?? []
  if (rows.length === 0) return { lines: [], missingCount: 0, hasProblems: false }
  const lines: string[] = [`*:moneybag: Hourly rate missing* (sends held until set)`]
  for (const r of rows) {
    const loc = r.name || r.location_id || 'unknown'
    const paths = (r.paths ?? []).join(', ')
    lines.push(`    • ${loc}${paths ? ` — ${paths}` : ''} — rate-quoting drips are held; enter the rate in Settings → Pricing`)
  }
  return { lines, missingCount: rows.length, hasProblems: true }
}

// ── missing-booking-link section ─────────────────────────────────
// Standing condition, exactly like the blank-rate section above: an active
// location whose default path tells the client to click a scheduling link
// with no calendar_link set has those sends HELD (lib/booking-link). It
// stays in the digest every window until a link is set or the path changes.
// Healthy (empty) input produces no lines and no un-suppress.
export type BookingLinkHealthDigestInput = {
  missingLink: Array<{
    location_id?: string | null
    name?: string | null
    paths?: string[]
  }>
}

export function buildBookingLinkHealthSection(
  input: BookingLinkHealthDigestInput | undefined,
): { lines: string[]; missingCount: number; hasProblems: boolean } {
  const rows = input?.missingLink ?? []
  if (rows.length === 0) return { lines: [], missingCount: 0, hasProblems: false }
  const lines: string[] = [`*:calendar: Booking link missing* (sends held until set)`]
  for (const r of rows) {
    const loc = r.name || r.location_id || 'unknown'
    const paths = (r.paths ?? []).join(', ')
    lines.push(`    • ${loc}${paths ? ` — ${paths}` : ''} — booking drips are held; set the link in Settings → My Location, or per person in Settings → Profile`)
  }
  return { lines, missingCount: rows.length, hasProblems: true }
}

// ── still-waiting-on-reconnect section ───────────────────────────
// The instant rail alerts the moment a location is stamped; this is the
// daily reminder that it is STILL stamped. Healthy → invisible.
export type ReconnectDigestInput = {
  locations: Array<{ location_id?: string | null; name?: string | null }>
}

export function buildReconnectSection(
  input: ReconnectDigestInput | undefined,
): { lines: string[]; count: number } {
  const rows = input?.locations ?? []
  if (rows.length === 0) return { lines: [], count: 0 }
  const lines: string[] = [`*:electric_plug: Jobber still disconnected* (nothing syncs until reconnected)`]
  for (const r of rows) {
    lines.push(`    • ${r.name || r.location_id || 'unknown'} — reconnect Jobber in Settings`)
  }
  return { lines, count: rows.length }
}

// ── never landed ─────────────────────────────────────────────────

export type NeverLanded = {
  location: string
  who: string
  friendly: string
  reason: string
  at: number
}

const ts = (e: WebhookLogEvent) => Date.parse(e.created_at) || 0

// A Jobber record is the same record whatever topic the retry arrives under
// (QUOTE_APPROVED fails, QUOTE_UPDATE lands) — so the key is the item alone.
const itemKey = (e: WebhookLogEvent) => e.jobber_item || e.entity_id || e.id

const recovered = (e: WebhookLogEvent) => e.processed && e.landed !== 'stuck'

const locName = (e: WebhookLogEvent) =>
  e.location_name || e.location_id || 'Unknown account'

const who = (e: WebhookLogEvent) =>
  e.client_name || (e.jobber_item ? `Jobber #${e.jobber_item}` : 'Unknown record')

// Jobber changes that failed or never reached their state AND never came
// through on a later row for the same record. One entry per record (its
// latest failure). Lead intake is excluded — a failed lead is an instant
// alert, not a daily line.
export function findNeverLanded(
  events: WebhookLogEvent[],
  nowMs: number,
): { neverLanded: NeverLanded[]; recoveredCount: number } {
  const jobber = events.filter(e => e.topic !== 'LEAD_INTAKE')
  const latestOk = new Map<string, number>()
  for (const e of jobber) {
    if (!recovered(e)) continue
    const k = itemKey(e)
    latestOk.set(k, Math.max(latestOk.get(k) ?? 0, ts(e)))
  }
  const byItem = new Map<string, WebhookLogEvent>()
  let recoveredCount = 0
  for (const e of jobber) {
    if (recovered(e)) continue
    if ((latestOk.get(itemKey(e)) ?? 0) > ts(e)) { recoveredCount++; continue }
    if (nowMs - ts(e) < RETRY_GRACE_MS) continue
    const k = itemKey(e)
    const prev = byItem.get(k)
    if (!prev || ts(e) > ts(prev)) byItem.set(k, e)
  }
  const neverLanded = Array.from(byItem.values())
    .sort((a, b) => ts(a) - ts(b))
    .map(e => ({
      location: locName(e),
      who: who(e),
      friendly: e.friendly,
      reason: e.processed
        ? "processed but didn't reach its state"
        : TOKEN_ERR_RE.test(`${e.error || ''} ${e.reason || ''}`)
          ? 'the Jobber connection blipped and no retry came'
          : (e.reason || e.error || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 120),
      at: ts(e),
    }))
  return { neverLanded, recoveredCount }
}

// ── formatting ────────────────────────────────────────────────

const plural = (n: number, s: string) => `${n} ${s}${n !== 1 ? 's' : ''}`

export function buildWebhookDigest(opts: {
  events: WebhookLogEvent[]
  appUrl: string          // e.g. https://app.example.com (no trailing slash)
  windowLabel?: string    // human label for the query window
  nowMs?: number          // defaults to Date.now(); tests pin it
  importHealth?: ImportHealthInput   // import pipeline health (item 2/3)
  rateHealth?: RateHealthDigestInput // blank-rate hold rollup (lib/rate-health)
  bookingLinkHealth?: BookingLinkHealthDigestInput // missing-link hold rollup (lib/booking-link-health)
  reconnect?: ReconnectDigestInput   // locations still stamped RECONNECT REQUIRED
}): WebhookDigest {
  const { appUrl } = opts
  const windowLabel = opts.windowLabel || 'last 24h'
  const nowMs = opts.nowMs ?? Date.now()

  const { neverLanded, recoveredCount } = findNeverLanded(opts.events, nowMs)
  const imp = buildImportHealthSection(opts.importHealth, windowLabel)
  const rate = buildRateHealthSection(opts.rateHealth)
  const booking = buildBookingLinkHealthSection(opts.bookingLinkHealth)
  const reconnect = buildReconnectSection(opts.reconnect)

  // Heartbeat counters — recorded on digest_runs, never posted.
  const leads = opts.events.filter(e => e.topic === 'LEAD_INTAKE')
  const leadsLanded = leads.filter(e => e.processed).length
  const leadsFailed = leads.length - leadsLanded
  const locOtherLeads = leads.filter(e => e.processed && e.location_id === 'loc_other').length
  const jobberLanded = opts.events.filter(e => e.topic !== 'LEAD_INTAKE' && recovered(e)).length

  // THE SILENCE RULE. Every reportable count, and nothing else: a day with
  // leads flowing and Jobber syncing but nothing wrong posts NOTHING.
  const problems =
    neverLanded.length + (imp.hasProblems ? 1 : 0) + rate.missingCount +
    booking.missingCount + reconnect.count
  const suppressed = problems === 0

  const parts: string[] = []
  if (neverLanded.length) parts.push(`${plural(neverLanded.length, 'Jobber change')} never landed`)
  if (reconnect.count) parts.push(`${plural(reconnect.count, 'location')} still disconnected from Jobber`)
  if (imp.originGated) parts.push('imports cannot self-resume')
  if (imp.stalledCount) parts.push(`${plural(imp.stalledCount, 'import')} stalled`)
  if (!imp.originGated && !imp.stalledCount && imp.hasProblems) parts.push('import re-pokes bouncing')
  if (rate.missingCount) parts.push(`${plural(rate.missingCount, 'location')} with sends held for no rate`)
  if (booking.missingCount) parts.push(`${plural(booking.missingCount, 'location')} with sends held for no booking link`)
  const headline = suppressed ? '' : `:clipboard: Daily check — ${parts.join(' · ')}`

  // ── never-landed section, grouped by location ──────────────
  const neverLines: string[] = []
  if (neverLanded.length) {
    neverLines.push(`*:warning: Never landed* (${windowLabel}) — failed, and no retry came through`)
    const byLoc = new Map<string, NeverLanded[]>()
    for (const n of neverLanded) byLoc.set(n.location, [...(byLoc.get(n.location) || []), n])
    let shown = 0
    for (const [loc, list] of Array.from(byLoc.entries())) {
      for (const n of list) {
        if (shown >= MAX_NEVER_LANDED_LINES) break
        neverLines.push(`    • ${loc}: ${n.who} — ${n.friendly}: ${n.reason}`)
        shown++
      }
    }
    const more = neverLanded.length - shown
    if (more > 0) neverLines.push(`    _…plus ${more} more_`)
    neverLines.push(`<${appUrl}/admin?adminTab=webhooks&whFilter=failures&whWindow=24h|Open the webhook dashboard>`)
  }

  const blocks = [neverLines, reconnect.lines, imp.lines, rate.lines, booking.lines]
    .filter(l => l.length)
    .map(l => l.join('\n'))
  const text = suppressed ? '' : [headline, ...blocks].join('\n\n')

  return {
    suppressed,
    allClear: suppressed,
    headline,
    leadsLanded,
    leadsFailed,
    jobberLanded,
    jobberDidntLand: neverLanded.length,
    selfHeals: recoveredCount,
    locOtherLeads,
    neverLanded: neverLanded.length,
    importFailed: imp.failedCount,
    importStalled: imp.stalledCount,
    importOriginGated: imp.originGated,
    rateMissing: rate.missingCount,
    bookingLinkMissing: booking.missingCount,
    reconnectRequired: reconnect.count,
    text,
  }
}
