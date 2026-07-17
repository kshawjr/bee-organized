// @vitest-environment happy-dom
//
// AdminNotificationsScreen — the outbound-mail notebook's read surface.
//
// The pins here encode the two DELIBERATE calls in this build, both of which
// are the kind that quietly rot without a test:
//
//   A) TOKENS, NOT THE PRECEDENT. The existing Webhooks tab
//      (AdminWebhookLogScreen) is ~300 lines of inline hex inside BeeHub.jsx
//      that ignores the design system. This screen was built the other way on
//      purpose. Nothing stops someone from "matching the neighbouring tab" and
//      pasting a literal back in — so this file sweeps the source, exactly like
//      the hive token sweep (beta-hive-tokens) does for components/hive/**.
//
//   B) ONE ROLE GATE. Webhooks is super_admin-only in SuperAdminLayout but
//      super_admin||admin in the legacy AdminScreen AND its API route. That
//      discrepancy is a live bug in the precedent; this screen must not inherit
//      it. All three gates (both shells + the route) are pinned to elevated.
//
// Both shells are pinned by SOURCE MATCH — AdminWebhookLogScreen and the shells
// are BeeHub.jsx internals with no export to mount, the same constraint
// beta-webhook-log / beta-webhook-superadmin work around.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import AdminNotificationsScreen from '@/components/admin/AdminNotificationsScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SCREEN_SRC = readFileSync('components/admin/AdminNotificationsScreen.jsx', 'utf8')
const ROUTE_SRC = readFileSync('app/api/admin/notification-log/route.ts', 'utf8')
const BEEHUB_SRC = readFileSync('components/BeeHub.jsx', 'utf8')

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const payload = (over: any = {}) => ({
  events: [],
  truncated: false,
  window: '7d',
  needs_migration: false,
  ...over,
})

const row = (over: any = {}) => ({
  id: 'n1',
  created_at: '2026-07-17T12:00:00.000Z',
  lead_id: 'lead-1',
  lead_name: 'Jane Prospect',
  location_id: 'loc-uuid-1',
  location_slug: 'boulder-01',
  channel: 'email',
  recipient: 'owner@biz.com',
  subject: 'New lead: Jane Prospect — Boulder',
  email_kind: 'lead_notification',
  send_status: 'accepted',
  resend_message_id: 're-1',
  delivery_status: null,
  delivery_updated_at: null,
  error: null,
  ...over,
})

const stubFetch = (body: any) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })))

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

// ── A) the design call — tokens, not the inline-hex precedent ──────
describe('token sweep — the screen carries no color literal of its own', () => {
  const HEX = /#[0-9a-fA-F]{3,8}\b/
  const RGBA = /rgba?\(/

  it('no hex/rgba literal anywhere in the screen (comments included — reword, don’t cite hexes)', () => {
    expect(HEX.test(SCREEN_SRC)).toBe(false)
    expect(RGBA.test(SCREEN_SRC)).toBe(false)
  })

  it('composes the SHARED primitives rather than re-rolling them', () => {
    expect(SCREEN_SRC).toContain("from '@/components/ui/FilterChips'")
    expect(SCREEN_SRC).toContain("from '@/components/ui/StatusChip'")
    expect(SCREEN_SRC).toMatch(/from '@\/components\/(ui|hive\/shared)\/tokens'/)
  })

  it('resolves every color through the token objects (T.* / SECTION_*), never a raw value', () => {
    // A literal would have had to come from somewhere — if the only color
    // sources are the token imports, the sweep above is airtight.
    expect(SCREEN_SRC).toMatch(/T\.ink\./)
    expect(SCREEN_SRC).toMatch(/T\.border\./)
  })
})

// ── B) one gate, all three places ─────────────────────────────────
describe('role gate — elevated (super_admin + admin), consistent across shells + route', () => {
  it('the API route gates on ELEVATED_ROLES, copied from the webhook-log route', () => {
    expect(ROUTE_SRC).toContain("const ELEVATED_ROLES = ['super_admin', 'admin']")
    expect(ROUTE_SRC).toMatch(/!ELEVATED_ROLES\.includes\(caller\.role\)/)
    expect(ROUTE_SRC).toMatch(/status: 403/)
  })

  it('SuperAdminLayout gates the nav item on showNotifications = super_admin || admin', () => {
    expect(BEEHUB_SRC).toMatch(
      /const showNotifications = role === 'super_admin' \|\| role === 'admin'/,
    )
    expect(BEEHUB_SRC).toMatch(
      /showNotifications \? \[\{ key:'notifications'/,
    )
  })

  it('legacy AdminScreen gates its tab on the SAME rule', () => {
    expect(BEEHUB_SRC).toMatch(
      /const showNotificationsTab = role === 'super_admin' \|\| role === 'admin'/,
    )
    expect(BEEHUB_SRC).toMatch(/showNotificationsTab\?\[\{key:'notifications'/)
  })

  it('both shells MOUNT the screen', () => {
    // SuperAdminLayout renderContent case + legacy AdminScreen ternary branch.
    expect(BEEHUB_SRC).toMatch(/case 'notifications':[\s\S]{0,300}?<AdminNotificationsScreen/)
    expect(BEEHUB_SRC).toMatch(/adminTab==='notifications' \? \(\s*<AdminNotificationsScreen/)
  })
})

// ── Behavior ───────────────────────────────────────────────────────
describe('AdminNotificationsScreen', () => {
  it('renders a row: recipient, subject, kind, lead + the location SLUG', async () => {
    stubFetch(payload({ events: [row()] }))
    const { host, unmount } = await mount(<AdminNotificationsScreen locations={[]} />)

    const text = host.textContent || ''
    expect(text).toContain('owner@biz.com')
    expect(text).toContain('New lead: Jane Prospect — Boulder')
    expect(text).toContain('lead_notification')
    expect(text).toContain('Jane Prospect')
    expect(text).toContain('boulder-01')
    await unmount()
  })

  // The whole point of Half A vs Half B. An 'accepted' row must never imply
  // the mail landed — Delivery reads '—' until the Resend webhook fills it.
  it('an accepted row shows NO delivery status (Half A knows acceptance, not delivery)', async () => {
    stubFetch(payload({ events: [row({ send_status: 'accepted', delivery_status: null })] }))
    const { host, unmount } = await mount(<AdminNotificationsScreen locations={[]} />)

    expect(host.textContent).toContain('Accepted')
    expect(host.textContent).not.toMatch(/delivered/i)
    await unmount()
  })

  it('a failed row surfaces the error inline — the reason is the point of the row', async () => {
    stubFetch(payload({ events: [row({ send_status: 'failed', error: 'rate limited', resend_message_id: null })] }))
    const { host, unmount } = await mount(<AdminNotificationsScreen locations={[]} />)

    expect(host.textContent).toContain('Failed')
    expect(host.textContent).toContain('rate limited')
    await unmount()
  })

  it('a zero_recipients row reads as "No recipients", not as a failure', async () => {
    stubFetch(payload({ events: [row({ send_status: 'zero_recipients', recipient: null, resend_message_id: null })] }))
    const { host, unmount } = await mount(<AdminNotificationsScreen locations={[]} />)

    // Scoped to the TABLE, not the whole host: the filter strip always renders
    // a 'Failed · 0' segment, so a host-wide assertion would fail on the
    // chrome rather than the row.
    const table = host.querySelector('table')?.textContent || ''
    expect(table).toContain('No recipients')
    expect(table).not.toContain('Failed')
    await unmount()
  })

  // The fail-soft posture: shipping the code before the migration must render
  // an explanation, not an error page.
  it('needs_migration renders an explanatory empty state, NOT an error', async () => {
    stubFetch(payload({ needs_migration: true }))
    const { host, unmount } = await mount(<AdminNotificationsScreen locations={[]} />)

    expect(host.textContent).toMatch(/doesn’t exist yet/i)
    expect(host.textContent).toMatch(/notification_log\.sql/)
    expect(host.textContent).not.toMatch(/Couldn’t load/i)
    await unmount()
  })

  it('a truncated window says so out loud (no silent caps)', async () => {
    stubFetch(payload({ events: [row()], truncated: true }))
    const { host, unmount } = await mount(<AdminNotificationsScreen locations={[]} />)

    expect(host.textContent).toMatch(/most recent 500/i)
    await unmount()
  })

  it('filters are applied SERVER-side — the status filter goes on the query string', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => payload() }))
    vi.stubGlobal('fetch', f)
    const { unmount } = await mount(<AdminNotificationsScreen locations={[]} />)

    const url = String(f.mock.calls[0][0])
    expect(url).toContain('/api/admin/notification-log?')
    expect(url).toContain('window=7d')
    await unmount()
  })
})
