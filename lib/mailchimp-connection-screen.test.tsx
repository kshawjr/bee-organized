// @vitest-environment happy-dom
//
// FL-75 slice 6 / FL-101 (2026-11-25) — the Mailchimp connection screen and
// the first-sync confirmation, built to Kevin's Lovable design in "Bee
// Organized Control Hive" (MailchimpConnection.tsx, BeforeWeAdd.tsx,
// MailchimpHold.tsx), with Kevin's rulings:
//   • REFUSE, never warn: while a flow that emails new contacts is live, no
//     button on any screen can start the sync; each flow is named, with how to
//     pause it
//   • "couldn't check" is never "nothing live": an unreadable Mailchimp, or an
//     overview that didn't load, is ON HOLD
//   • no typed-name field and no "I understand" tick, anywhere
//   • a tag that starts a live flow: its own unticked box, one by one
//   • the screen decides nothing — the sending code checks everything again
import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('./supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
import React from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import MailchimpConnectionScreen, { BeforeWeAdd, Hold, PAUSE_LINE, screenState, startAllowed, lastSyncedWords } from '@/components/settings/MailchimpConnectionScreen'
import { loadOverview, markReviewed, connectionState, canStart, RUN_RECORD, REVIEW_ENTITY } from './mailchimp-overview'
import { RUN_ENTITY } from './mailchimp-sync'
import { readFlows, type Flow, type FlowsRead } from './mailchimp-flows'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'tok-SECRET-123'

// ═══ 1. the rules the screen and the overview share ═══════════════════════
const OK_NONE = { ok: true, mustPause: [], paused: [] }
const OK_PAUSED = { ok: true, mustPause: [], paused: [{ name: 'Welcome New Contacts', status: 'paused', subjects: ['Welcome to the Bee Organized Hive!'] }] }
const LIVE = { ok: true, mustPause: [{ name: 'Welcome New Contacts', status: 'sending', subjects: ['Welcome to the Bee Organized Hive!'] }, { name: 'Profile Quiz - Welcome Flow', status: 'sending', subjects: ['Your Organizing Profile'] }], paused: [] }

describe('state: never synced / syncing / on hold', () => {
  const cases: Array<[any, string]> = [
    [{ synced: false, flows: OK_NONE }, 'setup'],
    [{ synced: true, flows: OK_PAUSED }, 'running'],
    [{ synced: false, flows: LIVE }, 'blocked'],
    [{ synced: true, flows: LIVE }, 'blocked'],
    [{ synced: true, flows: { ok: false } }, 'blocked'],
    [{ synced: false, flows: { ok: false } }, 'blocked'],
  ]
  it.each(cases)('%j → %s, the same on the server and in the browser', (o, want) => {
    expect(connectionState(o)).toBe(want)
    expect(screenState(o)).toBe(want)
  })
  it('no overview at all (it did not load) is on hold, never "nothing live"', () => {
    expect(screenState(null)).toBe('blocked')
    expect(screenState(undefined)).toBe('blocked')
    expect(screenState({})).toBe('blocked')
  })
  it('the button: never while on hold, never with the switch off, first sync only after the review', () => {
    for (const [s, o, want] of [
      ['blocked', { live: true, reviewed: true }, false],
      ['setup', { live: false, reviewed: true }, false],
      ['setup', { live: true, reviewed: false }, false],
      ['setup', { live: true, reviewed: true }, true],
      ['running', { live: true, reviewed: false }, true],
      ['running', { live: false, reviewed: true }, false],
    ] as const) {
      expect(canStart(s as any, o)).toBe(want)
      expect(startAllowed(s, o)).toBe(want)
    }
  })
  it('the run record is the sending code’s own', () => {
    expect(RUN_RECORD).toBe(RUN_ENTITY)
  })
})

// ═══ 2. the overview: read only ═══════════════════════════════════════════
function overviewDb(o: { syncLog?: any[]; choices?: any[]; location?: any; runsBroken?: boolean } = {}) {
  const writes: any[] = []
  const location = { id: LOC, location_id: 'loc_t', mailchimp_connected: true, mailchimp_access_token: TOKEN, mailchimp_server_prefix: 'us8', mailchimp_list_id: 'list1', mailchimp_sync_live: true, ...(o.location || {}) }
  const tables: Record<string, any[]> = { locations: [location], sync_log: o.syncLog || [], mailchimp_review_choices: o.choices || [] }
  const from = (table: string) => {
    const f: Array<(r: any) => boolean> = []
    let lim = Infinity
    const run = () => {
      if (table === 'sync_log' && o.runsBroken) return { data: null, error: { message: 'broken' } }
      const rows = (tables[table] || []).filter((r) => f.every((fn) => fn(r))).slice(0, lim)
      return { data: rows, error: null }
    }
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { f.push((r) => r[c] === v); return q },
      order: () => q,
      limit: (n: number) => { lim = n; return q },
      maybeSingle: async () => ({ data: run().data?.[0] || null, error: null }),
      insert: async (row: any) => { writes.push({ table, row }); return { error: null } },
      update: () => { throw new Error('the overview never updates') },
      upsert: () => { throw new Error('the overview never upserts') },
      delete: () => { throw new Error('the overview never deletes') },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
    }
    return q
  }
  return { db: { from }, writes }
}
const flowsAnswer = (over: Partial<Extract<FlowsRead, { ok: true }>> = {}): FlowsRead => ({ ok: true, flows: [], mustPause: [], tagFlows: [], signupFlows: [], fingerprint: 'fp', ...over })
const flow = (over: Partial<Flow>): Flow => ({ kind: 'journey', id: '1', name: 'Welcome New Contacts', status: 'paused', live: false, start: 'signup', startWords: '', tag: null, subjects: ['Welcome!'], ...over })

describe('GET overview', () => {
  const mc = () => {
    const reqs: any[] = []
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      reqs.push({ url, method: init?.method })
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ stats: { member_count: 714 } }) }
    })
    return { reqs, fetchImpl }
  }

  it('reads only: every Mailchimp request is a GET, nothing is written, and the token is not in the answer', async () => {
    const { db, writes } = overviewDb()
    const m = mc()
    const r = await loadOverview(LOC, { db, fetchImpl: m.fetchImpl as any, readFlowsImpl: async () => flowsAnswer() })
    expect(r.ok).toBe(true)
    expect(m.reqs.every((q) => q.method === 'GET')).toBe(true)
    expect(writes).toEqual([])
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    if (r.ok) expect(r.overview.audienceCount).toBe(714)
  })

  it('a live flow that emails new contacts → on hold, named with what it sends', async () => {
    const { db } = overviewDb()
    const live = flow({ status: 'sending', live: true, subjects: ['Welcome to the Bee Organized Hive!'] })
    const r = await loadOverview(LOC, { db, fetchImpl: mc().fetchImpl as any, readFlowsImpl: async () => flowsAnswer({ mustPause: [live], signupFlows: [live] }) })
    if (!r.ok) throw new Error('expected ok')
    expect(r.overview.flows).toEqual({ ok: true, mustPause: [{ name: 'Welcome New Contacts', status: 'sending', subjects: ['Welcome to the Bee Organized Hive!'] }], paused: [] })
    expect(connectionState(r.overview)).toBe('blocked')
  })

  it('flows that cannot be read → flows.ok false → on hold', async () => {
    const { db } = overviewDb()
    const r = await loadOverview(LOC, { db, fetchImpl: mc().fetchImpl as any, readFlowsImpl: async () => ({ ok: false, reason: 'rate_limited', detail: 'x' }) })
    if (!r.ok) throw new Error('expected ok')
    expect(r.overview.flows).toEqual({ ok: false })
    expect(connectionState(r.overview)).toBe('blocked')
  })

  it('synced only once a run finished completely; a partial run is the last run, with what is left', async () => {
    const partial = { entity_type: 'mailchimp_push', entity_id: LOC, status: 'partial', created_at: '2026-11-25T10:00:00Z', message: JSON.stringify({ added: 500, remaining: 700 }) }
    const { db } = overviewDb({ syncLog: [partial] })
    const r = await loadOverview(LOC, { db, fetchImpl: mc().fetchImpl as any, readFlowsImpl: async () => flowsAnswer() })
    if (!r.ok) throw new Error('expected ok')
    expect(r.overview.synced).toBe(false)
    expect(r.overview.lastRun).toEqual({ at: '2026-11-25T10:00:00Z', complete: false, added: 500, remaining: 700 })
    const { db: db2 } = overviewDb({ syncLog: [{ ...partial, status: 'complete' }] })
    const r2 = await loadOverview(LOC, { db: db2, fetchImpl: mc().fetchImpl as any, readFlowsImpl: async () => flowsAnswer() })
    if (r2.ok) expect(r2.overview.synced).toBe(true)
  })

  it('reviewed: Done was pressed, or a choice was saved — and not otherwise', async () => {
    const base = { fetchImpl: mc().fetchImpl as any, readFlowsImpl: async () => flowsAnswer() }
    const none = await loadOverview(LOC, { ...base, db: overviewDb().db })
    const done = await loadOverview(LOC, { ...base, db: overviewDb({ syncLog: [{ entity_type: REVIEW_ENTITY, entity_id: LOC, status: 'reviewed' }] }).db })
    const chose = await loadOverview(LOC, { ...base, db: overviewDb({ choices: [{ location_id: LOC, key: 'archived' }] }).db })
    expect([none, done, chose].map((r) => r.ok && r.overview.reviewed)).toEqual([false, true, true])
  })

  it('the switch is passed through as it is', async () => {
    const r = await loadOverview(LOC, { db: overviewDb({ location: { mailchimp_sync_live: false } }).db, fetchImpl: mc().fetchImpl as any, readFlowsImpl: async () => flowsAnswer() })
    if (r.ok) expect(r.overview.live).toBe(false)
  })

  it('markReviewed writes one sync_log row and nothing else', async () => {
    const { db, writes } = overviewDb()
    expect(await markReviewed(LOC, { db })).toBe(true)
    expect(writes).toEqual([{ table: 'sync_log', row: expect.objectContaining({ entity_type: 'mailchimp_review', entity_id: LOC, status: 'reviewed' }) }])
  })
})

describe('readFlows names what each flow sends, from the steps it already read', () => {
  it('subject lines come from the send-email steps; no extra requests', async () => {
    const urls: string[] = []
    const answer = (url: string) => {
      if (url.includes('customer-journeys/journeys/9/steps')) return { steps: [
        { step_type: 'trigger', trigger_type: 'signup', display_text: 'Contact signs up to ', display_subtext: 'Friends' },
        { step_type: 'action-send_email', action_details: { email: { settings: { subject_line: 'Welcome to the Bee Organized Hive!' } } } },
        { step_type: 'action-delay' },
        { step_type: 'action-send_email', action_details: { email: { settings: { subject_line: 'Your Organizing Profile' } } } },
      ] }
      if (url.includes('customer-journeys/journeys')) return { journeys: [{ id: 9, journey_name: 'Welcome New Contacts', status: 'sending', list_id: 'list1' }], total_items: 1 }
      if (url.includes('automations')) return { automations: [], total_items: 0 }
      return {}
    }
    const fetchImpl = async (url: string) => { urls.push(url); return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(answer(url)) } }
    const r = await readFlows({ token: TOKEN, serverPrefix: 'us8', listId: 'list1', fetchImpl: fetchImpl as any, sleep: async () => {} })
    if (!r.ok) throw new Error('expected ok')
    expect(r.mustPause[0].subjects).toEqual(['Welcome to the Bee Organized Hive!', 'Your Organizing Profile'])
    expect(urls).toHaveLength(3)
  })
})

// ═══ 3. the screen, mounted ═══════════════════════════════════════════════
let host: HTMLElement, root: Root
afterEach(() => { act(() => root?.unmount()); host?.remove() })
const mount = async (el: React.ReactElement) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(el) })
  await act(async () => {})
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null
const click = async (el: Element | null) => { expect(el, 'present').toBeTruthy(); await act(async () => { (el as HTMLElement).click() }); await act(async () => {}) }

const ASK = { count: 143, list_id: 'list1', list_name: 'Bee Organized Friends', flows: 'fp1',
  paused_flows: [{ name: 'Welcome New Contacts', status: 'paused', start: '' }], held_tags: [] as any[] }

function api(o: { overview?: any; overviewFails?: boolean; sync?: any[] }) {
  const syncReplies = [...(o.sync || [])]
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fetchImpl = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (url.startsWith('/api/mailchimp/overview')) {
      if (o.overviewFails) return { ok: false, status: 500, json: async () => ({ error: 'x' }) }
      return { ok: true, status: 200, json: async () => o.overview }
    }
    if (url === '/api/mailchimp/sync') return { ok: true, status: 200, json: async () => syncReplies.shift() }
    throw new Error('unexpected ' + url)
  })
  return { fetchImpl, calls, syncCalls: () => calls.filter((c) => c.url === '/api/mailchimp/sync') }
}
const screen = (a: ReturnType<typeof api>, extra: any = {}) => (
  <MailchimpConnectionScreen locationId="loc_test" accountName="Test Bee Organized" listName="Bee Organized Friends" onReview={() => {}} onDisconnect={() => {}} fetchImpl={a.fetchImpl} {...extra} />
)
const NEVER = { live: true, synced: false, reviewed: true, audience_count: 2, last_run: null, flows: OK_PAUSED, how_to_pause: '' }

describe('never synced', () => {
  it('three steps; the first sync stays off until the review is done', async () => {
    const a = api({ overview: { ...NEVER, reviewed: false } })
    await mount(screen(a))
    expect(host.querySelector('[data-testid="mc-connection"]')!.getAttribute('data-state')).toBe('setup')
    expect(byId('mc-pill')!.textContent).toBe('Not syncing yet')
    expect(host.textContent).toContain('Review who goes to Mailchimp')
    expect(host.textContent).toContain('Pause your Mailchimp automations')
    expect(byId('mc-start')!.disabled).toBe(true)
    expect(host.textContent).toContain('Finish your contact review first.')
  })
  it('the switch off keeps it off, even after the review, and says so', async () => {
    const a = api({ overview: { ...NEVER, live: false } })
    await mount(screen(a))
    expect(byId('mc-start')!.disabled).toBe(true)
    expect(byId('mc-not-live')).toBeTruthy()
  })
  it('step 2 names the flows checked as paused just now', async () => {
    const a = api({ overview: NEVER })
    await mount(screen(a))
    expect(byId('mc-step2-paused')!.textContent).toContain('Welcome New Contacts is paused')
  })
  it('"How to pause them" opens the four steps in a window; it sends nothing and closes by its cross', async () => {
    const a = api({ overview: NEVER })
    await mount(screen(a))
    expect(byId('mc-pause-window')).toBeNull()
    await click(byId('mc-how-to-pause'))
    expect(byId('mc-pause-window')!.getAttribute('aria-label')).toBe('How to pause your automations')
    expect(Array.from(host.querySelectorAll('[data-testid="mc-pause-steps"] li')).map((l) => l.textContent)).toEqual([
      '1.In Mailchimp, go to Automations.', '2.Find the flow in the list.', '3.Click the arrow on the right of its row.', '4.Choose Pause.'])
    expect(byId('mc-pause-window')!.textContent).toContain('Bee Hub can’t pause them for you.')
    await click(host.querySelector('[data-testid="mc-pause-window"] button[aria-label="Close"]'))
    expect(byId('mc-pause-window')).toBeNull()
    expect(a.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
  it('Disconnect is a quiet link; its window asks first, and Keep connected does nothing', async () => {
    const a = api({ overview: NEVER })
    const onDisconnect = vi.fn()
    await mount(screen(a, { onDisconnect }))
    await click(byId('mc-disconnect-link'))
    expect(byId('mc-disconnect')!.textContent).toContain('This stops Bee Hub adding people. Your Mailchimp audience stays as it is.')
    await click(Array.from(host.querySelectorAll('[data-testid="mc-disconnect"] button')).find((b) => b.textContent === 'Keep connected')!)
    expect(byId('mc-disconnect')).toBeNull()
    expect(onDisconnect).not.toHaveBeenCalled()
    await click(byId('mc-disconnect-link'))
    await click(byId('mc-disconnect-yes'))
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })
})

describe('the first-sync confirmation — nothing live', () => {
  it('Start asks the server; the page shows the exact count and audience; nothing more is sent', async () => {
    const a = api({ overview: NEVER, sync: [{ ran: false, reason: 'needs_confirmation', confirm: ASK }] })
    await mount(screen(a))
    await click(byId('mc-start'))
    expect(a.syncCalls()).toHaveLength(1)
    expect(a.syncCalls()[0].body.confirm).toBeUndefined()
    expect(host.querySelector('[data-testid="mc-before-we-add"]')!.getAttribute('data-kind')).toBe('ask')
    expect(byId('mc-confirm-count')!.textContent).toBe('About to add 143 people to Bee Organized Friends.')
    expect(byId('mc-confirm-clear')!.textContent).toBe('Nothing in Mailchimp will email them.')
    expect(byId('mc-add')!.textContent).toBe('Add them')
    expect(byId('mc-add')!.disabled).toBe(false)
    expect(host.textContent).toContain('Mailchimp · First sync')
    expect(host.textContent).toContain('Bee Organized Friends · Test Bee Organized')
  })
  it('promises no Bee Hub welcome email: the sync sends none to people already in Bee Hub', async () => {
    const a = api({ overview: NEVER, sync: [{ ran: false, reason: 'needs_confirmation', confirm: ASK }] })
    await mount(screen(a))
    await click(byId('mc-start'))
    expect(host.textContent).not.toMatch(/They.ll get Bee Hub/)
  })
  it('no typed-name field, no "I understand" tick', async () => {
    const a = api({ overview: NEVER, sync: [{ ran: false, reason: 'needs_confirmation', confirm: ASK }] })
    await mount(screen(a))
    await click(byId('mc-start'))
    expect(host.querySelectorAll('input:not([type=checkbox])')).toHaveLength(0)
    expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(0)
    expect(host.textContent).not.toMatch(/type your|full name|I understand/i)
  })
  it('Add sends the count, audience and flows that were shown; the result is the server’s', async () => {
    const a = api({ overview: NEVER, sync: [{ ran: false, reason: 'needs_confirmation', confirm: ASK }, { ran: true, complete: true, pushed: 143, already: 0, failed: 0, remaining: 0, tags_held: [] }] })
    await mount(screen(a))
    await click(byId('mc-start'))
    await click(byId('mc-add'))
    expect(a.syncCalls()[1].body.confirm).toEqual({ count: 143, list_id: 'list1', flows: 'fp1', tags_ok: [] })
    expect(host.textContent).toContain('Done: added 143 people to Bee Organized Friends.')
  })
  it('Cancel sends nothing', async () => {
    const a = api({ overview: NEVER, sync: [{ ran: false, reason: 'needs_confirmation', confirm: ASK }] })
    await mount(screen(a))
    await click(byId('mc-start'))
    const cancel = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!
    await click(cancel)
    expect(a.syncCalls()).toHaveLength(1)
    expect(byId('mc-start')).toBeTruthy()
  })
  it('something changed between the look and the send: asked again, with the new numbers', async () => {
    const a = api({ overview: NEVER, sync: [{ ran: false, reason: 'needs_confirmation', confirm: ASK }, { ran: false, reason: 'needs_confirmation', confirm: { ...ASK, count: 144, flows: 'fp2' } }] })
    await mount(screen(a))
    await click(byId('mc-start'))
    await click(byId('mc-add'))
    expect(host.textContent).toContain('Something changed in Mailchimp since you looked, so nothing was added.')
    expect(byId('mc-confirm-count')!.textContent).toBe('About to add 144 people to Bee Organized Friends.')
  })
  it('a tag that starts a live flow: its own box, unticked; ticking one carries that one only', async () => {
    const held = { ...ASK, held_tags: [{ tag: 'CLOSEDJOB', flows: ['Closed Job Journey'], people: 4 }, { tag: 'VIP', flows: ['VIP Thanks'], people: 1 }] }
    const a = api({ overview: NEVER, sync: [{ ran: false, reason: 'needs_confirmation', confirm: held }, { ran: true, complete: true, pushed: 143, remaining: 0, tags_held: ['VIP'] }] })
    await mount(screen(a))
    await click(byId('mc-start'))
    const boxes = Array.from(host.querySelectorAll('[data-testid="mc-held-tags"] input[type=checkbox]')) as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([false, false])
    await click(host.querySelector('input[aria-label="Carry the tag CLOSEDJOB"]'))
    await click(byId('mc-add'))
    expect(a.syncCalls()[1].body.confirm.tags_ok).toEqual(['CLOSEDJOB'])
  })
})

describe('the first-sync confirmation — something live: refused, never warned', () => {
  const REFUSED = { ran: false, reason: 'signup_flows_live', must_pause: LIVE.mustPause, how_to_pause: 'x' }
  it('names each flow, says how to pause each one, and Add is off', async () => {
    const a = api({ overview: NEVER, sync: [REFUSED] })
    await mount(screen(a))
    await click(byId('mc-start'))
    expect(host.querySelector('[data-testid="mc-before-we-add"]')!.getAttribute('data-kind')).toBe('live')
    const names = Array.from(host.querySelectorAll('[data-testid="mc-live-flows"] [data-flow-name]')).map((e) => e.textContent)
    expect(names).toEqual(['Welcome New Contacts', 'Profile Quiz - Welcome Flow'])
    expect(Array.from(host.querySelectorAll('[data-testid="mc-live-flows"] [data-flow-pause]')).map((e) => e.textContent)).toEqual([PAUSE_LINE, PAUSE_LINE])
    expect(byId('mc-hold-title')!.textContent).toBe('Can’t add people yet')
    expect(host.textContent).toContain('These would send a second welcome email on top of Bee Hub’s.')
    expect(byId('mc-add')!.textContent).toBe('Add them')
    expect(byId('mc-add')!.disabled).toBe(true)
    expect(host.textContent).not.toMatch(/Don.t want these emails/)
  })
  it('Check again asks the server again — still without a confirm', async () => {
    const a = api({ overview: NEVER, sync: [REFUSED, { ran: false, reason: 'needs_confirmation', confirm: ASK }] })
    await mount(screen(a))
    await click(byId('mc-start'))
    await click(byId('mc-check-again'))
    expect(a.syncCalls()[1].body.confirm).toBeUndefined()
    expect(byId('mc-confirm-count')!.textContent).toBe('About to add 143 people to Bee Organized Friends.')
    expect(byId('mc-add')!.disabled).toBe(false)
  })
  it('Check again while they are still on: says so, Add stays off, nothing is sent with a confirm', async () => {
    const a = api({ overview: NEVER, sync: [REFUSED, REFUSED] })
    await mount(screen(a))
    await click(byId('mc-start'))
    expect(byId('mc-hold-status')).toBeNull()
    await click(byId('mc-check-again'))
    expect(byId('mc-hold-status')!.textContent).toBe('Checked again. These are still on.')
    expect(byId('mc-add')!.disabled).toBe(true)
    expect(a.syncCalls().every((c) => c.body.confirm === undefined)).toBe(true)
  })
  it('a flow that went live after Add was shown: the answer is the refusal, not a send', async () => {
    const a = api({ overview: NEVER, sync: [{ ran: false, reason: 'needs_confirmation', confirm: ASK }, REFUSED] })
    await mount(screen(a))
    await click(byId('mc-start'))
    await click(byId('mc-add'))
    expect(host.querySelector('[data-testid="mc-before-we-add"]')!.getAttribute('data-kind')).toBe('live')
    expect(byId('mc-add')!.disabled).toBe(true)
  })
})

describe('the first-sync confirmation — couldn’t check', () => {
  it('says so, and Add is off', async () => {
    const a = api({ overview: NEVER, sync: [{ ran: false, reason: 'mailchimp_unreadable' }] })
    await mount(screen(a))
    await click(byId('mc-start'))
    expect(host.querySelector('[data-testid="mc-before-we-add"]')!.getAttribute('data-kind')).toBe('unreadable')
    expect(byId('mc-hold-title')!.textContent).toBe('Can’t add people yet: we couldn’t check Mailchimp')
    expect(host.textContent).toContain('Until we can check, nobody will be added.')
    expect(host.querySelector('[data-testid="mc-live-flows"]')).toBeNull()
    expect(byId('mc-add')!.disabled).toBe(true)
  })
})

describe('on hold', () => {
  it('live flows: each named with how to pause it, Sync now off; Check again only reads', async () => {
    const a = api({ overview: { ...NEVER, flows: LIVE } })
    await mount(screen(a))
    expect(byId('mc-pill')!.textContent).toBe('On hold')
    expect(byId('mc-on-hold')!.getAttribute('data-reason')).toBe('flows')
    expect(Array.from(host.querySelectorAll('[data-testid="mc-live-flows"] [data-flow-name]')).map((e) => e.textContent)).toEqual(['Welcome New Contacts', 'Profile Quiz - Welcome Flow'])
    expect(Array.from(host.querySelectorAll('[data-testid="mc-live-flows"] [data-flow-pause]')).map((e) => e.textContent)).toEqual([PAUSE_LINE, PAUSE_LINE])
    expect(byId('mc-sync-now')!.disabled).toBe(true)
    expect(byId('mc-start')).toBeNull()
    expect(byId('mc-add')).toBeNull()
    await click(byId('mc-check-again'))
    expect(a.calls.filter((c) => c.method !== 'GET')).toEqual([])
    expect(byId('mc-hold-status')!.textContent).toBe('Checked again. These are still on.')
  })
  it('flows unreadable → "we couldn’t check Mailchimp", Sync now off', async () => {
    const a = api({ overview: { ...NEVER, flows: { ok: false } } })
    await mount(screen(a))
    expect(byId('mc-on-hold')!.getAttribute('data-reason')).toBe('unreadable')
    expect(byId('mc-hold-title')!.textContent).toBe('Can’t add people yet: we couldn’t check Mailchimp')
    expect(byId('mc-sync-now')!.disabled).toBe(true)
  })
  it('the overview itself didn’t load → on hold, never "nothing live"', async () => {
    const a = api({ overviewFails: true })
    await mount(screen(a))
    expect(byId('mc-on-hold')!.getAttribute('data-reason')).toBe('unreadable')
    expect(byId('mc-sync-now')!.disabled).toBe(true)
  })
})

describe('syncing (synced before)', () => {
  const RUNNING = { ...NEVER, synced: true, audience_count: 714, last_run: { at: new Date(Date.now() - 2 * 3600e3).toISOString(), complete: true, added: 3, remaining: 0 } }
  it('the numbers, and Sync now sends without a confirmation', async () => {
    const a = api({ overview: RUNNING, sync: [{ ran: true, complete: true, pushed: 3, already: 0, failed: 0, remaining: 0, tags_held: [] }] })
    await mount(screen(a))
    expect(byId('mc-pill')!.textContent).toBe('Syncing')
    expect(host.textContent).toContain('714')
    expect(host.textContent).toContain('2 hours ago')
    await click(byId('mc-sync-now'))
    expect(a.syncCalls()[0].body.confirm).toBeUndefined()
    expect(host.textContent).toContain('Done: added 3 people to Bee Organized Friends.')
  })
  it('a run that stopped partway says so, and what is left', async () => {
    const a = api({ overview: { ...RUNNING, last_run: { ...RUNNING.last_run, complete: false, remaining: 700 } }, sync: [{ ran: true, complete: false, stopped: 'time', pushed: 500, remaining: 700 }] })
    await mount(screen(a))
    expect(host.textContent).toContain('Still to go from the last sync')
    await click(byId('mc-sync-now'))
    expect(host.textContent).toContain('Stopped partway: added 500 people to Bee Organized Friends, 700 still to go.')
  })
  it('a refusal for live flows puts the screen on hold', async () => {
    let n = 0
    const a = api({ overview: RUNNING, sync: [{ ran: false, reason: 'signup_flows_live', must_pause: LIVE.mustPause }] })
    a.fetchImpl.mockImplementation(async (url: string, init: any = {}) => {
      a.calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
      if (url.startsWith('/api/mailchimp/overview')) return { ok: true, status: 200, json: async () => (n++ ? { ...RUNNING, flows: LIVE } : RUNNING) }
      return { ok: true, status: 200, json: async () => ({ ran: false, reason: 'signup_flows_live', must_pause: LIVE.mustPause }) }
    })
    await mount(screen(a))
    await click(byId('mc-sync-now'))
    expect(byId('mc-on-hold')).toBeTruthy()
    expect(byId('mc-sync-now')!.disabled).toBe(true)
  })
  it('last-synced words', () => {
    const now = Date.parse('2026-11-25T12:00:00Z')
    expect(lastSyncedWords('2026-11-25T11:59:30Z', now)).toBe('Just now')
    expect(lastSyncedWords('2026-11-25T10:00:00Z', now)).toBe('2 hours ago')
    expect(lastSyncedWords('nonsense', now)).toBe('—')
  })
})

describe('the design’s confirmation, without its typed name', () => {
  it('the source has no typed-name field and no "I understand"', () => {
    const src = readFileSync(join(process.cwd(), 'components/settings/MailchimpConnectionScreen.jsx'), 'utf8').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/Type your full name|I understand/i)
    expect(src).not.toMatch(/<input(?![^>]*type="checkbox")/)
  })
  it('the refusal box on its own holds no button of its own: only what it is handed', async () => {
    const AnyHold = Hold as any   // the screen is untyped JS; typed here at the boundary
    await mount(<div data-mcc><AnyHold reason="flows" flows={LIVE.mustPause} status={null} actions={null} /></div>)
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(host.querySelectorAll('[data-flow-name]')).toHaveLength(2)
  })
  it('BeforeWeAdd on its own: "live" and "unreadable" have no way to add', async () => {
    for (const kind of ['live', 'unreadable']) {
      const AnyBefore = BeforeWeAdd as any
      await mount(<AnyBefore kind={kind} confirm={null} changed={false} busy={false} flows={LIVE.mustPause} listName="X" onYes={() => { throw new Error('no') }} onCheckAgain={() => {}} onCancel={() => {}} />)
      const add = byId('mc-add')!
      expect(add.disabled).toBe(true)
      await click(add)
      // every enabled button: none of them can add
      for (const b of Array.from(host.querySelectorAll('button:not(:disabled)'))) expect(['Back to Mailchimp', 'Check again', 'Cancel']).toContain(b.textContent)
      act(() => root.unmount()); host.remove()
    }
    root = undefined as any
  })
})
