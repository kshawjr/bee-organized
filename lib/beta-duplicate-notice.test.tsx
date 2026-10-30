// @vitest-environment happy-dom
// lib/beta-duplicate-notice.test.tsx
// ─────────────────────────────────────────────────────────────
// Showing the duplicate flag (29 Oct 2026). leads.possible_duplicate_of was
// write-only: Andrea Stevens (Central Denver) opened a flagged copy of Shirley
// Ann Morgan and nothing on it said it was one. Taking the copy off the Inbox
// only hid it from the Inbox.
//
//   - the flag's shape: a JSONB ARRAY of ids (tolerates a lone string, never
//     its own id, never a repeat)
//   - the card shows the notice with the other record's NAME, as a link
//   - two or more ids: all shown
//   - a junked or missing target: no crash, said plainly
//   - no flag: no notice
//   - the New client sheet, refused by the server's own check, opens the
//     existing record instead of showing an error
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import NewClientSheet from '@/components/hive/NewClientSheet'
import { duplicateIdsOf, resolveDuplicateOf } from '@/components/hive/shared/duplicateFlag'

// The sheet's browser-side gate (queryLeadMatches over the browser client):
// rows put here come back whatever the filter.
let gateRows: any[] = []
vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    const chain: any = {
      from: () => chain, select: () => chain, or: () => chain, not: () => chain,
      range: () => chain, eq: () => chain, in: () => chain,
      // the card's live-contacts subscription (not under test here)
      channel: () => { const ch: any = { on: () => ch, subscribe: () => ch, unsubscribe: () => {} }; return ch },
      removeChannel: () => {},
      then: (res: any, rej: any) => Promise.resolve({ data: gateRows, error: null }).then(res, rej),
    }
    return chain
  },
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })

const profilePayload = (client: any = {}) => ({
  client: {
    id: 'copy-2de9', name: 'Shirley Ann Morgan', email: 'smorganwre@yahoo.com', phone: '(702) 764-9862',
    created_at: new Date().toISOString(), source: 'Website', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null, jobber_client_id: null,
    location_uuid: 'loc-uuid-1', location_id: 'loc_centraldenver', paid_amount: 0,
    request_details: null, project_type: null, location_name: 'Central Denver',
    ...client,
  },
  referred_us: [], contacts: [], engagements: [], touchpoints: [], buzz_notes: [], job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})

let profileClient: any = {}
let leadPost: (body: any) => any = () => jsonRes({})
beforeEach(() => {
  document.body.innerHTML = ''
  profileClient = {}
  leadPost = () => jsonRes({})
  gateRows = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/profile')) return jsonRes(profilePayload(profileClient))
    if (u.endsWith('/api/leads') && opts.method === 'POST') return leadPost(JSON.parse(opts.body))
    if (u.includes('/api/lookups')) return jsonRes({ lookups: [] })
    return jsonRes({})
  })
})

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const type = (input: Element, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const notice = (host: Element) => host.querySelector('[data-testid="duplicate-notice"]')
const items = (host: Element) => Array.from(host.querySelectorAll('[data-testid="duplicate-notice-item"]'))

describe('possible_duplicate_of — reading the stored value', () => {
  it('is an ARRAY of ids; a lone string is tolerated; anything else is no flag', () => {
    expect(duplicateIdsOf(['a', 'b'])).toEqual(['a', 'b'])
    expect(duplicateIdsOf('a')).toEqual(['a'])
    expect(duplicateIdsOf(null)).toEqual([])
    expect(duplicateIdsOf({ id: 'a' })).toEqual([])
    expect(duplicateIdsOf(['a', 7, null, '', 'a'])).toEqual(['a'])
  })
  it('never lists the record itself', () => {
    expect(duplicateIdsOf(['self', 'other'], 'self')).toEqual(['other'])
  })
  it('resolves each id to ok / junk / gone, in stored order', () => {
    const out = resolveDuplicateOf(['real', 'binned', 'deleted'], [
      { id: 'binned', name: 'Old Copy', is_junk: true },
      { id: 'real', name: 'Shirley Ann Morgan', is_junk: false },
    ])
    expect(out).toEqual([
      { id: 'real', name: 'Shirley Ann Morgan', state: 'ok' },
      { id: 'binned', name: 'Old Copy', state: 'junk' },
      { id: 'deleted', name: null, state: 'gone' },
    ])
  })
})

describe('the client card shows the flag', () => {
  it("shows the notice with the other record's name, and opens it", async () => {
    profileClient = { duplicate_of: [{ id: 'real-072e', name: 'Shirley Ann Morgan', state: 'ok' }] }
    const onOpenClient = vi.fn()
    const { host, unmount } = await mount(<ClientProfile clientId="copy-2de9" onClose={() => {}} onOpenClient={onOpenClient} />)
    expect(notice(host)?.textContent).toContain('This may be a copy of another client')
    const link = Array.from(notice(host)!.querySelectorAll('button')).find(b => b.textContent === 'Shirley Ann Morgan')!
    expect(link).toBeTruthy()
    await click(link)
    expect(onOpenClient).toHaveBeenCalledWith('real-072e')
    await unmount()
  })

  it('shows every id when the record carries two or more', async () => {
    profileClient = { duplicate_of: [
      { id: 'a', name: 'Shirley Morgan', state: 'ok' },
      { id: 'b', name: 'S. A. Morgan', state: 'ok' },
      { id: 'c', name: 'Shirley M', state: 'ok' },
    ] }
    const { host, unmount } = await mount(<ClientProfile clientId="copy-2de9" onClose={() => {}} />)
    expect(notice(host)?.textContent).toContain('This may be a copy of 3 other clients')
    expect(items(host).map((i: Element) => i.textContent)).toEqual(['Shirley Morgan', 'S. A. Morgan', 'Shirley M'])
    await unmount()
  })

  it('a junked or missing target does not crash the page — it is said plainly', async () => {
    profileClient = { duplicate_of: [
      { id: 'binned', name: 'Old Copy', state: 'junk' },
      { id: 'deleted', name: null, state: 'gone' },
    ] }
    const { host, unmount } = await mount(<ClientProfile clientId="copy-2de9" onClose={() => {}} />)
    // the rest of the card still rendered
    expect(host.textContent).toContain('Shirley Ann Morgan')
    const [junk, gone] = items(host)
    expect(junk.textContent).toBe('Old Copy · in the bin')
    expect(gone.textContent).toBe("A record that's no longer available")
    expect(gone.querySelector('button')).toBeNull()
    await unmount()
  })

  it('a record with no flag shows no notice', async () => {
    profileClient = { duplicate_of: [] }
    const a = await mount(<ClientProfile clientId="copy-2de9" onClose={() => {}} />)
    expect(a.host.textContent).toContain('Shirley Ann Morgan')
    expect(notice(a.host)).toBeNull()
    await a.unmount()
    profileClient = {} // an older payload without the key
    const b = await mount(<ClientProfile clientId="copy-2de9" onClose={() => {}} />)
    expect(notice(b.host)).toBeNull()
    await b.unmount()
  })
})

describe('the New client sheet, refused by the server', () => {
  it('opens the existing record instead of erroring, and creates nothing', async () => {
    leadPost = () => jsonRes({ error: 'duplicate_client', existing: { id: 'real-072e', name: 'Shirley Ann Morgan' }, matched_on: 'email' }, 409)
    const onCreated = vi.fn()
    const onOpenClient = vi.fn()
    const setToast = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[]} locFilter="loc-uuid-1" onClose={() => {}}
        onCreated={onCreated} onOpenClient={onOpenClient} setToast={setToast} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Shirley Morgan')
    const create = Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Create — opens card')!
    await click(create)
    expect(onCreated).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Returning client')
    expect(host.textContent).toContain('Shirley Ann Morgan')
    expect(host.textContent).not.toContain('duplicate_client')
    expect(setToast).toHaveBeenCalledWith({ kind: 'error', msg: 'A matching client already exists — showing them instead' })
    const open = Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Open client profile')!
    await click(open)
    expect(onOpenClient).toHaveBeenCalledWith('real-072e')
    await unmount()
  })

  it('"None of these" after a refusal really creates — sending the record it was shown', async () => {
    const posts: any[] = []
    leadPost = (body) => {
      posts.push(body)
      return body.confirmed_not_duplicate_of?.includes('real-072e')
        ? jsonRes({ lead: { id: 'lead-spouse', name: body.name, possible_duplicate_of: ['real-072e'] } }, 201)
        : jsonRes({ error: 'duplicate_client', existing: { id: 'real-072e', name: 'Shirley Ann Morgan' }, matched_on: 'email' }, 409)
    }
    const onCreated = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[]} locFilter="loc-uuid-1" onClose={() => {}} onCreated={onCreated} setToast={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Ray Morgan')
    const btn = (t: string) => Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').trim() === t)!
    await click(btn('Create — opens card'))
    expect(host.textContent).toContain('Returning client')
    await click(btn('None of these — create a new client'))
    await click(btn('Create — opens card'))
    expect(posts).toHaveLength(2)
    expect(posts[0].confirmed_not_duplicate_of).toBeUndefined()
    expect(posts[1].confirmed_not_duplicate_of).toEqual(['real-072e'])
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onCreated.mock.calls[0][0].id).toBe('lead-spouse')
    await unmount()
  })

  it('the browser check does not bounce a record the person already dismissed', async () => {
    const posts: any[] = []
    leadPost = (body) => { posts.push(body); return jsonRes({ lead: { id: 'lead-spouse', name: body.name } }, 201) }
    const wife = { id: 'lead-wife', name: 'Ann Morgan', email: 'home@morgan.com', phone: '', locationId: 'loc-uuid-1', isJunk: false, outreachTimeline: [] }
    gateRows = [{ id: 'lead-wife', name: 'Ann Morgan', email: 'home@morgan.com', phone: null, location_uuid: 'loc-uuid-1' }]
    const onCreated = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[wife] as any} locFilter="loc-uuid-1" onClose={() => {}} onCreated={onCreated} setToast={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'home@morgan.com')
    const btn = (t: string) => Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').trim() === t)!
    expect(host.textContent).toContain('Returning client')
    await click(btn('None of these — create a new client'))
    await type(host.querySelector('input[aria-label="Name"]')!, 'Ray Morgan')
    await click(btn('Create — opens card'))
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ name: 'Ray Morgan', email: 'home@morgan.com', confirmed_not_duplicate_of: ['lead-wife'] })
    expect(onCreated).toHaveBeenCalledTimes(1)
    await unmount()
  })
})
