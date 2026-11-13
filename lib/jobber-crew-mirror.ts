// lib/jobber-crew-mirror.ts
// ─────────────────────────────────────────────────────────────
// Jobber's crew → the bees on a job → the job's Slack channel.
//
// Owners work a job in Jobber once it exists (Kevin, 2026-11-12): they put
// people on each visit there and do not come back to Bee Hub. So Jobber is the
// source of truth for who is on a job, and this module is the ONE place that
// reads it and makes Bee Hub match:
//
//   WHO IS ON THE JOB = everyone on any visit that is not finished yet,
//   across every live job of the engagement (Kevin's ruling). The crew lives
//   on the VISITS (Visit.assignedUsers). Jobber also keeps a job-level
//   default (Job.visitSchedule.assignedTo); it is NOT read — of 61 jobs that
//   had it set it matched the visits 28 times, and two locations never set it.
//
//   mirrorCrewFromJobber(engagementId)
//     1. read each live job's unfinished visits' assignedUsers  (Jobber, READ)
//     2. turn each person into a bee (location_bees), adding them the first
//        time they are seen, matched by Jobber id
//     3. make engagement_bees match
//     4. if the job has a Slack channel, make its membership match too —
//        with the SAME reconcile the unarchive sweep uses, so the owner, the
//        app and anyone added by hand in Slack are never removed
//
// Called from three places, all of which may run for the same change — it is
// idempotent, and a second run finds nothing to do:
//   · the four visit notices (VISIT_CREATE / _UPDATE / _COMPLETE / _DESTROY)
//   · JOB_CREATE / JOB_UPDATE, because a visit notice can arrive BEFORE the
//     job it belongs to (same second), when there is no job row to hang it on
//   · the 15-minute sweep (sweepJobCrews), the backstop: nobody has proved
//     VISIT_UPDATE fires on a crew-only change, and a notice whose Jobber read
//     failed must not lose the change
//
// READ ONLY TOWARDS JOBBER. Every Jobber call goes through jobberRead, which
// refuses any document that is not a query. There is no mutation in this
// file. Pinned by lib/beta-jobber-crew-mirror.test.ts.
//
// A FAILED READ CHANGES NOTHING. "Jobber did not answer" must never read as
// "nobody is on the job" — that would empty the bees and the channel. Any
// job that cannot be read in full stops the whole engagement, untouched.
//
// WHICH BEES THIS MANAGES: only bees that carry a jobber_user_id. A bee typed
// by hand for someone who is not in Jobber has none, and is never taken off a
// job here — that is what typing a bee by hand is still for.
//
// ONLY FOR LOCATIONS THAT HAVE RECONNECTED SLACK (Kevin, 2026-11-12). Bees
// exist to drive job channels, and a location whose Slack install has not
// been reconnected (no channels:manage) cannot have one. For every other
// location NOTHING here runs: no Jobber read, no bee added, no Slack call —
// from a notice, from a job event, or from the sweep. Otherwise several
// hundred names would appear on a screen 43 owners have never been told
// about, for a feature they cannot use. It spreads as owners reconnect: the
// first notice or sweep after a reconnect fills that location in.
//
// Log lines carry ids and counts only: no names, no emails, no tokens.
// ─────────────────────────────────────────────────────────────
import { isDeletedJob } from '@/components/hive/shared/jobDeleted'
import { jobberGraphQL } from './jobber'
import { encodeJobberId, extractJobberId } from './jobber-import'
import { slackCanManageChannels } from './slack-scopes'
import { BEE_COLUMNS, type BeeRow, checkBeeAgainstSlack, cleanEmail, cleanName, emailKey } from './location-bees'
import {
  type Db, assignBee, unassignBee, beesTableMissing, loadEngagementForBees,
  readLocationSlackFull, reconcileChannelBees,
} from './engagement-bees'

// ── Jobber, read only ────────────────────────────────────────
export type JobberReader = (locationSlug: string, query: string, variables?: Record<string, any>) => Promise<{ data?: any; errors?: any[] }>

// PAGE SIZES ARE A BUDGET, not a convenience. Jobber prices a query by what
// it COULD return and refuses it outright if that is more than the account
// has left (10,000 points, refilling 500 a second). Measured live 2026-11-12:
// 50 visits x 25 people was priced at 6,557 a read — two at once would have
// been refused. 25 x 15 is priced at 2,032 (measured), so three at once ask
// for about 6,100 and leave room for whatever else the account is doing; the
// real cost of a read was 7 to 60 points. A refused read is "unread": nothing
// changes and the sweep tries again.
const VISIT_PAGE = 25
const CREW_PAGE = 15
const MAX_VISIT_PAGES = 20   // 500 visits; past that the job is left alone, not half-read
const JOB_READS_AT_ONCE = 3

export const JOB_CREW_QUERY = `
  query JobCrewForMirror($jobId: EncodedId!, $after: String) {
    job(id: $jobId) {
      id
      visits(first: ${VISIT_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isComplete
          assignedUsers(first: ${CREW_PAGE}) {
            pageInfo { hasNextPage }
            nodes { id name { full } email { raw } }
          }
        }
      }
    }
  }
`

export const VISIT_JOB_QUERY = `
  query VisitJobForMirror($id: EncodedId!) {
    visit(id: $id) { id isComplete job { id } }
  }
`

// The only door to Jobber in this file. A document that is not a query is
// refused BEFORE it is sent.
export async function jobberRead(read: JobberReader, locationSlug: string, query: string, variables?: Record<string, any>) {
  if (!/^\s*query\b/.test(query)) throw new Error('jobber-crew-mirror is read-only: refused a non-query document')
  return read(locationSlug, query, variables)
}

export type CrewPerson = { jobberUserId: string; name: string | null; email: string | null }

// Everyone on an unfinished visit of ONE job. ok:false = could not be read in
// full; the caller changes nothing.
export async function readJobCrew(read: JobberReader, locationSlug: string, jobberJobId: string):
  Promise<{ ok: true; crew: CrewPerson[]; visits: number; unfinished: number } | { ok: false; reason: 'jobber_unread' | 'too_many_visits' }> {
  const crew = new Map<string, CrewPerson>()
  let after: string | null = null
  let visits = 0, unfinished = 0
  for (let page = 0; page < MAX_VISIT_PAGES; page++) {
    let res: { data?: any; errors?: any[] }
    try {
      res = await jobberRead(read, locationSlug, JOB_CREW_QUERY, { jobId: encodeJobberId('Job', jobberJobId), after })
    } catch (e: any) {
      console.warn(`[crew-mirror] job ${jobberJobId} read threw — ${String(e?.message || e).slice(0, 120)}`)
      return { ok: false, reason: 'jobber_unread' }
    }
    if (res.errors?.length || !res.data) {
      console.warn(`[crew-mirror] job ${jobberJobId} not read — ${String(res.errors?.[0]?.message || 'empty answer').slice(0, 120)}`)
      return { ok: false, reason: 'jobber_unread' }
    }
    // Jobber ANSWERED, with no error, that there is no such job (seen live:
    // { job: null }). That is an answer, not a failure: a job deleted in
    // Jobber has nobody on it. Treating it as unread would freeze the whole
    // engagement, and the location with it, on every run.
    if (res.data.job === null) return { ok: true, crew: [], visits: 0, unfinished: 0 }
    if (!res.data.job?.visits) return { ok: false, reason: 'jobber_unread' }
    const conn = res.data.job.visits
    for (const v of (conn.nodes || []).filter(Boolean)) {
      visits++
      if (v.isComplete) continue
      unfinished++
      // A visit with more people than one page holds would be half a crew.
      if (v.assignedUsers?.pageInfo?.hasNextPage) return { ok: false, reason: 'too_many_visits' }
      for (const u of (v.assignedUsers?.nodes || []).filter(Boolean)) {
        if (!u.id || crew.has(u.id)) continue
        crew.set(u.id, { jobberUserId: String(u.id), name: u.name?.full ?? null, email: u.email?.raw ?? null })
      }
    }
    if (!conn.pageInfo?.hasNextPage) return { ok: true, crew: Array.from(crew.values()), visits, unfinished }
    after = conn.pageInfo.endCursor
  }
  console.warn(`[crew-mirror] job ${jobberJobId} has more than ${VISIT_PAGE * MAX_VISIT_PAGES} visits — left alone`)
  return { ok: false, reason: 'too_many_visits' }
}

// ── People → bees ────────────────────────────────────────────
// Matched by Jobber id. The first time a person is seen:
//   · a bee typed by hand with the SAME email and no Jobber id is that person
//     — it gets the id, and keeps the name and email the owner typed;
//   · otherwise a new bee is added with the name and email Jobber has.
// After that the bee's name and email are never rewritten from Jobber, so an
// owner can correct an email that differs from the one used in Slack.
// A removed bee who turns up on a visit comes back: Jobber says they are
// working this job.
export async function beesForCrew(
  db: Db, locationUuid: string, crew: CrewPerson[],
): Promise<{ ok: true; beeIds: string[]; added: BeeRow[]; unresolved: number } | { ok: false; error: string }> {
  const { data, error } = await db.from('location_bees').select(BEE_COLUMNS).eq('location_uuid', locationUuid)
  if (error) return { ok: false, error: String(error.message || 'read_failed') }
  const all = (data || []) as BeeRow[]
  const byJobber = new Map<string, BeeRow>(all.filter(b => b.jobber_user_id).map(b => [String(b.jobber_user_id), b]))
  const byEmail = new Map<string, BeeRow>(all.map(b => [emailKey(b.email), b]))
  const out = { ok: true as const, beeIds: [] as string[], added: [] as BeeRow[], unresolved: 0 }
  const now = () => new Date().toISOString()

  const reactivate = async (bee: BeeRow, patch: Record<string, unknown> = {}) => {
    const full = { ...patch, ...(bee.is_active === false ? { is_active: true, removed_at: null } : {}) }
    if (!Object.keys(full).length) return true
    const { error: e } = await db.from('location_bees').update({ ...full, updated_at: now() }).eq('id', bee.id)
    if (e) { console.warn('[crew-mirror] bee not updated', bee.id, '—', e.message); return false }
    Object.assign(bee, full)
    return true
  }

  for (const p of crew) {
    let bee = byJobber.get(p.jobberUserId) || null
    if (bee) {
      if (!(await reactivate(bee))) { out.unresolved++; continue }
      out.beeIds.push(bee.id); continue
    }
    const email = cleanEmail(p.email)
    if (!email) { out.unresolved++; console.warn('[crew-mirror] a Jobber user on a visit has no usable email — not added as a bee'); continue }
    const typed = byEmail.get(emailKey(email)) || null
    if (typed) {
      // Same email, but already tied to a DIFFERENT Jobber user: two Jobber
      // logins share an email. Leave both alone rather than guess.
      if (typed.jobber_user_id) { out.unresolved++; console.warn('[crew-mirror] two Jobber users share an email at location', locationUuid, '— second one not added'); continue }
      if (!(await reactivate(typed, { jobber_user_id: p.jobberUserId }))) { out.unresolved++; continue }
      byJobber.set(p.jobberUserId, typed)
      out.beeIds.push(typed.id); continue
    }
    const name = cleanName(p.name) || email
    const { data: made, error: insErr } = await db.from('location_bees')
      .insert({ location_uuid: locationUuid, name, email, jobber_user_id: p.jobberUserId })
      .select(BEE_COLUMNS).maybeSingle()
    if (insErr || !made) {
      // 23505: another notice for the same person got there first. The next
      // run finds the row; nothing is lost by skipping them this once.
      out.unresolved++
      if (insErr?.code !== '23505') console.warn('[crew-mirror] bee not added at location', locationUuid, '—', insErr?.message || 'no row')
      continue
    }
    bee = made as BeeRow
    byJobber.set(p.jobberUserId, bee); byEmail.set(emailKey(email), bee)
    out.added.push(bee)
    out.beeIds.push(bee.id)
  }
  return out
}

// ── One engagement ───────────────────────────────────────────
export type CrewMirrorSkip =
  | 'engagement_not_found' | 'closed' | 'slack_not_reconnected' | 'no_jobs' | 'jobber_not_connected'
  | 'jobber_unread' | 'too_many_visits' | 'bees_not_set_up' | 'db_error'

export type CrewMirrorResult =
  | {
      ok: true
      engagementId: string
      onJob: number        // people Jobber has on unfinished visits
      added: number        // put on the job here
      removed: number      // taken off the job here
      newBees: number      // seen for the first time
      unresolved: number   // on a visit, but could not be made a bee
      slack: 'no_channel' | 'unchanged' | 'matched' | 'problems'
      slackProblems: number
    }
  | { ok: false; engagementId: string; reason: CrewMirrorSkip }

// Reasons worth another try by the sweep; the rest are settled facts.
export const isRetryable = (r: CrewMirrorResult) => !r.ok && (r.reason === 'jobber_unread' || r.reason === 'db_error')

export async function mirrorCrewFromJobber(
  db: Db,
  engagementId: string,
  opts: { read?: JobberReader } = {},
): Promise<CrewMirrorResult> {
  const read = opts.read || (jobberGraphQL as JobberReader)
  const skip = (reason: CrewMirrorSkip): CrewMirrorResult => ({ ok: false, engagementId, reason })

  const eng = await loadEngagementForBees(db, engagementId)
  if (!eng) return skip('engagement_not_found')
  if (eng.closed_at) return skip('closed')
  // The gate. Checked BEFORE Jobber is read, so a location that has not
  // reconnected costs one database read and nothing else.
  const slack = await readLocationSlackFull(db, eng.location_uuid)
  if (!slack.connected || !slack.token || !slack.canManageChannels) return skip('slack_not_reconnected')

  const [locRes, jobsRes] = await Promise.all([
    db.from('locations').select('location_id, jobber_connected').eq('id', eng.location_uuid).maybeSingle(),
    db.from('jobs').select('jobber_job_id, status').eq('engagement_id', engagementId).not('jobber_job_id', 'is', null),
  ])
  if (locRes.error || jobsRes.error) return skip('db_error')
  const slug: string | null = locRes.data?.location_id || null
  if (!slug || locRes.data?.jobber_connected !== true) return skip('jobber_not_connected')
  const jobIds: string[] = ((jobsRes.data || []) as any[]).filter(j => !isDeletedJob(j)).map(j => String(j.jobber_job_id))
  if (!jobIds.length) return skip('no_jobs')

  // 1. Jobber: every live job, a few at a time. ONE unreadable job stops the
  //    engagement — a partial crew would take real people off the job.
  const crew = new Map<string, CrewPerson>()
  for (let i = 0; i < jobIds.length; i += JOB_READS_AT_ONCE) {
    const batch = await Promise.all(jobIds.slice(i, i + JOB_READS_AT_ONCE).map(id => readJobCrew(read, slug, id)))
    for (const r of batch) {
      if (!r.ok) return skip(r.reason)
      for (const p of r.crew) if (!crew.has(p.jobberUserId)) crew.set(p.jobberUserId, p)
    }
  }

  // 2. People → bees.
  const bees = await beesForCrew(db, eng.location_uuid, Array.from(crew.values()))
  if (!bees.ok) return skip(beesTableMissing(bees.error) ? 'bees_not_set_up' : 'db_error')

  // 3. engagement_bees: add who is on a visit, take off Jobber-linked bees who
  //    no longer are. Bees with no Jobber id are hand-managed and left alone.
  const [liveRes, rosterRes] = await Promise.all([
    db.from('engagement_bees').select('bee_id, removed_at').eq('engagement_id', engagementId),
    db.from('location_bees').select('id, jobber_user_id').eq('location_uuid', eng.location_uuid),
  ])
  if (liveRes.error || rosterRes.error) {
    return skip(beesTableMissing(liveRes.error?.message || rosterRes.error?.message) ? 'bees_not_set_up' : 'db_error')
  }
  const fromJobber = new Set<string>(((rosterRes.data || []) as any[]).filter(b => b.jobber_user_id).map(b => b.id))
  const wanted = new Set<string>(bees.beeIds)
  const live = new Set<string>(((liveRes.data || []) as any[]).filter(r => !r.removed_at).map(r => r.bee_id))
  let added = 0, removed = 0
  for (const id of Array.from(wanted)) {
    if (live.has(id)) continue
    const r = await assignBee(db, engagementId, id)
    if (!r.ok) return skip('db_error')
    if (r.changed) added++
  }
  for (const id of Array.from(live)) {
    if (wanted.has(id) || !fromJobber.has(id)) continue
    const r = await unassignBee(db, engagementId, id)
    if (!r.ok) return skip('db_error')
    if (r.changed) removed++
  }

  // 4. Slack.
  const out: CrewMirrorResult = {
    ok: true, engagementId, onJob: crew.size, added, removed,
    newBees: bees.added.length, unresolved: bees.unresolved, slack: 'no_channel', slackProblems: 0,
  }
  // A new bee is checked against Slack once, when added — the roster's own
  // rule. Best effort: a failed check never undoes the bee.
  for (const b of bees.added) await checkBeeAgainstSlack(db, b, slack)
  if (!eng.slack_channel_id || eng.slack_channel_archived_at) out.slack = 'no_channel'
  // Nothing changed in the crew → Slack is not asked. A line Slack refused
  // before is NOT put to it again from here every 15 minutes (it was, until
  // 2026-11-13): the stored lines have their own paced retry,
  // lib/engagement-bees sweepChannelProblems.
  else if (added + removed === 0) out.slack = 'unchanged'
  else {
    const rec = await reconcileChannelBees(db, {
      token: slack.token, engagementId, locationUuid: eng.location_uuid,
      channelId: eng.slack_channel_id, channelName: eng.slack_channel_name, from: 'crew',
    })
    out.slackProblems = rec.problems.length
    out.slack = rec.problems.length ? 'problems' : 'matched'
  }
  console.log(`[crew-mirror] engagement=${engagementId} on_job=${out.onJob} added=${added} removed=${removed} new_bees=${out.newBees} unresolved=${out.unresolved} slack=${out.slack}${out.slackProblems ? `(${out.slackProblems})` : ''}`)
  return out
}

// One plain clause for a sync_log note. Ids and counts only.
export function crewNote(r: CrewMirrorResult): string {
  if (!r.ok) return `crew not changed (${r.reason}) engagement=${r.engagementId}`
  const parts = [`crew ${r.onJob} on job`, `+${r.added} -${r.removed}`]
  if (r.newBees) parts.push(`${r.newBees} new bee${r.newBees === 1 ? '' : 's'}`)
  if (r.unresolved) parts.push(`${r.unresolved} not added`)
  parts.push(`slack ${r.slack}${r.slackProblems ? ` (${r.slackProblems})` : ''}`)
  return `${parts.join(', ')} engagement=${r.engagementId}`
}

// The marker a failed notice leaves in sync_log for the sweep to pick up.
export const CREW_RETRY_MARK = 'crew_retry engagement='

// Never throws. For callers (the job handlers) where the crew is a side
// effect that must not fail the work they are really doing.
export async function mirrorCrewSafely(db: Db, engagementId: string, opts: { read?: JobberReader } = {}): Promise<CrewMirrorResult> {
  try {
    return await mirrorCrewFromJobber(db, engagementId, opts)
  } catch (e: any) {
    console.error('[crew-mirror] failed for engagement', engagementId, '—', e?.message || e)
    return { ok: false, engagementId, reason: 'db_error' }
  }
}

// ── A visit notice ───────────────────────────────────────────
// visit → its job → the job row Bee Hub has → that row's engagement → mirror.
//
// NEVER CREATES ANYTHING. A notice for a job Bee Hub does not have (VISIT_CREATE
// can land before JOB_CREATE, in the same second) does nothing and says so;
// JOB_CREATE then mirrors the crew itself, once the job exists.
//
// A deleted visit cannot be read back from Jobber, so each notice that CAN be
// read leaves a visit → job note in job_visits, and VISIT_DESTROY uses it.
export type VisitNoticeResult =
  | { status: 'mirrored'; result: CrewMirrorResult }
  | { status: 'unknown_job'; jobberJobId: string | null }
  | { status: 'visit_unreadable' }
  | { status: 'visit_gone' } // deleted, and never seen before — the sweep catches it
  | { status: 'not_reconnected' } // this location's Slack has no job channels: nothing is read or recorded

export async function handleVisitNotice(
  db: Db,
  args: { locationSlug: string; locationUuid: string; visitId: string; read?: JobberReader },
): Promise<VisitNoticeResult> {
  // The gate, before anything is asked of Jobber: ~190 visit notices a day
  // arrive across the fleet, nearly all from locations with no job channels.
  const gate = await readLocationSlackFull(db, args.locationUuid)
  if (!gate.connected || !gate.token || !gate.canManageChannels) return { status: 'not_reconnected' }
  const read = args.read || (jobberGraphQL as JobberReader)
  const visitNumeric = extractJobberId(args.visitId) || String(args.visitId)

  let jobberJobId: string | null = null
  let visitRead: any = null
  try {
    const res = await jobberRead(read, args.locationSlug, VISIT_JOB_QUERY, { id: encodeJobberId('Visit', visitNumeric) })
    if (res.errors?.length && !res.data?.visit) {
      // "Not found" is how Jobber answers for a deleted visit; anything else
      // is a failed read.
      const msg = String(res.errors[0]?.message || '')
      if (!/not found|does not exist|no .* found/i.test(msg)) {
        console.warn(`[crew-mirror] visit ${visitNumeric} not read — ${msg.slice(0, 120)}`)
        return { status: 'visit_unreadable' }
      }
    }
    visitRead = res.data?.visit ?? null
    jobberJobId = extractJobberId(visitRead?.job?.id) || null
  } catch (e: any) {
    console.warn(`[crew-mirror] visit ${visitNumeric} read threw — ${String(e?.message || e).slice(0, 120)}`)
    return { status: 'visit_unreadable' }
  }

  let jobRow: { id: string; lead_id: string | null; engagement_id: string | null } | null = null
  if (jobberJobId) {
    const { data, error } = await db.from('jobs').select('id, lead_id, engagement_id, status')
      .eq('location_id', args.locationSlug).eq('jobber_job_id', jobberJobId).maybeSingle()
    if (error) return { status: 'visit_unreadable' }
    jobRow = data && !isDeletedJob(data) ? data : null
    if (jobRow?.lead_id) {
      // Remember which job this visit belongs to, for the day it is deleted.
      try {
        const { error: e } = await db.from('job_visits').upsert(
          { jobber_visit_id: visitNumeric, job_id: jobRow.id, lead_id: jobRow.lead_id, location_id: args.locationSlug, jobber_synced_at: new Date().toISOString() },
          { onConflict: 'jobber_visit_id' },
        )
        if (e) console.warn('[crew-mirror] visit → job note not kept for visit', visitNumeric, '—', e.message)
      } catch { /* a missing note only costs a deleted visit up to 15 minutes */ }
    }
  } else {
    // Gone from Jobber. Did we note its job while it existed?
    const { data: note } = await db.from('job_visits').select('job_id').eq('jobber_visit_id', visitNumeric).maybeSingle()
    if (!note?.job_id) return { status: 'visit_gone' }
    const { data } = await db.from('jobs').select('id, lead_id, engagement_id, status').eq('id', note.job_id).maybeSingle()
    jobRow = data && !isDeletedJob(data) ? data : null
  }

  if (!jobRow?.engagement_id) return { status: 'unknown_job', jobberJobId }
  return { status: 'mirrored', result: await mirrorCrewSafely(db, jobRow.engagement_id, { read }) }
}

// ── The sweep: the backstop ──────────────────────────────────
// Every 15 minutes, beside the archive sweep (/api/cron/job-channels).
//
// WHO IS CHECKED, in this order, until the run's budget is spent:
//   1. engagements a notice could not finish (crew_retry marks in sync_log,
//      last 45 minutes)
//   2. every open job that HAS a Slack channel — this is where a missed
//      change is felt, so they are checked on every run
//   (only at locations that have reconnected Slack — see the top of the file)
//   3. one twelfth of the open jobs at 'Job in Progress' with no channel —
//      each is reached once every three hours. Their bees are a record, not a
//      conversation; three hours is the price of not reading a thousand jobs
//      from Jobber four times an hour.
// A location whose Jobber does not answer is skipped for the rest of the run.
export type CrewSweepResult = {
  ok: boolean
  checked: number
  changed: number       // engagements whose bees changed
  added: number
  removed: number
  unread: number        // Jobber did not answer — nothing changed, tried again next time
  deferred: number      // not reached inside this run's budget
  slack_problems: number
}

export const CREW_SWEEP_BUCKETS = 12
const CREW_SWEEP_MAX = 80
const CREW_SWEEP_BUDGET_MS = 40_000
const SLOT_MS = 15 * 60 * 1000

export const crewBucket = (engagementId: string) => (parseInt(String(engagementId).replace(/-/g, '').slice(0, 8), 16) || 0) % CREW_SWEEP_BUCKETS

export async function sweepJobCrews(
  db: Db,
  opts: { read?: JobberReader; now?: number; budgetMs?: number; max?: number } = {},
): Promise<CrewSweepResult> {
  const r: CrewSweepResult = { ok: true, checked: 0, changed: 0, added: 0, removed: 0, unread: 0, deferred: 0, slack_problems: 0 }
  const now = opts.now ?? Date.now()
  const max = opts.max ?? CREW_SWEEP_MAX
  const budget = opts.budgetMs ?? CREW_SWEEP_BUDGET_MS
  const slot = Math.floor(now / SLOT_MS)

  // Which locations take part at all: Slack connected AND reconnected.
  const { data: locRows, error: locErr } = await db.from('locations')
    .select('id, slack_connected, slack_bot_token, slack_scopes').eq('slack_connected', true).limit(1000)
  if (locErr) { console.error('[crew-mirror] sweep could not read locations —', locErr.message); return { ...r, ok: false } }
  const reconnected = new Set<string>(((locRows || []) as any[])
    .filter(l => typeof l.slack_bot_token === 'string' && l.slack_bot_token && slackCanManageChannels(l)).map(l => l.id))
  if (!reconnected.size) return r

  const [retries, withChannel, inProgress] = await Promise.all([
    db.from('sync_log').select('message').eq('direction', 'inbound')
      .gte('created_at', new Date(now - 45 * 60 * 1000).toISOString()).ilike('message', `%${CREW_RETRY_MARK}%`).limit(200),
    db.from('engagements').select('id, location_uuid')
      .is('closed_at', null).not('slack_channel_id', 'is', null).is('slack_channel_archived_at', null).order('id').limit(1000),
    db.from('engagements').select('id, location_uuid')
      .is('closed_at', null).eq('stage', 'Job in Progress').order('id').limit(1000),
  ])
  if (withChannel.error || inProgress.error) {
    console.error('[crew-mirror] sweep read failed —', (withChannel.error || inProgress.error).message)
    return { ...r, ok: false }
  }

  const here = (rows: any[] | null) => ((rows || []) as any[]).filter(e => reconnected.has(e.location_uuid))
  withChannel.data = here(withChannel.data); inProgress.data = here(inProgress.data)
  const locOf = new Map<string, string>()
  for (const e of [...withChannel.data, ...inProgress.data] as any[]) locOf.set(e.id, e.location_uuid)
  const retryIds = ((retries.data || []) as any[])
    .map(x => (String(x.message || '').split(CREW_RETRY_MARK)[1] || '').match(/^[0-9a-f-]{36}/i)?.[0] || '')
    .filter(Boolean)
  const channelIds = ((withChannel.data || []) as any[]).map(e => e.id as string)
  // More channel jobs than one run can hold: start from a different place
  // each run so none is starved.
  const start = channelIds.length > max ? (slot * max) % channelIds.length : 0
  const rotated = [...channelIds.slice(start), ...channelIds.slice(0, start)]
  const slice = ((inProgress.data || []) as any[]).map(e => e.id as string).filter(id => crewBucket(id) === slot % CREW_SWEEP_BUCKETS)
  const queue = Array.from(new Set<string>([...retryIds, ...rotated, ...slice]))

  const deadLocations = new Set<string>()
  const began = Date.now()
  for (let i = 0; i < queue.length; i++) {
    if (r.checked >= max || Date.now() - began > budget) { r.deferred = queue.length - i; break }
    const id = queue[i]
    const loc = locOf.get(id)
    if (loc && deadLocations.has(loc)) { r.unread++; continue }
    const res = await mirrorCrewFromJobber(db, id, { read: opts.read })
      .catch((e: any): CrewMirrorResult => { console.error('[crew-mirror] sweep failed for', id, '—', e?.message || e); return { ok: false, engagementId: id, reason: 'db_error' } })
    r.checked++
    if (!res.ok) {
      if (res.reason === 'jobber_unread') { r.unread++; if (loc) deadLocations.add(loc) }
      else if (res.reason === 'db_error') r.ok = false
      continue
    }
    if (res.added || res.removed) r.changed++
    r.added += res.added; r.removed += res.removed; r.slack_problems += res.slackProblems
  }
  return r
}
