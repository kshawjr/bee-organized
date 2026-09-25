// @vitest-environment happy-dom
//
// WHAT'S NEW — THE DRAFT SAYS TODAY'S DATE; A PUBLISHED WEEK SAYS THE DAY IT WENT OUT.
//
// Kevin opened Help → What's new on Friday 25 September and the draft read
// "This week · ending Thu, Oct 1" — correct (weeks run Friday to Thursday)
// and wrong to read: nobody pictures "this week" ending seven days out. He
// runs the note when he likes, so the draft is labelled with the day.
//
//   · the draft header shows today's date, in the app's existing format
//   · the roll-forward is untouched — a stale draft still moves to the
//     current week, and its week_start/publish_on are what they were
//   · a published release's card says the day it was PUBLISHED — Kevin put
//     one out on Fri 25 Sep and it read "Week ending Thu, Oct 1". Its
//     week_label and the Slack header still carry the week (labels only).
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import WhatsNew from '@/components/help/WhatsNew'
import {
  draftDateLabel, publishedDateLabel, draftWeekCorrection, formatWeekLabel, weekFor, shapeRelease, buildWaggleMessage,
} from '@/lib/help-releases'

// Friday 25 Sep 2026, midday in New York.
const FRI = new Date('2026-09-25T16:00:00Z')

const line = (over: any) => ({ id: 'x', release_id: 'r', group: 'fixed', title: 'Line', body: 'One sentence.', edited_at: '2026-09-01T00:00:00Z', unedited: false, ...over })
const PUB = {
  id: 'r-pub', week_start: '2026-09-18', publish_on: '2026-09-24', status: 'published', summary: null, published_at: '2026-09-24T20:00:00Z', week_label: 'Thu, Sep 24',
  groups: { new: [], changed: [], fixed: [line({ id: 'p1', release_id: 'r-pub' })], question: [] }, item_count: 1, unedited_count: 0,
}
// The draft exactly as the GET route hands it over on 25 Sep: already rolled
// into the Fri 25 Sep → Thu 1 Oct week.
// Kevin's own case: the Fri 25 Sep → Thu 1 Oct week, published on its FIRST
// day, Friday 25 Sep at 10am New York — six days before its week ends.
const EARLY = {
  id: 'r-early', week_start: '2026-09-25', publish_on: '2026-10-01', status: 'published', summary: null, published_at: '2026-09-25T14:00:00Z', week_label: 'Thu, Oct 1',
  groups: { new: [], changed: [], fixed: [line({ id: 'e1', release_id: 'r-early' })], question: [] }, item_count: 1, unedited_count: 0,
}
const DRAFT = {
  id: 'r-draft', week_start: '2026-09-25', publish_on: '2026-10-01', status: 'draft', summary: null, published_at: null, week_label: 'Thu, Oct 1',
  groups: { new: [], changed: [], fixed: [line({ id: 'd1', release_id: 'r-draft' })], question: [] }, item_count: 1, unedited_count: 0,
}

function stubFetch(payload: any) {
  ;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as any)
}
async function mount(el: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(el) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('draftDateLabel — today, in the format the tab already uses', () => {
  it('Friday 25 September reads "Fri, Sep 25"', () => {
    expect(draftDateLabel(FRI)).toBe('Fri, Sep 25')
  })

  it('is the same format as the published weeks ("Thu, Sep 24"), just today\'s date', () => {
    expect(draftDateLabel(new Date('2026-09-24T16:00:00Z'))).toBe(formatWeekLabel('2026-09-24'))
  })

  it('counts the day in New York, like the week does — 11pm Friday is still Friday', () => {
    expect(draftDateLabel(new Date('2026-09-26T03:00:00Z'))).toBe('Fri, Sep 25')
  })
})

describe('the draft header', () => {
  it('shows today\'s date, not the Thursday the week ends on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FRI)
    stubFetch({ releases: [PUB], draft: DRAFT, canEdit: true })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    const h = host.querySelector('[data-whatsnew-draft] h2')
    expect(h?.textContent).toBe('Fri, Sep 25')
    expect(host.textContent).not.toContain('ending Thu, Oct 1')
    await unmount()
  })

})

describe('a published release says the day it was published', () => {
  it('publishedDateLabel reads published_at, in the draft\'s format and New York\'s day', () => {
    expect(publishedDateLabel('2026-09-25T14:00:00Z')).toBe('Fri, Sep 25')
    // 11:30pm Friday in New York is already Saturday in UTC — still Friday.
    expect(publishedDateLabel('2026-09-26T03:30:00Z')).toBe('Fri, Sep 25')
    expect(publishedDateLabel('2026-09-25T14:00:00Z')).toBe(draftDateLabel(new Date('2026-09-25T14:00:00Z')))
    expect(publishedDateLabel(null)).toBe('')
    expect(publishedDateLabel('not a date')).toBe('')
  })

  it('the card shows "Published Thu, Sep 24"', async () => {
    stubFetch({ releases: [PUB], draft: null, canEdit: false })
    const { host, unmount } = await mount(<WhatsNew />)
    expect(host.querySelector('[data-whatsnew-release="r-pub"] h2')?.textContent).toBe('Published Thu, Sep 24')
    await unmount()
  })

  it('published on a different day than its week ends: the PUBLISH date, never the week', async () => {
    stubFetch({ releases: [EARLY], draft: null, canEdit: false })
    const { host, unmount } = await mount(<WhatsNew />)
    const h = host.querySelector('[data-whatsnew-release="r-early"] h2')?.textContent
    expect(h).toBe('Published Fri, Sep 25')
    expect(h).not.toContain('Oct 1')
    expect(host.textContent).not.toContain('Week ending')
    await unmount()
  })

  it('a row with no usable published_at still says its week rather than going blank', async () => {
    stubFetch({ releases: [{ ...PUB, published_at: null }], draft: null, canEdit: false })
    const { host, unmount } = await mount(<WhatsNew />)
    expect(host.querySelector('[data-whatsnew-release="r-pub"] h2')?.textContent).toBe('Week ending Thu, Sep 24')
    await unmount()
  })

  it('the draft still shows today\'s date beside a published card', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-28T16:00:00Z')) // Mon 28 Sep
    stubFetch({ releases: [EARLY], draft: { ...DRAFT, week_start: '2026-10-02', publish_on: '2026-10-08', week_label: 'Thu, Oct 8' }, canEdit: true })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    expect(host.querySelector('[data-whatsnew-draft] h2')?.textContent).toBe('Mon, Sep 28')
    expect(host.querySelector('[data-whatsnew-release="r-early"] h2')?.textContent).toBe('Published Fri, Sep 25')
    await unmount()
  })
})

describe('the week underneath is unchanged — this is a label', () => {
  it('a stale draft still rolls to the current week on 25 Sep', () => {
    const stale = { status: 'draft', publish_on: '2026-09-17' } as any
    expect(draftWeekCorrection(stale, FRI)).toEqual({ week_start: '2026-09-25', publish_on: '2026-10-01' })
    expect(weekFor(FRI)).toEqual({ week_start: '2026-09-25', publish_on: '2026-10-01' })
  })

  it('the shaped draft still carries its week_label from publish_on — the API did not change', () => {
    const shaped = shapeRelease({ ...DRAFT, groups: undefined } as any, [], { forOwner: false })
    expect(shaped.publish_on).toBe('2026-10-01')
    expect(shaped.week_label).toBe('Thu, Oct 1')
  })

  it('the week stays in the data: EARLY is still the 25 Sep → 1 Oct week', () => {
    const shaped = shapeRelease({ ...EARLY, groups: undefined } as any, [], { forOwner: true })
    expect(shaped.week_start).toBe('2026-09-25')
    expect(shaped.publish_on).toBe('2026-10-01')
    expect(shaped.week_label).toBe('Thu, Oct 1')
    expect(shaped.published_at).toBe('2026-09-25T14:00:00Z') // owners get it — the card needs it
  })

  it('a published release\'s week_label and Slack header still say its week', () => {
    const pub = { id: 'r-pub', week_start: '2026-09-18', publish_on: '2026-09-24', status: 'published', summary: null } as any
    expect(shapeRelease(pub, [], { forOwner: true }).week_label).toBe('Thu, Sep 24')
    const built = buildWaggleMessage(pub, [line({ id: 'p1', release_id: 'r-pub' })] as any)
    expect(built.text.split('\n')[0]).toBe('🐝 *The Waggle* · week ending Thu, Sep 24')
  })
})
