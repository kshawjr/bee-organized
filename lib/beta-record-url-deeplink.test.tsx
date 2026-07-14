// @vitest-environment happy-dom
//
// RECORD-IN-URL (client) — restore after the beta cutover.
//
// Record-id-in-URL for clients was built in 063640a (/clients/<id> route +
// pushState + popstate) but drove off the CLASSIC board's `selected` state.
// When the beta board (HiveShell) became everyone's default (1f70ab4), the
// open client moved into HiveShell's LOCAL `overlay` state, which never
// touched the URL — the onOpenClient→setSelected→pushState chain went dead.
// This restores it by wiring HiveShell's client open/close to the URL and
// feeding the URL id back in so the overlay follows the URL.
//
// Pins:
//   A) parseHubUrl / clientPath — pathname ↔ open-client-id vocabulary.
//   B) nextClientOverlay — the pure reducer HiveShell's URL→overlay effect
//      uses: opens on a URL id, closes when it clears, PRESERVES an already-
//      open client's siblings (same-ref no-op), and leaves engagement/person
//      overlays alone (client-only scope).
//   C) HiveShell (rendered) — a /clients/<id> deep-link (urlClientId prop)
//      opens the ClientProfile overlay (NOT the legacy PersonPanel — the two
//      detail UIs are unified); clearing the URL id closes it.
//   D) Wiring (source-pinned) — HiveShell drives the URL out (openClient→
//      onOpenClient, close→onCloseRecord, chevron→replace) and BeeHub feeds
//      it in (urlClientId) + no longer renders PersonPanel-on-selected in the
//      beta block + supports replaceState for sibling walks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHubUrl, clientPath, nextClientOverlay } from '@/components/hive/shared/hubUrl'
import HiveShell from '@/components/hive/HiveShell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── A) pathname ↔ state ────────────────────────────────────────
describe('parseHubUrl', () => {
  it('maps the bare tabs to nav keys with no open client', () => {
    expect(parseHubUrl('/')).toEqual({ nav: 'home', leadId: null })
    expect(parseHubUrl('/clients')).toEqual({ nav: 'hive', leadId: null })
    expect(parseHubUrl('/contacts')).toEqual({ nav: 'partners', leadId: null })
    expect(parseHubUrl('/reports')).toEqual({ nav: 'reports', leadId: null })
    expect(parseHubUrl('/settings')).toEqual({ nav: 'settings', leadId: null })
    expect(parseHubUrl('/admin')).toEqual({ nav: 'admin', leadId: null })
  })
  it('extracts the open client id from /clients/<id>', () => {
    expect(parseHubUrl('/clients/abc-123')).toEqual({ nav: 'hive', leadId: 'abc-123' })
    // uuids survive intact (the deep-link id is resolved server-side, RLS-scoped)
    expect(parseHubUrl('/clients/9d62fc00-0000-4000-8000-000000000001'))
      .toEqual({ nav: 'hive', leadId: '9d62fc00-0000-4000-8000-000000000001' })
  })
  it('falls back to home for empty / unknown routes', () => {
    expect(parseHubUrl('')).toEqual({ nav: 'home', leadId: null })
    expect(parseHubUrl(null as any)).toEqual({ nav: 'home', leadId: null })
    expect(parseHubUrl('/nope')).toEqual({ nav: 'home', leadId: null })
    // a deeper /clients path (trailing segment) isn't a record id — it stays
    // on the Clients tab but opens NOTHING (leadId null), never a bad record.
    expect(parseHubUrl('/clients/x/y')).toEqual({ nav: 'hive', leadId: null })
  })
})

describe('clientPath', () => {
  it('builds the canonical open-client path', () => {
    expect(clientPath('lead-9')).toBe('/clients/lead-9')
  })
})

// ── B) URL → overlay reducer ───────────────────────────────────
describe('nextClientOverlay', () => {
  it('opens a client overlay when the URL names one and none is open', () => {
    expect(nextClientOverlay('a', null)).toEqual({ type: 'client', clientId: 'a', siblings: null })
  })
  it('is a same-ref no-op when the URL re-confirms the open client (preserves siblings)', () => {
    const open = { type: 'client', clientId: 'a', siblings: ['a', 'b', 'c'] }
    expect(nextClientOverlay('a', open)).toBe(open)
  })
  it('swaps to the new client when the URL id changes', () => {
    const open = { type: 'client', clientId: 'a', siblings: ['a', 'b'] }
    expect(nextClientOverlay('b', open)).toEqual({ type: 'client', clientId: 'b', siblings: null })
  })
  it('closes the client overlay when the URL id clears', () => {
    expect(nextClientOverlay(null, { type: 'client', clientId: 'a', siblings: null })).toBe(null)
  })
  it('leaves engagement / person overlays alone (client-only scope)', () => {
    const eng = { type: 'engagement', engagement: { id: 'e1' } }
    const per = { type: 'person', person: { id: 'p1' } }
    expect(nextClientOverlay(null, eng)).toBe(eng)
    expect(nextClientOverlay(null, per)).toBe(per)
  })
  it('a URL id wins over a non-client overlay (deep-link into a client)', () => {
    const eng = { type: 'engagement', engagement: { id: 'e1' } }
    expect(nextClientOverlay('a', eng)).toEqual({ type: 'client', clientId: 'a', siblings: null })
  })
})

// ── C) HiveShell: deep-link opens ClientProfile, not PersonPanel ─
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
    if (u.includes('/profile')) return { ok: true, status: 200, json: async () => profilePayload() }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

const PEOPLE = [{
  id: 'lead-9', name: 'Dana Deeplink', email: 'dana@x.com', phone: '555',
  locationId: 'loc-uuid-1', created: new Date().toISOString(), paidAmount: 0, paused: false,
  jobberRef: null, source: 'webform', outreachTimeline: [],
}]

const renderShell = async (props: any) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<HiveShell engagements={[]} people={PEOPLE} locFilter="all" {...props} />)
  })
  // flush the ClientProfile profile fetch
  await act(async () => { await Promise.resolve() })
  return { host, rerender: async (next: any) => {
    await act(async () => {
      root.render(<HiveShell engagements={[]} people={PEOPLE} locFilter="all" {...next} />)
    })
    await act(async () => { await Promise.resolve() })
  }, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

describe('HiveShell — /clients/<id> deep-link opens the ClientProfile overlay', () => {
  beforeEach(() => { installFetch(); document.body.innerHTML = '';(globalThis as any).__BEE_TEST_WIDTH__ = 1200 })
  afterEach(() => { vi.unstubAllGlobals();(globalThis as any).__BEE_TEST_WIDTH__ = undefined })

  it('a urlClientId on mount opens ClientProfile (unified detail UI — no legacy PersonPanel)', async () => {
    const { host, unmount } = await renderShell({ urlClientId: 'lead-9' })
    // ClientProfile fetched the profile and rendered the client name.
    expect(host.textContent).toContain('Dana Deeplink')
    // It went through the profile route (ClientProfile), not any people-list panel.
    expect((globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes('/api/clients/lead-9/profile'))).toBe(true)
    await unmount()
  })

  it('clearing urlClientId (browser back to /clients) closes the overlay', async () => {
    const shell = await renderShell({ urlClientId: 'lead-9' })
    expect(shell.host.textContent).toContain('Dana Deeplink')
    await shell.rerender({ urlClientId: null })
    expect(shell.host.textContent).not.toContain('Dana Deeplink')
    await shell.unmount()
  })
})

// ── D) wiring, source-pinned ───────────────────────────────────
describe('wiring: HiveShell drives the URL out', () => {
  const src = readFileSync('components/hive/HiveShell.jsx', 'utf8')
  it('openClient drives the URL (calls onOpenClient)', () => {
    expect(src).toMatch(/const openClient =[\s\S]*?onOpenClient\(clientId\)/)
  })
  it('closing the client overlay clears the URL (onCloseRecord)', () => {
    expect(src).toMatch(/onClose=\{\(\) => \{ setOverlay\(null\); onCloseRecord\(\) \}\}/)
  })
  it('prev/next chevron walk uses replace (no history bloat)', () => {
    expect(src).toMatch(/onOpenClient\(id, \{ replace: true \}\)/)
  })
  it('the URL id feeds the overlay via nextClientOverlay', () => {
    expect(src).toContain('import { nextClientOverlay }')
    expect(src).toMatch(/setOverlay\(o => nextClientOverlay\(urlClientId, o\)\)/)
  })
  it('exposes urlClientId + onCloseRecord props', () => {
    expect(src).toMatch(/urlClientId = null/)
    expect(src).toMatch(/onCloseRecord = \(\) => \{\}/)
  })
})

describe('wiring: BeeHub feeds the URL in + unifies the detail UIs', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')
  it('passes urlClientId / onOpenClient / onCloseRecord to the beta HiveShell', () => {
    expect(src).toMatch(/urlClientId=\{selected\?\.id \|\| null\}/)
    expect(src).toMatch(/onCloseRecord=\{\(\)=>setSelected\(null\)\}/)
    expect(src).toMatch(/onOpenClient=\{\(clientId, opts\)=>\{/)
  })
  it('the beta block no longer renders PersonPanel-on-selected (two detail UIs unified)', () => {
    // The beta early-return block ends at the classic `return (` — within it
    // there must be no <PersonPanel …> tied to `selected`.
    const betaBlock = src.slice(
      src.indexOf("if (view==='engagements' && newBoardAllowed) {"),
      src.indexOf('  return (\n    <div style={{ fontFamily'),
    )
    expect(betaBlock.length).toBeGreaterThan(500)
    expect(betaBlock).not.toContain('<PersonPanel')
  })
  it('the selected→URL effect supports replaceState for sibling walks', () => {
    expect(src).toMatch(/urlReplaceRef\.current \? 'replaceState' : 'pushState'/)
  })
  it('URL helpers come from the shared, testable hubUrl module', () => {
    expect(src).toMatch(/from "@\/components\/hive\/shared\/hubUrl"/)
  })
})

describe('guard: a deep-link is resolved + scoped SERVER-side (RLS/location)', () => {
  // The client-side restore relies on this: /clients/<id> is resolved against
  // the authed, location-scoped initialPeople on the server; an unknown or
  // out-of-scope id bounces to /clients?notfound=1 and never opens a panel.
  // Pin it so a future refactor can't silently drop the scoping guard.
  const hub = readFileSync('app/_hub-page.tsx', 'utf8')
  it('unknown / out-of-scope initialSelectedLeadId redirects to notfound', () => {
    expect(hub).toMatch(/initialPeople\.some\(\(p: any\) => p\.id === initialSelectedLeadId\)/)
    expect(hub).toContain("redirect('/clients?notfound=1')")
  })
})
