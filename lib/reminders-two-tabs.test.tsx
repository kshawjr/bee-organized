// @vitest-environment happy-dom
//
// Reminders, second pass (2026-09-30): the lost-lead wizard sets a REAL
// reminder, the 13 stranded follow-ups are carried over due today, and the
// Reminders page has two tabs — Mine and Bee Hub noticed.
//
//   A) The wizard: "Set a reminder to follow up later?" → the same three
//      date choices + a line → POST /api/reminders on the CLIENT, carrying
//      no owner (the server stamps whoever answered — pinned end to end in
//      reminders-api.test.ts). No future-dated 'reach_out' any more; a plain
//      history line dated now instead.
//   B) The tabs: Mine = only reminders someone set; Bee Hub noticed = only
//      open Estimate-stage engagements whose quote waited > 3 days, at THIS
//      location, longest first. Noticed is the location's, says so, and has
//      nothing to tick — a row leaves when the job moves.
//   C) The 13 carried over as DUE TODAY (migration source pin — the SQL was
//      not executed; there is no Postgres in the test environment).
//   D) Home is unchanged: it never shows what Bee Hub noticed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import CloseLostWizard from '@/components/hive/shared/CloseLostWizard'
import RemindersScreen, { HomeReminders } from '@/components/hive/RemindersScreen'
import { estimatesAwaitingReply } from '@/components/hive/shared/noticed'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const ROOT = join(__dirname, '..')
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8')

const WED = new Date(2026, 8, 30, 12, 0, 0) // Wed 30 Sep 2026, local
const DAY = 86400000
const ago = (d: number) => new Date(WED.getTime() - d * DAY).toISOString()

let calls: Array<{ url: string; method: string; body: any }> = []
let myReminders: any[] = []
const res = (b: any, status = 200) => ({ ok: status < 400, status, json: async () => b })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(WED)
  calls = []
  myReminders = []
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: any = {}) => {
    const url = String(input)
    const method = (init.method || 'GET').toUpperCase()
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, method, body })
    if (url.startsWith('/api/reminders') && method === 'GET') return res({ reminders: myReminders })
    if (url === '/api/reminders' && method === 'POST') return res({ reminder: { id: 'r-new', ...body, user_id: 'server-stamped', done_at: null } }, 201)
    if (url.startsWith('/api/reminders/') && method === 'PATCH') {
      const id = url.split('/')[3]
      const r = myReminders.find(x => x.id === id)
      if (body.done) { myReminders = myReminders.filter(x => x.id !== id); return res({ reminder: { ...r, done_at: 'now' } }) }
      return res({ reminder: r })
    }
    if (url.startsWith('/api/engagements/') && method === 'PATCH') return res({ stage: 'Closed Lost', closed_reason: body?.closed_reason ?? null })
    if (url === '/api/touchpoints' && method === 'POST') return res({ touchpoint: { id: 'tp-1', ...body } }, 201)
    return res({})
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {}); await act(async () => {})
  return { host, root, rerender: async (next: React.ReactElement) => { await act(async () => { root.render(next) }); await act(async () => {}) } }
}
const click = (el: Element | null | undefined) => act(async () => {
  if (!el) throw new Error('nothing to click')
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const byText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text) as HTMLButtonElement | undefined
const type = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

// ── A) the wizard ────────────────────────────────────────────
describe('A) the lost-lead wizard sets a REAL reminder', () => {
  const openFollowUp = async () => {
    const onClosed = vi.fn(); const setToast = vi.fn()
    const m = await mount(<CloseLostWizard engagementId="eng-1" leadId="lead-7" onClosed={onClosed} setToast={setToast} />)
    await click(byText(document, 'Next'))
    return { ...m, onClosed, setToast }
  }

  it('asks the same three things as the Reminder button — Tomorrow / Next week / Pick a date, and what for', async () => {
    await openFollowUp()
    expect(document.body.textContent).toContain('Set a reminder to follow up later?')
    await click(byText(document, 'Yes, remind me'))
    const fields = document.querySelector('[data-testid="wizard-reminder-fields"]') as HTMLElement
    for (const t of ['Tomorrow', 'Next week', 'Pick a date']) expect(byText(fields, t)).toBeTruthy()
    expect(fields.querySelector('input[aria-label="What is this reminder for?"]')).toBeTruthy()
    // Needs BOTH a date and a line before it will close.
    expect(byText(document, 'Close as lost')!.disabled).toBe(true)
    await click(byText(fields, 'Next week'))
    expect(byText(document, 'Close as lost')!.disabled).toBe(true)
    await type(fields.querySelector('input[aria-label="What is this reminder for?"]') as HTMLInputElement, 'check back on budget')
    expect(byText(document, 'Close as lost')!.disabled).toBe(false)
  })

  it('creates a reminder on the CLIENT, with no owner in the request (the server stamps whoever answered)', async () => {
    const { setToast, onClosed } = await openFollowUp()
    await click(byText(document, 'Yes, remind me'))
    const fields = document.querySelector('[data-testid="wizard-reminder-fields"]') as HTMLElement
    await click(byText(fields, 'Tomorrow'))
    await type(fields.querySelector('input[aria-label="What is this reminder for?"]') as HTMLInputElement, 'check back on budget')
    await click(byText(document, 'Close as lost'))

    const post = calls.filter(c => c.url === '/api/reminders' && c.method === 'POST')
    expect(post).toHaveLength(1)
    expect(post[0].body).toEqual({ lead_id: 'lead-7', due_on: '2026-10-01', note: 'check back on budget' })
    expect(Object.keys(post[0].body)).not.toContain('user_id')
    expect(onClosed).toHaveBeenCalled()
    expect(setToast).toHaveBeenLastCalledWith({ kind: 'success', msg: 'Closed as lost · reminder set' })
  })

  it('no longer writes a future-dated "reach out"; keeps a plain history line dated NOW, with the person on it', async () => {
    await openFollowUp()
    await click(byText(document, 'Yes, remind me'))
    const fields = document.querySelector('[data-testid="wizard-reminder-fields"]') as HTMLElement
    await click(byText(fields, 'Next week'))
    await type(fields.querySelector('input[aria-label="What is this reminder for?"]') as HTMLInputElement, 'try again after the move')
    await click(byText(document, 'Close as lost'))

    const tps = calls.filter(c => c.url === '/api/touchpoints')
    expect(tps.some(t => t.body.kind === 'reach_out')).toBe(false)
    expect(tps.some(t => String(t.body.label).startsWith('Follow-up ·'))).toBe(false)
    expect(tps).toHaveLength(1)
    expect(tps[0].body).toMatchObject({ lead_id: 'lead-7', kind: 'system', status: null, actor: 'session', label: 'Reminder set for Wed, Oct 7 · try again after the move' })
    expect(tps[0].body).not.toHaveProperty('occurred_at') // dated now, not the due day
  })

  it('"No, skip" sets nothing', async () => {
    await openFollowUp()
    await click(byText(document, 'Close as lost'))
    expect(calls.some(c => c.url === '/api/reminders' && c.method === 'POST')).toBe(false)
    expect(calls.some(c => c.url === '/api/touchpoints')).toBe(false)
  })

  it('a failed reminder says so, plainly, and the close still stands', async () => {
    ;(globalThis.fetch as any).mockImplementation(async (input: any, init: any = {}) => {
      const url = String(input); const method = (init.method || 'GET').toUpperCase()
      calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null })
      if (url === '/api/reminders') return res({ error: 'insert_failed' }, 500)
      return res({ stage: 'Closed Lost' })
    })
    const { setToast, onClosed } = await openFollowUp()
    await click(byText(document, 'Yes, remind me'))
    const fields = document.querySelector('[data-testid="wizard-reminder-fields"]') as HTMLElement
    await click(byText(fields, 'Tomorrow'))
    await type(fields.querySelector('input[aria-label="What is this reminder for?"]') as HTMLInputElement, 'x')
    await click(byText(document, 'Close as lost'))
    expect(setToast).toHaveBeenLastCalledWith({ kind: 'error', msg: "Closed lost, but the reminder didn't save: insert_failed" })
    expect(onClosed).toHaveBeenCalled()
  })
})

// ── B) the two tabs ──────────────────────────────────────────
const LOC = 'loc-den'
const eng = (id: string, over: any = {}) => ({
  id, client_id: `c-${id}`, client_name: `Client ${id}`, title: `Job ${id}`, stage: 'Estimate', location_uuid: LOC,
  quotes: [{ sent_at: ago(10) }], ...over,
})
const ENGS = [
  eng('waited10'),                                                   // in
  eng('waited40', { quotes: [{ sent_at: ago(50) }, { sent_at: ago(40) }] }), // in — latest quote counts
  eng('fresh', { quotes: [{ sent_at: ago(2) }] }),                   // out — not 3 days yet
  eng('won', { stage: 'Closed Won' }),                               // out — the job moved
  eng('lost', { stage: 'Closed Lost' }),                             // out
  eng('booked', { stage: 'Job Scheduled' }),                         // out — moved on
  eng('noquote', { quotes: [] }),                                    // out — nothing sent
  eng('elsewhere', { location_uuid: 'loc-pdx' }),                    // out — another location
]
const MINE = [
  { id: 'r1', user_id: 'me', lead_id: 'c-x', due_on: '2026-10-02', note: 'call about the garage', record_type: 'client', record_name: 'Garage Gary', done_at: null },
]

describe('B) two tabs: Mine and Bee Hub noticed', () => {
  it('the noticed rule: open Estimate, quote waited > 3 days, this location, longest first', () => {
    const rows = estimatesAwaitingReply(ENGS, { locationId: LOC, nowMs: WED.getTime() })
    expect(rows.map(r => r.engagement_id)).toEqual(['waited40', 'waited10'])
    expect(rows.map(r => r.days)).toEqual([40, 10])
  })

  it('Mine lists ONLY reminders someone set — nothing Bee Hub noticed', async () => {
    myReminders = MINE
    const { host } = await mount(<RemindersScreen engagements={ENGS} locationId={LOC} locationName="Denver" />)
    const mine = host.querySelector('[data-testid="reminders-mine"]') as HTMLElement
    expect(mine.textContent).toContain('Only you see these')
    expect(mine.querySelectorAll('[data-testid="reminder-row"]')).toHaveLength(1)
    expect(mine.textContent).toContain('Garage Gary')
    for (const e of ENGS) expect(mine.textContent).not.toContain(`Client ${e.id}`)
    expect(host.querySelector('[data-testid="noticed-row"]')).toBeNull()
  })

  it('Bee Hub noticed lists only the waiting estimates, says it is shared, and has nothing to tick', async () => {
    myReminders = MINE
    const { host } = await mount(<RemindersScreen engagements={ENGS} locationId={LOC} locationName="Denver" />)
    await click(host.querySelector('[data-testid="reminders-tab-noticed"]'))
    const panel = host.querySelector('[data-testid="reminders-noticed"]') as HTMLElement
    expect(panel.querySelector('[data-testid="noticed-explainer"]')!.textContent).toContain('Shared by everyone at Denver')
    expect(panel.textContent).toContain('goes away by itself when the job moves')
    const rows = [...panel.querySelectorAll('[data-testid="noticed-row"]')] as HTMLElement[]
    expect(rows.map(r => r.textContent)).toEqual([expect.stringContaining('Client waited40'), expect.stringContaining('Client waited10')])
    expect(rows[0].querySelector('[data-testid="noticed-days"]')!.textContent).toBe('40 days')
    expect(panel.textContent).not.toContain('Garage Gary') // nothing personal here
    expect(panel.querySelector('[aria-label="Finish reminder"]')).toBeNull()
    expect(panel.querySelector('[aria-label="Delete reminder"]')).toBeNull()
    expect(panel.querySelector('input[type="checkbox"]')).toBeNull()
  })

  it('a noticed row leaves by itself when the job moves (won / lost / next stage)', async () => {
    const { host, rerender } = await mount(<RemindersScreen engagements={ENGS} locationId={LOC} locationName="Denver" initialTab="noticed" />)
    expect(host.querySelectorAll('[data-testid="noticed-row"]')).toHaveLength(2)
    const moved = ENGS.map(e => e.id === 'waited40' ? { ...e, stage: 'Closed Won' } : e)
    await rerender(<RemindersScreen engagements={moved} locationId={LOC} locationName="Denver" initialTab="noticed" />)
    const rows = [...host.querySelectorAll('[data-testid="noticed-row"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Client waited10')
  })

  it('a noticed row opens its engagement', async () => {
    const onOpen = vi.fn()
    const { host } = await mount(<RemindersScreen engagements={ENGS} locationId={LOC} onOpen={onOpen} initialTab="noticed" />)
    await click(byText(host, 'Client waited40'))
    expect(onOpen).toHaveBeenCalledWith({ record_type: 'engagement', engagement_id: 'waited40', client_id: 'c-waited40' })
  })

  it('ticking on Mine finishes the reminder and it leaves the list', async () => {
    myReminders = [...MINE]
    const { host } = await mount(<RemindersScreen engagements={ENGS} locationId={LOC} />)
    await click(host.querySelector('[data-testid="reminders-mine"] [aria-label="Finish reminder"]'))
    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ done: true })
    expect(host.querySelectorAll('[data-testid="reminders-mine"] [data-testid="reminder-row"]')).toHaveLength(0)
  })

  it('on All Locations, Noticed asks for a location rather than blending them', async () => {
    const { host } = await mount(<RemindersScreen engagements={ENGS} locationId={null} initialTab="noticed" />)
    expect(host.querySelector('[data-testid="noticed-pick-location"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="noticed-row"]')).toBeNull()
  })

  it('the page is wired with the engagements and the location', () => {
    const b = src('components/BeeHub.jsx')
    expect(b).toMatch(/<RemindersScreen onOpen=\{openReminderRecord\} engagements=\{Array\.isArray\(initialEngagements\)\?initialEngagements:\[\]\} locationId=\{locFilter!=='all' \? locFilter : \(viewAsUser\?\.locationId \|\| null\)\}/)
  })
})

// ── C) the 13 carried over ───────────────────────────────────
describe('C) the 13 stranded follow-ups come across as DUE TODAY (migration source pin — not executed)', () => {
  const sql = src('migrations/reminders_from_lost_followups.sql')
  const step2 = sql.slice(sql.indexOf('═══ STEP 2'))

  it('picks exactly the wizard follow-ups: reach_out, "Follow-up · …", with a person on them', () => {
    expect(step2).toContain("tp.kind = 'reach_out' AND tp.label LIKE 'Follow-up · %'")
    expect(step2).toContain('tp.user_id IS NOT NULL')
  })

  it('owner = the person who answered; client = the lead; note = the text after "Follow-up · "', () => {
    expect(step2).toMatch(/INSERT INTO public\.reminders \(user_id, location_uuid, lead_id, due_on, note\)\s+SELECT src\.user_id, src\.location_uuid, src\.lead_id,/)
    expect(step2).toContain("substr(tp.label, length('Follow-up · ') + 1)")
  })

  it('due_on is TODAY in the location’s own timezone — not the written date', () => {
    const dueLine = step2.split('\n').find(l => l.includes('-- DUE TODAY'))!
    expect(dueLine.trim().startsWith('(now() AT TIME ZONE src.tz)::date')).toBe(true)
    expect(step2).toContain("WHEN 'Central Time (CT)'  THEN 'America/Chicago'")
    expect(step2).not.toMatch(/created_at[^\n]*::date,\s*--/)
  })

  it('is written, not run: re-runnable, deletes and edits nothing, preview first', () => {
    expect(sql).toContain('WRITTEN, NOT RUN')
    expect(sql.indexOf('═══ STEP 1')).toBeLessThan(sql.indexOf('═══ STEP 2'))
    expect(step2).toContain('WHERE NOT EXISTS')
    expect(sql).not.toMatch(/\b(DELETE|UPDATE|DROP|TRUNCATE)\b/)
  })
})

// ── D) Home is unchanged ─────────────────────────────────────
describe('D) Home is unchanged — it never shows what Bee Hub noticed', () => {
  it('the Home block shows your reminders only, even with waiting estimates about', async () => {
    myReminders = [{ ...MINE[0], due_on: '2026-09-30' }]
    const { host } = await mount(<HomeReminders />)
    expect(host.textContent).toContain('Garage Gary')
    for (const e of ENGS) expect(host.textContent).not.toContain(`Client ${e.id}`)
    expect(host.querySelector('[data-testid="noticed-row"]')).toBeNull()
  })

  it('neither the Home block nor DashboardScreen reads the noticed list', () => {
    const screen = src('components/hive/RemindersScreen.jsx')
    const home = screen.slice(screen.indexOf('export function HomeReminders'), screen.indexOf('// ── the two tabs'))
    expect(home).not.toContain('estimatesAwaitingReply')
    expect(home).not.toContain('engagements')
    const b = src('components/BeeHub.jsx')
    const dash = b.slice(b.indexOf('function DashboardScreen('), b.indexOf('function DashboardScreen(') + 60000)
    expect(dash).not.toContain('estimatesAwaitingReply')
    expect(dash).toContain('<HomeReminders onOpen={onOpenReminder} onSeeAll={()=>nav(\'reminders\')} />')
  })
})
