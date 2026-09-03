// @vitest-environment node
//
// WHAT'S NEW — THE SERVER CONTRACT.
//
//   · an owner's GET never contains the draft, a removed line, or a line
//     still in the owner's words — and never a feedback id
//   · an editor's GET carries the draft, flagged, with the original report
//     beside every seeded line
//   · an owner cannot reach ANY editing route (403; 401 signed out)
//   · publishing with unedited lines WORKS: they are left out and carried
//     to next week's draft, and the response says how many
//   · the Slack preview is byte-for-byte what publish would post
//   · posting publishes the release too, and the textarea text is what goes
//   · a Slack failure does not lose the published release, and says so
//   · removing a line writes only to help_release_items
//   · the pure helpers: the Friday→Thursday week, the group map, the
//     message builder, and the migration never altering another table
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  weekForYmd, weekFor, nextWeekAfter, formatWeekLabel, groupForType, buildWaggleMessage,
  slackEscape, normalizeReleaseItemInput, shapeRelease, isMissingReleasesTable, WAGGLE_VARIANTS,
} from '@/lib/help-releases'
import { postWaggleMessage, wagglePostProblem, WAGGLE_WEBHOOK_ENV } from '@/lib/slack-waggle'

// ── a recording Supabase double ───────────────────────────────────────
const h = vi.hoisted(() => {
  const state: any = {
    user: { id: 'u-owner' } as any,
    role: 'owner',
    respond: (_ctx: any) => ({ data: null, error: null }),
    calls: [] as any[],
  }
  const makeBuilder = (table: string) => {
    const ctx: any = { table, op: 'select', filters: {}, inFilters: {}, isNull: {}, payload: null, cols: null }
    const b: any = {}
    const chain = (fn: (...a: any[]) => void) => (...a: any[]) => { fn(...a); return b }
    b.select = chain((cols?: any) => { if (ctx.op === 'select') ctx.cols = cols })
    b.insert = chain((p: any) => { ctx.op = 'insert'; ctx.payload = p })
    b.update = chain((p: any) => { ctx.op = 'update'; ctx.payload = p })
    b.eq = chain((c: string, v: any) => { ctx.filters[c] = v })
    b.in = chain((c: string, v: any) => { ctx.inFilters[c] = v })
    b.is = chain((c: string, v: any) => { ctx.isNull[c] = v })
    b.order = chain(() => {})
    b.limit = chain(() => {})
    const resolve = () => { state.calls.push(ctx); return Promise.resolve(state.respond(ctx)) }
    b.single = resolve
    b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
    return b
  }
  return { state, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.user } }) },
    from: (t: string) => {
      const b = h.makeBuilder(t)
      if (t === 'hub_users') b.single = async () => ({ data: h.state.user ? { role: h.state.role } : null, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/help/releases/route'
import { PATCH as PATCH_RELEASE } from '@/app/api/help/releases/[id]/route'
import { GET as SLACK_PREVIEW } from '@/app/api/help/releases/[id]/slack/route'
import { POST as ADD_ITEM } from '@/app/api/help/releases/items/route'
import { PATCH as PATCH_ITEM, DELETE as DELETE_ITEM } from '@/app/api/help/releases/items/[id]/route'

const req = (method: string, body?: any, url = 'http://x/api/help/releases') =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) as any

const RELEASES = [
  { id: 'r-pub', week_start: '2026-08-21', publish_on: '2026-08-27', status: 'published', summary: 'A quieter week.', published_at: '2026-08-27T20:00:00Z', slack_text: 'posted words', slack_posted_at: '2026-08-27T20:00:01Z', slack_error: null },
  { id: 'r-draft', week_start: '2026-08-28', publish_on: '2026-09-03', status: 'draft', summary: null, published_at: null, slack_text: null, slack_posted_at: null, slack_error: null },
]
const ITEMS = [
  { id: 'i-pub-1', release_id: 'r-pub', group: 'fixed', title: 'The Inbox badge no longer counts hidden leads.', body: 'If the badge and the list disagree, the Inbox now says a filter is hiding something.', edited_at: '2026-08-27T10:00:00Z', feedback_item_id: 'fb-1', deleted_at: null, created_at: '2026-08-25T00:00:00Z' },
  { id: 'i-pub-un', release_id: 'r-pub', group: 'fixed', title: 'Prefill Issue', body: null, edited_at: null, feedback_item_id: 'fb-2', deleted_at: null, created_at: '2026-08-26T00:00:00Z' },
  { id: 'i-pub-del', release_id: 'r-pub', group: 'new', title: 'Removed line', body: 'gone', edited_at: '2026-08-27T10:00:00Z', feedback_item_id: null, deleted_at: '2026-08-27T11:00:00Z', created_at: '2026-08-26T00:00:00Z' },
  { id: 'i-d-1', release_id: 'r-draft', group: 'fixed', title: 'Archiving a quote in Jobber closes the deal as Closed Lost.', body: 'No more moving it by hand.', edited_at: '2026-09-01T10:00:00Z', feedback_item_id: 'fb-3', deleted_at: null, created_at: '2026-08-30T00:00:00Z' },
  { id: 'i-d-2', release_id: 'r-draft', group: 'fixed', title: 'Inbox has a circle 1', body: null, edited_at: null, feedback_item_id: 'fb-4', deleted_at: null, created_at: '2026-08-31T00:00:00Z' },
  { id: 'i-d-3', release_id: 'r-draft', group: 'new', title: 'Two addresses per client', body: null, edited_at: '2026-09-02T10:00:00Z', feedback_item_id: null, deleted_at: null, created_at: '2026-09-01T00:00:00Z' },
]
const FEEDBACK = [
  { id: 'fb-3', title: 'Jobber - Quote Archive = Job Lost', type: 'bug', description: 'When we Archive a quote in Jobber...', admin_response: 'Shipped — this now works.' },
  { id: 'fb-4', title: 'Inbox has a circle 1', type: 'bug', description: 'A circle one is appearing in my inbox but it is empty', admin_response: 'Fixed. That lonely "1" was a lead your filters were hiding.' },
]

const draftItems = () => ITEMS.filter(i => i.release_id === 'r-draft' && !i.deleted_at)

function defaultRespond(ctx: any) {
  if (ctx.table === 'help_releases' && ctx.op === 'select') {
    if (ctx.filters.id) return { data: RELEASES.find(r => r.id === ctx.filters.id) || null, error: null }
    if (ctx.filters.status === 'draft') return { data: RELEASES.find(r => r.status === 'draft') || null, error: null }
    return { data: RELEASES, error: null }
  }
  if (ctx.table === 'help_releases' && ctx.op === 'update') {
    return { data: { ...RELEASES.find(r => r.id === ctx.filters.id), ...ctx.payload }, error: null }
  }
  if (ctx.table === 'help_releases' && ctx.op === 'insert') return { data: { id: 'r-next', ...ctx.payload }, error: null }
  if (ctx.table === 'help_release_items' && ctx.op === 'select') {
    if (ctx.filters.id) return { data: ITEMS.find(i => i.id === ctx.filters.id) || null, error: null }
    if (ctx.filters.release_id) return { data: ITEMS.filter(i => i.release_id === ctx.filters.release_id && (!('deleted_at' in ctx.isNull) || !i.deleted_at)), error: null }
    return { data: ITEMS, error: null }
  }
  if (ctx.table === 'help_release_items' && ctx.op === 'update') {
    const row = ITEMS.find(i => i.id === ctx.filters.id)
    return { data: row ? { ...row, ...ctx.payload } : null, error: null }
  }
  if (ctx.table === 'help_release_items' && ctx.op === 'insert') return { data: { id: 'i-new', ...ctx.payload }, error: null }
  if (ctx.table === 'feedback_items' && ctx.op === 'select') return { data: FEEDBACK.filter(f => (ctx.inFilters.id || []).includes(f.id)), error: null }
  return { data: null, error: null }
}

const slackFetch = vi.fn()
beforeEach(() => {
  h.state.user = { id: 'u-owner' }
  h.state.role = 'owner'
  h.state.calls = []
  h.state.respond = defaultRespond
  process.env[WAGGLE_WEBHOOK_ENV] = 'https://hooks.slack.com/services/T/B/waggle'
  slackFetch.mockReset()
  slackFetch.mockImplementation(async () => ({ ok: true, status: 200, text: async () => 'ok' }))
  ;(globalThis as any).fetch = slackFetch
})

const writes = (table: string) => h.state.calls.filter((c: any) => c.table === table && c.op !== 'select')

// ─── the week ──────────────────────────────────────────────────────────

describe('the week runs Friday to Thursday and the note goes out on the Thursday', () => {
  it('a Thursday closes its own week; a Friday opens the next', () => {
    expect(weekForYmd('2026-09-03')).toEqual({ week_start: '2026-08-28', publish_on: '2026-09-03' }) // Thu
    expect(weekForYmd('2026-09-04')).toEqual({ week_start: '2026-09-04', publish_on: '2026-09-10' }) // Fri
    expect(weekForYmd('2026-09-06')).toEqual({ week_start: '2026-09-04', publish_on: '2026-09-10' }) // Sun
    expect(weekForYmd('2026-09-09')).toEqual({ week_start: '2026-09-04', publish_on: '2026-09-10' }) // Wed
  })
  it('is computed in Eastern time — 11pm Thursday in New York is still Thursday', () => {
    // 2026-09-04T03:30Z is Thu 2026-09-03 23:30 in New York.
    expect(weekFor(new Date('2026-09-04T03:30:00Z'))).toEqual({ week_start: '2026-08-28', publish_on: '2026-09-03' })
  })
  it('the next draft after a publish is the following week, unless that week is already behind us', () => {
    expect(nextWeekAfter('2026-09-03', new Date('2026-09-03T18:00:00Z'))).toEqual({ week_start: '2026-09-04', publish_on: '2026-09-10' })
    // published two weeks late: the next draft is THIS week, not a stale one
    expect(nextWeekAfter('2026-09-03', new Date('2026-09-19T18:00:00Z'))).toEqual({ week_start: '2026-09-18', publish_on: '2026-09-24' })
  })
  it('labels the week by its Thursday', () => {
    expect(formatWeekLabel('2026-09-03')).toBe('Thu, Sep 3')
    expect(formatWeekLabel('bad')).toBe('')
  })
})

describe('the group map and the input rules', () => {
  it('bug → Fixed, feature → New, anything else → Changed', () => {
    expect(groupForType('bug')).toBe('fixed')
    expect(groupForType('feature')).toBe('new')
    expect(groupForType('question')).toBe('changed')
    expect(groupForType(null)).toBe('changed')
  })
  it('a line needs a group and a headline; the sentence is optional', () => {
    expect(normalizeReleaseItemInput({ group: 'fixed', title: '  Hello ', body: '' })).toEqual({ input: { group: 'fixed', title: 'Hello', body: null }, problem: null })
    expect(normalizeReleaseItemInput({ group: 'nope', title: 'x' }).problem).toMatch(/New, Changed or Fixed/)
    expect(normalizeReleaseItemInput({ group: 'new', title: '  ' }).problem).toMatch(/headline/i)
  })
})

// ─── the message ───────────────────────────────────────────────────────

describe('the Slack post is assembled from the edited lines — nothing else', () => {
  const release = { publish_on: '2026-09-03', summary: null }
  it('heads with The Waggle and the week, groups the lines, leaves out the unedited and the sentence-less', () => {
    const built = buildWaggleMessage(release, draftItems())
    expect(built.text.split('\n')[0]).toBe('🐝 *The Waggle* · week ending Thu, Sep 3')
    expect(built.text).toContain('✅ *Fixed*')
    expect(built.text).toContain('• *Archiving a quote in Jobber closes the deal as Closed Lost.* — No more moving it by hand.')
    expect(built.included).toBe(1)
    expect(built.text).not.toContain('Inbox has a circle 1')
    expect(built.text).not.toContain('Two addresses per client')
    expect(built.leftOut).toEqual([
      { id: 'i-d-2', title: 'Inbox has a circle 1', reason: 'their_words' },
      { id: 'i-d-3', title: 'Two addresses per client', reason: 'no_sentence' },
    ])
    // no ✨ New heading when nothing is in it
    expect(built.text).not.toContain('*New*')
  })
  it('uses the summary as the lede when there is one, a stock opener when there is not', () => {
    expect(buildWaggleMessage({ ...release, summary: 'Two fixes and a faster Inbox.' }, draftItems()).text.split('\n')[1]).toBe('Two fixes and a faster Inbox.')
    expect(buildWaggleMessage(release, draftItems()).text.split('\n')[1]).toBe('Here is what changed in Bee Hub this week.')
  })
  it('"different version" cycles the opener and closer and changes no fact', () => {
    const a = buildWaggleMessage(release, draftItems(), { variant: 0 })
    const b = buildWaggleMessage(release, draftItems(), { variant: 1 })
    const wrap = buildWaggleMessage(release, draftItems(), { variant: WAGGLE_VARIANTS })
    expect(a.text).not.toBe(b.text)
    expect(wrap.text).toBe(a.text)
    const facts = (t: string) => t.split('\n').filter(l => l.startsWith('•'))
    expect(facts(a.text)).toEqual(facts(b.text))
  })
  it('escapes the three characters Slack treats as markup', () => {
    expect(slackEscape('a & b <c>')).toBe('a &amp; b &lt;c&gt;')
    const built = buildWaggleMessage(release, [{ id: 'x', group: 'new', title: 'Quotes & jobs', body: 'x < y', edited_at: 't', deleted_at: null }])
    expect(built.text).toContain('*Quotes &amp; jobs* — x &lt; y')
  })
})

describe('the Waggle webhook', () => {
  it('posts { text } to the waggle URL and nothing else', async () => {
    const r = await postWaggleMessage('hello')
    expect(r).toEqual({ ok: true })
    expect(slackFetch).toHaveBeenCalledTimes(1)
    expect(slackFetch.mock.calls[0][0]).toBe('https://hooks.slack.com/services/T/B/waggle')
    expect(JSON.parse(slackFetch.mock.calls[0][1].body)).toEqual({ text: 'hello' })
  })
  it('with no URL it skips in words, never throws', async () => {
    delete process.env[WAGGLE_WEBHOOK_ENV]
    const r = await postWaggleMessage('hello')
    expect(r).toEqual({ ok: false, skipped: 'no_webhook_url' })
    expect(wagglePostProblem(r)).toContain(WAGGLE_WEBHOOK_ENV)
    expect(slackFetch).not.toHaveBeenCalled()
  })
  it('does not share the ops webhook variable', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/slack-waggle.ts'), 'utf8')
    expect(src).not.toMatch(/process\.env\.SLACK_WEBHOOK_URL/)
    expect(WAGGLE_WEBHOOK_ENV).not.toBe('SLACK_WEBHOOK_URL')
  })
})

// ─── who sees what ─────────────────────────────────────────────────────

describe('GET /api/help/releases', () => {
  it('an owner gets published weeks only — no draft, no removed line, no line in the owner’s words, no feedback ids', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.canEdit).toBe(false)
    expect(body.draft).toBeNull()
    expect(body.releases.map((r: any) => r.id)).toEqual(['r-pub'])
    const rel = body.releases[0]
    expect(rel.groups.fixed.map((i: any) => i.title)).toEqual(['The Inbox badge no longer counts hidden leads.'])
    expect(rel.groups.new).toEqual([])
    expect(rel.week_label).toBe('Thu, Aug 27')
    const text = JSON.stringify(body)
    expect(text).not.toContain('Prefill Issue')
    expect(text).not.toContain('Removed line')
    expect(text).not.toContain('r-draft')
    expect(text).not.toContain('fb-')
    expect(text).not.toContain('posted words')
    expect(text).not.toContain('slack_error')
    // no read of feedback_items on the owner path
    expect(h.state.calls.some((c: any) => c.table === 'feedback_items')).toBe(false)
  })

  it('an editor gets the draft too, lines flagged, with the original report beside each seeded line', async () => {
    h.state.role = 'admin'
    const body = await (await GET()).json()
    expect(body.canEdit).toBe(true)
    expect(body.draft.id).toBe('r-draft')
    expect(body.draft.unedited_count).toBe(1)
    expect(body.draft.week_label).toBe('Thu, Sep 3')
    const lines = [...body.draft.groups.fixed, ...body.draft.groups.new]
    const un = lines.find((i: any) => i.id === 'i-d-2')
    expect(un.unedited).toBe(true)
    expect(un.source).toEqual({ title: 'Inbox has a circle 1', type: 'bug', description: 'A circle one is appearing in my inbox but it is empty', admin_response: 'Fixed. That lonely "1" was a lead your filters were hiding.' })
    expect(lines.find((i: any) => i.id === 'i-d-3').source).toBeNull()
    // the published week shows the editor its unedited line too (flagged), never the removed one
    const pub = body.releases[0]
    expect(pub.groups.fixed.map((i: any) => i.id)).toEqual(['i-pub-1', 'i-pub-un'])
    expect(JSON.stringify(body)).not.toContain('Removed line')
    // the feedback read is a plain select by id — never a write
    const fb = h.state.calls.filter((c: any) => c.table === 'feedback_items')
    expect(fb.map((c: any) => c.op)).toEqual(['select'])
    expect(fb[0].inFilters.id.sort()).toEqual(['fb-3', 'fb-4'])
  })

  it('a missing table reads as empty, never a 500', async () => {
    h.state.respond = (ctx: any) => ctx.table === 'help_releases' ? { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.help_releases' in the schema cache" } } : defaultRespond(ctx)
    const body = await (await GET()).json()
    expect(body).toEqual({ releases: [], draft: null, canEdit: false, notSetUp: true })
    expect(isMissingReleasesTable({ code: '42P01' })).toBe(true)
    expect(isMissingReleasesTable({ message: 'relation "help_release_items" does not exist' })).toBe(true)
    expect(isMissingReleasesTable({ message: 'duplicate key' })).toBe(false)
  })

  it('signed out is 401', async () => {
    h.state.user = null
    expect((await GET()).status).toBe(401)
  })
})

describe('an owner cannot reach any editing route — and nothing is written', () => {
  const attempts: Array<[string, () => Promise<Response>]> = [
    ['add a line', () => ADD_ITEM(req('POST', { group: 'new', title: 'x' }))],
    ['edit a line', () => PATCH_ITEM(req('PATCH', { title: 'x' }), { params: { id: 'i-d-1' } })],
    ['remove a line', () => DELETE_ITEM(req('DELETE'), { params: { id: 'i-d-1' } })],
    ['edit the summary', () => PATCH_RELEASE(req('PATCH', { summary: 'x' }), { params: { id: 'r-draft' } })],
    ['publish', () => PATCH_RELEASE(req('PATCH', { publish: true }), { params: { id: 'r-draft' } })],
    ['preview the post', () => SLACK_PREVIEW(req('GET', undefined, 'http://x/api/help/releases/r-draft/slack'), { params: { id: 'r-draft' } })],
  ]
  for (const role of ['owner', 'manager', 'lite_user']) {
    for (const [what, go] of attempts) {
      it(`${role} cannot ${what}`, async () => {
        h.state.role = role
        const res = await go()
        expect(res.status).toBe(403)
        expect(h.state.calls.filter((c: any) => c.op !== 'select')).toEqual([])
        expect(slackFetch).not.toHaveBeenCalled()
      })
    }
  }
  it('signed out is 401 everywhere', async () => {
    h.state.user = null
    for (const [, go] of attempts) expect((await go()).status).toBe(401)
  })
})

// ─── editing ───────────────────────────────────────────────────────────

describe('editing lines', () => {
  beforeEach(() => { h.state.role = 'super_admin'; h.state.user = { id: 'u-kevin' } })

  it('a hand-added line lands in the open draft in Kevin’s words (edited_at set)', async () => {
    const res = await ADD_ITEM(req('POST', { group: 'changed', title: 'Timezone is a dropdown', body: 'Arizona is its own entry.' }))
    expect(res.status).toBe(201)
    const ins = writes('help_release_items')
    expect(ins).toHaveLength(1)
    expect(ins[0].payload).toMatchObject({ release_id: 'r-draft', group: 'changed', title: 'Timezone is a dropdown', body: 'Arizona is its own entry.', created_by: 'u-kevin' })
    expect(ins[0].payload.edited_at).toBeTruthy()
    expect(writes('help_releases')).toEqual([]) // the draft already existed
  })

  it('with no draft open, adding a line opens this week’s draft first', async () => {
    h.state.respond = (ctx: any) => (ctx.table === 'help_releases' && ctx.op === 'select' && ctx.filters.status === 'draft') ? { data: null, error: null } : defaultRespond(ctx)
    const res = await ADD_ITEM(req('POST', { group: 'new', title: 'x' }))
    expect(res.status).toBe(201)
    const rel = writes('help_releases')
    expect(rel).toHaveLength(1)
    expect(rel[0].op).toBe('insert')
    expect(rel[0].payload.status).toBe('draft')
    expect(rel[0].payload.publish_on).toBe(new Date(`${rel[0].payload.week_start}T00:00:00Z`).getTime() + 6 * 86400000 > 0 ? rel[0].payload.publish_on : '')
    expect(new Date(rel[0].payload.publish_on).getUTCDay()).toBe(4) // a Thursday
    expect(writes('help_release_items')[0].payload.release_id).toBe('r-next')
  })

  it('editing a seeded line stamps edited_at and writes ONLY to help_release_items', async () => {
    const res = await PATCH_ITEM(req('PATCH', { group: 'fixed', title: 'The Inbox badge no longer counts hidden leads.', body: 'Now it says a filter is hiding one.' }), { params: { id: 'i-d-2' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.unedited).toBe(false)
    const w = h.state.calls.filter((c: any) => c.op !== 'select')
    expect(w.map((c: any) => c.table)).toEqual(['help_release_items'])
    expect(w[0].payload.edited_at).toBeTruthy()
    expect(w[0].payload.title).toBe('The Inbox badge no longer counts hidden leads.')
  })

  it('removing a line is a soft delete on help_release_items and nothing on feedback_items', async () => {
    const res = await DELETE_ITEM(req('DELETE'), { params: { id: 'i-d-2' } })
    expect(res.status).toBe(200)
    const w = h.state.calls.filter((c: any) => c.op !== 'select')
    expect(w).toHaveLength(1)
    expect(w[0].table).toBe('help_release_items')
    expect(w[0].op).toBe('update')
    expect(w[0].payload.deleted_at).toBeTruthy()
    expect(w[0].isNull.deleted_at).toBeNull()
    expect(h.state.calls.some((c: any) => c.table === 'feedback_items')).toBe(false)
  })

  it('the summary is its own small save', async () => {
    const res = await PATCH_RELEASE(req('PATCH', { summary: '  Two fixes.  ' }), { params: { id: 'r-draft' } })
    expect(res.status).toBe(200)
    const w = writes('help_releases')
    expect(w).toHaveLength(1)
    expect(w[0].payload.summary).toBe('Two fixes.')
    expect(w[0].payload.status).toBeUndefined()
  })
})

// ─── publish + post ────────────────────────────────────────────────────

describe('publishing', () => {
  beforeEach(() => { h.state.role = 'admin'; h.state.user = { id: 'u-kevin' } })

  it('with lines still in the owner’s words: publishes, leaves them out, carries them to next week, and says so', async () => {
    const res = await PATCH_RELEASE(req('PATCH', { publish: true, post_slack: false }), { params: { id: 'r-draft' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.release.status).toBe('published')
    expect(body.published_count).toBe(2)
    expect(body.left_out).toBe(1)
    expect(body.carried_to).toEqual(expect.objectContaining({ week_start: expect.any(String), publish_on: expect.any(String) }))
    expect(body.slack).toEqual({ posted: false, problem: null, skipped: true })
    // the writes, in order: publish, open next draft, move the unedited line
    const w = h.state.calls.filter((c: any) => c.op !== 'select')
    expect(w.map((c: any) => `${c.table}:${c.op}`)).toEqual(['help_releases:update', 'help_releases:insert', 'help_release_items:update'])
    expect(w[0].payload).toMatchObject({ status: 'published', slack_text: null })
    expect(w[0].payload.published_at).toBeTruthy()
    expect(w[1].payload.status).toBe('draft')
    expect(w[2].payload.release_id).toBe('r-next')
    expect(w[2].inFilters.id).toEqual(['i-d-2'])
    expect(slackFetch).not.toHaveBeenCalled()
  })

  it('the preview is byte-for-byte what publish posts when the textarea is left alone', async () => {
    const pv = await (await SLACK_PREVIEW(req('GET', undefined, 'http://x/api/help/releases/r-draft/slack?variant=1'), { params: { id: 'r-draft' } })).json()
    expect(pv.variant).toBe(1)
    expect(pv.channel).toEqual({ id: 'C0BTS6KGLNP', name: '#tech-updates-info' })
    expect(pv.left_out.map((l: any) => l.id)).toEqual(['i-d-2', 'i-d-3'])
    h.state.calls = []
    const res = await PATCH_RELEASE(req('PATCH', { publish: true, post_slack: true, variant: 1 }), { params: { id: 'r-draft' } })
    const body = await res.json()
    expect(slackFetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(slackFetch.mock.calls[0][1].body)).toEqual({ text: pv.text })
    expect(body.slack_text).toBe(pv.text)
    expect(body.slack).toEqual({ posted: true, problem: null, skipped: false })
  })

  it('posting publishes the release too, and the edited textarea is exactly what goes', async () => {
    const mine = '🐝 *The Waggle* · week ending Thu, Sep 3\nKevin rewrote this by hand.\n\n✅ *Fixed*\n• *One thing* — one sentence.'
    const res = await PATCH_RELEASE(req('PATCH', { publish: true, post_slack: true, slack_text: mine }), { params: { id: 'r-draft' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.release.status).toBe('published')
    expect(JSON.parse(slackFetch.mock.calls[0][1].body)).toEqual({ text: mine })
    const w = h.state.calls.filter((c: any) => c.op !== 'select')
    expect(w[0].payload).toMatchObject({ status: 'published', slack_text: mine })
    const last = w[w.length - 1]
    expect(last.table).toBe('help_releases')
    expect(last.payload.slack_posted_at).toBeTruthy()
    expect(last.payload.slack_error).toBeNull()
  })

  it('a Slack failure does not lose the published release, and says so', async () => {
    slackFetch.mockImplementation(async () => ({ ok: false, status: 500, text: async () => 'boom' }))
    const res = await PATCH_RELEASE(req('PATCH', { publish: true, post_slack: true, slack_text: 'words' }), { params: { id: 'r-draft' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.release.status).toBe('published')
    expect(body.slack.posted).toBe(false)
    expect(body.slack.problem).toMatch(/Slack didn’t accept the post \(slack_http_500\)/)
    const w = h.state.calls.filter((c: any) => c.op !== 'select')
    expect(w[0].payload.status).toBe('published') // published BEFORE the post was attempted
    expect(w[w.length - 1].payload).toEqual({ slack_error: body.slack.problem })
  })

  it('with no webhook configured: published, and the problem names the missing setting', async () => {
    delete process.env[WAGGLE_WEBHOOK_ENV]
    const body = await (await PATCH_RELEASE(req('PATCH', { publish: true, post_slack: true, slack_text: 'words' }), { params: { id: 'r-draft' } })).json()
    expect(body.release.status).toBe('published')
    expect(body.slack.posted).toBe(false)
    expect(body.slack.problem).toContain('SLACK_WAGGLE_WEBHOOK_URL')
    expect(slackFetch).not.toHaveBeenCalled()
  })

  it('an already-published week cannot be published again', async () => {
    const res = await PATCH_RELEASE(req('PATCH', { publish: true }), { params: { id: 'r-pub' } })
    expect(res.status).toBe(409)
    expect(slackFetch).not.toHaveBeenCalled()
  })
})

// ─── shaping + the migration ───────────────────────────────────────────

describe('shapeRelease', () => {
  it('for an owner drops unedited and deleted lines and every editor-only field', () => {
    const s = shapeRelease(RELEASES[0] as any, ITEMS as any, { forOwner: true })
    expect(s.groups.fixed.map(i => i.id)).toEqual(['i-pub-1'])
    expect(s.unedited_count).toBe(0)
    expect('slack_text' in s).toBe(false)
    expect((s.groups.fixed[0] as any).feedback_item_id).toBeUndefined()
  })
})

describe('the migration', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'migrations/help_releases.sql'), 'utf8')
  it('creates the two tables, one open draft at a time, and one line per feedback entry ever', () => {
    expect(sql).toMatch(/create table if not exists public\.help_releases/)
    expect(sql).toMatch(/create table if not exists public\.help_release_items/)
    expect(sql).toMatch(/help_releases_one_draft_idx[\s\S]*where status = 'draft'/)
    expect(sql).toMatch(/help_release_items_feedback_idx[\s\S]*\(feedback_item_id\) where feedback_item_id is not null/)
    expect(sql).toMatch(/publish_on = week_start \+ 6/)
  })
  it('never alters feedback_items, feedback_replies or help_entries — the only mention is a foreign key', () => {
    expect(sql).not.toMatch(/alter table[^;]*feedback_items/i)
    expect(sql).not.toMatch(/alter table[^;]*feedback_replies/i)
    expect(sql).not.toMatch(/alter table[^;]*help_entries/i)
    expect(sql).not.toMatch(/(update|insert into|delete from)\s+(public\.)?feedback_items/i)
    expect(sql).not.toMatch(/(update|insert into|delete from)\s+(public\.)?help_entries/i)
    expect(sql).toMatch(/references public\.feedback_items\(id\) on delete set null/)
  })
  it('the new code never writes to feedback_items', () => {
    const files = [
      'lib/help-releases.ts', 'lib/slack-waggle.ts',
      'app/api/help/releases/route.ts', 'app/api/help/releases/[id]/route.ts', 'app/api/help/releases/[id]/slack/route.ts',
      'app/api/help/releases/items/route.ts', 'app/api/help/releases/items/[id]/route.ts',
      'components/help/WhatsNew.jsx', 'components/help/ReleaseItemForm.jsx', 'components/help/WagglePreview.jsx',
    ]
    for (const f of files) {
      const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8')
      expect(src, f).not.toMatch(/from\('feedback_items'\)[\s\S]{0,200}\.(update|insert|delete|upsert)\(/)
      expect(src, f).not.toMatch(/from\('feedback_replies'\)/)
    }
  })
})
