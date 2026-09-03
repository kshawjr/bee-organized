// @vitest-environment node
//
// THE HELP SECTION'S SERVER CONTRACT.
//
//   · an owner's GET carries no draft item, no empty topic, no empty section
//   · an editor's GET carries drafts (marked) and the deleted list
//   · an owner cannot reach ANY authoring route directly — POST, PATCH,
//     DELETE, move, sign all 403 (401 when signed out)
//   · an editor's POST lands the row at the bottom of its level
//   · the sign route refuses an over-limit or wrong-type file in words
//   · a missing help_entries table degrades to an empty tree, never a 500
//   · the pure helpers: tree build, reorder swap, step parsing, input rules
//   · the ask strip's help_entry_id survives the feedback context whitelist
//   · /help is a Hub route: URL ↔ nav both ways
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildHelpTree, deletedRoots, moveSibling, normalizeSteps, normalizeEntryInput,
  helpMediaUrl, helpBreadcrumb, isHelpEditorRole, isMissingHelpTable, mediaLimitProblem,
  HELP_VIDEO_MAX_BYTES, HELP_IMAGE_MAX_BYTES,
} from '@/lib/help-content'
import { buildSafeContext } from '@/lib/feedback-context'
import { parseHubUrl, NAV_TO_URL, ROUTE_TO_NAV, navScreenLabel } from '@/components/hive/shared/hubUrl'

// ── a recording Supabase double ───────────────────────────────────────
const h = vi.hoisted(() => {
  const state: any = {
    user: { id: 'u-owner' },
    role: 'owner',
    respond: (_ctx: any) => ({ data: null, error: null }),
    calls: [] as any[],
    signResult: { data: { token: 'tok-1', signedUrl: 'https://x/upload' }, error: null },
  }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', filters: {}, isNull: {}, payload: null, order: null, limit: null, cols: null }
    const b: any = {}
    const chain = (fn: (...a: any[]) => void) => (...a: any[]) => { fn(...a); return b }
    b.select = chain((cols?: any) => { if (ctx.op === 'select') ctx.cols = cols })
    b.insert = chain((p: any) => { ctx.op = 'insert'; ctx.payload = p })
    b.update = chain((p: any) => { ctx.op = 'update'; ctx.payload = p })
    b.eq = chain((c: string, v: any) => { ctx.filters[c] = v })
    b.is = chain((c: string, v: any) => { ctx.isNull[c] = v })
    b.order = chain((c: string, o: any) => { ctx.order = { c, ...o } })
    b.limit = chain((n: number) => { ctx.limit = n })
    const resolve = () => { state.calls.push(ctx); return Promise.resolve(state.respond(ctx)) }
    b.single = resolve
    b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
    return b
  }
  return { state, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (t: string) => h.makeBuilder(t, 'service'),
    storage: { from: (_b: string) => ({ createSignedUploadUrl: async (_p: string) => h.state.signResult }) },
  },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.user } }) },
    from: (t: string) => {
      const b = h.makeBuilder(t, 'session')
      if (t === 'hub_users') {
        b.single = async () => ({ data: h.state.user ? { role: h.state.role } : null, error: null })
      }
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/help/entries/route'
import { PATCH, DELETE } from '@/app/api/help/entries/[id]/route'
import { POST as MOVE } from '@/app/api/help/entries/[id]/move/route'
import { POST as SIGN } from '@/app/api/help/media/sign/route'

const req = (method: string, body?: any, url = 'http://x/api/help/entries') =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) as any

const row = (over: any) => ({
  id: 'x', kind: 'item', parent_id: null, position: 0, title: 'Row', status: 'published',
  deleted_at: null, steps: [], media_kind: null, media_path: null, lead: null, callout: null, ...over,
})

// Getting started › Connect Jobber › {published, draft}; Home › (empty topic)
const ROWS = [
  row({ id: 's1', kind: 'section', title: 'Getting started', position: 0 }),
  row({ id: 's2', kind: 'section', title: 'Home', position: 1 }),
  row({ id: 't1', kind: 'topic', parent_id: 's1', title: 'Connect Jobber', position: 0 }),
  row({ id: 't2', kind: 'topic', parent_id: 's2', title: 'Empty topic', position: 0 }),
  row({ id: 'i1', kind: 'item', parent_id: 't1', title: 'Turn on alerts', position: 0, media_kind: 'video', media_path: 'video/a.mp4', steps: ['Open Settings', 'Tap Notifications'] }),
  row({ id: 'i2', kind: 'item', parent_id: 't1', title: 'Half written', position: 1, status: 'draft' }),
  row({ id: 'i3', kind: 'item', parent_id: 't1', title: 'Gone', position: 2, deleted_at: '2026-09-01T00:00:00Z' }),
]

beforeEach(() => {
  h.state.user = { id: 'u-owner' }
  h.state.role = 'owner'
  h.state.calls = []
  h.state.respond = (ctx: any) => {
    if (ctx.table === 'help_entries' && ctx.op === 'select') return { data: ROWS, error: null }
    return { data: null, error: null }
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
})

// ─── who sees what ────────────────────────────────────────────────────

describe('GET /api/help/entries', () => {
  it('an owner gets published items only — no draft, no empty topic or section, no deleted list', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.canEdit).toBe(false)
    expect(body.deleted).toEqual([])
    expect(body.sections.map((s: any) => s.title)).toEqual(['Getting started'])
    const items = body.sections[0].children[0].children
    expect(items.map((i: any) => i.title)).toEqual(['Turn on alerts'])
    expect(JSON.stringify(body)).not.toContain('Half written')
    expect(JSON.stringify(body)).not.toContain('Gone')
    expect(items[0].media_url).toBe('https://proj.supabase.co/storage/v1/object/public/help-media/video/a.mp4')
  })

  it('a corporate user (db role admin) gets the draft, marked, plus the deleted list', async () => {
    h.state.role = 'admin'
    const body = await (await GET()).json()
    expect(body.canEdit).toBe(true)
    const items = body.sections[0].children[0].children
    expect(items.map((i: any) => [i.title, i.status])).toEqual([['Turn on alerts', 'published'], ['Half written', 'draft']])
    expect(body.sections.map((s: any) => s.title)).toEqual(['Getting started', 'Home'])
    expect(body.deleted).toEqual([{ id: 'i3', kind: 'item', title: 'Gone', deleted_at: '2026-09-01T00:00:00Z' }])
  })

  it('a super admin is an editor too', async () => {
    h.state.role = 'super_admin'
    const body = await (await GET()).json()
    expect(body.canEdit).toBe(true)
    expect(JSON.stringify(body)).toContain('Half written')
  })

  it('signed out → 401', async () => {
    h.state.user = null
    expect((await GET()).status).toBe(401)
  })

  it('before the migration runs, the tree is empty and flagged — not a 500', async () => {
    h.state.respond = () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.help_entries' in the schema cache" } })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sections: [], deleted: [], canEdit: false, notSetUp: true })
  })
})

// ─── the authoring routes are closed to owners, at the route ─────────

describe('an owner cannot reach the authoring routes directly', () => {
  const params = { params: { id: 'i1' } }
  it('POST / PATCH / DELETE / move / sign all 403 for owner, manager and lite_user', async () => {
    for (const role of ['owner', 'manager', 'lite_user']) {
      h.state.role = role
      expect((await POST(req('POST', { kind: 'section', title: 'X' }))).status, `POST as ${role}`).toBe(403)
      expect((await PATCH(req('PATCH', { title: 'Y' }), params)).status, `PATCH as ${role}`).toBe(403)
      expect((await DELETE(req('DELETE'), params)).status, `DELETE as ${role}`).toBe(403)
      expect((await MOVE(req('POST', { direction: 'up' }), params)).status, `move as ${role}`).toBe(403)
      expect((await SIGN(req('POST', { name: 'a.mp4', type: 'video/mp4', size: 1000 }))).status, `sign as ${role}`).toBe(403)
    }
    // and nothing was written
    expect(h.state.calls.filter(c => c.client === 'service' && c.op !== 'select')).toEqual([])
  })

  it('signed out → 401 on every one', async () => {
    h.state.user = null
    expect((await POST(req('POST', { kind: 'section', title: 'X' }))).status).toBe(401)
    expect((await PATCH(req('PATCH', { title: 'Y' }), params)).status).toBe(401)
    expect((await DELETE(req('DELETE'), params)).status).toBe(401)
    expect((await MOVE(req('POST', { direction: 'up' }), params)).status).toBe(401)
    expect((await SIGN(req('POST', { name: 'a.mp4', type: 'video/mp4', size: 1000 }))).status).toBe(401)
  })
})

// ─── editors can write ────────────────────────────────────────────────

describe('an editor writes', () => {
  beforeEach(() => { h.state.role = 'admin'; h.state.user = { id: 'u-corp' } })

  it('POST adds an item at the bottom of its topic, as a draft when asked', async () => {
    h.state.respond = (ctx: any) => {
      if (ctx.op === 'select' && ctx.filters.id === 't1') return { data: { id: 't1', kind: 'topic', deleted_at: null }, error: null }
      if (ctx.op === 'select' && ctx.cols === 'position') return { data: { position: 4 }, error: null }
      if (ctx.op === 'insert') return { data: { id: 'new', ...ctx.payload }, error: null }
      return { data: null, error: null }
    }
    const res = await POST(req('POST', { kind: 'item', parent_id: 't1', title: '  Turn on alerts ', lead: 'One line', steps: '1. Open Settings\n2. Tap Notifications\n\n', callout: 'Only the assignee', status: 'draft', media_kind: 'image', media_path: 'image/abc.png' }))
    expect(res.status).toBe(201)
    const ins = h.state.calls.find(c => c.op === 'insert')
    expect(ins.payload).toMatchObject({
      kind: 'item', parent_id: 't1', title: 'Turn on alerts', lead: 'One line',
      steps: ['Open Settings', 'Tap Notifications'], callout: 'Only the assignee', status: 'draft',
      media_kind: 'image', media_path: 'image/abc.png', position: 5, created_by: 'u-corp',
    })
  })

  it('POST refuses an item under a section (items live under topics)', async () => {
    h.state.respond = (ctx: any) => {
      if (ctx.op === 'select' && ctx.filters.id === 's1') return { data: { id: 's1', kind: 'section', deleted_at: null }, error: null }
      return { data: null, error: null }
    }
    const res = await POST(req('POST', { kind: 'item', parent_id: 's1', title: 'X' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('must sit under a topic')
  })

  it('DELETE is soft — an update that stamps deleted_at, never a delete', async () => {
    h.state.respond = (ctx: any) => ctx.op === 'update' ? { data: { id: 'i1', kind: 'item', title: 'Turn on alerts', deleted_at: ctx.payload.deleted_at }, error: null } : { data: null, error: null }
    const res = await DELETE(req('DELETE'), { params: { id: 'i1' } })
    expect(res.status).toBe(200)
    const upd = h.state.calls.find(c => c.op === 'update')
    expect(upd.payload.deleted_at).toBeTruthy()
    expect(upd.isNull.deleted_at).toBeNull()
    expect(h.state.calls.some(c => c.op === 'delete')).toBe(false)
  })

  it('PATCH { restore: true } clears the stamp and touches nothing else', async () => {
    h.state.respond = (ctx: any) => {
      if (ctx.op === 'select') return { data: ROWS.find(r => r.id === 'i3'), error: null }
      if (ctx.op === 'update') return { data: { id: 'i3', deleted_at: null }, error: null }
      return { data: null, error: null }
    }
    const res = await PATCH(req('PATCH', { restore: true }), { params: { id: 'i3' } })
    expect(res.status).toBe(200)
    const upd = h.state.calls.find(c => c.op === 'update')
    expect(Object.keys(upd.payload).sort()).toEqual(['deleted_at', 'updated_at', 'updated_by'])
    expect(upd.payload.deleted_at).toBeNull()
  })

  it('PATCH re-validates the whole row and can publish a draft', async () => {
    h.state.respond = (ctx: any) => {
      if (ctx.op === 'select') return { data: ROWS.find(r => r.id === 'i2'), error: null }
      if (ctx.op === 'update') return { data: { id: 'i2', ...ctx.payload }, error: null }
      return { data: null, error: null }
    }
    const res = await PATCH(req('PATCH', { title: 'Now written', steps: ['Do this'], status: 'published' }), { params: { id: 'i2' } })
    expect(res.status).toBe(200)
    const upd = h.state.calls.find(c => c.op === 'update')
    expect(upd.payload).toMatchObject({ title: 'Now written', steps: ['Do this'], status: 'published' })
  })

  it('move swaps positions with the neighbour and renumbers the level', async () => {
    const siblings = ROWS.filter(r => r.parent_id === 't1' && !r.deleted_at)
    h.state.respond = (ctx: any) => {
      if (ctx.op === 'select' && ctx.filters.id === 'i2') return { data: { id: 'i2', parent_id: 't1' }, error: null }
      if (ctx.op === 'select') return { data: siblings, error: null }
      return { data: null, error: null }
    }
    const res = await MOVE(req('POST', { direction: 'up' }), { params: { id: 'i2' } })
    expect(await res.json()).toMatchObject({ ok: true, moved: true })
    const writes = h.state.calls.filter(c => c.op === 'update').map(c => [c.filters.id, c.payload.position])
    expect(writes).toEqual([['i1', 1], ['i2', 0]])
  })
})

// ─── the upload gate ──────────────────────────────────────────────────

describe('POST /api/help/media/sign', () => {
  beforeEach(() => { h.state.role = 'super_admin'; h.state.user = { id: 'u-kevin' } })

  it('mints a token and a public URL for a video within limits', async () => {
    const res = await SIGN(req('POST', { name: 'clip.mov', type: 'video/quicktime', size: 40 * 1024 * 1024, seconds: 61 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kind).toBe('video')
    expect(body.path).toMatch(/^video\/[0-9a-f-]{36}\.mov$/)
    expect(body.token).toBe('tok-1')
    expect(body.publicUrl).toBe(`https://proj.supabase.co/storage/v1/object/public/help-media/${body.path}`)
  })

  it('refuses a video over 100 MB, or over two minutes, in words — 413', async () => {
    const big = await SIGN(req('POST', { name: 'a.mp4', type: 'video/mp4', size: HELP_VIDEO_MAX_BYTES + 1 }))
    expect(big.status).toBe(413)
    expect((await big.json()).error).toContain('over 100 MB')
    const long = await SIGN(req('POST', { name: 'a.mp4', type: 'video/mp4', size: 1000, seconds: 200 }))
    expect(long.status).toBe(413)
    expect((await long.json()).error).toContain('two minutes')
  })

  it('refuses a screenshot over 10 MB and a type that is neither video nor image', async () => {
    expect((await SIGN(req('POST', { name: 'a.png', type: 'image/png', size: HELP_IMAGE_MAX_BYTES + 1 }))).status).toBe(413)
    const pdf = await SIGN(req('POST', { name: 'a.pdf', type: 'application/pdf', size: 10 }))
    expect(pdf.status).toBe(400)
    expect((await pdf.json()).error).toContain('isn’t supported')
  })

  it('says so when the bucket is missing (migration not run)', async () => {
    h.state.signResult = { data: null, error: { message: 'Bucket not found' } }
    const res = await SIGN(req('POST', { name: 'a.mp4', type: 'video/mp4', size: 10 }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('help_entries.sql')
    h.state.signResult = { data: { token: 'tok-1', signedUrl: 'https://x/upload' }, error: null }
  })
})

// ─── pure helpers ─────────────────────────────────────────────────────

describe('lib/help-content', () => {
  it('editor roles are the two database roles behind Super Admin and Corporate', () => {
    expect(isHelpEditorRole('super_admin')).toBe(true)
    expect(isHelpEditorRole('admin')).toBe(true)
    for (const r of ['owner', 'manager', 'lite_user', 'corporate', '', null]) expect(isHelpEditorRole(r)).toBe(false)
  })

  it('buildHelpTree hides drafts and empty containers for owners, keeps them for editors, and drops deleted subtrees for both', () => {
    const owner = buildHelpTree(ROWS as any, { includeDrafts: false })
    expect(owner.map(s => s.title)).toEqual(['Getting started'])
    expect(owner[0].children[0].children.map(i => i.title)).toEqual(['Turn on alerts'])
    const editor = buildHelpTree(ROWS as any, { includeDrafts: true })
    expect(editor.map(s => s.title)).toEqual(['Getting started', 'Home'])
    expect(editor[0].children[0].children.map(i => i.title)).toEqual(['Turn on alerts', 'Half written'])
    // a deleted SECTION takes its topics and items with it
    const rows = ROWS.map(r => r.id === 's1' ? { ...r, deleted_at: '2026-09-01T00:00:00Z' } : r)
    expect(buildHelpTree(rows as any, { includeDrafts: true }).map(s => s.title)).toEqual(['Home'])
    expect(deletedRoots(rows as any).map(r => r.id)).toEqual(['s1'])
  })

  it('moveSibling swaps with the neighbour and returns null at the edge', () => {
    const sib = [{ id: 'a', position: 0 }, { id: 'b', position: 1 }, { id: 'c', position: 1 }] as any
    expect(moveSibling(sib, 'a', 'up')).toBeNull()
    expect(moveSibling(sib, 'c', 'down')).toBeNull()
    expect(moveSibling(sib, 'c', 'up')).toEqual([{ id: 'a', position: 0 }, { id: 'b', position: 2 }, { id: 'c', position: 1 }])
  })

  it('normalizeSteps takes an array or one-per-line text, strips numbering and bullets', () => {
    expect(normalizeSteps('1. Open Settings\n- Tap Notifications\n• Turn it on\n\n  ')).toEqual(['Open Settings', 'Tap Notifications', 'Turn it on'])
    expect(normalizeSteps(['  a ', '', 'b'])).toEqual(['a', 'b'])
    expect(normalizeSteps(null)).toEqual([])
  })

  it('normalizeEntryInput enforces the shape rules in words', () => {
    expect(normalizeEntryInput({ kind: 'section', title: '' }).problem).toBe('A title is required.')
    expect(normalizeEntryInput({ kind: 'topic', title: 'T' }).problem).toBe('A topic needs a parent.')
    expect(normalizeEntryInput({ kind: 'section', title: 'S', parent_id: 'x' }).problem).toBe('A section has no parent.')
    expect(normalizeEntryInput({ kind: 'item', title: 'I', parent_id: 't', media_kind: 'video' }).problem).toBe('Media needs both a kind and a path.')
    expect(normalizeEntryInput({ kind: 'item', title: 'I', parent_id: 't', media_kind: 'video', media_path: 'image/x.png' }).problem).toBe('invalid media path')
    // sections and topics are always published, whatever the body says
    expect(normalizeEntryInput({ kind: 'topic', title: 'T', parent_id: 's', status: 'draft' }).input!.status).toBe('published')
    expect(normalizeEntryInput({ kind: 'item', title: 'I', parent_id: 't', status: 'draft' }).input!.status).toBe('draft')
  })

  it('media limits and URLs', () => {
    expect(mediaLimitProblem('video', 10, 119)).toBeNull()
    expect(mediaLimitProblem('video', 10, null)).toBeNull()
    expect(mediaLimitProblem('image', HELP_IMAGE_MAX_BYTES)).toBeNull()
    expect(helpMediaUrl(null, 'https://p.supabase.co')).toBeNull()
    expect(helpMediaUrl('image/a b.png', 'https://p.supabase.co/')).toBe('https://p.supabase.co/storage/v1/object/public/help-media/image/a%20b.png')
    expect(isMissingHelpTable({ code: '42P01' })).toBe(true)
    expect(isMissingHelpTable({ code: '23505', message: 'duplicate key' })).toBe(false)
  })

  it('helpBreadcrumb joins titles with ›', () => {
    expect(helpBreadcrumb([{ title: 'Getting started' }, null, { title: 'Connect Jobber' }])).toBe('Getting started › Connect Jobber')
  })
})

// ─── the ask strip's context survives the feedback whitelist ─────────

describe('the ask strip context', () => {
  it('help_entry_id is a whitelisted, id-only key', () => {
    expect(buildSafeContext({ origin: 'help_ask_strip', screen: 'Help', help_entry_id: 'i1', name: 'Nope' }))
      .toEqual({ origin: 'help_ask_strip', screen: 'Help', help_entry_id: 'i1' })
  })
})

// ─── /help is a Hub route ─────────────────────────────────────────────

describe('/help in the URL vocabulary', () => {
  it('maps both ways and labels the screen', () => {
    expect(parseHubUrl('/help', '')).toEqual({ nav: 'help', leadId: null, engagementId: null })
    expect(ROUTE_TO_NAV.help).toBe('help')
    expect(NAV_TO_URL.help).toBe('/help')
    expect(navScreenLabel('help')).toBe('Help')
  })
})
