// @vitest-environment node
//
// Issue 296 — the senders route, exercised rather than read.
//
// Two verbs, two facts, and the validation that was missing:
//
//   POST  who handles a set of types. Takes a person and nothing else — the
//         identity is read from their hub_users row, never from the request.
//   PUT   what ONE type sends as. Never names a person, so it cannot reassign.
//
// sender_reply_to is the point of most of this. It has had a column, a
// validator and a send-path reader since it was created, and every row in
// production is null, because no UI ever put it in a body. Its "validator" only
// ever trimmed — which was harmless while nothing could write it, and stops
// being harmless the moment a typo in settings can fail a client's drip at
// delivery time and look like a broken send.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const lib = vi.hoisted(() => ({
  getSenderConfig: vi.fn(async () => ({ assignments: [], people: [] })),
  getPickableHandler: vi.fn(async () => ({ source_user_id: 'u1', name: 'Bree', email: 'bree@x.com' })),
  setHandlerForTypes: vi.fn(async () => {}),
  setSenderIdentityForType: vi.fn(async () => {}),
  unassignTypes: vi.fn(async () => {}),
}))
vi.mock('@/lib/project-type-senders', () => lib)

// Authenticated owner of THIS location. The access predicate itself is pinned
// in project-type-senders-config.test.ts; here it just needs to say yes.
const LOC = 'loc-uuid-1'
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: 'owner-1', role: 'owner', location_id: LOC } }),
        }),
      }),
    }),
  }),
}))

import { POST, PUT } from '@/app/api/locations/[id]/project-type-senders/route'

const params = { params: { id: LOC } }
const req = (body: any) => ({ json: async () => body }) as any
const put = (body: any) => PUT(req(body), params)
const post = (body: any) => POST(req(body), params)

beforeEach(() => { vi.clearAllMocks() })

describe('PUT — an invalid reply-to is rejected', () => {
  it('rejects a malformed reply-to with 400 and writes nothing', async () => {
    const res = await put({
      project_type: 'Local Move',
      sender_is_custom: true,
      sender_name: 'Bee Organized Moving',
      sender_email: 'moving@beeorganized-kc.com',
      sender_reply_to: 'carol-at-beeorganized',   // no @
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'sender_reply_to must be a valid email' })
    expect(lib.setSenderIdentityForType).not.toHaveBeenCalled()
  })

  it('rejects a reply-to with no domain dot', async () => {
    const res = await put({
      project_type: 'Local Move', sender_is_custom: true,
      sender_name: 'X', sender_email: 'moving@beeorganized-kc.com',
      sender_reply_to: 'carol@localhost',
    })
    expect(res.status).toBe(400)
    expect(lib.setSenderIdentityForType).not.toHaveBeenCalled()
  })

  it('accepts a valid reply-to and passes it through verbatim', async () => {
    const res = await put({
      project_type: 'Local Move', sender_is_custom: true,
      sender_name: 'Bee Organized Moving', sender_email: 'moving@beeorganized-kc.com',
      sender_reply_to: '  carol@beeorganized-kc.com  ',
    })
    expect(res.status).toBe(200)
    expect(lib.setSenderIdentityForType).toHaveBeenCalledWith(LOC, 'Local Move', {
      sender_is_custom: true,
      sender_name: 'Bee Organized Moving',
      sender_email: 'moving@beeorganized-kc.com',
      sender_reply_to: 'carol@beeorganized-kc.com',
    })
  })

  it('an omitted reply-to is null, not an empty string', async () => {
    await put({
      project_type: 'Local Move', sender_is_custom: true,
      sender_name: 'X', sender_email: 'moving@beeorganized-kc.com',
    })
    expect(lib.setSenderIdentityForType.mock.calls[0][2]).toMatchObject({ sender_reply_to: null })
  })
})

describe('PUT — the rest of the contract', () => {
  it('rejects a malformed sending address', async () => {
    const res = await put({
      project_type: 'Local Move', sender_is_custom: true,
      sender_name: 'X', sender_email: 'not-an-address',
    })
    expect(res.status).toBe(400)
    expect(lib.setSenderIdentityForType).not.toHaveBeenCalled()
  })

  it('a typed sender must carry a name — an empty From name is not a choice', async () => {
    const res = await put({
      project_type: 'Local Move', sender_is_custom: true,
      sender_name: '   ', sender_email: 'moving@beeorganized-kc.com',
    })
    expect(res.status).toBe(400)
  })

  it('requires sender_is_custom to be an actual boolean', async () => {
    // Absent would otherwise read as falsy and silently switch a group inbox
    // back to a person — the exact silent-revert class this issue is about.
    const res = await put({ project_type: 'Local Move' })
    expect(res.status).toBe(400)
    expect(lib.setSenderIdentityForType).not.toHaveBeenCalled()
  })

  it('person mode needs no addresses at all', async () => {
    const res = await put({ project_type: 'Local Move', sender_is_custom: false })
    expect(res.status).toBe(200)
    expect(lib.setSenderIdentityForType).toHaveBeenCalledWith(LOC, 'Local Move', { sender_is_custom: false })
  })

  it('a type with no handler row answers 409, not 500', async () => {
    lib.setSenderIdentityForType.mockRejectedValueOnce(new Error('set_sender_identity: no handler for "Local Move"'))
    const res = await put({ project_type: 'Local Move', sender_is_custom: false })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ error: 'no_handler_for_type' })
  })
})

describe('POST — the identity is not the caller’s to supply', () => {
  it('sends only the person to the writer, whatever the body claims', async () => {
    // A body that still carries an identity must not be able to persist one:
    // person mode reads name/email from hub_users via getPickableHandler.
    const res = await post({
      source_user_id: 'u1',
      project_types: ['Local Move'],
      sender_name: 'Someone Else',
      sender_email: 'spoof@elsewhere.com',
    })
    expect(res.status).toBe(200)
    expect(lib.setHandlerForTypes).toHaveBeenCalledWith(
      LOC,
      { source_user_id: 'u1', name: 'Bree', email: 'bree@x.com' },
      ['Local Move'],
    )
  })

  it('refuses a person who is not pickable at this location', async () => {
    lib.getPickableHandler.mockResolvedValueOnce(null as any)
    const res = await post({ source_user_id: 'u-elsewhere', project_types: ['Local Move'] })
    expect(res.status).toBe(400)
    expect(lib.setHandlerForTypes).not.toHaveBeenCalled()
  })

  it('still refuses a handler with no person', async () => {
    const res = await post({ project_types: ['Local Move'] })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('must be a person') })
  })
})
