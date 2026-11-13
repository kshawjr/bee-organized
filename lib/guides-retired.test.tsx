// @vitest-environment happy-dom
//
// ASK BEE HUB AND THE GUIDES ARE RETIRED (2026-11-13, Kevin).
//
// The Quick Start Guide and the Manual were out of date and are being
// replaced with help videos; Ask Bee Hub is covered by Help. This pins the
// end state, piece by piece:
//
//   1 · Admin › Content no longer offers the Guide or the Manual editor. It
//       offers the three editors that were always beside them, and a browser
//       that remembered "guide" or "manual" opens the first of those.
//   2 · POST /api/help-chat answers "closed" for everyone and reads nothing.
//   3 · The chat panel, its prompt and the guide viewer/editor file are
//       deleted, and nothing imports them.
//   4 · The screen map lists none of the retired screens, so the feedback
//       sorter cannot file a report onto a screen that is not there.
//   5 · NOTHING IS DELETED FROM THE DATABASE. The slide tables keep their
//       rows: no migration names either table that did not before, no code
//       writes to either, and the two slide routes — whose save
//       wiped its table and wrote a new set — are CLOSED too: they answer
//       "closed" and read nothing.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

// Every way the old route reached out. If the closed route touched any of
// them, these would record it.
const touched = vi.hoisted(() => ({ supabase: 0 }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => { touched.supabase++; return {} },
  createServiceClient: () => { touched.supabase++; return {} },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/admin',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

import App from '@/components/BeeHub'
import { POST as helpChatPOST } from '@/app/api/help-chat/route'
import { GET as guideGET, POST as guidePOST } from '@/app/api/guide-slides/route'
import { GET as manualGET, POST as manualPOST } from '@/app/api/manual-slides/route'
import { buildPlacementIndex, placeFeedbackItem } from '@/lib/feedback-placement'
import screenMap from '@/docs/screen-map.json'

const root0 = process.cwd()
const read = (f: string) => readFileSync(join(root0, f), 'utf8')
const atHead = (f: string) => execSync(`git show 722aaa0:${f}`, { cwd: root0, maxBuffer: 64 * 1024 * 1024 }).toString()
const HUB = read('components/BeeHub.jsx')
const ENTRIES = (screenMap as any).entries as any[]

// ═══════════════════════════════════════════════════════════════════════════
// 1 · ADMIN › CONTENT
// ═══════════════════════════════════════════════════════════════════════════
const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
const SLIDES = [{ chapter: 'Basics', icon: '🐝', title: 'Welcome to the Hive', color: '#1a2e2b', body: 'Hello.', bullets: [] }]
const baseProps = (over: any = {}) => ({
  initialRoute: 'admin',
  initialRole: 'super_admin', initialFranchiseRole: 'owner',
  initialLocations: [{ id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' }],
  initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
  initialPeople: [], initialBinPeople: [], initialTransferPeople: [],
  initialEngagements: [], initialPartners: [], initialCompanies: [],
  // The page still hands the slides over; the app must show them nowhere.
  initialGuideSlides: SLIDES, initialManualSlides: SLIDES, initialTierPrices: [],
  currentUser: { id: 's', email: 's@x.com', name: 'Sam Super', role: 'super_admin', locationId: null },
  currentLocation: null, currentSubscription: null,
  initialLocFilter: 'all', initialScopeLocationId: null,
  ...over,
})
const CORPORATE = { initialRole: 'corporate', currentUser: { id: 'c', email: 'c@x.com', name: 'Cora Corp', role: 'admin', locationId: null } }

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let errSpy: any
let fetchMock: ReturnType<typeof vi.fn>
const store = (() => { let m: Record<string, string> = {}; return { getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = String(v) }, removeItem: (k: string) => { delete m[k] }, clear: () => { m = {} } } })()
Object.defineProperty(window, 'localStorage', { configurable: true, value: store })
beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState({}, '', '/admin')
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  ;(globalThis as any).fetch = fetchMock
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  touched.supabase = 0
})
afterEach(() => {
  try { act(() => root?.unmount()) } catch {}
  host?.remove()
  errSpy.mockRestore()
})
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(over: any = {}) {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(React.createElement(App as any, baseProps(over))) })
  await settle()
}
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const byText = (text: string, sel = 'button, a, [role="tab"], [role="button"], div, span, li') =>
  Array.from(host.querySelectorAll(sel)).filter(e => (e.textContent || '').trim() === text).pop() as HTMLElement | undefined
async function openContent() {
  const tab = byText('Content')
  if (!tab) throw new Error('no Content entry in Admin; saw: ' + (host.textContent || '').slice(0, 400))
  await click(tab)
  return host.querySelector('[data-content-editor]') as HTMLElement
}
const options = (ed: HTMLElement) => Array.from(ed.querySelectorAll('select option')).map(o => [(o as HTMLOptionElement).value, o.textContent])
const picked = (ed: HTMLElement) => (ed.querySelector('select') as HTMLSelectElement).value

describe('Admin › Content no longer edits the Guide or the Manual', () => {
  for (const [label, props] of [['super admin', {}], ['corporate', CORPORATE]] as const) {
    it(`${label}: the Edit picker offers exactly the three editors that are left, and opens on the first`, async () => {
      await mount(props)
      const ed = await openContent()
      expect(ed, 'the Content screen').toBeTruthy()
      expect(options(ed)).toEqual([
        ['drips', '📨 New Lead Drips (Master)'],
        ['templates', '📧 Email Templates (Master)'],
        ['variables', '🧩 Variable Reference'],
      ])
      expect(picked(ed)).toBe('drips')
      expect(ed.textContent).not.toMatch(/Quick Start Guide|Manual\b|Add slide|slides?\b/i)
      // the slides the page handed over are shown nowhere
      expect(host.textContent).not.toContain('Welcome to the Hive')
    })

    for (const stale of ['guide', 'manual', 'something-else']) {
      it(`${label}: a browser that remembered "${stale}" opens the first editor, not an empty page`, async () => {
        window.localStorage.setItem('bee_content_editor_active', stale)
        await mount(props)
        const ed = await openContent()
        expect(picked(ed)).toBe('drips')
        expect(window.localStorage.getItem('bee_content_editor_active')).toBe('drips')
        expect(ed.children.length).toBeGreaterThan(1)          // the picker row AND an editor under it
      })
    }

    it(`${label}: a remembered editor that still exists is still honoured`, async () => {
      window.localStorage.setItem('bee_content_editor_active', 'variables')
      await mount(props)
      expect(picked(await openContent())).toBe('variables')
    })

    it(`${label}: opening Content never calls the slide routes`, async () => {
      await mount(props)
      await openContent()
      const urls = fetchMock.mock.calls.map(c => String(c[0]))
      expect(urls.filter(u => /guide-slides|manual-slides|help-chat/.test(u))).toEqual([])
    })
  }

  it('the page heading no longer promises guide and manual slides', () => {
    expect(HUB).not.toContain('Edit onboarding guide and manual slides')
    expect(HUB).toContain('Edit master drips and email templates')
  })

  it('the shell holds no guide or manual code at all: no viewer, no editor, no save call', () => {
    for (const gone of ['GuideEditor', 'ManualEditor', 'SlideEditFormManual', 'ManualModal', 'HowToGuideModal', 'guideSlides', 'manualSlides', 'guidePersist', 'manualPersist', '/api/guide-slides', '/api/manual-slides', 'toEmbedUrl(', 'CHAPTER_COLORS', '📖 Quick Start Guide', '📚 Manual']) expect(HUB, gone).not.toContain(gone)
  })

  it('the three editors that are left are the code they were at 722aaa0', () => {
    const span = (src: string, name: string) => { const i = src.indexOf(`function ${name}(`); const j = src.indexOf('\nfunction ', i + 10); expect(i, name).toBeGreaterThan(0); return src.slice(i, j) }
    const before = atHead('components/BeeHub.jsx')
    for (const name of ['MasterTemplatesEditor', 'MasterDripPathsEditor', 'VariableReference']) expect(span(HUB, name), name).toBe(span(before, name))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · POST /api/help-chat IS CLOSED
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/help-chat answers "closed" and reads nothing', () => {
  const ask = () => new Request('http://localhost/api/help-chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: 'sb-access-token=anything' },
    body: JSON.stringify({ screen: { name: 'Clients', detail: 'Jane Doe owes $400' }, messages: [{ role: 'user', content: 'How do I add a client?' }] }),
  })

  it('410, with the reason, the same for every caller', async () => {
    const answers: string[] = []
    for (const req of [ask(), new Request('http://localhost/api/help-chat', { method: 'POST' }), undefined]) {
      const res = await (helpChatPOST as any)(req)
      expect(res.status).toBe(410)
      const j = await res.json()
      expect(j).toEqual({ error: 'help_chat_closed', message: 'Ask Bee Hub is closed. Help has how-tos, and you can ask the team a question there.' })
      answers.push(JSON.stringify(j))
    }
    expect(new Set(answers).size).toBe(1)
  })

  it('it reads nothing: not the request, not the session, not the database, not Anthropic', async () => {
    const req = ask()
    const before = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-must-not-be-used'
    const res = await (helpChatPOST as any)(req)
    process.env.ANTHROPIC_API_KEY = before
    expect(res.status).toBe(410)
    expect(req.bodyUsed).toBe(false)               // the question and the screen readout were never read
    expect(touched.supabase).toBe(0)               // no session lookup, no table
    expect(fetchMock).not.toHaveBeenCalled()       // nothing sent anywhere
    expect((await res.text()).length).toBeLessThan(200)
  })

  it('the file is nothing but the refusal', () => {
    const src = read('app/api/help-chat/route.ts')
    const code = src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    expect(code).not.toMatch(/supabase|anthropic|fetch\(|process\.env|req\b|request\b|await /i)
    expect(code.match(/^import /gm)!.length).toBe(1)
    expect(code).toContain("import { NextResponse } from 'next/server'")
    expect(code).toContain('export async function POST() {')
    expect(code).toContain('{ status: 410 }')
    expect(code.match(/export /g)!.length).toBe(1)           // POST only: every other method is refused by the framework
  })

  it('nothing in the app calls it', () => {
    const walk = (dir: string): string[] => readdirSync(join(root0, dir), { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (['node_modules', '.next', '.git'].includes(e.name) ? [] : walk(join(dir, e.name))) : /\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : [])
    const callers = ['app', 'components', 'lib'].flatMap(walk).filter(f => f !== 'app/api/help-chat/route.ts' && /help-chat/.test(read(f).split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')))
    expect(callers).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE FILES ARE DELETED
// ═══════════════════════════════════════════════════════════════════════════
describe('the chat panel, its prompt and the guide file are deleted', () => {
  const GONE = ['components/hive/AskBeeHubPanel.jsx', 'lib/help-chat-prompt.ts', 'components/guide/HowToGuideModal.jsx']
  it('none of the three is on disk', () => {
    for (const f of GONE) expect(existsSync(join(root0, f)), f).toBe(false)
  })

  it('nothing that ships imports them or names what they exported', () => {
    const walk = (dir: string): string[] => readdirSync(join(root0, dir), { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (['node_modules', '.next', '.git'].includes(e.name) ? [] : walk(join(dir, e.name))) : /\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : [])
    const hits: string[] = []
    for (const f of ['app', 'components', 'lib'].flatMap(walk)) {
      const code = read(f).split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')
      if (/AskBeeHubPanel|help-chat-prompt|HowToGuideModal|buildSystem\(/.test(code)) hits.push(f)
    }
    expect(hits).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · THE SCREEN MAP, AND WHAT THE FEEDBACK SORTER DOES WITH IT
// ═══════════════════════════════════════════════════════════════════════════
describe('the screen map lists none of the retired screens', () => {
  it('the three entries are gone and nothing else was dropped', () => {
    const ids = ENTRIES.map(e => e.id)
    for (const gone of ['shell.ask-bee-hub', 'shell.guide', 'shell.manual']) expect(ids, gone).not.toContain(gone)
    const before = (JSON.parse(atHead('docs/screen-map.json')).entries as any[]).map(e => e.id)
    expect(before.filter(id => !ids.includes(id))).toEqual(['shell.ask-bee-hub', 'shell.guide', 'shell.manual'])
    expect(ids.filter(id => !before.includes(id))).toEqual([])
  })

  it('no entry points at a deleted file, a retired screen, the chat route or a slide route', () => {
    for (const e of ENTRIES) {
      expect(existsSync(join(root0, e.file)), `${e.id} → ${e.file}`).toBe(true)
      expect(JSON.stringify([e.surface, e.symbol, e.routes]), e.id).not.toMatch(/Ask Bee Hub|AskBeeHubPanel|HowToGuide|ManualModal|help-chat|guide-slides|manual-slides/)
      expect(JSON.stringify(e.tables || []), e.id).not.toMatch(/guide_slides|manual_slides/)
    }
  })

  it('Admin › Content is described as what it is now', () => {
    const e = ENTRIES.find(x => x.id === 'admin.content')
    expect(e.symbol).toBe('ContentEditor')
    expect(e.surface).not.toMatch(/Guide|Manual|slide/i)
    expect(e.surface).toMatch(/master drips/)
    expect(e.says.join(' ')).not.toMatch(/guide|manual/i)
    expect(e.says.length).toBeGreaterThan(0)
  })

  // The sorter matches an owner's WORDS against the map; it never checks that
  // the screen still exists. So a stale entry meant a report that mentioned
  // the chat was filed, with a file path, onto a screen that is gone. With
  // the entries removed those reports come back unplaced — a person reads
  // them — and are not pushed onto some other screen instead.
  it('the sorter files a report about the chat or the guides nowhere, not somewhere wrong', () => {
    const idx = buildPlacementIndex(ENTRIES as any)
    for (const title of [
      'The Ask Bee Hub chat gave me a wrong answer about drips', 'the help thing does not open', 'the question mark button is missing',
      'I cannot find the guide', 'the manual pages are out of date', 'editing the guide loses my changes', 'the chat bubble covers the save button',
    ]) {
      const p = placeFeedbackItem({ title, description: '' }, idx)
      expect(p.confidence, title).toBe('none')
      expect(p.candidates, title).toEqual([])
    }
  })

  it('…and a stale entry really did catch them (the map at 722aaa0)', () => {
    const idx = buildPlacementIndex(JSON.parse(atHead('docs/screen-map.json')).entries)
    const p = placeFeedbackItem({ title: 'the chat bubble covers the save button', description: '' }, idx)
    expect(p.candidates[0].id).toBe('shell.ask-bee-hub')
  })

  it('reports about screens that still exist are sorted as they were', () => {
    const now = buildPlacementIndex(ENTRIES as any), then = buildPlacementIndex(JSON.parse(atHead('docs/screen-map.json')).entries)
    for (const title of ['the master emails have a typo', 'the default email schedule is wrong', 'I cannot add a tag to a client', 'the reminders list is empty', 'Send to Jobber failed', 'the inbox count is wrong']) {
      const a = placeFeedbackItem({ title, description: '' }, now), b = placeFeedbackItem({ title, description: '' }, then)
      expect([a.confidence, a.candidates[0]?.id], title).toEqual([b.confidence, b.candidates[0]?.id])
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · NOTHING IS DELETED FROM THE DATABASE
// ═══════════════════════════════════════════════════════════════════════════
describe('the slides stay as rows', () => {
  // WHAT THIS GUARDS: the rows in guide_slides and manual_slides can only be
  // lost two ways — a migration that names one of the tables, or app code
  // that writes to one. Both are checked against the tree AS IT IS NOW.
  //
  // It used to assert "no migration was added, changed or removed since
  // 722aaa0", and that no line added anywhere since then contained "delete
  // from", "truncate" or ".delete()". That described one commit, not the
  // tables: it went red the moment the next, unrelated migration landed (the
  // call-script seed, 8f8e100), and would have gone red again on any later
  // delete in any feature. A guard that fails on honest work gets switched
  // off; this one names the two tables and nothing else.
  const SLIDE_TABLES = /guide_slides|manual_slides/

  it('no migration that names a slide table was added, changed or removed', () => {
    // Read from disk, not from git, so a migration written but not yet
    // committed is caught too.
    const naming = readdirSync(join(root0, 'migrations')).filter(f => SLIDE_TABLES.test(read(`migrations/${f}`))).sort()
    // The three that existed when the guides were retired: the two that made
    // the tables, and help_entries, which only mentions them.
    expect(naming).toEqual(['help_entries.sql', 'manual_slides.sql', 'tier_prices.sql'])
    for (const f of naming) expect(read(`migrations/${f}`), f).toBe(atHead(`migrations/${f}`))
    // The scan is really reading the folder (a migration added since then,
    // which does not name the tables, is seen and passed over).
    expect(readdirSync(join(root0, 'migrations'))).toContain('seed_call_script_masters.sql')
  })

  it('no code writes to a slide table: the only two uses are the page load’s reads', () => {
    const walk = (dir: string): string[] => readdirSync(join(root0, dir), { withFileTypes: true }).flatMap(d => {
      const p = `${dir}/${d.name}`
      if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p)
      return /\.(ts|tsx|js|jsx|mjs)$/.test(d.name) && !/\.test\./.test(d.name) ? [p] : []
    })
    const uses: string[] = []
    for (const f of ['app', 'lib', 'components', 'scripts'].flatMap(walk)) {
      const src = read(f)
      const re = /\.from\(\s*['"`](guide_slides|manual_slides)['"`]\s*\)([\s\S]{0,400})/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        // What is done with the table: the first call chained onto .from().
        const verb = (m[2].match(/^\s*\.(\w+)\(/) || [])[1] || 'unknown'
        uses.push(`${f}: ${m[1]} ${verb}`)
        // …and nothing in the rest of that chain changes rows.
        const chain = m[2].split(/\n\s*\n|;/)[0]
        expect(chain, `${f} ${m[1]}`).not.toMatch(/\.(delete|update|insert|upsert)\(/)
      }
      // No raw SQL against them either.
      expect(src, f).not.toMatch(/(drop table|truncate|delete from|update|insert into)\s+(if exists\s+)?(public\.)?(guide_slides|manual_slides)/i)
    }
    expect(uses.sort()).toEqual(['app/_hub-page.tsx: guide_slides select', 'app/_hub-page.tsx: manual_slides select'])
  })

  it('the page load that reads the rows, and the record of both tables’ columns, are byte-for-byte what they were', () => {
    expect(read('app/_hub-page.tsx'), 'app/_hub-page.tsx').toBe(atHead('app/_hub-page.tsx'))
    // The record of the two slide tables' columns: THEIR two lines, byte for
    // byte. This used to compare the whole snapshot file, so it went red the
    // day any other table was added (client_files, 13 Nov 2026) — the same
    // too-wide pin the migrations check above had. A new table's line is not
    // a change to the slides; a change to either slide line still fails here.
    const slideLines = (text: string) => text.split('\n').filter(l => /^(guide_slides|manual_slides):/.test(l))
    expect(slideLines(read('lib/db-columns.snapshot.txt'))).toEqual(slideLines(atHead('lib/db-columns.snapshot.txt')))
    expect(slideLines(read('lib/db-columns.snapshot.txt'))).toHaveLength(2)
  })
})

// The last thing that could destroy the rows: each route's save deleted every
// row in its table and inserted the new set. Nothing in the app calls either
// route any more, so both are closed, read and save alike.
describe('/api/guide-slides and /api/manual-slides answer "closed" and read nothing', () => {
  const ROUTES = [
    { name: 'guide-slides', GET: guideGET, POST: guidePOST, table: 'guide_slides', body: { error: 'guide_slides_closed', message: 'The Quick Start Guide is retired. Its slides are kept, but they can no longer be read or changed here.' } },
    { name: 'manual-slides', GET: manualGET, POST: manualPOST, table: 'manual_slides', body: { error: 'manual_slides_closed', message: 'The Manual is retired. Its slides are kept, but they can no longer be read or changed here.' } },
  ] as const
  const save = (name: string) => new Request(`http://localhost/api/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: 'sb-access-token=a-super-admin' },
    body: JSON.stringify({ slides: [] }),          // the payload that used to empty the table
  })

  for (const r of ROUTES) {
    it(`${r.name}: a save is refused with 410, unread, with no session lookup and no table touched`, async () => {
      const req = save(r.name)
      const res = await (r.POST as any)(req)
      expect(res.status).toBe(410)
      expect(await res.json()).toEqual(r.body)
      expect(req.bodyUsed).toBe(false)
      expect(touched.supabase).toBe(0)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it(`${r.name}: a read is refused the same way, and hands back no slides`, async () => {
      const res = await (r.GET as any)(new Request(`http://localhost/api/${r.name}`))
      expect(res.status).toBe(410)
      const j = await res.json()
      expect(j).toEqual(r.body)
      expect(j.slides).toBeUndefined()
      expect(touched.supabase).toBe(0)
    })

    it(`${r.name}: the answer is the same with a request, an empty one, or none`, async () => {
      const answers = new Set<string>()
      for (const fn of [r.GET, r.POST]) for (const req of [save(r.name), new Request(`http://localhost/api/${r.name}`, { method: 'POST' }), undefined]) {
        const res = await (fn as any)(req)
        answers.add(res.status + JSON.stringify(await res.json()))
      }
      expect(answers.size).toBe(1)
      expect(touched.supabase).toBe(0)
    })

    it(`${r.name}: the file is nothing but the refusal — it cannot delete, insert or read`, () => {
      const code = read(`app/api/${r.name}/route.ts`).split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
      expect(code).not.toMatch(/supabase|\.from\(|\.delete\(|\.insert\(|\.select\(|fetch\(|process\.env|request\b|req\b|await /i)
      expect(code).not.toContain(`'${r.table}'`)               // the table is never named as a table (only inside the error code)
      expect(code.match(/^import /gm)!.length).toBe(1)
      expect(code).toContain("import { NextResponse } from 'next/server'")
      expect(code.match(/export /g)!.length).toBe(2)             // GET and POST only
      expect(code).toContain('export async function GET() {')
      expect(code).toContain('export async function POST() {')
      expect(code.match(/status: 410/g)!.length).toBe(2)
      // and the wipe it used to do really was there
      expect(atHead(`app/api/${r.name}/route.ts`)).toMatch(/\.delete\(\)/)
    })
  }

  it('nothing in the app calls either route', () => {
    const walk = (dir: string): string[] => readdirSync(join(root0, dir), { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (['node_modules', '.next', '.git'].includes(e.name) ? [] : walk(join(dir, e.name))) : /\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : [])
    const callers = ['app', 'components', 'lib'].flatMap(walk).filter(f => !/^app\/api\/(guide|manual)-slides\//.test(f) && /\/api\/(guide|manual)-slides/.test(read(f)))
    expect(callers).toEqual([])
  })

  it('the page still reads both tables itself, so the rows are still reachable for Kevin’s videos', () => {
    const page = read('app/_hub-page.tsx')
    expect(page).toContain(".from('guide_slides')")
    expect(page).toContain(".from('manual_slides')")
    expect(page).not.toMatch(/guide_slides'\)\s*\.delete|manual_slides'\)\s*\.delete/)
  })
})
