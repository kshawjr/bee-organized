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
  client_id: string | null
  client_name: string | null
  project_type: string | null
  closed_at: string | null
  slack_channel_id: string | null
  slack_channel_name: string | null
  slack_channel_archived_at: string | null
  slack_channel_problems: ChannelProblems | null // what the last unattended reconcile couldn't do
  channelColumns: boolean // false until migrations/engagement_slack_channel.sql runs
}

const ENG_BASE = 'id, location_uuid, client_id, client_name, project_type, closed_at'
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
    client_name: data.client_name ?? null,
    project_type: data.project_type ?? null,
    closed_at: data.closed_at ?? null,
    slack_channel_id: channelColumns ? data.slack_channel_id ?? null : null,
    slack_channel_name: channelColumns ? data.slack_channel_name ?? null : null,
    slack_channel_archived_at: channelColumns ? data.slack_channel_archived_at ?? null : null,
    slack_channel_problems: channelColumns ? readProblems(data.slack_channel_problems) : null,
    channelColumns,
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
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function openingMessage(args: { clientName: string | null; projectType: string | null; url: string | null }): string {
  const who = slackEscape(args.clientName || 'this client')
  const what = args.projectType ? ` — ${slackEscape(args.projectType)}` : ''
  const lines = [`This is the channel for *${who}*${what}.`]
  if (args.url) lines.push(`<${args.url}|Open the job in Bee Hub>`)
  return lines.join('\n')
}

export type CreateResult =
  | { ok: true; channel: { id: string; name: string }; already: boolean; problems: BeeSlackOutcome[]; owners: { invited: number; notInSlack: number }; ownerProblems?: BeeSlackOutcome[] }
  | { ok: false; reason: 'not_set_up_yet' | 'not_ready' | 'closed' | 'scope_lost' | 'name_unavailable' | 'slack_unavailable' | 'store_failed' }

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

  // Bees must be readable BEFORE a channel exists — if the table isn't
  // there yet, make nothing.
  const bees = await readEngagementBees(db, eng)
  if (!bees.setUp) return { ok: false, reason: 'not_set_up_yet' }

  // conversations.create, retrying name_taken with -2, -3, …
  let created: { id: string; name: string } | null = null
  for (let i = 0; i < NAME_ATTEMPTS && !created; i++) {
    const name = slackJobChannelName(eng.client_name, eng.project_type, i === 0 ? '' : `-${i + 1}`)
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
  if ('assigned' in bees) {
    for (const b of bees.assigned) {
      const row = await readBeeRow(db, b.id)
      if (!row) continue
      const o = await mirrorBee(db, { token, locationUuid: eng.location_uuid, engagementId: eng.id, channelId: created.id, channelName: created.name, bee: row, action: 'add' })
      if (o.status !== 'ok') problems.push(o)
      if (o.status === 'scope_lost' || o.status === 'channel_gone') break
    }
  }
  const owners = await inviteOwners(db, token, eng, created.id)

  const url = baseUrl && eng.client_id ? `${baseUrl.replace(/\/$/, '')}/clients/${eng.client_id}?e=${eng.id}` : null
  const posted = await slackApi(token, 'chat.postMessage', {
    channel: created.id,
    text: openingMessage({ clientName: eng.client_name, projectType: eng.project_type, url }),
    unfurl_links: false,
  })
  if (!posted.ok) console.warn(`[engagement-bees] opening message engagement=${eng.id} → ${slackErr(posted)}`)

  return { ok: true, already: false, channel: created, problems, owners: { invited: owners.invited, notInSlack: owners.notInSlack }, ownerProblems: owners.missed }
}

// The location's owners (hub_users role 'owner'), looked up by email in this
// Slack. Not bees: they are never in engagement_bees, so unticking can't
// remove them. Best effort — a miss never fails the channel — but NEVER
// SILENT: the dialog says "the owner is added too", so every owner who was
// not added comes back in `missed` and is named on the screen. The common
// one is an owner whose Bee Hub email is not the email they use in Slack;
// we can name the email we looked for, not the one Slack knows them by.
async function inviteOwners(db: Db, token: string, eng: EngagementForBees, channelId: string) {
  const out = { invited: 0, notInSlack: 0, missed: [] as BeeSlackOutcome[] }
  try {
    const { data } = await db.from('hub_users').select('id, email, role, full_name').eq('location_id', eng.location_uuid).eq('role', 'owner')
    for (const u of (data || []) as any[]) {
      if (!u.email) continue
      const who = (typeof u.full_name === 'string' && u.full_name.trim()) || u.email
      const r = await lookupSlackUserByEmail(token, u.email)
      if (r.status !== 'found') {
        if (r.status === 'not_found') { out.notInSlack++; out.missed.push({ status: 'owner_not_in_slack', bee: who, email: u.email }) }
        else out.missed.push({ status: 'owner_not_added', bee: who })
        continue
      }
      const j = await slackApi(token, 'conversations.invite', { channel: channelId, users: r.slackUserId })
      if (j.ok || j.error === 'already_in_channel' || j.error === 'cant_invite_self') out.invited++
      else {
        out.missed.push({ status: 'owner_not_added', bee: who })
        console.warn(`[engagement-bees] owner invite engagement=${eng.id} user=${u.id} → ${slackErr(j)}`)
      }
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
  const cols = 'id, location_uuid, client_name, closed_at, slack_channel_id, slack_channel_name, slack_channel_archived_at'
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
        const rec = await reconcileChannelBees(db, { token: slack.token, engagementId: row.id, locationUuid: row.location_uuid, channelId: row.slack_channel_id, channelName: row.slack_channel_name ?? null })
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
// Nobody watches the cron, so every miss is STORED on the engagement
// (slack_channel_problems) and shown under the Bees cell the next time
// anyone opens the job, until the owner taps Got it or re-ticks that bee.
// A clean reconcile clears the old list. Bee Hub's assignment is never
// changed here.
export type ChannelProblem = BeeSlackOutcome & { bee_id?: string }
export type ChannelProblems = { at: string; items: ChannelProblem[] }

export function readProblems(raw: unknown): ChannelProblems | null {
  if (!raw || typeof raw !== 'object') return null
  const items = Array.isArray((raw as any).items) ? (raw as any).items.filter((x: any) => x && typeof x.status === 'string') : []
  return items.length ? { at: String((raw as any).at || ''), items } : null
}

export async function storeProblems(db: Db, engagementId: string, problems: ChannelProblems | null) {
  try {
    const { error } = await db.from('engagements').update({ slack_channel_problems: problems }).eq('id', engagementId)
    if (error) console.warn('[engagement-bees] channel problems not stored for', engagementId, '—', error.message)
  } catch { /* logged above when it answers */ }
}

export async function reconcileChannelBees(
  db: Db,
  args: { token: string; engagementId: string; locationUuid: string; channelId: string; channelName: string | null },
): Promise<{ problems: ChannelProblem[]; invites: number; removes: number }> {
  const { token, engagementId, locationUuid, channelId, channelName } = args
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
  ]
  for (const step of plan) {
    const bee = await readBeeRow(db, step.id)
    if (!bee || bee.location_uuid !== locationUuid) continue
    if (step.action === 'remove' && ownerEmails.has(String(bee.email || '').trim().toLowerCase())) continue
    if (step.action === 'add') out.invites++; else out.removes++
    const o = await mirrorBee(db, { token, locationUuid, engagementId, channelId, channelName, bee, action: step.action })
    if (o.status !== 'ok') out.problems.push({ ...o, bee_id: bee.id })
    if (o.status === 'scope_lost' || o.status === 'channel_gone') break
  }

  // channel_gone already forgot the channel (and its problems) — nothing to
  // store against a channel that no longer exists.
  if (!out.problems.some(p => p.status === 'channel_gone')) {
    await storeProblems(db, engagementId, out.problems.length ? { at: new Date().toISOString(), items: out.problems } : null)
  }
  return out
}
