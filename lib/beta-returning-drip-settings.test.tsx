// @vitest-environment happy-dom
//
// The returning-client sequence — where it lives in Settings › Emails.
//
// A third group, "When a past client gets back in touch", between the
// new-lead sequence and the closed-job pair. Same row shape and controls as
// group one (Read / Edit / Reset / timing / paused reason), keyed on the fixed
// path 'returning' rather than the location's default, and hidden until the
// master path is seeded so the list never promises emails that do not exist.
//
// Pinned:
//   1) buildEmailList returns the group from pathSteps['returning'], sorted by
//      day, rows carrying pathKey 'returning' (what Edit / timing act on)
//   2) group one and the closed-job pair are unchanged by its presence
//   3) EmailsList renders the heading and its Read buttons when steps exist,
//      and renders nothing for it when they do not
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { buildEmailList, EmailsList, RETURNING_EMAILS_PATH_KEY } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const organizingSteps = [
  { id:'master_organizing-b_1', order:1, type:'email', delay_days:0,
    subject:'Thank you for reaching out!', body:'Hello {{first_name}},\n\nThank you so much for reaching out.', fromMaster:true },
  { id:'master_organizing-b_2', order:2, type:'email', delay_days:5,
    subject:'Following up on your project', body:'Hi {{first_name}},\n\nWe would be honored to support you.', fromMaster:true },
  { id:'master_organizing-b_3', order:3, type:'email', delay_days:30,
    subject:'Still interested?', body:'{{first_name}},\n\nStill interested?', fromMaster:true },
]
const returningSteps = [
  { id:'master_returning_1', order:1, type:'email', delay_days:0,
    subject:'Good to hear from you again', body:'Hi {{first_name}},\n\nThanks for getting back in touch.', fromMaster:true },
  { id:'master_returning_2', order:2, type:'email', delay_days:3,
    subject:"Still here when you're ready", body:"Hi {{first_name}},\n\nJust making sure this didn't get buried.", fromMaster:true },
  { id:'master_returning_3', order:3, type:'email', delay_days:10,
    subject:'One more from us', body:"Hi {{first_name}},\n\nThis is the last you'll hear from us on this one.", fromMaster:true },
]
const tpl = (o: any) => ({
  dbId:o.dbId, legacyId:o.legacyId ?? null, name:o.name ?? '', type:'email',
  subject:o.subject, body:o.body, isActive:true, isMaster:true, isOwnCustom:false,
  clonedFromId:null, updatedAt:'2026-01-01',
})
const templates = [
  tpl({ dbId:'t-3mo', legacyId:'opp_closed_job_3mo', subject:"We hope you're still loving your space!", body:'{{first_name}},\n\nStill thrilled?' }),
  tpl({ dbId:'t-12mo', legacyId:'opp_closed_job_12mo', subject:"It's been a year", body:'{{first_name}},\n\nA year already.' }),
]

describe('1) the builder returns the past-client group', () => {
  it('three rows, by day, on the fixed path key', () => {
    const { returning } = buildEmailList({
      pathSteps: { 'organizing-b': organizingSteps, [RETURNING_EMAILS_PATH_KEY]: returningSteps },
      templates, pathKey: 'organizing-b',
    })
    expect(RETURNING_EMAILS_PATH_KEY).toBe('returning')
    expect(returning.map(r => r.when)).toEqual(['Right away', 'Day 3', 'Day 10'])
    expect(returning.map(r => r.subject)).toEqual([
      'Good to hear from you again', "Still here when you're ready", 'One more from us',
    ])
    expect(returning.every(r => r.rail === 'drip' && r.pathKey === 'returning' && r.timingIsData)).toBe(true)
    expect(returning.every(r => r.wording === 'master')).toBe(true)
    // Each row has a first line past the greeting, like every other row.
    for (const r of returning) expect(r.firstLine).not.toMatch(/^Hi \{\{first_name\}\}/)
  })

  it('is empty (not missing) until the master path is seeded', () => {
    const { returning } = buildEmailList({ pathSteps: { 'organizing-b': organizingSteps }, templates, pathKey: 'organizing-b' })
    expect(returning).toEqual([])
  })

  it('a location copy of the returning path reads as Your wording', () => {
    const own = [{ id:'db_9', dbId:'db9', order:1, type:'email', delay_days:0, subject:'Ours', body:'Ours\n\nSecond.' }]
    const { returning } = buildEmailList({ pathSteps: { [RETURNING_EMAILS_PATH_KEY]: own }, templates, pathKey: 'organizing-b' })
    expect(returning[0].wording).toBe('yours')
    expect(returning[0].pathKey).toBe('returning')
  })
})

describe('2) the other groups are unchanged by it', () => {
  it('group one still reads the default path only; the closed-job pair is untouched', () => {
    const { newLead, afterJob } = buildEmailList({
      pathSteps: { 'organizing-b': organizingSteps, [RETURNING_EMAILS_PATH_KEY]: returningSteps },
      templates, pathKey: 'organizing-b',
    })
    expect(newLead.map(r => r.when)).toEqual(['Right away', 'Day 5', 'Day 30'])
    expect(newLead.every(r => r.pathKey === 'organizing-b')).toBe(true)
    expect(newLead.some(r => r.subject === 'Good to hear from you again')).toBe(false)
    expect(afterJob.map(r => r.when)).toEqual(['3 months later', 'A year later'])
  })
})

describe('3) the list renders the group', () => {
  let container: HTMLElement
  let root: ReturnType<typeof createRoot>
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const mount = async (pathSteps: any) => {
    await act(async () => {
      root.render(<EmailsList pathSteps={pathSteps} templates={templates}
        generalDefault="organizing-b" moveDefault="organizing-b" />)
    })
    return container
  }
  const readButtons = () => Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Read')

  it('with the master seeded: the heading, its note, and eight Read buttons in all', async () => {
    await mount({ 'organizing-b': organizingSteps, [RETURNING_EMAILS_PATH_KEY]: returningSteps })
    expect(container.textContent).toContain('When a past client gets back in touch')
    expect(container.textContent).toContain('Stops the moment you log a reach-out')
    expect(container.textContent).toContain('Good to hear from you again')
    expect(readButtons()).toHaveLength(3 + 3 + 2)
    // Order on the page: new lead, past client, after a job.
    const t = container.textContent || ''
    expect(t.indexOf('When someone new gets in touch')).toBeLessThan(t.indexOf('When a past client gets back in touch'))
    expect(t.indexOf('When a past client gets back in touch')).toBeLessThan(t.indexOf('After a job is finished'))
  })

  it('before the master is seeded: no heading, no empty-group placeholder, five Read buttons as today', async () => {
    await mount({ 'organizing-b': organizingSteps })
    expect(container.textContent).not.toContain('When a past client gets back in touch')
    expect(readButtons()).toHaveLength(5)
  })
})
