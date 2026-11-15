import { describe, expect, it } from 'vitest'
import { changeEvents, contactHistory } from './history'
import { sampleContact } from './testing'
import { withTypes } from './types'

describe('Follow-up history', () => {
  it('records a saved follow-up date in the contact timeline', () => {
    const prev = sampleContact({ nextFollowUp: undefined, history: [] })
    const next = { ...prev, nextFollowUp: '2026-11-20' }
    const events = changeEvents(prev, next, '2026-11-14')
    expect(events).toContainEqual({ kind: 'followup', when: '2026-11-14', text: 'Follow-up set for 2026-11-20' })
    expect(contactHistory({ ...next, history: events })).toContainEqual(events[0])
  })
  it('records removal without retaining the scheduled date', () => {
    const p = sampleContact()
    expect(changeEvents({ ...p, nextFollowUp: '2026-11-20' }, { ...p, nextFollowUp: undefined }))
      .toContainEqual({ kind: 'followup', when: 'Today', text: 'Follow-up cleared' })
  })
})

describe('What changed, in plain words', () => {
  const p = sampleContact({ types: ['partner'], level: 'referral', stage: 'New Contact', tags: ['Realtor'] })
  const texts = (next: typeof p) => changeEvents(p, next).map((e) => e.text)

  it('says nothing when nothing changed', () => {
    expect(changeEvents(p, { ...p })).toEqual([])
  })
  it('names tags added and removed', () => {
    expect(texts({ ...p, tags: ['Friend', 'Mover'] })).toEqual(['Added tags Friend, Mover', 'Removed tag Realtor'])
  })
  it('names the new level', () => {
    expect(texts({ ...p, level: 'power' })).toEqual(['Level set to Power Partner'])
  })
  it('names the new stage', () => {
    expect(texts({ ...p, stage: 'Gone quiet' })).toEqual(['Moved to Gone quiet'])
  })
  it('records a type change, and that the level went with it', () => {
    expect(texts(withTypes(p, ['vendor']))).toEqual(['Changed contact type', 'Partner level cleared'])
  })
  it('records a new Referral partner starting at Potential and New Contact', () => {
    const vendor = sampleContact({ types: ['vendor'], level: undefined, stage: undefined })
    expect(changeEvents(vendor, withTypes(vendor, ['vendor', 'partner'])).map((e) => e.text))
      .toEqual(['Changed contact type', 'Level set to Potential', 'Moved to New Contact'])
  })
  it('ignores a level stored on someone who is not a Referral partner', () => {
    const vendor = sampleContact({ types: ['vendor'], level: undefined, stage: undefined })
    expect(changeEvents(vendor, { ...vendor, level: 'power', stage: 'Active Partner' })).toEqual([])
  })
  it('records drip, Mailchimp, phone, email and birthday changes', () => {
    expect(texts({
      ...p, drip: 'Moving soon', mailchimp: { on: true }, phone: undefined, email: 'new@example.com',
      birthday: 'Mar 22', birthdayReminder: true,
    })).toEqual([
      'Enrolled in drip “Moving soon”', 'Added to Mailchimp', 'Removed phone number', 'Updated email address',
      'Birthday set for Mar 22', 'Marked for birthday reminder',
    ])
  })
})

describe('The whole timeline', () => {
  it('lists notes, changes, touchpoints, referrals and how you met', () => {
    const c = sampleContact({
      notes: [{ text: 'Loves the pantry photos', at: '2026-11-01', title: 'Coffee' }],
      history: [{ kind: 'partner', when: '2026-10-01', text: 'Moved to Active Partner' }],
      touchpoints: [{ kind: 'Call', when: 'Sep 14', note: 'Spring listings' }, { kind: 'Text', when: 'Sep 20' }],
      referred: 2, converted: 1, revenue: 1900, howMet: 'Chamber breakfast',
    })
    expect(contactHistory(c)).toEqual([
      { kind: 'note', when: '2026-11-01', text: 'Coffee: Loves the pantry photos' },
      { kind: 'partner', when: '2026-10-01', text: 'Moved to Active Partner' },
      { kind: 'touchpoint', when: 'Sep 14', text: 'Call — Spring listings' },
      { kind: 'touchpoint', when: 'Sep 20', text: 'Text' },
      { kind: 'referral', when: 'All time', text: 'Sent 2 referrals, 1 became jobs ($1,900)' },
      { kind: 'created', when: 'Start', text: 'How you met: Chamber breakfast' },
    ])
  })
  it('leaves out the referral line for someone who has sent nobody', () => {
    expect(contactHistory(sampleContact({ howMet: undefined }))).toEqual([])
  })
})
