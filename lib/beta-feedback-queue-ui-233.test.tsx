// @vitest-environment happy-dom
//
// issue 233 — the rebuilt Feedback screen, MOUNTED — as it stands after THE
// QUEUES REDESIGN.
//
// Issue 233 replaced one flat list with three queue cards and a hidden closed
// set. The queues redesign kept every 233 GUARANTEE and changed the shape:
//
//   - closed items are still HIDDEN by default — behind the Open / Closed /
//     Everything filter since the tiles redesign (the "Show N closed" link
//     is gone)
//   - the three status cards became TWO queues, and the queues became SIX
//     TILES in two groups (the tiles redesign)
//   - the header count still equals what the tiles hold; the nav badge is a
//     different, smaller number (unanswered bugs + questions)
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

// Six items. Where each lands under the tiles redesign (viewer is u1, Ankur):
//   n1  Snooze Button      idea, no reply              → Decide (10d, own item)
//   n2  Client not moving  bug, reply, still submitted → Stuck (12d)
//   s1  Guide              bug, reply, under_review    → Still deciding (58d)
//   s2  Bulk Update        idea, reply, planned        → Build (58d)
//   h1  Additional Address bug, reply, under_review    → Still deciding (3d)
//   c1  Archived clients   shipped                     → closed, behind the filter
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
      <AdminFeedbackScreen onBadgeCountChange={props.onBadgeCountChange || (() => {})} {...props} />
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
const tileSection = (host: Element, key: string) => host.querySelector(`[data-section="${key}"]`) as HTMLElement | null
// The Save button names who it emails ("Save and email Lynette") when it sends.
const sendButton = (host: Element) => buttons(host).find(b => /^Save and email /.test((b.textContent || '').trim()))
const setScope = (host: Element, value: string) => act(async () => {
  const sel = host.querySelector('select[aria-label="Open or closed"]') as HTMLSelectElement
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(sel, value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})
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

// Closed items are hidden by default — and reached through the Open / Closed /
// Everything FILTER now (the tiles redesign), not a grey link at the bottom.
describe('closed items are hidden by default', () => {
  it('the shipped row is absent on open, and the filter names how many are closed', async () => {
    const { host, unmount } = await screenFor()
    expect(rowTitles(host)).not.toContain('Archived clients')
    expect(rowTitles(host).length).toBe(5)
    const scope = host.querySelector('select[aria-label="Open or closed"]') as HTMLSelectElement
    expect([...scope.options].map(o => o.textContent)).toEqual(['Open (5)', 'Closed (1)', 'Everything (6)'])
    await unmount()
  })

  it('choosing Closed shows them under their own word; there is no bottom link', async () => {
    const { host, unmount } = await screenFor()
    expect(buttons(host).some(b => /(show|hide)\s+\d+\s+closed/i.test(b.textContent || ''))).toBe(false)
    await setScope(host, 'closed')
    expect(rowTitles(host)).toEqual(['Archived clients'])
    expect(rowTitles(host, tileSection(host, 'closed-shipped'))).toEqual(['Archived clients'])
    await unmount()
  })

  it('no closed control for an empty set — the filter says Closed (0)', async () => {
    const { host, unmount } = await screenFor(ITEMS.filter(i => i.status !== 'shipped'))
    expect(buttons(host).some(b => (b.textContent || '').includes('closed'))).toBe(false)
    const scope = host.querySelector('select[aria-label="Open or closed"]') as HTMLSelectElement
    expect([...scope.options][1].textContent).toBe('Closed (0)')
    await unmount()
  })
})

// The two queues became six tiles (lib/beta-admin-feedback-tiles.test.tsx
// pins the arithmetic). Here: these six items land where they should.
describe('the six tiles', () => {
  it('each item lands in its tile: unanswered by type, answered by status', async () => {
    const { host, unmount } = await screenFor()
    expect(rowTitles(host, tileSection(host, 'decide'))).toEqual(['Snooze Button'])
    expect(rowTitles(host, tileSection(host, 'build'))).toEqual(['Bulk Update'])
    expect(rowTitles(host, tileSection(host, 'stuck'))).toEqual(['Client not moving in system correctly'])
    expect(rowTitles(host, tileSection(host, 'deciding'))).toEqual(['Guide', 'Additional Address'])
    await unmount()
  })

  it('inside a section: longest waiting first', async () => {
    const { host, unmount } = await screenFor()
    // Guide was filed 58 days ago, Additional Address 3.
    expect(rowTitles(host, tileSection(host, 'deciding'))).toEqual(['Guide', 'Additional Address'])
    await unmount()
  })

  it('each tile says how many and how old the oldest is', async () => {
    const { host, unmount } = await screenFor()
    const t = host.querySelector('[data-tile="deciding"]')!
    expect(t.querySelector('[data-tile-count]')!.textContent).toBe('2')
    expect(t.querySelector('[data-tile-oldest]')!.textContent).toBe('Oldest: 58 days')
    await unmount()
  })

  it('age steps: 58 days is amber (30 to 59), never the strong red of 60+', async () => {
    const { host, unmount } = await screenFor()
    for (const k of ['decide', 'build', 'deciding', 'stuck']) {
      expect((tileSection(host, k)!.querySelector('h3') as HTMLElement).style.color, k).not.toBe(T.state.danger.strong)
    }
    expect(host.querySelector('[data-row="s1"] [data-age-tone]')!.getAttribute('data-age-tone')).toBe('amber')
    expect(host.querySelector('[data-row="h1"] [data-age-tone]')!.getAttribute('data-age-tone')).toBe('plain')
    await unmount()
  })
})

describe('the open count and the badge', () => {
  it('the header count equals the five tiles plus the Stuck strip', async () => {
    const { host, unmount } = await screenFor()
    expect(host.textContent).toContain('5 open items · 6 in total')
    const sum = [...host.querySelectorAll('[data-tile-count]')].reduce((n, e) => n + Number(e.textContent), 0)
    expect(sum).toBe(4)
    // n2 is the one Stuck item: counted on the strip, not on a tile.
    expect(host.querySelector('[data-stuck-strip]')!.textContent).toContain('1 has a reply but still says nobody has answered.')
    await unmount()
  })

  it('the badge is NOT the open count — no unanswered bug or question here, so 0', async () => {
    const onBadgeCountChange = vi.fn()
    const { unmount } = await screenFor(ITEMS, { onBadgeCountChange })
    expect(onBadgeCountChange).toHaveBeenLastCalledWith(0)
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
    expect(row(host, 'Client not moving').textContent).toContain('Replied, still marked With the team')
    // A normally-answered item just says so.
    expect(row(host, 'Guide').textContent).toContain('Replied')
    await unmount()
  })

  it('no red dot any more — the section says it needs an answer, and red is kept for age', async () => {
    const { host, unmount } = await screenFor()
    expect(host.querySelector('[data-testid="needs-dot"]')).toBeNull()
    expect(rowTitles(host, tileSection(host, 'decide'))).toContain('Snooze Button')
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

  it('counts your position, and names the tile the item sits in', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    expect(modal(host)!.textContent).toContain('1 of 5 · Ideas')
    await unmount()
  })

  it('Next moves to the following item and re-points the modal', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    await click(next(host))
    expect(modal(host)!.textContent).toContain('2 of 5 · We said yes')
    expect(modal(host)!.textContent).toContain('Changing twenty clients') // now showing "Bulk Update"
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
    expect([...sel.options].map(o => o.textContent)).toEqual(['With the team', 'Looking at it', 'On the list', 'Building it now', 'Answered', 'Fixed', 'Not planned'])
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
    expect(sendButton(host)).toBeFalsy()
    expect(exact(host, 'Save')).toBeTruthy()
    await unmount()
  })

  it('still promises the email when replying to SOMEONE ELSE', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Client not moving'))
    await typeReply(host, 'Fixed in this week release.')
    expect(modal(host)!.textContent).toContain('Saving emails this to lynette@kc.com.')
    expect(sendButton(host)?.textContent).toBe('Save and email Lynette')
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
    expect(sendButton(host)).toBeTruthy()
    // …and it must not also carry the line that says the opposite.
    expect(modal(host)!.textContent).not.toContain('Changing the type or status alone sends nothing')
    await unmount()
  })

  it('still says nothing is sent for the MIDDLE statuses', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Client not moving'))
    await pickStatus(host, 'planned')
    expect(modal(host)!.textContent).not.toContain('emails lynette@kc.com to tell them')
    expect(sendButton(host)).toBeFalsy()
    await unmount()
  })

  it('does not promise an email for Fixed on your OWN report', async () => {
    const { host, unmount } = await screenFor()
    await click(row(host, 'Snooze Button'))
    await pickStatus(host, 'shipped')
    expect(modal(host)!.textContent).toContain('This is your own report — saving marks it Fixed, and no email is sent.')
    expect(sendButton(host)).toBeFalsy()
    await unmount()
  })

  it('promises nothing when the item is ALREADY Fixed — the send is a transition', async () => {
    const { host, unmount } = await screenFor()
    await setScope(host, 'closed')
    await click(row(host, 'Archived clients'))
    expect(modal(host)!.textContent).not.toContain('emails lynette@kc.com to tell them')
    expect(sendButton(host)).toBeFalsy()
    await unmount()
  })

  it('a status-only save omits admin_response entirely — it cannot blank or re-send a reply', async () => {
    const f = stubFetch()
    const { host, unmount } = await mount(
      <CurrentUserContext.Provider value={{ id: 'u1', email: 'ankur@pb.com' } as any}>
        <AdminFeedbackScreen onBadgeCountChange={() => {}} />
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
