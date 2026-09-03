// @vitest-environment happy-dom
//
// issue 233 — the rebuilt Feedback screen, MOUNTED — as it stands after THE
// QUEUES REDESIGN.
//
// Issue 233 replaced one flat list with three queue cards and a hidden closed
// set. The queues redesign kept every 233 GUARANTEE and changed the shape:
//
//   - closed items are still HIDDEN by default, behind "Show N closed"
//   - the three status cards became TWO queues grouped by whose turn it is
//     ("Needs an answer" / "Waiting on them"), with a fixed type order inside
//   - the header count still equals what the queues hold
//   - rows still carry the description
//   - the context pointer still renders as "Open the record" — in the modal
//   - a reply that never moved the status is still flagged on the row
//   - search still reaches the description
//   - next/previous still walks the list and stops at both ends — as arrow
//     buttons now, plus the arrow keys
//   - the detail modal still says what Save will do before it is pressed, and
//     status is a DROPDOWN in plain words (the row of buttons is gone)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { T } from '@/components/hive/shared/tokens'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

// Six items. Where each lands under the redesign (viewer is u1, Ankur):
//   n1  Snooze Button      no reply                → Needs an answer (10d, own item)
//   n2  Client not moving  legacy reply 12d ago    → Waiting on them (12d)
//   s1  Guide              reply, undated          → Waiting on them (since filing, 58d)
//   s2  Bulk Update        reply, undated          → Waiting on them (58d)
//   h1  Additional Address reply, undated          → Waiting on them (3d)
//   c1  Archived clients   shipped                 → closed, hidden
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
const exact = (host: Element, text: string) =>
  buttons(host).find(b => (b.textContent || '').trim() === text)
const row = (host: Element, title: string) =>
  buttons(host).find(b => (b.textContent || '').startsWith(title))!
const rowTitles = (host: Element, within: Element | null = host) =>
  [...(within?.querySelectorAll('button') || [])]
    .map(b => [...ITEMS, WITH_CONTEXT].find(i => (b.textContent || '').trim().startsWith(i.title))?.title)
    .filter((t): t is string => !!t)
const section = (host: Element, label: string) => host.querySelector(`section[aria-label="${label}"]`) as HTMLElement | null
const modal = (host: Element) => host.querySelector('[role="dialog"]') as HTMLElement | null
const byLabel = (host: Element, label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null
const pickStatus = (host: Element, value: string) => act(async () => {
  const sel = byLabel(host, 'Status') as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  setter.call(sel, value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})
async function typeReply(host: Element, text: string) {
  const ta = modal(host)!.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

  it('the toggle reveals them as a third group and flips its own label', async () => {
    const { host, unmount } = await screenFor()
    await click(byText(host, 'Show 1 closed')!)
    expect(rowTitles(host)).toContain('Archived clients')
    expect(rowTitles(host, section(host, 'Closed'))).toEqual(['Archived clients'])
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

describe('the two queues', () => {
  it('the unanswered item needs an answer; every replied item is waiting on them', async () => {
    const { host, unmount } = await screenFor()
    expect(rowTitles(host, section(host, 'Needs an answer'))).toEqual(['Snooze Button'])
    expect(rowTitles(host, section(host, 'Waiting on them')).sort())
      .toEqual(['Additional Address', 'Bulk Update', 'Client not moving in system correctly', 'Guide'].sort())
    await unmount()
  })

  it('inside a queue: bugs before ideas, longest waiting first within each', async () => {
    const { host, unmount } = await screenFor()
    // Bugs: Guide (58d, undated reply → since filing) · Client not moving (12d) · Additional Address (3d). Then the idea.
    expect(rowTitles(host, section(host, 'Waiting on them')))
      .toEqual(['Guide', 'Client not moving in system correctly', 'Additional Address', 'Bulk Update'])
    await unmount()
  })

  it('each header says how many and how long the oldest has waited', async () => {
    const { host, unmount } = await screenFor()
    expect(section(host, 'Needs an answer')!.querySelector('h3')!.textContent).toContain('1')
    expect(section(host, 'Needs an answer')!.textContent).toContain('oldest 10 days')
    expect(section(host, 'Waiting on them')!.querySelector('h3')!.textContent).toContain('4')
    expect(section(host, 'Waiting on them')!.textContent).toContain('oldest 58 days')
    await unmount()
  })

  it('the header that has waited past 14 days is red; the other is not', async () => {
    const { host, unmount } = await screenFor()
    expect((section(host, 'Waiting on them')!.querySelector('h3') as HTMLElement).style.color).toBe(T.state.danger.strong)
    expect((section(host, 'Needs an answer')!.querySelector('h3') as HTMLElement).style.color).toBe(T.ink.primary)
    await unmount()
  })
})

describe('one open count — header, queues and badge agree', () => {
  it('the header count equals the two queues together', async () => {
    const { host, unmount } = await screenFor()
    expect(host.textContent).toContain('5 open items · 6 in total')
    const needs = rowTitles(host, section(host, 'Needs an answer')).length
    const waiting = rowTitles(host, section(host, 'Waiting on them')).length
    expect(needs + waiting).toBe(5)
    await unmount()
  })

  it('reports that SAME number up to the nav badge — the number the dashboard shows', async () => {
    const onOpenCountChange = vi.fn()
    const { unmount } = await screenFor(ITEMS, { onOpenCountChange })
    expect(onOpenCountChange).toHaveBeenLastCalledWith(5) // not 1, the submitted-only count
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

  it('the context pointer renders in the modal as "Open the record", linked to the record itself', async () => {
    const { host, unmount } = await screenFor([WITH_CONTEXT])
    await click(row(host, 'Problem with Engagement'))
    const link = [...modal(host)!.querySelectorAll('a')].find(a => (a.textContent || '').includes('Open the record'))!
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/clients/lead-7?e=eng-3')
    expect(modal(host)!.textContent).toContain('Mary Sifian · Request')
    await unmount()
  })

  it('flags a reply that never moved the status — the one that keeps ringing the badge', async () => {
    const { host, unmount } = await screenFor()
    expect(row(host, 'Client not moving').textContent).toContain('Replied, still marked New')
    // A normally-answered item just says so.
    expect(row(host, 'Guide').textContent).toContain('Replied')
    await unmount()
  })

  it('marks what needs a response with the red dot, and nothing else', async () => {
    const { host, unmount } = await screenFor()
    expect(row(host, 'Snooze Button').querySelector('[data-testid="needs-dot"]')).toBeTruthy()
    expect(row(host, 'Guide').querySelector('[data-testid="needs-dot"]')).toBeNull()
    await unmount()
  })
})

describe('search reaches the description', () => {
  const search = (host: Element) => host.querySelector('input[aria-label="Search feedback"]') as HTMLInputElement
  it('finds an item by words that appear only in its body', async () => {
    const { host, unmount } = await screenFor()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(search(host), 'Closed Lost')
      search(host).dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rowTitles(host)).toEqual(['Client not moving in system correctly'])
    await unmount()
  })

  it('still matches the submitter, as it always did', async () => {
    const { host, unmount } = await screenFor()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(search(host), 'lynette@kc.com')
      search(host).dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rowTitles(host)).toEqual(['Client not moving in system correctly'])
    await unmount()
  })
})

describe('next / previous walks the list and stops at both ends', () => {
  const prev = (host: Element) => byLabel(host, 'Previous item') as HTMLButtonElement
  const next = (host: Element) => byLabel(host, 'Next item') as HTMLButtonElement

  it('counts your position, and names the queue the item sits in', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    expect(modal(host)!.textContent).toContain('1 of 5 · Needs an answer')
    await unmount()
  })

  it('Next moves to the following item and re-points the modal', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    await click(next(host))
    expect(modal(host)!.textContent).toContain('2 of 5 · Waiting on them')
    expect(modal(host)!.textContent).toContain('The guide does not open') // now showing "Guide"
    await unmount()
  })

  it('STOPS at both ends — Previous is dead on the first, Next on the last', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    expect(prev(host).disabled).toBe(true)
    expect(next(host).disabled).toBe(false)
    for (let n = 0; n < 4; n++) await click(next(host))
    expect(modal(host)!.textContent).toContain('5 of 5')
    expect(next(host).disabled).toBe(true)
    expect(prev(host).disabled).toBe(false)
    // Clicking the dead end changes nothing rather than wrapping around.
    await click(next(host))
    expect(modal(host)!.textContent).toContain('5 of 5')
    await unmount()
  })

  it('the arrow keys walk too, and Escape closes', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(modal(host)!.textContent).toContain('2 of 5')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(modal(host)).toBeNull()
    await unmount()
  })
})

describe('the detail modal', () => {
  it('renders an existing reply AS a reply, not as prefilled text in a textarea', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Client not moving'))
    // The reply is on screen…
    expect(modal(host)!.textContent).toContain('You can remove it from the three dots menu.')
    // …and NOT sitting in an editable field waiting to be overwritten.
    const textareas = [...host.querySelectorAll('textarea')]
    expect(textareas.length).toBe(1)
    expect(textareas.every(t => !t.value.includes('three dots'))).toBe(true)
    await unmount()
  })

  it('offers status as a dropdown, in plain words, never the db values', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    const sel = byLabel(host, 'Status') as HTMLSelectElement
    expect([...sel.options].map(o => o.textContent)).toEqual(['New', 'Looking at it', 'Planned', 'In progress', 'Answered', 'Fixed', 'Not planned'])
    expect(host.textContent).not.toContain('under_review')
    // No row of status buttons any more.
    expect(exact(host, 'Looking at it')).toBeUndefined()
    await unmount()
  })

  it('tells the admin what Save will do before they press it', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Client not moving'))
    expect(modal(host)!.textContent).toContain('Sending a reply emails lynette@kc.com. Changing the type or status alone sends nothing — except Fixed, which tells them by email.')
    await unmount()
  })

  // issue 235 defect B. The viewer here is u1 and "Snooze Button" is u1's OWN
  // item, so route rule 4 skips the send. The copy must say so.
  it('does not promise an email when replying to your OWN item', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    await typeReply(host, 'Good idea — adding it.')
    expect(modal(host)!.textContent).toContain('This is your own report — saving stores the reply, but no email is sent.')
    expect(modal(host)!.textContent).not.toContain('Saving emails this to ankur@pb.com.')
    expect(exact(host, 'Save and send')).toBeFalsy()
    expect(exact(host, 'Save')).toBeTruthy()
    await unmount()
  })

  it('still promises the email when replying to SOMEONE ELSE', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Client not moving'))
    await typeReply(host, 'Fixed in this week release.')
    expect(modal(host)!.textContent).toContain('Saving emails this to lynette@kc.com.')
    expect(exact(host, 'Save and send')).toBeTruthy()
    await unmount()
  })

  // ── issue 236 ──────────────────────────────────────────────
  // Marking something Fixed sends on its own, so this screen says so BEFORE
  // the press.
  it('promises the email when Fixed is chosen with the box EMPTY', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Client not moving'))
    await pickStatus(host, 'shipped')
    expect(modal(host)!.textContent).toContain('Saving marks this Fixed and emails lynette@kc.com to tell them')
    expect(exact(host, 'Save and send')).toBeTruthy()
    // …and it must not also carry the line that says the opposite.
    expect(modal(host)!.textContent).not.toContain('Changing the type or status alone sends nothing')
    await unmount()
  })

  it('still says nothing is sent for the MIDDLE statuses', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Client not moving'))
    await pickStatus(host, 'planned')
    expect(modal(host)!.textContent).not.toContain('emails lynette@kc.com to tell them')
    expect(exact(host, 'Save and send')).toBeFalsy()
    await unmount()
  })

  it('does not promise an email for Fixed on your OWN report', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    await pickStatus(host, 'shipped')
    expect(modal(host)!.textContent).toContain('This is your own report — saving marks it Fixed, and no email is sent.')
    expect(exact(host, 'Save and send')).toBeFalsy()
    await unmount()
  })

  it('promises nothing when the item is ALREADY Fixed — the send is a transition', async () => {
    const { host, unmount } = await screenFor()
    await click(byText(host, 'Show 1 closed')!)
    await click(row(host, 'Archived clients'))
    expect(modal(host)!.textContent).not.toContain('emails lynette@kc.com to tell them')
    expect(exact(host, 'Save and send')).toBeFalsy()
    await unmount()
  })

  it('a status-only save omits admin_response entirely — it cannot blank or re-send a reply', async () => {
    const f = stubFetch()
    const { host, unmount } = await mount(
      <CurrentUserContext.Provider value={{ id: 'u1', email: 'ankur@pb.com' } as any}>
        <AdminFeedbackScreen onOpenCountChange={() => {}} />
      </CurrentUserContext.Provider>,
    )
    await click(row(host, 'Client not moving'))
    await pickStatus(host, 'planned')
    await click(exact(host, 'Save')!)
    const patch = f.mock.calls.find(c => (c[1] as any)?.method === 'PATCH')!
    expect(JSON.parse((patch[1] as any).body)).toEqual({ status: 'planned' })
    await unmount()
  })
})
