// @vitest-environment happy-dom
//
// THREE ONBOARDING AND LANDING FIXES — from Kevin watching a real owner go
// through onboarding (2026-10-21).
//
// 1) THE LOCATION PHONE IS ASKED FOR ON ITS OWN. It used to fall back to the
//    owner's personal phone in three places (the form prefill, the save, the
//    readiness gate), so an owner could never keep their own number out of
//    client emails. Kevin's ruling: both numbers, typed separately, even
//    when they are the same. The location phone now gets the same 10-digit
//    check the personal phone has. Proven by mounting the real
//    OnboardingScreen on the location step and reading the PATCH it sends.
//
// 2) THE CLIENTS PAGE OPENS ON INBOX. Only the default changes: a lens the
//    owner already picked is still read back from localStorage and wins.
//
// 3) THE INBOX SORTS NEWEST FIRST. Reverses the 2026-09-03 oldest-first
//    call. A stored sort still wins, and the Needs-transfer queue stays
//    oldest-first whatever the Inbox sort says, because it is a queue.
//
// The flipped lens default means InboxScreen now mounts and unmounts on
// every load headed for Engagements or Client List — the same path that
// once clobbered the board sort (beta-stored-controls-hydration.test.tsx).
// The last block pins that bee_hive_inbox_sort survives it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OnboardingScreen, CurrentLocationContext, CurrentUserContext } from '@/components/BeeHub'
import HiveShell from '@/components/hive/HiveShell'
import InboxScreen from '@/components/hive/InboxScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// happy-dom v20 ships no localStorage.
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

let patches: Array<{ url: string, body: any }> = []
let root: any = null

beforeEach(() => {
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
  patches = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    if (init?.method === 'PATCH') patches.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ rows: [], total: 0 }) } as any
  }))
  document.body.innerHTML = ''
})
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null
  vi.unstubAllGlobals()
  lsStore.clear()
  document.body.innerHTML = ''
})

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  return host
}
const click = (el: Element | null | undefined) => act(async () => {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
// React tracks a controlled input's value through the native setter.
const type = (el: HTMLInputElement, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})

// ── 1) onboarding: the location phone ───────────────────────────
const PERSONAL = '(503) 555-0101'
const user = { id: 'u-1', first_name: 'Jane', last_name: 'Smith', email: 'jane@beeorganized.com', phone: PERSONAL }
const loc = (over: any = {}) => ({
  id: 'loc-1', name: 'Portland',
  address: '12 Oak St', city: 'Portland', state: 'OR', zip: '97201',
  phone: null, timezone: 'Pacific Time (PT)',
  sender_name: 'Jane Smith', send_from_email: 'jane@beeorganized.com', reply_to_email: 'jane@beeorganized.com',
  reviews_link: 'https://g.page/bee-organized-portland/review',
  onboarding_state: { completedSteps: { welcome: true, pay: true, profile: true }, activeStepOpen: 'location' },
  ...over,
})

const openLocationStep = (locOver: any = {}) => mount(
  <CurrentUserContext.Provider value={user as any}>
    <CurrentLocationContext.Provider value={loc(locOver) as any}>
      <OnboardingScreen ownerName="Jane Smith" ownerEmail="jane@beeorganized.com" />
    </CurrentLocationContext.Provider>
  </CurrentUserContext.Provider>,
)
const locationPhoneInput = () => {
  const label = [...document.querySelectorAll('p')].find(p => p.textContent === '📞 Location Phone')
  return label?.parentElement?.parentElement?.querySelector('input[type=tel]') as HTMLInputElement
}
const saveButton = () => [...document.querySelectorAll('button')]
  .find(b => /Save & Complete|Fill in all required fields/.test(b.textContent || '')) as HTMLButtonElement

describe('onboarding — the location phone is its own number', () => {
  it('the location form does not prefill from the personal phone', async () => {
    await openLocationStep()
    expect(locationPhoneInput()).toBeTruthy()
    expect(locationPhoneInput().value).toBe('')
  })

  it("the location form still starts from the location's own saved phone", async () => {
    await openLocationStep({ phone: '(503) 555-0199' })
    expect(locationPhoneInput().value).toBe('(503) 555-0199')
  })

  it('the step is not ready with the location phone empty, even with a personal phone on file', async () => {
    await openLocationStep()
    expect(saveButton().disabled).toBe(true)
    expect(saveButton().textContent).toBe('Fill in all required fields')
  })

  it('a location phone under 10 digits is refused', async () => {
    await openLocationStep()
    await type(locationPhoneInput(), '555-0101')
    expect(saveButton().disabled).toBe(true)
    expect(document.body.textContent).toContain('Needs 10 digits')
  })

  it('a 10-digit location phone makes the step ready', async () => {
    await openLocationStep()
    await type(locationPhoneInput(), '(503) 555-0199')
    expect(saveButton().disabled).toBe(false)
  })

  it("the saved payload carries the location field's value, never the profile value", async () => {
    await openLocationStep()
    await type(locationPhoneInput(), '(503) 555-0199')
    await click(saveButton())
    const sent = patches.find(p => p.url === '/api/locations/loc-1')
    expect(sent).toBeTruthy()
    expect(sent!.body.phone).toBe('(503) 555-0199')
    expect(sent!.body.phone).not.toBe(PERSONAL)
  })

  // The gate keeps the button off while the location phone is empty, so a
  // fallback in the save can never be reached through the screen. Pinned
  // off the source instead: the save writes the location field and nothing
  // else.
  it('the save never falls back to the profile phone (source)', () => {
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    const start = src.indexOf('async function saveLocation()')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf("markDone('location')", start))
    expect(body).toMatch(/phone:\s+locationForm\.phone,/)
    expect(body).not.toMatch(/profileForm\.phone/)
  })

  it('the same number typed twice is accepted and saved as typed', async () => {
    await openLocationStep()
    await type(locationPhoneInput(), PERSONAL)
    await click(saveButton())
    expect(patches.find(p => p.url === '/api/locations/loc-1')!.body.phone).toBe(PERSONAL)
  })

  it('the old "Prefilled from your profile" wording is gone from the phone field', async () => {
    await openLocationStep({ phone: PERSONAL })
    const field = locationPhoneInput().parentElement!
    expect(field.textContent).not.toMatch(/Prefilled from your profile/)
    expect(field.textContent).toMatch(/separately on purpose/)
  })
})

// ── 2) the Clients page lens ────────────────────────────────────
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const LOCATIONS = [{ id: 'loc-uuid-1', name: 'Portland' }]

describe('HiveShell — which lens the Clients page opens on', () => {
  const lensesSeen = async () => {
    const seen: string[] = []
    await mount(<HiveShell engagements={[] as any} people={[] as any} locations={LOCATIONS as any}
      onLensChange={(l: string) => seen.push(l)} />)
    return seen
  }

  it('with nothing in localStorage, the lens is inbox', async () => {
    const seen = await lensesSeen()
    expect(seen[seen.length - 1]).toBe('inbox')
  })

  it('with engagements saved, the saved choice still wins', async () => {
    lsStore.set('bee_hive_beta_lens', 'engagements')
    const seen = await lensesSeen()
    expect(seen[seen.length - 1]).toBe('engagements')
  })

  it('with clients saved, the saved choice still wins', async () => {
    lsStore.set('bee_hive_beta_lens', 'clients')
    const seen = await lensesSeen()
    expect(seen[seen.length - 1]).toBe('clients')
  })
})

// ── 3) the Inbox sort ───────────────────────────────────────────
const person = (id: string, name: string, ageDays: number, over: any = {}) => ({
  id, name, email: `${id}@x.com`, phone: '(503) 555-0000',
  locationId: 'loc-uuid-1', created: daysAgo(ageDays),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null,
  jobberRef: null, outreachTimeline: [], ...over,
})
const PEOPLE = [
  person('p-mid', 'Bea Middle', 5),
  person('p-old', 'Ada Oldest', 9),
  person('p-new', 'Cy Newest', 1),
]
const TRANSFER = [
  person('t-new', 'Tia Transfer Newest', 2, { atLocOther: true }),
  person('t-old', 'Tom Transfer Oldest', 8, { atLocOther: true }),
]
const order = (names: string[]) => {
  const text = document.body.textContent || ''
  return names.map(n => ({ n, i: text.indexOf(n) })).filter(x => x.i >= 0).sort((a, b) => a.i - b.i).map(x => x.n)
}
const openInbox = () => mount(<InboxScreen people={PEOPLE as any} transferPeople={TRANSFER as any}
  engagements={[]} locFilter="all" locations={LOCATIONS as any} setToast={() => {}} />)

describe('InboxScreen — sort order', () => {
  it('with nothing stored, the sort is newest first and the rows come back that way', async () => {
    await openInbox()
    expect(order(['Ada Oldest', 'Bea Middle', 'Cy Newest'])).toEqual(['Cy Newest', 'Bea Middle', 'Ada Oldest'])
    expect(JSON.parse(lsStore.get('bee_hive_inbox_sort') || '{}').key).toBe('newest')
  })

  it('a stored sort that no longer exists falls back to newest first', async () => {
    lsStore.set('bee_hive_inbox_sort', JSON.stringify({ key: 'retired_sort' }))
    await openInbox()
    expect(order(['Ada Oldest', 'Bea Middle', 'Cy Newest'])).toEqual(['Cy Newest', 'Bea Middle', 'Ada Oldest'])
  })

  it("with 'oldest' stored, it is still oldest first", async () => {
    lsStore.set('bee_hive_inbox_sort', JSON.stringify({ key: 'oldest' }))
    await openInbox()
    expect(order(['Ada Oldest', 'Bea Middle', 'Cy Newest'])).toEqual(['Ada Oldest', 'Bea Middle', 'Cy Newest'])
  })

  it('the Needs-transfer queue is oldest first under the newest-first default', async () => {
    await openInbox()
    expect(order(['Tia Transfer Newest', 'Tom Transfer Oldest'])).toEqual(['Tom Transfer Oldest', 'Tia Transfer Newest'])
  })

  it("the Needs-transfer queue is oldest first under a stored 'oldest' sort too", async () => {
    lsStore.set('bee_hive_inbox_sort', JSON.stringify({ key: 'oldest' }))
    await openInbox()
    expect(order(['Tia Transfer Newest', 'Tom Transfer Oldest'])).toEqual(['Tom Transfer Oldest', 'Tia Transfer Newest'])
  })
})

// ── 4) the flipped default does not wipe a saved Inbox sort ─────
describe('a saved Inbox sort survives loads headed away from the Inbox', () => {
  for (const lens of ['engagements', 'clients']) {
    it(`keeps a saved Inbox sort when the saved lens is ${lens}`, async () => {
      lsStore.set('bee_hive_beta_lens', lens)
      lsStore.set('bee_hive_inbox_sort', JSON.stringify({ key: 'name' }))
      await mount(<HiveShell engagements={[] as any} people={PEOPLE as any} locations={LOCATIONS as any} />)
      expect(lsStore.get('bee_hive_inbox_sort')).toBe(JSON.stringify({ key: 'name' }))
    })
  }
})
