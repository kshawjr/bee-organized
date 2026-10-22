// @vitest-environment node
//
// THE TRIAGE SAVE OPENS THE CLICKUP TASK (task 868mm1h7z) — the PATCH route
// half of the outbound create. The ClickUp client is a fake.
//
//   · a team save that leaves an owner's item open past 'submitted' creates a
//     task and stores its id in clickup_task_id
//   · an internal item, an owner's own save, a 'submitted' item and a closed
//     item create nothing
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, any>,
    updates: [] as { table: string; arg: any }[],
  }
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ['select', 'order', 'limit', 'is', 'not', 'in', 'eq']) b[m] = () => b
    b.update = (arg: any) => { state.updates.push({ table, arg }); b.__update = arg; return b }
    b.insert = (arg: any) => { b.__insert = arg; return b }
    const resolve = () => {
      if (b.__insert) return { data: { id: `${table}-new`, ...b.__insert }, error: null }
      if (b.__update) {
        state.rows[table] = { ...(state.rows[table] || {}), ...b.__update }
        return { data: state.rows[table], error: null }
      }
      return { data: state.rows[table] ?? null, error: null }
    }
    b.single = () => Promise.resolve(resolve())
    b.maybeSingle = () => Promise.resolve(resolve())
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }
  return { state, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'admin-1' } as any }))
const fake = vi.hoisted(() => ({ client: null as any }))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: vi.fn(async () => ({ success: true, id: 'm' })) }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/clickup', async () => {
  const actual = await vi.importActual<any>('@/lib/clickup')
  return { ...actual, clickUpClientFromEnv: () => fake.client }
})

import { PATCH } from '@/app/api/admin/feedback/[id]/route'

const ITEM = {
  id: 'fb-1', location_id: 'loc-1', user_id: 'owner-9', type: 'bug',
  title: 'Snooze button forgets', description: 'It resets overnight.', status: 'submitted',
  admin_response: null as string | null, is_internal: false, clickup_task_id: null as string | null,
}
const ADMIN = { id: 'admin-1', role: 'super_admin', location_id: null }
const OWNER = { id: 'owner-9', role: 'owner', location_id: 'loc-1' }

const patch = async (body: any) => {
  const res = await PATCH({ json: async () => body } as any, { params: { id: 'fb-1' } })
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.state.rows = { hub_users: { ...ADMIN }, feedback_items: { ...ITEM } }
  h.state.updates = []
  authUser.current = { id: 'admin-1' }
  fake.client = {
    listFields: vi.fn(async () => [
      { id: 'f-source', name: 'Source', type: 'drop_down', type_config: { options: [{ id: 'opt-owner', name: 'Owner Request' }] } },
      { id: 'f-desk', name: 'Bee Desk ID', type: 'short_text' },
    ]),
    createTask: vi.fn(async () => ({ id: 'cu-task-77' })),
    getTask: vi.fn(),
  }
})

describe('triage creates the ClickUp task', () => {
  it('moving an owner item to On the list creates a task and stores its id', async () => {
    const { status, body } = await patch({ status: 'planned' })
    expect(status).toBe(200)
    expect(fake.client.createTask).toHaveBeenCalledTimes(1)
    expect(body.clickup).toEqual({ created: true, task_id: 'cu-task-77' })
    expect(h.state.updates.map(u => u.arg)).toContainEqual({ clickup_task_id: 'cu-task-77' })
  })

  it.each([
    ['an internal item', () => { h.state.rows.feedback_items.is_internal = true }, { status: 'planned' }],
    ['a save that leaves the item at submitted', () => {}, { assigned_to: 'admin-1' }],
    ['a save straight to a closed status', () => {}, { status: 'declined' }],
  ])('%s creates nothing', async (_l, setup, body) => {
    setup()
    const res = await patch(body)
    expect(res.status).toBe(200)
    expect(fake.client.createTask).not.toHaveBeenCalled()
    expect(res.body.clickup).toBeNull()
  })

  it('an owner moving their own location’s item creates nothing', async () => {
    authUser.current = { id: 'owner-9' }
    h.state.rows.hub_users = { ...OWNER }
    const res = await patch({ status: 'planned' })
    expect(res.status).toBe(200)
    expect(fake.client.createTask).not.toHaveBeenCalled()
  })
})
