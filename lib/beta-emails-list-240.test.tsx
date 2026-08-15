// @vitest-environment happy-dom
//
// Issue 240 step 7 — the read-only Emails list.
//
// Six rows a client experiences as one sequence, which the database keeps in
// three unrelated shapes. The builder is pure so the unification can be tested
// without mounting, and the seams are asserted rather than assumed:
//
//   RAIL A  drip steps   delay_days is a real per-location COLUMN
//   RAIL B  welcome      24h, a CONSTANT in lib/welcome-email.ts
//   RAIL C  closed job   [90, 365], CONSTANTS in lib/stage-emails.ts
//
// Pinned:
//   1) all six rows, in order, across the two groups
//   2) the groups are never interleaved — they are measured from different
//      moments, so one sorted axis across all six would be a lie
//   3) rail A resolves inline-first, mirroring lib/drip-send.ts
//   4) fork resolution matches the server rule, and marks "Your wording"
//   5) Read opens the full body; Previous/Next stops at both ends
//   6) NO write path exists from this component
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { buildEmailList, EmailsList } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Master steps as masterStepsToUi produces them: inline copy, fromMaster set.
const masterSteps = [
  { id:'master_organizing-a_1', order:1, type:'email', delay_days:0,
    subject:'Thank you for reaching out!', body:'{{first_name}},\n\nHello, and thank you so much for reaching out.', fromMaster:true },
  { id:'master_organizing-a_2', order:2, type:'email', delay_days:5,
    subject:'Following up on your project', body:'Hi {{first_name}},\n\nWe would be honored to support you.', fromMaster:true },
  { id:'master_organizing-a_3', order:3, type:'email', delay_days:30,
    subject:'Still interested?', body:'{{first_name}},\n\nStill interested in the benefits of organization?', fromMaster:true },
]

const tpl = (o: any) => ({
  dbId:o.dbId, legacyId:o.legacyId ?? null, name:o.name ?? '', type:'email',
  subject:o.subject, body:o.body, isActive:o.isActive !== false,
  isMaster:!!o.isMaster, isOwnCustom:!!o.isOwnCustom,
  clonedFromId:o.clonedFromId ?? null, updatedAt:o.updatedAt ?? '2026-01-01',
})

const templates = [
  tpl({ dbId:'t-welcome', legacyId:'welcome', isMaster:true,
        subject:'Welcome to the Bee Organized Hive!', body:'Welcome to the Hive!\n\nWe are excited to connect.' }),
  tpl({ dbId:'t-3mo', legacyId:'opp_closed_job_3mo', isMaster:true,
        subject:"We hope you're still loving your space!", body:'{{first_name}},\n\nWe hope you are still thrilled.' }),
  tpl({ dbId:'t-12mo', legacyId:'opp_closed_job_12mo', isMaster:true,
        subject:"It's been a year", body:'{{first_name}},\n\nIt has been about a year.' }),
]

const build = (over: any = {}) => buildEmailList({
  pathSteps: { 'organizing-a': masterSteps },
  templates, pathKey:'organizing-a', ...over,
})

describe('the six rows unify across three rails', () => {
  it('group one is the drip steps plus the welcome, in send order', () => {
    const { newLead } = build()
    expect(newLead.map(r => r.when)).toEqual(['Right away', 'Next day', 'Day 5', 'Day 30'])
    expect(newLead.map(r => r.rail)).toEqual(['drip', 'welcome', 'drip', 'drip'])
  })

  it('group two is the closed-job pair', () => {
    const { afterJob } = build()
    expect(afterJob.map(r => r.when)).toEqual(['3 months later', 'A year later'])
    expect(afterJob.map(r => r.rail)).toEqual(['stage', 'stage'])
  })

  it('six rows in total, and the groups stay separate', () => {
    const { newLead, afterJob } = build()
    expect(newLead.length + afterJob.length).toBe(6)
    // Interleaving would claim day 90 follows day 30 on one timeline. It does
    // not — group two is counted from the job closing, group one from intake.
    expect(newLead.some(r => r.rail === 'stage')).toBe(false)
    expect(afterJob.some(r => r.rail === 'drip')).toBe(false)
  })

  it('marks which timings are data and which are constants', () => {
    const { newLead, afterJob } = build()
    expect(newLead.filter(r => r.timingIsData).map(r => r.when)).toEqual(['Right away', 'Day 5', 'Day 30'])
    // The welcome and both closed-job rows are code constants.
    expect(newLead.find(r => r.rail === 'welcome')!.timingIsData).toBe(false)
    expect(afterJob.every(r => r.timingIsData === false)).toBe(true)
  })

  it('every row supplies a first line taken past the greeting', () => {
    const { newLead, afterJob } = build()
    for (const r of [...newLead, ...afterJob]) {
      expect(r.firstLine, `${r.key} first line`).toBeTruthy()
      expect(r.firstLine).not.toBe('{{first_name}},')
    }
  })
})

describe('rail A resolves content the way the sender does', () => {
  it('inline step text wins over the linked template', () => {
    const steps = [{ id:'s', dbId:'db1', order:1, type:'email', delay_days:0,
      subject:'Inline subject', body:'Inline body\n\nSecond line.',
      masterTemplateId:'t-other' }]
    const withTpl = [...templates, tpl({ dbId:'t-other', legacyId:'other', isMaster:true,
      subject:'Template subject', body:'Template body' })]
    const { newLead } = buildEmailList({ pathSteps:{ p:steps }, templates:withTpl, pathKey:'p' })
    expect(newLead[0].subject).toBe('Inline subject')
  })

  it('falls back to the linked template when the step has none', () => {
    // The drip-paths route selects the joined template's subject/body but
    // flattens only name + legacy_id, so a template-backed step arrives with
    // null content and MUST be resolved against the templates array.
    const steps = [{ id:'s', dbId:'db1', order:1, type:'email', delay_days:0,
      subject:null, body:null, masterTemplateId:'t-other' }]
    const withTpl = [...templates, tpl({ dbId:'t-other', legacyId:'other', isMaster:true,
      subject:'Template subject', body:'Template body\n\nSecond line.' })]
    const { newLead } = buildEmailList({ pathSteps:{ p:steps }, templates:withTpl, pathKey:'p' })
    expect(newLead[0].subject).toBe('Template subject')
    expect(newLead[0].contentMissing).toBe(false)
  })

  it('says so rather than faking it when nothing resolves', () => {
    const steps = [{ id:'s', dbId:'db1', order:1, type:'email', delay_days:0,
      subject:null, body:null, masterTemplateId:'t-missing' }]
    const { newLead } = buildEmailList({ pathSteps:{ p:steps }, templates, pathKey:'p' })
    expect(newLead[0].contentMissing).toBe(true)
  })

  it('does not hide a quarantined template — the sender still resolves it', () => {
    const steps = [{ id:'s', dbId:'db1', order:1, type:'email', delay_days:0,
      subject:null, body:null, masterTemplateId:'t-dead' }]
    const withTpl = [...templates, tpl({ dbId:'t-dead', legacyId:'dead', isMaster:true,
      isActive:false, subject:'Quarantined subject', body:'Body\n\nSecond.' })]
    const { newLead } = buildEmailList({ pathSteps:{ p:steps }, templates:withTpl, pathKey:'p' })
    expect(newLead[0].subject).toBe('Quarantined subject')
  })

  it('non-email steps are not listed', () => {
    const steps = [...masterSteps, { id:'sms', order:4, type:'sms', delay_days:2, subject:'A text', body:'x', fromMaster:true }]
    const { newLead } = buildEmailList({ pathSteps:{ p:steps }, templates, pathKey:'p' })
    expect(newLead.some(r => r.subject === 'A text')).toBe(false)
  })
})

describe('fork resolution matches the server rule', () => {
  it('a location fork wins and is labelled Your wording', () => {
    const withFork = [...templates, tpl({ dbId:'f1', legacyId:null, isOwnCustom:true,
      clonedFromId:'t-welcome', subject:'Our own welcome', body:'Ours\n\nSecond line.' })]
    const { newLead } = build({ templates: withFork })
    const w = newLead.find(r => r.rail === 'welcome')!
    expect(w.subject).toBe('Our own welcome')
    expect(w.wording).toBe('yours')
  })

  it('an inactive fork is ignored, exactly as the sender ignores it', () => {
    const withFork = [...templates, tpl({ dbId:'f1', legacyId:null, isOwnCustom:true,
      isActive:false, clonedFromId:'t-welcome', subject:'Stale', body:'x' })]
    const { newLead } = build({ templates: withFork })
    expect(newLead.find(r => r.rail === 'welcome')!.subject).toBe('Welcome to the Bee Organized Hive!')
  })

  it('the most recently updated fork wins', () => {
    const withForks = [...templates,
      tpl({ dbId:'f1', isOwnCustom:true, clonedFromId:'t-welcome', subject:'Older', body:'a\n\nb', updatedAt:'2026-01-01' }),
      tpl({ dbId:'f2', isOwnCustom:true, clonedFromId:'t-welcome', subject:'Newer', body:'a\n\nb', updatedAt:'2026-06-01' })]
    const { newLead } = build({ templates: withForks })
    expect(newLead.find(r => r.rail === 'welcome')!.subject).toBe('Newer')
  })

  it('master-backed drip steps read as Bee Organized wording', () => {
    // fromMaster, not "carries inline text" — master steps carry inline text
    // too, so the naive test would mark every row as edited.
    const { newLead } = build()
    expect(newLead.filter(r => r.rail === 'drip').every(r => r.wording === 'master')).toBe(true)
  })

  it('a location-owned step reads as Your wording', () => {
    const own = [{ id:'db_1', dbId:'db1', order:1, type:'email', delay_days:0,
      subject:'Ours', body:'Ours\n\nSecond.' }]
    const { newLead } = buildEmailList({ pathSteps:{ p:own }, templates, pathKey:'p' })
    expect(newLead[0].wording).toBe('yours')
  })
})

describe('the list renders and Read works', () => {
  let container: HTMLElement
  let root: ReturnType<typeof createRoot>
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const mount = async () => {
    await act(async () => {
      root.render(<EmailsList pathSteps={{ 'organizing-a': masterSteps }} templates={templates}
        generalDefault="organizing-a" moveDefault="organizing-a" />)
    })
    return container
  }
  const readButtons = () =>
    Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Read')

  it('renders both group headings and all six Read buttons', async () => {
    await mount()
    expect(container.textContent).toContain('When someone new gets in touch')
    expect(container.textContent).toContain('After a job is finished')
    expect(readButtons().length).toBe(6)
  })

  it('shows no editing affordance anywhere', async () => {
    await mount()
    const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent ?? '')
    for (const banned of ['Edit', 'Duplicate', 'Customize', 'Save', 'Use a different one', 'Add another email']) {
      expect(labels, `must not offer "${banned}"`).not.toContain(banned)
    }
    expect(container.querySelectorAll('input, textarea, select').length).toBe(0)
  })

  it('Read opens the full body, not the truncated first line', async () => {
    await mount()
    await act(async () => { readButtons()[0].click() })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Hello, and thank you so much for reaching out')
    expect(dialog.textContent).toContain('1 of 4')
  })

  it('Previous is dead on the first row and Next on the last', async () => {
    await mount()
    await act(async () => { readButtons()[0].click() })
    const prev = () => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Previous')) as HTMLButtonElement
    const next = () => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Next')) as HTMLButtonElement
    expect(prev().disabled).toBe(true)
    for (let i = 0; i < 3; i++) await act(async () => { next().click() })
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('4 of 4')
    expect(next().disabled).toBe(true)
    // Clicking a dead Next must not wrap around.
    await act(async () => { next().click() })
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('4 of 4')
  })

  it('navigates only within its own group', async () => {
    await mount()
    await act(async () => { readButtons()[4].click() })  // first closed-job row
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('1 of 2')
  })
})

describe('no write path exists from this component', () => {
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
  const slice = beehub.slice(
    beehub.indexOf('function EmailReadModal('),
    beehub.indexOf('export function TextsComingSoon('))

  it('the list and modal never fetch, and never mutate', () => {
    expect(slice.length).toBeGreaterThan(500)
    expect(slice).not.toContain('fetch(')
    for (const verb of ["method:'POST'", "method:'PATCH'", "method:'DELETE'", "method: 'POST'"]) {
      expect(slice, `must not ${verb}`).not.toContain(verb)
    }
    expect(slice).not.toContain('setSettings')
    expect(slice).not.toContain('commitSteps')
  })
})
