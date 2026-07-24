// lib/webhook-digest.ts
// ─────────────────────────────────────────────────────────────
// Pure formatter for the Slack webhook digest (runs every 3h — see
// app/api/cron/webhook-digest). The cron fetches the enriched events for
// the window and posts whatever this returns; keeping the formatting pure
// keeps it unit-testable without Slack or Supabase.
//
// REDESIGN (migration-watch): the digest now LEADS with lead-intake
// health (the website→Bee Hub door that runs in parallel with Zoho) and
// re-presents Jobber webhook sync underneath. Two ideas drive the whole
// file:
//
//   1. REAL PROBLEMS ONLY drive the headline. A "real problem" is a lead
//      that DIDN'T LAND or a Jobber event that DIDN'T LAND. Everything
//      that landed — including events that briefly failed a token race
//      and then succeeded on retry — is calm background noise.
//
//   2. TOKEN-RACE SELF-HEALS are not failures. When a Jobber event fails
//      with a reauth/401 error and the SAME entity succeeds again within
//      SELF_HEAL_WINDOW_MS, that pair is a self-heal: the token refreshed
//      mid-flight and Jobber's retry landed. Both rows are consumed —
//      neither counts as landed nor as a failure. They surface only as a
//      calm "expected, no action" line, and never in the headline.
//      A reauth failure with NO following success is a GENUINE expiry
//      (dead refresh token, e.g. loc_kc) — that IS a real didn't-land and
//      is flagged loud.
//
// SUPPRESSION: if nothing landed and nothing failed (a quiet window, or a
// window whose only activity was self-heals), the digest is `suppressed`
// and the cron posts nothing — a digest arriving should mean there was
// activity worth a glance. Self-heal counts are still surfaced when a
// digest fires for other reasons.
// ─────────────────────────────────────────────────────────────

import type { WebhookLogEvent } from './webhook-observability'

// A reauth/401 failure that is followed by a success on the SAME entity
// within this window is treated as a token-race self-heal, not a failure.
// Jobber retries a webhook a few times with backoff; a concurrent request
// refreshing the token means the retry lands seconds-to-minutes later.
// Kept short relative to the 3h digest window so two genuinely-separate
// events on one entity are never mistaken for a heal.
export const SELF_HEAL_WINDOW_MS = 5 * 60 * 1000

// loc_other is the catch-all/testing slug. Some volume there is normal;
// call it out as a spike only when it dominates the window AND there is
// enough total volume for the ratio to mean something (a 1-of-1 window
// shouldn't read as a 100% spike).
export const LOC_OTHER_SLUG = 'loc_other'
export const LOC_OTHER_SPIKE_RATIO = 0.3
export const LOC_OTHER_SPIKE_FLOOR = 4

const TOKEN_ERR_RE = /reauth|no_valid_jobber_token|\b401\b/i

const MAX_LEAD_FAIL_LINES = 10
const MAX_JOBBER_PROBLEM_LINES = 10

export type WebhookDigest = {
  suppressed: boolean       // true → cron posts nothing
  allClear: boolean         // no real problems (may still fire for the calm rundown)
  headline: string
  // counts (also logged by the cron route)
  leadsLanded: number
  leadsFailed: number
  jobberLanded: number
  jobberDidntLand: number
  selfHeals: number
  locOtherLeads: number
  locOtherSpike: boolean
  // import health (added to the digest; 0 / false when healthy)
  importFailed: number
  importStalled: number
  importOriginGated: boolean
  // active locations on rate-quoting default paths (-a/-b) with a blank
  // rate_per_hour — their rate-quoting sends are HELD by lib/rate-guard
  rateMissing: number
  // active locations on booking default paths (-b/-d) with a blank
  // calendar_link — their booking sends are HELD by lib/booking-link
  bookingLinkMissing: number
  text: string
}

// ── import health section (item 2/3) ─────────────────────────────
// The import pipeline reports into this SAME ops digest (never the per-lead
// notification path). Only PROBLEMS produce output — a healthy import window
// adds nothing (no lines, no un-suppress). Three problem classes:
//   • failed  — jobs that ended failed in the window (cancel, token/throttle
//               death, or the sweeper's max-lifetime fail-out)
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
  const hasProblems = failedCount > 0 || stalledCount > 0 || originGated || bouncedCount > 0
  if (!hasProblems) return { lines: [], failedCount, stalledCount, originGated, hasProblems: false }

  const lines: string[] = [`*:package: Imports* (${windowLabel})`]

  if (originGated) {
    lines.push(
      `• :rotating_light: Re-poke origin is SSO-GATED${input.originTarget ? ` (${input.originTarget})` : ''} — ` +
        `imports cannot self-resume; every sweeper re-poke bounces. ` +
        `Set NEXT_PUBLIC_APP_URL to the non-SSO custom domain.`,
    )
  }

  if (failedCount > 0) {
    lines.push(`• :x: ${failedCount} failed:`)
    for (const j of input.failed.slice(0, MAX_IMPORT_LINES)) {
      const loc = j.location_id || 'unknown'
      const reason = (j.error_message || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 160)
      lines.push(`    • ${loc} — ${j.phase || 'unknown'}${progressOf(j)}: ${reason}`)
    }
    const more = failedCount - MAX_IMPORT_LINES
    if (more > 0) lines.push(`    _…plus ${more} more_`)
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

// ── classification ────────────────────────────────────────────

type LeadFailure = { slug: string; reason: string }
type JobberProblem = {
  location: string
  who: string
  friendly: string
  topic: string
  reason: string
  tokenExpired: boolean     // genuine reauth failure with no following success
}
type SelfHeal = { location: string; topic: string }

const ts = (e: WebhookLogEvent) => Date.parse(e.created_at) || 0

// entity identity for self-heal pairing: same topic + same Jobber item.
// jobber_item is extractJobberId(jobber_record_id) and is identical on the
// failing and the healing row (both carry item=<itemId>); entity_id can
// differ (a healed success may resolve a lead_id the failure didn't).
const entityKey = (e: WebhookLogEvent) =>
  `${e.topic}::${e.jobber_item || e.entity_id || e.id}`

const isTokenErr = (e: WebhookLogEvent) =>
  TOKEN_ERR_RE.test(`${e.error || ''} ${e.reason || ''}`)

const locName = (e: WebhookLogEvent) =>
  e.location_name || e.location_id || 'Unknown account'

const leadSlug = (e: WebhookLogEvent) =>
  e.location_id || e.intake_slug || 'unknown'

const who = (e: WebhookLogEvent) =>
  e.client_name || (e.jobber_item ? `Jobber #${e.jobber_item}` : 'Unknown record')

export function classifyDigestEvents(events: WebhookLogEvent[]) {
  const leadEvents = events.filter(e => e.topic === 'LEAD_INTAKE')
  const jobberEvents = events.filter(e => e.topic !== 'LEAD_INTAKE')

  // ── leads ──────────────────────────────────────────────────
  const landedByLocation = new Map<string, number>()
  const leadFailures: LeadFailure[] = []
  for (const e of leadEvents) {
    if (e.processed) {
      const slug = leadSlug(e)
      landedByLocation.set(slug, (landedByLocation.get(slug) || 0) + 1)
    } else {
      leadFailures.push({
        slug: leadSlug(e),
        reason: e.reason || e.error || 'unknown error',
      })
    }
  }
  let leadsLanded = 0
  landedByLocation.forEach(n => { leadsLanded += n })
  const locOtherLeads = landedByLocation.get(LOC_OTHER_SLUG) || 0
  const locOtherSpike =
    leadsLanded >= LOC_OTHER_SPIKE_FLOOR &&
    locOtherLeads / leadsLanded > LOC_OTHER_SPIKE_RATIO

  // ── jobber self-heal pairing ───────────────────────────────
  // Walk ascending so a failure is only ever paired with a LATER success.
  const asc = [...jobberEvents].sort((a, b) => ts(a) - ts(b))
  const successesByKey = new Map<string, { e: WebhookLogEvent; used: boolean }[]>()
  for (const e of asc) {
    if (e.processed && e.landed !== 'stuck') {
      const key = entityKey(e)
      const list = successesByKey.get(key) || []
      list.push({ e, used: false })
      successesByKey.set(key, list)
    }
  }
  const consumedSuccess = new Set<WebhookLogEvent>()
  const consumedFailure = new Set<WebhookLogEvent>()
  const selfHeals: SelfHeal[] = []
  for (const e of asc) {
    if (e.processed || !isTokenErr(e)) continue
    const cands = successesByKey.get(entityKey(e)) || []
    const heal = cands.find(
      c => !c.used && ts(c.e) > ts(e) && ts(c.e) - ts(e) <= SELF_HEAL_WINDOW_MS,
    )
    if (heal) {
      heal.used = true
      consumedSuccess.add(heal.e)
      consumedFailure.add(e)
      selfHeals.push({ location: locName(e), topic: e.topic || 'UNKNOWN' })
    }
  }

  // ── jobber landed / didn't-land ────────────────────────────
  let jobberLanded = 0
  const jobberProblems: JobberProblem[] = []
  for (const e of jobberEvents) {
    if (e.processed && e.landed !== 'stuck') {
      if (!consumedSuccess.has(e)) jobberLanded += 1
    } else if (!e.processed) {
      if (consumedFailure.has(e)) continue // self-healed — not a problem
      jobberProblems.push({
        location: locName(e),
        who: who(e),
        friendly: e.friendly,
        topic: e.topic || 'UNKNOWN',
        reason: e.reason || e.error || 'unknown error',
        tokenExpired: isTokenErr(e), // reauth with no heal = genuine expiry
      })
    } else {
      // processed but landed === 'stuck' → didn't reach its intended state
      jobberProblems.push({
        location: locName(e),
        who: who(e),
        friendly: e.friendly,
        topic: e.topic || 'UNKNOWN',
        reason: "processed but didn't land",
        tokenExpired: false,
      })
    }
  }

  return {
    leadsLanded,
    landedByLocation,
    leadFailures,
    locOtherLeads,
    locOtherSpike,
    jobberLanded,
    jobberProblems,
    selfHeals,
  }
}

// ── formatting ────────────────────────────────────────────────

const plural = (n: number, s: string) => `${n} ${s}${n !== 1 ? 's' : ''}`

export function buildWebhookDigest(opts: {
  events: WebhookLogEvent[]
  appUrl: string          // e.g. https://app.example.com (no trailing slash)
  windowLabel?: string    // human label for the query window
  importHealth?: ImportHealthInput   // import pipeline health (item 2/3)
  rateHealth?: RateHealthDigestInput // blank-rate hold rollup (lib/rate-health)
  bookingLinkHealth?: BookingLinkHealthDigestInput // missing-link hold rollup (lib/booking-link-health)
}): WebhookDigest {
  const { appUrl } = opts
  const windowLabel = opts.windowLabel || 'last 3h'
  const c = classifyDigestEvents(opts.events)

  const leadsFailed = c.leadFailures.length
  const jobberDidntLand = c.jobberProblems.length

  const imp = buildImportHealthSection(opts.importHealth, windowLabel)
  const rate = buildRateHealthSection(opts.rateHealth)
  const booking = buildBookingLinkHealthSection(opts.bookingLinkHealth)

  const realProblems =
    leadsFailed + jobberDidntLand +
    (imp.hasProblems ? 1 : 0) + (rate.hasProblems ? 1 : 0) + (booking.hasProblems ? 1 : 0)
  const allClear = realProblems === 0

  // Suppress a quiet window OR a self-heal-only window: nothing landed and
  // nothing failed. Self-heal rows are consumed above, so a window whose
  // only activity was self-heals has zero landed + zero failed here. An import
  // PROBLEM un-suppresses even when webhooks are quiet — but a healthy import
  // window contributes nothing (imp.hasProblems is false), so success is silent.
  const suppressed =
    c.leadsLanded === 0 &&
    leadsFailed === 0 &&
    c.jobberLanded === 0 &&
    jobberDidntLand === 0 &&
    !imp.hasProblems &&
    !rate.hasProblems &&
    !booking.hasProblems

  // ── headline (real problems only) ──────────────────────────
  let headline: string
  if (allClear) {
    headline =
      `:white_check_mark: Leads healthy — ${c.leadsLanded} in, 0 didn't land` +
      ` · Jobber: ${c.jobberLanded} landed`
  } else {
    const parts: string[] = []
    if (leadsFailed > 0) parts.push(`${plural(leadsFailed, 'lead')} DIDN'T LAND`)
    if (jobberDidntLand > 0) parts.push(`${plural(jobberDidntLand, 'Jobber event')} DIDN'T LAND`)
    if (imp.originGated) parts.push(`import origin SSO-GATED`)
    if (imp.failedCount > 0) parts.push(`${plural(imp.failedCount, 'import')} FAILED`)
    if (imp.stalledCount > 0) parts.push(`${plural(imp.stalledCount, 'import')} STALLED`)
    if (rate.missingCount > 0) parts.push(`${plural(rate.missingCount, 'location')} on rate-quoting paths with NO RATE (sends held)`)
    if (booking.missingCount > 0) parts.push(`${plural(booking.missingCount, 'location')} on booking paths with NO LINK (sends held)`)
    headline = `:warning: ${parts.join(' + ')} — check`
  }

  // ── leads section ──────────────────────────────────────────
  const leadLines: string[] = [`*:inbox_tray: Lead intake* (${windowLabel})`]
  if (c.leadsLanded === 0) {
    leadLines.push('• 0 landed')
  } else {
    const byLoc = Array.from(c.landedByLocation.entries()).sort((a, b) => b[1] - a[1])
    const parts = byLoc.map(([slug, n]) => {
      if (slug === LOC_OTHER_SLUG) {
        return c.locOtherSpike
          ? `${slug} ×${n} :warning: spike (${Math.round((n / c.leadsLanded) * 100)}% of leads)`
          : `${slug} ×${n} (normal)`
      }
      return `${slug} ×${n}`
    })
    leadLines.push(`• ${c.leadsLanded} landed — ${parts.join(', ')}`)
  }
  if (leadsFailed > 0) {
    leadLines.push(`• :warning: ${leadsFailed} didn't land:`)
    for (const f of c.leadFailures.slice(0, MAX_LEAD_FAIL_LINES)) {
      leadLines.push(`    • ${f.slug} — ${f.reason}`)
    }
    const more = leadsFailed - MAX_LEAD_FAIL_LINES
    if (more > 0) leadLines.push(`    _…plus ${more} more_`)
  }

  // ── jobber section ─────────────────────────────────────────
  const jobberLines: string[] = [
    `*:wrench: Jobber sync* (${windowLabel})`,
    `• ${c.jobberLanded} landed, ${jobberDidntLand} didn't land`,
  ]
  if (jobberDidntLand > 0) {
    for (const p of c.jobberProblems.slice(0, MAX_JOBBER_PROBLEM_LINES)) {
      const tail = p.tokenExpired
        ? `${p.reason} :key: token expired — reconnect`
        : p.reason
      jobberLines.push(`    • ${p.location}: ${p.who} — ${p.friendly} (${p.topic}): ${tail}`)
    }
    const more = jobberDidntLand - MAX_JOBBER_PROBLEM_LINES
    if (more > 0) jobberLines.push(`    _…plus ${more} more_`)
  }
  if (c.selfHeals.length > 0) {
    // Name the locations once each, with a count if a location repeated.
    const byLoc = new Map<string, number>()
    for (const s of c.selfHeals) byLoc.set(s.location, (byLoc.get(s.location) || 0) + 1)
    const names = Array.from(byLoc.entries())
      .map(([loc, n]) => (n > 1 ? `${loc} ×${n}` : loc))
      .join(', ')
    jobberLines.push(
      `• :recycle: ${plural(c.selfHeals.length, 'token self-heal')} — ${names} (expected, no action)`,
    )
  }

  // Deep link into the admin Webhooks tab, pre-filtered to failures when
  // there are any (else the didn't-land bucket).
  const filter = jobberDidntLand > 0 ? 'failures' : 'stuck'
  const link = `${appUrl}/admin?adminTab=webhooks&whFilter=${filter}&whWindow=24h`

  // Import section only appears when there's an import problem to act on.
  const importBlock = imp.lines.length ? `${imp.lines.join('\n')}\n\n` : ''
  // Same rule for the blank-rate section: healthy → invisible.
  const rateBlock = rate.lines.length ? `${rate.lines.join('\n')}\n\n` : ''
  // Same rule for the missing-booking-link section: healthy → invisible.
  const bookingBlock = booking.lines.length ? `${booking.lines.join('\n')}\n\n` : ''

  const text =
    `${headline}\n\n` +
    `${leadLines.join('\n')}\n\n` +
    `${jobberLines.join('\n')}\n\n` +
    importBlock +
    rateBlock +
    bookingBlock +
    `<${link}|Open the webhook dashboard>`

  return {
    suppressed,
    allClear,
    headline,
    leadsLanded: c.leadsLanded,
    leadsFailed,
    jobberLanded: c.jobberLanded,
    jobberDidntLand,
    selfHeals: c.selfHeals.length,
    locOtherLeads: c.locOtherLeads,
    locOtherSpike: c.locOtherSpike,
    importFailed: imp.failedCount,
    importStalled: imp.stalledCount,
    importOriginGated: imp.originGated,
    rateMissing: rate.missingCount,
    bookingLinkMissing: booking.missingCount,
    text,
  }
}
