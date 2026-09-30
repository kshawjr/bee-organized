// @vitest-environment happy-dom
//
// Settings → Emails: removing an email, and the after-the-first switch
// (lib/drip-followups.ts). Render only — the writes are pinned in
// lib/drip-followups.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  EmailsList, FollowupsSwitch, rowCanBeRemoved, FIRST_EMAIL_ALWAYS_SENDS_NOTE, FOLLOWUPS_OFF_ROW_REASON,
} from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const step = (order: number, over: any = {}) => ({
  id: `db_${order}`, dbId: `s${order}`, order, type: 'email',
  delay_days: order === 1 ? 0 : order * 5,
  subject: `Subject ${order}`, body: `Subject ${order}\n\nBody.`, origin: 'master', ...over,
})
const tpl = (o: any) => ({
  dbId: o.dbId, legacyId: o.legacyId ?? null, name: '', type: 'email',
  subject: o.subject, body: o.body, isActive: true, isMaster: true, isOwnCustom: false,
  clonedFromId: null, updatedAt: '2026-01-01',
})
const TEMPLATES = [
  tpl({ dbId: 't-welcome', legacyId: 'welcome', subject: 'Welcome!', body: 'Welcome\n\nPlain.' }),
  tpl({ dbId: 't-3mo', legacyId: 'opp_closed_job_3mo', subject: '3mo', body: '3mo\n\nPlain.' }),
  tpl({ dbId: 't-12mo', legacyId: 'opp_closed_job_12mo', subject: '12mo', body: '12mo\n\nPlain.' }),
]

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const mountList = async (over: any = {}) => {
  const steps = over.steps ?? [step(1), step(2), step(3)]
  const actions = { edit: vi.fn(), reset: vi.fn(), remove: vi.fn(), restore: vi.fn() }
  const props: any = {
    pathSteps: { 'organizing-a': steps }, masterSteps: { 'organizing-a': steps },
    templates: TEMPLATES, generalDefault: 'organizing-a', moveDefault: null,
    actions, sendConfig: { ratePerHour: '95', ownerBookingLink: 'x', locationCalendarLink: 'y' },
    followupsOff: !!over.followupsOff,
  }
  await act(async () => { root.render(<EmailsList {...props} />) })
  return actions
}
// Each rendered row's text, keyed by its subject.
const rowFor = (subject: string) =>
  Array.from(container.querySelectorAll('b')).find(b => b.textContent === subject)!
    .closest('div[style*="border-radius: 11px"]') as HTMLElement
const buttonsIn = (el: HTMLElement) => Array.from(el.querySelectorAll('button')).map(b => b.textContent)

describe('Remove, per email', () => {
  it('step 1 has no Remove and says why in one line; steps 2+ have Remove', async () => {
    await mountList()
    const first = rowFor('Subject 1')
    expect(buttonsIn(first)).not.toContain('Remove')
    expect(first.textContent).toContain(FIRST_EMAIL_ALWAYS_SENDS_NOTE)
    expect(buttonsIn(rowFor('Subject 2'))).toContain('Remove')
    expect(buttonsIn(rowFor('Subject 3'))).toContain('Remove')
  })

  it('the welcome and the after-job emails never get Remove', async () => {
    await mountList()
    for (const subj of ['Welcome!', '3mo', '12mo']) expect(buttonsIn(rowFor(subj))).not.toContain('Remove')
  })

  it('rowCanBeRemoved: sequence emails after the first only', () => {
    expect(rowCanBeRemoved({ rail: 'drip', order: 1 })).toBe(false)
    expect(rowCanBeRemoved({ rail: 'drip', order: 2 })).toBe(true)
    expect(rowCanBeRemoved({ rail: 'welcome', order: 2 })).toBe(false)
  })

  it('a removed email stays listed, says so, and offers Put back', async () => {
    const actions = await mountList({ steps: [step(1), step(2, { isActive: false }), step(3)] })
    const r = rowFor('Subject 2')
    expect(r.textContent).toContain('Removed')
    expect(r.textContent).toContain('won’t send')
    expect(buttonsIn(r)).toContain('Put back')
    expect(buttonsIn(r)).not.toContain('Remove')
    await act(async () => { Array.from(r.querySelectorAll('button')).find(b => b.textContent === 'Put back')!.click() })
    expect(actions.restore).toHaveBeenCalledWith(expect.objectContaining({ order: 2 }))
  })

  it('Remove hands the row to the action', async () => {
    const actions = await mountList()
    const r = rowFor('Subject 3')
    await act(async () => { Array.from(r.querySelectorAll('button')).find(b => b.textContent === 'Remove')!.click() })
    expect(actions.remove).toHaveBeenCalledWith(expect.objectContaining({ order: 3, rail: 'drip' }))
  })
})

describe('the list with the switch off', () => {
  it('every email after the first reads as not sending; step 1 and the welcome do not', async () => {
    await mountList({ followupsOff: true })
    expect(rowFor('Subject 2').textContent).toContain(FOLLOWUPS_OFF_ROW_REASON)
    expect(rowFor('Subject 3').textContent).toContain(FOLLOWUPS_OFF_ROW_REASON)
    expect(rowFor('Subject 1').textContent).not.toContain(FOLLOWUPS_OFF_ROW_REASON)
    expect(rowFor('Welcome!').textContent).not.toContain(FOLLOWUPS_OFF_ROW_REASON)
  })
})

describe('FollowupsSwitch', () => {
  const mountSwitch = async (state: any) => {
    const onSetOff = vi.fn(async () => undefined)
    await act(async () => { root.render(<FollowupsSwitch state={state} onSetOff={onSetOff} />) })
    return onSetOff
  }
  const click = async (label: string) => {
    const b = Array.from(container.querySelectorAll('button')).find(x => x.textContent === label)!
    await act(async () => { b.click() })
  }

  it('switching off is confirmed first, quoting how many it stops and that they will not resume', async () => {
    const onSetOff = await mountSwitch({ off: false, inFlight: 12, busy: false, err: '' })
    expect(container.textContent).toContain('The first email and the welcome always go')
    await click('Switch off emails after the first one')
    expect(onSetOff).not.toHaveBeenCalled()
    expect(container.textContent).toContain('12 people')
    expect(container.textContent).toContain('stop where they are')
    expect(container.textContent).toContain('Anyone stopped now won’t pick up again.')
    await click('Switch them off')
    expect(onSetOff).toHaveBeenCalledWith(true)
  })

  it('when off, it says nobody resumes, and turning back on needs no confirm', async () => {
    const onSetOff = await mountSwitch({ off: true, inFlight: 0, busy: false, err: '' })
    expect(container.textContent).toContain('anyone already stopped stays stopped')
    await click('Turn them back on')
    expect(onSetOff).toHaveBeenCalledWith(false)
  })
})
