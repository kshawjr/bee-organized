// @vitest-environment happy-dom
//
// The returning-client sequence — where it lives in Settings › Emails.
//
// A third group, "When a past client gets back in touch", between the
// new-lead sequence and the closed-job pair. Same row shape and controls as
// group one (Read / Edit / Reset / timing / paused reason). It shows the
// VARIANT that matches the location's two answers — the letter of the
// organizing default, returning-a..d — exactly as group one shows the
// organizing variant, and it is hidden until that master is seeded so the
// list never promises emails that do not exist.
//
// Pinned:
//   1) buildEmailList returns the group from pathSteps[returningPathKey],
//      sorted by day, rows carrying that path key (what Edit / timing act on)
//   2) group one and the closed-job pair are unchanged by its presence
//   3) EmailsList picks the variant from generalDefault — an owner on
//      organizing-c sees returning-c (no rate, no booking link, so no Paused
//      chip), and a seeded -b is NOT shown to them
//   4) nothing seeded for that variant → no heading at all
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { buildEmailList, EmailsList } from '@/components/BeeHub'
import { returningPathKeyFor } from '@/components/hive/shared/returningVariant'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const organizingSteps = [
  { id:'master_organizing-c_1', order:1, type:'email', delay_days:0,
    subject:'Thank you for reaching out!', body:'Hello {{first_name}},\n\nThank you so much for reaching out.', fromMaster:true },
  { id:'master_organizing-c_2', order:2, type:'email', delay_days:5,
    subject:'Following up on your project', body:'Hi {{first_name}},\n\nWe would be honored to support you.', fromMaster:true },
  { id:'master_organizing-c_3', order:3, type:'email', delay_days:30,
    subject:'Still interested?', body:'{{first_name}},\n\nStill interested?', fromMaster:true },
]
// returning-c: neither block.
const returningCSteps = [
  { id:'master_returning-c_1', order:1, type:'email', delay_days:0,
    subject:'Good to hear from you again', body:'Hi {{first_name}},\n\nThanks for getting back in touch.', fromMaster:true },
  { id:'master_returning-c_2', order:2, type:'email', delay_days:3,
    subject:"Still here when you're ready", body:"Hi {{first_name}},\n\nJust making sure this didn't get buried.", fromMaster:true },
  { id:'master_returning-c_3', order:3, type:'email', delay_days:10,
    subject:'One more from us', body:"Hi {{first_name}},\n\nThis is the last you'll hear from us on this one.", fromMaster:true },
]
// returning-b: both blocks — what a -c owner must NOT be shown.
const returningBSteps = returningCSteps.map(s => ({
  ...s, id: s.id.replace('-c_', '-b_'),
  body: s.body + '\n\nPlease click HERE ({{book_assessment_link}}) to book. Our rate starts at {{rate_per_hour}} per hour per Bee.',
}))
const tpl = (o: any) => ({
  dbId:o.dbId, legacyId:o.legacyId ?? null, name:o.name ?? '', type:'email',
  subject:o.subject, body:o.body, isActive:true, isMaster:true, isOwnCustom:false,
  clonedFromId:null, updatedAt:'2026-01-01',
})
const templates = [
  tpl({ dbId:'t-3mo', legacyId:'opp_closed_job_3mo', subject:"We hope you're still loving your space!", body:'{{first_name}},\n\nStill thrilled?' }),
  tpl({ dbId:'t-12mo', legacyId:'opp_closed_job_12mo', subject:"It's been a year", body:'{{first_name}},\n\nA year already.' }),
]
const allSteps = { 'organizing-c': organizingSteps, 'returning-c': returningCSteps, 'returning-b': returningBSteps }

describe('1) the builder returns the past-client group for the variant it is given', () => {
  it('three rows, by day, on that path key', () => {
    const { returning } = buildEmailList({ pathSteps: allSteps, templates, pathKey: 'organizing-c', returningPathKey: 'returning-c' })
    expect(returning.map(r => r.when)).toEqual(['Right away', 'Day 3', 'Day 10'])
    expect(returning.map(r => r.subject)).toEqual([
      'Good to hear from you again', "Still here when you're ready", 'One more from us',
    ])
    expect(returning.every(r => r.rail === 'drip' && r.pathKey === 'returning-c' && r.timingIsData)).toBe(true)
    expect(returning.every(r => r.wording === 'master')).toBe(true)
    expect(returning.every(r => !r.body.includes('{{rate_per_hour}}') && !r.body.includes('{{book_assessment_link}}'))).toBe(true)
    for (const r of returning) expect(r.firstLine).not.toMatch(/^Hi \{\{first_name\}\}/)
  })

  it('is empty (not missing) until that variant is seeded', () => {
    const { returning } = buildEmailList({ pathSteps: { 'organizing-c': organizingSteps }, templates, pathKey: 'organizing-c', returningPathKey: 'returning-c' })
    expect(returning).toEqual([])
  })

  it('no variant asked for → empty', () => {
    const { returning } = buildEmailList({ pathSteps: allSteps, templates, pathKey: 'organizing-c' })
    expect(returning).toEqual([])
  })

  it('a location copy of the variant reads as Your wording', () => {
    const own = [{ id:'db_9', dbId:'db9', order:1, type:'email', delay_days:0, subject:'Ours', body:'Ours\n\nSecond.' }]
    const { returning } = buildEmailList({ pathSteps: { 'returning-c': own }, templates, pathKey: 'organizing-c', returningPathKey: 'returning-c' })
    expect(returning[0].wording).toBe('yours')
    expect(returning[0].pathKey).toBe('returning-c')
  })
})

describe('2) the other groups are unchanged by it', () => {
  it('group one still reads the default path only; the closed-job pair is untouched', () => {
    const { newLead, afterJob } = buildEmailList({ pathSteps: allSteps, templates, pathKey: 'organizing-c', returningPathKey: 'returning-c' })
    expect(newLead.map(r => r.when)).toEqual(['Right away', 'Day 5', 'Day 30'])
    expect(newLead.every(r => r.pathKey === 'organizing-c')).toBe(true)
    expect(newLead.some(r => r.subject === 'Good to hear from you again')).toBe(false)
    expect(afterJob.map(r => r.when)).toEqual(['3 months later', 'A year later'])
  })
})

describe('3 + 4) the list picks the variant from the organizing answers', () => {
  let container: HTMLElement
  let root: ReturnType<typeof createRoot>
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const mount = async (pathSteps: any, generalDefault = 'organizing-c', sendConfig: any = {}) => {
    await act(async () => {
      root.render(<EmailsList pathSteps={pathSteps} templates={templates}
        generalDefault={generalDefault} moveDefault={generalDefault} sendConfig={sendConfig} />)
    })
    return container
  }
  const readButtons = () => Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Read')

  it('an owner who answered no / no (organizing-c) sees returning-c: no Paused chip, no "Not sending", even with nothing set', async () => {
    expect(returningPathKeyFor('organizing-c')).toBe('returning-c')
    await mount(allSteps, 'organizing-c', { ratePerHour: '', ownerBookingLink: '', locationCalendarLink: '' })
    expect(container.textContent).toContain('When a past client gets back in touch')
    expect(container.textContent).toContain('Good to hear from you again')
    expect(container.textContent).not.toContain('Paused')
    expect(container.textContent).not.toContain('Not sending')
    expect(container.textContent).not.toContain('per hour per Bee')
    expect(readButtons()).toHaveLength(3 + 3 + 2)
    const t = container.textContent || ''
    expect(t.indexOf('When someone new gets in touch')).toBeLessThan(t.indexOf('When a past client gets back in touch'))
    expect(t.indexOf('When a past client gets back in touch')).toBeLessThan(t.indexOf('After a job is finished'))
  })

  it('the same owner is NOT shown the -b variant even though it is seeded', async () => {
    await mount({ 'organizing-c': organizingSteps, 'returning-b': returningBSteps }, 'organizing-c')
    expect(container.textContent).not.toContain('When a past client gets back in touch')
    expect(readButtons()).toHaveLength(5)
  })

  it('an owner on organizing-b with the rate and link set sees returning-b with no Paused chip', async () => {
    await mount({ 'organizing-b': organizingSteps, 'returning-b': returningBSteps }, 'organizing-b',
      { ratePerHour: '$98.00', ownerBookingLink: '', locationCalendarLink: 'https://calendar.app.google/abc' })
    expect(container.textContent).toContain('When a past client gets back in touch')
    expect(container.textContent).not.toContain('Paused')
  })

  it('an owner on organizing-b who has NOT filled in the link is told so — held is for a blank setting, not a declined one', async () => {
    await mount({ 'organizing-b': organizingSteps, 'returning-b': returningBSteps }, 'organizing-b',
      { ratePerHour: '$98.00', ownerBookingLink: '', locationCalendarLink: '' })
    expect(container.textContent).toContain('Paused')
    expect(container.textContent).toContain('your booking link is empty')
  })
})
