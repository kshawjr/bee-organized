// @vitest-environment node
//
// AN OWNER MAY EDIT AND DELETE THEIR OWN NOTE — and only their own.
//
// Two verbs arriving by different roads. DELETE was fully built and simply
// never wired to a button; EDIT did not exist. So the risk is not that delete
// is wrong — it has been right and unreachable — but that PATCH, written
// second, quietly grants something DELETE refuses.
//
// THE ROUTE REFUSES, NOT THE SCREEN. Every refusal below is asserted against
// the handler with a forged request, the way beta-feedback-edit-delete does
// it. A hidden button is not a rule: the card decides whether to DRAW a
// pencil, and this decides who may act.
//
// THE WALL IS user_id, NEVER location_id. A colleague at the SAME location is
// refused, and so is a manager — neither is the author and neither is an
// admin. That is the single most important pin here, because "same location"
// is the intuition that would quietly widen this rule if anyone rewrote it.
//
// ONE RULE, TWO VERBS: the pair of parity tests at the end walks every
// refusal shape through BOTH handlers and asserts they answer identically.
// That is what stops PATCH and DELETE drifting later.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    note: null as any,
    hubUser: null as any,
    authUser: { id: 'u-author' } as any,
    updates: [] as any[],
    deletes: [] as any[],
    updateError: null as any,
    updatedRow: null as any,
    missingColumnOnly: false,
  }
  const reset = () => {
    state.note = null; state.hubUser = null; state.authUser = { id: 'u-author' }
    state.updates = []; state.deletes = []; state.updateError = null; state.updatedRow = null
    state.missingColumnOnly = false
  }
  return { state, reset }
})

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: h.state.authUser } })) },
    from: () => {
      const b: any = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.single = async () => ({ data: h.state.hubUser, error: h.state.hubUser ? null : { message: 'none' } })
      return b
    },
  })),
}))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      const b: any = { _op: null, _arg: null }
      for (const m of ['select', 'eq']) b[m] = () => b
      b.update = (arg: any) => { b._op = 'update'; b._arg = arg; h.state.updates.push({ table, arg }); return b }
      b.delete = () => { b._op = 'delete'; h.state.deletes.push({ table }); return b }
      b.single = async () => {
        if (b._op === 'update') {
          // The database objects to the COLUMN, not to the write. A missing
          // edited_at fails only the attempt that names it, so the retry
          // without it succeeds — which is the behaviour under test. Any
          // other configured error applies to every attempt, as a real
          // constraint violation would.
          const blames = h.state.updateError
            && (!h.state.missingColumnOnly || 'edited_at' in (b._arg || {}))
          if (blames) return { data: null, error: h.state.updateError }
          return { data: h.state.updatedRow ?? { ...h.state.note, ...b._arg }, error: null }
        }
        return { data: h.state.note, error: h.state.note ? null : { message: 'not found' } }
      }
      b.then = (res: any, rej: any) =>
        Promise.resolve(b._op === 'delete' ? { error: null } : { data: h.state.note, error: null }).then(res, rej)
      return b
    },
  },
}))

// The read-only guard has its own suite; here it must simply not interfere.
vi.mock('@/lib/read-only-access', () => ({
  readOnlyWriteBlock: vi.fn(async () => null),
}))

import { PATCH, DELETE } from '@/app/api/lead-notes/[id]/route'
import { noteEditAuthError, isMissingEditedAtColumn } from '@/lib/lead-note-edit'

const LOC = 'loc-uuid-1'
const NOTE = (over: any = {}) => ({
  id: 'n1', lead_id: 'c1', location_uuid: LOC, kind: 'job',
  user_id: 'u-author', text: 'The original text', ...over,
})

const AUTHOR   = { id: 'u-author',    role: 'owner',       location_id: LOC }
const COLLEAGUE= { id: 'u-colleague', role: 'owner',       location_id: LOC }   // SAME location
const MANAGER  = { id: 'u-manager',   role: 'manager',     location_id: LOC }   // SAME location
const ADMIN    = { id: 'u-admin',     role: 'admin',       location_id: null }
const SUPER    = { id: 'u-super',     role: 'super_admin', location_id: null }

const patch = (body: any = { text: 'Edited text' }) =>
  PATCH(
    new Request('http://test/api/lead-notes/n1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as any,
    { params: Promise.resolve({ id: 'n1' }) },
  )

const del = () =>
  DELETE(new Request('http://test/api/lead-notes/n1', { method: 'DELETE' }) as any,
    { params: Promise.resolve({ id: 'n1' }) })

beforeEach(() => { h.reset(); h.state.note = NOTE() })

describe('the author may edit and delete their own note', () => {
  it('the author edits: 200, the text is written', async () => {
    h.state.hubUser = AUTHOR
    const res = await patch({ text: 'Edited text' })
    expect(res.status).toBe(200)
    expect(h.state.updates[0].arg.text).toBe('Edited text')
  })

  it('the author deletes: 200', async () => {
    h.state.hubUser = AUTHOR
    const res = await del()
    expect(res.status).toBe(200)
    expect(h.state.deletes).toHaveLength(1)
  })

  it('an edit stamps edited_at, so the card can say so', async () => {
    // Kevin's ruling: an edited note shows it was edited. Nothing else in the
    // row records that — created_at cannot distinguish a note edited a second
    // after writing from one never touched.
    h.state.hubUser = AUTHOR
    await patch({ text: 'Edited text' })
    expect(h.state.updates[0].arg.edited_at).toEqual(expect.any(String))
    expect(Number.isNaN(Date.parse(h.state.updates[0].arg.edited_at))).toBe(false)
  })

  it('the text is trimmed, and an empty edit is refused', async () => {
    h.state.hubUser = AUTHOR
    await patch({ text: '  padded  ' })
    expect(h.state.updates[0].arg.text).toBe('padded')

    h.state.updates.length = 0
    const res = await patch({ text: '   ' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('text_required')
    expect(h.state.updates).toHaveLength(0) // nothing written
  })
})

describe('an admin may act on anyone’s note', () => {
  it('admin edits someone else’s note: 200', async () => {
    h.state.hubUser = ADMIN
    expect((await patch()).status).toBe(200)
  })
  it('admin deletes someone else’s note: 200', async () => {
    h.state.hubUser = ADMIN
    expect((await del()).status).toBe(200)
  })
  it('super_admin too', async () => {
    h.state.hubUser = SUPER
    expect((await patch()).status).toBe(200)
    expect((await del()).status).toBe(200)
  })
})

describe('everyone else is refused AT THE ROUTE', () => {
  it('a COLLEAGUE at the same location cannot edit — the wall is user_id', async () => {
    h.state.hubUser = COLLEAGUE
    const res = await patch()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_not_author')
    expect(h.state.updates).toHaveLength(0)
  })

  it('a COLLEAGUE at the same location cannot delete', async () => {
    h.state.hubUser = COLLEAGUE
    const res = await del()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_not_author')
    expect(h.state.deletes).toHaveLength(0)
  })

  it('a MANAGER cannot edit — manager is not admin', async () => {
    h.state.hubUser = MANAGER
    const res = await patch()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_not_author')
    expect(h.state.updates).toHaveLength(0)
  })

  it('a MANAGER cannot delete', async () => {
    h.state.hubUser = MANAGER
    const res = await del()
    expect(res.status).toBe(403)
    expect(h.state.deletes).toHaveLength(0)
  })

  it('SIGNED OUT gets 401 from both verbs', async () => {
    h.state.authUser = null
    h.state.hubUser = null
    expect((await patch()).status).toBe(401)
    expect((await del()).status).toBe(401)
    expect(h.state.updates).toHaveLength(0)
    expect(h.state.deletes).toHaveLength(0)
  })

  it('a signed-in user with no hub_user profile gets 403', async () => {
    h.state.hubUser = null
    const res = await patch()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('no_hub_user_profile')
  })

  it('the author at a DIFFERENT location is refused', async () => {
    h.state.hubUser = { ...AUTHOR, location_id: 'loc-uuid-9' }
    const res = await patch()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_wrong_location')
  })

  it('a missing note is 404, not a silent success', async () => {
    h.state.hubUser = AUTHOR
    h.state.note = null
    expect((await patch()).status).toBe(404)
    expect((await del()).status).toBe(404)
  })
})

describe('what cannot be changed', () => {
  it('a SYSTEM note is not editable and not deletable', async () => {
    // The audit trail. Refused for the author and for an admin alike.
    h.state.note = NOTE({ kind: 'system' })
    h.state.hubUser = ADMIN
    const pres = await patch()
    expect(pres.status).toBe(403)
    expect((await pres.json()).error).toBe('system_notes_cannot_be_edited')
    const dres = await del()
    expect(dres.status).toBe(403)
    expect((await dres.json()).error).toBe('system_notes_cannot_be_deleted')
  })

  it('KIND cannot be changed through the edit path', async () => {
    // buzz and job render in different places; a note changing kind is a
    // MOVE, not an edit, and would vanish out from under whoever is reading
    // it. The body is ignored rather than rejected, so passing it silently
    // does nothing.
    h.state.hubUser = AUTHOR
    const res = await patch({ text: 'Edited text', kind: 'buzz' })
    expect(res.status).toBe(200)
    expect(h.state.updates[0].arg).not.toHaveProperty('kind')
    expect(Object.keys(h.state.updates[0].arg).sort()).toEqual(['edited_at', 'text'])
  })

  it('nothing else in the body rides along either', async () => {
    h.state.hubUser = AUTHOR
    await patch({ text: 'Edited text', user_id: 'u-someone', lead_id: 'c-other', location_uuid: 'loc-9' })
    expect(Object.keys(h.state.updates[0].arg).sort()).toEqual(['edited_at', 'text'])
  })
})

describe('the edited_at column may not be applied yet', () => {
  it('falls back to writing the text alone, and still succeeds', async () => {
    // Kevin applies migrations by hand. An edit button that 500s until he
    // runs SQL would be worse than one whose marker arrives late.
    h.state.hubUser = AUTHOR
    h.state.updateError = { code: '42703', message: `column "edited_at" of relation "lead_notes" does not exist` }
    h.state.missingColumnOnly = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // First attempt carries edited_at and fails; the retry drops it.
    const res = await patch({ text: 'Edited text' })

    expect(h.state.updates).toHaveLength(2)
    expect(h.state.updates[0].arg).toHaveProperty('edited_at')
    expect(Object.keys(h.state.updates[1].arg)).toEqual(['text'])
    expect(warn).toHaveBeenCalled()
    expect(res.status).toBe(200)
  })

  it('an UNRELATED write failure is NOT mistaken for the missing column', async () => {
    // The detector names the column on purpose: a real failure must surface
    // as a 500, not be silently downgraded to a text-only write.
    h.state.hubUser = AUTHOR
    h.state.updateError = { code: '23505', message: 'duplicate key value violates unique constraint' }
    const res = await patch({ text: 'Edited text' })
    expect(res.status).toBe(500)
    expect(h.state.updates).toHaveLength(1) // no retry
  })

  it('the detector only fires on edited_at', () => {
    expect(isMissingEditedAtColumn({ code: '42703', message: 'column "edited_at" does not exist' })).toBe(true)
    expect(isMissingEditedAtColumn({ code: 'PGRST204', message: "'edited_at' column of 'lead_notes' in the schema cache" })).toBe(true)
    expect(isMissingEditedAtColumn({ code: '42703', message: 'column "former_addresses" does not exist' })).toBe(false)
    expect(isMissingEditedAtColumn({ code: '23505', message: 'duplicate key' })).toBe(false)
    expect(isMissingEditedAtColumn(null)).toBe(false)
  })
})

describe('ONE RULE, TWO VERBS — PATCH and DELETE cannot drift', () => {
  // Every refusal shape, through both handlers, asserting they agree. This is
  // the test that fails if someone widens one verb and forgets the other.
  const shapes: Array<{ name: string; hubUser: any; note?: any; status: number }> = [
    { name: 'a colleague at the same location', hubUser: COLLEAGUE, status: 403 },
    { name: 'a manager', hubUser: MANAGER, status: 403 },
    { name: 'the author at another location', hubUser: { ...AUTHOR, location_id: 'loc-9' }, status: 403 },
    { name: 'no hub_user profile', hubUser: null, status: 403 },
    { name: 'the author', hubUser: AUTHOR, status: 200 },
    { name: 'an admin', hubUser: ADMIN, status: 200 },
  ]

  for (const sh of shapes) {
    it(`${sh.name}: both verbs answer ${sh.status}`, async () => {
      h.state.note = sh.note ?? NOTE()
      h.state.hubUser = sh.hubUser
      const p = await patch()
      h.state.note = sh.note ?? NOTE()
      h.state.hubUser = sh.hubUser
      const d = await del()
      expect(p.status).toBe(sh.status)
      expect(d.status).toBe(sh.status)
    })
  }

  it('the shared helper is what both call — admins pass, non-authors do not', () => {
    expect(noteEditAuthError(NOTE(), AUTHOR)).toBeNull()
    expect(noteEditAuthError(NOTE(), ADMIN)).toBeNull()
    expect(noteEditAuthError(NOTE(), SUPER)).toBeNull()
    expect(noteEditAuthError(NOTE(), COLLEAGUE)).toBe('forbidden_not_author')
    expect(noteEditAuthError(NOTE(), MANAGER)).toBe('forbidden_not_author')
    expect(noteEditAuthError(NOTE(), { ...AUTHOR, location_id: 'loc-9' })).toBe('forbidden_wrong_location')
  })

  it('both handlers call the shared helper rather than re-deriving the rule', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'app/api/lead-notes/[id]/route.ts'), 'utf8')
    expect(src.match(/noteEditAuthError\(note, hubUser\)/g) || []).toHaveLength(2)
    // and neither re-inlines the old test
    expect(src).not.toContain('const isAuthor =')
  })
})
