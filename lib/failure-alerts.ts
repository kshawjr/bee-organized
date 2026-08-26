// lib/failure-alerts.ts
// ─────────────────────────────────────────────────────────────
// Instant failure alerts (issue 159). The webhook digest is now once daily;
// this is the real-time channel. app/api/cron/failure-alerts runs every
// ~5 min, and this module decides what — if anything — to post to Slack.
//
// ALLOWLIST, not a denylist. We alert on exactly seven hard, actionable
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
//   5. a STRANDED CHECKOUT (issue 312) — an owner completed Stripe checkout,
//      the session came back unpaid, and STRANDED_CHECKOUT_MS later their
//      location still is not active. See the window note below.
//   6. a SLACK LEAD ALERT that failed to post (notification_log channel=slack
//      send_status=failed). Nothing retries a Slack post, so every one of
//      these is a lead a team permanently never heard about — the Aug 2026
//      audit found 18 channel_not_found failures across 7 locations in 30
//      days (5 at Portland alone) that surfaced to no one. First failure
//      alerts; the watermark makes each row alert exactly once, and one line
//      per location per window keeps a busy channel from flooding the post.
//   7. an EMAIL HELD for a BLANK SUBJECT (issue 316) that has stayed held for
//      HELD_SUBJECT_ALERT_MS — the hold itself is correct (better held than
//      "(no subject)" in a client's inbox) and self-clears the moment a
//      subject is saved, so a fresh hold is NOT an incident: the owner may be
//      mid-edit, and the lead badge / cron counters already show it. A hold
//      still uncleared 6 hours after the send came due means nobody noticed —
//      that is the silent gap this alerts on. Same alert-moment windowing as
//      the stranded checkout (due_at + HELD_SUBJECT_ALERT_MS through the
//      (since, cutoff] watermark), so each held send alerts exactly once.
//
// THE STRANDED-CHECKOUT WINDOW — 90 minutes, and why not days.
//
// The obvious reasoning is that an ACH debit legitimately takes 3-5 days, so
// a short window would page on every bank payer. Measured against the three
// pending checkouts prod has ever recorded, that reasoning is wrong, because
// it watches the wrong clock. The bank clears on its own schedule; the OWNER's
// clock is how long they cannot get into Bee Hub, and those are not the same
// number. Both real ACH payers were let in almost immediately and the money
// arrived six days later:
//
//   loc_bostonsuburbs  pending 13:36:43 → ACTIVE 13:50:42  (14 min)
//                      …ACH actually cleared 5.99 days later
//   loc_westraleigh    pending 17:08:59 → ACTIVE 17:10:35  (96 sec)
//                      …ACH actually cleared 5.80 days later
//   loc_centralaustin  pending 14:12:39 → ACTIVE 15:10:44  (58 min)  ← the strand
//
// So the resolution signal is ACTIVATION, not settlement. Keying on activation
// means the two bank payers never alert at ANY window — they were never locked
// out — and the window is free to be short enough to reach a person who still
// has the tab open. 90 minutes clears the observed maximum (58 min) with room,
// and the cron's 5-min cadence plus 5-min settle puts the alert in Slack about
// 100 minutes after checkout, while the owner is still in the session.
//
// A bank payer that nobody force-activates IS locked out and DOES alert — that
// is correct, not a false positive: it is the same alert Kevin already acts on
// by force-activating, and it fires exactly once per session, never repeats.
//
// DELIBERATELY EXCLUDED (would drown the useful signal):
//   • raw sync_log status='error' — overwhelmingly self-healing webhook
//     token-race transients (135/30d). Only a genuine, un-healed expiry (3)
//     or a recorded not_landed (1) gets through.
//   • notification_log EMAIL send_status='failed' — hourly-retried transients
//     capped by the drip auto-stop (#73), historically dominated by fake test
//     leads (294/7d at the issue-159 audit). The ONE notification_log slice
//     this module reads is channel='slack' + send_status='failed' (kind 6
//     above — real, never-retried, and no longer test noise: every failed
//     Slack row in the Aug 2026 audit was a genuine channel_not_found);
//     email rows stay excluded.
//   • email holds for a missing RATE or BOOKING LINK — same hold mechanics as
//     the subject hold, but those gaps are owner content choices with their
//     own digest sections; only the subject hold has shipped a client-visible
//     incident (July 2026 "(no subject)"), so only it earns the instant rail.
//   • a subject hold YOUNGER than HELD_SUBJECT_ALERT_MS — mid-edit, already
//     visible on the lead badge and cron counters. See kind 7.
//   • the Slack TEST button (app/api/locations/[id]/slack-test) — its result
//     is shown to the clicking owner in the UI and is deliberately never
//     written to notification_log, so a failed test can't re-alert here.
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

export type AlertKind =
  | 'not_landed'
  | 'import_failed'
  | 'token_expired'
  | 'assessment_mismatch'
  | 'checkout_stranded'
  | 'slack_failed'
  | 'email_held'

// How long an owner may sit on an unpaid checkout before it is a strand.
// Measured, not guessed — see the window note in the module header.
export const STRANDED_CHECKOUT_MS = 90 * 60_000

// How long a blank-subject email hold may persist before it is an incident.
// The hold retries hourly and self-clears the moment a subject is saved, and
// the lead badge + cron counters make the first hours visible to anyone
// looking — 6h is the line between "someone is editing" and "nobody noticed",
// while still surfacing same-day (the failures that motivated this sat silent
// for 4 days). ~6 retry ticks have happened by the time this fires.
export const HELD_SUBJECT_ALERT_MS = 6 * 60 * 60_000

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

// Raw sync_log "awaiting async payment" row (fetchPendingCheckouts). entity_id
// is the Stripe checkout session id; location_id is the slug — null on rows
// written before issue 312 taught the webhook to record it.
export type PendingCheckoutRow = {
  created_at?: string | null
  entity_id?: string | null
  location_id?: string | null
}

// slug → the one billing fact the strand check needs: is the owner in?
export type LocationBillingState = { status: string | null }

// Raw notification_log Slack failure row (fetchSlackSendFailures).
export type SlackFailureRow = {
  location_slug?: string | null
  lead_name?: string | null
  error?: string | null
  created_at?: string | null
}

// A send currently held for a blank subject (fetchHeldSubjectEmails). due_at
// is when the send became DUE — the queue timestamp the hold freezes (drip
// next_send_at / welcome_email_scheduled_at / stage send_at) — and is the
// anchor the once-only alert-moment windowing keys on.
export type HeldEmailSource = 'drip' | 'welcome' | 'stage'
export type HeldSubjectEmailRow = {
  source: HeldEmailSource
  lead_name?: string | null
  location_uuid?: string | null
  due_at?: string | null
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

// "58 min" / "1h 30m" / "3 days" — the alert leads with how long the person
// has been waiting, so the reader feels the wait before reading the cause.
const ageLabel = (ms: number) => {
  const mins = Math.max(1, Math.round(ms / 60_000))
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days} day${days > 1 ? 's' : ''}`
}

// Stripe session ids are 66 chars; enough of one to find it in the dashboard.
const sessionShort = (id: string | null | undefined) =>
  id ? `${id.slice(0, 22)}…` : 'unknown session'

// Slack error code → what Kevin can actually do about it. Every failure in
// the Aug 2026 audit was channel_not_found (owners picking a private channel
// on Slack's own OAuth screen — the bot is never in it); the rest are the
// codes the per-location bot transport already logs distinctly. Unknown
// codes pass through raw. (This module only READS the logged rows — it never
// touches the bot transport itself; a 312-era pin enforces that.)
const slackFailureHint = (error: string | null | undefined): string => {
  switch (error) {
    case 'channel_not_found':
      return "Slack can't see the channel (likely private — the owner must invite the Bee Hub app to it, or reconnect to a public channel)"
    case 'not_in_channel':
      return 'the bot is not in the channel — the owner must invite it in Slack'
    case 'is_archived':
      return 'the channel is archived — the owner must reconnect to a live one'
    case 'invalid_auth':
    case 'token_revoked':
    case 'account_inactive':
      return 'the Slack connection is dead — the owner must reconnect'
    default:
      return clean(error || 'unknown Slack error', 80)
  }
}

// ── the pure selector ──────────────────────────────────────────────
// Given the raw sources already fetched for the run, return the alert lines
// that are BOTH allowlisted AND newly-committed in (sinceMs, cutoffMs]. Pure:
// no Supabase, no Slack — the unit-test surface for windowing + allowlist.
export function selectNewAlerts(input: {
  events: WebhookLogEvent[]        // enriched inbound webhook events
  importFailed: ImportFailedRow[]  // import_jobs status='failed' rows
  mismatches: MismatchRow[]        // sync_log ASSESSMENT_TEAM_MISMATCH rows
  locName: Map<string, string>     // slug → display name
  // issue 312 — optional so every pre-312 caller and test is unchanged.
  pendingCheckouts?: PendingCheckoutRow[]           // sync_log awaiting-async rows
  locBilling?: Map<string, LocationBillingState>    // slug → subscription state
  resolvedSessions?: Set<string>                    // sessions with a later terminal row
  // silent-sends rail — optional for the same every-prior-caller reason.
  slackFailures?: SlackFailureRow[]                 // notification_log slack failed rows
  heldEmails?: HeldSubjectEmailRow[]                // sends held for a blank subject
  locNameByUuid?: Map<string, string>               // locations.id (uuid) → display name
  sinceMs: number
  cutoffMs: number                 // = nowMs - ALERT_SETTLE_MS
  nowMs: number
}): AlertItem[] {
  const {
    events, importFailed, mismatches, locName, sinceMs, cutoffMs, nowMs,
    pendingCheckouts = [], locBilling, resolvedSessions,
    slackFailures = [], heldEmails = [], locNameByUuid,
  } = input
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

  // (5) stranded checkout (issue 312) — an owner paid and never got in.
  //
  // The alert moment is NOT when the row was written, it is when the row went
  // stale: created_at + STRANDED_CHECKOUT_MS. Windowing that derived instant
  // through the same (since, cutoff] watermark the other four kinds use means
  // a strand is evaluated in exactly one run and alerted exactly once, even
  // though the row itself is 90 minutes older than the window it fires in.
  for (const pc of pendingCheckouts) {
    const createdMs = Date.parse(pc.created_at || '')
    if (!Number.isFinite(createdMs)) continue
    if (!inWindow(createdMs + STRANDED_CHECKOUT_MS, sinceMs, cutoffMs)) continue

    // Settled: a later non-pending sync_log row for this same checkout session
    // (async_payment_succeeded, or the async_payment_failed path — which runs
    // its own louder alert, so adding a strand line would double-ping).
    if (pc.entity_id && resolvedSessions?.has(pc.entity_id)) continue

    // Let in: the location is active by ANY route — the async payment cleared,
    // a retry on a different session worked, or Kevin force-activated. This is
    // the check that keeps genuine ACH payers quiet: both of prod's real bank
    // payers were active within 14 minutes while their money took six days.
    const slug = pc.location_id || null
    if (slug && locBilling?.get(slug)?.status === 'active') continue

    // A pending row with no location is either pre-312 (the webhook did not
    // record one yet) or a session that arrived without a client_reference_id.
    // Either way we cannot name the owner from the row — so say that plainly
    // and point at the one place that can, rather than guessing.
    const who = slug ? locLabel(slug, locName) : 'an unidentified location'
    items.push({
      kind: 'checkout_stranded',
      ts: createdMs + STRANDED_CHECKOUT_MS,
      text:
        `Owner stuck at checkout — ${who}: they completed checkout ${ageLabel(nowMs - createdMs)} ago ` +
        `and still cannot get in. Stripe never confirmed the payment, so activation ` +
        `never ran and they are watching a spinner. Session ${sessionShort(pc.entity_id)}` +
        (slug ? '' : ' — open it in Stripe to see who'),
    })
  }

  // (6) Slack lead alert failed — one line per LOCATION per window, carrying
  // the count: five leads into a dead Portland channel is one problem, not
  // five, and the fix (invite the bot / reconnect) is per-location. Rows are
  // windowed on created_at like every immediate kind; the group's ts is its
  // latest row so ordering stays stable.
  const slackByLoc = new Map<string, { n: number; ts: number; lead: string | null; error: string | null }>()
  for (const f of slackFailures) {
    const t = Date.parse(f.created_at || '')
    if (!inWindow(t, sinceMs, cutoffMs)) continue
    const key = f.location_slug || ''
    const g = slackByLoc.get(key) ?? { n: 0, ts: t, lead: null, error: null }
    g.n++
    if (t >= g.ts) {
      g.ts = t
      g.lead = f.lead_name ?? g.lead
      g.error = f.error ?? g.error
    }
    slackByLoc.set(key, g)
  }
  for (const [slug, g] of Array.from(slackByLoc.entries())) {
    const who =
      g.n === 1
        ? `${clean(g.lead || 'a lead', 60)}'s lead alert never posted`
        : `${g.n} lead alerts never posted`
    items.push({
      kind: 'slack_failed',
      ts: g.ts,
      text: `Slack alert failed — ${locLabel(slug || null, locName)}: ${who} — ${slackFailureHint(g.error)}`,
    })
  }

  // (7) email held for a blank subject — alert-moment windowing, exactly the
  // stranded-checkout idiom: the moment is due_at + HELD_SUBJECT_ALERT_MS,
  // evaluated in the one run whose (since, cutoff] contains it. The fetcher
  // only returns sends that are STILL held at fetch time, so a subject fixed
  // at hour 5 never reaches here.
  for (const held of heldEmails) {
    const dueMs = Date.parse(held.due_at || '')
    if (!Number.isFinite(dueMs)) continue
    if (!inWindow(dueMs + HELD_SUBJECT_ALERT_MS, sinceMs, cutoffMs)) continue
    const who = clean(held.lead_name || 'a lead', 60)
    const loc = (held.location_uuid && locNameByUuid?.get(held.location_uuid)) || 'Unknown account'
    items.push({
      kind: 'email_held',
      ts: dueMs + HELD_SUBJECT_ALERT_MS,
      text:
        `Email held ${ageLabel(nowMs - dueMs)} — ${loc}: ${who}'s ${held.source} email has a ` +
        `blank subject — it releases itself the moment a subject is saved on the template or step`,
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
  checkout_stranded: ':hourglass_flowing_sand:',
  slack_failed: ':no_bell:',
  email_held: ':envelope:',
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

// Pending checkouts whose STRAND MOMENT falls in this run's window. The row
// is written at checkout; it becomes an alert STRANDED_CHECKOUT_MS later, so
// the rows to consider are the ones created one strand-window EARLIER than
// the window being evaluated. That shift lives here, in one place, so the
// selector can stay pure and the bounds stay assertable.
export async function fetchPendingCheckouts(
  supabase: typeof supabaseService,
  sinceMs: number,
  cutoffMs: number,
): Promise<PendingCheckoutRow[]> {
  const { data } = await supabase
    .from('sync_log')
    .select('created_at, entity_id, location_id')
    .eq('entity_type', 'payment')
    .ilike('message', '%awaiting async payment%')
    .gt('created_at', new Date(sinceMs - STRANDED_CHECKOUT_MS).toISOString())
    .lte('created_at', new Date(cutoffMs - STRANDED_CHECKOUT_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(50)
  return (data as PendingCheckoutRow[]) ?? []
}

// Which of those sessions have since reached a terminal STRIPE_PAYMENT row.
//
// "Later" is enforced on the CLOCK, not on the message text. Excluding the
// seed row by its wording alone would make this query depend on the pending
// row's phrasing to avoid resolving itself — a loop where one copy edit in
// the webhook silently switches the whole alert off. A resolution is a row
// for the same session written strictly AFTER the pending one; the wording
// check stays as a second, independent guard.
//
// Filtered in JS rather than with a negated ilike: the candidate set is tiny
// (prod has written three pending rows ever), and the ordering rule is
// clearer read as code than as a PostgREST negation.
export async function fetchCheckoutResolutions(
  supabase: typeof supabaseService,
  pending: PendingCheckoutRow[],
): Promise<Set<string>> {
  const resolved = new Set<string>()

  // session id → when its pending row was written (earliest, if somehow two).
  const pendingAt = new Map<string, number>()
  for (const p of pending) {
    const id = p.entity_id
    const t = Date.parse(p.created_at || '')
    if (!id || !Number.isFinite(t)) continue
    pendingAt.set(id, Math.min(pendingAt.get(id) ?? Infinity, t))
  }
  if (pendingAt.size === 0) return resolved

  const { data } = await supabase
    .from('sync_log')
    .select('entity_id, created_at, message')
    .eq('entity_type', 'payment')
    .in('entity_id', Array.from(pendingAt.keys()))
    .limit(200)

  for (const r of (data as any[]) || []) {
    const id = r?.entity_id
    if (!id) continue
    const seeded = pendingAt.get(id)
    if (seeded == null) continue
    const t = Date.parse(r.created_at || '')
    if (!Number.isFinite(t) || t <= seeded) continue
    if (/awaiting async payment/i.test(r.message || '')) continue
    resolved.add(id)
  }
  return resolved
}

// The one notification_log slice this module reads: Slack lead alerts that
// FAILED. Scoped hard on channel + send_status by design — email failures,
// skips, and mutes must never reach the rail (see the exclusion note in the
// header). Windowed on created_at like the other immediate sources.
export async function fetchSlackSendFailures(
  supabase: typeof supabaseService,
  sinceIso: string,
  cutoffIso: string,
): Promise<SlackFailureRow[]> {
  const { data } = await supabase
    .from('notification_log')
    .select('location_slug, lead_name, error, created_at')
    .eq('channel', 'slack')
    .eq('send_status', 'failed')
    .gt('created_at', sinceIso)
    .lte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(50)
  return (data as SlackFailureRow[]) ?? []
}

// Sends currently HELD for a blank subject whose ALERT MOMENT
// (due_at + HELD_SUBJECT_ALERT_MS) falls in this run's window — the same
// shifted-window trick as fetchPendingCheckouts, so the selector stays pure
// and each held send is evaluated in exactly one run.
//
// Three queues, two detection routes:
//   • DRIP — authoritative: the sender itself wrote the hold verdict onto the
//     lead (recordDripSendStatus, 'Email subject is blank — …'), so a lead
//     whose latest attempt held for ANY OTHER reason (rate, booking link)
//     never matches. This route also catches a subject that merely RENDERS
//     to blank, because the sender judged the rendered value.
//   • WELCOME / STAGE — those senders record nothing per-row (console.warn
//     only), so held-for-subject is re-derived from the template chain using
//     the sender's own resolution rule: fork?.subject ?? master.subject
//     (lib/template-fork's rule, inlined here because that module binds the
//     global service client and this one keeps supabase injectable). RAW
//     subject only — a subject that is non-blank but renders to nothing is
//     the drip route's catch, not this one's; the residual gap is a
//     tag-only welcome/stage subject, which no template in prod has.
// An overdue row whose subject is real (cron outage, other hold) never
// matches either route — this alert is about subjects, not backlogs.
export async function fetchHeldSubjectEmails(
  supabase: typeof supabaseService,
  sinceMs: number,
  cutoffMs: number,
): Promise<HeldSubjectEmailRow[]> {
  const loIso = new Date(sinceMs - HELD_SUBJECT_ALERT_MS).toISOString()
  const hiIso = new Date(cutoffMs - HELD_SUBJECT_ALERT_MS).toISOString()
  const out: HeldSubjectEmailRow[] = []

  // (a) drip — active progress rows still frozen at a due time one hold-window
  // back, joined to the sender's own held-for-subject verdict on the lead.
  const { data: prog } = await supabase
    .from('lead_drip_progress')
    .select('lead_id, next_send_at')
    .is('paused_at', null)
    .is('stopped_at', null)
    .is('completed_at', null)
    .gt('next_send_at', loIso)
    .lte('next_send_at', hiIso)
    .limit(50)
  const progRows = (prog as any[]) ?? []
  if (progRows.length) {
    const leadIds = Array.from(new Set(progRows.map((p) => p.lead_id).filter(Boolean)))
    const { data: heldLeads } = await supabase
      .from('leads')
      .select('id, name, location_uuid')
      .in('id', leadIds)
      .eq('drip_last_send_status', 'failed')
      .ilike('drip_last_send_error', '%subject is blank%')
    const leadById = new Map(((heldLeads as any[]) ?? []).map((l) => [l.id, l]))
    for (const p of progRows) {
      const lead = leadById.get(p.lead_id)
      if (!lead) continue
      out.push({
        source: 'drip',
        lead_name: lead.name ?? null,
        location_uuid: lead.location_uuid ?? null,
        due_at: p.next_send_at ?? null,
      })
    }
  }

  // (b) welcome — pending, unpaused, due one hold-window back. (The welcome
  // writer is retired per issue 314, so this queue is normally empty — the
  // sender stays wired for straggler rows, and so does this.)
  const { data: wl } = await supabase
    .from('leads')
    .select('id, name, location_uuid, welcome_email_scheduled_at')
    .gt('welcome_email_scheduled_at', loIso)
    .lte('welcome_email_scheduled_at', hiIso)
    .is('welcome_email_sent_at', null)
    .eq('paused', false)
    .limit(50)
  const welcomeRows = (wl as any[]) ?? []

  // (c) stage — pending scheduled rows due one hold-window back.
  const { data: st } = await supabase
    .from('scheduled_stage_emails')
    .select('lead_id, stage_email_key, send_at')
    .gt('send_at', loIso)
    .lte('send_at', hiIso)
    .is('sent_at', null)
    .is('cancelled_at', null)
    .limit(50)
  const stageRows = (st as any[]) ?? []

  if (!welcomeRows.length && !stageRows.length) return out

  // Stage rows carry only lead_id; the lead supplies name + location.
  let stageLeadById = new Map<string, any>()
  if (stageRows.length) {
    const ids = Array.from(new Set(stageRows.map((r) => r.lead_id).filter(Boolean)))
    const { data } = await supabase.from('leads').select('id, name, location_uuid').in('id', ids)
    stageLeadById = new Map(((data as any[]) ?? []).map((l) => [l.id, l]))
  }

  // Masters for every key in play ('welcome' + the stage keys)…
  const keys = Array.from(
    new Set([
      ...(welcomeRows.length ? ['welcome'] : []),
      ...stageRows.map((r) => r.stage_email_key).filter(Boolean),
    ]),
  )
  const { data: mastersData } = await supabase
    .from('templates')
    .select('id, legacy_id, subject')
    .in('legacy_id', keys)
    .is('location_uuid', null)
  const masterByKey = new Map(((mastersData as any[]) ?? []).map((m) => [m.legacy_id, m]))

  // …and every ACTIVE fork for the (master, location) pairs in play, newest
  // updated_at winning — lib/template-fork's rule, batched into one read.
  const masterIds = Array.from(new Set(Array.from(masterByKey.values()).map((m) => m.id)))
  const locUuids = Array.from(
    new Set(
      [
        ...welcomeRows.map((r) => r.location_uuid),
        ...Array.from(stageLeadById.values()).map((l) => l.location_uuid),
      ].filter(Boolean),
    ),
  )
  const forkSubject = new Map<string, string | null>() // `${masterId}:${locUuid}` → fork subject
  if (masterIds.length && locUuids.length) {
    const { data: forks } = await supabase
      .from('templates')
      .select('cloned_from_id, location_uuid, subject, updated_at')
      .in('cloned_from_id', masterIds)
      .in('location_uuid', locUuids)
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
    for (const f of (forks as any[]) ?? []) {
      const key = `${f.cloned_from_id}:${f.location_uuid}`
      if (!forkSubject.has(key)) forkSubject.set(key, f.subject ?? null)
    }
  }

  // The sender's exact rule: fork?.subject ?? master.subject. A missing master
  // is a template_lookup ERROR at send time, not a subject hold — skipped.
  const resolvedRawSubject = (legacyId: string, locUuid: string | null): string | null => {
    const master = masterByKey.get(legacyId)
    if (!master) return null
    const fork = locUuid != null ? forkSubject.get(`${master.id}:${locUuid}`) : undefined
    return fork ?? master.subject ?? null
  }

  for (const r of welcomeRows) {
    if (!masterByKey.has('welcome')) continue
    const s = resolvedRawSubject('welcome', r.location_uuid ?? null)
    if (s && s.trim()) continue
    out.push({
      source: 'welcome',
      lead_name: r.name ?? null,
      location_uuid: r.location_uuid ?? null,
      due_at: r.welcome_email_scheduled_at ?? null,
    })
  }
  for (const r of stageRows) {
    if (!masterByKey.has(r.stage_email_key)) continue
    const lead = stageLeadById.get(r.lead_id)
    const locUuid = lead?.location_uuid ?? null
    const s = resolvedRawSubject(r.stage_email_key, locUuid)
    if (s && s.trim()) continue
    out.push({
      source: 'stage',
      lead_name: lead?.name ?? null,
      location_uuid: locUuid,
      due_at: r.send_at ?? null,
    })
  }
  return out
}

// One locations read, three maps: the slug-keyed display names every alert
// kind uses, the uuid-keyed names the held-email lines need (leads carry
// location_uuid, not the slug), and the subscription state the strand check
// needs.
async function fetchLocationDirectory(supabase: typeof supabaseService): Promise<{
  names: Map<string, string>
  namesByUuid: Map<string, string>
  billing: Map<string, LocationBillingState>
}> {
  const { data } = await supabase.from('locations').select('id, location_id, name, subscription_status')
  const names = new Map<string, string>()
  const namesByUuid = new Map<string, string>()
  const billing = new Map<string, LocationBillingState>()
  for (const l of (data as any[]) || []) {
    names.set(l.location_id, l.name || l.location_id)
    if (l.id) namesByUuid.set(l.id, l.name || l.location_id)
    billing.set(l.location_id, { status: l.subscription_status ?? null })
  }
  return { names, namesByUuid, billing }
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
  const [{ events }, importFailed, mismatches, directory, pendingCheckouts, slackFailures, heldEmails] =
    await Promise.all([
      fetchEvents({ window: '24h' }),
      fetchImportFailures(supabase, sinceIso, cutoffIso),
      fetchAssessmentMismatches(supabase, sinceIso, cutoffIso),
      fetchLocationDirectory(supabase),
      fetchPendingCheckouts(supabase, opts.sinceMs, cutoffMs),
      fetchSlackSendFailures(supabase, sinceIso, cutoffIso),
      fetchHeldSubjectEmails(supabase, opts.sinceMs, cutoffMs),
    ])

  // Second hop, and only when there is something to resolve: which of the
  // candidate sessions already reached a terminal row.
  const resolvedSessions = await fetchCheckoutResolutions(supabase, pendingCheckouts)

  const items = selectNewAlerts({
    events,
    importFailed,
    mismatches,
    locName: directory.names,
    pendingCheckouts,
    locBilling: directory.billing,
    resolvedSessions,
    slackFailures,
    heldEmails,
    locNameByUuid: directory.namesByUuid,
    sinceMs: opts.sinceMs,
    cutoffMs,
    nowMs: opts.nowMs,
  })
  return { items, cutoffMs }
}
