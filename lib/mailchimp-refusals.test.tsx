// @vitest-environment happy-dom
// FL-75 slice 6 (2026-11-26): who Mailchimp refused — the rules, the list the
// owner sees, and the screen that shows it (lib/mailchimp-refusals.ts,
// app/api/mailchimp/refused, components/settings/MailchimpConnectionScreen.jsx).
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { classifyRefusal, isHeld, listRefused, HOLD_AFTER, bounceKind } from './mailchimp-refusals'
import { RefusedPeople, refusedStatus, bounceWords } from '@/components/settings/MailchimpConnectionScreen'
import { loadOverview } from './mailchimp-overview'

vi.mock('./supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'

describe('what Mailchimp said decides the kind', () => {
  it.each([
    ['dana.kirsch.test@example.com looks fake or invalid, please enter a real email address.', 'invalid'],
    ['x@y.com was permanently deleted and cannot be re-imported. The contact must re-subscribe to get back on the list.', 'said_no'],
    // names a bounce among its possible causes: not a no (2026-11-26) — a bounce of unknown kind
    ['x@y.com is in a compliance state due to unsubscribe, bounce, or compliance review and cannot be subscribed.', 'temporary'],
    ['x@y.com has unsubscribed and cannot be re-added.', 'said_no'],
    ['x@y.com is in a compliance state due to a compliance review and cannot be subscribed.', 'said_no'],
    ['Forgotten Email Not Subscribed', 'said_no'],
    ['x@y.com has a hard bounce and cannot be added.', 'invalid'],
    ['x@y.com had a soft bounce.', 'temporary'],
    ['x@y.com bounced.', 'temporary'],
    ['x@y.com was cleaned.', 'temporary'],
    ['x@y.com has signed up to a lot of lists very recently; we\'re not allowing more signups for now', 'temporary'],
    ['Something Mailchimp has never said before', 'temporary'],
  ] as const)('%s → %s', (said, kind) => expect(classifyRefusal('ERROR_GENERIC', said)).toBe(kind))
  it('"already a member" is not a refusal', () => expect(classifyRefusal('ERROR_CONTACT_EXISTS', 'is already a list member')).toBe('already'))
  it('Mailchimp says hard or soft only in its own words; anything else is "unknown" — never guessed', () => {
    expect(bounceKind('has a hard bounce')).toBe('hard')
    expect(bounceKind('Hard-bounced address')).toBe('hard')
    expect(bounceKind('soft bounce: mailbox full')).toBe('soft')
    expect(bounceKind('this address bounced')).toBe('unknown')
    expect(bounceKind('mailbox does not exist')).toBe(null)          // no bounce word: not read as one
    expect(bounceKind('cleaned contact')).toBe('unknown')
  })
  // THE NO-MARKETING LIST IS NEVER WRITTEN FOR ANYTHING BUT A GENUINE NO
  it('of every message Bee Hub knows, only consent is a "no"; no message that names a bounce ever is', () => {
    const corpus = [
      'looks fake or invalid, please enter a real email address.', 'was permanently deleted and cannot be re-imported.',
      'is in a compliance state due to unsubscribe, bounce, or compliance review and cannot be subscribed.',
      'has a hard bounce', 'soft bounce', 'bounced', 'was cleaned', 'has unsubscribed', 'Forgotten Email Not Subscribed',
      "has signed up to a lot of lists very recently; we're not allowing more signups for now", 'Something new',
    ]
    const no = corpus.filter((t) => classifyRefusal('ERROR_GENERIC', t) === 'said_no')
    expect(no).toEqual(['was permanently deleted and cannot be re-imported.', 'has unsubscribed', 'Forgotten Email Not Subscribed'])
    for (const t of corpus) if (/bounc|cleaned/i.test(t)) expect(classifyRefusal('ERROR_GENERIC', t), t).not.toBe('said_no')
  })
  it('held = held and no Try again pending', () => {
    expect(isHeld({ held: true, retry_requested_at: null })).toBe(true)
    expect(isHeld({ held: true, retry_requested_at: 'x' })).toBe(false)
    expect(isHeld({ held: false, retry_requested_at: null })).toBe(false)
    expect(isHeld(undefined)).toBe(false)
    expect(HOLD_AFTER).toBe(3)
  })
})

// A stand-in that understands the filters listRefused uses.
function db(t: { refusals?: any[] | 'missing'; choices?: any[]; leads?: any[] }) {
  const from = (table: string) => {
    const f: Array<(r: any) => boolean> = []
    const rows = () => table === 'mailchimp_refusals' ? (t.refusals === 'missing' ? null : t.refusals || []) : table === 'mailchimp_review_choices' ? t.choices || [] : table === 'leads' ? t.leads || [] : []
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { f.push((r) => r[c] === v); return q },
      not: (c: string, _op: string, v: any) => { f.push((r) => (r[c] ?? null) !== v); return q },
      ilike: (c: string, v: string) => { const want = v.replace(/\\(.)/g, '$1').toLowerCase(); f.push((r) => String(r[c] || '').toLowerCase() === want); return q },
      then: (ok: any, bad: any) => {
        const all = rows()
        if (all === null) return Promise.resolve({ data: null, error: { code: '42P01', message: 'missing' } }).then(ok, bad)
        return Promise.resolve({ data: all.filter((r: any) => f.every((fn) => fn(r))), error: null }).then(ok, bad)
      },
    }
    return q
  }
  return { from }
}
const R = (key: string, over: any = {}) => ({ location_id: LOC, email_key: key, kind: 'invalid', mailchimp_code: 'ERROR_GENERIC', mailchimp_said: `${key} looks fake or invalid, please enter a real email address.`, refused_count: 1, first_refused_at: '2026-11-26T16:08:55Z', last_refused_at: '2026-11-26T16:08:55Z', held: true, retry_requested_at: null, ...over })
const L = (id: string, email: string, over: any = {}) => ({ id, location_uuid: LOC, email, first_name: id, last_name: 'Doe', is_junk: false, ...over })

describe('who the owner sees', () => {
  it('refused addresses on live records here — with every live record sharing the address, never one in the Recycle Bin', async () => {
    const r = await listRefused(LOC, { db: db({
      refusals: [R('test@test.com'), R('dup.test.one@example.com')],
      leads: [L('t1', 'test@test.com'), L('t2', 'Test@Test.com'), L('d1', 'dup.test.one@example.com'), L('dbin', 'dup.test.one@example.com', { is_junk: true })],
    }) })
    if (!r.ok) throw new Error('read failed')
    expect(r.people.map((p) => [p.email_key, p.records.map((x) => x.id)])).toEqual([['dup.test.one@example.com', ['d1']], ['test@test.com', ['t1', 't2']]])
  })
  it('not shown: left out by the owner, or no live record has that address any more (corrected, or only in the bin)', async () => {
    const r = await listRefused(LOC, { db: db({
      refusals: [R('left@x.com'), R('fixed@x.com'), R('binonly@x.com'), R('shown@x.com')],
      choices: [{ location_id: LOC, scope: 'person', key: 'left@x.com', choice: 'out' }],
      leads: [L('a', 'left@x.com'), L('b', 'now.correct@x.com'), L('c', 'binonly@x.com', { is_junk: true }), L('d', 'shown@x.com')],
    }) })
    if (!r.ok) throw new Error('read failed')
    expect(r.people.map((p) => p.email_key)).toEqual(['shown@x.com'])
  })
  it('a bounced address is on the list, with the kind of bounce Mailchimp said (or unknown)', async () => {
    const r = await listRefused(LOC, { db: db({ refusals: [R('full@x.com', { kind: 'temporary', held: false, mailchimp_said: 'full@x.com bounced.' })], leads: [L('f', 'full@x.com')] }) })
    if (!r.ok) throw new Error('read failed')
    expect(r.people.map((p) => [p.email_key, p.bounce])).toEqual([['full@x.com', 'unknown']])
  })
  it('before the migration: nothing to show, and it says so (ready false) rather than guessing', async () => {
    expect(await listRefused(LOC, { db: db({ refusals: 'missing' }) })).toEqual({ ok: true, ready: false, people: [] })
  })
})

describe('the overview counts them for the line on the Mailchimp screen', () => {
  it('refused_count = the people the list shows; unknown → 0', async () => {
    const loc = { id: LOC, location_id: 'loc_test', mailchimp_connected: true, mailchimp_access_token: 't', mailchimp_server_prefix: 'us8', mailchimp_list_id: 'l1', mailchimp_sync_live: true, mailchimp_review_done_at: null, mailchimp_first_sync_at: '2026-11-26T16:08:56Z' }
    const odb = { from: (t: string) => { const q: any = { select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: t === 'locations' ? loc : null, error: null }), then: (ok: any) => Promise.resolve({ data: [], error: null }).then(ok) }; return q } }
    const base = { db: odb, fetchImpl: (async () => ({ status: 200, text: async () => '{"stats":{"member_count":18}}' })) as any, readFlowsImpl: async () => ({ ok: true, flows: [], mustPause: [], tagFlows: [], signupFlows: [], fingerprint: 'f' }) as any }
    const six = await loadOverview(LOC, { ...base, listRefusedImpl: async () => ({ ok: true, ready: true, people: new Array(6).fill({}) }) as any })
    expect(six.ok && six.overview.refusedCount).toBe(6)
    const broken = await loadOverview(LOC, { ...base, listRefusedImpl: async () => { throw new Error('x') } })
    expect(broken.ok && broken.overview.refusedCount).toBe(0)
  })
})

// ── The screen ───────────────────────────────────────────────
let host: HTMLElement, root: Root
afterEach(() => { act(() => root?.unmount()); host?.remove() })
const P = (key: string, over: any = {}) => ({ email_key: key, email: key, records: [{ id: 'r-' + key, name: 'Dana Kirsch' }], kind: 'invalid', mailchimp_said: `${key} looks fake or invalid, please enter a real email address.`, mailchimp_code: 'ERROR_GENERIC', refused_count: 1, first_refused_at: 'x', last_refused_at: 'x', held: true, retry_requested: false, ...over })
function api(people: any[]) {
  const calls: any[] = []
  const fetchImpl = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (url.startsWith('/api/mailchimp/refused?')) return { ok: true, status: 200, json: async () => ({ ready: true, people }) }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
  return { calls, fetchImpl }
}
const mount = async (el: React.ReactElement) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(el) }); await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click() }); await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)

describe('the owner can see who was refused, from the Mailchimp screen', () => {
  it('"6 people couldn’t be added", and See who opens them in place — each with what MAILCHIMP said', async () => {
    const a = api([P('dana.kirsch.test@example.com'), P('test@test.com', { records: [{ id: 't1', name: 'Test One' }, { id: 't2', name: 'Test Two' }] })])
    const onChanged = vi.fn()
    await mount(<RefusedPeople locationId="loc" count={6} doFetch={a.fetchImpl} onChanged={onChanged} />)
    expect(q('mc-refused-line')!.textContent).toBe('6 people couldn’t be added to Mailchimp')
    expect(q('mc-refused-list')).toBeNull()
    await click(q('mc-refused-toggle'))
    const rows = host.querySelectorAll('[data-testid="mc-refused-person"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('[data-testid="mc-refused-said"]')!.textContent).toBe('Mailchimp said: “dana.kirsch.test@example.com looks fake or invalid, please enter a real email address.”')
    expect(rows[0].querySelector('[data-testid="mc-refused-status"]')!.textContent).toBe('Not sent again until the address is changed.')
    expect(rows[1].textContent).toContain('on 2 Bee Hub records')
    expect(q('mc-refused-toggle')!.textContent).toBe('Hide')
  })
  it('Try again → one POST, then the list and the count reload', async () => {
    const a = api([P('x@test.com')])
    const onChanged = vi.fn()
    await mount(<RefusedPeople locationId="loc" count={1} doFetch={a.fetchImpl} onChanged={onChanged} />)
    await click(q('mc-refused-toggle'))
    await click(q('mc-refused-retry'))
    expect(a.calls.filter((c) => c.method === 'POST')).toEqual([{ url: '/api/mailchimp/refused', method: 'POST', body: { location_id: 'loc', email_key: 'x@test.com', action: 'retry' } }])
    expect(onChanged).toHaveBeenCalled()
  })
  it('Leave out → one POST (the same untick the review screen saves)', async () => {
    const a = api([P('x@test.com')])
    await mount(<RefusedPeople locationId="loc" count={1} doFetch={a.fetchImpl} onChanged={() => {}} />)
    await click(q('mc-refused-toggle'))
    await click(q('mc-refused-leave'))
    expect(a.calls.filter((c) => c.method === 'POST').map((c) => c.body.action)).toEqual(['leave_out'])
  })
  it('Edit address saves the new address on EVERY live record with it, through the client record’s own route', async () => {
    const a = api([P('test@test.com', { records: [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }] })])
    await mount(<RefusedPeople locationId="loc" count={1} doFetch={a.fetchImpl} onChanged={() => {}} />)
    await click(q('mc-refused-toggle'))
    await click(q('mc-refused-edit'))
    const input = q('mc-refused-email') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'real.person@gmail.com'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(q('mc-refused-save'))
    expect(a.calls.filter((c) => c.method === 'PATCH')).toEqual([
      { url: '/api/leads/t1', method: 'PATCH', body: { email: 'real.person@gmail.com' } },
      { url: '/api/leads/t2', method: 'PATCH', body: { email: 'real.person@gmail.com' } },
    ])
  })
  it('a temporary refusal that will be tried anyway has no Try again; a pending Try again says so', () => {
    expect(refusedStatus(P('a', { kind: 'temporary', held: false }))).toBe('Will be tried again on the next sync.')
    expect(refusedStatus(P('a', { retry_requested: true }))).toBe('Will be tried once more on the next sync.')
    expect(refusedStatus(P('a', { kind: 'temporary', held: true, refused_count: 3 }))).toBe('Not sent again: Mailchimp refused them 3 times.')
  })
  it('a BOUNCED person is on the list with their address editable, and told what kind of bounce Mailchimp said it was', async () => {
    const a = api([P('full.inbox@gmail.com', { kind: 'temporary', held: false, bounce: 'unknown', mailchimp_said: 'full.inbox@gmail.com bounced.' })])
    await mount(<RefusedPeople locationId="loc" count={1} doFetch={a.fetchImpl} onChanged={() => {}} />)
    await click(q('mc-refused-toggle'))
    expect(q('mc-refused-said')!.textContent).toBe('Mailchimp said: “full.inbox@gmail.com bounced.”')
    expect(q('mc-refused-bounce')!.textContent).toBe('Mailchimp didn’t say whether this bounce is for good, so Bee Hub tries again and stops after 3 tries.')
    expect(q('mc-refused-edit')).toBeTruthy()
    await click(q('mc-refused-edit'))
    expect(q('mc-refused-email')).toBeTruthy()
    expect(bounceWords({ bounce: 'hard' })).toContain('hard bounce')
    expect(bounceWords({ bounce: 'soft' })).toContain('soft bounce')
    expect(bounceWords({ bounce: null })).toBeNull()
  })
  it('no Try again button when nothing is held', async () => {
    const a = api([P('a@x.com', { kind: 'temporary', held: false })])
    await mount(<RefusedPeople locationId="loc" count={1} doFetch={a.fetchImpl} onChanged={() => {}} />)
    await click(q('mc-refused-toggle'))
    expect(q('mc-refused-retry')).toBeNull()
  })
})

describe('the refused route', () => {
  it('loads (a broken route file fails here, not only at build time), GET and POST', async () => {
    const m: any = await import('@/app/api/mailchimp/refused/route')
    expect([typeof m.GET, typeof m.POST]).toEqual(['function', 'function'])
  })
  it('a "no" has no route action: only retry and leave_out exist, and it uses the shared Mailchimp gate', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('app/api/mailchimp/refused/route.ts', 'utf8')
    expect(src).toContain("['retry', 'leave_out'].includes(body?.action)")
    expect(src).toContain('bounce: p.bounce')                        // the screen is told what kind of bounce
    expect(src).toContain('resolveMailchimpTarget(supabase, user.id, requested)')
  })
})
