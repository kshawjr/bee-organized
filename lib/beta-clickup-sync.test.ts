// @vitest-environment node
//
// BEE DESK ↔ CLICKUP (task 868mm1h7z). The ClickUp client is always a fake —
// nothing here can reach api.clickup.com.
//
//   · a close WITH a comment writes admin_response and the mapped status
//   · a close with NO comment writes nothing and invents nothing (held)
//   · each of the nine ClickUp statuses lands as its one Bee Desk status
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
} from '@/lib/clickup-sync'
import { CLICKUP_BEE_DESK_LIST_ID } from '@/lib/clickup'
import { POST } from '@/app/api/webhooks/clickup/route'

const ITEM_ID = '11111111-2222-3333-4444-555555555555'
const TASK_ID = '86abc123'
const SOURCE_FIELD_ID = 'f-source'
const DESK_FIELD_ID = 'f-desk'
const OPTIONS = [
  { id: 'opt-owner', name: 'Owner request', orderindex: 0 },
  { id: 'opt-internal', name: 'Internal', orderindex: 1 },
  { id: 'opt-idea', name: 'Idea', orderindex: 2 },
]
const LIST_FIELDS = [
  { id: SOURCE_FIELD_ID, name: 'Source', type: 'drop_down', type_config: { options: OPTIONS } },
  { id: DESK_FIELD_ID, name: 'Bee Desk ID', type: 'short_text' },
]

function taskWith(status: string, source = 'opt-owner', deskId: string | null = ITEM_ID) {
  return {
    id: TASK_ID,
    status: { status },
    custom_fields: [
      { id: SOURCE_FIELD_ID, name: 'Source', type: 'drop_down', type_config: { options: OPTIONS }, value: source },
      { id: DESK_FIELD_ID, name: 'Bee Desk ID', type: 'short_text', value: deskId },
    ],
  }
}

function makeClient(over: Partial<Record<string, any>> = {}) {
  return {
    listFields: vi.fn(async () => LIST_FIELDS),
    createTask: vi.fn(async () => ({ id: 'new-task-9' })),
    getTask: vi.fn(async () => taskWith('shipped')),
    getComments: vi.fn(async () => [] as any[]),
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

// ─── closing statuses carry real words ───────────────────────────────

describe('a close with a comment', () => {
  it('writes admin_response from the comment and the mapped status', async () => {
    fake.client = makeClient({
      getTask: vi.fn(async () => taskWith('Shipped')),
      getComments: vi.fn(async () => [
        { id: 'c1', comment_text: 'old note', date: '1000' },
        { id: 'c2', comment_text: '  Fixed — the snooze button now sticks.  ', date: '2000' },
      ]),
    })
    const { status, body } = await deliver({ event: 'taskStatusUpdated', task_id: TASK_ID })
    expect(status).toBe(200)
    expect(body.outcome).toBe('reply_written')
    const w = itemWrites()
    expect(w).toHaveLength(1)
    expect(w[0].status).toBe('shipped')
    expect(w[0].admin_response).toBe('Fixed — the snooze button now sticks.')
    expect(typeof w[0].admin_response_at).toBe('string')
  })
})

describe('a close with no comment', () => {
  it('writes nothing to the item, invents no text, and logs a held reply loudly', async () => {
    fake.client = makeClient({
      getTask: vi.fn(async () => taskWith('answered')),
      getComments: vi.fn(async () => [{ id: 'c1', comment_text: '   ', date: '1' }]),
    })
    const { status, body } = await deliver({ event: 'taskStatusUpdated', task_id: TASK_ID })
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.outcome).toBe('held')
    expect(itemWrites()).toEqual([])
    const held = h.state.syncLog.find(r => /HELD/.test(r.message))
    expect(held?.status).toBe('error')
  })

  it('a later comment on the held task releases the close with that comment', async () => {
    fake.client = makeClient({
      getTask: vi.fn(async () => taskWith('not doing')),
      getComments: vi.fn(async () => [{ id: 'c9', comment_text: 'Not doing this one — Jobber owns that screen.', date: '5' }]),
    })
    await deliver({ event: 'taskCommentPosted', task_id: TASK_ID })
    expect(itemWrites()).toEqual([
      expect.objectContaining({ status: 'declined', admin_response: 'Not doing this one — Jobber owns that screen.' }),
    ])
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

describe('the status map', () => {
  it('has exactly the nine ClickUp statuses', () => {
    expect(Object.keys(CLICKUP_TO_BEE_DESK).sort()).toEqual(NINE.map(([c]) => c.toLowerCase()).sort())
  })

  it.each(NINE)('ClickUp "%s" writes Bee Desk %s', async (clickup, desk) => {
    expect(mapClickUpStatus(clickup)).toBe(desk)
    // Start from a status different from the target so a write must happen.
    h.state.row.status = desk === 'declined' ? 'planned' : 'declined'
    fake.client = makeClient({
      getTask: vi.fn(async () => taskWith(clickup)),
      getComments: vi.fn(async () => [{ id: 'c', comment_text: 'Words from a person.', date: '1' }]),
    })
    await deliver({ event: 'taskStatusUpdated', task_id: TASK_ID })
    const w = itemWrites()
    expect(w).toHaveLength(1)
    expect(w[0].status).toBe(desk)
  })
})

// ─── Source gates everything ─────────────────────────────────────────

describe.each([['Internal', 'opt-internal'], ['Idea', 'opt-idea']])('Source %s', (_name, opt) => {
  it.each(['Shipped', 'On the list'])('moving to %s triggers nothing', async (status) => {
    fake.client = makeClient({
      getTask: vi.fn(async () => taskWith(status, opt)),
      getComments: vi.fn(async () => [{ id: 'c', comment_text: 'internal chatter', date: '1' }]),
    })
    const { body } = await deliver({ event: 'taskStatusUpdated', task_id: TASK_ID })
    expect(body.outcome).toBe('not_owner_request')
    expect(itemWrites()).toEqual([])
    expect(h.state.syncLog).toEqual([])
    expect(fake.client.getComments).not.toHaveBeenCalled()
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
    fake.client = makeClient({
      getTask: vi.fn(async () => taskWith('shipped')),
      getComments: vi.fn(async () => [{ id: 'c', comment_text: 'Done.', date: '1' }]),
    })
    const { body } = await deliver({ event: 'taskStatusUpdated', task_id: TASK_ID })
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
    expect(body.status).toBe('On the list')
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
