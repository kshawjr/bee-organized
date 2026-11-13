// lib/engagement-bees.ts
// ─────────────────────────────────────────────────────────────
// Bees on a job, and the job's Slack channel (Slack job channels, slice 3).
//
//   PART A — engagement_bees (migrations/engagement_bees.sql): which roster
//   bees are on which engagement. Works for every location, Slack or not.
//   Unassigning stamps removed_at; nothing is ever deleted.
//
//   PART B — a public Slack channel per job, made only when an owner presses
//   "Put this job in Slack". Ticking a bee invites them, unticking kicks
//   them, on the request. A sweep (sweepJobChannels, /api/cron/job-channels)
//   archives the channel of a closed job and unarchives a reopened one.
//
//   PART C — what Slack would not do, KEPT ON THE JOB (2026-11-13). Anyone
//   who could not be put in (or taken out of) the channel — a bee, or the
//   location's owner — is stored on the engagement and shown under the Bees
//   cell every time the job is opened, by whoever opens it. See "What Slack
//   would not do" below for where it is written, how it is retried and how
//   it goes away.
//
// BEES ARE NOT ASSIGNEES. Nothing here reads or writes engagement_assignees
// or calls Jobber. Bees sync to Slack; assignees sync to Jobber.
//
// THE ASSIGNMENT IS THE TRUTH. A Slack failure never rolls an assignment
// back. Every failure comes back as a BeeSlackOutcome the screen turns into
// one plain line (components/hive/shared/BeeSlackStatus.jsx).
//
// SERVER-ONLY. slack_bot_token goes into fetch's Authorization header and
// nowhere else — never a return value, a log line or an error message. Log
// lines carry ids and Slack's own error code only.
// ─────────────────────────────────────────────────────────────
import { BEE_COLUMNS, type BeeRow, type PublicBee, lookupSlackUserByEmail, toPublicBee } from '@/lib/location-bees'
import { slackCanManageChannels } from '@/lib/slack-scopes'
import { recordSlackMissingScope } from '@/lib/slack-scopes-server'

export type Db = { from: (table: string) => any }

const SLACK_API = 'https://slack.com/api/'
const SLACK_TIMEOUT_MS = 8000

// ── "the migration hasn't run yet" ───────────────────────────
// Postgres: relation "public.x" does not exist / column x does not exist.
// PostgREST: Could not find the table 'public.x' in the schema cache.
const notSetUp = (msg: unknown, what: RegExp) =>
  typeof msg === 'string' && what.test(msg) && /does not exist|schema cache|could not find/i.test(msg)
export const beesTableMissing = (msg: unknown) => notSetUp(msg, /engagement_bees|location_bees/)
export const channelColumnsMissing = (msg: unknown) => notSetUp(msg, /slack_channel/)

// The channel-name rule lives in lib/slack-channel-name.ts (pure, so the
// create dialog can preview the exact name).
export { SLACK_CHANNEL_MAX, slugForSlack, slackJobChannelName, isValidSlackChannelName } from '@/lib/slack-channel-name'
import { slackJobChannelName } from '@/lib/slack-channel-name'
import { engagementHasJob } from '@/lib/engagement-has-job'
import { postJobCard, type CardResult } from '@/lib/job-channel-card'

// ── One Slack Web API call ───────────────────────────────────
// Never throws. A transport failure comes back as Slack-shaped
// { ok:false, error:'network' | 'timeout' | 'http_NNN' } so every caller has
// one shape to read. The token is in the header and nowhere else.
export async function slackApi(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SLACK_TIMEOUT_MS)
  try {
    const res = await fetch(SLACK_API + method, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, error: `http_${res.status}` }
    const j = await res.json().catch(() => null)
    return j && typeof j === 'object' ? j : { ok: false, error: 'bad_response' }
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

const slackErr = (j: any) => (typeof j?.error === 'string' ? j.error.slice(0, 60) : 'unknown')

// ── The location's Slack, read once per request ──────────────
export type LocationSlack = {
  connected: boolean
  canManageChannels: boolean
  token: string | null // SERVER-ONLY — never put this in a response
}

export async function readLocationSlackFull(db: Db, locationUuid: string): Promise<LocationSlack> {
  const none: LocationSlack = { connected: false, canManageChannels: false, token: null }
  try {
    let { data, error } = await db.from('locations')
      .select('slack_connected, slack_bot_token, slack_scopes').eq('id', locationUuid).maybeSingle()
    if (error && /slack_scopes/.test(error.message || '')) {
      // slice 1's column not added yet → scopes unknown → not ready.
      ;({ data, error } = await db.from('locations')
        .select('slack_connected, slack_bot_token').eq('id', locationUuid).maybeSingle())
    }
    if (error || !data) return none
    const token = typeof data.slack_bot_token === 'string' && data.slack_bot_token ? data.slack_bot_token : null
    const connected = data.slack_connected === true && !!token
    return { connected, token, canManageChannels: connected && slackCanManageChannels(data) }
  } catch {
    return none
  }
}

// ── The engagement, with or without the channel columns ──────
export type EngagementForBees = {
  id: string
  location_uuid: string
  client_id: string | null // leads.id — the engagement has NO name of its own
  project_type: string | null
  closed_at: string | null
  slack_channel_id: string | null
  slack_channel_name: string | null
  slack_channel_archived_at: string | null
  slack_channel_problems: ChannelProblems | null // who could not be put in / taken out of the channel (PART C)
  channelColumns: boolean // false until migrations/engagement_slack_channel.sql runs
}

// REAL COLUMNS ONLY. `engagements` has client_id (→ leads.id) and no
// client_name: the name lives on the lead (readClientName). Selecting a
// column that does not exist fails the WHOLE read — which took the Bees cell
// and the sweep down on 2026-11-12. lib/beta-db-columns.test.ts checks every
// select in the app against the real schema so that cannot ship again.
const ENG_BASE = 'id, location_uuid, client_id, project_type, closed_at'
const ENG_CHANNEL = 'slack_channel_id, slack_channel_name, slack_channel_archived_at, slack_channel_problems'

export async function loadEngagementForBees(db: Db, id: string): Promise<EngagementForBees | null> {
  let { data, error } = await db.from('engagements').select(`${ENG_BASE}, ${ENG_CHANNEL}`).eq('id', id).maybeSingle()
  let channelColumns = true
  if (error && channelColumnsMissing(error.message)) {
    channelColumns = false
    ;({ data, error } = await db.from('engagements').select(ENG_BASE).eq('id', id).maybeSingle())
  }
  if (error || !data) return null
  return {
    id: data.id,
    location_uuid: data.location_uuid,
    client_id: data.client_id ?? null,
    project_type: data.project_type ?? null,
    closed_at: data.closed_at ?? null,
    slack_channel_id: channelColumns ? data.slack_channel_id ?? null : null,
    slack_channel_name: channelColumns ? data.slack_channel_name ?? null : null,
    slack_channel_archived_at: channelColumns ? data.slack_channel_archived_at ?? null : null,
    slack_channel_problems: channelColumns ? readProblems(data.slack_channel_problems) : null,
    channelColumns,
  }
}

// The client's name, from the lead the engagement belongs to — the same
// place the hub page gets it (leads.name by engagements.client_id). Only the
// channel name and its opening message need it, so it is read when a channel
// is made, not on every open of a job.
//   { ok: true, name }  → the name (null when the lead has none)
//   { ok: false }       → the read FAILED; the caller makes nothing rather
//                         than a channel named after the project type alone.
export async function readClientName(db: Db, clientId: string | null): Promise<{ ok: true; name: string | null } | { ok: false }> {
  if (!clientId) return { ok: true, name: null }
  try {
    const { data, error } = await db.from('leads').select('name').eq('id', clientId).maybeSingle()
    if (error) { console.warn('[engagement-bees] client name not read for lead', clientId, '—', error.message); return { ok: false } }
    const name = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : null
    return { ok: true, name }
  } catch (e: any) {
    console.warn('[engagement-bees] client name not read for lead', clientId, '—', e?.name || 'error')
    return { ok: false }
  }
}

// ── Part A: who is on the job ────────────────────────────────
export type AssignedBee = PublicBee & { assigned_at: string }

export type BeesRead =
  | { setUp: true; assigned: AssignedBee[]; roster: PublicBee[] }
  | { setUp: false }
  | { setUp: true; error: string }

export async function readEngagementBees(db: Db, eng: { id: string; location_uuid: string }): Promise<BeesRead> {
  const [live, roster] = await Promise.all([
    db.from('engagement_bees').select('bee_id, assigned_at, removed_at').eq('engagement_id', eng.id),
    db.from('location_bees').select(BEE_COLUMNS).eq('location_uuid', eng.location_uuid),
  ])
  if (live.error || roster.error) {
    const msg = live.error?.message || roster.error?.message
    if (beesTableMissing(msg)) return { setUp: false }
    return { setUp: true, error: String(msg || 'read_failed') }
  }
  const byId = new Map<string, BeeRow>(((roster.data || []) as BeeRow[]).map(b => [b.id, b]))
  const assigned: AssignedBee[] = ((live.data || []) as any[])
    .filter(r => !r.removed_at && byId.has(r.bee_id))
    .sort((a, b) => String(a.assigned_at).localeCompare(String(b.assigned_at)))
    .map(r => ({ ...toPublicBee(byId.get(r.bee_id)!), assigned_at: r.assigned_at }))
  const rosterOut = ((roster.data || []) as BeeRow[])
    .filter(b => b.is_active !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toPublicBee)
  return { setUp: true, assigned, roster: rosterOut }
}

// Put a bee on a job (idempotent). Reassigning clears removed_at on the SAME
// row. Returns false + an error string on a write failure.
export async function assignBee(db: Db, engagementId: string, beeId: string): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const now = new Date().toISOString()
  const { data: rows, error } = await db.from('engagement_bees').select('id, removed_at')
    .eq('engagement_id', engagementId).eq('bee_id', beeId)
  if (error) return { ok: false, error: error.message }
  const row = (rows || [])[0]
  if (row && !row.removed_at) return { ok: true, changed: false }
  if (row) {
    const { error: e2 } = await db.from('engagement_bees')
      .update({ removed_at: null, assigned_at: now, updated_at: now }).eq('id', row.id)
    return e2 ? { ok: false, error: e2.message } : { ok: true, changed: true }
  }
  const { error: e3 } = await db.from('engagement_bees').insert({ engagement_id: engagementId, bee_id: beeId })
  if (e3?.code === '23505') return { ok: true, changed: false } // added a moment ago
  return e3 ? { ok: false, error: e3.message } : { ok: true, changed: true }
}

// Take a bee off a job. Stamps removed_at — NEVER deletes.
export async function unassignBee(db: Db, engagementId: string, beeId: string): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const now = new Date().toISOString()
  const { data: rows, error } = await db.from('engagement_bees').select('id, removed_at')
    .eq('engagement_id', engagementId).eq('bee_id', beeId)
  if (error) return { ok: false, error: error.message }
  const row = (rows || [])[0]
  if (!row || row.removed_at) return { ok: true, changed: false }
  const { error: e2 } = await db.from('engagement_bees')
    .update({ removed_at: now, updated_at: now }).eq('id', row.id)
  return e2 ? { ok: false, error: e2.message } : { ok: true, changed: true }
}

// ── Part B: mirroring one bee into the channel ───────────────
// What the screen is told. 'ok' is silent. Every other status is one line.
export type BeeSlackOutcome =
  | { status: 'ok' }
  | { status: 'still_in_channel'; bee: string; channel: string | null } // kick refused by the workspace
  | { status: 'add_refused'; bee: string }                              // invite refused by the workspace
  | { status: 'not_in_slack'; bee: string; email: string }
  | { status: 'scope_lost' }
  | { status: 'channel_gone' }
  | { status: 'archived' }
  | { status: 'unavailable'; bee: string; action: 'add' | 'remove' }
  // The location's OWNER, at channel creation only (owners are not bees):
  | { status: 'owner_not_in_slack'; bee: string; email: string } // nobody in this Slack has their Bee Hub email
  | { status: 'owner_not_added'; bee: string }                   // found, or not looked up, but not added

// Re-ask Slack who has this email, store the answer. null = nobody.
// 'unavailable' leaves the stored id alone ("Slack was down" ≠ "nobody").
async function relookup(db: Db, token: string, bee: BeeRow): Promise<string | null | 'unavailable'> {
  const r = await lookupSlackUserByEmail(token, bee.email)
  if (r.status === 'unavailable') return 'unavailable'
  const id = r.status === 'found' ? r.slackUserId : null
  const now = new Date().toISOString()
  try {
    const { error } = await db.from('location_bees')
      .update({ slack_user_id: id, slack_checked_at: now, updated_at: now }).eq('id', bee.id)
    if (error) console.warn('[engagement-bees] Slack id not stored for bee', bee.id, '—', error.message)
  } catch { /* the call still goes ahead with the fresh id */ }
  bee.slack_user_id = id
  bee.slack_checked_at = now
  return id
}

export async function mirrorBee(
  db: Db,
  args: { token: string; locationUuid: string; engagementId: string; channelId: string; channelName: string | null; bee: BeeRow; action: 'add' | 'remove' },
): Promise<BeeSlackOutcome> {
  const { token, locationUuid, engagementId, channelId, channelName, bee, action } = args
  const method = action === 'add' ? 'conversations.invite' : 'conversations.kick'
  const call = (uid: string) => slackApi(token, method, action === 'add' ? { channel: channelId, users: uid } : { channel: channelId, user: uid })
  const log = (code: string) =>
    console.warn(`[engagement-bees] ${method} engagement=${engagementId} bee=${bee.id} → ${code}`)

  // No cached id (never checked, or nobody had the email when checked —
  // and this location may have reconnected to another workspace since):
  // ask Slack now.
  let uid: string | null | 'unavailable' = bee.slack_user_id
  let lookedUp = false
  if (!uid) {
    uid = await relookup(db, token, bee)
    lookedUp = true
    if (uid === 'unavailable') { log('lookup_unavailable'); return { status: 'unavailable', bee: bee.name, action } }
    if (!uid) {
      // Nobody in this Slack has the email. On remove there's nobody to take
      // out; on add, point at the email.
      if (action === 'remove') return { status: 'ok' }
      log('user_not_found')
      return { status: 'not_in_slack', bee: bee.name, email: bee.email }
    }
  }

  let j = await call(uid)

  // A cached id rejected: the location probably reconnected to a DIFFERENT
  // workspace (a Slack user id is valid in one workspace only). Look the
  // email up again, store the new id, retry ONCE.
  if (!j.ok && j.error === 'user_not_found' && !lookedUp) {
    const fresh = await relookup(db, token, bee)
    if (fresh === 'unavailable') { log('lookup_unavailable'); return { status: 'unavailable', bee: bee.name, action } }
    if (!fresh) {
      if (action === 'remove') return { status: 'ok' }
      log('user_not_found')
      return { status: 'not_in_slack', bee: bee.name, email: bee.email }
    }
    j = await call(fresh)
  }

  if (j.ok) return { status: 'ok' }
  const code = slackErr(j)
  if (code === 'already_in_channel' || code === 'not_in_channel' || code === 'cant_invite_self' || code === 'cant_kick_self') {
    return { status: 'ok' }
  }
  log(code)
  if (code === 'restricted_action') {
    return action === 'remove'
      ? { status: 'still_in_channel', bee: bee.name, channel: channelName }
      : { status: 'add_refused', bee: bee.name }
  }
  if (code === 'missing_scope') {
    await recordSlackMissingScope(locationUuid, j)
    return { status: 'scope_lost' }
  }
  if (code === 'channel_not_found') {
    await forgetChannel(db, engagementId)
    return { status: 'channel_gone' }
  }
  if (code === 'is_archived') return { status: 'archived' }
  if (code === 'user_not_found') return action === 'remove' ? { status: 'ok' } : { status: 'not_in_slack', bee: bee.name, email: bee.email }
  return { status: 'unavailable', bee: bee.name, action }
}

// The channel was deleted in Slack: forget it so the owner is offered a new one.
export async function forgetChannel(db: Db, engagementId: string) {
  try {
    const { error } = await db.from('engagements')
      .update({ slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null, slack_channel_problems: null }).eq('id', engagementId)
    if (error) console.warn('[engagement-bees] could not forget channel for', engagementId, '—', error.message)
  } catch { /* logged above when it answers */ }
}

export async function readBeeRow(db: Db, beeId: string): Promise<BeeRow | null> {
  const { data, error } = await db.from('location_bees').select(BEE_COLUMNS).eq('id', beeId).maybeSingle()
  if (error || !data) return null
  return data as BeeRow
}

// ── Part B: making the channel ───────────────────────────────
export type CreateResult =
  | { ok: true; channel: { id: string; name: string }; already: boolean; problems: BeeSlackOutcome[]; owners: { invited: number; notInSlack: number }; ownerProblems?: BeeSlackOutcome[]; card?: CardResult; stored?: ChannelProblems | null }
  | { ok: false; reason: 'not_set_up_yet' | 'not_ready' | 'closed' | 'no_job' | 'job_unreadable' | 'scope_lost' | 'name_unavailable' | 'slack_unavailable' | 'store_failed' | 'client_unreadable' }

const NAME_ATTEMPTS = 6

export async function createJobChannel(
  db: Db,
  args: { eng: EngagementForBees; slack: LocationSlack; baseUrl: string | null },
): Promise<CreateResult> {
  const { eng, slack, baseUrl } = args
  if (!eng.channelColumns) return { ok: false, reason: 'not_set_up_yet' }
  if (eng.slack_channel_id) {
    return { ok: true, already: true, channel: { id: eng.slack_channel_id, name: eng.slack_channel_name || '' }, problems: [], owners: { invited: 0, notInSlack: 0 } }
  }
  if (eng.closed_at) return { ok: false, reason: 'closed' }
  if (!slack.connected || !slack.token || !slack.canManageChannels) return { ok: false, reason: 'not_ready' }
  const token = slack.token

  // A job must exist. Checked HERE — the one function the Slack mark's route
  // and automatic channels both call — and before anything is asked of Slack,
  // so a forged request and a notice out of order get the same answer.
  const hasJob = await engagementHasJob(db, eng.id)
  if (hasJob === 'unknown') return { ok: false, reason: 'job_unreadable' }
  if (!hasJob) return { ok: false, reason: 'no_job' }

  // Bees must be readable BEFORE a channel exists — if the table isn't
  // there yet, make nothing.
  const bees = await readEngagementBees(db, eng)
  if (!bees.setUp) return { ok: false, reason: 'not_set_up_yet' }

  // The channel is named for the client, and the client's name is on the
  // lead. Read BEFORE anything is made; a failed read makes nothing.
  const client = await readClientName(db, eng.client_id)
  if (!client.ok) return { ok: false, reason: 'client_unreadable' }
  const clientName = client.name

  // conversations.create, retrying name_taken with -2, -3, …
  let created: { id: string; name: string } | null = null
  for (let i = 0; i < NAME_ATTEMPTS && !created; i++) {
    const name = slackJobChannelName(clientName, eng.project_type, i === 0 ? '' : `-${i + 1}`)
    const j = await slackApi(token, 'conversations.create', { name, is_private: false })
    if (j.ok && j.channel?.id) { created = { id: String(j.channel.id), name: String(j.channel.name || name) }; break }
    const code = slackErr(j)
    console.warn(`[engagement-bees] conversations.create engagement=${eng.id} name=${name} → ${code}`)
    if (code === 'name_taken') continue
    if (code === 'missing_scope') { await recordSlackMissingScope(eng.location_uuid, j); return { ok: false, reason: 'scope_lost' } }
    return { ok: false, reason: 'slack_unavailable' }
  }
  if (!created) return { ok: false, reason: 'name_unavailable' }

  // Remember it — only if nobody else made one in the meantime (a double
  // press). The loser archives its own channel and uses the winner's.
  const { data: stored, error: storeErr } = await db.from('engagements')
    .update({ slack_channel_id: created.id, slack_channel_name: created.name, slack_channel_archived_at: null })
    .eq('id', eng.id).is('slack_channel_id', null).select('id')
  if (storeErr || !stored || (Array.isArray(stored) && stored.length === 0)) {
    await slackApi(token, 'conversations.archive', { channel: created.id })
    if (storeErr) { console.error('[engagement-bees] channel made but not stored for', eng.id, '—', storeErr.message); return { ok: false, reason: 'store_failed' } }
    const again = await loadEngagementForBees(db, eng.id)
    if (again?.slack_channel_id) return { ok: true, already: true, channel: { id: again.slack_channel_id, name: again.slack_channel_name || '' }, problems: [], owners: { invited: 0, notInSlack: 0 } }
    return { ok: false, reason: 'store_failed' }
  }

  // Who goes in: the bot (already in — it made the channel), the ticked
  // bees, and the location's owner(s) by email.
  const problems: BeeSlackOutcome[] = []
  const keep: ChannelProblem[] = []
  let gone = false
  if ('assigned' in bees) {
    for (const b of bees.assigned) {
      const row = await readBeeRow(db, b.id)
      if (!row) continue
      const o = await mirrorBee(db, { token, locationUuid: eng.location_uuid, engagementId: eng.id, channelId: created.id, channelName: created.name, bee: row, action: 'add' })
      if (o.status !== 'ok') { problems.push(o); keep.push({ ...o, bee_id: row.id }) }
      if (o.status === 'channel_gone') gone = true
      if (o.status === 'scope_lost' || o.status === 'channel_gone') break
    }
  }
  const owners = await inviteOwners(db, token, eng, created.id)
  keep.push(...owners.kept)

  // KEEP IT ON THE JOB. Until 2026-11-13 these went back to the page that
  // pressed the button and nowhere else: closing the job's card lost them,
  // and a channel made automatically (no page at all) never told anyone.
  // Stored, they show under the Bees cell for whoever opens the job next.
  let kept: ChannelProblems | null = null
  if (keep.length && !gone) {
    const at = new Date().toISOString()
    kept = { at, items: keep.map(p => ({ ...p, from: 'created' as const, since: at, tried_at: at })) }
    await storeProblems(db, eng.id, kept)
  }

  const url = baseUrl && eng.client_id ? `${baseUrl.replace(/\/$/, '')}/clients/${eng.client_id}?e=${eng.id}` : null
  // The job card (lib/job-channel-card.ts): the channel's first message,
  // then pinned. HERE and nowhere else — this branch runs once per channel,
  // for the caller that made it and won the write above — so a channel never
  // gets a second card. After the people are in, so nothing about who is in
  // the channel depends on it. A card that fails to post, or a pin Slack
  // refuses (no pins:write until the location reconnects), changes nothing:
  // the channel is made either way.
  const card = await postJobCard(db, {
    slackApi, token, channelId: created.id, engagementId: eng.id, locationUuid: eng.location_uuid,
    clientId: eng.client_id, clientName, projectType: eng.project_type, url,
  })

  return { ok: true, already: false, channel: created, problems, owners: { invited: owners.invited, notInSlack: owners.notInSlack }, ownerProblems: owners.missed, card, stored: kept }
}

// The location's owners (hub_users role 'owner'), looked up by email in this
// Slack. Not bees: they are never in engagement_bees, so unticking can't
// remove them. Best effort — a miss never fails the channel — but NEVER
// SILENT: the dialog says "the owner is added too", so every owner who was
// not added comes back in `missed` and is named on the screen. The common
// one is an owner whose Bee Hub email is not the email they use in Slack;
// we can name the email we looked for, not the one Slack knows them by.
type OwnerRow = { id: string; email: string | null; full_name?: string | null }

// One owner into one channel. `miss` is null when they are in (added now, or
// already there). `code` is Slack's own word for a refused invite.
async function inviteOneOwner(token: string, channelId: string, u: OwnerRow): Promise<{ miss: BeeSlackOutcome | null; code?: string }> {
  const email = String(u.email || '')
  const who = (typeof u.full_name === 'string' && u.full_name.trim()) || email
  const r = await lookupSlackUserByEmail(token, email)
  if (r.status === 'not_found') return { miss: { status: 'owner_not_in_slack', bee: who, email } }
  if (r.status !== 'found') return { miss: { status: 'owner_not_added', bee: who } }
  const j = await slackApi(token, 'conversations.invite', { channel: channelId, users: r.slackUserId })
  if (j.ok || j.error === 'already_in_channel' || j.error === 'cant_invite_self') return { miss: null }
  return { miss: { status: 'owner_not_added', bee: who }, code: slackErr(j) }
}

async function inviteOwners(db: Db, token: string, eng: EngagementForBees, channelId: string) {
  const out = { invited: 0, notInSlack: 0, missed: [] as BeeSlackOutcome[], kept: [] as ChannelProblem[] }
  try {
    const { data } = await db.from('hub_users').select('id, email, role, full_name').eq('location_id', eng.location_uuid).eq('role', 'owner')
    for (const u of (data || []) as any[]) {
      if (!u.email) continue
      const r = await inviteOneOwner(token, channelId, u)
      if (!r.miss) { out.invited++; continue }
      if (r.miss.status === 'owner_not_in_slack') out.notInSlack++
      out.missed.push(r.miss)
      out.kept.push({ ...r.miss, user_id: String(u.id) })
      if (r.code) console.warn(`[engagement-bees] owner invite engagement=${eng.id} user=${u.id} → ${r.code}`)
    }
  } catch (e: any) {
    console.warn('[engagement-bees] owner invite skipped for', eng.id, '—', e?.name || 'error')
  }
  return out
}

// ── The sweep: archive closed jobs' channels, unarchive reopened ones ──
// One place that catches every close path (there are at least five) and any
// added later. Safe to run twice: a stamped row no longer matches.
export type SweepResult = {
  ok: boolean
  not_set_up_yet?: boolean
  archived: number
  unarchived: number
  gone: number      // channel_not_found — forgotten, not a failure
  no_slack: number  // location disconnected — left for later
  failed: number
  reconcile_problems: number // bee-level misses on unarchive — stored on the job for its owner
}

const SWEEP_LIMIT = 200

export async function sweepJobChannels(db: Db): Promise<SweepResult> {
  const r: SweepResult = { ok: true, archived: 0, unarchived: 0, gone: 0, no_slack: 0, failed: 0, reconcile_problems: 0 }
  const cols = 'id, location_uuid, closed_at, slack_channel_id, slack_channel_name, slack_channel_archived_at'
  const [toArchive, toUnarchive] = await Promise.all([
    db.from('engagements').select(cols)
      .not('slack_channel_id', 'is', null).not('closed_at', 'is', null).is('slack_channel_archived_at', null)
      .limit(SWEEP_LIMIT),
    db.from('engagements').select(cols)
      .not('slack_channel_id', 'is', null).is('closed_at', null).not('slack_channel_archived_at', 'is', null)
      .limit(SWEEP_LIMIT),
  ])
  const err = toArchive.error || toUnarchive.error
  if (err) {
    if (channelColumnsMissing(err.message)) return { ...r, not_set_up_yet: true }
    console.error('[engagement-bees] sweep read failed —', err.message)
    return { ...r, ok: false }
  }

  const slackByLoc = new Map<string, LocationSlack>()
  const slackFor = async (loc: string) => {
    if (!slackByLoc.has(loc)) slackByLoc.set(loc, await readLocationSlackFull(db, loc))
    return slackByLoc.get(loc)!
  }

  const run = async (row: any, archive: boolean) => {
    const slack = await slackFor(row.location_uuid)
    if (!slack.connected || !slack.token) { r.no_slack++; return }
    const j = await slackApi(slack.token, archive ? 'conversations.archive' : 'conversations.unarchive', { channel: row.slack_channel_id })
    const code = j.ok ? 'ok' : slackErr(j)
    if (code === 'ok' || code === (archive ? 'already_archived' : 'not_archived')) {
      const { error } = await db.from('engagements')
        .update({ slack_channel_archived_at: archive ? new Date().toISOString() : null }).eq('id', row.id)
      if (error) { r.failed++; console.error('[engagement-bees] sweep stamp failed', row.id, '—', error.message); return }
      if (archive) r.archived++
      else {
        r.unarchived++
        const rec = await reconcileChannelBees(db, { token: slack.token, engagementId: row.id, locationUuid: row.location_uuid, channelId: row.slack_channel_id, channelName: row.slack_channel_name ?? null, from: 'reopened' })
        r.reconcile_problems += rec.problems.length
      }
      return
    }
    if (code === 'channel_not_found') { await forgetChannel(db, row.id); r.gone++; return }
    if (code === 'missing_scope') await recordSlackMissingScope(row.location_uuid, j)
    r.failed++
    console.warn(`[engagement-bees] sweep ${archive ? 'archive' : 'unarchive'} engagement=${row.id} → ${code}`)
  }

  for (const row of toArchive.data || []) await run(row, true)
  for (const row of toUnarchive.data || []) await run(row, false)
  r.ok = r.failed === 0
  return r
}

// ── Reconcile: make the channel match the job, both directions ──
// Slack's unarchive restores the channel WITH the members it had when it was
// archived — including bees taken off the job in between. So after an
// unarchive, against the bees on the job at that moment:
//   · on the job, not in the channel → invite   (already_in_channel: silent)
//   · taken off the job, still in it → remove   (not_in_channel: silent)
// The SAME mirrorBee and error table as the live toggle — restricted_action
// is "still_in_channel" here exactly as there, and the bee stays off the job.
//
// Who is a candidate for removal: ONLY bees with an engagement_bees row for
// this job that is stamped removed_at. Never the Bee Hub app, never the
// location's owners (invited by email, not bees — skipped even when an
// owner's email is also on the roster), never anyone added by hand in Slack.
// No conversations.members read: that needs channels:read, which we don't
// require, and the per-bee answers already say "not in channel" for free.
//
// Bee Hub's assignment is never changed here.
//
// ── What Slack would not do (PART C) ─────────────────────────
// ONE STORE: engagements.slack_channel_problems, a small list. A bee's miss
// and the owner's miss sit in the same list and are told apart by what they
// are (`bee_id` or `user_id`, and the status). One list because every reader
// wants all of it at once, and a channel deleted in Slack forgets all of it
// at once (forgetChannel).
//
// WRITTEN FROM THREE PLACES, each saying which (`from`):
//   'created'   createJobChannel — the Slack mark AND automatic channels
//   'crew'      the crew changed in Jobber and the channel was brought in line
//   'reopened'  the job reopened and its channel was unarchived
//
// HOW A LINE GOES AWAY:
//   · it stops being true. Every run of the 15-minute cron looks at the
//     stored lines (sweepChannelProblems) and tries again the ones that are
//     DUE; one that now works is removed. That is the only way a line is
//     deleted, apart from the channel itself going.
//   · "Got it" only HIDES the lines from the page (seen_at). They are still
//     tried again, so a fix is still picked up after someone tapped it.
//
// WHEN A LINE IS DUE (problemDue) — never "every 15 minutes, for ever":
//   · something changed on OUR side since it was last tried: the email we
//     looked for is no longer the person's email in Bee Hub, or Bee Hub has
//     since found the bee in Slack. Tried on the next run.
//   · otherwise once a day (PROBLEM_RETRY_MS). That is what picks up a fix
//     made only in Slack — the person joined, or took that email there —
//     which Bee Hub cannot see happen.
//   · a miss that may only have been Slack having a bad minute ('unavailable',
//     'owner_not_added') is tried every run for its first hour, then daily.
// A change of crew, or a reopen, brings the whole channel in line at once and
// does not wait for any of this.
export type ChannelProblem = BeeSlackOutcome & {
  bee_id?: string    // a bee's line
  user_id?: string   // the owner's line (hub_users.id)
  from?: 'created' | 'crew' | 'reopened'
  since?: string     // when this line first became true
  tried_at?: string  // when Slack was last asked
  seen_at?: string   // someone tapped Got it — hidden, still tried
}
export type ChannelProblems = { at: string; items: ChannelProblem[] }

export const PROBLEM_RETRY_MS = 24 * 60 * 60 * 1000
export const PROBLEM_QUICK_MS = 60 * 60 * 1000
const SETTLED = new Set(['not_in_slack', 'add_refused', 'still_in_channel', 'owner_not_in_slack'])
const emailKeyOf = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
export const isOwnerProblem = (p: { status: string }) => p.status === 'owner_not_in_slack' || p.status === 'owner_not_added'

export function problemDue(
  p: ChannelProblem, nowMs: number,
  current: { email?: string | null; slackUserId?: string | null; slackCheckedAt?: string | null } = {},
): boolean {
  const tried = Date.parse(p.tried_at || '')
  if (!Number.isFinite(tried)) return true // stored before retries were paced: once, then it is stamped
  if (p.status === 'not_in_slack' || p.status === 'owner_not_in_slack') {
    if (current.email != null && emailKeyOf(current.email) !== emailKeyOf((p as any).email)) return true
  }
  if (p.status === 'not_in_slack' && current.slackUserId && Date.parse(current.slackCheckedAt || '') > tried) return true
  const since = Date.parse(p.since || '')
  if (!SETTLED.has(p.status) && Number.isFinite(since) && nowMs - since < PROBLEM_QUICK_MS) return true
  return nowMs - tried >= PROBLEM_RETRY_MS
}

export function readProblems(raw: unknown): ChannelProblems | null {
  if (!raw || typeof raw !== 'object') return null
  const items = Array.isArray((raw as any).items) ? (raw as any).items.filter((x: any) => x && typeof x.status === 'string') : []
  return items.length ? { at: String((raw as any).at || ''), items } : null
}

// What the page is shown: everything nobody has tapped Got it on.
export function visibleProblems(p: ChannelProblems | null | undefined): ChannelProblems | null {
  const items = (p?.items || []).filter(x => !x.seen_at)
  return items.length ? { at: p!.at, items } : null
}

export async function storeProblems(db: Db, engagementId: string, problems: ChannelProblems | null) {
  try {
    const { error } = await db.from('engagements').update({ slack_channel_problems: problems }).eq('id', engagementId)
    if (error) console.warn('[engagement-bees] channel problems not stored for', engagementId, '—', error.message)
  } catch { /* logged above when it answers */ }
}

// "Got it": hide every line from the page. Nothing is deleted — a line only
// goes when it stops being true.
export async function markProblemsSeen(db: Db, engagementId: string, problems: ChannelProblems | null) {
  if (!problems) return
  const now = new Date().toISOString()
  await storeProblems(db, engagementId, { ...problems, items: problems.items.map(p => (p.seen_at ? p : { ...p, seen_at: now })) })
}

// The list as it is in the database NOW (not as it was when the caller
// loaded the job) — so a write here never drops a line someone else stored.
async function readStoredProblems(db: Db, engagementId: string): Promise<{ ok: true; value: ChannelProblems | null } | { ok: false }> {
  try {
    const { data, error } = await db.from('engagements').select('slack_channel_problems').eq('id', engagementId).maybeSingle()
    if (error) return { ok: false }
    return { ok: true, value: readProblems(data?.slack_channel_problems) }
  } catch { return { ok: false } }
}

// A line that is still true keeps when it started and whether it was hidden;
// a line that CHANGED (another status, another email) is a new line.
const carry = (now: string, fresh: ChannelProblem, prev: ChannelProblem | undefined, from: ChannelProblem['from']): ChannelProblem => {
  const same = !!prev && prev.status === fresh.status && emailKeyOf((prev as any).email) === emailKeyOf((fresh as any).email)
  return {
    ...fresh,
    from: same ? prev!.from ?? from : from,
    since: same ? prev!.since ?? now : now,
    tried_at: now,
    ...(same && prev!.seen_at ? { seen_at: prev!.seen_at } : {}),
  }
}

export async function reconcileChannelBees(
  db: Db,
  args: {
    token: string; engagementId: string; locationUuid: string; channelId: string; channelName: string | null
    from?: 'crew' | 'reopened'
    only?: Set<string> // the timed retry: ONLY these bees are put to Slack; every other line is left as it is
  },
): Promise<{ problems: ChannelProblem[]; invites: number; removes: number }> {
  const { token, engagementId, locationUuid, channelId, channelName, only } = args
  const from = args.from ?? 'crew'
  const out = { problems: [] as ChannelProblem[], invites: 0, removes: 0 }
  const { data: rows, error } = await db.from('engagement_bees').select('bee_id, removed_at').eq('engagement_id', engagementId)
  if (error) { console.warn('[engagement-bees] reconcile read failed for', engagementId, '—', error.message); return out }
  const onJob = new Set<string>(((rows || []) as any[]).filter(x => !x.removed_at).map(x => x.bee_id))
  const offJob = new Set<string>(((rows || []) as any[]).filter(x => x.removed_at && !onJob.has(x.bee_id)).map(x => x.bee_id))

  let ownerEmails = new Set<string>()
  if (offJob.size) {
    try {
      const { data } = await db.from('hub_users').select('email, role').eq('location_id', locationUuid).eq('role', 'owner')
      ownerEmails = new Set(((data || []) as any[]).map(u => String(u.email || '').trim().toLowerCase()).filter(Boolean))
    } catch { /* no owners read → skip nobody extra; owners are not bees anyway */ }
  }

  const plan: { id: string; action: 'add' | 'remove' }[] = [
    ...Array.from(onJob).map(id => ({ id, action: 'add' as const })),
    ...Array.from(offJob).map(id => ({ id, action: 'remove' as const })),
  ].filter(step => !only || only.has(step.id))
  const asked = new Set<string>()
  let gone = false
  for (const step of plan) {
    const bee = await readBeeRow(db, step.id)
    if (!bee || bee.location_uuid !== locationUuid) continue
    if (step.action === 'remove' && ownerEmails.has(String(bee.email || '').trim().toLowerCase())) continue
    if (step.action === 'add') out.invites++; else out.removes++
    const o = await mirrorBee(db, { token, locationUuid, engagementId, channelId, channelName, bee, action: step.action })
    // Slack answered about this bee, yes or no — unless the whole thing just
    // stopped (permission lost): then nothing is known and the old line stays.
    if (o.status !== 'scope_lost' && o.status !== 'channel_gone') asked.add(bee.id)
    if (o.status !== 'ok') out.problems.push({ ...o, bee_id: bee.id })
    if (o.status === 'channel_gone') gone = true
    if (o.status === 'scope_lost' || o.status === 'channel_gone') break
  }

  // channel_gone already forgot the channel (and its lines) — nothing to
  // store against a channel that no longer exists.
  if (gone) return out
  const prior = await readStoredProblems(db, engagementId)
  if (!prior.ok) { console.warn('[engagement-bees] stored lines not read for', engagementId, '— left as they are'); return out }
  const before = prior.value?.items || []
  const prevFor = (beeId?: string) => before.find(p => !!beeId && p.bee_id === beeId)
  const now = new Date().toISOString()
  const items: ChannelProblem[] = [
    // The owner's lines are not this function's to judge: kept as they are.
    ...before.filter(p => !p.bee_id),
    // On the timed retry, a bee that was not asked about keeps its line.
    ...(only ? before.filter(p => p.bee_id && !asked.has(p.bee_id)) : []),
    ...out.problems.filter(p => p.status !== 'scope_lost' || !only).map(p => carry(now, p, prevFor(p.bee_id), from)),
  ]
  out.problems = out.problems.map(p => items.find(i => i.bee_id === p.bee_id && i.status === p.status) || p)
  await storeProblems(db, engagementId, items.length ? { at: now, items } : null)
  return out
}

// ── The owner's line, tried again ────────────────────────────
// Looks the owner up by the email they have in Bee Hub NOW and invites them.
// In (or already in) → the line is removed. Never removes anyone. An owner
// who is no longer this location's owner has no line: it is not true any more.
async function retryOwnerLines(
  db: Db,
  args: { token: string; engagementId: string; locationUuid: string; channelId: string; items: ChannelProblem[]; nowMs: number },
): Promise<{ items: ChannelProblem[]; tried: number; fixed: number; waiting: number; changed: boolean; gone: boolean }> {
  const out = { items: [] as ChannelProblem[], tried: 0, fixed: 0, waiting: 0, changed: false, gone: false }
  let owners: OwnerRow[]
  try {
    const { data, error } = await db.from('hub_users').select('id, email, role, full_name').eq('location_id', args.locationUuid).eq('role', 'owner')
    if (error) return { ...out, items: args.items }
    owners = (data || []) as OwnerRow[]
  } catch { return { ...out, items: args.items } }
  const now = new Date(args.nowMs).toISOString()
  for (const item of args.items) {
    if (out.gone) break
    const u = owners.find(o => String(o.id) === item.user_id)
    if (!u || !u.email) { out.changed = true; out.fixed++; continue }
    if (!problemDue(item, args.nowMs, { email: u.email })) { out.items.push(item); out.waiting++; continue }
    out.tried++; out.changed = true
    const r = await inviteOneOwner(args.token, args.channelId, u)
    if (r.code === 'channel_not_found') { await forgetChannel(db, args.engagementId); out.gone = true; break }
    if (!r.miss) { out.fixed++; continue }
    if (r.code) console.warn(`[engagement-bees] owner invite engagement=${args.engagementId} user=${u.id} → ${r.code}`)
    out.items.push(carry(now, { ...r.miss, user_id: item.user_id }, item, item.from ?? 'created'))
  }
  return out
}

// ── The timed retry: every stored line that is due ───────────
// Runs in the 15-minute cron, after the archive sweep. Reads only jobs that
// HAVE stored lines, and asks Slack only about the lines that are due
// (problemDue) — a line Slack refused an hour ago for a reason that has not
// changed is not asked again until tomorrow.
export type ProblemSweepResult = {
  ok: boolean
  jobs: number      // open jobs with a channel and at least one stored line
  tried: number     // lines put to Slack again this run
  fixed: number     // lines that are no longer true, removed
  waiting: number   // lines not due yet — Slack was not asked
}

export async function sweepChannelProblems(db: Db, opts: { now?: number } = {}): Promise<ProblemSweepResult> {
  const r: ProblemSweepResult = { ok: true, jobs: 0, tried: 0, fixed: 0, waiting: 0 }
  const nowMs = opts.now ?? Date.now()
  const { data, error } = await db.from('engagements')
    .select('id, location_uuid, slack_channel_id, slack_channel_name, slack_channel_problems')
    .is('closed_at', null).not('slack_channel_id', 'is', null).is('slack_channel_archived_at', null)
    .not('slack_channel_problems', 'is', null).limit(SWEEP_LIMIT)
  if (error) {
    if (channelColumnsMissing(error.message)) return r
    console.error('[engagement-bees] problem sweep read failed —', error.message)
    return { ...r, ok: false }
  }
  const slackByLoc = new Map<string, LocationSlack>()
  for (const row of (data || []) as any[]) {
    const stored = readProblems(row.slack_channel_problems)
    if (!stored) continue
    r.jobs++
    try {
      if (!slackByLoc.has(row.location_uuid)) slackByLoc.set(row.location_uuid, await readLocationSlackFull(db, row.location_uuid))
      const slack = slackByLoc.get(row.location_uuid)!
      if (!slack.connected || !slack.token || !slack.canManageChannels) { r.waiting += stored.items.length; continue }

      // 1. The owner's lines.
      const ownerLines = stored.items.filter(p => !p.bee_id)
      let gone = false
      if (ownerLines.length) {
        const o = await retryOwnerLines(db, { token: slack.token, engagementId: row.id, locationUuid: row.location_uuid, channelId: row.slack_channel_id, items: ownerLines, nowMs })
        r.tried += o.tried; r.fixed += o.fixed; r.waiting += o.waiting
        gone = o.gone
        if (o.changed && !gone) {
          const fresh = await readStoredProblems(db, row.id)
          if (fresh.ok) {
            const items = [...(fresh.value?.items || []).filter(p => p.bee_id), ...o.items]
            await storeProblems(db, row.id, items.length ? { at: new Date(nowMs).toISOString(), items } : null)
          }
        }
      }
      if (gone) continue

      // 2. The bees' lines that are due.
      const beeLines = stored.items.filter(p => p.bee_id)
      const due = new Set<string>()
      for (const p of beeLines) {
        const bee = await readBeeRow(db, p.bee_id!)
        if (!bee || problemDue(p, nowMs, { email: bee.email, slackUserId: bee.slack_user_id, slackCheckedAt: bee.slack_checked_at })) due.add(p.bee_id!)
      }
      r.waiting += beeLines.length - due.size
      if (due.size) {
        const rec = await reconcileChannelBees(db, { token: slack.token, engagementId: row.id, locationUuid: row.location_uuid, channelId: row.slack_channel_id, channelName: row.slack_channel_name ?? null, only: due })
        r.tried += due.size
        r.fixed += Math.max(0, due.size - rec.problems.length)
      }
    } catch (e: any) {
      r.ok = false
      console.error('[engagement-bees] problem sweep failed for', row.id, '—', e?.name || 'error')
    }
  }
  return r
}
