// @vitest-environment happy-dom
//
// issue 233 — the rebuilt Feedback screen, MOUNTED.
//
// The screen was one flat list of everything, sorted by arrival, with
// title-only rows. Sixty-three rows of which thirty-four were already decided;
// every visit began by clicking a status chip. These pin the rebuild:
//
//   - closed items are HIDDEN by default, behind a "Show N closed" toggle
//   - three QUEUE CARDS replace the status chips, and the stale queue exists
//   - the header count equals the cards (the count reconciliation, at the DOM
//     level rather than only in the arithmetic)
//   - rows carry the description, so two reports with the same auto-generated
//     title are distinguishable without opening either
//   - the context pointer renders as "Open the record"
//   - a reply that never moved the status is flagged on the row
//   - search reaches the description
//   - next/previous walks the queue and stops at both ends
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

// Ages are computed off the real clock so no fake timers have to fight React's
// scheduler — the fixture just declares "this was touched N days ago".
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

// Six items: 2 untouched, 2 gone quiet, 1 recently reviewed (the remainder),
// 1 shipped. Every assertion below is hand-derived from THIS shape.
const ITEMS = [
  { id: 'n1', title: 'Snooze Button', description: 'It would help to hide a client for a week.\nRight now they just sit there.', type: 'feature', status: 'submitted', user_id: 'u1', submitter_name: 'Ankur Patel', submitter_email: 'ankur@pb.com', location_id: 'loc-1', location_name: 'Palm Beach', created_at: daysAgo(10), updated_at: daysAgo(10), attachments: [] },
  { id: 'n2', title: 'Client not moving in system correctly', description: 'I put two clients in Closed Lost and they came back to my inbox.', type: 'bug', status: 'submitted', user_id: 'u2', submitter_name: 'Lynette Ewy', submitter_email: 'lynette@kc.com', location_id: 'loc-2', location_name: 'Kansas City', created_at: daysAgo(12), updated_at: daysAgo(12), admin_response: 'You can remove it from the three dots menu.', admin_response_at: daysAgo(12), attachments: [] },
  { id: 's1', title: 'Guide', description: 'The guide does not open from the menu any more.', type: 'bug', status: 'under_review', user_id: 'u1', submitter_name: 'Ankur Patel', submitter_email: 'ankur@pb.com', location_id: 'loc-1', location_name: 'Palm Beach', created_at: daysAgo(58), updated_at: daysAgo(14), admin_response: 'Looking at this.', attachments: [] },
  { id: 's2', title: 'Bulk Update', description: 'Changing twenty clients one at a time takes all morning.', type: 'feature', status: 'planned', user_id: 'u1', submitter_name: 'Ankur Patel', submitter_email: 'ankur@pb.com', location_id: 'loc-1', location_name: 'Palm Beach', created_at: daysAgo(58), updated_at: daysAgo(19), admin_response: 'On the list.', attachments: [] },
  { id: 'h1', title: 'Additional Address', description: 'Some clients have two houses.', type: 'bug', status: 'under_review', user_id: 'u2', submitter_name: 'Linette Voytovich', submitter_email: 'lin@np.com', location_id: 'loc-2', location_name: 'North Pittsburgh', created_at: daysAgo(3), updated_at: daysAgo(1), admin_response: 'Asking about this.', attachments: [] },
  { id: 'c1', title: 'Archived clients', description: 'Archived quotes should close the job.', type: 'bug', status: 'shipped', user_id: 'u2', submitter_name: 'Lynette Ewy', submitter_email: 'lynette@kc.com', location_id: 'loc-2', location_name: 'Kansas City', created_at: daysAgo(30), updated_at: daysAgo(20), admin_response: 'Shipped last week.', attachments: [] },
]

// One item filed from a client record — the id-only context pointer plus the
// name the GET route resolves for it.
const WITH_CONTEXT = {
  id: 'x1', title: 'Problem with Engagement – Aug 2026',
  description: 'This went to the main hive but shows in the assessment column.',
  type: 'bug', status: 'submitted', user_id: 'u1',
  submitter_name: 'Ankur Patel', submitter_email: 'ankur@pb.com',
  location_id: 'loc-1', location_name: 'Palm Beach',
  created_at: daysAgo(12), updated_at: daysAgo(12), attachments: [],
  context: { kind: 'engagement', lead_id: 'lead-7', stage: 'Request', path: '/clients/lead-7?e=eng-3' },
  context_client_name: 'Mary Sifian',
}

const stubFetch = (items: any[] = ITEMS) => {
  const f = vi.fn(async (_url: any, init?: any) => {
    if (init?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ id: 'n1', status: 'planned', reply_email: null }) }
    }
    return { ok: true, status: 200, json: async () => ({ items }) }
  })
  vi.stubGlobal('fetch', f)
  return f
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {})
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

const screenFor = (items: any[] = ITEMS, props: any = {}) => {
  stubFetch(items)
  return mount(
    <CurrentUserContext.Provider value={{ id: 'u1', email: 'ankur@pb.com' } as any}>
      <AdminFeedbackScreen onOpenCountChange={props.onOpenCountChange || (() => {})} {...props} />
    </CurrentUserContext.Provider>,
  )
}

const buttons = (host: Element) => [...host.querySelectorAll('button')]
const byText = (host: Element, prefix: string) =>
  buttons(host).find(b => (b.textContent || '').trim().startsWith(prefix))
// Row buttons open the modal; the queue cards are the aria-pressed ones.
const rowTitles = (host: Element) =>
  buttons(host)
    .map(b => [...ITEMS, WITH_CONTEXT].find(i => (b.textContent || '').trim().startsWith(i.title))?.title)
    .filter((t): t is string => !!t)
const card = (host: Element, label: string) =>
  buttons(host).find(b => b.hasAttribute('aria-pressed') && (b.textContent || '').startsWith(label))
const cardCount = (host: Element, label: string) => {
  const m = (card(host, label)?.textContent || '').match(/^.*?(\d+)/)
  return m ? Number(m[1]) : null
}

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('closed items are hidden by default', () => {
  it('the shipped row is absent on open, and the toggle names how many are hidden', async () => {
    const { host, unmount } = await screenFor()
    expect(rowTitles(host)).not.toContain('Archived clients')
    expect(rowTitles(host).length).toBe(5)
    expect(byText(host, 'Show 1 closed')).toBeTruthy()
    await unmount()
  })

  it('the toggle reveals them and flips its own label', async () => {
    const { host, unmount } = await screenFor()
    await click(byText(host, 'Show 1 closed')!)
    expect(rowTitles(host)).toContain('Archived clients')
    expect(byText(host, 'Hide 1 closed')).toBeTruthy()
    await unmount()
  })

  it('no toggle at all when nothing is closed — no control for an empty set', async () => {
    const { host, unmount } = await screenFor(ITEMS.filter(i => i.status !== 'shipped'))
    expect(byText(host, 'Show 0 closed')).toBeUndefined()
    expect(buttons(host).some(b => (b.textContent || '').includes('closed'))).toBe(false)
    await unmount()
  })
})

describe('the three queue cards', () => {
  it('counts the two untouched, the two gone quiet, and nothing in progress', async () => {
    const { host, unmount } = await screenFor()
    expect(cardCount(host, 'Not looked at yet')).toBe(2)
    expect(cardCount(host, 'Going stale')).toBe(2)
    expect(cardCount(host, 'Being worked on')).toBe(0)
    await unmount()
  })

  it('the stale card catches under_review AND planned untouched for 14+ days', async () => {
    const { host, unmount } = await screenFor()
    await click(card(host, 'Going stale')!)
    expect(rowTitles(host).sort()).toEqual(['Bulk Update', 'Guide'])
    // The item reviewed yesterday is NOT stale, though it shares the status.
    expect(rowTitles(host)).not.toContain('Additional Address')
    await unmount()
  })

  it('says how long the oldest one has been waiting', async () => {
    const { host, unmount } = await screenFor()
    expect(card(host, 'Not looked at yet')!.textContent).toContain('oldest waiting 12 days')
    await unmount()
  })

  it('clicking the selected card again clears back to everything open', async () => {
    const { host, unmount } = await screenFor()
    await click(card(host, 'Not looked at yet')!)
    expect(rowTitles(host).length).toBe(2)
    await click(card(host, 'Not looked at yet')!)
    expect(rowTitles(host).length).toBe(5)
    await unmount()
  })

  it('the stale queue lists longest-quiet FIRST — the whole point of looking at it', async () => {
    const { host, unmount } = await screenFor()
    await click(card(host, 'Going stale')!)
    expect(rowTitles(host)).toEqual(['Bulk Update', 'Guide']) // quiet 19d, then 14d
    await unmount()
  })
})

describe('one open count — header, cards and badge agree', () => {
  it('the header count equals the three cards plus the in-hand remainder', async () => {
    const { host, unmount } = await screenFor()
    expect(host.textContent).toContain('5 open items · 6 in total')
    const sum = cardCount(host, 'Not looked at yet')! + cardCount(host, 'Going stale')! + cardCount(host, 'Being worked on')!
    // 2 + 2 + 0 = 4 cards, plus the one recently-reviewed item = the header's 5.
    expect(sum).toBe(4)
    expect(host.textContent).toContain('1 more open item is in hand')
    await unmount()
  })

  it('reports that SAME number up to the nav badge — the number the dashboard shows', async () => {
    const onOpenCountChange = vi.fn()
    const { unmount } = await screenFor(ITEMS, { onOpenCountChange })
    expect(onOpenCountChange).toHaveBeenLastCalledWith(5) // not 2, the old submitted-only count
    await unmount()
  })

  it('the in-hand line is its own filter, so every open item is reachable', async () => {
    const { host, unmount } = await screenFor()
    await click(byText(host, 'Show them')!)
    expect(rowTitles(host)).toEqual(['Additional Address'])
    await unmount()
  })
})

describe('rows say what the item is', () => {
  it('carries the description, so two identically-titled reports are distinguishable', async () => {
    const twins = [
      { ...WITH_CONTEXT, id: 't1', description: 'This went to the main hive but shows in the assessment column.' },
      { ...WITH_CONTEXT, id: 't2', description: 'This is a repeat client showing in request, not new.' },
    ]
    const { host, unmount } = await screenFor(twins)
    const text = host.textContent || ''
    expect(text).toContain('This went to the main hive')
    expect(text).toContain('This is a repeat client')
    await unmount()
  })

  it('renders the context pointer as "Open the record", linked to the record itself', async () => {
    const { host, unmount } = await screenFor([WITH_CONTEXT])
    const link = [...host.querySelectorAll('a')].find(a => (a.textContent || '').includes('Open the record'))!
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/clients/lead-7?e=eng-3')
    // …and names what it points at, resolved live by the route.
    expect(host.textContent).toContain('Mary Sifian · Request')
    await unmount()
  })

  it('flags a reply that never moved the status — the one that keeps ringing the badge', async () => {
    const { host, unmount } = await screenFor()
    const stranded = buttons(host).find(b => (b.textContent || '').startsWith('Client not moving'))!
    expect(stranded.textContent).toContain('Replied, still marked New')
    // A normally-answered item just says so.
    await click(card(host, 'Going stale')!)
    expect(buttons(host).find(b => (b.textContent || '').startsWith('Guide'))!.textContent).toContain('Replied')
    await unmount()
  })

  it('says when nothing has been said back yet', async () => {
    const { host, unmount } = await screenFor()
    expect(buttons(host).find(b => (b.textContent || '').startsWith('Snooze Button'))!.textContent)
      .toContain('No reply yet')
    await unmount()
  })
})

describe('search reaches the description', () => {
  it('finds an item by words that appear only in its body', async () => {
    const { host, unmount } = await screenFor()
    const search = host.querySelector('input') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'Closed Lost')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rowTitles(host)).toEqual(['Client not moving in system correctly'])
    await unmount()
  })

  it('still matches the submitter, as it always did', async () => {
    const { host, unmount } = await screenFor()
    const search = host.querySelector('input') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'lynette@kc.com')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rowTitles(host)).toEqual(['Client not moving in system correctly'])
    await unmount()
  })
})

describe('next / previous walks the queue and stops at both ends', () => {
  const openFirst = async (host: Element) => {
    await click(card(host, 'Going stale')!)
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Bulk Update'))!)
  }
  const nav = (host: Element, label: string) =>
    buttons(host).find(b => (b.textContent || '').trim().startsWith(label))!

  it('counts your position within the queue you came from', async () => {
    const { host, unmount } = await screenFor()
    await openFirst(host)
    expect(host.textContent).toContain('1 of 2 going stale')
    await unmount()
  })

  it('Next moves to the following item and re-points the modal', async () => {
    const { host, unmount } = await screenFor()
    await openFirst(host)
    await click(nav(host, 'Next'))
    expect(host.textContent).toContain('2 of 2 going stale')
    expect(host.textContent).toContain('The guide does not open') // now showing "Guide"
    await unmount()
  })

  it('STOPS at both ends — Previous is dead on the first, Next on the last', async () => {
    const { host, unmount } = await screenFor()
    await openFirst(host)
    expect((nav(host, '‹ Previous') as HTMLButtonElement).disabled).toBe(true)
    expect((nav(host, 'Next') as HTMLButtonElement).disabled).toBe(false)

    await click(nav(host, 'Next'))
    expect((nav(host, 'Next') as HTMLButtonElement).disabled).toBe(true)
    expect((nav(host, '‹ Previous') as HTMLButtonElement).disabled).toBe(false)
    // Clicking the dead end changes nothing rather than wrapping around.
    await click(nav(host, 'Next'))
    expect(host.textContent).toContain('2 of 2 going stale')
    await unmount()
  })

  it('walking the whole open list counts against the header number', async () => {
    const { host, unmount } = await screenFor()
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Snooze Button'))!)
    expect(host.textContent).toContain('of 5 open')
    await unmount()
  })
})

describe('the detail modal', () => {
  it('renders an existing reply AS a reply, not as prefilled text in a textarea', async () => {
    const { host, unmount } = await screenFor()
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Client not moving'))!)
    // The reply is on screen…
    expect(host.textContent).toContain('You can remove it from the three dots menu.')
    // …and NOT sitting in an editable field waiting to be overwritten.
    const textareas = [...host.querySelectorAll('textarea')]
    expect(textareas.every(t => !t.value.includes('three dots'))).toBe(true)
    expect(byText(host, 'Write a new reply')).toBeTruthy()
    await unmount()
  })

  it('offers status as buttons, in plain words, never a dropdown of db values', async () => {
    const { host, unmount } = await screenFor()
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Snooze Button'))!)
    for (const label of ['New', 'Looking at it', 'Planned', 'In progress', 'Fixed', 'Not planned']) {
      expect(buttons(host).some(b => (b.textContent || '').trim() === label)).toBe(true)
    }
    expect(host.textContent).not.toContain('under_review')
    await unmount()
  })

  async function typeReply(host: HTMLElement, text: string) {
    const ta = host.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('tells the admin what Save will do before they press it', async () => {
    const { host, unmount } = await screenFor()
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Snooze Button'))!)
    expect(host.textContent).toContain('Saving with the box empty changes the status only. No email is sent.')
    await unmount()
  })

  // issue 235 defect B. The viewer here is u1 and "Snooze Button" is u1's OWN
  // item, so route rule 4 skips the send. The screen used to promise
  // "Saving emails this to ankur@pb.com." under a button reading "Save and
  // send" — a promise the route guaranteed it would not keep. This test
  // previously asserted that wrong copy; it now asserts the truth.
  it('does not promise an email when replying to your OWN item', async () => {
    const { host, unmount } = await screenFor()
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Snooze Button'))!)
    await typeReply(host, 'Good idea — adding it.')
    expect(host.textContent).toContain('This is your own report — saving stores the reply, but no email is sent.')
    expect(host.textContent).not.toContain('Saving emails this to ankur@pb.com.')
    expect(byText(host, 'Save and send')).toBeFalsy()
    expect(byText(host, 'Save')).toBeTruthy()
    await unmount()
  })

  it('still promises the email when replying to SOMEONE ELSE', async () => {
    const { host, unmount } = await screenFor()
    // n2 is Lynette's (u2) and already carries a reply, so the composer opens
    // behind "Write a new reply".
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Client not moving'))!)
    await click(byText(host, 'Write a new reply')!)
    await typeReply(host, 'Fixed in this week release.')
    expect(host.textContent).toContain('Saving emails this to lynette@kc.com.')
    expect(byText(host, 'Save and send')).toBeTruthy()
    await unmount()
  })

  it('a status-only save omits admin_response entirely — it cannot blank or re-send a reply', async () => {
    const f = stubFetch()
    const { host, unmount } = await mount(
      <CurrentUserContext.Provider value={{ id: 'u1', email: 'ankur@pb.com' } as any}>
        <AdminFeedbackScreen onOpenCountChange={() => {}} />
      </CurrentUserContext.Provider>,
    )
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Client not moving'))!)
    await click(buttons(host).find(b => (b.textContent || '').trim() === 'Planned')!)
    await click(byText(host, 'Save')!)
    const patch = f.mock.calls.find(c => (c[1] as any)?.method === 'PATCH')!
    expect(JSON.parse((patch[1] as any).body)).toEqual({ status: 'planned' })
    await unmount()
  })
})
