// lib/connection-health.ts
// ─────────────────────────────────────────────────────────────
// What the Slack and Jobber connection screens (Settings › Connections) show
// beyond "connected / not connected" — worked out ONLY from rows Bee Hub
// already writes. Nothing here writes anything, and no column was added.
//
// SLACK — "Channel broken"
//   The most recent lead alert Bee Hub tried to post for the location
//   (notification_log, channel 'slack') failed with channel_not_found.
//   'muted' rows are skipped: a muted location posted nothing, so a muted row
//   says nothing about the channel. The Send-test-message button is NOT in
//   this table (lib/slack-test.ts: deliberately not logged), so a channel
//   that was fixed today still reads broken here until the next lead posts —
//   the screen clears it itself when a test message arrives.
//
// JOBBER
//   lastInboundAt  when Jobber last sent Bee Hub an update: the newest
//                  sync_log row the Jobber receiver wrote for the location
//                  (direction 'inbound'). The one inbound row the IMPORT
//                  writes ("[job-status] …") is left out — Jobber did not
//                  send that.
//   lastJob        the newest client import (import_jobs): how it ended and
//                  how far it got. Its `phase` is NOT returned — that column
//                  holds notes written for support, not for an owner.
//   broughtIn      how many clients the last finished import brought in.
//
// The two pure functions at the bottom are the whole rule for which state a
// screen is in; the screens only draw what they say.
// ─────────────────────────────────────────────────────────────

type Db = { from: (table: string) => any }

export type SlackLastPost = { status: 'accepted' | 'failed'; error: string | null; at: string } | null
export type JobberLastJob = { status: string; processed: number; total: number; at: string | null } | null
export type JobberHealth = { lastInboundAt: string | null; lastJob: JobberLastJob; broughtIn: number | null }

export async function readSlackLastPost(db: Db, locationUuid: string): Promise<SlackLastPost> {
  const { data, error } = await db
    .from('notification_log')
    .select('send_status, error, created_at')
    .eq('location_id', locationUuid)
    .eq('channel', 'slack')
    .in('send_status', ['accepted', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return { status: data.send_status, error: data.error ?? null, at: data.created_at }
}

export async function readJobberHealth(db: Db, locationSlug: string): Promise<JobberHealth> {
  const [inbound, job, done] = await Promise.all([
    db.from('sync_log')
      .select('created_at')
      .eq('location_id', locationSlug)
      .eq('direction', 'inbound')
      .not('message', 'like', '[job-status]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('import_jobs')
      .select('status, processed_records, total_records, started_at, completed_at')
      .eq('location_id', locationSlug)
      .eq('type', 'jobber_clients')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('import_jobs')
      .select('processed_records')
      .eq('location_id', locationSlug)
      .eq('type', 'jobber_clients')
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  const j = job?.data
  const n = done?.data?.processed_records
  return {
    lastInboundAt: inbound?.data?.created_at ?? null,
    lastJob: j ? { status: String(j.status || ''), processed: Number(j.processed_records) || 0, total: Number(j.total_records) || 0, at: j.completed_at ?? j.started_at ?? null } : null,
    broughtIn: typeof n === 'number' && n > 0 ? n : null,
  }
}

// ── The rules ─────────────────────────────────────────────────────────────

// Broken = the LAST post failed, and failed because Slack could not find the
// channel. An older failure followed by a post that arrived is not broken.
export function slackChannelBroken(lastPost: SlackLastPost | undefined): boolean {
  return !!lastPost && lastPost.status === 'failed' && lastPost.error === 'channel_not_found'
}

// A stopped import that got part of the way: some clients in, not all.
export function importStoppedPartWay(lastJob: JobberLastJob | undefined): { done: number; total: number } | null {
  if (!lastJob || lastJob.status !== 'failed') return null
  if (!(lastJob.processed > 0) || !(lastJob.total > 0) || lastJob.processed >= lastJob.total) return null
  return { done: lastJob.processed, total: lastJob.total }
}

export type JobberScreenState = 'off' | 'reconnect' | 'first' | 'importing' | 'stuck' | 'running'

//   status       'connected' | 'reconnect_required' | 'disconnected' (lib/jobber-status)
//   importPhase  what the import engine on the page says right now:
//                'idle' | 'running' | 'parked' | 'complete' | 'error'
//   hasImported  locations.jobber_initial_import_completed_at is set
//   lastJob      from readJobberHealth; unknown (undefined/null) is never "stuck"
export function jobberScreenState(a: { status: string; importPhase?: string; hasImported?: boolean; lastJob?: JobberLastJob }): JobberScreenState {
  if (a.status === 'reconnect_required') return 'reconnect'
  if (a.status !== 'connected') return 'off'
  if (a.importPhase === 'running' || a.importPhase === 'parked') return 'importing'
  if (a.importPhase === 'error') return 'stuck'
  if (a.importPhase === 'complete' || a.hasImported) return 'running'
  if (importStoppedPartWay(a.lastJob)) return 'stuck'
  return 'first'
}

// "Today, 10:18 AM" · "Yesterday, 4:02 PM" · "Nov 19, 9:30 AM". In the
// reader's own time zone, like every other time on the Settings screens.
export function whenWords(iso: string | null | undefined, now: Date = new Date()): string {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(now) - day(d)) / 86400000)
  if (days === 0) return `Today, ${clock}`
  if (days === 1) return `Yesterday, ${clock}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })}, ${clock}`
}
