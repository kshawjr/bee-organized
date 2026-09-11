// @vitest-environment happy-dom
//
// A dismissed lead is VISIBLE and REVERSIBLE. Nothing about what dismiss DOES
// changes.
//
// Courtney Grady (Central Denver, website lead 9 Sep) was dismissed from the
// Inbox by mistake on 10 Sep at 19:05. She stayed a live lead, stayed on the
// Client List, stayed in the drip — and simply stopped appearing in the one
// place anyone looks for work. Nobody chased her for 36 hours. Dismiss is not
// the problem (159 leads across 18 locations rely on it); being invisible and,
// once the undo toast faded, irreversible from the UI, was.
//
// THE TWO RULES THESE TESTS EXIST TO PIN
//
// 1. The chip is a VIEW toggle and must NEVER touch the nav badge count.
//    That is the exact drift #89 was filed for: the badge and the list each
//    grew their own opinion and disagreed. The badge's count rule lives in
//    isInboxCountable/isSoftRemovedFromInbox and the chip is deliberately not
//    part of it. `toggling the chip does not move the badge` is the
//    most important assertion in this file.
//
// 2. SHOW WHAT YOU KNOW, NEVER GUESS. The dismiss button has never recorded
//    who clicked it (verified in prod 2026-09-10: all 84 dismiss touchpoints
//    carry a null author), so most dismissed leads can name nobody. The line
//    must then show the DATE ALONE — never "by system", never "by unknown",
//    never a dangling "by". A person probably clicked it and we did not write
//    it down; saying otherwise is a guess presented as fact.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import HiveShell from '@/components/hive/HiveShell'
import ClientProfile from '@/components/hive/ClientProfile'
import { mapLeadToPerson } from '@/lib/people-mapper'
import {
  describeDismissal, dismissalLine, dismissRouteOfLabel,
  DISMISS_BUTTON_LABEL, NO_COVERAGE_LABEL,
} from '@/components/hive/shared/dismissalFacts'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const ANDREA = 'u-andrea'
const roster = [{ id: ANDREA, name: 'Andrea Whitfield' }]

// A live NEW lead (recent, contactable, no reach-out, no engagement).
const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell', email: 'sarah@email.com', phone: '(561) 555-0199',
  locationId: KC, created: daysAgo(3),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null,
  outreachTimeline: [], atLocOther: false, paused: false,
  originCity: null, originState: null, originZip: null, project: '',
  ...over,
})

// A dismissed lead whose audit row records NOBODY — the button path, and the
// overwhelmingly common case (66 of the 159 dismissed in prod).
const dismissedNoActor = (over: any = {}) => {
  const at = over.at || daysAgo(1)
  return person({
    name: 'Courtney Grady',
    inboxDismissedAt: at,
    dismissal: { at, route: 'button', actorId: null, actorName: null },
    ...over.personOver,
  })
}

// A dismissed lead whose audit row DOES record an actor — the automatic
// routes, which have always written one.
const dismissedWithActor = (over: any = {}) => {
  const at = over.at || daysAgo(1)
  return person({
    name: 'Debra Vargas',
    inboxDismissedAt: at,
    dismissal: { at, route: over.route || 'network', actorId: ANDREA, actorName: null },
    ...over.personOver,
  })
}

// ── fetch mock ─────────────────────────────────────────────
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let patches: Array<{ id: string; body: any }> = []
let touchpointPosts: any[] = []
let fetchMock: any
const installFetch = () => {
  patches = []
  touchpointPosts = []
  fetchMock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (/\/api\/leads\/[^/]+$/.test(u) && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body)
      patches.push({ id: u.split('/').pop()!, body })
      return jsonRes({ lead: { id: u.split('/').pop(), ...body } })
    }
    if (u.includes('/api/touchpoints') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      touchpointPosts.push(body)
      return jsonRes({ touchpoint: { id: 'tp-1', ...body } }, 201)
    }
    return jsonRes({})
  })
  ;(globalThis as any).fetch = fetchMock
  return fetchMock
}

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })
beforeEach(() => { installFetch(); try { localStorage.clear() } catch {} })

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(ui) })
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return {
    host,
    rerender: async (next: React.ReactElement) => { await act(async () => { root.render(next) }) },
  }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

let lastToast: any = null
const setToast = (t: any) => { lastToast = t }

const inbox = (people: any[], over: any = {}) => (
  <InboxScreen people={people} engagements={[]} locFilter={KC}
    locationUsers={roster} setToast={setToast} {...over} />
)

const chip = (host: Element) =>
  host.querySelector('[data-testid="inbox-dismissed-chip"]') as HTMLButtonElement | null
const section = (host: Element) =>
  host.querySelector('[data-testid="inbox-dismissed-section"]')
const dismissedLine = (host: Element, id: string) =>
  host.querySelector(`[data-testid="dismissed-line-${id}"]`)?.textContent || ''

// ═══════════════════════════════════════════════════════════
// The shared wording module, in isolation. Pure — no DOM, no clock drift.
// ═══════════════════════════════════════════════════════════
describe('dismissalFacts — the one opinion on what we may say', () => {
  const AT = '2026-09-10T19:05:00.000Z'

  it('routes are read off the label, not guessed', () => {
    expect(dismissRouteOfLabel(DISMISS_BUTTON_LABEL)).toBe('button')
    expect(dismissRouteOfLabel(NO_COVERAGE_LABEL)).toBe('no_coverage')
    expect(dismissRouteOfLabel('Moved to Network as Amy McNeal — drips paused')).toBe('network')
    expect(dismissRouteOfLabel('Added to Network as Kat Morga')).toBe('network')
    expect(dismissRouteOfLabel('Something we have never written')).toBeNull()
  })

  it('a lead that is not dismissed has nothing to say', () => {
    expect(describeDismissal(null, [])).toBeNull()
    expect(dismissalLine(null)).toBeNull()
  })

  it('matches the touchpoint that belongs to THIS dismissal, not a stale one', () => {
    const facts = describeDismissal(AT, [
      // An older dismissal that was undone months ago — must not be adopted.
      { kind: 'system', label: DISMISS_BUTTON_LABEL, occurred_at: '2026-07-01T10:00:00.000Z', user_id: 'someone-else' },
      { kind: 'system', label: DISMISS_BUTTON_LABEL, occurred_at: '2026-09-10T19:05:03.000Z', user_id: ANDREA },
    ])
    expect(facts!.actorId).toBe(ANDREA)
  })

  it('an actor on record produces a NAME and a time', () => {
    const facts = describeDismissal(AT, [
      { kind: 'system', label: NO_COVERAGE_LABEL, occurred_at: AT, user_label: 'Andrea' },
    ])
    const line = dismissalLine(facts)
    expect(line).toContain('Dismissed by Andrea')
    expect(line).toMatch(/10 Sep/)
  })

  it('NO actor on record produces the DATE ALONE — no name, no placeholder', () => {
    const facts = describeDismissal(AT, [
      { kind: 'system', label: DISMISS_BUTTON_LABEL, occurred_at: AT, user_id: null },
    ])
    const line = dismissalLine(facts)!
    expect(line).toBe('Dismissed 10 Sep')
    // The guess-presented-as-fact guard. This is what the mutation test breaks.
    expect(line.toLowerCase()).not.toContain('system')
    expect(line.toLowerCase()).not.toContain('unknown')
    expect(line.toLowerCase()).not.toContain('someone')
    expect(line).not.toMatch(/\bby\b/)
  })

  it('an unrecognised label is still only a date — never an invented route', () => {
    const facts = describeDismissal(AT, [{ kind: 'system', label: 'Who knows', occurred_at: AT }])
    expect(dismissalLine(facts)).toBe('Dismissed 10 Sep')
  })

  it('an automatic route with no actor says what HAPPENED, which is a fact, not a person', () => {
    const facts = describeDismissal(AT, [
      { kind: 'system', label: NO_COVERAGE_LABEL, occurred_at: AT, user_id: null },
    ])
    const line = dismissalLine(facts)!
    expect(line).toContain('no-coverage email was sent')
    expect(line).not.toMatch(/\bby\b/)
  })

  it('resolveName is consulted for an id, and a miss falls back honestly', () => {
    const facts = describeDismissal(AT, [
      { kind: 'system', label: DISMISS_BUTTON_LABEL, occurred_at: AT, user_id: ANDREA },
    ])
    expect(dismissalLine(facts, () => 'Andrea Whitfield')).toContain('by Andrea Whitfield')
    // A roster that cannot cover the id (a corporate admin on a franchise's
    // lead) must NOT invent anything.
    expect(dismissalLine(facts, () => null)).toBe('Dismissed 10 Sep')
  })
})

// ═══════════════════════════════════════════════════════════
// The feed — what actually reaches the browser, and what it costs.
// ═══════════════════════════════════════════════════════════
describe('the feed carries the dismissal', () => {
  const leadRow = (over: any = {}) => ({
    id: 'lead-1', name: 'Courtney Grady', location_uuid: KC,
    created_at: daysAgo(3), ...over,
  })

  it('carries the actor when one was recorded', () => {
    const at = '2026-09-10T19:05:00.000Z'
    const p = mapLeadToPerson(leadRow({ inbox_dismissed_at: at }) as any, {
      touchpoints: [{ id: 't1', kind: 'system', label: NO_COVERAGE_LABEL, occurred_at: at, user_id: ANDREA }],
    } as any)
    expect(p.dismissal).toMatchObject({ at, route: 'no_coverage', actorId: ANDREA })
  })

  it('carries the date with NO actor when none was recorded', () => {
    const at = '2026-09-10T19:05:00.000Z'
    const p = mapLeadToPerson(leadRow({ inbox_dismissed_at: at }) as any, {
      touchpoints: [{ id: 't1', kind: 'system', label: DISMISS_BUTTON_LABEL, occurred_at: at, user_id: null }],
    } as any)
    expect(p.dismissal).toMatchObject({ at, route: 'button', actorId: null, actorName: null })
    expect(dismissalLine(p.dismissal)).toBe('Dismissed 10 Sep')
  })

  it('a lead that is not dismissed carries nothing', () => {
    const p = mapLeadToPerson(leadRow() as any, { touchpoints: [] } as any)
    expect(p.dismissal).toBeNull()
  })

  it('COST: mapping issues no fetch of its own, however many leads', () => {
    const at = '2026-09-10T19:05:00.000Z'
    const before = fetchMock.mock.calls.length
    for (let i = 0; i < 50; i++) {
      mapLeadToPerson(leadRow({ id: `l-${i}`, inbox_dismissed_at: at }) as any, {
        touchpoints: [{ id: `t${i}`, kind: 'system', label: DISMISS_BUTTON_LABEL, occurred_at: at, user_id: ANDREA }],
      } as any)
    }
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('COST: rendering the dismissed view is O(1) in fetches — no per-row lookup', async () => {
    // The N+1 guard, executed rather than asserted about. One dismissed row and
    // twenty-five dismissed rows must cost the SAME number of fetches; a
    // per-row actor lookup would make the second number grow.
    const countFor = async (n: number) => {
      installFetch()
      const rows = Array.from({ length: n }, (_, i) =>
        dismissedWithActor({ personOver: { id: `d-${i}`, name: `Dismissed ${i}` } }))
      const m = await mount(inbox(rows))
      await click(chip(m.host)!)
      return fetchMock.mock.calls.length
    }
    expect(await countFor(25)).toBe(await countFor(1))
  })
})

// ═══════════════════════════════════════════════════════════
// The chip, and the badge it must never touch.
// ═══════════════════════════════════════════════════════════
describe('the Dismissed chip', () => {
  it('is OFF by default — the Inbox looks exactly as it does today', async () => {
    const live = person({ name: 'Live Lead' })
    const gone = dismissedNoActor()
    const m = await mount(inbox([live, gone]))

    expect(m.host.textContent).toContain('Live Lead')
    expect(m.host.textContent).not.toContain('Courtney Grady')
    expect(section(m.host)).toBeNull()
    expect(chip(m.host)!.getAttribute('aria-pressed')).toBe('false')
  })

  it('counts what is hidden', async () => {
    const m = await mount(inbox([
      person({ name: 'Live Lead' }),
      dismissedNoActor({ personOver: { id: 'd1', name: 'Courtney Grady' } }),
      dismissedNoActor({ personOver: { id: 'd2', name: 'Shelby Hoyt' } }),
    ]))
    expect(chip(m.host)!.textContent).toContain('2')
  })

  it('does not render at all when nothing is hidden', async () => {
    const m = await mount(inbox([person({ name: 'Live Lead' })]))
    expect(chip(m.host)).toBeNull()
  })

  it('turning it ON shows dismissed leads; turning it OFF hides them again', async () => {
    const m = await mount(inbox([person({ name: 'Live Lead' }), dismissedNoActor()]))

    await click(chip(m.host)!)
    expect(section(m.host)).not.toBeNull()
    expect(m.host.textContent).toContain('Courtney Grady')
    expect(m.host.textContent).toContain('Live Lead')   // the worklist is untouched

    await click(chip(m.host)!)
    expect(section(m.host)).toBeNull()
    expect(m.host.textContent).not.toContain('Courtney Grady')
  })

  it('shows the shelf even when the live worklist is EMPTY', async () => {
    // The case the empty state would otherwise win: nothing live, something
    // hidden. This is precisely when someone needs to see what is hidden.
    const m = await mount(inbox([dismissedNoActor()]))
    await click(chip(m.host)!)
    expect(m.host.textContent).toContain('Courtney Grady')
  })

  it('a dismissed lead that is ALSO junked stays out — Dismissed is not "everything hidden"', async () => {
    const m = await mount(inbox([
      dismissedNoActor({ personOver: { id: 'dj', name: 'Junked Too', isJunk: true } }),
    ]))
    expect(chip(m.host)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════
// THE #89 REGRESSION GUARD — the most important test in this file.
// ═══════════════════════════════════════════════════════════
describe('#89 guard: the chip is a VIEW toggle, never a removal', () => {
  const shellBase = (over: any = {}) => ({
    engagements: [], people: [], transferPeople: [],
    locFilter: KC, locationRequired: false,
    locations: [{ id: KC, name: 'Kansas City' }],
    locationUsers: roster, currentUserId: 'u1', currentLocationUuid: KC,
    closedCount: 0, closedWonCount: 0,
    ...over,
  })
  const inboxTab = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('button')).find(b => /inbox/i.test(b.textContent || '')) as HTMLButtonElement
  const badgeCount = (host: HTMLElement) => {
    const m = (inboxTab(host).textContent || '').match(/(\d+)/)
    return m ? Number(m[1]) : 0
  }

  it('toggling the chip does NOT move the nav badge count', async () => {
    const m = await mount(React.createElement(HiveShell as any, shellBase({
      people: [
        person({ name: 'Live One' }),
        person({ name: 'Live Two' }),
        dismissedNoActor({ personOver: { id: 'd1', name: 'Courtney Grady' } }),
        dismissedNoActor({ personOver: { id: 'd2', name: 'Shelby Hoyt' } }),
      ],
    })))

    // Two live leads are countable; the two dismissed ones are soft-removed.
    const before = badgeCount(m.host)
    expect(before).toBe(2)

    await act(async () => { inboxTab(m.host).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(badgeCount(m.host)).toBe(before)

    // Reveal the dismissed rows. The badge counts WORK, and a dismissed lead
    // is not work — revealing it must not add it back to the count.
    await click(chip(m.host)!)
    expect(m.host.textContent).toContain('Courtney Grady')
    expect(badgeCount(m.host)).toBe(before)

    // …and hiding them again must not move it either.
    await click(chip(m.host)!)
    expect(badgeCount(m.host)).toBe(before)
  })
})

// ═══════════════════════════════════════════════════════════
// What a dismissed row says.
// ═══════════════════════════════════════════════════════════
describe('a dismissed row says when, and who when we know', () => {
  it('shows WHO and WHEN when the actor was recorded', async () => {
    const p = dismissedWithActor({ personOver: { id: 'dw', name: 'Debra Vargas' } })
    const m = await mount(inbox([p]))
    await click(chip(m.host)!)
    const line = dismissedLine(m.host, p.id)
    expect(line).toContain('Dismissed by Andrea Whitfield')
  })

  it('an AUTOMATIC route now shows its name in the row — the feed carries it', async () => {
    const p = dismissedWithActor({ route: 'no_coverage', personOver: { id: 'nc', name: 'Ashley Devoto' } })
    const m = await mount(inbox([p]))
    await click(chip(m.host)!)
    expect(dismissedLine(m.host, p.id)).toContain('Andrea Whitfield')
  })

  it('a lead with NO recorded actor degrades to the DATE ALONE — no invented person', async () => {
    const p = dismissedNoActor({ personOver: { id: 'na', name: 'Courtney Grady' } })
    const m = await mount(inbox([p]))
    await click(chip(m.host)!)

    const line = dismissedLine(m.host, p.id)
    expect(line).toMatch(/^Dismissed \d/)
    expect(line.toLowerCase()).not.toContain('system')
    expect(line.toLowerCase()).not.toContain('unknown')
    expect(line).not.toMatch(/\bby\b/)
  })

  it('an actor the roster cannot resolve still shows only the date', async () => {
    const at = daysAgo(1)
    const p = person({
      id: 'xl', name: 'Cross Location',
      inboxDismissedAt: at,
      dismissal: { at, route: 'network', actorId: 'u-not-in-roster', actorName: null },
    })
    const m = await mount(inbox([p]))
    await click(chip(m.host)!)
    expect(dismissedLine(m.host, p.id)).not.toMatch(/\bby\b/)
  })
})

// ═══════════════════════════════════════════════════════════
// Put back.
// ═══════════════════════════════════════════════════════════
describe('Put back', () => {
  it('clears inbox_dismissed_at and returns the lead to its real band', async () => {
    const p = dismissedNoActor({ personOver: { id: 'pb', name: 'Courtney Grady' } })
    const patched: any[] = []
    const m = await mount(inbox([p], { onLeadPatched: (id: string, cols: any) => patched.push({ id, cols }) }))
    await click(chip(m.host)!)

    const btn = m.host.querySelector(`[data-testid="put-back-${p.id}"]`) as HTMLButtonElement
    expect(btn, 'a dismissed row carries a durable Put back').toBeTruthy()
    await click(btn)

    // The one write — the same call the toast Undo has always made.
    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({ id: p.id, body: { inbox_dismissed_at: null } })
    // …and it is handed UP so the row re-derives into its real band rather
    // than being locally reassigned.
    expect(patched).toEqual([{ id: p.id, cols: { inbox_dismissed_at: null } }])

    // Re-render with the cleared column, as the page state would: she is back
    // in the worklist, and no longer on the shelf.
    const back = { ...p, inboxDismissedAt: null, dismissal: null }
    await m.rerender(inbox([back], {}))
    expect(m.host.textContent).toContain('Courtney Grady')
    expect(chip(m.host)).toBeNull()
  })

  it('is undoable — a stray click is not permanent either', async () => {
    const p = dismissedNoActor({ personOver: { id: 'pb2', name: 'Courtney Grady' } })
    const m = await mount(inbox([p]))
    await click(chip(m.host)!)
    await click(m.host.querySelector(`[data-testid="put-back-${p.id}"]`)!)

    const kids = React.Children.toArray(lastToast.msg.props.children) as any[]
    const undo = kids.find(k => k?.type === 'button')
    expect(undo, 'Put back offers an Undo').toBeTruthy()
    await act(async () => { await undo.props.onClick() })
    expect(patches[1].body.inbox_dismissed_at).toBeTruthy()
  })

  it('the row verb carries the small-action release class', async () => {
    // globals.css `button{font-size:16px!important}` silently discards an
    // inline fontSize; .bee-small-action is the release stop. Without it this
    // verb renders at 16px and towers over the row it sits in.
    const p = dismissedNoActor({ personOver: { id: 'pb3' } })
    const m = await mount(inbox([p]))
    await click(chip(m.host)!)
    const btn = m.host.querySelector(`[data-testid="put-back-${p.id}"]`) as HTMLButtonElement
    expect(btn.className).toContain('bee-small-action')
  })
})

// ═══════════════════════════════════════════════════════════
// New dismissals record their actor.
// ═══════════════════════════════════════════════════════════
describe('a new dismissal records who did it', () => {
  const moreButton = (host: Element) => host.querySelector('button[aria-label="More"]') as HTMLButtonElement
  const menuButton = (text: string) =>
    [...document.querySelectorAll('[data-bee-row-menu] button')].find(b => (b.textContent || '').trim() === text)

  it('asks the server to attribute the touchpoint to the acting session', async () => {
    const p = person({ id: 'nd', name: 'Sarah Mitchell' })
    const m = await mount(inbox([p]))
    await click(moreButton(m.host))
    await click(menuButton('Dismiss')!)

    expect(touchpointPosts).toHaveLength(1)
    // The identity itself is resolved server-side from the session — the
    // client asks for attribution, it never supplies a user id.
    expect(touchpointPosts[0]).toMatchObject({
      lead_id: p.id, kind: 'system', method: 'system', actor: 'session',
    })
    expect(touchpointPosts[0].label).toBe(DISMISS_BUTTON_LABEL)
    expect(JSON.stringify(touchpointPosts[0])).not.toContain('user_id')
  })

  it('still does exactly what dismiss always did to the lead', async () => {
    const p = person({ id: 'nd2', name: 'Sarah Mitchell' })
    const m = await mount(inbox([p]))
    await click(moreButton(m.host))
    await click(menuButton('Dismiss')!)

    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0].body)).toEqual(['inbox_dismissed_at'])
    expect(m.host.textContent).not.toContain('Sarah Mitchell')
  })
})

// ═══════════════════════════════════════════════════════════
// The line on the lead's own card.
//
// The chip only helps someone who goes LOOKING in the Inbox. Kevin found
// Courtney by opening her record — where, before this, nothing said a thing
// was wrong. The card carries the same sentence, worded by the same module.
// ═══════════════════════════════════════════════════════════
describe('the card line', () => {
  const AT = '2026-09-10T19:05:00.000Z'
  const profilePayload = (over: any = {}) => ({
    client: {
      id: 'lead-9', name: 'Courtney Grady', first_name: 'Courtney', last_name: 'Grady',
      email: 'c@x.com', phone: '(303) 555-0100', address: null, city: null, state: null, zip: null,
      created_at: daysAgo(400), source: 'Website', paused: false, marketing_opt_out: false,
      snoozed_until: null, inbox_dismissed_at: null, assigned_to: null, assigned_to_name: null,
      referred_by_kind: null, referred_by_id: null, referred_by_name: null,
      jobber_client_id: null, location_uuid: KC, location_id: null,
      paid_amount: 0, request_details: null, project_type: null, location_name: 'Central Denver',
      ...(over.client || {}),
    },
    referred_us: [], contacts: [], engagements: [],
    touchpoints: over.touchpoints || [], buzz_notes: [], job_notes: [], tags: [],
    aggregates: { lifetime_paid: 0, invoiced: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
  })

  let profileBody: any
  const installProfileFetch = () => {
    patches = []
    fetchMock = vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url)
      if (/\/api\/leads\/[^/]+$/.test(u) && opts.method === 'PATCH') {
        patches.push({ id: u.split('/').pop()!, body: JSON.parse(opts.body) })
        return jsonRes({ lead: {} })
      }
      if (u.includes('/profile')) return jsonRes(profileBody)
      return jsonRes({})
    })
    ;(globalThis as any).fetch = fetchMock
  }

  const mountCard = async (props: any = {}) => mount(
    React.createElement(ClientProfile as any, {
      clientId: 'lead-9', people: [], onClose: () => {}, setToast,
      lookupOptions: { sources: [], projectTypes: [] }, locationUsers: roster, ...props,
    })
  )
  const notice = (host: Element) => host.querySelector('[data-testid="card-dismissed-notice"]')
  const line = (host: Element) => host.querySelector('[data-testid="card-dismissed-line"]')?.textContent || ''

  it('does NOT appear when the lead is not dismissed', async () => {
    profileBody = profilePayload()
    installProfileFetch()
    const m = await mountCard()
    expect(m.host.textContent).toContain('Courtney Grady')  // the card did render
    expect(notice(m.host)).toBeNull()
  })

  it('appears when the lead IS dismissed, and says it is still live', async () => {
    profileBody = profilePayload({
      client: { inbox_dismissed_at: AT },
      touchpoints: [{ id: 't1', kind: 'system', label: DISMISS_BUTTON_LABEL, occurred_at: AT, user_id: null, user_label: null }],
    })
    installProfileFetch()
    const m = await mountCard()
    expect(notice(m.host)).not.toBeNull()
    expect(m.host.textContent).toContain('still a live lead')
    expect(m.host.textContent).toContain('still receiving your emails')
  })

  it('follows the SAME rule as the row: a known actor is named', async () => {
    profileBody = profilePayload({
      client: { inbox_dismissed_at: AT },
      touchpoints: [{ id: 't1', kind: 'system', label: NO_COVERAGE_LABEL, occurred_at: AT, user_id: ANDREA, user_label: 'Andrea Whitfield' }],
    })
    installProfileFetch()
    const m = await mountCard()
    expect(line(m.host)).toContain('Dismissed by Andrea Whitfield')
  })

  it('follows the SAME rule as the row: no actor means the date alone', async () => {
    profileBody = profilePayload({
      client: { inbox_dismissed_at: AT },
      touchpoints: [{ id: 't1', kind: 'system', label: DISMISS_BUTTON_LABEL, occurred_at: AT, user_id: null, user_label: null }],
    })
    installProfileFetch()
    const m = await mountCard()
    const text = line(m.host)
    expect(text).toBe('Dismissed 10 Sep')
    expect(text.toLowerCase()).not.toContain('system')
    expect(text.toLowerCase()).not.toContain('unknown')
    expect(text).not.toMatch(/\bby\b/)
  })

  it('does NOT promise emails that have been paused (a Network move pauses them)', async () => {
    profileBody = profilePayload({
      client: { inbox_dismissed_at: AT, paused: true },
      touchpoints: [{ id: 't1', kind: 'system', label: 'Moved to Network as Amy McNeal — drips paused', occurred_at: AT, user_id: ANDREA, user_label: 'Andrea Whitfield' }],
    })
    installProfileFetch()
    const m = await mountCard()
    expect(m.host.textContent).not.toContain('still receiving your emails')
    expect(m.host.textContent).toContain('emails are paused')
  })

  it('offers Put back, which clears inbox_dismissed_at', async () => {
    profileBody = profilePayload({
      client: { inbox_dismissed_at: AT },
      touchpoints: [{ id: 't1', kind: 'system', label: DISMISS_BUTTON_LABEL, occurred_at: AT, user_id: null }],
    })
    installProfileFetch()
    const m = await mountCard()
    const btn = m.host.querySelector('[data-testid="card-put-back"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.className).toContain('bee-small-action')   // the 16px floor release
    await click(btn)
    expect(patches).toEqual([{ id: 'lead-9', body: { inbox_dismissed_at: null } }])
    expect(notice(m.host)).toBeNull()   // the notice clears with the state
  })
})
