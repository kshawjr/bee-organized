// @vitest-environment happy-dom
//
// LEAD NOTES REALTIME — a note one bee writes appears on another bee's open
// card for the same client, with no reload.
//
// THE GAP. A note writes to lead_notes and touches neither the leads row nor
// touchpoints, so neither existing channel has an event to carry it. It is the
// most common collaborative act in the app and it reached nobody: two people
// on one client could not see each other write.
//
// THE DUPLICATE CASE, pinned hardest. The author's note is already in local
// state when their own INSERT comes back down the socket, and a refetch can
// bring it a third time. Notes are APPENDS — there is no version of this where
// last-wins is safe — so the merge is additive-BY-ID and converges on the
// snapshot, exactly as peopleTouchPatch does for timeline entries. Both
// composers on the card and the realtime arrival go through that ONE merge, so
// a remote note and a local one are the same kind of thing by construction.
// Pins:
//   · another user's note appears on an open client card, live
//   · the same note by realtime AND by refetch renders ONCE
//   · the author's own note behaves exactly as it does today
//   · a note for another client never reaches the card
//   · nothing else on the card is disturbed by the arrival
//   · ClientProfile is wired to the seam this suite tests (source sweep)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import { upsertNote } from '@/components/hive/shared/noteStream'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// ── supabase realtime harness ─────────────────────────────────────
const { channels, removed, cfg } = vi.hoisted(() => ({
  channels: [] as any[],
  removed: [] as any[],
  cfg: { throwOnCreate: false },
}))

vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    if (cfg.throwOnCreate) {
      throw new Error("@supabase/ssr: Your project's URL and API key are required to create a Supabase client!")
    }
    return {
      channel: (name: string) => {
        const ch: any = { name, config: null, handler: null, subscribed: false }
        ch.on = (_e: string, config: any, handler: any) => { ch.config = config; ch.handler = handler; return ch }
        ch.subscribe = () => { ch.subscribed = true; return ch }
        channels.push(ch)
        return ch
      },
      // The channel is opened through use-realtime-channel, which awaits
      // supabase.realtime.setAuth() so the join carries the access token.
      // Without this the hook's try/catch would swallow a TypeError and these
      // suites would go on passing while every channel joined ANONYMOUSLY —
      // which is the exact failure beta-realtime-auth exists to catch.
      realtime: { setAuth: async () => {} },
      removeChannel: (ch: any) => { removed.push(ch) },
    }
  },
}))

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

// A raw lead_notes row, as postgres_changes delivers it AND as the POST
// response returns it — the same shape, which is the point.
const note = (over: any = {}) => ({
  id: 'n-remote-1',
  lead_id: 'c1',
  kind: 'buzz',
  text: 'Spoke to her husband, call after six',
  user_label: 'Dana Reed',
  created_at: iso(1000),
  ...over,
})

// ── the pure merge ────────────────────────────────────────────────
describe('upsertNote — additive by id, converging on the snapshot', () => {
  const data = (over: any = {}) => ({ client: { id: 'c1' }, buzz_notes: [], job_notes: [], ...over })

  it('adds a buzz note to the buzz bucket, newest first', () => {
    const older = note({ id: 'n-old', created_at: iso(9000) })
    const next: any = upsertNote(data({ buzz_notes: [older] }), note())
    expect(next.buzz_notes.map((n: any) => n.id)).toEqual(['n-remote-1', 'n-old'])
  })

  it('adds a job note to the job bucket, leaving buzz alone', () => {
    const next: any = upsertNote(data({ buzz_notes: [note({ id: 'b1' })] }), note({ id: 'j1', kind: 'job' }))
    expect(next.job_notes.map((n: any) => n.id)).toEqual(['j1'])
    expect(next.buzz_notes.map((n: any) => n.id)).toEqual(['b1'])
  })

  it('DROPS a note already in its bucket, returning the same reference', () => {
    // The author's own note coming back down the socket. Same ref → no
    // re-render, and no second copy.
    const d = data({ buzz_notes: [note()] })
    expect(upsertNote(d, note())).toBe(d)
  })

  it('is idempotent across a burst of events for the same note', () => {
    let d: any = data()
    for (let i = 0; i < 3; i++) d = upsertNote(d, note())
    expect(d.buzz_notes).toHaveLength(1)
  })

  it('sorts created_at DESCENDING, as the profile route ships both buckets', () => {
    // A note written moments ago can still arrive after a later one.
    let d: any = data()
    d = upsertNote(d, note({ id: 'n-mid', created_at: iso(5000) }))
    d = upsertNote(d, note({ id: 'n-new', created_at: iso(100) }))
    d = upsertNote(d, note({ id: 'n-old', created_at: iso(9000) }))
    expect(d.buzz_notes.map((n: any) => n.id)).toEqual(['n-new', 'n-mid', 'n-old'])
  })

  it('ignores a kind this card does not display', () => {
    // The POST route can write kind='system'; the profile route fetches only
    // buzz and job. Bucketing an unknown kind would show a row live that a
    // reload then makes vanish.
    const d = data()
    expect(upsertNote(d, note({ id: 'n-sys', kind: 'system' }))).toBe(d)
    expect(upsertNote(d, note({ id: 'n-huh', kind: undefined }))).toBe(d)
  })

  it('ignores a note with no id, and a null data object', () => {
    const d = data()
    expect(upsertNote(d, note({ id: null }))).toBe(d)
    expect(upsertNote(d, null)).toBe(d)
    expect(upsertNote(null, note())).toBe(null)
  })

  it('tolerates a bucket the payload has not got yet', () => {
    const next: any = upsertNote({ client: { id: 'c1' } } as any, note())
    expect(next.buzz_notes.map((n: any) => n.id)).toEqual(['n-remote-1'])
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
let postedNotes = 0
let nextPostResponse: any = null

const installFetch = () => {
  profileFetches = 0
  postedNotes = 0
  ;(globalThis as any).fetch = vi.fn(async (url: any) => {
    const u = String(url)
    if (u.includes('/api/clients/')) {
      profileFetches++
      return { ok: true, status: 200, json: async () => profilePayload } as any
    }
    if (u.includes('/api/lead-notes')) {
      // The POST response: a CONFIRMED row carrying the real id, which is
      // what makes a locally-posted note and a realtime one the same thing.
      postedNotes++
      return { ok: true, status: 200, json: async () => ({ note: nextPostResponse }) } as any
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
}

// Fire a postgres_changes INSERT at the live channel, ENFORCING the channel's
// filter the way Supabase would — a suite that called the handler blind would
// pass even with the scope wrong.
const emit = async (row: any) => {
  const ch = channels[channels.length - 1]
  const want = ch.config.filter
  if (want && want !== `lead_id=eq.${row.lead_id}`) return // not delivered
  await act(async () => { ch.handler({ eventType: 'INSERT', new: row }) })
  await flush()
}

const text = () => container.textContent || ''
const countOf = (needle: string) => text().split(needle).length - 1

// The job-note composer, driven for real. React controls the input, so the
// value goes in through the native setter and an input event, exactly as a
// keystroke would.
const composer = () =>
  [...container.querySelectorAll('input')].find((i: any) => i.placeholder === 'Add a note…') as HTMLInputElement
const postNote = async (value: string) => {
  const el = composer()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
  await flush()
}

beforeEach(() => {
  installFetch()
  channels.length = 0
  removed.length = 0
  cfg.throwOnCreate = false
  profilePayload = PROFILE()
  nextPostResponse = null
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  ;(root as any) = null
  container?.remove()
  vi.restoreAllMocks()
})

describe("someone else's note appears on the open card", () => {
  it('a buzz note written elsewhere shows up live', async () => {
    await mount()
    expect(text()).not.toContain('call after six')

    await emit(note())

    expect(text()).toContain('call after six')
  })

  it('a job note arrives into the activity stream, with its author', async () => {
    await mount()

    await emit(note({ id: 'n-job', kind: 'job', text: 'Quote sent Tuesday', user_label: 'Dana Reed' }))

    expect(text()).toContain('Quote sent Tuesday')
    expect(text()).toContain('Dana Reed')
  })

  it('subscribes on THIS client, not a location', async () => {
    await mount()
    expect(channels).toHaveLength(1)
    expect(channels[0].subscribed).toBe(true)
    expect(channels[0].config.table).toBe('lead_notes')
    expect(channels[0].config.event).toBe('INSERT')
    expect(channels[0].config.filter).toBe('lead_id=eq.c1')
  })

  it('nothing else on the card is disturbed by the arrival', async () => {
    // Job notes, because the activity stream renders a LIST — the buzz band
    // shows only the latest note (history sits behind its pencil), so it
    // could not show an existing note and an arrival at the same time.
    profilePayload = PROFILE({
      job_notes: [note({ id: 'n-have', kind: 'job', text: 'Existing note', created_at: iso(9000) })],
    })
    await mount()
    expect(text()).toContain('Existing note')
    const fetchesBefore = profileFetches

    await emit(note({ id: 'n-new', kind: 'job', text: 'Brand new note', created_at: iso(100) }))

    expect(text()).toContain('Sarah Mitchell')      // the person
    expect(text()).toContain('sarah@email.com')     // their contact stack
    expect(text()).toContain('12 Oak St')           // their address
    expect(text()).toContain('Existing note')       // the note already there
    expect(text()).toContain('Brand new note')      // and the arrival
    expect(profileFetches).toBe(fetchesBefore)      // no refetch: the row IS the truth
  })
})

describe('THE DUPLICATE CASE — one note must render once', () => {
  // All job notes: the activity stream renders every one it holds, so a
  // second copy would really be visible here. The buzz band would hide it.

  it('the same note by realtime AND already in the snapshot renders ONCE', async () => {
    profilePayload = PROFILE({ job_notes: [note({ id: 'n-dup', kind: 'job', text: 'Only once please' })] })
    await mount()
    expect(countOf('Only once please')).toBe(1)

    await emit(note({ id: 'n-dup', kind: 'job', text: 'Only once please' }))

    expect(countOf('Only once please')).toBe(1)
  })

  it('a duplicate realtime burst renders once', async () => {
    await mount()
    const row = note({ id: 'n-burst', kind: 'job', text: 'Burst note' })

    await emit(row)
    await emit(row)
    await emit(row)

    expect(countOf('Burst note')).toBe(1)
  })

  it("the author posts, their own INSERT echoes back, and it renders ONCE", async () => {
    // The real sequence, through the real composer: POST → the confirmed row
    // lands in local state → the same row arrives on the socket.
    await mount()
    nextPostResponse = note({ id: 'n-mine', kind: 'job', text: 'My own note', user_label: 'You' })

    await postNote('My own note')
    expect(postedNotes).toBe(1)
    expect(countOf('My own note')).toBe(1)

    await emit(nextPostResponse)
    await emit(nextPostResponse)

    expect(countOf('My own note')).toBe(1) // the echo changed nothing
  })

  it("the author's own note still posts exactly as it did — API call and all", async () => {
    await mount()
    nextPostResponse = note({ id: 'n-solo', kind: 'job', text: 'Posted normally' })

    await postNote('Posted normally')

    expect(postedNotes).toBe(1)             // it really hit the route
    expect(countOf('Posted normally')).toBe(1)
    expect(composer().value).toBe('')       // and the draft cleared
  })
})

describe('scope', () => {
  it("a note for another client is not delivered", async () => {
    await mount()

    await emit(note({ id: 'n-far', lead_id: 'c-other', text: 'Someone elses client' }))

    expect(text()).not.toContain('Someone elses client')
  })

  it('a row whose lead_id disagrees with the card is refused even if delivered', async () => {
    // Belt and braces: the hook re-checks the row's own lead_id, so a filter
    // that ever let a stray row through still cannot land it on this card.
    await mount()
    const ch = channels[channels.length - 1]
    await act(async () => { ch.handler({ eventType: 'INSERT', new: note({ id: 'n-stray', lead_id: 'c-other', text: 'Stray note' }) }) })
    await flush()

    expect(text()).not.toContain('Stray note')
  })

  it('renders the card anyway when the supabase client cannot be created', async () => {
    cfg.throwOnCreate = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await mount()

    expect(channels).toHaveLength(0)
    expect(text()).toContain('Sarah Mitchell') // the card is alive
    expect(err).toHaveBeenCalled()
  })

  it('removes the channel on unmount', async () => {
    await mount()
    const ch = channels[0]
    await act(async () => { root.unmount() })
    ;(root as any) = null
    expect(removed).toContain(ch)
  })
})

// ── source sweep ──────────────────────────────────────────────────
describe('ClientProfile is wired to the seam this suite tests', () => {
  const src = readFileSync(join(process.cwd(), 'components/hive/ClientProfile.jsx'), 'utf8')

  it('subscribes on the open client', () => {
    expect(src).toContain('useLeadNotesRealtime(clientId')
  })

  it('routes BOTH composers and the arrival through the one merge', () => {
    // Three call sites, one function: the buzz band, the job-note composer,
    // and the realtime handler. A second prepend path here is exactly how the
    // author's own note would end up on the card twice.
    expect(src.match(/upsertNote\(/g) || []).toHaveLength(3)
    // and the old inline prepends are gone
    expect(src).not.toContain('buzz_notes: [j.note,')
    expect(src).not.toContain('job_notes: [j.note,')
  })

  it('the merge it feeds is additive-by-id, not last-wins', () => {
    const merge = readFileSync(join(process.cwd(), 'components/hive/shared/noteStream.js'), 'utf8')
    expect(merge).toContain('cur.some(n => n && n.id === note.id)')
  })

  it('the migration adds BOTH the publication entry and the policy', () => {
    // Either alone is dead. Pinned so a half-application is visible here.
    const sql = readFileSync(join(process.cwd(), 'migrations/lead_notes_realtime_rls.sql'), 'utf8')
    expect(sql).toContain('alter publication supabase_realtime add table public.lead_notes')
    expect(sql).toContain('create policy')
    expect(sql).toContain('for select')
    // derived from the lead, not from the note's own location stamp
    expect(sql).toContain('l.id = lead_notes.lead_id')
    expect(sql).not.toContain('lead_notes.location_uuid')
  })
})
