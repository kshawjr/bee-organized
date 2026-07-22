// @vitest-environment happy-dom
// NewClientSheet — the beta manual add-client flow. Covers:
//   - the lookup-first HARD gate (no create form before a searched miss)
//   - dedup/match paths: email-only, phone-only, both; formatted stored
//     phones match digit queries (the phone-storage gotcha)
//   - NULL is_junk rows are NOT excluded (NULL-equality gotcha)
//   - the match read carries .not('is_junk','is',true) + .range(0,999)
//     and never a bare .select()
//   - the create POST path (POST /api/leads, confirmed row → onCreated)
//   - frame B/D on a RETURNING client found an engagement under the
//     EXISTING lead (POST /api/engagements) — never a second leads row
//   - frame D fires ONLY when the match has 1+ open engagement
//   - copy: frame A/C/D headings + primary button labels (copy drift)
//   - FAB hidden while a sheet is open
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NewClientSheet from '@/components/hive/NewClientSheet'
import HiveShell from '@/components/hive/HiveShell'
import { matchPeople, buildLeadMatchOr, queryLeadMatches, maskPhone, maskEmail } from '@/components/hive/shared/clientMatch'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199', // formatted on purpose — the free-text reality
  locationId: 'loc-uuid-1',
  created: daysAgo(40),
  isJunk: false,
  outreachTimeline: [],
  ...over,
})

const openEng = (clientId: string, over: any = {}) => ({
  id: `e-${Math.random().toString(36).slice(2, 8)}`,
  client_id: clientId,
  client_name: 'Sarah Mitchell',
  location_uuid: 'loc-uuid-1',
  stage: 'Request',
  created_at: daysAgo(5),
  stage_entered_at: daysAgo(5),
  quotes: [], jobs: [], invoices: [],
  ...over,
})

// ── fetch mock ─────────────────────────────────────────────
const jsonRes = (body: any, status = 200) => ({
  ok: status < 400, status,
  json: async () => body,
})
let createdBodies: any[] = []
let foundedBodies: any[] = []
const installFetch = () => {
  createdBodies = []
  foundedBodies = []
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/lookups')) return jsonRes({ lookups: [] })
    // Manual founding (decoupled from Send to Jobber) — returns the real
    // engagement row in board shape, like POST /api/engagements does.
    if (u.includes('/api/engagements') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      foundedBodies.push(body)
      return jsonRes({
        engagement: {
          id: `eng-founded-${foundedBodies.length}`,
          client_id: body.client_id,
          client_name: 'Sarah Mitchell',
          client_phone: null,
          client_email: 'sarah@email.com',
          location_uuid: 'loc-uuid-1',
          stage: 'Request',
          founded_by: 'manual',
          title: 'Engagement – Jul 2026',
          created_at: new Date(now).toISOString(),
          stage_entered_at: new Date(now).toISOString(),
          repeat_count: foundedBodies.length,
          quotes: [], jobs: [], invoices: [], assessments: [],
        },
      }, 201)
    }
    if (u.includes('/api/leads') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      createdBodies.push(body)
      return jsonRes({ lead: { id: 'lead-new-1', ...body, is_junk: null, created_at: new Date(now).toISOString(), addresses: [] } }, 201)
    }
    if (u.includes('/profile')) return jsonRes({ client: null, aggregates: null, buzz_notes: [], touchpoints: [] })
    return jsonRes({})
  })
  ;(globalThis as any).fetch = mock
  return mock
}

// ── DOM helpers ────────────────────────────────────────────
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
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
const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)

// Seeds BOTH width paths: __BEE_TEST_WIDTH__ covers renderToString (no
// effects), and window.innerWidth covers happy-dom mounts — useIsMobile's
// mount effect re-reads window.innerWidth and would otherwise override
// the seed with happy-dom's desktop default.
const setWidth = (w: number | undefined) => {
  ;(globalThis as any).__BEE_TEST_WIDTH__ = w
  const win = (globalThis as any).window
  if (win?.happyDOM?.setViewport) win.happyDOM.setViewport({ width: w ?? 1024 })
}
beforeEach(() => installFetch())
afterEach(() => { setWidth(undefined); document.body.style.overflow = '' })

// ═══ pure matching layer ═══════════════════════════════════
describe('clientMatch — dedup/match paths', () => {
  const P = [
    person({ id: 'a', email: 'sarah@email.com', phone: '' }),
    person({ id: 'b', name: 'Linda Hall', email: '', phone: '561-555-0107' }),
    person({ id: 'c', name: 'Both Keys', email: 'both@x.com', phone: '(303) 555-0182' }),
  ]

  it('matches email-only people by exact normalized email', () => {
    const hits = matchPeople(P, '  SARAH@EMAIL.COM ')
    expect(hits).toHaveLength(1)
    expect(hits[0].person.id).toBe('a')
    expect(hits[0].matchedOn).toBe('email')
  })

  it('matches phone-only people through digit normalization of FORMATTED stored values', () => {
    const hits = matchPeople(P, '5615550107')
    expect(hits).toHaveLength(1)
    expect(hits[0].person.id).toBe('b')
    expect(hits[0].matchedOn).toBe('phone')
  })

  it('matches people with both keys on either key', () => {
    expect(matchPeople(P, 'both@x.com')[0]?.person.id).toBe('c')
    expect(matchPeople(P, '(303) 555-0182')[0]?.person.id).toBe('c')
  })

  it('does NOT exclude rows with is_junk NULL — only affirmative true', () => {
    const rows = [
      person({ id: 'null-junk', email: 'n@x.com', isJunk: null }),
      person({ id: 'true-junk', email: 'n@x.com', isJunk: true }),
    ]
    const hits = matchPeople(rows, 'n@x.com')
    expect(hits.map(h => h.person.id)).toEqual(['null-junk'])
  })

  it('masks matched values (phone +1 561···0199 style, email first-char···domain)', () => {
    expect(maskPhone('(561) 555-0199')).toBe('+1 561···0199')
    expect(maskEmail('Sarah@Email.com')).toBe('s···@email.com')
  })
})

describe('clientMatch — the authoritative match read', () => {
  const recorder = (data: any[] = []) => {
    const calls: Record<string, any[]> = {}
    const rec: any = { calls }
    for (const m of ['from', 'select', 'or', 'not', 'range', 'eq']) {
      rec[m] = (...args: any[]) => { (calls[m] ||= []).push(args); return rec }
    }
    rec.then = (resolve: any) => resolve({ data, error: null })
    return rec
  }

  it('builds .or() ONLY from keys that exist — never null/empty keys', () => {
    expect(buildLeadMatchOr({ email: 'a@b.com', phone: '' })).toBe('email.eq."a@b.com"')
    expect(buildLeadMatchOr({ email: '', phone: '(561) 555-0199' })).toBe('phone_normalized.eq."5615550199"')
    expect(buildLeadMatchOr({ email: ' A@B.com ', phone: '561-555-0199' })).toBe('email.eq."a@b.com",phone_normalized.eq."5615550199"')
    expect(buildLeadMatchOr({})).toBeNull()
    expect(String(buildLeadMatchOr({ email: 'a@b.com' }))).not.toContain('null')
  })

  it('excludes junk with .not(is_junk,is,true) — never .eq(is_junk,false) — and never a bare .select()', async () => {
    const q = recorder()
    await queryLeadMatches(q, { email: 'a@b.com', phone: '5615550199' })
    expect(q.calls.not).toEqual([['is_junk', 'is', true]])
    expect(q.calls.eq || []).toEqual([]) // no .eq('is_junk', false), no stray filters
    expect(q.calls.range).toEqual([[0, 999]]) // 1000-row silent-truncation habit
    expect(q.calls.select[0][0]).toContain('id') // explicit columns, not bare
    expect(q.calls.or[0][0]).toBe('email.eq."a@b.com",phone_normalized.eq."5615550199"')
  })

  it('short-circuits to [] with no usable key — the query never runs', async () => {
    const q = recorder()
    const rows = await queryLeadMatches(q, { email: '', phone: '  ' })
    expect(rows).toEqual([])
    expect(q.calls.from).toBeUndefined()
  })
})

// ═══ the sheet ═════════════════════════════════════════════
describe('NewClientSheet frames', () => {
  it('frame A copy — and the lookup gate: no create form before a searched miss', () => {
    const html = renderToString(<NewClientSheet people={[person()]} onClose={() => {}} />)
    expect(html).toContain('New client')
    expect(html).toContain('Search first so you don&#x27;t create a duplicate.')
    expect(html).toContain('Name, email, or phone')
    expect(html).toContain('Matches on email or phone (digits only). Type to search — results appear as you go.')
    // HARD gate: no create affordance and no returning-client block yet.
    expect(html).not.toContain('Create — opens card')
    expect(html).not.toContain('Returning client')
  })

  it('frame C: create POST path — confirmed row flows to onCreated', async () => {
    const onCreated = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} locFilter="loc-uuid-1" currentUserId="user-1" onClose={() => {}} onCreated={onCreated} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')

    // Frame C copy
    expect(host.textContent).toContain('No match — new person')
    expect(host.textContent).toContain('Founding-viable fields only. The card opens on create — fill the rest there.')
    const create = buttonByText(host, 'Create — opens card')!
    expect(create, 'create button missing').toBeTruthy()

    // Name prefilled from the query; defaults Source=Manual Type=Client.
    expect((host.querySelector('input[aria-label="Name"]') as HTMLInputElement).value).toBe('Fresh Person')
    expect((host.querySelector('select[aria-label="Source"]') as HTMLSelectElement).value).toBe('Manual')
    expect((host.querySelector('select[aria-label="Type"]') as HTMLSelectElement).value).toBe('Client')
    // On-create notification multi-select — all three pills default OFF.
    const pills = [...host.querySelectorAll('[role="checkbox"]')]
    expect(pills.map(p => p.getAttribute('aria-label'))).toEqual([
      'Send notification email', 'Post to Slack', 'Start drip emails',
    ])
    expect(pills.every(p => p.getAttribute('aria-checked') === 'false')).toBe(true)

    await click(create)
    expect(createdBodies).toHaveLength(1)
    expect(createdBodies[0]).toMatchObject({
      location_uuid: 'loc-uuid-1',
      assigned_to: 'user-1',
      name: 'Fresh Person',
      first_name: 'Fresh',
      last_name: 'Person',
      source: 'Manual',
      project_type: 'Client',
      stage: 'New',
      // All three opt-in actions default OFF → silent create.
      notifyEmail: false,
      notifySlack: false,
      startDrip: false,
      // Request-details textarea left empty → null (omitted from email/Slack).
      request_details: null,
    })
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onCreated.mock.calls[0][0].id).toBe('lead-new-1') // the REAL returned row
    await unmount()
  })

  it('frame C: on-create pills fire INDEPENDENTLY — selecting Email + Drip sends only those two', async () => {
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} locFilter="loc-uuid-1" currentUserId="user-1" onClose={() => {}} onCreated={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')

    const pill = (aria: string) => host.querySelector(`[role="checkbox"][aria-label="${aria}"]`)! as HTMLElement
    await click(pill('Send notification email'))
    await click(pill('Start drip emails'))
    // Slack left OFF; the two selected read checked.
    expect(pill('Send notification email').getAttribute('aria-checked')).toBe('true')
    expect(pill('Post to Slack').getAttribute('aria-checked')).toBe('false')
    expect(pill('Start drip emails').getAttribute('aria-checked')).toBe('true')

    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies).toHaveLength(1)
    expect(createdBodies[0]).toMatchObject({
      notifyEmail: true,
      notifySlack: false, // independent — not selected, not sent
      startDrip: true,
    })
    await unmount()
  })

  it('frame C: request-details textarea rides the POST as request_details (→ email + Slack)', async () => {
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} locFilter="loc-uuid-1" currentUserId="user-1" onClose={() => {}} onCreated={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')

    const ta = host.querySelector('textarea[aria-label="Request details"]') as HTMLTextAreaElement
    expect(ta, 'request-details textarea missing').toBeTruthy()
    await act(async () => {
      // Textarea uses the HTMLTextAreaElement value setter (not the input one).
      const setter = Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, 'Whole-house declutter, garage + pantry')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies).toHaveLength(1)
    // Persisted to the SAME leads.request_details column the intake path fills.
    expect(createdBodies[0].request_details).toBe('Whole-house declutter, garage + pantry')
    await unmount()
  })

  // ── optional address (restored to the beta create form) ─────────
  it('frame C: address is OPTIONAL and collapsed — the block appears only after "Add address"', async () => {
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} locFilter="loc-uuid-1" currentUserId="user-1" onClose={() => {}} onCreated={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')

    // Default form stays short: no address inputs, just the toggle.
    expect(host.querySelector('input[aria-label="City"]'), 'address hidden by default').toBeFalsy()
    const toggle = host.querySelector('button[aria-label="Add address"]') as HTMLButtonElement
    expect(toggle, 'Add-address toggle present').toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // The revealed block reuses the shared AddressAutofill street typeahead
    // (placeholder) + the labeled part fields.
    expect([...host.querySelectorAll('input')].some(i => (i.getAttribute('placeholder') || '').startsWith('Start typing a street')), 'street autofill revealed').toBe(true)
    expect(host.querySelector('input[aria-label="City"]'), 'City revealed').toBeTruthy()
    expect(host.querySelector('input[aria-label="State"]'), 'State revealed').toBeTruthy()
    expect(host.querySelector('input[aria-label="ZIP"]'), 'ZIP revealed').toBeTruthy()
    await unmount()
  })

  it('frame C: creating WITHOUT opening the address block posts NO address keys (byte-identical to today)', async () => {
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} locFilter="loc-uuid-1" currentUserId="user-1" onClose={() => {}} onCreated={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')
    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies).toHaveLength(1)
    // The optional address contributes nothing when never opened.
    expect(createdBodies[0]).not.toHaveProperty('address')
    expect(createdBodies[0]).not.toHaveProperty('city')
    expect(createdBodies[0]).not.toHaveProperty('addresses')
    await unmount()
  })

  it('frame C: creating WITH an address posts the full shape — composed `address` string + parts + discrete-street addresses[]', async () => {
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} locFilter="loc-uuid-1" currentUserId="user-1" onClose={() => {}} onCreated={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')
    await click(host.querySelector('button[aria-label="Add address"]')!)

    const street = [...host.querySelectorAll('input')].find(i => (i.getAttribute('placeholder') || '').startsWith('Start typing a street'))!
    await type(street, '123 Main St')
    await type(host.querySelector('input[aria-label="City"]')!, 'Denver')
    await type(host.querySelector('input[aria-label="State"]')!, 'CO')
    await type(host.querySelector('input[aria-label="ZIP"]')!, '80202')

    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies).toHaveLength(1)
    // Full composed string (the import storage convention) + the part columns…
    expect(createdBodies[0]).toMatchObject({
      name: 'Fresh Person',
      address: '123 Main St, Denver, CO, 80202',
      city: 'Denver', state: 'CO', zip: '80202',
    })
    // …plus a discrete-`street` addresses[] entry — what the Send-to-Jobber
    // property step reads (addresses[].street) and what leadHasUsableAddress
    // keys on. Clean street1, not the full joined string.
    expect(createdBodies[0].addresses).toEqual([
      { type: 'Service', value: '123 Main St, Denver, CO, 80202', street: '123 Main St', city: 'Denver', state: 'CO', zip: '80202' },
    ])
    // Let the AddressAutofill debounce settle while still mounted.
    await act(async () => { await new Promise(r => setTimeout(r, 200)) })
    await unmount()
  })

  it('frame B: returning client with matched-on line and stat block', async () => {
    const p = person({ id: 'p1' })
    const { host, unmount } = await mount(
      <NewClientSheet people={[p]} engagements={[openEng('p1')]} locFilter="loc-uuid-1" onClose={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    expect(host.textContent).toContain('Returning client')
    expect(host.textContent).toContain('matched on email · s···@email.com')
    expect(host.textContent).toContain('Open engagements')
    expect(host.textContent).toContain('1 open')
    expect(host.textContent).toContain('Last contact')
    expect(buttonByText(host, 'Open client profile')).toBeTruthy()
    await unmount()
  })

  it('frame D fires ONLY when the match has 1+ open engagement — and its confirm gates a REAL second founding', async () => {
    const p = person({ id: 'p1' })
    // 1+ open → confirm frame with the locked copy
    const withOpen = await mount(
      <NewClientSheet people={[p]} engagements={[openEng('p1')]} locFilter="loc-uuid-1" onClose={() => {}} />
    )
    await type(withOpen.host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    await click([...withOpen.host.querySelectorAll('button')].find(b => (b.textContent || '').includes('Start new engagement'))!)
    expect(foundedBodies, 'must NOT found before confirm').toHaveLength(0)
    expect(withOpen.host.textContent).toContain('This client has an open engagement')
    expect(withOpen.host.textContent).toContain('creates a second, concurrent engagement — both stay active.')
    expect(buttonByText(withOpen.host, 'Start another engagement')).toBeTruthy()
    expect(buttonByText(withOpen.host, 'Open existing instead')).toBeTruthy()
    // Confirm → a REAL second engagement founds under the EXISTING lead:
    // POST /api/engagements, never the retired duplicate-leads-row path.
    await click(buttonByText(withOpen.host, 'Start another engagement')!)
    expect(foundedBodies).toHaveLength(1)
    expect(foundedBodies[0].client_id).toBe('p1')
    expect(createdBodies, 'must NEVER POST /api/leads for a returning client').toHaveLength(0)
    await withOpen.unmount()

    // zero open → D skipped entirely, founding fires straight away
    installFetch()
    const noOpen = await mount(
      <NewClientSheet people={[p]} engagements={[]} locFilter="loc-uuid-1" onClose={() => {}} />
    )
    await type(noOpen.host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    await click([...noOpen.host.querySelectorAll('button')].find(b => (b.textContent || '').includes('Start new engagement'))!)
    expect(noOpen.host.textContent).not.toContain('This client has an open engagement')
    expect(foundedBodies).toHaveLength(1)
    expect(foundedBodies[0].client_id).toBe('p1')
    expect(createdBodies).toHaveLength(0)
    await noOpen.unmount()
  })
})

// ═══ placement ═════════════════════════════════════════════
describe('New-client entry points', () => {
  it('desktop: one dark "New" pill in the shell top row', () => {
    const html = renderToString(<HiveShell engagements={[]} people={[]} />)
    const pill = html.match(/<button[^>]*aria-label="New client"[^>]*>/)
    expect(pill, 'desktop New pill missing').toBeTruthy()
    expect(pill![0]).toContain('background:#1a1a18')
    expect(html).not.toContain('position:fixed;right:calc(16px') // no FAB on desktop
  })

  it('mobile: FAB present, ink #1a1a18, safe-area aware — and hidden while a sheet is open', async () => {
    setWidth(390)
    const { host, unmount } = await mount(<HiveShell engagements={[]} people={[]} />)
    const fab = host.querySelector('button[aria-label="New client"]') as HTMLElement
    expect(fab, 'mobile FAB missing').toBeTruthy()
    expect(fab.style.position).toBe('fixed')
    expect(fab.style.background).toBe('#1a1a18')
    // Safe-area asserted on the server-rendered markup — happy-dom's CSS
    // parser drops calc(env(...)) values from the style object.
    const ssr = renderToString(<HiveShell engagements={[]} people={[]} />)
    const ssrFab = ssr.match(/<button[^>]*aria-label="New client"[^>]*position:fixed[^>]*>/)
    expect(ssrFab, 'FAB missing from mobile SSR markup').toBeTruthy()
    expect(ssrFab![0]).toContain('safe-area-inset-bottom')

    // Open the sheet from the FAB → the FAB must leave the page.
    await click(fab)
    expect(host.textContent).toContain('Search first so you don')
    const fabsWhileOpen = [...host.querySelectorAll('button[aria-label="New client"]')]
      .filter(b => (b as HTMLElement).style.position === 'fixed')
    expect(fabsWhileOpen, 'FAB must hide while a sheet is open').toHaveLength(0)
    await unmount()
  })
})
