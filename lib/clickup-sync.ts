// lib/clickup-sync.ts
//
// Bee Desk ↔ ClickUp, both directions (ClickUp task 868mm1h7z). One feature:
// the column, the outbound create and the inbound webhook are useless apart.
//
// ─── OUT: TRIAGE CREATES A TASK ───────────────────────────────────────
// "Triaged" means: a team (elevated) save on an owner's item that leaves it at
// an open status past 'submitted' — Looking at it, On the list, In progress —
// when it has no task yet. That is the moment a person has looked and decided
// it is work. It is NOT a claim or a tick on a 'submitted' item (nobody has
// decided anything), and NOT a save straight to answered/shipped/declined (the
// item is already closed; a task would open only to sit there). Internal items
// never get one: Source = Owner Request is a promise someone is waiting.
//
// The task is created on list CLICKUP_BEE_DESK_LIST_ID with the report's title
// and body, the ClickUp status matching where triage put it, and two custom
// fields read BY NAME at runtime — Source (= "Owner Request") and Bee Desk ID
// (= the feedback_items uuid). If either field is missing, or Source has no
// "Owner Request" option, NO task is created and a sync_log error says which.
// Field names, option names and status names all match ignoring case and
// whitespace (norm, below) — the live board stores statuses lowercase and
// spells the option "Owner Request".
// A task without them would be one the inbound half can never reply from.
//
// ─── IN: A CLICKUP CLOSE IS THE REPLY ─────────────────────────────────
// Every ClickUp status maps to exactly one Bee Desk status (CLICKUP_TO_BEE_DESK).
// Moves into Shipped / Answered / Not doing write admin_response from the
// task's "Reply to Owner" custom field — words a person typed into a field
// that exists only to be sent to the owner. Never generated text, and never a
// comment: the newest comment can be an internal engineering note, and it
// would have gone to a franchise owner as their answer. admin_response has no
// author column, so a reply has to be words somebody wrote FOR the owner.
//
// The field is matched by name ("Reply to Owner", ignoring case), falling back
// to its id (REPLY_FIELD_ID) — it was "Note to Client" before the rename, and
// the id survives a rename where the name does not.
//
// EMPTY FIELD → HELD, NOT REJECTED. Rejecting means refusing the webhook, and
// ClickUp does not show a refusal to the person who moved the card — it retries,
// then suspends the webhook. The close would be lost and every later close with
// it. Held means: nothing is written to the item (no status, no text), and a
// sync_log ERROR row says a reply is owed and how to release it: fill in Reply
// to Owner, then move the task into the closing status again. Same rule as
// caa0fda on the Bee Desk side: the status change has to carry words.
//
// ONE EVENT: taskStatusUpdated. The handler reads the field from the task at
// the moment of the move, so no second event is needed for the ordinary close
// (fill the field, then move the card). Filling the field AFTER the move fires
// no status event, which is why the held message says to move it again.
//
// THE EMAIL. A written reply is then emailed to the submitter through the SAME
// decision the triage save uses (lib/feedback-notify): a new or changed reply
// sends; re-closing with the identical text does not; moving INTO Shipped
// carries the Fixed line. 35 of 43 owners never open Bee Desk, so a reply with
// no email reaches nobody. The write never waits on the mail: a send that
// fails or is skipped (no address on file) leaves the reply written and adds a
// sync_log ERROR row saying the owner was not emailed.
//
// Source Internal and Idea trigger NOTHING — no item write, no email, no
// sync_log row. Only Source = Owner Request is read further.
//
// Every failure is a sync_log row with status 'error'. None is swallowed: a
// failure here means an owner silently never hears back.

import type { ClickUpClient, ClickUpField, ClickUpTask } from './clickup'
import { CLICKUP_BEE_DESK_LIST_ID } from './clickup'
import { writeSyncLog } from './sync-log'
import { wouldHandSetStuck } from './feedback-admin-tiles'
import { maybeNotifySubmitter, type ReplyEmailOutcome } from './feedback-notify'

export const SOURCE_FIELD = 'Source'
export const BEE_DESK_ID_FIELD = 'Bee Desk ID'
export const OWNER_REQUEST = 'Owner Request'
export const REPLY_FIELD = 'Reply to Owner'
// The field's id on list 901111225249 (created as "Note to Client"). Used only
// when no field carries REPLY_FIELD's name.
export const REPLY_FIELD_ID = 'c31305bb-4e98-46af-9e1e-9986617dbea2'

// Case- and whitespace-blind comparison for every name read off ClickUp:
// statuses, field names, dropdown options. "  On   the List " → "on the list".
export const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

// ClickUp status (norm'd) → feedback_items.status. Several share one; none
// maps to two (a Record cannot hold two values per key).
export const CLICKUP_TO_BEE_DESK: Record<string, string> = {
  'submitted': 'submitted',
  'looking at it': 'under_review',
  'needs input': 'under_review',
  'on the list': 'planned',
  'in progress': 'planned',
  'testing': 'planned',
  'shipped': 'shipped',
  'answered': 'answered',
  'not doing': 'declined',
}

export const CLOSING_CLICKUP_STATUSES = new Set(['shipped', 'answered', 'not doing'])

// The ClickUp status a newly-created task starts in, by where triage put the
// item. Only the open statuses past 'submitted' — the same set that triggers
// a create. Spelled exactly as the live board stores them (lowercase).
export const CREATE_STATUS_FOR: Record<string, string> = {
  under_review: 'looking at it',
  planned: 'on the list',
  in_progress: 'in progress',
}

export function mapClickUpStatus(status: string | null | undefined): string | null {
  return CLICKUP_TO_BEE_DESK[norm(status)] ?? null
}

export function shouldCreateClickUpTask(args: {
  isElevatedCaller: boolean
  isInternal: boolean
  statusAfter: string
}): boolean {
  return args.isElevatedCaller && !args.isInternal && args.statusAfter in CREATE_STATUS_FOR
}

type Db = { from: (table: string) => any }

const log = (status: 'success' | 'error', entityId: string, direction: 'inbound' | 'outbound', message: string) =>
  writeSyncLog({
    location_id: null,
    entity_id: entityId,
    entity_type: 'feedback',
    direction,
    status,
    message: `clickup ${message}`.slice(0, 1000),
  })

const findField = (fields: ClickUpField[] | undefined, name: string) =>
  (fields || []).find(f => norm(f.name) === norm(name))

// ─── OUT ──────────────────────────────────────────────────────────────

export type CreateOutcome =
  | { created: true; task_id: string }
  | { created: false; skipped: string }
  | { created: false; error: string }

export async function createClickUpTaskForFeedback(args: {
  client: ClickUpClient | null
  db: Db
  item: { id: string; title: string; description?: string | null; status: string }
}): Promise<CreateOutcome> {
  const { client, db, item } = args
  const fail = async (error: string, detail: string): Promise<CreateOutcome> => {
    console.error(`[clickup-sync] create failed item=${item.id}: ${detail}`)
    await log('error', item.id, 'outbound', `create_task error=${error} item=${item.id} — ${detail}`)
    return { created: false, error }
  }

  if (!client) return fail('no_clickup_token', 'CLICKUP_API_TOKEN is not set; no task created for this triaged owner item')

  // Its own read, so a pre-migration column never breaks the triage select.
  const { data: link, error: linkErr } = await db
    .from('feedback_items').select('clickup_task_id').eq('id', item.id).maybeSingle()
  if (linkErr) return fail('link_read_failed', `could not read clickup_task_id (migration not run?): ${linkErr.message}`)
  if (link?.clickup_task_id) return { created: false, skipped: 'already_linked' }

  let fields: ClickUpField[]
  try {
    fields = await client.listFields(CLICKUP_BEE_DESK_LIST_ID)
  } catch (err: any) {
    return fail('field_read_failed', String(err?.message || err))
  }

  const source = findField(fields, SOURCE_FIELD)
  const deskId = findField(fields, BEE_DESK_ID_FIELD)
  const missing = [!source && SOURCE_FIELD, !deskId && BEE_DESK_ID_FIELD].filter(Boolean)
  if (missing.length) {
    return fail('missing_custom_fields', `list ${CLICKUP_BEE_DESK_LIST_ID} has no custom field named ${missing.map(m => `"${m}"`).join(' or ')}`)
  }

  let sourceValue: unknown
  if (source!.type === 'drop_down') {
    const opt = (source!.type_config?.options || []).find(o => norm(o.name) === norm(OWNER_REQUEST))
    if (!opt) return fail('missing_source_option', `Source has no "${OWNER_REQUEST}" option`)
    sourceValue = opt.id
  } else if (source!.type === 'text' || source!.type === 'short_text') {
    sourceValue = OWNER_REQUEST
  } else {
    return fail('unsupported_field_type', `Source is a ${source!.type} field; expected drop_down or text`)
  }
  if (deskId!.type !== 'text' && deskId!.type !== 'short_text') {
    return fail('unsupported_field_type', `Bee Desk ID is a ${deskId!.type} field; expected text`)
  }

  let taskId: string
  try {
    const task = await client.createTask(CLICKUP_BEE_DESK_LIST_ID, {
      name: item.title,
      description: item.description || '',
      ...(CREATE_STATUS_FOR[item.status] ? { status: CREATE_STATUS_FOR[item.status] } : {}),
      custom_fields: [
        { id: source!.id, value: sourceValue },
        { id: deskId!.id, value: item.id },
      ],
    })
    taskId = String(task?.id || '')
    if (!taskId) return fail('no_task_id_returned', 'ClickUp accepted the create but returned no id')
  } catch (err: any) {
    return fail('create_failed', String(err?.message || err))
  }

  const { error: storeErr } = await db
    .from('feedback_items').update({ clickup_task_id: taskId }).eq('id', item.id).is('clickup_task_id', null)
  if (storeErr) {
    return fail('store_failed', `task ${taskId} WAS created in ClickUp but its id was not stored: ${storeErr.message}`)
  }

  await log('success', item.id, 'outbound', `create_task item=${item.id} task=${taskId}`)
  return { created: true, task_id: taskId }
}

// ─── IN ───────────────────────────────────────────────────────────────

export const HANDLED_EVENTS = new Set(['taskStatusUpdated'])

export type InboundOutcome =
  | { ok: true; outcome: 'ignored' | 'not_owner_request' | 'no_change' | 'status_written'; feedback_id?: string }
  | { ok: true; outcome: 'reply_written'; feedback_id: string; email: ReplyEmailOutcome | null }
  | { ok: false; outcome: 'held'; feedback_id: string }
  | { ok: false; outcome: 'error'; error: string }

const fieldText = (f: ClickUpField | undefined): string | null => {
  if (!f || f.value == null || f.value === '') return null
  if (f.type === 'drop_down') {
    // ClickUp's Get Task reference returns a drop_down value as the option's
    // orderindex, a NUMBER ("value": 2), even with new_drop_down: true. The
    // option uuid is what a write sends; accept it on read too. Any other
    // shape finds no option and reads as no Source — which triggers nothing.
    const opt = (f.type_config?.options || []).find(o => o.id === f.value || String(o.orderindex) === String(f.value))
    return opt?.name ?? null
  }
  return String(f.value).trim() || null
}

// The Reply to Owner field: by name first, then by id. Returns the trimmed
// text, or null when the field is absent or empty.
export function replyFieldText(fields: ClickUpField[] | undefined): string | null {
  const f = findField(fields, REPLY_FIELD) ?? (fields || []).find(x => x.id === REPLY_FIELD_ID)
  return fieldText(f)
}

export async function handleClickUpEvent(args: {
  client: ClickUpClient | null
  db: Db
  event: { event?: string; task_id?: string }
  now?: Date
}): Promise<InboundOutcome> {
  const { client, db, event } = args
  const taskId = String(event.task_id || '')
  const fail = async (error: string, entityId: string, detail: string): Promise<InboundOutcome> => {
    console.error(`[clickup-webhook] ${error} task=${taskId}: ${detail}`)
    await log('error', entityId, 'inbound', `event=${event.event} task=${taskId} error=${error} — ${detail}`)
    return { ok: false, outcome: 'error', error }
  }

  if (!event.event || !HANDLED_EVENTS.has(event.event)) return { ok: true, outcome: 'ignored' }
  if (!taskId) return fail('missing_task_id', 'unknown', 'signed delivery carried no task_id')
  if (!client) return fail('no_clickup_token', taskId, 'CLICKUP_API_TOKEN is not set; cannot read the task, so no reply can be written')

  let task: ClickUpTask
  try {
    task = await client.getTask(taskId)
  } catch (err: any) {
    return fail('task_read_failed', taskId, String(err?.message || err))
  }

  // Internal, Idea, blank — nothing. Not even a log row.
  if (norm(fieldText(findField(task.custom_fields, SOURCE_FIELD))) !== norm(OWNER_REQUEST)) {
    return { ok: true, outcome: 'not_owner_request' }
  }

  const feedbackId = fieldText(findField(task.custom_fields, BEE_DESK_ID_FIELD))
  if (!feedbackId) return fail('no_bee_desk_id', taskId, 'Owner Request task has no Bee Desk ID; nobody can be replied to')

  const clickupStatus = norm(task.status?.status)
  const mapped = mapClickUpStatus(clickupStatus)
  if (!mapped) return fail('unmapped_status', feedbackId, `ClickUp status "${task.status?.status}" has no Bee Desk status`)

  const { data: row, error: readErr } = await db
    .from('feedback_items')
    .select('id, status, admin_response, is_internal, clickup_task_id, user_id, location_id, title, type')
    .eq('id', feedbackId).maybeSingle()
  if (readErr || !row) {
    return fail('no_feedback_item', feedbackId, `Bee Desk ID ${feedbackId} matches no feedback_items row${readErr ? ` (${readErr.message})` : ''}`)
  }
  if (row.is_internal) return fail('internal_item', feedbackId, 'Owner Request task points at an internal item; refusing to write')
  if (row.clickup_task_id && row.clickup_task_id !== taskId) {
    return fail('task_mismatch', feedbackId, `item is linked to task ${row.clickup_task_id}, not ${taskId}`)
  }

  const closing = CLOSING_CLICKUP_STATUSES.has(clickupStatus)

  const write = async (patch: Record<string, unknown>) => {
    const { error } = await db.from('feedback_items').update(patch).eq('id', feedbackId)
    return error
  }

  if (!closing) {
    if (row.status === mapped) return { ok: true, outcome: 'no_change', feedback_id: feedbackId }
    // The same refusal the triage PATCH makes: a replied item moved back to
    // 'submitted' would sit in Stuck on the triage screen.
    if (wouldHandSetStuck({ fromStatus: row.status, toStatus: mapped, replyAfter: row.admin_response })) {
      return fail('stuck_is_not_settable', feedbackId, `moving a replied item back to submitted would leave it Stuck; status left at ${row.status}`)
    }
    const err = await write({ status: mapped })
    if (err) return fail('write_failed', feedbackId, err.message)
    await log('success', feedbackId, 'inbound', `event=${event.event} task=${taskId} status ${row.status} → ${mapped}`)
    return { ok: true, outcome: 'status_written', feedback_id: feedbackId }
  }

  const reply = replyFieldText(task.custom_fields)
  if (!reply) {
    console.error(`[clickup-webhook] held task=${taskId} item=${feedbackId}: closed with Reply to Owner empty`)
    await log('error', feedbackId, 'inbound',
      `event=${event.event} task=${taskId} HELD — moved to "${task.status?.status}" with Reply to Owner empty. Nothing written; the owner is still owed a reply. Fill in Reply to Owner, then move the task into "${task.status?.status}" again to release it.`)
    return { ok: false, outcome: 'held', feedback_id: feedbackId }
  }

  const err = await write({
    status: mapped,
    admin_response: reply,
    admin_response_at: (args.now ?? new Date()).toISOString(),
  })
  if (err) return fail('write_failed', feedbackId, err.message)
  await log('success', feedbackId, 'inbound', `event=${event.event} task=${taskId} status ${row.status} → ${mapped} reply written from Reply to Owner`)

  // The triage save's rules, compared against the BEFORE row like the route
  // does: changed text only, and Fixed only on the move INTO shipped.
  let email: ReplyEmailOutcome | null
  try {
    email = await maybeNotifySubmitter({
      newReplyText: reply !== String(row.admin_response ?? '').trim() ? reply : null,
      statusChanged: mapped !== row.status,
      shippedNow: mapped === 'shipped' && row.status !== 'shipped',
      callerId: null,
      target: row,
      newStatus: mapped,
    })
  } catch (e: any) {
    email = { sent: false, error: String(e?.message || e) }
  }
  if (email && !email.sent) {
    const why = 'error' in email ? `error=${email.error}` : `skipped=${email.skipped}`
    console.error(`[clickup-webhook] reply written but owner NOT emailed task=${taskId} item=${feedbackId}: ${why}`)
    await log('error', feedbackId, 'inbound',
      `event=${event.event} task=${taskId} reply written but the owner was NOT emailed (${why}). They will only see it if they open Bee Desk.`)
  }
  return { ok: true, outcome: 'reply_written', feedback_id: feedbackId, email }
}
