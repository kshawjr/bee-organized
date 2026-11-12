// lib/job-channel-auto.ts
// ─────────────────────────────────────────────────────────────
// AUTOMATIC JOB CHANNELS (2026-11-12, Jobber crew → Slack, slice 3 of 3).
//
// A location's owner can turn on, in Settings › Slack, "make a Slack channel
// for every new job". When a job is CREATED in Jobber, Bee Hub makes the
// job's channel, puts the owner in, and waits: the visit notices
// (lib/jobber-crew-mirror.ts) add people as they are put on the job's visits.
//
// ONE CALLER, ON PURPOSE: the JOB_CREATE webhook (handleJobCore in
// lib/jobber-webhook-handlers.ts, when ctx.topic is JOB_CREATE). Not the
// import (it writes jobs by its own route), not JOB_UPDATE, not the visit
// notices, and NEVER the 15-minute sweep — the sweep keeps existing channels
// in step and must not make one (San Francisco alone would get 355 in one
// run). lib/beta-job-channel-auto.test.ts pins that this file has exactly
// that one caller.
//
// THE GUARDS, in the order they are checked. Every "no" stops before Slack.
//   1. The switch is on (locations.slack_auto_channels_at is a time).
//   2. JOBBER says the job was created AFTER that time. The switch going on
//      can never sweep up a job that already existed; a replayed or late
//      notice for an old job is refused; a job with no readable date is
//      refused (fails closed).
//   3. The location has reconnected Slack for job channels.
//   4. The job's deal is open and has no channel. A second job on the same
//      deal REUSES the deal's channel: nothing is made.
//   5. THE CLAIM: engagements.slack_channel_auto_at is stamped by a write
//      only one caller can win (… where it is null). Two notices for one job
//      in the same second, a replay, VISIT_CREATE racing JOB_CREATE: one
//      wins, the rest stop here. A deal claimed once is never claimed again,
//      so a channel an owner deleted in Slack is not quietly remade.
//   6. THE CEILING: this location's claims in the last 24 hours, counted
//      AFTER claiming so that two racing jobs both see each other. Over the
//      ceiling → the claim is given back, the location is stamped
//      (slack_auto_channels_capped_at) so the switch can TELL THE OWNER, and
//      nothing is made. A count that cannot be read counts as over.
//   7. createJobChannel — the same function the Slack mark on a job calls,
//      with its own refusals (closed, not ready, name, Slack down). If it
//      makes nothing, the claim is given back.
//
// THE CEILING IS 15. Measured over 30 days before this was built: 557 new
// jobs across 44 locations, the busiest single location-day had 12, and 95%
// of location-days had 3 or fewer. 15 is above the busiest real day, so no
// real day is cut short, and it is what a fault (a replay storm, a bulk
// change in Jobber) is held to: 15 channels, not hundreds.
//
// UNBOOKED JOBS get a channel like any other: the trigger is the job being
// created, not it being put on the calendar. The channel needs no team and
// no date (it is named from the client and the job type).
//
// Never throws. Logs ids and counts only — no names, no token.
// ─────────────────────────────────────────────────────────────
import { createJobChannel, loadEngagementForBees, readLocationSlackFull, type Db } from '@/lib/engagement-bees'

export const AUTO_CHANNEL_DAILY_CAP = 15
export const AUTO_CHANNEL_WINDOW_MS = 24 * 60 * 60 * 1000

const missing = (msg: unknown, col: RegExp) => {
  const m = String(msg || '')
  return col.test(m) && /does not exist|could not find|schema cache/i.test(m)
}
export const autoColumnsMissing = (msg: unknown) => missing(msg, /slack_auto_channels|slack_channel_auto_at/)

// ── Who may set the switch ───────────────────────────────────
// The people who can reconnect Slack: super_admin, admin, and the OWNER of
// this location (the same check as slack-invite and slack-disconnect).
export function canSetAutoChannels(hubUser: { role?: string | null; location_id?: string | null } | null | undefined, locationUuid: string): boolean {
  if (!hubUser) return false
  return hubUser.role === 'super_admin' || hubUser.role === 'admin' || (hubUser.role === 'owner' && hubUser.location_id === locationUuid)
}

// ── The switch, read ─────────────────────────────────────────
export type AutoSwitch =
  | { setUp: false }
  | { setUp: true; onSince: string | null; cappedAt: string | null }

export async function readAutoSwitch(db: Db, locationUuid: string): Promise<AutoSwitch | { setUp: true; error: string }> {
  try {
    const { data, error } = await db.from('locations')
      .select('slack_auto_channels_at, slack_auto_channels_capped_at').eq('id', locationUuid).maybeSingle()
    if (error) return autoColumnsMissing(error.message) ? { setUp: false } : { setUp: true, error: 'read_failed' }
    if (!data) return { setUp: true, error: 'no_location' }
    return { setUp: true, onSince: data.slack_auto_channels_at ?? null, cappedAt: data.slack_auto_channels_capped_at ?? null }
  } catch {
    return { setUp: true, error: 'read_failed' }
  }
}

// Is the ceiling's stop still in force? True while the stamp is inside the
// window: after that the oldest of the channels that filled it has aged out.
export function capStillOn(cappedAt: string | null | undefined, now: number = Date.now()): boolean {
  const t = cappedAt ? Date.parse(cappedAt) : NaN
  return Number.isFinite(t) && now - t < AUTO_CHANNEL_WINDOW_MS
}

// ── The switch, set ──────────────────────────────────────────
// ON needs a reconnected Slack — checked HERE, on the server, whatever the
// browser sent. Turning on what is already on keeps the first time (a second
// press must not move the line that decides which jobs are "new").
export type SetResult =
  | { ok: true; onSince: string | null }
  | { ok: false; reason: 'not_set_up_yet' | 'not_reconnected' | 'save_failed' }

export async function setAutoSwitch(db: Db, locationUuid: string, on: boolean, now: Date = new Date()): Promise<SetResult> {
  const cur = await readAutoSwitch(db, locationUuid)
  if (!cur.setUp) return { ok: false, reason: 'not_set_up_yet' }
  if ('error' in cur) return { ok: false, reason: 'save_failed' }
  if (!on) {
    const { error } = await db.from('locations')
      .update({ slack_auto_channels_at: null, slack_auto_channels_capped_at: null }).eq('id', locationUuid)
    if (error) return { ok: false, reason: autoColumnsMissing(error.message) ? 'not_set_up_yet' : 'save_failed' }
    return { ok: true, onSince: null }
  }
  const slack = await readLocationSlackFull(db, locationUuid)
  if (!slack.connected || !slack.token || !slack.canManageChannels) return { ok: false, reason: 'not_reconnected' }
  if (cur.onSince) return { ok: true, onSince: cur.onSince }
  const stamp = now.toISOString()
  const { error } = await db.from('locations')
    .update({ slack_auto_channels_at: stamp, slack_auto_channels_capped_at: null }).eq('id', locationUuid)
  if (error) return { ok: false, reason: autoColumnsMissing(error.message) ? 'not_set_up_yet' : 'save_failed' }
  return { ok: true, onSince: stamp }
}

// ── The one thing this file is for ───────────────────────────
export type AutoOutcome =
  | { status: 'off' }
  | { status: 'not_set_up_yet' }
  | { status: 'skipped'; why: 'job_older_than_switch' | 'job_date_unreadable' | 'not_reconnected' | 'no_engagement' | 'closed' | 'has_channel' | 'already_claimed' | 'switch_unreadable' }
  | { status: 'capped'; cap: number }
  | { status: 'created'; channelId: string; notAdded: number }
  | { status: 'failed'; reason: string }

const giveBack = async (db: Db, engagementId: string) => {
  try { await db.from('engagements').update({ slack_channel_auto_at: null }).eq('id', engagementId) } catch { /* the claim stays: it only ever blocks */ }
}

export async function autoCreateJobChannel(
  db: Db,
  args: { engagementId: string; locationUuid: string; jobCreatedAt: string | null | undefined; baseUrl: string | null; now?: Date },
): Promise<AutoOutcome> {
  const { engagementId, locationUuid, jobCreatedAt, baseUrl } = args
  const now = args.now ?? new Date()

  // 1. The switch.
  const sw = await readAutoSwitch(db, locationUuid)
  if (!sw.setUp) return { status: 'not_set_up_yet' }
  if ('error' in sw) return { status: 'skipped', why: 'switch_unreadable' }
  if (!sw.onSince) return { status: 'off' }

  // 2. Only a job Jobber made AFTER the switch went on.
  const since = Date.parse(sw.onSince)
  const made = jobCreatedAt ? Date.parse(jobCreatedAt) : NaN
  if (!Number.isFinite(since) || !Number.isFinite(made)) return { status: 'skipped', why: 'job_date_unreadable' }
  if (made <= since) return { status: 'skipped', why: 'job_older_than_switch' }

  // 3. Reconnected.
  const slack = await readLocationSlackFull(db, locationUuid)
  if (!slack.connected || !slack.token || !slack.canManageChannels) return { status: 'skipped', why: 'not_reconnected' }

  // 4. An open deal with no channel.
  const eng = await loadEngagementForBees(db, engagementId)
  if (!eng || eng.location_uuid !== locationUuid) return { status: 'skipped', why: 'no_engagement' }
  if (!eng.channelColumns) return { status: 'not_set_up_yet' }
  if (eng.slack_channel_id) return { status: 'skipped', why: 'has_channel' }
  if (eng.closed_at) return { status: 'skipped', why: 'closed' }

  // 5. The claim — one winner.
  const stamp = now.toISOString()
  const claim = await db.from('engagements')
    .update({ slack_channel_auto_at: stamp })
    .eq('id', engagementId).is('slack_channel_auto_at', null).is('slack_channel_id', null).select('id')
  if (claim.error) return autoColumnsMissing(claim.error.message) ? { status: 'not_set_up_yet' } : { status: 'failed', reason: 'claim_failed' }
  if (!Array.isArray(claim.data) || claim.data.length === 0) return { status: 'skipped', why: 'already_claimed' }

  // 6. The ceiling, counted with our own claim in it.
  const windowStart = new Date(now.getTime() - AUTO_CHANNEL_WINDOW_MS).toISOString()
  const counted = await db.from('engagements').select('id')
    .eq('location_uuid', locationUuid).gte('slack_channel_auto_at', windowStart).limit(AUTO_CHANNEL_DAILY_CAP + 50)
  const used = counted.error || !Array.isArray(counted.data) ? Infinity : counted.data.length
  if (used > AUTO_CHANNEL_DAILY_CAP) {
    await giveBack(db, engagementId)
    try { await db.from('locations').update({ slack_auto_channels_capped_at: stamp }).eq('id', locationUuid) } catch { /* the log line below still says it */ }
    console.warn(`[job-channel-auto] ceiling reached location=${locationUuid} engagement=${engagementId} cap=${AUTO_CHANNEL_DAILY_CAP}`)
    return { status: 'capped', cap: AUTO_CHANNEL_DAILY_CAP }
  }

  // 7. Make it — the same function the Slack mark on a job calls.
  const made1 = await createJobChannel(db, { eng, slack, baseUrl })
  if (!made1.ok) {
    await giveBack(db, engagementId)
    console.warn(`[job-channel-auto] not made engagement=${engagementId} → ${made1.reason}`)
    return { status: 'failed', reason: made1.reason }
  }
  const notAdded = made1.problems.length + (made1.ownerProblems?.length || 0)
  console.log(`[job-channel-auto] made engagement=${engagementId} channel=${made1.channel.id} not_added=${notAdded}`)
  return { status: 'created', channelId: made1.channel.id, notAdded }
}

// Never throws: a fault here must not fail the job write it rides on.
export async function autoCreateJobChannelSafely(db: Db, args: Parameters<typeof autoCreateJobChannel>[1]): Promise<AutoOutcome> {
  try {
    return await autoCreateJobChannel(db, args)
  } catch (e: any) {
    console.error(`[job-channel-auto] threw engagement=${args.engagementId} —`, e?.name || 'error')
    return { status: 'failed', reason: 'threw' }
  }
}

// One plain line for sync_log, or null when there is nothing worth a line
// (switch off, not set up: exactly what the log said before this existed).
export function autoNote(o: AutoOutcome): string | null {
  switch (o.status) {
    case 'off': case 'not_set_up_yet': return null
    case 'created': return `auto channel made${o.notAdded ? `, ${o.notAdded} not added` : ''}`
    case 'capped': return `auto channel NOT made — daily ceiling of ${o.cap} reached`
    case 'failed': return `auto channel not made — ${o.reason}`
    case 'skipped': return o.why === 'has_channel' || o.why === 'already_claimed' ? null : `auto channel skipped — ${o.why}`
  }
}
