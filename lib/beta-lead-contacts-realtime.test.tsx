// @vitest-environment happy-dom
//
// LEAD CONTACTS REALTIME — a secondary contact one bee adds appears on
// another bee's open card for the same client, with no reload.
//
// THE GAP, third table with the same shape: a contact writes to lead_contacts
// and touches neither the leads row nor touchpoints nor lead_notes, so no
// existing channel has an event to carry it. Noticed while building the notes
// equivalent (94af905) and left alone then as out of scope.
//
// THE DUPLICATE CASE. The author's contact is already in local state when
// their own INSERT comes back down the socket. upsertContact is additive-BY-ID
// and converges on the snapshot, exactly as noteStream and peopleTouchPatch
// do — a contact already in the list is dropped and the SAME data reference
// comes back.
//
// THE JOIN MUST BE AUTHENTICATED, and this suite asserts it on the JOIN
// PAYLOAD rather than on subscription status. That is the lesson of 9c5cf0a:
// every realtime channel in the app joined anonymously for a day, was
// accepted, reported SUBSCRIBED, and delivered nothing — and 135 tests stayed
// green because they all asked "did it subscribe?", which was always true.
// lead_contacts' policy grants to `authenticated` only, so an anonymous join
// here would be silently dead in exactly the same way.
// Pins:
//   · another user's contact appears on an open card, live
//   · the same contact by realtime AND by refetch renders ONCE
//   · the author's own still behaves as today
//   · a contact for another client never reaches the card
//   · the channel joins carrying an access token
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import { upsertContact } from '@/components/hive/shared/contactStream'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.session-one'

// ── supabase double ───────────────────────────────────────────────
// Models the two behaviours of the installed realtime-js that matter here:
// the socket caches a token asynchronously, and subscribe() attaches it to
// the join ONLY if it is already resolved. That is what makes the
// join-payload assertions below able to fail.
const fake = vi.hoisted(() => ({
  channels: [] as any[],
  removed: [] as any[],
  joins: [] as any[],
  accessTokenValue: null as string | null,
  sessionToken: null as string | null,
  cfg: { throwOnCreate: false },
}))

vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    if (fake.cfg.throwOnCreate) throw new Error('no supabase env')
    return {
      realtime: {
        setAuth: async () => {
          await Promise.resolve()
          fake.accessTokenValue = fake.sessionToken
        },
      },
      channel: (name: string) => {
        const ch: any = { name, kind: null, config: null, handler: null, joinPayload: null }
        ch.on = (kind: string, config: any, handler: any) => {
          ch.kind = kind; ch.config = config; ch.handler = handler; return ch
        }
        ch.subscribe = () => {
          const payload: any = { config: { private: false } }
          if (fake.accessTokenValue) payload.access_token = fake.accessTokenValue
          ch.joinPayload = payload
          fake.joins.push({ name, payload })
          return ch
        }
        fake.channels.push(ch)
        return ch
      },
      removeChannel: (ch: any) => { fake.removed.push(ch) },
    }
  },
}))

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

// A raw lead_contacts row, as postgres_changes delivers it AND as the POST
// response returns it — the same shape, which is the point.
const contact = (over: any = {}) => ({
  id: 'ct-remote-1',
  lead_id: 'c1',
  name: 'Marcus Mitchell',
  role: 'Husband',
  phone: '(561) 555-0234',
  email: 'marcus@email.com',
  created_at: iso(1000),
  ...over,
})

// ── the pure merge ────────────────────────────────────────────────
describe('upsertContact — additive by id, converging on the snapshot', () => {
  const data = (over: any = {}) => ({ client: { id: 'c1' }, contacts: [], ...over })

  it('adds a contact it has never seen', () => {
    const next: any = upsertContact(data(), contact())
    expect(next.contacts.map((c: any) => c.id)).toEqual(['ct-remote-1'])
  })

  it('DROPS a contact already in the list, returning the same reference', () => {
    // The author's own contact coming back down the socket. Same ref → no
    // re-render, and no second copy.
    const d = data({ contacts: [contact()] })
    expect(upsertContact(d, contact())).toBe(d)
  })

  it('is idempotent across a burst of events for the same contact', () => {
    let d: any = data()
    for (let i = 0; i < 3; i++) d = upsertContact(d, contact())
    expect(d.contacts).toHaveLength(1)
  })

  it('keeps created_at ASCENDING — the order the profile route ships', () => {
    // Deliberately the opposite of noteStream. Contacts come back
    // oldest-first; guessing one list's order from the other would quietly
    // reorder the card.
    let d: any = data()
    d = upsertContact(d, contact({ id: 'ct-mid', created_at: iso(5000) }))
    d = upsertContact(d, contact({ id: 'ct-new', created_at: iso(100) }))
    d = upsertContact(d, contact({ id: 'ct-old', created_at: iso(9000) }))
    expect(d.contacts.map((c: any) => c.id)).toEqual(['ct-old', 'ct-mid', 'ct-new'])
  })

  it('ignores a contact with no id, and a null data object', () => {
    const d = data()
    expect(upsertContact(d, contact({ id: null }))).toBe(d)
    expect(upsertContact(d, null)).toBe(d)
    expect(upsertContact(null, contact())).toBe(null)
  })

  it('tolerates a payload with no contacts array yet', () => {
    const next: any = upsertContact({ client: { id: 'c1' } } as any, contact())
    expect(next.contacts.map((c: any) => c.id)).toEqual(['ct-remote-1'])
  })

  it('leaves every other part of the card alone', () => {
    const d = data({ buzz_notes: [{ id: 'n1' }], job_notes: [{ id: 'n2' }] })
    const next: any = upsertContact(d, contact())
    expect(next.buzz_notes).toBe(d.buzz_notes)
    expect(next.job_notes).toBe(d.job_notes)
    expect(next.client).toBe(d.client)
  })
})

// ── the card, for real ────────────────────────────────────────────
const PROFILE = (over: any = {}) => ({
  client: {
    id: 'c1', name: 'Sarah Mitchell', first_name: 'Sarah', last_name: 'Mitchell',
    email: 'sarah@email.com', phone: '(561) 555-0199', address: '12 Oak St',
    stage: 'New', created_at: iso(86400000), location_name: 'Palm Beach',
    is_junk: false, snoozed_until: null, inbox_dismissed_at: null,
    jobber_client_id: null, assigned_to: null, tags: [],
  },
  referred_us: [], referred_us_total: 0, contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { owing: 0, paid: 0, invoiced: 0 },
  ...over,
})

let container: HTMLDivElement
let root: Root
let profilePayload: any = null
let profileFetches = 0
let postedContacts = 0
let nextPostResponse: any = null

const installFetch = () => {
  profileFetches = 0
  postedContacts = 0
  ;(globalThis as any).fetch = vi.fn(async (url: any) => {
    const u = String(url)
    if (u.includes('/api/clients/')) {
      profileFetches++
      return { ok: true, status: 200, json: async () => profilePayload } as any
    }
    if (u.includes('/api/lead-contacts')) {
      postedContacts++
      return { ok: true, status: 200, json: async () => ({ contact: nextPostResponse }) } as any
    }
    return { ok: true, status: 200, json: async () => ({}) } as any
  })
}

const flush = async () => { await act(async () => { await Promise.resolve() }) }

const mount = async (props: any = {}) => {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(<ClientProfile clientId="c1" {...props} />)
  })
  await flush()
  await flush()
  await flush()
}

// Deliver a postgres_changes INSERT the way Realtime would, ENFORCING the
// channel's filter. Calling the handler blind would pass even with the scope
// wrong.
const emit = async (row: any) => {
  const ch = fake.channels.find((c: any) => c.config?.table === 'lead_contacts')
  if (!ch) return
  const want = ch.config.filter
  if (want && want !== `lead_id=eq.${row.lead_id}`) return
  await act(async () => { ch.handler({ eventType: 'INSERT', new: row }) })
  await flush()
}

const text = () => container.textContent || ''
const countOf = (s: string) => text().split(s).length - 1
const contactsJoin = () => fake.joins.find(j => j.name.startsWith('lead_contacts:'))

beforeEach(() => {
  installFetch()
  fake.channels.length = 0
  fake.removed.length = 0
  fake.joins.length = 0
  fake.accessTokenValue = null
  fake.sessionToken = TOKEN
  fake.cfg.throwOnCreate = false
  profilePayload = PROFILE()
  nextPostResponse = null
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  ;(root as any) = null
  container?.remove()
  vi.restoreAllMocks()
})

describe('the channel joins AUTHENTICATED', () => {
  it('the join payload carries an access token', async () => {
    // The lesson of 9c5cf0a: assert on what goes over the wire. A channel
    // that joins anonymously is accepted and reports SUBSCRIBED, then
    // delivers nothing — and lead_contacts' policy grants to `authenticated`
    // only, so that failure would be total and silent.
    await mount()

    const j = contactsJoin()
    expect(j).toBeDefined()
    expect(j!.payload.access_token).toBe(TOKEN)
  })

  it('goes through the shared primitive rather than opening its own channel', () => {
    const src = readFileSync(join(process.cwd(), 'lib/use-lead-contacts-realtime.ts'), 'utf8')
    expect(src).toContain('useRealtimeChannel(')
    expect(src).not.toContain('createClient()')
    expect(src).not.toContain('.subscribe()')
  })

  it('subscribes on THIS client', async () => {
    await mount()
    const ch = fake.channels.find((c: any) => c.config?.table === 'lead_contacts')
    expect(ch).toBeDefined()
    expect(ch.name).toBe('lead_contacts:c1')
    expect(ch.config.event).toBe('INSERT')
    expect(ch.config.filter).toBe('lead_id=eq.c1')
  })
})

describe("someone else's contact appears on the open card", () => {
  it('a contact added elsewhere shows up live', async () => {
    await mount()
    expect(text()).not.toContain('Marcus Mitchell')

    await emit(contact())

    expect(text()).toContain('Marcus Mitchell')
    expect(text()).toContain('Husband')
  })

  it('it joins the contacts a card already had, without disturbing them', async () => {
    profilePayload = PROFILE({
      contacts: [contact({ id: 'ct-have', name: 'Existing Eve', role: 'Sister', created_at: iso(9000) })],
    })
    await mount()
    expect(text()).toContain('Existing Eve')
    const fetchesBefore = profileFetches

    await emit(contact({ id: 'ct-new', name: 'Marcus Mitchell', created_at: iso(100) }))

    expect(text()).toContain('Existing Eve')     // still there
    expect(text()).toContain('Marcus Mitchell')  // and the arrival
    expect(text()).toContain('Sarah Mitchell')   // the person
    expect(text()).toContain('sarah@email.com')  // their contact stack
    expect(profileFetches).toBe(fetchesBefore)   // no refetch: the row IS the truth
  })
})

describe('THE DUPLICATE CASE — one contact must render once', () => {
  it('the same contact by realtime AND already in the snapshot renders ONCE', async () => {
    profilePayload = PROFILE({ contacts: [contact()] })
    await mount()
    expect(countOf('Marcus Mitchell')).toBe(1)

    await emit(contact())

    expect(countOf('Marcus Mitchell')).toBe(1)
  })

  it('a duplicate realtime burst renders once', async () => {
    await mount()

    await emit(contact())
    await emit(contact())
    await emit(contact())

    expect(countOf('Marcus Mitchell')).toBe(1)
  })

  it("the author adds one, their own INSERT echoes back, and it renders ONCE", async () => {
    // ContactsBlock appends the confirmed row locally; the socket then
    // delivers the same row. The merge refuses the id it already holds.
    profilePayload = PROFILE({ contacts: [contact({ id: 'ct-mine', name: 'My Own Contact' })] })
    await mount()
    expect(countOf('My Own Contact')).toBe(1)

    await emit(contact({ id: 'ct-mine', name: 'My Own Contact' }))
    await emit(contact({ id: 'ct-mine', name: 'My Own Contact' }))

    expect(countOf('My Own Contact')).toBe(1)
  })

  it("the author's own add path is untouched — ContactsBlock still owns the array", async () => {
    // Source pin. Add, edit and remove are not all insertions, so that
    // contract stays as it was; the two layers converge because the realtime
    // merge never overwrites what is already there.
    const src = readFileSync(join(process.cwd(), 'components/hive/ClientProfile.jsx'), 'utf8')
    expect(src).toContain('onChange={next => setData(d => d ? { ...d, contacts: next } : d)}')
    expect(src).toContain('upsertContact(d, row)')
  })
})

describe('scope', () => {
  it("a contact for another client is not delivered", async () => {
    await mount()

    await emit(contact({ id: 'ct-far', lead_id: 'c-other', name: 'Someone Elses Contact' }))

    expect(text()).not.toContain('Someone Elses Contact')
  })

  it('a row whose lead_id disagrees with the card is refused even if delivered', async () => {
    await mount()
    const ch = fake.channels.find((c: any) => c.config?.table === 'lead_contacts')
    await act(async () => {
      ch.handler({ eventType: 'INSERT', new: contact({ id: 'ct-stray', lead_id: 'c-other', name: 'Stray Contact' }) })
    })
    await flush()

    expect(text()).not.toContain('Stray Contact')
  })

  it('renders the card anyway when the supabase client cannot be created', async () => {
    fake.cfg.throwOnCreate = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await mount()

    expect(text()).toContain('Sarah Mitchell') // the card is alive
    expect(err).toHaveBeenCalled()
  })

  it('removes the channel on unmount', async () => {
    await mount()
    const ch = fake.channels.find((c: any) => c.config?.table === 'lead_contacts')
    await act(async () => { root.unmount() })
    ;(root as any) = null
    expect(fake.removed).toContain(ch)
  })
})

// ── the migration ─────────────────────────────────────────────────
describe('the migration carries BOTH halves', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations/lead_contacts_realtime_rls.sql'), 'utf8')

  it('adds the publication entry AND the policy — either alone is dead', () => {
    expect(sql).toContain('alter publication supabase_realtime add table public.lead_contacts')
    expect(sql).toContain('create policy')
    expect(sql).toContain('for select')
    expect(sql).toContain('to authenticated')
  })

  it('derives visibility from the LEAD, not the row\'s own location stamp', () => {
    expect(sql).toContain('l.id = lead_contacts.lead_id')
    expect(sql).not.toContain('lead_contacts.location_uuid')
  })

  it('grants no write policy — writes still go through the service key', () => {
    expect(sql).not.toMatch(/for\s+(insert|update|delete|all)/i)
  })
})
