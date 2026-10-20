// @vitest-environment happy-dom
//
// The served-area guard on the "not in our service area" email
// (lib/no-coverage-guard.ts, run inside lib/lead-no-coverage.ts). Kevin,
// 20 Oct 2026: of the 8 no-coverage emails ever sent, 3 went to zips on a
// franchise's list and 7 were within 75 miles of a hive.
//   A. the 8 real emails, replayed against the rule on the real territory
//      snapshot: 3 blocked, 4 need confirmation, 1 clear
//   B. the shared close refuses from ANY door: blocked has no override;
//      confirm/unmeasured need the person's yes; a failed check refuses
//   C. the API's GET check names the claimant and its location id
//   D. the Inbox modal: no Send on a block, "Route to X instead"; a tick box
//      before Send within 75 miles; nothing until the check answers
//   E. no other path can send the email
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const h = vi.hoisted(() => ({
  lead: null as any,
  updates: [] as { table: string; arg: any }[],
  inserts: [] as { table: string; arg: any }[],
  locs: [] as any[],
  checkThrows: false,
  role: 'admin',
  selects: [] as { table: string; cols: string }[],
}))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      const b: any = {}
      for (const m of ['eq', 'in']) b[m] = () => b
      b.select = (cols: string) => { h.selects.push({ table, cols: String(cols) }); return b }
      b.update = (arg: any) => { h.updates.push({ table, arg }); return b }
      b.insert = (arg: any) => { h.inserts.push({ table, arg }); return b }
      const res = () => (table === 'leads' ? { data: h.lead, error: null } : table === 'locations' ? { data: h.locs, error: null } : { data: null, error: null })
      b.single = async () => res()
      b.maybeSingle = async () => res()
      b.then = (r: any, j: any) => Promise.resolve(res()).then(r, j)
      return b
    },
  },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'web-user' } } }) },
    from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: { id: 'web-user', role: h.role, location_id: null }, error: null }); return b },
  })),
}))
vi.mock('@/lib/no-coverage-email', () => ({
  sendNoCoverageEmail: vi.fn(async () => ({ success: true })),
  firstNameOf: () => 'Jess',
}))
// The map: the REAL ranking over the real territory snapshot.
vi.mock('@/lib/zip-proximity', async (orig) => {
  const real: any = await orig()
  const { readFileSync: rf } = await import('node:fs')
  const { join: j } = await import('node:path')
  const snap = JSON.parse(rf(j(process.cwd(), 'lib/fixtures/zip-proximity-snapshot.json'), 'utf8'))
  const coords = new Map(Object.entries(snap.coords as Record<string, any[]>).map(([z, [lat, lng, state, states]]) => [z, { lat, lng, state, states }]))
  return {
    ...real,
    nearestLocationsForZip: vi.fn(async (zip: unknown, state: unknown, limit: number) => {
      if (h.checkThrows) throw new Error('zip_coords read failed: down')
      return real.rankNearestLocations({ zip, leadState: state, coords, claims: snap.claims, limit })
    }),
  }
})

vi.mock('@/lib/other-card-sync', async (orig) => {
  const real: any = await orig()
  return { ...real, retireOtherCards: vi.fn(async () => ({ edited: 1, failed: 0 })), actorName: vi.fn(async () => 'Leslie Mullins') }
})

import { retireOtherCards } from '@/lib/other-card-sync'
import { checkNoCoverage, mayEmailNoCoverage, verdictWords, verdictFromSuggestion, type NoCoverageVerdict } from '@/lib/no-coverage-guard'
import { closeLeadAsNoCoverage } from '@/lib/lead-no-coverage'
import { GET as CHECK } from '@/app/api/leads/[id]/no-coverage/route'
import { sendNoCoverageEmail } from '@/lib/no-coverage-email'
import NoCoverageModal from '@/components/hive/NoCoverageModal'

const LEAD = (over: any = {}) => ({
  id: 'lead-1', name: 'Jessica Example', first_name: 'Jessica', email: 'j@example.com', city: null, state: null,
  zip: '60173', location_id: 'loc_other', location_uuid: 'uuid-other', inbox_dismissed_at: null, marketing_consented_at: null, ...over,
})
const ADMIN = { hubUserId: 'hu-leslie', role: 'admin' }

beforeEach(() => {
  vi.clearAllMocks()
  h.lead = LEAD()
  h.updates = []
  h.inserts = []
  h.locs = []
  h.checkThrows = false
  h.role = 'admin'
  h.selects = []
})

// ═══ A. the real eight ═══════════════════════════════════════════
describe('A. the 8 no-coverage emails ever sent, replayed against the rule', () => {
  it.each([
    ['Lyndsay McIntosh', '89509', 'blocked', 'Reno'],
    ['Alice McKeon', '89431', 'blocked', 'Reno'],
    ['Loujean Potter', '92651', 'blocked', 'South Orange County'],
    ['Jessica Mawhinney', '33928', 'confirm', 'Miami · 48'],
    ['Sabrina Pernyeszi', '89403', 'confirm', 'Reno · 22'],
    ['Mark Cassidy', '11747', 'confirm', 'North Jersey · 42'],
    ['b e cky carter', '65802', 'confirm', 'Northwest Arkansas · 70'],
    ['Taylor Brutlag', '55424', 'clear', 'Sioux Falls · 162'],
  ])('%s (%s) → %s (%s)', async (_who, zip, kind, detail) => {
    const v = await checkNoCoverage({ id: 'x', zip, state: null })
    expect(v.kind).toBe(kind)
    if (v.kind === 'blocked') expect(v.claimants.map((c) => c.name)).toEqual([detail])
    if (v.kind === 'confirm' || v.kind === 'clear') expect(`${v.nearest!.name} · ${v.nearest!.miles}`).toBe(detail)
  })

  it('a claimed PO-box zip the Census lacks (02901) is still blocked', async () => {
    expect(await checkNoCoverage({ id: 'x', zip: '02901', state: null })).toMatchObject({ kind: 'blocked', claimants: [{ name: 'Rhode Island' }] })
  })

  it.each([
    [null, 'no_zip'],
    ['', 'no_zip'],
    ['K1A 0B1', 'unreadable_zip'],
    ['11111', 'unknown_zip'],
  ])('zip %j → unmeasured (%s)', async (zip, why) => {
    expect(await checkNoCoverage({ id: 'x', zip: zip as any, state: null })).toMatchObject({ kind: 'unmeasured', why })
  })

  it('no hive that takes leads to measure to → unmeasured (no_hive), never clear', () => {
    const s: any = { kind: 'nearby', zip: '00000', options: [], showNotInServiceArea: false }
    expect(verdictFromSuggestion(s)).toEqual({ kind: 'unmeasured', zip: '00000', why: 'no_hive' })
  })

  it('the 75-mile line is the Slack card\'s line: 75 as shown confirms, 76 is clear', () => {
    const at = (miles: number, show: boolean): any => ({ kind: 'nearby', zip: '00000', options: [{ slug: 'loc_a', name: 'A', miles, lifecycle_status: 'active', label: '', highlighted: false }], showNotInServiceArea: show })
    expect(verdictFromSuggestion(at(75, false)).kind).toBe('confirm')
    expect(verdictFromSuggestion(at(76, true)).kind).toBe('clear')
  })
})

describe('mayEmailNoCoverage and the words', () => {
  const blocked: NoCoverageVerdict = { kind: 'blocked', zip: '89509', claimants: [{ slug: 'loc_reno', name: 'Reno' }] }
  const confirm: NoCoverageVerdict = { kind: 'confirm', zip: '33928', nearest: { slug: 'loc_miami', name: 'Miami', miles: 48 } }
  const unmeasured: NoCoverageVerdict = { kind: 'unmeasured', zip: null, why: 'no_zip' }
  const clear: NoCoverageVerdict = { kind: 'clear', zip: '55424', nearest: { slug: 'loc_siouxfalls', name: 'Sioux Falls', miles: 162 } }

  it('blocked is never sendable, confirmed or not', () => {
    expect(mayEmailNoCoverage(blocked, false)).toBe(false)
    expect(mayEmailNoCoverage(blocked, true)).toBe(false)
  })
  it('confirm and unmeasured need the yes', () => {
    for (const v of [confirm, unmeasured]) {
      expect(mayEmailNoCoverage(v, false)).toBe(false)
      expect(mayEmailNoCoverage(v, true)).toBe(true)
    }
  })
  it('clear sends either way', () => {
    expect(mayEmailNoCoverage(clear, false)).toBe(true)
  })
  it('the words name who and how far', () => {
    expect(verdictWords(blocked)).toBe("Zip 89509 is on Reno's zip list — that is their territory, so Bee Hub won't send the not-in-area email. Route the lead to Reno instead.")
    expect(verdictWords(confirm)).toBe("Miami is 48 mi from zip 33928. Check they're really out of range before sending.")
    expect(verdictWords(unmeasured)).toBe("This lead has no zip, so Bee Hub can't tell how far they are from a hive. Check they're really out of range before sending.")
    expect(verdictWords({ ...blocked, claimants: [{ slug: 'a', name: 'Denver' }, { slug: 'b', name: 'West Denver' }] })).toContain("Denver and West Denver's zip list")
  })
})

// ═══ B. the shared close — every door ═══════════════════════════
const sentNothing = () => {
  expect(sendNoCoverageEmail).not.toHaveBeenCalled()
  expect(h.updates).toEqual([]) // no token minted, nothing dismissed
  expect(h.inserts).toEqual([])
}

describe('B. closeLeadAsNoCoverage refuses a served area from any door', () => {
  it('a claimed zip → 409 zip_claimed, nothing minted or sent — and confirming changes nothing', async () => {
    h.lead = LEAD({ zip: '89509' })
    for (const confirmedOutOfRange of [false, true]) {
      const out = await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN, confirmedOutOfRange })
      expect(out.status).toBe(409)
      expect(out.body.error).toBe('zip_claimed')
      expect(out.body.detail).toContain("Reno's zip list")
      sentNothing()
    }
  })

  it('a hive within 75 miles, not confirmed → 409 needs_confirmation with the hive and miles; nothing sent', async () => {
    h.lead = LEAD({ zip: '33928' })
    const out = await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN })
    expect(out).toMatchObject({ status: 409, body: { error: 'needs_confirmation', verdict: { kind: 'confirm', nearest: { name: 'Miami', miles: 48 } } } })
    sentNothing()
  })

  it('…confirmed → sent, and the timeline says it was sent after confirming, with the miles', async () => {
    h.lead = LEAD({ zip: '33928' })
    const out = await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN, confirmedOutOfRange: true })
    expect(out.status).toBe(200)
    expect(sendNoCoverageEmail).toHaveBeenCalledTimes(1)
    const note = h.inserts.find((i) => i.table === 'touchpoints')!.arg.notes
    expect(note).toContain("Sent after confirming they're out of range: Miami is 48 mi from zip 33928.")
  })

  it('no zip, not confirmed → refused; confirmed → sent', async () => {
    h.lead = LEAD({ zip: null })
    expect((await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN })).body.error).toBe('needs_confirmation')
    sentNothing()
    expect((await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN, confirmedOutOfRange: true })).status).toBe(200)
  })

  it('past 75 miles, no claim → sent with no friction and no extra note', async () => {
    h.lead = LEAD({ zip: '55424' })
    const out = await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN })
    expect(out.status).toBe(200)
    expect(out.body.verdict).toMatchObject({ kind: 'clear' })
    expect(h.inserts.find((i) => i.table === 'touchpoints')!.arg.notes).not.toContain('Sent after confirming')
  })

  it('a sent email edits Other\'s card: who was told and by whom', async () => {
    h.lead = LEAD({ zip: '55424' })
    await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN })
    expect(retireOtherCards).toHaveBeenCalledWith({ leadId: 'lead-1', resolution: 'no_coverage', line: "📭 Told j@example.com we don't serve their area yet (mailing-list link sent) — by Leslie Mullins." })
  })

  it('a refused email never touches the card', async () => {
    h.lead = LEAD({ zip: '89509' })
    await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN })
    expect(retireOtherCards).not.toHaveBeenCalled()
  })

  it('the check fails → 503, nothing sent (fail closed)', async () => {
    h.checkThrows = true
    const out = await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN, confirmedOutOfRange: true })
    expect(out.status).toBe(503)
    expect(out.body.error).toBe('coverage_check_failed')
    sentNothing()
  })

  it('the close reads the lead\'s zip and state — the check needs both', async () => {
    await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN })
    const cols = h.selects.find((x) => x.table === 'leads')!.cols.split(',').map((c) => c.trim())
    expect(cols).toEqual(expect.arrayContaining(['zip', 'state']))
  })

  it('a claimed zip is refused even when the lead has no email (the block is reported first)', async () => {
    h.lead = LEAD({ zip: '89509', email: null })
    expect((await closeLeadAsNoCoverage({ leadId: 'lead-1', actor: ADMIN })).body.error).toBe('zip_claimed')
  })
})

// ═══ C. the API check ═════════════════════════════════════════════
const get = () => CHECK({} as any, { params: Promise.resolve({ id: 'lead-1' }) })

describe('C. GET /api/leads/:id/no-coverage — the verdict before anything is sent', () => {
  it('blocked: names the claimant with its location id, so the modal can route there', async () => {
    h.lead = LEAD({ zip: '89509' })
    h.locs = [{ id: 'uuid-reno', location_id: 'loc_reno' }]
    const res = await get()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.verdict.kind).toBe('blocked')
    expect(j.claimants).toEqual([{ slug: 'loc_reno', name: 'Reno', id: 'uuid-reno' }])
    expect(j.words).toContain("Reno's zip list")
    sentNothing()
  })

  it('confirm: the hive and the miles', async () => {
    h.lead = LEAD({ zip: '33928' })
    const j = await (await get()).json()
    expect(j.verdict).toMatchObject({ kind: 'confirm', nearest: { name: 'Miami', miles: 48 } })
    expect(j.claimants).toBeUndefined()
  })

  it('a non-corporate user → 403', async () => {
    h.role = 'owner'
    expect((await get()).status).toBe(403)
  })

  it('the check fails → 503', async () => {
    h.checkThrows = true
    expect((await get()).status).toBe(503)
  })

  it('no lead → 404', async () => {
    h.lead = null
    expect((await get()).status).toBe(404)
  })
})

// ═══ D. the Inbox modal ═══════════════════════════════════════════
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const PERSON = { id: 'lead-1', name: 'Jessica Example', email: 'j@example.com', firstName: 'Jessica', city: null, state: null }
const fetchWith = (check: any, post: any = { ok: true, status: 200, body: { success: true, dismissed: true } }) => {
  const mock = vi.fn(async (_url: any, init?: any) =>
    (init?.method || 'GET') === 'GET'
      ? { ok: check.ok ?? true, status: check.status ?? 200, json: async () => check.body }
      : { ok: post.ok, status: post.status, json: async () => post.body })
  ;(globalThis as any).fetch = mock
  return mock
}
const sendBtn = () => document.querySelector('[data-bee-no-coverage-send]') as HTMLButtonElement | null

describe('D. the No coverage modal', () => {
  it('blocked: no Send button at all; the claimant is named; "Route to Reno instead" hands back its id', async () => {
    fetchWith({ body: { verdict: { kind: 'blocked', zip: '89509', claimants: [{ slug: 'loc_reno', name: 'Reno' }] }, words: "Zip 89509 is on Reno's zip list — that is their territory.", claimants: [{ slug: 'loc_reno', name: 'Reno', id: 'uuid-reno' }] } })
    const onRouteInstead = vi.fn()
    const { unmount } = await mount(<NoCoverageModal person={PERSON} onRouteInstead={onRouteInstead} />)
    expect(document.querySelector('[data-bee-coverage-check="blocked"]')!.textContent).toContain("Reno's zip list")
    expect(sendBtn()).toBeNull()
    const route = document.querySelector('[data-bee-route-instead="uuid-reno"]') as HTMLButtonElement
    expect(route.textContent).toBe('Route to Reno instead')
    await act(async () => { route.click() })
    expect(onRouteInstead).toHaveBeenCalledWith('uuid-reno')
    await unmount()
  })

  it('confirm: the hive and miles shown; Send is off until the tick; the POST says confirmed', async () => {
    const mock = fetchWith({ body: { verdict: { kind: 'confirm', zip: '33928', nearest: { slug: 'loc_miami', name: 'Miami', miles: 48 } }, words: 'Miami is 48 mi from zip 33928.' } })
    const { unmount } = await mount(<NoCoverageModal person={PERSON} />)
    expect(document.querySelector('[data-bee-coverage-check="confirm"]')!.textContent).toContain('Miami is 48 mi away')
    expect(sendBtn()!.disabled).toBe(true)
    const tick = document.querySelector('[data-bee-confirm-out-of-range]') as HTMLInputElement
    await act(async () => { tick.click() })
    expect(sendBtn()!.disabled).toBe(false)
    await act(async () => { sendBtn()!.click() })
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve() })
    const post = mock.mock.calls.find((c: any) => c[1]?.method === 'POST')!
    expect(JSON.parse(post[1].body)).toEqual({ confirmed_out_of_range: true })
    await unmount()
  })

  it('unmeasured: says Bee Hub can\'t tell where they are; needs the tick too', async () => {
    fetchWith({ body: { verdict: { kind: 'unmeasured', zip: null, why: 'no_zip' }, words: "This lead has no zip, so Bee Hub can't tell how far they are from a hive." } })
    const { unmount } = await mount(<NoCoverageModal person={PERSON} />)
    expect(document.querySelector('[data-bee-coverage-check="unmeasured"]')!.textContent).toContain('Bee Hub can’t tell where they are')
    expect(sendBtn()!.disabled).toBe(true)
    await unmount()
  })

  it('clear: Send is on, no tick box, and the POST is not "confirmed"', async () => {
    const mock = fetchWith({ body: { verdict: { kind: 'clear', zip: '55424', nearest: { slug: 'loc_siouxfalls', name: 'Sioux Falls', miles: 162 } }, words: 'The nearest hive, Sioux Falls, is 162 mi away.' } })
    const { unmount } = await mount(<NoCoverageModal person={PERSON} />)
    expect(document.querySelector('[data-bee-confirm-out-of-range]')).toBeNull()
    expect(sendBtn()!.disabled).toBe(false)
    await act(async () => { sendBtn()!.click() })
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve() })
    expect(JSON.parse(mock.mock.calls.find((c: any) => c[1]?.method === 'POST')![1].body)).toEqual({})
    await unmount()
  })

  it('the check fails: Send stays off and the modal says why', async () => {
    fetchWith({ ok: false, status: 503, body: { error: 'coverage_check_failed' } })
    const { unmount } = await mount(<NoCoverageModal person={PERSON} />)
    expect(document.querySelector('[data-bee-coverage-check="failed"]')!.textContent).toContain("won't send this until it can check")
    expect(sendBtn()!.disabled).toBe(true)
    await unmount()
  })

  it('while the check is still running, Send is off', async () => {
    ;(globalThis as any).fetch = vi.fn(() => new Promise(() => {}))
    const { unmount } = await mount(<NoCoverageModal person={PERSON} />)
    expect(document.querySelector('[data-bee-coverage-check="loading"]')).toBeTruthy()
    expect(sendBtn()!.disabled).toBe(true)
    await unmount()
  })
})

describe('D. in the Inbox: a blocked lead → "Route to Reno instead" → the transfer opens with Reno chosen', () => {
  it('end to end through InboxScreen', async () => {
    const { default: InboxScreen } = await import('@/components/hive/InboxScreen')
    ;(globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url)
      if (u.includes('/api/locations/transfer-targets')) {
        return { ok: true, status: 200, json: async () => ({ targets: [
          { id: 'uuid-sanfrancisco', name: 'San Francisco', slug: 'loc_sanfrancisco', lifecycle_status: 'onboarding', owner_name: null },
          { id: 'uuid-reno', name: 'Reno', slug: 'loc_reno', lifecycle_status: 'onboarding', owner_name: null },
        ] }) }
      }
      if (u.includes('/no-coverage') && (init?.method || 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => ({
          verdict: { kind: 'blocked', zip: '89509', claimants: [{ slug: 'loc_reno', name: 'Reno' }] },
          words: "Zip 89509 is on Reno's zip list — that is their territory.",
          claimants: [{ slug: 'loc_reno', name: 'Reno', id: 'uuid-reno' }],
        }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    const lead = {
      id: 'lead-ly', name: 'Lyndsay McIntosh', email: 'l@example.com', phone: null, phoneNormalized: null,
      locationId: 'loc-other-uuid', atLocOther: true, created: new Date().toISOString(), isJunk: false,
      snoozeUntil: null, inboxDismissedAt: null, jobberRef: null, outreachTimeline: [], originZip: '89509',
    }
    const { host, unmount } = await mount(<InboxScreen people={[]} transferPeople={[lead] as any} engagements={[]} locFilter="all" />)
    const pill = Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'No coverage')!
    await act(async () => { pill.click() })
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
    const route = document.querySelector('[data-bee-route-instead="uuid-reno"]') as HTMLButtonElement
    expect(route).toBeTruthy()
    await act(async () => { route.click() })
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
    // The no-coverage modal is gone; the transfer is open with Reno selected.
    expect(document.querySelector('[data-bee-coverage-check]')).toBeNull()
    const selected = Array.from(document.querySelectorAll('[role="option"][aria-selected="true"]')).map((o) => o.textContent || '')
    expect(selected).toHaveLength(1)
    expect(selected[0]).toContain('Reno')
    await unmount()
  })
})

// ═══ E. no other door ═════════════════════════════════════════════
describe('E. every door goes through the guard', () => {
  it('only lib/lead-no-coverage.ts calls sendNoCoverageEmail, and it checks first', () => {
    const lib = readFileSync(join(process.cwd(), 'lib/lead-no-coverage.ts'), 'utf8')
    const check = lib.indexOf('await checkNoCoverage(')
    expect(check).toBeGreaterThan(-1)
    expect(lib.indexOf('optin_token: token')).toBeGreaterThan(check)
    expect(lib.indexOf('await sendNoCoverageEmail(')).toBeGreaterThan(check)
    for (const f of ['app/api/leads/[id]/no-coverage/route.ts', 'lib/route-suggestion-actions.ts', 'components/hive/NoCoverageModal.jsx']) {
      expect(readFileSync(join(process.cwd(), f), 'utf8')).not.toContain('sendNoCoverageEmail(')
    }
  })

  it('the Slack button never confirms on a person\'s behalf', () => {
    expect(readFileSync(join(process.cwd(), 'lib/route-suggestion-actions.ts'), 'utf8')).toContain('confirmedOutOfRange: false')
  })
})
