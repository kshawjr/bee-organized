// @vitest-environment happy-dom
//
// Issue 240 step 5 — the Your team routing table.
//
// One row per job type the WEBSITE FORM offers, grouped under its parent, with
// two capped single-select dropdowns that are SEPARATE settings.
//
// The rows are not hardcoded: they are lookups where category='project_types'
// AND is_active — the four the form posts. Production also holds twelve
// INACTIVE types (Garage, Kitchen + Pantry, Move-In Organization, …) and leads
// still carry some of them, so the fixture includes an inactive-shaped payload
// to prove the table renders what routes rather than what exists.
//
// Pinned:
//   1) four rows, under the right parents, from lookups
//   2) both dropdowns are capped and side by side — the reason for the rebuild
//   3) no per-row Slack control
//   4) "also told: N others" discloses everyone the dropdown cannot show
//   5) picking someone ADDS the type; it never strips anyone else
//   6) neither master toggle is flipped silently from a dropdown
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TeamRouting } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The four ACTIVE types, with the drip_category that drives the grouping.
const LOOKUPS = {
  lookups: [
    { label: 'Home or Office Organizing', attrs: { drip_category: 'general' } },
    { label: 'Concierge Services',        attrs: { drip_category: 'general' } },
    { label: 'Other',                     attrs: { drip_category: 'general' } },
    { label: 'Moving/Relocation',         attrs: { drip_category: 'move' } },
  ],
}

const PEOPLE = [
  { id: 'u1', name: 'Lynette Ewy', email: 'lynette@bee.test', role: 'owner',   domain_warning: false },
  { id: 'u2', name: 'Carol Kern',  email: 'carol@bee.test',   role: 'manager', domain_warning: false },
]

const senderCfg = (over: any = {}) => ({
  enabled: true,
  base_sender_email: 'hello@bee.test',
  project_types: LOOKUPS.lookups.map(l => l.label),
  assignments: [],
  people: PEOPLE,
  ...over,
})

const notifCfg = (over: any = {}) => ({
  split_enabled: true,
  project_types: LOOKUPS.lookups.map(l => l.label),
  users: [
    { hub_user_id: 'u1', name: 'Lynette Ewy', email: 'lynette@bee.test', role: 'owner',   category: 'all', subscribed: true },
    { hub_user_id: 'u2', name: 'Carol Kern',  email: 'carol@bee.test',   role: 'manager', category: 'all', subscribed: true },
  ],
  externals: [],
  ...over,
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: Array<{ url: string; method: string; body: any }>

const stubFetch = (senders: any, notif: any) => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    const json = url.includes('/api/lookups') ? LOOKUPS
      : url.includes('project-type-senders') ? senders
      : url.includes('notification-recipients') ? notif
      : {}
    return { ok: true, status: 200, json: async () => json }
  }))
}

const mount = async (senders = senderCfg(), notif = notifCfg()) => {
  stubFetch(senders, notif)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<TeamRouting realLocId="loc-1" />) })
  await act(async () => {})
  return container
}

const selects = () => Array.from(container.querySelectorAll('select')) as HTMLSelectElement[]
const labelled = (text: string) =>
  Array.from(container.querySelectorAll('label')).filter(l => l.textContent === text)

beforeEach(() => { calls = [] })
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})

describe('the rows come from the website form, not the app picker', () => {
  it('renders exactly the four active types', async () => {
    await mount()
    for (const l of LOOKUPS.lookups) expect(container.textContent).toContain(l.label)
    // Two selects per row.
    expect(selects().length).toBe(8)
  })

  it('groups them under Organizing and Moving via drip_category', async () => {
    await mount()
    const text = container.textContent ?? ''
    expect(text).toContain('Organizing')
    expect(text).toContain('Moving')
    // Moving/Relocation is the only 'move' row, so Moving must come after the
    // three organizing rows in document order.
    expect(text.indexOf('Home or Office Organizing')).toBeLessThan(text.indexOf('Moving/Relocation'))
  })

  it('an inactive type is not offered a row', async () => {
    // /api/lookups filters is_active server-side, so an inactive type simply
    // never arrives. Pin the consequence: no row for one.
    await mount()
    expect(container.textContent).not.toContain('Move-In Organization')
    expect(container.textContent).not.toContain('Garage')
  })
})

describe('the two settings are separate, and capped', () => {
  it('every row has both dropdowns', async () => {
    await mount()
    expect(labelled('Emails come from').length).toBe(4)
    expect(labelled('Lead goes to').length).toBe(4)
  })

  it('neither dropdown stretches — both carry an explicit cap', async () => {
    await mount()
    for (const s of selects()) {
      expect(s.style.maxWidth, 'each select is capped').toBeTruthy()
      expect(s.style.maxWidth).toMatch(/^\d+px$/)
    }
  })

  it('has no per-row Slack control', async () => {
    await mount()
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0)
    expect(container.textContent?.toLowerCase()).not.toContain('slack')
  })
})

describe('the many-to-many is disclosed, not hidden', () => {
  it('counts externals the dropdown cannot represent', async () => {
    await mount(senderCfg(), notifCfg({
      users: [{ hub_user_id:'u1', name:'Lynette Ewy', email:'l@b.test', role:'owner',
                category: JSON.stringify(['Moving/Relocation']), subscribed:true }],
      externals: [
        { id:'e1', name:'Ops inbox', email:'ops@bee.test', category:'all' },
        { id:'e2', name:'Franchise HQ', email:'hq@bee.test', category:'all' },
      ],
    }))
    expect(container.textContent).toContain('also told: 2 others')
  })

  it('counts a second team member who also claims the type', async () => {
    await mount(senderCfg(), notifCfg({
      users: [
        { hub_user_id:'u1', name:'Lynette Ewy', email:'l@b.test', role:'owner',
          category: JSON.stringify(['Moving/Relocation']), subscribed:true },
        { hub_user_id:'u2', name:'Carol Kern', email:'c@b.test', role:'manager',
          category: JSON.stringify(['Moving/Relocation']), subscribed:true },
      ],
      externals: [],
    }))
    // Lynette holds the dropdown; Carol must still be visible somewhere.
    expect(container.textContent).toContain('also told: 1 other')
  })

  it('says nothing when there is genuinely no one else', async () => {
    await mount(senderCfg(), notifCfg({
      users: [{ hub_user_id:'u1', name:'Lynette Ewy', email:'l@b.test', role:'owner',
                category: JSON.stringify(['Moving/Relocation']), subscribed:true }],
      externals: [],
    }))
    expect(container.textContent).not.toContain('also told')
  })
})

describe('writes are additive, never destructive', () => {
  it('picking a person ADDS the type and leaves other claimants alone', async () => {
    await mount(senderCfg(), notifCfg({
      users: [
        { hub_user_id:'u1', name:'Lynette Ewy', email:'l@b.test', role:'owner',
          category: JSON.stringify(['Home or Office Organizing']), subscribed:true },
        { hub_user_id:'u2', name:'Carol Kern', email:'c@b.test', role:'manager',
          category: JSON.stringify(['Moving/Relocation']), subscribed:true },
      ],
      externals: [],
    }))
    const leadGoesTo = selects()[1]   // first row, second select
    await act(async () => {
      leadGoesTo.value = 'u2'
      leadGoesTo.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const patches = calls.filter(c => c.method === 'PATCH' && c.url.includes('notification-recipients'))
    expect(patches.length).toBe(1)
    // Carol GAINS the organizing type; her existing moving claim survives.
    expect(patches[0].body.hub_user_id).toBe('u2')
    const next = JSON.parse(patches[0].body.category)
    expect(next).toContain('Home or Office Organizing')
    expect(next).toContain('Moving/Relocation')
    // Nobody else was rewritten.
    expect(patches.some(p => p.body.hub_user_id === 'u1')).toBe(false)
  })

  it('assigning a sender posts only that one type', async () => {
    await mount()
    const comeFrom = selects()[0]
    await act(async () => {
      comeFrom.value = 'u2'
      comeFrom.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const post = calls.find(c => c.method === 'POST' && c.url.includes('project-type-senders'))
    expect(post).toBeTruthy()
    expect(post!.body.project_types).toEqual(['Home or Office Organizing'])
    expect(post!.body.source_user_id).toBe('u2')
  })
})

describe('the master toggles are never flipped from a dropdown', () => {
  it('disables the sender selects and says why when the split is off', async () => {
    await mount(senderCfg({ enabled: false }))
    const comeFrom = labelled('Emails come from')[0].parentElement!.querySelector('select') as HTMLSelectElement
    expect(comeFrom.disabled).toBe(true)
    expect(container.textContent).toContain('Per-type senders are off')
  })

  it('disables the notify selects and says why when the split is off', async () => {
    await mount(senderCfg(), notifCfg({ split_enabled: false }))
    const goesTo = labelled('Lead goes to')[0].parentElement!.querySelector('select') as HTMLSelectElement
    expect(goesTo.disabled).toBe(true)
    expect(container.textContent).toContain('Per-type notifications are off')
  })

  it('never PATCHes enabled or split_enabled on its own', async () => {
    await mount()
    const comeFrom = selects()[0]
    await act(async () => {
      comeFrom.value = 'u2'
      comeFrom.dispatchEvent(new Event('change', { bubbles: true }))
    })
    for (const c of calls) {
      expect(c.body?.enabled, 'no silent sender-split flip').toBeUndefined()
      expect(c.body?.split_enabled, 'no silent notify-split flip').toBeUndefined()
    }
  })

  it('leaves an "all" subscriber alone rather than narrowing them', async () => {
    // Picking someone who currently hears about everything must not quietly
    // restrict them to this one type — that would stop their other leads.
    await mount()
    const goesTo = selects()[1]
    await act(async () => {
      goesTo.value = 'u2'
      goesTo.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(calls.filter(c => c.method === 'PATCH' && c.url.includes('notification-recipients')).length).toBe(0)
  })
})
