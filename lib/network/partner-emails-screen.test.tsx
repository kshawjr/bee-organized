// @vitest-environment happy-dom
//
// Partner emails, slice 3 (2026-11-22): THE PARTNER EMAILS GROUP ON THE EMAILS
// SCREEN. Kevin: "partner emails are treated exactly like every other email."
// The same EmailsList, EmailRow, Read dialog, step editor and actions as the
// client sequences, with the partner tags and partner words.
//
// Every owner action on a client sequence, one by one, on a partner sequence:
//   Read (and step through)       · Edit the wording (Customize first)
//   Put the Bee Organized wording back · Change when it goes out
//   Add an email (blank)          · Remove · Bring back · Pause / Start
//   Send me a test                · Preview in the editor · merge tags
//   a button                      · the rich-text Message editor
import { expandAllEmailGroups } from '../emails-test-helpers'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHub from '@/components/BeeHub'
import * as EmailsScreen from '@/components/settings/EmailsScreen'
import { PARTNER_MERGE_TAGS } from '../partner-merge-tags'
import { OWNER_MERGE_TAGS } from '../merge-tags'
import { PARTNER_FOOTER_REASON } from './partner-footer'

const { SendTestBar, MergeTagPicker, previewCardFooter, previewEmailHtml } = EmailsScreen as any
const { EmailsList, DripPathStepEditor, TimingEditModal, AddEmailModal, RemoveEmailModal, stepSaveProblemInWords, PARTNER_FIRST_EMAIL_NOTE, dripEmailRows, buildEmailList } = BeeHub as any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = process.cwd()
const MIG = readFileSync(join(ROOT, 'migrations/partner_emails.sql'), 'utf8')
const bodyIn = (tag: string) => new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(MIG)![1]
// The two partner masters, as the screen holds them (masterStepsToUi shape).
const mstep = (order: number, subject: string, days: number, unit: string | null, body: string, extra: any = {}) =>
  ({ id: `m${order}`, order, type: 'email', delay_days: days, delayUnit: unit, subject, body, origin: 'master', fromMaster: true, isActive: true, ...extra })
const PARTNER_STEPS = {
  'partner-introduction': [mstep(1, 'Great to meet you', 0, null, bodyIn('email500')), mstep(2, 'Thinking of you and your clients', 90, 'months', bodyIn('email501'))],
  'partner-power-introduction': [mstep(1, 'Great to meet you', 0, null, bodyIn('email502'))],
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const spyActions = () => ({ edit: vi.fn(), reset: vi.fn(), add: vi.fn(), editTiming: vi.fn(), remove: vi.fn(), restore: vi.fn(), pause: vi.fn() })
async function mount(props: any = {}) {
  const actions = props.actions ?? spyActions()
  await act(async () => { root.render(<EmailsList audience="partner" pathSteps={PARTNER_STEPS} templates={[]} masterSteps={PARTNER_STEPS} actions={actions} locationId="loc-1" {...props} />) })
  await expandAllEmailGroups(container, act as any)
  return actions
}
const rowEl = (key: string) => container.querySelector(`[data-email-row="${key}"]`) as HTMLElement
const buttonIn = (el: Element, text: string) => (Array.from(el.querySelectorAll('button')) as HTMLButtonElement[]).find(b => (b.textContent || '').trim().startsWith(text))
const K1 = 'step-partner-introduction-1', K2 = 'step-partner-introduction-2', KP = 'step-partner-power-introduction-1'

describe('the Partner emails group shows the two partner sequences', () => {
  it('two groups, named for partners, with their emails, subjects and timing', async () => {
    await mount()
    const text = container.textContent || ''
    expect(text).toContain('Partner introduction')
    expect(text).toContain('Power Partner introduction')
    expect(text).toContain('Counted from the day you start a partner on it')
    expect(text).not.toMatch(/enquiry|someone new gets in touch|after a job/i)
    expect(rowEl(K1).textContent).toContain('Great to meet you')
    expect(rowEl(K1).textContent).toContain('Right away')
    expect(rowEl(K2).textContent).toContain('Thinking of you and your clients')
    // the label as rendered, beside its clock: "3 months", no "later" (Kevin)
    expect((rowEl(K2).querySelector('button[title="Change when this goes out"]') as HTMLElement).textContent!.trim()).toBe('3 months')
    expect(rowEl(KP).textContent).toContain('Great to meet you')
    // the first email of each says how it goes, in partner words
    expect(rowEl(K1).textContent).toContain('Fixed — sends when you start it')
    expect(rowEl(K1).textContent).toContain(PARTNER_FIRST_EMAIL_NOTE)
  })
  it('no client group, no moving toggle, no client email appears in partner mode', async () => {
    await mount({ pathSteps: { ...PARTNER_STEPS, 'organizing-a': [mstep(1, 'CLIENT', 0, null, 'x')] }, generalDefault: 'organizing-a' })
    expect(container.textContent).not.toContain('CLIENT')
    expect(container.querySelectorAll('[data-email-row]')).toHaveLength(3)
  })
  // Compares what actually RENDERS — every row and every group on screen —
  // not a heading. Adding a partner sequence to the client list fails it.
  it('the client list renders exactly the client rows and groups, and no partner one', async () => {
    const client = { 'organizing-a': [mstep(1, 'Hi', 0, null, 'x'), mstep(2, 'Again', 5, null, 'y')], 'returning-a': [mstep(1, 'Back', 0, null, 'z')] }
    await act(async () => { root.render(<EmailsList pathSteps={{ ...PARTNER_STEPS, ...client }} masterSteps={{ ...PARTNER_STEPS, ...client }} templates={[]} generalDefault="organizing-a" actions={spyActions()} />) })
    await expandAllEmailGroups(container, act as any)
    const rows = Array.from(container.querySelectorAll('[data-email-row]')).map(e => e.getAttribute('data-email-row')).sort()
    expect(rows).toEqual(['step-organizing-a-1', 'step-organizing-a-2', 'step-returning-a-1'])
    const groups = Array.from(container.querySelectorAll('[data-fold-header]')).map(e => e.getAttribute('aria-controls')).sort()
    expect(groups).toEqual(['email-group-job', 'email-group-new', 'email-group-returning'])
  })
  it('handed a partner key as its default, the client list still renders no partner row', async () => {
    await act(async () => { root.render(<EmailsList pathSteps={{ ...PARTNER_STEPS }} templates={[]} generalDefault="partner-introduction" />) })
    await expandAllEmailGroups(container, act as any)
    const rows = Array.from(container.querySelectorAll('[data-email-row]')).map(e => e.getAttribute('data-email-row'))
    // buildEmailList shows whatever key it is given as "new"; the guard is the
    // database (a location's default can never be a partner key). This pins
    // that the partner list's OWN groups are never added on top.
    expect(Array.from(container.querySelectorAll('[data-fold-header]')).map(e => e.getAttribute('aria-controls')).sort()).toEqual(['email-group-job', 'email-group-new'])
    expect(rows.filter(r => r!.includes('partner-power-introduction'))).toEqual([])
  })
  it('the rows are the very same rows a client sequence makes (one row builder)', () => {
    const viaShared = dripEmailRows({ pathSteps: PARTNER_STEPS, templates: [], pathKey: 'partner-introduction' })
    const viaClientBuilder = buildEmailList({ pathSteps: PARTNER_STEPS, templates: [], pathKey: null, returningPathKey: 'partner-introduction' }).returning
    expect(viaShared).toEqual(viaClientBuilder)
  })
})

describe('every owner action on a client sequence works on a partner sequence', () => {
  it('Read opens the same dialog, and steps through the sequence', async () => {
    await mount()
    await act(async () => { buttonIn(rowEl(K1), 'Read')!.click() })
    const dlg = document.querySelector('[data-edialog]') as HTMLElement
    expect(dlg.textContent).toContain('Great to meet you')
    await act(async () => { buttonIn(dlg, 'Next →')!.click() })
    expect((document.querySelector('[data-edialog]') as HTMLElement).textContent).toContain('Thinking of you and your clients')
  })
  it('Edit the wording: the same edit action, with the row of the partner sequence', async () => {
    const a = await mount()
    await act(async () => { buttonIn(rowEl(K2), 'Edit')!.click() })
    expect(a.edit).toHaveBeenCalledTimes(1)
    expect(a.edit.mock.calls[0][0]).toMatchObject({ pathKey: 'partner-introduction', order: 2, rail: 'drip' })
  })
  it('Put the Bee Organized wording back: offered on an email in your own words, same reset action', async () => {
    const yours = { ...PARTNER_STEPS, 'partner-introduction': PARTNER_STEPS['partner-introduction'].map((s: any) => ({ ...s, fromMaster: false, dbId: 'd' + s.order, subject: s.order === 2 ? 'My subject' : s.subject })) }
    const a = await mount({ pathSteps: yours })
    await act(async () => { buttonIn(rowEl('step-partner-introduction-d2'), 'Read')!.click() })
    const back = buttonIn(document.querySelector('[data-edialog]')!, 'Put the Bee Organized wording back')
    expect(back).toBeTruthy()
    await act(async () => { back!.click() })
    expect(a.reset.mock.calls[0][0]).toMatchObject({ pathKey: 'partner-introduction', order: 2 })
  })
  it('Change when it goes out: the clock on every email after the first, same timing action', async () => {
    const a = await mount()
    expect(rowEl(K1).querySelector('button[title="Change when this goes out"]')).toBeNull()
    await act(async () => { (rowEl(K2).querySelector('button[title="Change when this goes out"]') as HTMLButtonElement).click() })
    expect(a.editTiming.mock.calls[0][0]).toMatchObject({ pathKey: 'partner-introduction', order: 2 })
  })
  it('the timing dialog counts from "you start it", not an enquiry', async () => {
    const row = dripEmailRows({ pathSteps: PARTNER_STEPS, templates: [], pathKey: 'partner-introduction' })[1]
    await act(async () => { root.render(<TimingEditModal row={row} steps={PARTNER_STEPS['partner-introduction']} ownsPath={false} liveLeadCount={0} busy={false} err="" onCancel={() => {}} onConfirm={() => {}} />) })
    expect(document.body.textContent).toContain('after you start it')
    expect(document.body.textContent).not.toContain('enquiry')
  })
  it('the partway notes are about partners on a partner sequence (timing, add, remove), and as before on a client one', async () => {
    const prow = dripEmailRows({ pathSteps: PARTNER_STEPS, templates: [], pathKey: 'partner-introduction' })[1]
    const crow = { ...prow, pathKey: 'organizing-a', key: 'c' }
    const text = async (el: any) => { await act(async () => { root.render(el) }); const t = document.body.textContent || ''; return t }
    const noop = () => {}
    const timing = (row: any, n: number) => <TimingEditModal row={row} steps={PARTNER_STEPS['partner-introduction']} ownsPath liveLeadCount={n} busy={false} err="" onCancel={noop} onConfirm={noop} />
    let t = await text(timing(prow, 0))
    expect(t).toContain('so this affects the partners you start on it from now on.')
    expect(t).not.toContain('come in')
    // nothing changed yet, so it must not claim "Right now it is 3 months" (the short list label)
    expect(t).toContain('That’s day 90.')
    expect(t).not.toContain('Right now it is')
    t = await text(timing(prow, 2)); expect(t).toContain('2 partners are partway')
    t = await text(timing(prow, 1)); expect(t).toContain('1 partner is partway')
    t = await text(timing(crow, 0)); expect(t).toContain('so this affects people who come in from now on.')
    t = await text(timing(crow, 3)); expect(t).toContain('3 people are partway')
    const add = (partner: boolean, n: number) => <AddEmailModal templates={[]} steps={PARTNER_STEPS['partner-introduction']} ownsPath liveLeadCount={n} busy={false} err="" onCancel={noop} onConfirm={noop} partner={partner} />
    t = await text(add(true, 0)); expect(t).toContain('so this will only go to the partners you start on it from now on.'); expect(t).not.toContain('come in')
    t = await text(add(true, 4)); expect(t).toContain('4 partners are partway')
    t = await text(add(false, 0)); expect(t).toContain('so this will only go to people who come in from now on.')
    const rem = (row: any, n: number) => <RemoveEmailModal row={row} ownsPath liveLeadCount={n} busy={false} err="" onCancel={noop} onConfirm={noop} />
    t = await text(rem(prow, 2)); expect(t).toContain('2 partners are partway')
    t = await text(rem(crow, 2)); expect(t).toContain('2 people are partway')
  })
  it('Add an email: on each partner sequence, with that sequence', async () => {
    const a = await mount()
    const adds = (Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]).filter(b => (b.textContent || '').includes('Add an email here'))
    expect(adds).toHaveLength(2)
    await act(async () => { adds[0].click(); adds[1].click() })
    expect(a.add.mock.calls.map((c: any) => c[0])).toEqual(['partner-introduction', 'partner-power-introduction'])
  })
  it('Remove and Pause: on every email after the first, never the first (same rule as clients)', async () => {
    const a = await mount()
    expect(buttonIn(rowEl(K1), 'Remove')).toBeUndefined()
    expect(buttonIn(rowEl(K1), '⏸ Pause')).toBeUndefined()
    await act(async () => { buttonIn(rowEl(K2), 'Remove')!.click() })
    await act(async () => { buttonIn(rowEl(K2), '⏸ Pause')!.click() })
    expect(a.remove.mock.calls[0][0]).toMatchObject({ pathKey: 'partner-introduction', order: 2 })
    expect(a.pause.mock.calls[0]).toEqual([expect.objectContaining({ pathKey: 'partner-introduction', order: 2 }), true])
  })
  it('a paused partner email says so in partner words, and Start runs the same action', async () => {
    const paused = { ...PARTNER_STEPS, 'partner-introduction': [PARTNER_STEPS['partner-introduction'][0], { ...PARTNER_STEPS['partner-introduction'][1], isPaused: true }] }
    const a = await mount({ pathSteps: paused })
    expect(rowEl(K2).textContent).toContain('no partner gets this one')
    await act(async () => { buttonIn(rowEl(K2), '▶ Start')!.click() })
    expect(a.pause.mock.calls[0][1]).toBe(false)
  })
  it('Bring back a removed email: same restore action', async () => {
    const removed = { ...PARTNER_STEPS, 'partner-introduction': [PARTNER_STEPS['partner-introduction'][0], { ...PARTNER_STEPS['partner-introduction'][1], isActive: false }] }
    const a = await mount({ pathSteps: removed })
    await act(async () => { buttonIn(container, 'Bring back')!.click() })
    expect(a.restore.mock.calls[0][0]).toMatchObject({ pathKey: 'partner-introduction', order: 2 })
  })
  it('Send me a test: in the Read dialog, to the partner test route, with the step', async () => {
    const fetchMock: any = vi.fn(async (..._a: any[]) => ({ ok: true, json: async () => ({ ok: true, to: 'me@beeorganized.com' }) }))
    vi.stubGlobal('fetch', fetchMock)
    const row = { ...dripEmailRows({ pathSteps: PARTNER_STEPS, templates: [], pathKey: 'partner-introduction' })[0], stepId: 'step-uuid-1' }
    await act(async () => { root.render(<SendTestBar locationId="loc-1" row={row} sending />) })
    expect(container.textContent).toContain('never to a partner')
    await act(async () => { buttonIn(container, 'Send me a test')!.click() })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/emails/test-send-partner')
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body)).toEqual({ locationId: 'loc-1', stepId: 'step-uuid-1' })
    expect(container.textContent).toContain('Sent to me@beeorganized.com')
  })
  it("a client email's test still goes to the client test route, as before", async () => {
    const fetchMock: any = vi.fn(async (..._a: any[]) => ({ ok: true, json: async () => ({ ok: true, to: 'me@x.com' }) }))
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => { root.render(<SendTestBar locationId="loc-1" row={{ rail: 'drip', stepId: 's1', pathKey: 'organizing-a' }} sending />) })
    expect(container.textContent).toContain('as a client will')
    await act(async () => { buttonIn(container, 'Send me a test')!.click() })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/emails/test-send')
  })
  it('a client drip email\'s preview still carries no footer (unchanged)', () => {
    expect(previewCardFooter({ rail: 'drip', pathKey: 'organizing-a' }, 'x')).toBeNull()
    const html = previewEmailHtml({ row: { rail: 'drip', pathKey: 'organizing-a', subject: 'Hi', body: 'Hello' }, style: 'soft', values: {}, signature: null, postalAddress: 'x' })
    expect(html).not.toContain('bo-card-footer')
  })
})

describe('the editor on a partner email: same editor, partner tags only', () => {
  const step = { step_order: 1, subject: 'Great to meet you', body: 'Hi {{partner_name}},', delay_days: 0, button_text: '', button_link: '', button_align: null }
  const offered = () => Array.from(document.querySelectorAll('[data-merge-tag]')).map(b => b.getAttribute('data-merge-tag'))
  it('the tag picker offers exactly the partner tags, grouped for partners', async () => {
    await act(async () => { root.render(<DripPathStepEditor step={step} onSave={vi.fn()} onClose={() => {}} audience="partner" />) })
    expect(offered()).toEqual(PARTNER_MERGE_TAGS.map(t => t.key))
    expect(document.body.textContent).toContain('The partner')
    expect(document.body.textContent).toContain('{{partner_name}}')
    expect(document.body.textContent).toContain('days after you start a partner on it')
    expect(offered()).not.toContain('first_name')
  })
  it('a client email keeps the client tags, unchanged', async () => {
    await act(async () => { root.render(<DripPathStepEditor step={step} onSave={vi.fn()} onClose={() => {}} />) })
    expect(offered()).toEqual(OWNER_MERGE_TAGS.map(t => t.key))
    expect(document.body.textContent).toContain('days after the lead comes in')
  })
  it('the picker on its own: partner tags with partner groups; with no groups given, the client groups as before', async () => {
    await act(async () => { root.render(<MergeTagPicker onInsert={() => {}} />) })
    expect(offered()).toEqual(OWNER_MERGE_TAGS.map(t => t.key))
  })
  it('the editor saves through the same save, with the wording typed', async () => {
    const onSave = vi.fn(async () => {})
    await act(async () => { root.render(<DripPathStepEditor step={step} onSave={onSave} onClose={() => {}} audience="partner" />) })
    const save = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]).find(b => b.textContent === 'Save')!
    await act(async () => { save.click() })
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Great to meet you', body: 'Hi {{partner_name}},', delay_days: 0 }))
  })
})

describe('the Settings screen wires the partner sequences into the same actions (source)', () => {
  const HUB = readFileSync(join(ROOT, 'components/BeeHub.jsx'), 'utf8')
  it('loads the partner masters and the location\'s partner copies, merged into the same maps', () => {
    // twice: the Emails screen, and the corporate master editor
    expect(HUB.split("fetch('/api/drip-paths/masters?audience=partner', { credentials: 'include' })")).toHaveLength(3)
    expect(HUB).toContain("fetch(`/api/locations/${realLocId}/drip-paths?audience=partner`, { credentials: 'include' })")
  })
  it('the partner group is given the very same action functions as the client list', () => {
    const acts = HUB.match(/actions=\{realLocId \? \{ edit: emailsRowEdit, reset: emailsRowReset, add: openAddEmail, editTiming: emailsRowEditTiming, remove: openRemoveEmail, restore: emailsRowRestore, pause: emailsRowPause \} : null\}/g)
    expect(acts).toHaveLength(2)
    expect(HUB).toMatch(/<EmailsList\s+audience="partner"/)
  })
  it('the editors open with the partner tags for a partner sequence', () => {
    expect(HUB).toContain('{...emailsEditorProps(stepContentEditor.pathId)}')
    expect(HUB).toContain('{...emailsEditorProps(addEmailState.pathKey)}')
  })
  it('a partner sequence is offered a blank email, not the client templates, and its note is about partners', () => {
    expect(HUB).toContain('templates={isPartnerPathKey(addEmailState.pathKey) ? [] : templates}\n          partner={isPartnerPathKey(addEmailState.pathKey)}')
  })
  it('corporate edits the partner masters in the same master editor, with the partner tags', () => {
    expect(HUB).toContain("audience={isPartnerPathKey(editing.pathKey) ? 'partner' : 'client'}")
  })
})

describe("the refused reset is worded for owners", () => {
  it('one partner', () => {
    expect(stepSaveProblemInWords('partner_progress_active: 1 partner(s) are still on this sequence; stop them before resetting it'))
      .toMatch(/^a partner is still partway through these emails, so your version can’t be thrown away yet/)
  })
  it('several', () => {
    expect(stepSaveProblemInWords(new Error('Could not: partner_progress_active: 3 partner(s) are still on this sequence')))
      .toMatch(/^3 partners are still partway/)
  })
  it('the footer reason line is a partner\'s, not a client\'s', () => {
    expect(PARTNER_FOOTER_REASON).toMatch(/referral partners/)
  })
})
