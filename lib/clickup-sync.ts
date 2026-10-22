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
// never get one: Source = Owner request is a promise someone is waiting.
//
// The task is created on list CLICKUP_BEE_DESK_LIST_ID with the report's title
// and body, the ClickUp status matching where triage put it, and two custom
// fields read BY NAME at runtime — Source (= "Owner request") and Bee Desk ID
// (= the feedback_items uuid). If either field is missing, or Source has no
// "Owner request" option, NO task is created and a sync_log error says which.
// A task without them would be one the inbound half can never reply from.
//
// ─── IN: A CLICKUP CLOSE IS THE REPLY ─────────────────────────────────
// Every ClickUp status maps to exactly one Bee Desk status (CLICKUP_TO_BEE_DESK).
// Moves into Shipped / Answered / Not doing write admin_response from a REAL
// COMMENT on the task — never generated text. admin_response has no author
// column, so a generated reply would be words nobody wrote, read by the owner
// as ours.
//
// NO COMMENT → HELD, NOT REJECTED. Rejecting means refusing the webhook, and
// ClickUp does not show a refusal to the person who moved the card — it retries,
// then suspends the webhook. The close would be lost and every later close with
// it. Held means: nothing is written to the item (no status, no text), a
// sync_log ERROR row says a reply is owed and how to release it, and the close
// completes on its own the moment someone comments on the task (the webhook
// also listens for taskCommentPosted, and a comment on a task that sits in a
// closing status its Bee Desk row has not reached yet releases it). Same rule
// as caa0fda on the Bee Desk side: the status change has to carry words.
//
// Source Internal and Idea trigger NOTHING — no item write, no sync_log row.
// Only Source = Owner request is read further.
//
// Every failure is a sync_log row with status 'error'. None is swallowed: a
// failure here means an owner silently never hears back.

import type { ClickUpClient, ClickUpComment, ClickUpField, ClickUpTask } from './clickup'
import { CLICKUP_BEE_DESK_LIST_ID } from './clickup'
import { writeSyncLog } from './sync-log'
import { wouldHandSetStuck } from './feedback-admin-tiles'

export const SOURCE_FIELD = 'Source'
export const BEE_DESK_ID_FIELD = 'Bee Desk ID'
export const OWNER_REQUEST = 'Owner request'

// ClickUp status (lowercased) → feedback_items.status. Several share one; none
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
// a create.
export const CREATE_STATUS_FOR: Record<string, string> = {
  under_review: 'Looking at it',
  planned: 'On the list',
  in_progress: 'In progress',
}

export function mapClickUpStatus(status: string | null | undefined): string | null {
  return CLICKUP_TO_BEE_DESK[String(status ?? '').trim().toLowerCase()] ?? null
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

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
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

export const HANDLED_EVENTS = new Set(['taskStatusUpdated', 'taskCommentPosted'])

export type InboundOutcome =
  | { ok: true; outcome: 'ignored' | 'not_owner_request' | 'no_change' | 'status_written' | 'reply_written'; feedback_id?: string }
  | { ok: false; outcome: 'held'; feedback_id: string }
  | { ok: false; outcome: 'error'; error: string }

const fieldText = (f: ClickUpField | undefined): string | null => {
  if (!f || f.value == null || f.value === '') return null
  if (f.type === 'drop_down') {
    // Task reads return a drop_down value as the option's orderindex (older
    // payloads) or its id; accept either.
    const opt = (f.type_config?.options || []).find(o => o.id === f.value || String(o.orderindex) === String(f.value))
    return opt?.name ?? null
  }
  return String(f.value).trim() || null
}

export function latestComment(comments: ClickUpComment[]): string | null {
  const real = comments
    .map(c => ({ text: String(c.comment_text ?? '').trim(), at: Number(c.date ?? 0) }))
    .filter(c => c.text)
    .sort((a, b) => b.at - a.at)
  return real[0]?.text ?? null
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
  if (!feedbackId) return fail('no_bee_desk_id', taskId, 'Owner request task has no Bee Desk ID; nobody can be replied to')

  const clickupStatus = norm(task.status?.status)
  const mapped = mapClickUpStatus(clickupStatus)
  if (!mapped) return fail('unmapped_status', feedbackId, `ClickUp status "${task.status?.status}" has no Bee Desk status`)

  const { data: row, error: readErr } = await db
    .from('feedback_items').select('id, status, admin_response, is_internal, clickup_task_id')
    .eq('id', feedbackId).maybeSingle()
  if (readErr || !row) {
    return fail('no_feedback_item', feedbackId, `Bee Desk ID ${feedbackId} matches no feedback_items row${readErr ? ` (${readErr.message})` : ''}`)
  }
  if (row.is_internal) return fail('internal_item', feedbackId, 'Owner request task points at an internal item; refusing to write')
  if (row.clickup_task_id && row.clickup_task_id !== taskId) {
    return fail('task_mismatch', feedbackId, `item is linked to task ${row.clickup_task_id}, not ${taskId}`)
  }

  const closing = CLOSING_CLICKUP_STATUSES.has(clickupStatus)

  // A comment only matters when it releases a held close.
  if (event.event === 'taskCommentPosted' && !(closing && row.status !== mapped)) {
    return { ok: true, outcome: 'no_change', feedback_id: feedbackId }
  }

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

  let comments: ClickUpComment[]
  try {
    comments = await client.getComments(taskId)
  } catch (err: any) {
    return fail('comment_read_failed', feedbackId, String(err?.message || err))
  }
  const reply = latestComment(comments)
  if (!reply) {
    console.error(`[clickup-webhook] held task=${taskId} item=${feedbackId}: closed with no comment`)
    await log('error', feedbackId, 'inbound',
      `event=${event.event} task=${taskId} HELD — moved to "${task.status?.status}" with no comment. Nothing written; the owner is still owed a reply. Add a comment on the task to release it.`)
    return { ok: false, outcome: 'held', feedback_id: feedbackId }
  }

  const err = await write({
    status: mapped,
    admin_response: reply,
    admin_response_at: (args.now ?? new Date()).toISOString(),
  })
  if (err) return fail('write_failed', feedbackId, err.message)
  await log('success', feedbackId, 'inbound', `event=${event.event} task=${taskId} status ${row.status} → ${mapped} reply written from task comment`)
  return { ok: true, outcome: 'reply_written', feedback_id: feedbackId }
}
