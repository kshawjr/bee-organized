// @vitest-environment happy-dom
//
// RECORD-IN-URL (engagement) — deep-link an engagement by URL.
//
// Clients/contacts/leads are the SAME people record and got a URL in 3c0ad3a
// + 46abed6 (/clients/<id>). ENGAGEMENTS were the one record type with no URL:
// they opened in HiveShell's standalone EngagementPanel with no pushState and
// no /engagements route. An engagement belongs to a client, so rather than a
// new /engagements/<id> route this reuses the client route with a ?e= param —
// /clients/<clientId>?e=<engagementId> — which INHERITS the client route's
// server-side location scoping (the parent client is already location-validated;
// a foreign deal can't be deep-linked for free).
//
// Pins:
//   A) parseHubUrl(pathname, search) / engagementPath — the ?e= vocabulary,
//      and the rule that ?e= only resolves under a /clients/<id> path.
//   B) nextRecordOverlay — the pure reducer's engagement half: ?e opens the
//      EngagementPanel overlay (minimal seed), a same-id URL is a no-op that
//      keeps the seed, an engagement in the URL WINS the shared slot, and it
//      closes when nothing is named.
//   C) HiveShell (rendered) — a /clients/<id>?e=<engId> deep-link (urlEngagementId
//      prop) opens the SAME standalone EngagementPanel a click produces (fetches
//      /api/engagements/<id>, NOT the client profile); clearing ?e swaps back to
//      the client profile; clearing both closes.
//   D) Wiring (source-pinned) — HiveShell drives the URL out (openEngagement →
//      onOpenEngagementUrl(client_id, id), panel close → onCloseRecord) and BeeHub
//      feeds it in (urlEngagementId) + builds the URL via engagementPath + reads
//      ?e on popstate.
//   E) Guard (source-pinned) — the ?e= is resolved + location-scoped SERVER-side:
//      the engagement must belong to the already-scoped client (.eq('client_id')).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHubUrl, engagementPath, clientPath, nextRecordOverlay } from '@/components/hive/shared/hubUrl'
import HiveShell from '@/components/hive/HiveShell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── A) pathname + search ↔ engagement id ───────────────────────
describe('parseHubUrl — ?e= engagement param', () => {
  it('extracts the engagement id from /clients/<id>?e=<engId>', () => {
    expect(parseHubUrl('/clients/lead-9', '?e=eng-7')).toEqual({ nav: 'hive', leadId: 'lead-9', engagementId: 'eng-7' })
  })
  it('finds ?e among other query params, and url-decodes it', () => {
    expect(parseHubUrl('/clients/lead-9', '?foo=1&e=eng-7&bar=2').engagementId).toBe('eng-7')
    expect(parseHubUrl('/clients/lead-9', '?e=a%2Db').engagementId).toBe('a-b')
  })
  it('is null when there is no ?e', () => {
    expect(parseHubUrl('/clients/lead-9', '').engagementId).toBe(null)
    expect(parseHubUrl('/clients/lead-9', undefined as any).engagementId).toBe(null)
  })
  it('DROPS ?e when there is no parent client id (an engagement needs its client)', () => {
    // /clients?e=x is meaningless — the client route is what carries scoping.
    expect(parseHubUrl('/clients', '?e=eng-7')).toEqual({ nav: 'hive', leadId: null, engagementId: null })
    // a non-clients route never carries an engagement
    expect(parseHubUrl('/reports', '?e=eng-7').engagementId).toBe(null)
  })
})

describe('engagementPath', () => {
  it('builds /clients/<clientId>?e=<engagementId>', () => {
    expect(engagementPath('lead-9', 'eng-7')).toBe('/clients/lead-9?e=eng-7')
  })
  it('round-trips through parseHubUrl', () => {
    const path = engagementPath('lead-9', 'eng-7')
    const [pathname, search] = path.split(/(?=\?)/)
    expect(parseHubUrl(pathname, search)).toEqual({ nav: 'hive', leadId: 'lead-9', engagementId: 'eng-7' })
  })
})

// ── B) URL → overlay reducer (engagement half) ─────────────────
describe('nextRecordOverlay — engagement cases', () => {
  it('opens an engagement overlay (minimal seed) when ?e names one', () => {
    expect(nextRecordOverlay('lead-9', 'eng-7', null))
      .toEqual({ type: 'engagement', engagement: { id: 'eng-7', client_id: 'lead-9' } })
  })
  it('carries client_id null when the engagement has no client in the URL', () => {
    expect(nextRecordOverlay(null, 'eng-7', null))
      .toEqual({ type: 'engagement', engagement: { id: 'eng-7', client_id: null } })
  })
  it('is a same-ref no-op when ?e re-confirms the open engagement (preserves the full seed)', () => {
    // A click opened it with a FULL board-row seed; the URL echo must not
    // clobber that with the minimal {id, client_id}.
    const open = { type: 'engagement', engagement: { id: 'eng-7', client_id: 'lead-9', title: 'Roof Repair', stage: 'Assessment Scheduled' } }
    expect(nextRecordOverlay('lead-9', 'eng-7', open)).toBe(open)
  })
  it('swaps to the new engagement when ?e changes', () => {
    const open = { type: 'engagement', engagement: { id: 'eng-7', client_id: 'lead-9', title: 'Roof Repair' } }
    expect(nextRecordOverlay('lead-9', 'eng-8', open))
      .toEqual({ type: 'engagement', engagement: { id: 'eng-8', client_id: 'lead-9' } })
  })
  it('an engagement in the URL WINS the shared slot over an open client overlay', () => {
    const client = { type: 'client', clientId: 'lead-9', siblings: ['lead-9', 'lead-10'] }
    expect(nextRecordOverlay('lead-9', 'eng-7', client))
      .toEqual({ type: 'engagement', engagement: { id: 'eng-7', client_id: 'lead-9' } })
  })
  it('clearing ?e (client stays) swaps the engagement overlay back to the client profile', () => {
    const eng = { type: 'engagement', engagement: { id: 'eng-7', client_id: 'lead-9' } }
    expect(nextRecordOverlay('lead-9', null, eng)).toEqual({ type: 'client', clientId: 'lead-9', siblings: null })
  })
})

// ── C) HiveShell: deep-link opens the standalone EngagementPanel ─
const engagementPayload = () => ({
  engagement: {
    id: 'eng-7', client_id: 'lead-9', title: 'Roof Repair', stage: 'Assessment Scheduled',
    created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    total_paid: 0, total_invoiced: 0, description: null, project_type: null,
    closed_at: null, closed_reason: null, closed_note: null, location_uuid: 'loc-uuid-1',
  },
  children: { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] },
  client: { id: 'lead-9', name: 'Dana Deeplink', email: 'dana@x.com', phone: '(561) 555-0100' },
  assignees: [],
})
const profilePayload = () => ({
  client: {
    id: 'lead-9', name: 'Dana Deeplink', first_name: 'Dana', last_name: 'Deeplink',
    email: 'dana@x.com', phone: '(561) 555-0100', address: '12 Hive Ln', city: 'Denver', state: 'CO', zip: '80014',
    created_at: new Date(Date.now() - 40 * 86400000).toISOString(), source: 'Webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Denver',
  },
  referred_us: [], contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})

const installFetch = () => {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url)
    if (u.includes('/api/engagements/eng-7')) return { ok: true, status: 200, json: async () => engagementPayload() }
    if (u.includes('/profile')) return { ok: true, status: 200, json: async () => profilePayload() }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

const PEOPLE = [{
  id: 'lead-9', name: 'Dana Deeplink', email: 'dana@x.com', phone: '555',
  locationId: 'loc-uuid-1', created: new Date().toISOString(), paidAmount: 0, paused: false,
  jobberRef: null, source: 'webform', outreachTimeline: [],
}]

const fetchedEngagement = () => (globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes('/api/engagements/eng-7'))
const fetchedProfile = () => (globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes('/api/clients/lead-9/profile'))

const renderShell = async (props: any) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<HiveShell engagements={[]} people={PEOPLE} locFilter="all" {...props} />)
  })
  await act(async () => { await Promise.resolve() })
  return { host, rerender: async (next: any) => {
    await act(async () => {
      root.render(<HiveShell engagements={[]} people={PEOPLE} locFilter="all" {...next} />)
    })
    await act(async () => { await Promise.resolve() })
  }, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

describe('HiveShell — /clients/<id>?e=<engId> deep-link opens the EngagementPanel', () => {
  beforeEach(() => { installFetch(); document.body.innerHTML = '';(globalThis as any).__BEE_TEST_WIDTH__ = 1200 })
  afterEach(() => { vi.unstubAllGlobals();(globalThis as any).__BEE_TEST_WIDTH__ = undefined })

  it('a urlEngagementId on mount opens the standalone EngagementPanel (NOT the client profile)', async () => {
    const { unmount } = await renderShell({ urlClientId: 'lead-9', urlEngagementId: 'eng-7' })
    // It went through the engagement route (EngagementPanel), not the profile.
    expect(fetchedEngagement()).toBe(true)
    expect(fetchedProfile()).toBe(false)
    await unmount()
  })

  it('clearing ?e (back to /clients/<id>) swaps to the client profile', async () => {
    const shell = await renderShell({ urlClientId: 'lead-9', urlEngagementId: 'eng-7' })
    expect(fetchedEngagement()).toBe(true)
    expect(fetchedProfile()).toBe(false)
    // browser back: /clients/lead-9?e=eng-7 → /clients/lead-9
    await shell.rerender({ urlClientId: 'lead-9', urlEngagementId: null })
    expect(fetchedProfile()).toBe(true)
    expect(shell.host.textContent).toContain('Dana Deeplink')
    await shell.unmount()
  })

  it('clearing both (back to bare /clients) closes the overlay', async () => {
    const shell = await renderShell({ urlClientId: 'lead-9', urlEngagementId: 'eng-7' })
    await shell.rerender({ urlClientId: null, urlEngagementId: null })
    // The engagement panel's client name is gone; no profile fetch happened.
    expect(shell.host.textContent).not.toContain('Dana Deeplink')
    expect(fetchedProfile()).toBe(false)
    await shell.unmount()
  })
})

// ── D) wiring, source-pinned ───────────────────────────────────
describe('wiring: HiveShell drives the engagement URL out', () => {
  const src = readFileSync('components/hive/HiveShell.jsx', 'utf8')
  it('openEngagement pushes /clients/<clientId>?e=<id> via onOpenEngagementUrl', () => {
    expect(src).toMatch(/const openEngagement = \(e\) => \{[\s\S]*?onOpenEngagementUrl\(e\.client_id, e\.id\)/)
  })
  it('closing the engagement panel clears the URL (onCloseRecord)', () => {
    expect(src).toMatch(/onClose=\{\(\) => \{ setOverlay\(null\); onCloseRecord\(\) \}\}/)
  })
  it('the URL ids feed the overlay via nextRecordOverlay (client + engagement)', () => {
    expect(src).toContain('import { nextRecordOverlay }')
    expect(src).toMatch(/setOverlay\(o => nextRecordOverlay\(urlClientId, urlEngagementId, o\)\)/)
  })
  it('exposes urlEngagementId + onOpenEngagementUrl props', () => {
    expect(src).toMatch(/urlEngagementId = null/)
    expect(src).toMatch(/onOpenEngagementUrl = \(\) => \{\}/)
  })
})

describe('wiring: BeeHub feeds the engagement URL in + out', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')
  it('passes urlEngagementId / onOpenEngagementUrl to the beta HiveShell', () => {
    expect(src).toMatch(/urlEngagementId=\{selectedEngagementId \|\| null\}/)
    expect(src).toMatch(/onOpenEngagementUrl=\{\(clientId, engagementId, opts\)=>\{/)
  })
  it('the selected→URL effect builds the engagement path via engagementPath', () => {
    expect(src).toContain('engagementPath')
    expect(src).toMatch(/selectedEngagementId \? engagementPath\(selected\.id, selectedEngagementId\)/)
  })
  it('popstate reads ?e from window.location.search', () => {
    expect(src).toMatch(/parseHubUrl\(window\.location\.pathname, window\.location\.search\)/)
  })
  it('opening a bare client clears the engagement param (client ⊃ engagement)', () => {
    expect(src).toMatch(/onOpenClient=\{\(clientId, opts\)=>\{[\s\S]*?setSelectedEngagementId\(null\)/)
  })
})

describe('guard: the ?e= is resolved + location-scoped SERVER-side', () => {
  // The deep-link relies on this: /clients/<id>?e=<engId> is resolved on the
  // server against the ALREADY location-scoped client — the engagement must
  // match .eq('client_id', <scoped client>), so a foreign/other-client deal
  // can't be deep-linked. A mismatch is silently dropped (client opens, panel
  // doesn't) — never an error that leaks whether the id exists.
  const hub = readFileSync('app/_hub-page.tsx', 'utf8')
  const route = readFileSync('app/clients/[id]/page.tsx', 'utf8')
  it('the [id] route forwards ?e as initialSelectedEngagementId', () => {
    expect(route).toMatch(/searchParams: Promise<\{ e\?: string \}>/)
    expect(route).toMatch(/initialSelectedEngagementId=\{typeof e === 'string' \? e : undefined\}/)
  })
  it('HubPage validates the engagement belongs to the scoped client', () => {
    expect(hub).toMatch(/\.eq\('id', initialSelectedEngagementId\)/)
    expect(hub).toMatch(/\.eq\('client_id', initialSelectedLeadId\)/)
  })
  it('HubPage only opens the engagement after the client passed its own scope check', () => {
    // client notfound-redirect must precede the engagement lookup
    expect(hub.indexOf("redirect('/clients?notfound=1')")).toBeLessThan(hub.indexOf(".eq('client_id', initialSelectedLeadId)"))
  })
})
