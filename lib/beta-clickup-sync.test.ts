// @vitest-environment node
//
// BEE DESK ↔ CLICKUP (task 868mm1h7z). The ClickUp client is always a fake —
// nothing here can reach api.clickup.com.
//
//   · a close WITH Reply to Owner filled writes admin_response and the status
//   · a close with Reply to Owner EMPTY writes nothing and invents nothing (held)
//   · comments are never the reply — there is no comment read at all
//   · the reply field is found by name ignoring case, else by its id
//   · each of the nine ClickUp statuses lands as its one Bee Desk status,
//     including the exact lowercase strings the live board stores
//   · Source "Owner Request" (the board's spelling) matches ignoring case
//   · Source Internal / Idea trigger nothing at all
//   · a delivery without the right X-Signature is refused
//   · a Bee Desk ID matching no row fails loudly
//   · creating a task stores the returned id in clickup_task_id
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

const h = vi.hoisted(() => {
  const state = {
    row: null as any,
    readError: null as any,
    updates: [] as { table: string; arg: any; filters: Record<string, any> }[],
    syncLog: [] as any[],
  }
  const makeBuilder = (table: string) => {
    const b: any = {}
    const filters: Record<string, any> = {}
    let update: any = null
    for (const m of ['select', 'order', 'limit', 'not', 'in']) b[m] = () => b
    b.eq = (c: string, v: any) => { filters[c] = v; return b }
    b.is = (c: string, v: any) => { filters[`is:${c}`] = v; return b }
    b.update = (arg: any) => { update = arg; state.updates.push({ table, arg, filters }); return b }
    const resolve = () => {
      if (update) return { data: { ...(state.row || {}), ...update }, error: null }
      if (table === 'feedback_items') {
        if (state.readError) return { data: null, error: state.readError }
        return { data: state.row && filters.id === state.row.id ? state.row : null, error: null }
      }
      return { data: state.row, error: null }
    }
    b.single = () => Promise.resolve(resolve())
    b.maybeSingle = () => Promise.resolve(resolve())
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }
  const db = { from: (t: string) => makeBuilder(t) }
  return { state, db }
})

const fake = vi.hoisted(() => ({
  client: null as any,
}))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: h.db }))
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async (row: any) => { h.state.syncLog.push(row) }),
}))
vi.mock('@/lib/clickup', async () => {
  const actual = await vi.importActual<any>('@/lib/clickup')
  return { ...actual, clickUpClientFromEnv: () => fake.client }
})

import {
  CLICKUP_TO_BEE_DESK, mapClickUpStatus, handleClickUpEvent, createClickUpTaskForFeedback,
  REPLY_FIELD_ID,
} from '@/lib/clickup-sync'
import { CLICKUP_BEE_DESK_LIST_ID } from '@/lib/clickup'
import { POST } from '@/app/api/webhooks/clickup/route'

const ITEM_ID = '11111111-2222-3333-4444-555555555555'
const TASK_ID = '86abc123'
const SOURCE_FIELD_ID = 'f-source'
const DESK_FIELD_ID = 'f-desk'
// The board's spellings, exactly.
const OPTIONS = [
  { id: 'opt-owner', name: 'Owner Request', orderindex: 0 },
  { id: 'opt-internal', name: 'Internal', orderindex: 1 },
  { id: 'opt-idea', name: 'Idea', orderindex: 2 },
]
const LIST_FIELDS = [
  { id: SOURCE_FIELD_ID, name: 'Source', type: 'drop_down', type_config: { options: OPTIONS } },
  { id: DESK_FIELD_ID, name: 'Bee Desk ID', type: 'short_text' },
]

// A task as GET /task returns it. `reply` is the Reply to Owner field; pass
// replyField to change its name/id (rename + fallback tests).
function taskWith(
  status: string,
  opts: {
    source?: string; deskId?: string | null; reply?: string | null
    replyField?: { id: string; name: string } | null
  } = {},
) {
  const { source = 'opt-owner', deskId = ITEM_ID, reply = null } = opts
  const replyField = opts.replyField === undefined
    ? { id: REPLY_FIELD_ID, name: 'Reply to Owner' }
    : opts.replyField
  return {
    id: TASK_ID,
    status: { status },
    custom_fields: [
      { id: SOURCE_FIELD_ID, name: 'Source', type: 'drop_down', type_config: { options: OPTIONS }, value: source },
      { id: DESK_FIELD_ID, name: 'Bee Desk ID', type: 'short_text', value: deskId },
      ...(replyField ? [{ ...replyField, type: 'text', value: reply }] : []),
    ],
  }
}

function makeClient(over: Partial<Record<string, any>> = {}) {
  return {
    listFields: vi.fn(async () => LIST_FIELDS),
    createTask: vi.fn(async () => ({ id: 'new-task-9' })),
    getTask: vi.fn(async () => taskWith('shipped')),
    ...over,
  }
}

const SECRET = 'whsec-test'
const sign = (body: string) => createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')
const deliver = async (payload: any, signature?: string | null) => {
  const body = JSON.stringify(payload)
  const headers = new Map<string, string>()
  const sig = signature === undefined ? sign(body) : signature
  if (sig !== null) headers.set('x-signature', sig)
  const req = { text: async () => body, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null } } as any
  const res = await POST(req)
  return { status: res.status, body: await res.json() }
}
const moved = (task: any) => {
  fake.client = makeClient({ getTask: vi.fn(async () => task) })
  return deliver({ event: 'taskStatusUpdated', task_id: TASK_ID })
}
const itemWrites = () => h.state.updates.filter(u => u.table === 'feedback_items').map(u => u.arg)

beforeEach(() => {
  h.state.row = {
    id: ITEM_ID, status: 'planned', admin_response: null, is_internal: false, clickup_task_id: TASK_ID,
  }
  h.state.readError = null
  h.state.updates = []
  h.state.syncLog = []
  fake.client = makeClient()
  process.env.CLICKUP_WEBHOOK_SECRET = SECRET
})

// ─── closing statuses carry real words, from the field ───────────────

describe('a close with Reply to Owner filled', () => {
  it('writes admin_response from the field and the mapped status', async () => {
    const { status, body } = await moved(taskWith('shipped', { reply: '  Fixed — the snooze button now sticks.  ' }))
    expect(status).toBe(200)
    expect(body.outcome).toBe('reply_written')
    const w = itemWrites()
    expect(w).toHaveLength(1)
    expect(w[0].status).toBe('shipped')
    expect(w[0].admin_response).toBe('Fixed — the snooze button now sticks.')
    expect(typeof w[0].admin_response_at).toBe('string')
  })

  it('never reads comments — the client has no way to', async () => {
    const client = makeClient({ getTask: vi.fn(async () => taskWith('answered', { reply: 'Yes, it does.' })) })
    expect('getComments' in client).toBe(false)
    fake.client = client
    await deliver({ event: 'taskStatusUpdated', task_id: TASK_ID })
    expect(itemWrites()[0].admin_response).toBe('Yes, it does.')
  })
})

describe('a close with Reply to Owner empty', () => {
  it.each([
    ['null', null],
    ['blank', '   '],
  ])('(%s) writes nothing, invents no text, and logs a held reply loudly', async (_l, reply) => {
    const { status, body } = await moved(taskWith('answered', { reply }))
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.outcome).toBe('held')
    expect(itemWrites()).toEqual([])
    const held = h.state.syncLog.find(r => /HELD/.test(r.message))
    expect(held?.status).toBe('error')
    expect(held?.message).toMatch(/Fill in Reply to Owner, then move the task/)
  })

  it('a task with no reply field at all is held too', async () => {
    const { body } = await moved(taskWith('not doing', { replyField: null }))
    expect(body.outcome).toBe('held')
    expect(itemWrites()).toEqual([])
  })

  it('moving it into the closing status again, once filled, releases it', async () => {
    await moved(taskWith('not doing', { reply: '' }))
    expect(itemWrites()).toEqual([])
    await moved(taskWith('not doing', { reply: 'Not doing this one — Jobber owns that screen.' }))
    expect(itemWrites()).toEqual([
      expect.objectContaining({ status: 'declined', admin_response: 'Not doing this one — Jobber owns that screen.' }),
    ])
  })
})

describe('finding the reply field', () => {
  it('by name, ignoring case, even when the id is not the known one', async () => {
    await moved(taskWith('shipped', { reply: 'By name.', replyField: { id: 'some-new-id', name: 'reply TO owner' } }))
    expect(itemWrites()[0].admin_response).toBe('By name.')
  })

  it('by id when the name does not match (the old "Note to Client" name)', async () => {
    await moved(taskWith('shipped', { reply: 'By id.', replyField: { id: REPLY_FIELD_ID, name: 'Note to Client' } }))
    expect(itemWrites()[0].admin_response).toBe('By id.')
  })

  it('neither name nor id → held, not some other field', async () => {
    const { body } = await moved(taskWith('shipped', { reply: 'Wrong field.', replyField: { id: 'other', name: 'Internal notes' } }))
    expect(body.outcome).toBe('held')
    expect(itemWrites()).toEqual([])
  })
})

describe('only taskStatusUpdated is handled', () => {
  it.each(['taskCommentPosted', 'taskUpdated', 'taskCreated'])('%s is ignored without reading the task', async (ev) => {
    fake.client = makeClient({ getTask: vi.fn(async () => taskWith('shipped', { reply: 'x' })) })
    const { body } = await deliver({ event: ev, task_id: TASK_ID })
    expect(body.outcome).toBe('ignored')
    expect(fake.client.getTask).not.toHaveBeenCalled()
    expect(itemWrites()).toEqual([])
  })
})

// ─── the status map ──────────────────────────────────────────────────

const NINE: [string, string][] = [
  ['Submitted', 'submitted'],
  ['Looking at it', 'under_review'],
  ['Needs input', 'under_review'],
  ['On the list', 'planned'],
  ['In progress', 'planned'],
  ['Testing', 'planned'],
  ['Shipped', 'shipped'],
  ['Answered', 'answered'],
  ['Not doing', 'declined'],
]

// Exactly what the live board stores (confirmed 2026-10-22).
const LIVE_LOWERCASE: [string, string][] = [
  ['submitted', 'submitted'],
  ['on the list', 'planned'],
  ['looking at it', 'under_review'],
  ['needs input', 'under_review'],
  ['in progress', 'planned'],
  ['testing', 'planned'],
  ['answered', 'answered'],
  ['not doing', 'declined'],
  ['shipped', 'shipped'],
]

describe('the status map', () => {
  it('has exactly the nine ClickUp statuses', () => {
    expect(Object.keys(CLICKUP_TO_BEE_DESK).sort()).toEqual(LIVE_LOWERCASE.map(([c]) => c).sort())
  })

  it.each(LIVE_LOWERCASE)('the live board\'s "%s" maps to %s', (clickup, desk) => {
    expect(mapClickUpStatus(clickup)).toBe(desk)
  })

  it.each([
    ['  On   The LIST ', 'planned'],
    ['NOT DOING', 'declined'],
    ['\tlooking  at it\n', 'under_review'],
  ])('case and whitespace are ignored: %j → %s', (clickup, desk) => {
    expect(mapClickUpStatus(clickup)).toBe(desk)
  })

  it.each([...NINE, ...LIVE_LOWERCASE])('a move to "%s" writes Bee Desk %s', async (clickup, desk) => {
    // Start from a status different from the target so a write must happen.
    h.state.row.status = desk === 'declined' ? 'planned' : 'declined'
    await moved(taskWith(clickup, { reply: 'Words from a person.' }))
    const w = itemWrites()
    expect(w).toHaveLength(1)
    expect(w[0].status).toBe(desk)
  })
})

// ─── Source gates everything ─────────────────────────────────────────

describe('Source "Owner Request" matches ignoring case', () => {
  it.each(['Owner Request', 'owner request', 'OWNER REQUEST', ' Owner  request '])(
    'an option named %j is read as an owner request', async (name) => {
      const task: any = taskWith('shipped', { reply: 'Done.' })
      task.custom_fields[0].type_config = { options: [{ id: 'opt-owner', name, orderindex: 0 }] }
      const { body } = await moved(task)
      expect(body.outcome).toBe('reply_written')
    })

  it('the create picks the board\'s "Owner Request" option', async () => {
    h.state.row = { id: ITEM_ID, clickup_task_id: null }
    const client = makeClient()
    await createClickUpTaskForFeedback({ client, db: h.db, item: { id: ITEM_ID, title: 't', status: 'planned' } })
    const body = (client.createTask.mock.calls[0] as any[])[1]
    expect(body.custom_fields[0]).toEqual({ id: SOURCE_FIELD_ID, value: 'opt-owner' })
  })
})

describe.each([['Internal', 'opt-internal'], ['Idea', 'opt-idea']])('Source %s', (_name, opt) => {
  it.each(['shipped', 'on the list'])('moving to %s triggers nothing', async (status) => {
    const { body } = await moved(taskWith(status, { source: opt, reply: 'internal chatter' }))
    expect(body.outcome).toBe('not_owner_request')
    expect(itemWrites()).toEqual([])
    expect(h.state.syncLog).toEqual([])
  })
})

// ─── the secret header ───────────────────────────────────────────────

describe('the signature gate', () => {
  it.each([
    ['no header', null],
    ['a wrong signature', 'deadbeef'],
  ])('a delivery with %s is refused 401 and touches nothing', async (_l, sig) => {
    const { status } = await deliver({ event: 'taskStatusUpdated', task_id: TASK_ID }, sig)
    expect(status).toBe(401)
    expect(fake.client.getTask).not.toHaveBeenCalled()
    expect(itemWrites()).toEqual([])
    expect(h.state.syncLog).toEqual([])
  })

  it('a delivery signed with a different secret is refused', async () => {
    const body = JSON.stringify({ event: 'taskStatusUpdated', task_id: TASK_ID })
    const other = createHmac('sha256', 'not-the-secret').update(body).digest('hex')
    const { status } = await deliver({ event: 'taskStatusUpdated', task_id: TASK_ID }, other)
    expect(status).toBe(401)
  })
})

// ─── a Bee Desk ID nobody owns ───────────────────────────────────────

describe('a Bee Desk ID that matches no row', () => {
  it('fails loudly: error outcome, sync_log error, no write', async () => {
    h.state.row = { ...h.state.row, id: 'some-other-id' }
    const { body } = await moved(taskWith('shipped', { reply: 'Done.' }))
    expect(body.ok).toBe(false)
    expect(body.error).toBe('no_feedback_item')
    expect(itemWrites()).toEqual([])
    expect(h.state.syncLog).toEqual([
      expect.objectContaining({ status: 'error', entity_type: 'feedback', entity_id: ITEM_ID }),
    ])
  })
})

// ─── outbound: the create ────────────────────────────────────────────

describe('creating a task', () => {
  const item = { id: ITEM_ID, title: 'Snooze button forgets', description: 'It resets overnight.', status: 'planned' }

  it('stores the returned id in clickup_task_id, and the task carries both custom fields', async () => {
    h.state.row = { id: ITEM_ID, clickup_task_id: null }
    const client = makeClient()
    const out = await createClickUpTaskForFeedback({ client, db: h.db, item })
    expect(out).toEqual({ created: true, task_id: 'new-task-9' })
    expect(itemWrites()).toEqual([{ clickup_task_id: 'new-task-9' }])
    const [listId, body] = client.createTask.mock.calls[0] as any[]
    expect(listId).toBe(CLICKUP_BEE_DESK_LIST_ID)
    expect(body.name).toBe('Snooze button forgets')
    expect(body.description).toBe('It resets overnight.')
    expect(body.status).toBe('on the list')
    expect(body.custom_fields).toEqual([
      { id: SOURCE_FIELD_ID, value: 'opt-owner' },
      { id: DESK_FIELD_ID, value: ITEM_ID },
    ])
  })

  it('with the custom fields missing it creates nothing and logs which ones', async () => {
    h.state.row = { id: ITEM_ID, clickup_task_id: null }
    const client = makeClient({ listFields: vi.fn(async () => []) })
    const out = await createClickUpTaskForFeedback({ client, db: h.db, item })
    expect(out).toEqual({ created: false, error: 'missing_custom_fields' })
    expect(client.createTask).not.toHaveBeenCalled()
    expect(itemWrites()).toEqual([])
    expect(h.state.syncLog[0].status).toBe('error')
    expect(h.state.syncLog[0].message).toMatch(/"Source" or "Bee Desk ID"/)
  })

  it('an item already linked is not created twice', async () => {
    h.state.row = { id: ITEM_ID, clickup_task_id: 'existing' }
    const client = makeClient()
    const out = await createClickUpTaskForFeedback({ client, db: h.db, item })
    expect(out).toEqual({ created: false, skipped: 'already_linked' })
    expect(client.createTask).not.toHaveBeenCalled()
  })

  it('with no token it fails loudly, not quietly', async () => {
    const out = await createClickUpTaskForFeedback({ client: null, db: h.db, item })
    expect(out).toEqual({ created: false, error: 'no_clickup_token' })
    expect(h.state.syncLog[0].status).toBe('error')
  })
})

// ─── direct handler checks ───────────────────────────────────────────

describe('handleClickUpEvent', () => {
  it('ignores events it was not built for', async () => {
    const out = await handleClickUpEvent({ client: fake.client, db: h.db, event: { event: 'taskCreated', task_id: TASK_ID } })
    expect(out.outcome).toBe('ignored')
    expect(fake.client.getTask).not.toHaveBeenCalled()
  })
})
