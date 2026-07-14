// @vitest-environment happy-dom
//
// Lead deep-linking (Inbox → ClientProfile + URL) and the safe post-login
// return-to threading. Builds on 3c0ad3a (client record-in-URL): a lead and
// a client are the SAME record, so a lead must be deep-linkable exactly like
// a client.
//
// Pins:
//   A) HiveShell — clicking a lead in the Inbox opens the UNIFIED
//      ClientProfile overlay and drives the URL (onOpenClient), instead of the
//      retired PersonCard overlay that cleared it. (Deep-link-on-load →
//      ClientProfile is pinned in beta-record-url-deeplink.test.tsx.)
//   B) safeNextPath — same-origin relative only (open-redirect guard).
//   C) ?next threading — requireAuth/login/callback/_hub-page carry the
//      intended lead URL through login so a logged-out cold arrival lands on
//      the lead, not home.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import HiveShell from '@/components/hive/HiveShell'
import { safeNextPath } from '@/lib/safe-next'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── A) Inbox lead open → ClientProfile overlay + URL ───────────
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const LEAD = {
  id: 'lead-9', name: 'Ida Inbox', email: 'ida@x.com', phone: '(561) 555-0199',
  locationId: 'loc-uuid-1', created: daysAgo(3), // recent, no outreach → New row
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null,
  paidAmount: 0, paused: false, source: 'webform', outreachTimeline: [],
}

const profilePayload = () => ({
  client: {
    id: 'lead-9', name: 'Ida Inbox', first_name: 'Ida', last_name: 'Inbox',
    email: 'ida@x.com', phone: '(561) 555-0199', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(3), source: 'webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: 'Garage please', project_type: null, location_name: 'Boulder',
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

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

describe('HiveShell — Inbox lead open is unified on ClientProfile + drives the URL', () => {
  beforeEach(() => {
    installFetch()
    document.body.innerHTML = ''
    ;(globalThis as any).__BEE_TEST_WIDTH__ = 1200
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    ;(globalThis as any).__BEE_TEST_WIDTH__ = undefined
  })

  it('clicking an Inbox lead row calls onOpenClient(id) (URL push) and opens ClientProfile', async () => {
    const onOpenClient = vi.fn()
    const m = await mount(
      <HiveShell engagements={[]} people={[LEAD]} locFilter="all" onOpenClient={onOpenClient} />,
    )
    // Switch to the Inbox lens via its tab (sets state directly — no reliance
    // on localStorage hydration, which isn't available in this env).
    const inboxTab = [...m.host.querySelectorAll('button')]
      .find(b => (b.textContent || '').includes('Inbox'))
    expect(inboxTab).toBeTruthy()
    await click(inboxTab!)
    await act(async () => { await Promise.resolve() })

    const row = m.host.querySelector('.bee-inbox-row')
    expect(row).toBeTruthy()
    await click(row!)
    await act(async () => { await Promise.resolve() })

    // The URL-driving callback fired with the lead id — the old PersonCard
    // path did NOT call this. This is the regression Kevin reported.
    expect(onOpenClient).toHaveBeenCalledWith('lead-9')
    // And the overlay that opened fetched the client profile (ClientProfile),
    // not a people-list panel.
    expect((globalThis.fetch as any).mock.calls.some(
      (c: any[]) => String(c[0]).includes('/api/clients/lead-9/profile'),
    )).toBe(true)

    await m.unmount()
  })
})

describe('HiveShell wiring (source-pinned): lead overlay unified on ClientProfile', () => {
  const src = readFileSync('components/hive/HiveShell.jsx', 'utf8')
  it('openPerson routes to openClient(person.id) (URL-driving), not a person overlay', () => {
    expect(src).toMatch(/const openPerson = \(person\) => \{ if \(person\?\.id\) openClient\(person\.id\) \}/)
  })
  it('the PersonCard overlay slot is retired (no type:person render, no import)', () => {
    expect(src).not.toContain("overlay?.type === 'person'")
    expect(src).not.toContain("import PersonCard from './PersonCard'")
  })
  it('new-lead create opens the unified ClientProfile overlay too', () => {
    expect(src).toMatch(/if \(person\?\.id\) openClient\(person\.id\)/)
  })
})

// ── B) safeNextPath — open-redirect guard ──────────────────────
describe('safeNextPath', () => {
  it('accepts same-origin relative paths', () => {
    expect(safeNextPath('/clients/abc-123')).toBe('/clients/abc-123')
    expect(safeNextPath('/reports')).toBe('/reports')
    expect(safeNextPath('/clients/abc?tab=1')).toBe('/clients/abc?tab=1')
  })
  it('rejects protocol-relative and absolute URLs → "/"', () => {
    expect(safeNextPath('//evil.com')).toBe('/')
    expect(safeNextPath('https://evil.com')).toBe('/')
    expect(safeNextPath('http://evil.com/clients/x')).toBe('/')
    expect(safeNextPath('/\\evil.com')).toBe('/')
    expect(safeNextPath('/%2f%2fevil.com')).toBe('/')
  })
  it('rejects non-rooted, empty, null, and whitespace-smuggled → "/"', () => {
    expect(safeNextPath('relative')).toBe('/')
    expect(safeNextPath('')).toBe('/')
    expect(safeNextPath(null)).toBe('/')
    expect(safeNextPath(undefined)).toBe('/')
    expect(safeNextPath('/a b')).toBe('/')
    expect(safeNextPath('/a\nb')).toBe('/')
  })
})

// ── C) ?next threading (source-pinned) ─────────────────────────
describe('threading: logged-out cold arrival returns to the deep-link', () => {
  it('requireAuth builds /auth/login?next=<sanitized> from returnTo', () => {
    const src = readFileSync('lib/auth.ts', 'utf8')
    expect(src).toContain("import { safeNextPath } from './safe-next'")
    expect(src).toMatch(/requireAuth\(returnTo\?: string \| null\)/)
    expect(src).toMatch(/\/auth\/login\?next=\$\{encodeURIComponent\(safe\)\}/)
  })
  it('_hub-page computes returnTo from a /clients/[id] deep-link', () => {
    const src = readFileSync('app/_hub-page.tsx', 'utf8')
    // returnTo now also carries the optional ?e=<engagementId> so a logged-out
    // engagement deep-link returns to the engagement, not just the client.
    expect(src).toMatch(/initialSelectedLeadId\s*\n?\s*\?\s*`\/clients\/\$\{initialSelectedLeadId\}\$\{initialSelectedEngagementId \? `\?e=\$\{initialSelectedEngagementId\}` : ''\}`/)
    expect(src).toContain('await requireAuth(returnTo)')
  })
  it('login page forwards a sanitized next into the OAuth callback', () => {
    const src = readFileSync('app/auth/login/page.tsx', 'utf8')
    expect(src).toContain("import { safeNextPath } from '@/lib/safe-next'")
    expect(src).toMatch(/\/auth\/callback\?next=\$\{encodeURIComponent\(nextParam\)\}/)
  })
  it('callback sanitizes next before redirecting', () => {
    const src = readFileSync('app/auth/callback/route.ts', 'utf8')
    expect(src).toContain("import { safeNextPath } from '@/lib/safe-next'")
    expect(src).toMatch(/const next = safeNextPath\(searchParams\.get\('next'\)\)/)
  })
})
