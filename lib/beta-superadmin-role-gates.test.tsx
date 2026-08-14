// SuperAdminLayout role gates vs the legacy AdminScreen — source pins for the
// sibling-sweep fixes (follow-up to the webhooks mount, 70ab517).
//
//   1) CONTENT: the legacy tab strip showed Content to super_admin AND
//      corporate (Leslie edits the Hive Hub Guide), but the sidebar had it in
//      the super_admin-only Advanced cluster — corporate lost it when
//      elevated users moved to SuperAdminLayout. It now lives in Operations
//      behind the explicit legacy gate. Configure / Recycle Bin / Webhooks
//      stay super_admin-only.
//
//   2) RENEWALS: KEPT visible to corporate (ratified by Kevin, 7/10 PM). The Billing
//      cluster's per-item gating (Conversions and Pricing individually
//      super_admin-wrapped, Renewals not) is deliberate — flip by wrapping
//      the renewals item in a role === 'super_admin' spread if reversed.
//
//   3) DEEP LINK: /admin?adminTab=feedback now maps to the sidebar's Feedback
//      section for both elevated roles, mirroring the legacy
//      showFeedbackTab gate (webhooks stays super_admin-only — pinned in
//      beta-webhook-superadmin).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

// SuperAdminLayout body (up to the legacy AdminScreen definition)
const layout = beehub.slice(
  beehub.indexOf('function SuperAdminLayout'),
  beehub.indexOf('function AdminScreen'),
)
// App body (holds the SuperAdminLayout mount + deep-link parse)
const app = beehub.slice(beehub.indexOf('export default function App'))

const groupsStart = layout.indexOf('const sidebarGroups')
const groupsEnd   = layout.indexOf('const SECTION_META')
const groups      = layout.slice(groupsStart, groupsEnd)
const advanced    = groups.slice(groups.indexOf("header: 'Advanced'"))

describe('role gates — Content restored for corporate', () => {
  it('Content sits in Operations behind the legacy super_admin-or-corporate gate', () => {
    const operations = groups.slice(
      groups.indexOf("header: 'Operations'"),
      groups.indexOf("header: 'Billing'"),
    )
    expect(operations).toMatch(
      /\.\.\.\(role === 'super_admin' \|\| role === 'corporate' \? \[\{ key:'content',\s*label:'Content',\s*icon:'✏️' \}\] : \[\]\)/,
    )
    // Exactly one sidebar entry — not also left behind in Advanced.
    expect(groups.match(/key:'content'/g)).toHaveLength(1)
    expect(advanced).not.toContain("key:'content'")
  })

  it('SECTION_META breadcrumbs Content under Operations', () => {
    expect(layout).toMatch(/content:\s*\{ label:'Content',\s*cluster:'Operations'\s*\}/)
  })

  it('Configure, Recycle Bin and Webhooks stay inside the super_admin-only Advanced cluster', () => {
    // The Advanced group is still the super_admin-gated one…
    expect(groups).toMatch(/\.\.\.\(role === 'super_admin' \? \[\{\s*header: 'Advanced',/)
    // …and each restricted key appears exactly once, inside it.
    for (const key of ['configure', 'webhooks', 'bin']) {
      expect(groups.match(new RegExp(`key:'${key}'`, 'g'))).toHaveLength(1)
      expect(advanced).toContain(`key:'${key}'`)
    }
  })
})

// issue 216 renamed this section: it never processed renewals — Stripe does
// that — it retires seats an owner scheduled for removal.
//
// issue 226 step 8 RETIRED the Billing cluster entirely. Seat Removals is a
// fleet-wide ACTION with per-row confirmation, not a way to find locations, so
// it could not become a filter or a sort the way Conversions Due did; it moved
// to the Dashboard, beside the Action Required count that was already sending
// people to look for it.
//
// THE ROLE DECISION IS UNCHANGED AND STILL THE POINT OF THESE ASSERTIONS:
// corporate keeps access. It is now carried by WHERE the card renders rather
// than by a nav gate — AdminDashboard mounts for super_admin and corporate
// alike, and ProcessRemovalsCard sits inside it unwrapped.
describe('role gates — Seat Removals decision (KEEP corporate access)', () => {
  it('the Billing cluster is gone', () => {
    expect(groups).not.toContain("header: 'Billing'")
    expect(groups).not.toContain("key:'conversions'")
    expect(groups).not.toContain("key:'removals'")
  })

  it('Pricing survives, in Advanced, still super_admin-only', () => {
    expect(advanced).toContain("key:'pricing'")
    expect(groups.match(/key:'pricing'/g)).toHaveLength(1)
  })

  it('ProcessRemovalsCard renders on the Dashboard, unwrapped by any role check', () => {
    const dash = beehub.slice(
      beehub.indexOf('function AdminDashboard'),
      beehub.indexOf('function SuperAdminProfile'),
    )
    expect(dash).toContain('<ProcessRemovalsCard />')
    // The mount is not inside a super_admin branch — corporate sees it, which
    // is the decision issue 216 made and this step preserves.
    const mountIdx = dash.indexOf('<ProcessRemovalsCard />')
    const before = dash.slice(Math.max(0, mountIdx - 600), mountIdx)
    expect(before).not.toMatch(/role === 'super_admin' &&\s*\($/)
  })

  // AdminDashboard itself is the gate, and it is the elevated pair.
  it('the Dashboard is reachable by both elevated roles', () => {
    expect(layout).toMatch(/case 'dashboard':/)
  })
})

describe('role gates — feedback deep link for elevated users', () => {
  it('App parses ?adminTab=feedback for both elevated roles', () => {
    expect(app).toMatch(
      /else if \(t === 'feedback' && \(role === 'super_admin' \|\| role === 'corporate'\)\) setAdminDeepLinkSection\('feedback'\)/,
    )
  })

  it('webhooks deep link stays super_admin-only (unchanged)', () => {
    expect(app).toMatch(/if \(t === 'webhooks' && role === 'super_admin'\) setAdminDeepLinkSection\('webhooks'\)/)
  })

  it("renderContent has a 'feedback' case for the deep link to land on", () => {
    expect(layout).toMatch(/case 'feedback':/)
  })
})

// ── issue 226 step 8 — retired keys must land somewhere ───────────────────
// 'conversions' and 'removals' still arrive from ?adminTab= deep links and
// bookmarks. Falling through to the switch would render a blank frame under a
// breadcrumb naming a section that no longer exists — which reads as the app
// being broken, not as the section having moved.
describe('retired section keys resolve, never blank', () => {
  it('maps each retired key to where its FUNCTION went', () => {
    expect(layout).toMatch(
      /RETIRED_SECTIONS = \{ conversions: 'locations', removals: 'dashboard' \}/,
    )
  })

  it('resolves on first render AND on every navigate', () => {
    expect(layout).toMatch(/useState\(resolveRetiredSection\(initialSection \|\| 'dashboard'\)\)/)
    expect(layout).toMatch(/setActiveSection\(resolveRetiredSection\(section\)\)/)
  })

  it('the deep-link parser maps them too, for both elevated roles', () => {
    expect(app).toMatch(/t === 'conversions' && \(role === 'super_admin' \|\| role === 'corporate'\)\) setAdminDeepLinkSection\('locations'\)/)
    expect(app).toMatch(/t === 'removals' && \(role === 'super_admin' \|\| role === 'corporate'\)\) setAdminDeepLinkSection\('dashboard'\)/)
  })

  it('neither key has a section to render any more', () => {
    expect(layout).not.toMatch(/case 'conversions':/)
    expect(layout).not.toMatch(/case 'removals':/)
    // …and both targets exist.
    expect(layout).toMatch(/case 'locations':/)
    expect(layout).toMatch(/case 'dashboard':/)
  })

  it('ConversionsDueTab is deleted, not orphaned', () => {
    expect(beehub).not.toMatch(/function ConversionsDueTab/)
    expect(beehub).not.toMatch(/<ConversionsDueTab/)
  })
})
