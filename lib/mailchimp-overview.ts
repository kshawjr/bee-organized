// lib/mailchimp-overview.ts
//
// FL-75 SLICE 6 (2026-11-25): what the Mailchimp connection screen shows
// before anyone presses a button — never synced / synced / on hold — built to
// Kevin's Lovable design (kshawjr/mailchimbeehub, MailchimpConnection.tsx).
//
// READ ONLY. Every Mailchimp request here is a GET (the audience's size, and
// the flows through readFlows). It sends nothing, and the token never leaves
// the server.
//
// IT DECIDES NOTHING ABOUT SENDING. The sending code (behind POST
// /api/mailchimp/sync) reads the switch and the flows again, itself, right
// before it sends, every time. This only lets the screen say up front what
// the send would say anyway: "on hold" while a flow that emails new contacts
// is live, or while the flows can't be read.
//
// WHAT IS DONE is read from two dates on the location (Kevin's ruling, option
// B, 2026-11-26; migrations/mailchimp_progress_dates.sql):
//   mailchimp_review_done_at — the owner pressed Done on "Who goes to Mailchimp"
//   mailchimp_first_sync_at  — a first sync fully finished (set by the
//                              sending code; a sync that stops partway never sets it)
// They replace two sync_log rows that sync_log's own rules refused, so neither
// was ever saved. The dates are read on their own: if they can't be read (the
// migration not run yet), they read as "not yet" — which only ever asks for
// MORE confirmation, never less.
//
// The one write here is markReviewed: Done sets mailchimp_review_done_at. It
// is a record only; nothing reads it to decide who is sent.

import { supabaseService } from './supabase-service'
import { apiBase } from './mailchimp'
import { scrub } from './mailchimp-audience-look'
import { readFlows, HOW_TO_PAUSE, type FlowsRead, type Flow } from './mailchimp-flows'
import { listRefused } from './mailchimp-refusals'

// The two dates, by name, so the screen, the sending code and the tests share them.
export const REVIEW_DONE_COLUMN = 'mailchimp_review_done_at'
export const FIRST_SYNC_COLUMN = 'mailchimp_first_sync_at'

export type OverviewFlow = { name: string; status: string; subjects: string[] }

export type Overview = {
  live: boolean                       // Kevin's switch
  synced: boolean                     // the first sync fully finished (mailchimp_first_sync_at)
  lastSyncedAt: string | null         // the newest time a person was added or found in Mailchimp
  reviewed: boolean                   // Done was pressed (mailchimp_review_done_at)
  refusedCount: number                // people Mailchimp refused, still on a live record, not left out (0 if unknown)
  audienceCount: number | null        // null = Mailchimp didn't say
  flows:
    | { ok: true; mustPause: OverviewFlow[]; paused: OverviewFlow[] }
    | { ok: false }
  howToPause: string
}

type Deps = {
  db?: any
  fetchImpl?: (url: string, init: any) => Promise<any>
  sleep?: (ms: number) => Promise<void>
  readFlowsImpl?: (args: any) => Promise<FlowsRead>
  listRefusedImpl?: typeof listRefused
}

const line = (f: Flow): OverviewFlow => ({ name: f.name, status: f.status, subjects: f.subjects || [] })

export async function loadOverview(locationUuid: string, deps: Deps = {}): Promise<{ ok: true; overview: Overview } | { ok: false; error: string }> {
  const db = deps.db || supabaseService
  const doFetch = deps.fetchImpl || ((url: string, init: any) => fetch(url, init) as any)
  const flowsOf = deps.readFlowsImpl || readFlows

  const { data: loc, error } = await db
    .from('locations')
    .select('id, mailchimp_connected, mailchimp_access_token, mailchimp_server_prefix, mailchimp_list_id, mailchimp_sync_live')
    .eq('id', locationUuid)
    .maybeSingle()
  if (error || !loc) return { ok: false, error: 'location_not_found' }
  if (!loc.mailchimp_connected || !loc.mailchimp_access_token || !loc.mailchimp_server_prefix || !loc.mailchimp_list_id) {
    return { ok: false, error: 'not_ready' }
  }
  const token = loc.mailchimp_access_token as string
  const prefix = loc.mailchimp_server_prefix as string
  const listId = loc.mailchimp_list_id as string

  // The two dates, on their own read: a failure (the migration not run yet)
  // is "not yet", never "done".
  const dates = await db.from('locations').select('mailchimp_review_done_at, mailchimp_first_sync_at').eq('id', locationUuid).maybeSingle()
  const d: any = dates?.error ? null : dates?.data
  const reviewed = !!d?.mailchimp_review_done_at
  const synced = !!d?.mailchimp_first_sync_at

  // "Last synced": the newest write-back on a person at this location. Every
  // run stamps each person it added or found already there.
  const last = await db.from('leads').select('mailchimp_synced_at').eq('location_uuid', locationUuid)
    .not('mailchimp_synced_at', 'is', null).order('mailchimp_synced_at', { ascending: false }).limit(1)
  const lastSyncedAt: string | null = last?.error ? null : ((last?.data || [])[0]?.mailchimp_synced_at ?? null)

  // The audience's size, one GET. Anything wrong → null ("—" on screen).
  let audienceCount: number | null = null
  try {
    const res = await doFetch(`${apiBase(prefix)}lists/${encodeURIComponent(listId)}?fields=stats.member_count`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    })
    if (res.status >= 200 && res.status < 300) {
      const n = Number(JSON.parse(await res.text())?.stats?.member_count)
      if (Number.isFinite(n)) audienceCount = n
    }
  } catch (e) {
    console.warn('[mailchimp-overview] audience size not read:', scrub((e as any)?.message || e, token))
  }

  // Who Mailchimp refused (lib/mailchimp-refusals.ts). Unknown → 0, the line hides.
  let refusedCount = 0
  try {
    const rf = await (deps.listRefusedImpl || listRefused)(locationUuid, { db })
    if (rf.ok) refusedCount = rf.people.length
  } catch { /* unknown */ }

  const fr = await flowsOf({ token, serverPrefix: prefix, listId, fetchImpl: deps.fetchImpl, sleep: deps.sleep })
  const flows: Overview['flows'] = fr.ok
    ? { ok: true, mustPause: fr.mustPause.map(line), paused: fr.signupFlows.filter((f) => !f.live).map(line) }
    : { ok: false }

  return {
    ok: true,
    overview: { live: loc.mailchimp_sync_live === true, synced, lastSyncedAt, reviewed, refusedCount, audienceCount, flows, howToPause: HOW_TO_PAUSE },
  }
}

export const REVIEW_NOT_SAVED_WORDS = 'Your review couldn’t be saved, so step 1 isn’t ticked yet. Your ticks are kept. Please press Done again. If it keeps happening, tell us through Help.'

// Done on "Who goes to Mailchimp". True only when the date really landed on
// this location's row — the caller says so plainly when it did not.
export async function markReviewed(locationUuid: string, deps: { db?: any; now?: () => Date } = {}): Promise<boolean> {
  const db = deps.db || supabaseService
  const at = (deps.now ? deps.now() : new Date()).toISOString()
  const res = await db.from('locations').update({ mailchimp_review_done_at: at }).eq('id', locationUuid).select('id')
  return !res?.error && (res?.data || []).length === 1
}

// The connection screen's state, from the overview. Kept here so the screen and
// its tests share one rule.
//   blocked  — a flow that emails new contacts is live, or the flows couldn't be read
//   running  — a run has finished completely before
//   setup    — never synced
export type ConnectionState = 'setup' | 'running' | 'blocked'
export function connectionState(o: Pick<Overview, 'synced' | 'flows'>): ConnectionState {
  if (!o.flows.ok || o.flows.mustPause.length > 0) return 'blocked'
  return o.synced ? 'running' : 'setup'
}

// May the first-sync / Sync now button be pressed? Never while blocked, never
// while the switch is off, and the first sync only after the review.
export function canStart(state: ConnectionState, o: Pick<Overview, 'live' | 'reviewed'>): boolean {
  if (state === 'blocked' || !o.live) return false
  return state === 'running' || o.reviewed
}
