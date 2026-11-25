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
// The one write is markReviewed: when the owner presses Done on "Who goes to
// Mailchimp", one sync_log row (entity_type 'mailchimp_review') records that
// the review was finished, so step 1 stays ticked after a reload. It is a
// record only; nothing reads it to decide who is sent.

import { supabaseService } from './supabase-service'
import { apiBase } from './mailchimp'
import { scrub } from './mailchimp-audience-look'
import { readFlows, HOW_TO_PAUSE, type FlowsRead, type Flow } from './mailchimp-flows'

export const REVIEW_ENTITY = 'mailchimp_review'
// The sending code's run record (its RUN_ENTITY). The same string, written
// out here; a test pins that the two never drift apart.
export const RUN_RECORD = 'mailchimp_push'

export type OverviewFlow = { name: string; status: string; subjects: string[] }

export type Overview = {
  live: boolean                       // Kevin's switch
  synced: boolean                     // a run has finished completely
  lastRun: { at: string; complete: boolean; added: number; remaining: number } | null
  reviewed: boolean
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

  // Runs, newest first. A failed read is "don't know", shown as never synced —
  // which only ever asks for MORE confirmation, never less (the send decides
  // "first" for itself).
  const runs = await db.from('sync_log').select('status, message, created_at')
    .eq('entity_type', RUN_RECORD).eq('entity_id', locationUuid)
    .order('created_at', { ascending: false }).limit(20)
  const runRows: any[] = runs?.error ? [] : (runs?.data || [])
  const synced = runRows.some((r) => r.status === 'complete')
  let lastRun: Overview['lastRun'] = null
  if (runRows[0]) {
    let m: any = {}
    try { m = JSON.parse(String(runRows[0].message || '{}')) } catch { m = {} }
    lastRun = { at: String(runRows[0].created_at), complete: runRows[0].status === 'complete', added: Number(m.added) || 0, remaining: Number(m.remaining) || 0 }
  }

  // Reviewed: Done was pressed on the review screen, or a choice was saved there.
  const [rev, ch] = await Promise.all([
    db.from('sync_log').select('id').eq('entity_type', REVIEW_ENTITY).eq('entity_id', locationUuid).limit(1),
    db.from('mailchimp_review_choices').select('key').eq('location_id', locationUuid).limit(1),
  ])
  const reviewed = (!rev?.error && (rev?.data || []).length > 0) || (!ch?.error && (ch?.data || []).length > 0)

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

  const fr = await flowsOf({ token, serverPrefix: prefix, listId, fetchImpl: deps.fetchImpl, sleep: deps.sleep })
  const flows: Overview['flows'] = fr.ok
    ? { ok: true, mustPause: fr.mustPause.map(line), paused: fr.signupFlows.filter((f) => !f.live).map(line) }
    : { ok: false }

  return {
    ok: true,
    overview: { live: loc.mailchimp_sync_live === true, synced, lastRun, reviewed, audienceCount, flows, howToPause: HOW_TO_PAUSE },
  }
}

export async function markReviewed(locationUuid: string, deps: { db?: any } = {}): Promise<boolean> {
  const db = deps.db || supabaseService
  const { data: loc } = await db.from('locations').select('location_id').eq('id', locationUuid).maybeSingle()
  const res = await db.from('sync_log').insert({
    location_id: (loc?.location_id as string) || locationUuid,
    direction: 'internal',
    entity_type: REVIEW_ENTITY,
    entity_id: locationUuid,
    status: 'reviewed',
    message: 'Done pressed on Who goes to Mailchimp',
  })
  return !res?.error
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
