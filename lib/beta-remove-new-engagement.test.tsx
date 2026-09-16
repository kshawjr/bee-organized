// @vitest-environment happy-dom
//
// "NEW ENGAGEMENT" IS GONE FROM THE CLIENT CARD.
//
// I stopped this twice and both times the evidence said stop. The third look
// settled it, and it is worth recording because the first two figures were
// the misleading ones. Over 120 days, 125 engagements were founded by hand
// (excluding the Close flow, which founds-and-closes and is a different
// thing). They split two ways:
//   · 78 went on to carry real Jobber records — a request, a quote, a job.
//     For those the button was only an early container; Send to Jobber would
//     have produced one anyway.
//   · 47 stayed COMPLETELY empty. No request, no quote, no job. Every one of
//     them sits at Request and can NEVER move, because nothing is coming from
//     Jobber to attach. 20 locations, newest created the day before this was
//     written — so it was still happening.
// Either the button duplicated Jobber's own path or it produced a permanent
// empty card. That is why it went.
//
// THE CAPABILITY IS NOT REMOVED, and this file pins that too. POST
// /api/engagements still serves NewClientSheet and the Close flow, and
// NewClientSheet's frame B founds on a MATCHED EXISTING client with the
// identical call — so a client who will never touch Jobber can still be
// started, via New → search them → found it there.
//
// THE LAYOUT IS THE SUBTLE PART. ActionRow sizes its grid from the CHILD
// COUNT, so removing one action re-flows the row: a normal writable card goes
// from four columns to three. That is asserted directly, because it is the
// kind of thing a future edit breaks silently.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

let profileOver: any = {}
const profilePayload = () => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'd@e.com', phone: '(561) 555-0100', address: '12 Oak St', stage: 'New',
    created_at: daysAgo(30), tags: [], jobber_client_id: null, is_junk: false,
    snoozed_until: null, inbox_dismissed_at: null, assigned_to: null,
    location_id: 'loc_real', marketing_opt_out: false, paused: false,
    ...(profileOver.client || {}),
  },
  referred_us: [], referred_us_total: 0, contacts: [],
  engagements: profileOver.engagements ?? [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { owing: 0, paid: 0, invoiced: 0 },
})

let posts: any[] = []
beforeEach(() => {
  posts = []; profileOver = {}
  ;(globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url); const method = init?.method || 'GET'
    if (method === 'POST') posts.push({ u, body: init?.body ? JSON.parse(init.body) : null })
    if (/\/profile/.test(u)) return { ok: true, json: async () => profilePayload() } as any
    if (/\/api\/engagements$/.test(u)) return { ok: true, json: async () => ({ engagement: { id: 'eng-N' } }) } as any
    return { ok: true, json: async () => ({}) } as any
  })
  document.body.innerHTML = ''
})

let root: any
const mount = async (over: any = {}) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<ClientProfile clientId="lead-9" people={[]} onClose={() => {}} setToast={() => {}}
      onSendToJobber={() => {}} lookupOptions={{ sources: [], projectTypes: [], clientTags: [] } as any}
      locationUsers={[] as any} {...over} />)
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return host
}
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null; document.body.innerHTML = ''; vi.restoreAllMocks()
})
const bar = (host: Element) => host.querySelector('[aria-label="Card actions"]')!
const grid = (host: Element) => bar(host).firstElementChild as HTMLElement

describe('the button is absent from the card action bar', () => {
  it('for an ordinary writable client', async () => {
    const host = await mount()
    expect((bar(host).textContent || '')).not.toContain('New engagement')
  })

  it('for a client who has never had an engagement — the case I twice protected', async () => {
    // Protecting it was right on the old evidence and is wrong on the new:
    // this is exactly the shape that produced the 47 permanent empties.
    profileOver = { engagements: [] }
    const host = await mount()
    expect((bar(host).textContent || '')).not.toContain('New engagement')
  })

  it('for a returning client with a closed engagement', async () => {
    profileOver = { engagements: [{ id: 'e1', stage: 'Closed Won', title: 'Garage', created_at: daysAgo(90), closed_at: daysAgo(80) }] }
    const host = await mount()
    expect((bar(host).textContent || '')).not.toContain('New engagement')
  })

  it('and nowhere else on the card either', async () => {
    const host = await mount()
    expect(host.textContent || '').not.toContain('New engagement')
  })

  it('the handler that called it is gone too, not just the button', () => {
    const src = readFileSync(join(process.cwd(), 'components/hive/ClientProfile.jsx'), 'utf8')
    expect(src).not.toContain('async function newEngagement')
    expect(src).not.toContain('onClick={newEngagement}')
    // and the card no longer POSTs an engagement at all
    expect(src).not.toMatch(/fetch\('\/api\/engagements',\s*\{/)
  })
})

describe('the action bar still lays out correctly', () => {
  it('a normal writable card is THREE columns — ActionRow reads the child count', async () => {
    // Call + Log touchpoint + Send to Jobber. It was four.
    const host = await mount()
    expect(grid(host).style.gridTemplateColumns).toBe('repeat(3, 1fr)')
    expect(grid(host).children).toHaveLength(3)
  })

  it('each remaining action is its own child, not one wrapped block', async () => {
    const host = await mount()
    const text = bar(host).textContent || ''
    expect(text).toContain('Call')
    expect(text).toContain('Log touchpoint')
    expect(text).toContain('Send to Jobber')
  })

  it('a jobber-linked client still gets Open in Jobber, still three columns', async () => {
    profileOver = { client: { jobber_client_id: 'jc-1' } }
    const host = await mount()
    expect((bar(host).textContent || '')).toContain('Open in Jobber')
    expect(grid(host).style.gridTemplateColumns).toBe('repeat(3, 1fr)')
  })

  it('a client with no phone drops to TWO — the count follows the children', async () => {
    profileOver = { client: { phone: null } }
    const host = await mount()
    expect(grid(host).children).toHaveLength(2)
    expect(grid(host).style.gridTemplateColumns).toBe('repeat(2, 1fr)')
  })

  it('a read-only card keeps only what it could already do', async () => {
    const host = await mount({ readOnly: true })
    const text = bar(host).textContent || ''
    expect(text).not.toContain('Log touchpoint')
    expect(text).not.toContain('New engagement')
  })
})

describe('loc_other is untouched — Transfer is still its only action', () => {
  it('one column, Transfer, nothing else', async () => {
    profileOver = { client: { location_id: 'loc_other' } }
    const host = await mount()
    const text = bar(host).textContent || ''
    expect(text).toContain('Transfer')
    expect(text).not.toContain('New engagement')
    expect(text).not.toContain('Log touchpoint')
    expect(grid(host).children).toHaveLength(1)
    expect(grid(host).style.gridTemplateColumns).toBe('repeat(1, 1fr)')
  })
})

describe('the capability survives — this removed a button, not a route', () => {
  it('POST /api/engagements still exists and still founds manually', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/engagements/route.ts'), 'utf8')
    expect(route).toContain('foundManualEngagement')
    const lib = readFileSync(join(process.cwd(), 'lib/engagements.ts'), 'utf8')
    expect(lib).toContain("founded_by: 'manual'")
  })

  it('the CLOSE flow still founds through it — pinned specifically', () => {
    // Close founds AND closes a Closed Lost engagement for a lead that never
    // had one. It is the single biggest caller and must not have been caught
    // by this removal.
    const wiz = readFileSync(join(process.cwd(), 'components/hive/shared/CloseLostWizard.jsx'), 'utf8')
    expect(wiz).toContain("fetch('/api/engagements'")
    expect(wiz).toContain('reuse_open')
  })

  it('NewClientSheet still founds — including on a MATCHED EXISTING client', () => {
    // This is the answer to "is there any way left to start work on a client
    // who will never touch Jobber": yes — New → search them → found it there.
    const sheet = readFileSync(join(process.cwd(), 'components/hive/NewClientSheet.jsx'), 'utf8')
    expect(sheet).toContain("fetch('/api/engagements'")
    expect(sheet).toContain('foundEngagementFor')
    expect(sheet).toContain('m.person.id')   // an existing matched person
  })
})
