// lib/failure-alerts.ts
// ─────────────────────────────────────────────────────────────
// Instant alerts. app/api/cron/failure-alerts runs every ~5 min, and this
// module decides what — if anything — to post to Kevin's ops channel.
//
// THE RULE (Sept 2026 rebuild): alert instantly on what only Kevin can fix,
// ONE MESSAGE PER PROBLEM. Batch what he should know about into the daily
// digest (lib/webhook-digest). Say nothing about what fixes itself or belongs
// to someone else. The rebuild was measured, not guessed — see the notes on
// each exclusion below.
//
// INSTANT (an allowlist — nothing else reaches this rail):
//   1. LEAD DIDN'T ARRIVE — a LEAD_INTAKE sync_log row that failed
//      (full_name required, location_slug required, location_not_found…).
//      That is Kevin's web form; nobody else can fix it, and the person who
//      filled it in is waiting on a reply that will never come.
//   2. OWNER REPORT — anything an owner files: a bug, a question, or a
//      feature idea (feedback_items, not internal). One message per report,
//      carrying who, where, the title, a trimmed description, the screen it
//      was filed from and the screenshot count — enough to judge urgency
//      without opening Bee Hub. See ownerReportText for the shape and why.
//   3. JOBBER RECONNECT REQUIRED — a location whose refresh token Jobber
//      rejected for good. lib/jobber performRefresh stamps
//      locations.last_sync_status 'RECONNECT REQUIRED — … @ <iso>' only after
//      the race-loss check (#102) finds no sibling rotated the token, so the
//      stamp IS the non-recovering case. One alert per stamp, keyed on the
//      stamp's own time (lib/jobber-reconnect); the next successful refresh
//      overwrites it.
//   4. IMPORT FAILED — import_jobs status='failed', excluding user cancels.
//   5. ASSESSMENT_TEAM_MISMATCH — the send landed, the team didn't apply.
//   6. STRANDED CHECKOUT (issue 312) — see the window note below.
//   7. EMAIL HELD ≥ HELD_SUBJECT_ALERT_MS FOR A BLANK SUBJECT (issue 316).
// (Stripe payment failures post instantly from app/api/webhooks/stripe
//  itself, one message each — they never needed this rail.)
//
// NEVER, deliberately:
//   • INDIVIDUAL TOKEN FAILURES. Measured over 7 days to 2026-09-26: 33
//     no_valid_jobber_token failures, 31 back within ~1 second; the location
//     was working again within a second EVERY time. The old per-record
//     self-heal check (same topic + same Jobber item within 5 min) missed the
//     recovery whenever two failures shared one retry, the retry came under a
//     different topic, or it took 9m48s — and paged "token expired —
//     reconnect Jobber" 7 times that week for locations that were fine. The
//     only token state that does not recover is the RECONNECT REQUIRED stamp
//     (kind 3); that is the whole token signal now.
//   • SLACK LEAD-ALERT FAILURES (notification_log channel='slack' failed).
//     Every one is channel_not_found / not_in_channel on the OWNER's Slack;
//     the fix is theirs (invite the app, or reconnect), not Kevin's. The
//     Settings Slack card is where that surfaces.
//   • sync_log not_landed — moved to the daily digest as "never landed".
//     26 in 30 days, almost all PROPERTY_UPDATE former-address syncs; stuck,
//     not an emergency.
//   • raw status='error' transients, notification_log EMAIL failures,
//     rate/booking-link holds, subject holds younger than 6h, the Slack TEST
//     button, status='partial' — unchanged from issue 159.
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
// DEDUPE = a stored watermark (lib/alert-runs). Each run considers only rows
// whose alert moment is after the last watermark and at-or-before a settle
// cutoff of now-ALERT_SETTLE_MS, so every problem is evaluated in exactly one
// window → alerted once. Every item's `ts` IS that windowed moment, which is
// what lets the route advance the watermark item-by-item when a post fails
// part-way (watermarkAfterPosting).
// The selector and message builder are pure so the allowlist is unit-testable
// without Slack or Supabase.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { fetchWebhookLogEvents, type WebhookLogEvent } from './webhook-observability'
import { SELF_HEAL_WINDOW_MS } from './webhook-digest'
import { parseReconnectStamp } from './jobber-reconnect'

export { parseReconnectStamp }

// The watermark trails now() by this settle window so a row written a moment
// ago (and anything joined to it) has landed before we judge it.
export const ALERT_SETTLE_MS = SELF_HEAL_WINDOW_MS

// One message per problem — but a run that surfaces more than this many is an
// incident, not a list, and the rest go into one closing summary message
// rather than flooding the channel.
export const MAX_ALERT_MESSAGES = 10

export type AlertKind =
  | 'lead_failed'
  | 'owner_report'
  | 'reconnect_required'
  | 'import_failed'
  | 'assessment_mismatch'
  | 'checkout_stranded'
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
  ts: number       // ms — the windowed alert moment (ordering + watermark)
  text: string     // phone-readable text, no leading emoji (added at render)
  emoji?: string   // overrides the per-kind icon (owner reports: one per type)
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

// An owner-filed report (fetchOwnerReports). location_id is the
// locations.id uuid, not the slug. owner_name is resolved from hub_users by
// the fetcher; context is the id-only whitelist lib/feedback-context writes.
export type OwnerReportRow = {
  type?: string | null
  title?: string | null
  description?: string | null
  location_id?: string | null
  created_at?: string | null
  is_internal?: boolean | null
  attachments?: unknown[] | null
  context?: { screen?: string | null; origin?: string | null; kind?: string | null; stage?: string | null; lead_id?: string | null } | null
  owner_name?: string | null
}

// A location whose Jobber connection needs a human reconnect. stamped_at is
// parsed out of last_sync_status (parseReconnectStamp).
export type ReconnectRow = {
  location_id: string
  stamped_at: string
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

// The intake route writes the reason as `error=<code> <detail>`; say what the
// code means for the person who filled in the form, then keep the raw detail
// so Kevin can find the submission.
const leadFailureWhy = (reason: string): string => {
  if (/full_name required/i.test(reason)) return 'the form sent no name'
  if (/location_slug required/i.test(reason)) return 'the form sent no location'
  if (/location_not_found/i.test(reason)) return "the form's location matches no Bee Hub location"
  return 'the intake rejected it'
}

// ── owner report message ─────────────────────────────────────────
//
// WHAT KEVIN SEES, AND WHY. The old alerts were too thin to judge urgency
// from, so this errs toward detail — but stays a phone screen, not a wall:
//
//   :beetle: *BUG* — Jane Smith, Portland
//   *Calendar will not load*
//   > It spins forever when I open Tuesday. Two clients are booked …
//   Filed from Clients (on a client's Request-stage job) · 2 screenshots
//   <…/admin?adminTab=feedback|Open the Feedback list> — no link to a single report exists yet
//
//   • The TYPE leads, in capitals, with its own icon — a bug and an idea
//     must be told apart before reading a word.
//   • The description is cut at OWNER_REPORT_DESC_MAX (300) characters, on a
//     word boundary, with a visible "…" when cut. Measured on every report
//     filed so far: median 115 characters, 90th percentile 260, longest 509
//     — so 300 shows ~9 in 10 reports whole, and the cut ones still give the
//     gist. Line breaks are kept (up to 4 lines) because owners write steps.
//   • The link is the ADMIN Feedback list, labelled as the list. The admin
//     tab reads no per-report parameter, so pretending to deep-link would be
//     a lie. It must never be /?feedback=1: that is the OWNER's reply-email
//     link and now redirects to the owner's own Help › My requests page —
//     which is where this alert pointed until this fix.
export const OWNER_REPORT_DESC_MAX = 300
const OWNER_REPORT_DESC_LINES = 4
export const FEEDBACK_TRIAGE_PATH = '/admin?adminTab=feedback'

const REPORT_TYPE: Record<string, { label: string; emoji: string }> = {
  bug: { label: 'BUG', emoji: ':beetle:' },
  question: { label: 'QUESTION', emoji: ':question:' },
  feature: { label: 'IDEA', emoji: ':bulb:' },
}

export function trimDescription(raw: string | null | undefined, max = OWNER_REPORT_DESC_MAX): string {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  let text = lines.slice(0, OWNER_REPORT_DESC_LINES).join('\n')
  let cut = lines.length > OWNER_REPORT_DESC_LINES
  if (text.length > max) {
    const hard = text.slice(0, max)
    const soft = hard.slice(0, Math.max(hard.lastIndexOf(' '), hard.lastIndexOf('\n')))
    text = (soft.length > max * 0.6 ? soft : hard).trimEnd()
    cut = true
  }
  return cut ? `${text} …` : text
}

const filedFrom = (ctx: OwnerReportRow['context']): string | null => {
  if (!ctx) return null
  const screen = ctx.screen ? String(ctx.screen) : null
  const onRecord =
    ctx.kind === 'engagement'
      ? `on a client's ${ctx.stage ? `${ctx.stage}-stage ` : ''}job`
      : ctx.lead_id
        ? 'on a client record'
        : null
  if (screen && onRecord) return `${screen} (${onRecord})`
  return screen || onRecord
}

export function ownerReportText(r: OwnerReportRow, locationName: string, appUrl: string): { text: string; emoji: string } {
  const t = REPORT_TYPE[r.type || ''] || { label: String(r.type || 'REPORT').toUpperCase(), emoji: ':speech_balloon:' }
  const who = clean(r.owner_name || 'An owner', 60)
  const lines = [`*${t.label}* — ${who}, ${locationName}`, `*${clean(r.title || '(no title)', 100)}*`]
  const desc = trimDescription(r.description)
  if (desc) lines.push(desc.split('\n').map(l => `> ${l}`).join('\n'))
  const n = Array.isArray(r.attachments) ? r.attachments.length : 0
  const shots = n === 0 ? 'no screenshots' : `${n} screenshot${n > 1 ? 's' : ''}`
  const from = filedFrom(r.context)
  lines.push(from ? `Filed from ${from} · ${shots}` : `Screen not recorded · ${shots}`)
  lines.push(
    appUrl
      ? `<${appUrl}${FEEDBACK_TRIAGE_PATH}|Open the Feedback list> — no link to a single report exists yet`
      : `Open Admin › Feedback — no link to a single report exists yet`,
  )
  return { text: lines.join('\n'), emoji: t.emoji }
}

// ── the pure selector ──────────────────────────────────────────────
// Given the raw sources already fetched for the run, return the alert items
// that are BOTH allowlisted AND newly-committed in (sinceMs, cutoffMs]. Pure:
// no Supabase, no Slack — the unit-test surface for windowing + allowlist.
export function selectNewAlerts(input: {
  events: WebhookLogEvent[]        // enriched inbound sync_log events
  importFailed: ImportFailedRow[]  // import_jobs status='failed' rows
  mismatches: MismatchRow[]        // sync_log ASSESSMENT_TEAM_MISMATCH rows
  locName: Map<string, string>     // slug → display name
  pendingCheckouts?: PendingCheckoutRow[]           // sync_log awaiting-async rows
  locBilling?: Map<string, LocationBillingState>    // slug → subscription state
  resolvedSessions?: Set<string>                    // sessions with a later terminal row
  heldEmails?: HeldSubjectEmailRow[]                // sends held for a blank subject
  ownerReports?: OwnerReportRow[]                   // feedback_items rows filed by owners
  reconnects?: ReconnectRow[]                       // locations stamped RECONNECT REQUIRED
  locNameByUuid?: Map<string, string>               // locations.id (uuid) → display name
  appUrl?: string                                   // for the triage link on owner reports
  sinceMs: number
  cutoffMs: number                 // = nowMs - ALERT_SETTLE_MS
  nowMs: number
}): AlertItem[] {
  const {
    events, importFailed, mismatches, locName, sinceMs, cutoffMs, nowMs,
    pendingCheckouts = [], locBilling, resolvedSessions,
    heldEmails = [], ownerReports = [], reconnects = [], locNameByUuid, appUrl = '',
  } = input
  const items: AlertItem[] = []
  const uuidLabel = (id: string | null | undefined) =>
    (id && locNameByUuid?.get(id)) || 'Unknown account'

  // (1) a lead that never arrived — one message per failed submission.
  // Only LEAD_INTAKE rows: every other failed sync_log row is Jobber's, and
  // those either retry on their own or end up in the daily "never landed".
  for (const e of events) {
    if (e.topic !== 'LEAD_INTAKE' || e.processed) continue
    const t = Date.parse(e.created_at)
    if (!inWindow(t, sinceMs, cutoffMs)) continue
    const reason = clean(e.reason || e.error || 'unknown error', 120)
    const where = e.location_id ? ` — ${locLabel(e.location_id, locName)}` : ''
    items.push({
      kind: 'lead_failed',
      ts: t,
      text: `A website lead didn't arrive${where}: ${leadFailureWhy(reason)} (${reason})`,
    })
  }

  // (2) an owner filed a report — bug, question or idea. Windowed on
  // created_at, so editing a report later (updated_at) never re-alerts, and a
  // deleted one simply is not there to find.
  for (const r of ownerReports) {
    if (r.is_internal === true) continue
    const t = Date.parse(r.created_at || '')
    if (!inWindow(t, sinceMs, cutoffMs)) continue
    const { text, emoji } = ownerReportText(r, uuidLabel(r.location_id), appUrl)
    items.push({ kind: 'owner_report', ts: t, text, emoji })
  }

  // (3) Jobber reconnect required — keyed on the stamp's own time, so a
  // location that stays dead alerts once, not every run.
  for (const r of reconnects) {
    const t = Date.parse(r.stamped_at)
    if (!inWindow(t, sinceMs, cutoffMs)) continue
    items.push({
      kind: 'reconnect_required',
      ts: t,
      text:
        `Jobber disconnected — ${locLabel(r.location_id, locName)}: Jobber rejected the saved login ` +
        `and it will not recover by itself. Nothing syncs with Jobber for this location until ` +
        `Jobber is reconnected in Settings.`,
    })
  }

  // (4) import failed, excluding deliberate user cancels.
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

  // (5) ASSESSMENT_TEAM_MISMATCH — the send landed but the team didn't apply.
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

  // (6) stranded checkout (issue 312) — an owner paid and never got in.
  //
  // The alert moment is NOT when the row was written, it is when the row went
  // stale: created_at + STRANDED_CHECKOUT_MS. Windowing that derived instant
  // through the same (since, cutoff] watermark the other kinds use means a
  // strand is evaluated in exactly one run and alerted exactly once, even
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
    items.push({
      kind: 'email_held',
      ts: dueMs + HELD_SUBJECT_ALERT_MS,
      text:
        `Email held ${ageLabel(nowMs - dueMs)} — ${uuidLabel(held.location_uuid)}: ${who}'s ${held.source} email has a ` +
        `blank subject — it releases itself the moment a subject is saved on the template or step`,
    })
  }

  return items.sort((a, b) => a.ts - b.ts)
}

// ── the pure message builder ────────────────────────────────────────
// ONE MESSAGE PER PROBLEM. Zero items → [] (a quiet window posts NOTHING).
// Past MAX_ALERT_MESSAGES the remainder becomes one summary message, so a
// burst reads as an incident instead of burying the channel.
const EMOJI: Record<AlertKind, string> = {
  lead_failed: ':inbox_tray:',
  owner_report: ':speech_balloon:',
  reconnect_required: ':electric_plug:',
  import_failed: ':x:',
  assessment_mismatch: ':busts_in_silhouette:',
  checkout_stranded: ':hourglass_flowing_sand:',
  email_held: ':envelope:',
}

export type AlertMessage = { text: string; items: AlertItem[] }

export function buildAlertMessages(items: AlertItem[]): AlertMessage[] {
  const out: AlertMessage[] = items
    .slice(0, MAX_ALERT_MESSAGES)
    .map(i => ({ text: `${i.emoji || EMOJI[i.kind]} ${i.text}`, items: [i] }))
  const rest = items.slice(MAX_ALERT_MESSAGES)
  if (rest.length > 0) {
    out.push({
      text:
        `:rotating_light: …and ${rest.length} more problem${rest.length > 1 ? 's' : ''} in the same few minutes:\n` +
        rest.map(i => `• ${i.emoji || EMOJI[i.kind]} ${i.text.split('\n')[0]}`).join('\n'),
      items: rest,
    })
  }
  return out
}

// Where the watermark may safely move after posting messages in order and
// stopping at the first Slack error. Everything posted is behind it; nothing
// unposted is. Because every item's ts is its windowed moment, the answer is
// the largest posted ts that is strictly below the smallest unposted ts —
// or `sinceMs` if even that would skip an unposted item.
export function watermarkAfterPosting(opts: {
  sinceMs: number
  cutoffMs: number
  posted: AlertItem[]
  unposted: AlertItem[]
}): number {
  const { sinceMs, cutoffMs, posted, unposted } = opts
  if (unposted.length === 0) return Math.max(sinceMs, cutoffMs)
  const firstUnposted = Math.min(...unposted.map(i => i.ts))
  const safe = posted.map(i => i.ts).filter(t => t < firstUnposted)
  return safe.length ? Math.max(sinceMs, ...safe) : sinceMs
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

// Every report owners filed in the window — bug, question and feature idea
// alike — plus the filer's name from hub_users (a second read, only when
// there is something to name). Internal items are filtered in the selector
// so a pre-migration row without is_internal still counts.
export async function fetchOwnerReports(
  supabase: typeof supabaseService,
  sinceIso: string,
  cutoffIso: string,
): Promise<OwnerReportRow[]> {
  const { data } = await supabase
    .from('feedback_items')
    .select('user_id, type, title, description, location_id, created_at, is_internal, attachments, context')
    .gt('created_at', sinceIso)
    .lte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(50)
  const rows = (data as any[]) ?? []
  if (!rows.length) return []

  const userIds = Array.from(new Set(rows.map(r => r.user_id).filter(Boolean)))
  const nameById = new Map<string, string>()
  if (userIds.length) {
    const { data: users } = await supabase
      .from('hub_users')
      .select('id, full_name, first_name, last_name, email')
      .in('id', userIds)
    for (const u of (users as any[]) ?? []) {
      const name =
        (u.full_name && String(u.full_name).trim()) ||
        [u.first_name, u.last_name].filter(Boolean).join(' ').trim() ||
        u.email ||
        ''
      if (name) nameById.set(u.id, name)
    }
  }
  return rows.map(r => ({ ...r, owner_name: nameById.get(r.user_id) ?? null }))
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

// One locations read, four answers: the slug-keyed display names every alert
// kind uses, the uuid-keyed names the held-email and owner-report lines need
// (those rows carry locations.id, not the slug), the subscription state the
// strand check needs, and which locations carry a RECONNECT REQUIRED stamp.
export async function fetchLocationDirectory(supabase: typeof supabaseService): Promise<{
  names: Map<string, string>
  namesByUuid: Map<string, string>
  billing: Map<string, LocationBillingState>
  reconnects: ReconnectRow[]
}> {
  const { data } = await supabase
    .from('locations')
    .select('id, location_id, name, subscription_status, last_sync_status')
  const names = new Map<string, string>()
  const namesByUuid = new Map<string, string>()
  const billing = new Map<string, LocationBillingState>()
  const reconnects: ReconnectRow[] = []
  for (const l of (data as any[]) || []) {
    names.set(l.location_id, l.name || l.location_id)
    if (l.id) namesByUuid.set(l.id, l.name || l.location_id)
    billing.set(l.location_id, { status: l.subscription_status ?? null })
    const stamped = parseReconnectStamp(l.last_sync_status)
    if (stamped != null) reconnects.push({ location_id: l.location_id, stamped_at: new Date(stamped).toISOString() })
  }
  return { names, namesByUuid, billing, reconnects }
}

// ── the run collector (route entrypoint) ────────────────────────────
// Fetches every raw source + the location directory for the window, then
// runs the pure selector. cutoff trails now() by ALERT_SETTLE_MS; sinceMs is
// the prior watermark. An empty (settled) window short-circuits to no work.
export async function collectFailureAlerts(opts: {
  nowMs: number
  sinceMs: number
  supabase?: typeof supabaseService
  fetchEvents?: typeof fetchWebhookLogEvents
  appUrl?: string
}): Promise<{ items: AlertItem[]; cutoffMs: number }> {
  const supabase = opts.supabase ?? supabaseService
  const fetchEvents = opts.fetchEvents ?? fetchWebhookLogEvents
  const cutoffMs = opts.nowMs - ALERT_SETTLE_MS
  if (opts.sinceMs >= cutoffMs) return { items: [], cutoffMs }

  const sinceIso = new Date(opts.sinceMs).toISOString()
  const cutoffIso = new Date(cutoffMs).toISOString()

  // '24h' bounds the enriched read while comfortably covering (since, now];
  // the (sinceMs, cutoffMs] filter — not the fetch window — is the real dedup
  // boundary. A cron outage longer than 24h would drop older failed-lead
  // detail here; the admin Webhooks tab still has every row.
  const [{ events }, importFailed, mismatches, directory, pendingCheckouts, ownerReports, heldEmails] =
    await Promise.all([
      fetchEvents({ window: '24h' }),
      fetchImportFailures(supabase, sinceIso, cutoffIso),
      fetchAssessmentMismatches(supabase, sinceIso, cutoffIso),
      fetchLocationDirectory(supabase),
      fetchPendingCheckouts(supabase, opts.sinceMs, cutoffMs),
      fetchOwnerReports(supabase, sinceIso, cutoffIso),
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
    heldEmails,
    ownerReports,
    reconnects: directory.reconnects,
    locNameByUuid: directory.namesByUuid,
    appUrl: opts.appUrl,
    sinceMs: opts.sinceMs,
    cutoffMs,
    nowMs: opts.nowMs,
  })
  return { items, cutoffMs }
}
