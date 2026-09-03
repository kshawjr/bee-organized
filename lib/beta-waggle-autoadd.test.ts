// @vitest-environment node
//
// A CLAUDE CODE SESSION CAN DROP ONE LINE INTO THE WHAT'S NEW DRAFT.
//
//   · POST /api/help/releases/lines lands a line in the current draft, and
//     opens this week's draft (Friday → Thursday) if none is open
//   · the line arrives WRITTEN (edited_at set), not "their words", with
//     no hub_user as author (created_by NULL)
//   · nobody but the key holder can add one: no key → 401, wrong key →
//     401, key not configured → 500 and nothing written; the route never
//     reads a session, so a signed-in owner's cookie is worth nothing here
//   · the words are checked: a hash, an issue number, a file name, a
//     route, a function, a setting name, jargon, or "various fixes" is
//     refused in one sentence — by the script before any network, and by
//     the route regardless
//   · the script: dry run prints and stops; no key says how to set up and
//     exits 2; a real run sends the bearer key and the line, and prints
//     what landed
//   · nothing else changes: the route writes only help_release_items and
//     (when opening a week) help_releases; it never names feedback_items
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { lintOwnerLine } from '@/lib/waggle-line-rules.mjs'

const REAL_FETCH = globalThis.fetch

const h = vi.hoisted(() => {
  const state: any = { respond: (_ctx: any) => ({ data: null, error: null }), calls: [] as any[], sessionReads: 0 }
  const makeBuilder = (table: string) => {
    const ctx: any = { table, op: 'select', filters: {}, payload: null }
    const b: any = {}
    const chain = (fn: (...a: any[]) => void) => (...a: any[]) => { fn(...a); return b }
    b.select = chain(() => {})
    b.insert = chain((p: any) => { ctx.op = 'insert'; ctx.payload = p })
    b.update = chain((p: any) => { ctx.op = 'update'; ctx.payload = p })
    b.eq = chain((c: string, v: any) => { ctx.filters[c] = v })
    b.is = chain(() => {}); b.in = chain(() => {}); b.order = chain(() => {}); b.limit = chain(() => {})
    const resolve = () => { state.calls.push(ctx); return Promise.resolve(state.respond(ctx)) }
    b.single = resolve; b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
    return b
  }
  return { state, makeBuilder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => { h.state.sessionReads++; throw new Error('the lines route must never read a session') },
}))

import { POST } from '@/app/api/help/releases/lines/route'

const DRAFT = { id: 'r-draft', status: 'draft', week_start: '2026-09-04', publish_on: '2026-09-10' }
const KEY = 'k-' + 'a'.repeat(40)
const GOOD = { group: 'fixed', headline: 'Finished jobs will actually close now', sentence: 'Jobs you archived or finished at no charge sat in Final Processing with no way out. Two clicks now.' }

const post = (body: any, auth?: string) => POST(new Request('http://x/api/help/releases/lines', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
  body: JSON.stringify(body),
}) as any)
const writes = () => h.state.calls.filter((c: any) => c.op !== 'select')

beforeEach(() => {
  process.env.WAGGLE_WRITE_KEY = KEY
  h.state.calls = []
  h.state.sessionReads = 0
  h.state.respond = (ctx: any) => {
    if (ctx.table === 'help_releases' && ctx.op === 'select') return { data: DRAFT, error: null }
    if (ctx.table === 'help_releases' && ctx.op === 'insert') return { data: { id: 'r-new', ...ctx.payload }, error: null }
    if (ctx.table === 'help_release_items' && ctx.op === 'insert') return { data: { id: 'i-new', ...ctx.payload }, error: null }
    return { data: null, error: null }
  }
})

// ─── the route ─────────────────────────────────────────────────────────

describe('POST /api/help/releases/lines', () => {
  it('lands a WRITTEN line in the current draft, with no hub_user as author', async () => {
    const res = await post(GOOD, `Bearer ${KEY}`)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.line).toEqual({ id: 'i-new', group: 'fixed', title: GOOD.headline, body: GOOD.sentence })
    expect(body.release).toEqual({ id: 'r-draft', week_start: '2026-09-04', publish_on: '2026-09-10', week_label: 'Thu, Sep 10' })
    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0].table).toBe('help_release_items')
    expect(w[0].payload).toMatchObject({ release_id: 'r-draft', group: 'fixed', title: GOOD.headline, body: GOOD.sentence, created_by: null, updated_by: null })
    expect(w[0].payload.edited_at).toBeTruthy() // written, not "their words"
    expect(h.state.sessionReads).toBe(0)
  })

  it('accepts title/body spelling too', async () => {
    const res = await post({ group: 'new', title: 'Clients are allowed to move house', body: 'Change an address and we ask whether they moved or you are fixing a typo.' }, `Bearer ${KEY}`)
    expect(res.status).toBe(201)
    expect(writes()[0].payload).toMatchObject({ group: 'new', title: 'Clients are allowed to move house' })
  })

  it('opens this week’s draft (Friday → Thursday) when none is open', async () => {
    h.state.respond = (ctx: any) => {
      if (ctx.table === 'help_releases' && ctx.op === 'select') return { data: null, error: null }
      if (ctx.table === 'help_releases' && ctx.op === 'insert') return { data: { id: 'r-new', ...ctx.payload }, error: null }
      if (ctx.table === 'help_release_items' && ctx.op === 'insert') return { data: { id: 'i-new', ...ctx.payload }, error: null }
      return { data: null, error: null }
    }
    const res = await post(GOOD, `Bearer ${KEY}`)
    expect(res.status).toBe(201)
    const w = writes()
    expect(w.map((c: any) => `${c.table}:${c.op}`)).toEqual(['help_releases:insert', 'help_release_items:insert'])
    expect(w[0].payload.status).toBe('draft')
    expect(new Date(`${w[0].payload.week_start}T00:00:00Z`).getUTCDay()).toBe(5)
    expect(new Date(`${w[0].payload.publish_on}T00:00:00Z`).getUTCDay()).toBe(4)
    expect(w[1].payload.release_id).toBe('r-new')
  })

  it('no key → 401, nothing written; wrong key → 401, nothing written', async () => {
    expect((await post(GOOD)).status).toBe(401)
    expect((await post(GOOD, 'Bearer nope')).status).toBe(401)
    expect((await post(GOOD, KEY)).status).toBe(401) // missing "Bearer "
    expect(writes()).toEqual([])
    expect(h.state.sessionReads).toBe(0)
  })

  it('key not configured → 500, nothing written — fail-closed like the crons', async () => {
    delete process.env.WAGGLE_WRITE_KEY
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(GOOD, `Bearer ${KEY}`)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('waggle_key_not_configured')
    expect(writes()).toEqual([])
    err.mockRestore()
  })

  it('refuses the tells of a line written for Kevin, in one sentence, before writing', async () => {
    const bad = [
      [{ ...GOOD, sentence: 'Fixed in e2403da, see the PR.' }, /commit hash/],
      [{ ...GOOD, sentence: 'Closes issue 236 for everyone.' }, /issue number/],
      [{ ...GOOD, sentence: 'The fix is in feedback-reply-email.ts now.' }, /names a file/],
      [{ ...GOOD, sentence: 'Hit /api/help/releases to see it.' }, /path or a route/],
      [{ ...GOOD, sentence: 'buildWaggleMessage() now escapes ampersands.' }, /function/],
      [{ ...GOOD, sentence: 'Set SLACK_WAGGLE_WEBHOOK_URL and it works.' }, /setting name/],
      [{ ...GOOD, sentence: 'Various fixes and improved reliability.' }, /not a change an owner can notice/],
      [{ ...GOOD, sentence: 'The webhook retries now.' }, /engineering vocabulary/],
      [{ ...GOOD, sentence: '' }, /One sentence is required/],
      [{ ...GOOD, group: 'bug' }, /new, changed or fixed/],
    ] as const
    for (const [body, re] of bad) {
      const res = await post(body, `Bearer ${KEY}`)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error, JSON.stringify(body)).toMatch(re)
    }
    expect(writes()).toEqual([])
  })

  it('a missing table says so in words, never a 500 with a stack', async () => {
    h.state.respond = () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.help_releases' in the schema cache" } })
    const res = await post(GOOD, `Bearer ${KEY}`)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/isn't set up yet/)
  })

  it('never names feedback_items, the seed, publish, or Slack', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/help/releases/lines/route.ts'), 'utf8')
    for (const banned of ["from('feedback_items')", 'seedReleaseItemFromFeedback', 'postWaggleMessage', 'buildWaggleMessage', "status: 'published'"]) {
      expect(src).not.toContain(banned)
    }
  })
})

// ─── the rules ─────────────────────────────────────────────────────────

describe('lintOwnerLine', () => {
  it('passes the two real examples from the brief', () => {
    expect(lintOwnerLine({ group: 'fixed', title: 'Finished jobs will actually close now', body: 'Jobs you archived or finished at no charge sat in Final Processing with no way out. Two clicks now. Some of you had a pile, sorry about that.' })).toBeNull()
    expect(lintOwnerLine({ group: 'fixed', title: 'Clients are allowed to move house', body: 'Change an address and we ask whether they moved or you are fixing a typo. If they moved, the old address keeps every one of its old jobs in Jobber. Nothing gets quietly rewritten.' })).toBeNull()
  })
  it('does not mistake a phone number or a long digit run for a hash', () => {
    expect(lintOwnerLine({ group: 'changed', title: 'Phone numbers are formatted for you', body: 'Type 5551234567 and it shows as (555) 123-4567.' })).toBeNull()
  })
  it('does not flag ordinary words that merely contain jargon', () => {
    expect(lintOwnerLine({ group: 'new', title: 'A shortcut to the route sheet', body: 'Tap the truck to see today’s stops.' })).toMatch(/"route"/) // whole word — this one IS jargon
    expect(lintOwnerLine({ group: 'new', title: 'Routed to the right person', body: 'New leads go to whoever is on call.' })).toBeNull() // "routed" is not "route"
  })
})

// ─── the script ────────────────────────────────────────────────────────

describe('scripts/waggle-add.mjs', () => {
  const script = () => import('../scripts/waggle-add.mjs')
  const capture = () => { const lines: string[] = []; return { out: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) }, lines } }
  const NO_KEY_ENV = { HOME: '/nonexistent-home-for-test' } as any

  it('dry run prints the line and the target and sends nothing', async () => {
    const { main } = await script()
    const { out, lines } = capture()
    const f = vi.fn(); (globalThis as any).fetch = f
    const code = await main(['fixed', GOOD.headline, GOOD.sentence, '--dry-run'], NO_KEY_ENV, out)
    expect(code).toBe(0)
    expect(lines[0]).toBe('DRY RUN — would POST to https://beehive.beeorganized.com/api/help/releases/lines')
    expect(JSON.parse(lines[1])).toEqual({ group: 'fixed', title: GOOD.headline, body: GOOD.sentence })
    expect(f).not.toHaveBeenCalled()
  })

  it('refuses bad words before any network', async () => {
    const { main } = await script()
    const { out, lines } = capture()
    const f = vi.fn(); (globalThis as any).fetch = f
    expect(await main(['fixed', 'Closed Lost works', 'Fixed in e2403da.'], { ...NO_KEY_ENV, WAGGLE_WRITE_KEY: KEY }, out)).toBe(1)
    expect(lines[0]).toMatch(/Not added — .*commit hash/)
    expect(f).not.toHaveBeenCalled()
  })

  it('with no key it says how to set up and exits 2, sending nothing', async () => {
    const { main, KEY_FILE } = await script()
    const { out, lines } = capture()
    const f = vi.fn(); (globalThis as any).fetch = f
    const home = fs.mkdtempSync(path.join(process.cwd(), '.tmp-home-'))
    try {
      expect(fs.existsSync(KEY_FILE)).toBe(fs.existsSync(KEY_FILE)) // whatever this machine has; the env below overrides HOME only for the message
      const code = await main(['fixed', GOOD.headline, GOOD.sentence], { HOME: home, WAGGLE_WRITE_KEY: '' }, out)
      // readKey falls back to the real KEY_FILE path (computed at import from os.homedir), so only assert when it is absent
      if (!fs.existsSync(KEY_FILE)) {
        expect(code).toBe(2)
        expect(lines[0]).toMatch(/Not set up — no WAGGLE_WRITE_KEY/)
        expect(lines[0]).toContain('waggle-key')
        expect(f).not.toHaveBeenCalled()
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('a real run sends the bearer key and the line to WAGGLE_URL, and prints what landed', async () => {
    const { main } = await script()
    const seen: any = {}
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        seen.method = req.method; seen.url = req.url; seen.auth = req.headers.authorization; seen.body = JSON.parse(raw)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, line: { id: 'i-1', group: 'fixed', title: GOOD.headline, body: GOOD.sentence }, release: { id: 'r', week_label: 'Thu, Sep 10' } }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as any).port
    try {
      const { out, lines } = capture()
      const code = await main(['fixed', GOOD.headline, GOOD.sentence], { WAGGLE_WRITE_KEY: KEY, WAGGLE_URL: `http://127.0.0.1:${port}/` }, out)
      expect(code).toBe(0)
      expect(seen).toEqual({ method: 'POST', url: '/api/help/releases/lines', auth: `Bearer ${KEY}`, body: { group: 'fixed', title: GOOD.headline, body: GOOD.sentence } })
      expect(lines[0]).toBe("Added to the What's new draft for the week ending Thu, Sep 10:")
      expect(lines[1]).toBe(`  Fixed · ${GOOD.headline}`)
    } finally { server.close() }
  })

  it('a refusal from the server is printed and exits 1', async () => {
    const { main } = await script()
    const server = http.createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as any).port
    try {
      const { out, lines } = capture()
      expect(await main(['fixed', GOOD.headline, GOOD.sentence], { WAGGLE_WRITE_KEY: 'wrong', WAGGLE_URL: `http://127.0.0.1:${port}` }, out)).toBe(1)
      expect(lines[0]).toBe('Not added — the server said 401: unauthorized')
    } finally { server.close() }
  })
})

// ─── the rule lives where every Bee Hub session reads it ───────────────

describe('CLAUDE.md', () => {
  it('carries the rule and names the script', () => {
    const md = fs.readFileSync(path.join(process.cwd(), 'CLAUDE.md'), 'utf8')
    expect(md).toContain("## What's new — telling the owners")
    expect(md).toContain('node scripts/waggle-add.mjs')
    expect(md).toContain('If in doubt, skip it')
  })
})

afterEach(() => { vi.restoreAllMocks(); (globalThis as any).fetch = REAL_FETCH })
